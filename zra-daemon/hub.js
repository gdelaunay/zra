// Routage du protocole ZRA — docs/fr/protocol.md §3 et §4.
//
// Le hub est le seul endroit qui connaît les clients. Il applique les invariants
// du §6 : verbatim, ordre, ring buffer, idempotence, aucun état par client,
// `thread_state` après toute action, journalisation de toute écriture.

import { logger } from './log.js'
import { mkdir } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { InjectionError } from './inject/backend.js'
import { AuthError } from './auth.js'
import { isLoopback } from './server.js'
import { normPath, projectKey } from './threads-index.js'
import { buildPromptBlocks, listFiles } from './mentions.js'
import { tr } from './i18n.js'

const log = logger('hub')

/** Messages entrants qui constituent une écriture, donc à journaliser (§9). */
const WRITES = new Set(['send', 'set_option', 'respond_permission', 'respond_elicitation', 'new_thread', 'new_project', 'interrupt', 'cancel_queued', 'rename_thread', 'delete_thread'])

export class Hub {
  /**
   * @param {{
   *   config: object, threads: import('./threads-index.js').ThreadsIndex,
   *   states: import('./thread-state.js').ThreadStates,
   *   rings: import('./ring-buffer.js').RingBuffers,
   *   shims: import('./shim-registry.js').ShimRegistry,
   *   backend: object, machine: object, recordInjection?: (e:object)=>void,
   *   loader?: import('./session-loader.js').SessionLoader|null,
   *   zed?: import('./zed/control.js').ZedControl|null,
   *   covers?: (sessionId:string) => boolean,
   *   pairing?: import('./auth.js').Pairing|null,
   *   ops?: import('./thread-ops.js').ThreadOps|null,
   *   push?: import('./push.js').PushNotifier|null,
   * }} deps `pairing` : absent, aucun appairage exigé (tests, mode dev).
   */
  constructor({ config, threads, states, rings, shims, backend, machine, recordInjection, loader = null, zed = null, covers = () => false, pairing = null, ops = null, push = null }) {
    this.pairing = pairing
    this.ops = ops
    this.push = push
    this.zed = zed
    this.covers = covers
    this.config = config
    this.threads = threads
    this.states = states
    this.rings = rings
    this.shims = shims
    this.backend = backend
    this.machine = machine
    this.loader = loader
    this.recordInjection = recordInjection || (() => {})
    /** Permissions déjà tranchées, pour ne verrouiller l'encart qu'une fois. */
    this.resolvedPermissions = new Set()
    /** Questions de l'agent déjà répondues, de même. */
    this.resolvedElicitations = new Set()

    /** @type {Map<object, { conn:object, clientId:string|null, subs:Set<string> }>} */
    this.clients = new Map()
    /** Options demandées pendant un tour, appliquées au retour à `idle` (§3 `set_option`). */
    this.pendingOptions = new Map()

    /**
     * Activité de chaque thread, montrée dans la liste comme dans le sidebar de
     * Zed : tour en cours, permission en attente (`ThreadEntry::apply_active_info`).
     * `threadId` → `{ turn, waiting:Set<requestId> }`.
     */
    this.activity = new Map()

    threads.on('change', () => this.broadcastThreads())
    states.on('change', (threadId) => this.pushState(threadId))
    states.on('dequeue', (threadId, entry) => this.deliverQueued(threadId, entry))
    // Capacités apprises en cours de route : le gating de la liste change.
    ops?.on('change', () => this.broadcastThreads())
  }

  // ---- cycle de vie des clients -------------------------------------------

  attach(conn) {
    // La loopback, c'est le poste lui-même : rien à appairer. Mais un proxy
    // local qui relaie vers 127.0.0.1 (en-têtes forwarded) étend la loopback
    // au monde : cette connexion-là doit s'appairer comme une autre.
    const trusted = !this.pairing ||
      (this.config.auth?.exemptLoopback !== false && isLoopback(conn.remoteAddress) && !conn.forwarded)
    const client = { conn, clientId: null, subs: new Set(), authed: trusted, pairedId: null }
    if (trusted) conn.authenticate?.()
    this.clients.set(conn, client)
    log.info(tr`Client ${conn.id} connecté (origin=${conn.origin ?? '—'}, ip=${conn.remoteAddress}).`)

    conn.on('message', (msg) => {
      const failed = (err) => {
        // Un message malformé ne doit jamais faire tomber le daemon.
        log.warn(tr`Client ${conn.id} : ${msg?.type} a échoué —`, err.message)
        this.error(conn, err instanceof InjectionError ? err.code : 'internal_error', err.message, msg?.threadId)
      }
      try {
        Promise.resolve(this.handle(client, msg)).catch(failed)
      } catch (err) {
        failed(err)
      }
    })

    conn.on('close', () => {
      this.clients.delete(conn)
      // Le code de fermeture WS, quand le client en a envoyé un : 1001 = il part
      // (onglet fermé, reconnexion), absence = TCP mort sans adieu (à creuser).
      log.info(conn.closeCode ? tr`Client ${conn.id} déconnecté (code ${conn.closeCode}).` : tr`Client ${conn.id} déconnecté (sans code — coupure TCP).`)
    })
  }

  // ---- entrée --------------------------------------------------------------

  handle(client, msg) {
    const { conn } = client
    // Heartbeat de la PWA : sans lui, une socket morte côté mobile passe pour vivante.
    if (msg.type === 'ping') return conn.send({ type: 'pong' })
    if (!client.authed) return this.handleUnpaired(client, msg)
    if (WRITES.has(msg.type)) {
      this.recordInjection({
        client: client.clientId, ip: conn.remoteAddress, type: msg.type,
        threadId: msg.threadId ?? null, text: msg.text ?? null,
        key: msg.key ?? null, value: msg.value ?? null,
        optionId: msg.optionId ?? null, agentId: msg.agentId ?? null,
        ...(msg.type === 'new_project' ? { name: msg.name ?? null, parent: msg.parent ?? null } : {}),
      })
    }

    switch (msg.type) {
      case 'hello':
        client.clientId = typeof msg.clientId === 'string' ? msg.clientId : null
        this.bootstrap(client)
        return

      case 'list_threads':
        conn.send(this.threadsMessage())
        return

      case 'subscribe':
        return this.subscribe(client, msg.threadId, msg.since)

      case 'unsubscribe':
        client.subs.delete(msg.threadId)
        return

      case 'load_history':
        return this.loadHistory(conn, msg.threadId)

      case 'send':
        return this.send(conn, msg)

      case 'files':
        return this.files(conn, msg)

      case 'interrupt':
        return this.interrupt(conn, msg.threadId)

      case 'cancel_queued':
        return this.cancelQueued(conn, msg)

      case 'set_option':
        return this.setOption(conn, msg)

      case 'respond_permission':
        return this.respondPermission(conn, msg)

      case 'respond_elicitation':
        return this.respondElicitation(conn, msg)

      case 'new_thread':
        return this.newThread(conn, msg)

      case 'new_project':
        return this.newProject(conn, msg)

      case 'rename_thread':
        return this.renameThread(conn, msg)

      case 'delete_thread':
        return this.deleteThread(conn, msg)

      case 'push_subscribe':
        return this.pushSubscribe(client, msg)

      case 'push_unsubscribe':
        return this.pushUnsubscribe(client, msg)

      case 'zra/trigger':
        // Marqueur explicite : un daemon réel n'a pas de scénarios à déclencher.
        return this.error(conn, 'unknown_message', tr`Déclencheur de scénario refusé : ce daemon n’est pas un bouchon.`)

      default:
        return this.error(conn, 'unknown_message', tr`Message inconnu : ${msg.type}.`)
    }
  }

  // ---- appairage ---------------------------------------------------

  /**
   * Client pas encore reconnu : seuls `hello` (avec un jeton) et `pair` (avec
   * le code) passent — plus `ping`, traité avant ce contrôle dans `handle()` :
   * le heartbeat de la PWA doit vivre pendant la saisie du code, sinon elle
   * croit le lien mort et se reconnecte en boucle. Tout le reste est ignoré
   * sans réponse : une PWA rejoue sa file à la connexion, on ne l'inonde pas
   * d'erreurs.
   */
  handleUnpaired(client, msg) {
    const { conn } = client
    if (msg.type === 'hello') {
      client.clientId = typeof msg.clientId === 'string' ? msg.clientId : null
      const paired = this.pairing.verify(msg.token)
      if (paired) return this.admit(client, paired)
      conn.send({ type: 'auth_required', name: this.machine.name, reason: msg.token ? tr`Jeton inconnu ou révoqué.` : null })
      return
    }
    if (msg.type === 'pair') {
      try {
        const label = typeof msg.label === 'string' && msg.label ? msg.label : (client.clientId ?? 'appareil')
        const { token, client: paired } = this.pairing.pair(msg.code, { label, address: conn.remoteAddress })
        log.info(tr`Client ${conn.id} appairé (« ${paired.label} », ${conn.remoteAddress}) — nouveau code : ${this.pairing.display}`)
        conn.send({ type: 'paired', token, clientId: paired.id })
        this.admit(client, paired)
      } catch (err) {
        if (!(err instanceof AuthError)) throw err
        log.warn(tr`Appairage refusé (${err.code}) depuis ${conn.remoteAddress}`)
        this.error(conn, err.code, err.message)
      }
      return
    }
    log.debug(tr`Client ${conn.id} non appairé : ${msg.type} ignoré.`)
  }

  admit(client, paired) {
    client.authed = true
    client.pairedId = paired.id
    client.conn.authenticate?.()
    this.bootstrap(client)
  }

  /** Révoque un client appairé et coupe ses connexions ouvertes. */
  revoke(id) {
    const done = this.pairing?.revoke(id) ?? false
    for (const client of this.clients.values()) {
      if (client.pairedId === id) client.conn.close(4401)
    }
    return done
  }

  // ---- bootstrap -----------------------------------------------------------

  bootstrap(client) {
    const { conn } = client
    conn.send({ type: 'machine', ...this.machine.describe() })
    conn.send(this.threadsMessage())
    for (const t of this.threads.threads) {
      conn.send(this.states.snapshot(t.threadId, { state: t.state }))
    }
    if (this.threads.degraded) {
      this.error(conn, 'index_degraded', this.threads.degraded)
    }
  }

  /**
   * Idempotent : un `subscribe` rejoué à la reconnexion doit être inoffensif.
   * `since` : le client a déjà tout jusqu'à ce `seq`. Il ne reçoit que la
   * suite, ou l'historique si le ring ne peut plus la lui donner.
   */
  subscribe(client, threadId, since) {
    const thread = this.threads.get(threadId)
    if (!thread) return this.error(client.conn, 'unknown_thread', tr`Thread inconnu de cet index.`, threadId)
    client.subs.add(threadId)
    client.conn.send(this.states.snapshot(threadId, { state: thread.state }))
    const events = Number.isSafeInteger(since) ? this.rings.since(threadId, since) : this.rings.read(threadId)
    if (!events) return this.loadHistory(client.conn, threadId)
    for (const event of events) {
      client.conn.send({ type: 'acp_event', threadId, ...event })
    }
  }

  // ---- lecture -------------------------------------------------------------

  /**
   * Replay complet d'un thread. Opération coûteuse : le daemon lance
   * l'agent, collecte, tue l'instance, et met en cache 10 minutes.
   */
  async loadHistory(conn, threadId) {
    const thread = this.threads.get(threadId)
    if (!thread) return this.error(conn, 'unknown_thread', tr`Thread inconnu de cet index.`, threadId)
    if (!thread.sessionId) {
      return this.error(conn, 'no_session', tr`Thread sans session : historique indisponible.`, threadId)
    }

    // Thread vivant : tout ce que l'agent a émis est passé par le shim, donc
    // par le ring buffer. On le rend tel quel plutôt que de lancer une seconde
    // instance de l'agent sur une session que Zed tient déjà ouverte.
    if (this.shims.hasSession(thread.sessionId) && this.covers(thread.sessionId)) {
      const events = this.rings.read(threadId)
      conn.send({
        type: 'history', threadId,
        updates: events.map((e) => e.update),
        complete: !this.rings.truncated(threadId),
        until: this.rings.cursor(),
      })
      return
    }

    if (!this.loader) {
      return this.error(conn, 'history_unavailable',
        tr`Historique indisponible : ce poste ne sait pas relire une session fermée.`, threadId)
    }
    // `until` : ce que le ring contenait au lancement de la relecture est dans
    // le replay. La PWA écarte ces événements s'ils lui sont aussi parvenus en
    // direct, sans quoi elle les afficherait deux fois.
    const until = this.rings.cursor()
    try {
      const { updates, complete } = await this.loader.load(threadId)
      conn.send({ type: 'history', threadId, updates, complete, until })
    } catch (err) {
      this.error(conn, err.code || 'history_unavailable', err.message, threadId)
    }
  }

  // ---- écriture ------------------------------------------------------------

  async send(conn, msg) {
    const thread = this.requireWritable(conn, msg.threadId)
    if (!thread) return
    const text = typeof msg.text === 'string' ? msg.text : ''
    if (!text) return

    // Thread fermé : Zed le rouvre, un shim le recharge, puis injection normale
    // — une seule session, aucune divergence.
    if (!this.shims.hasSession(thread.sessionId) && this.zed?.canReopen && this.backend.name !== 'mock') {
      // Thread d'un agent que ZRA n'enveloppe pas (créé avant ZRA, avec
      // « claude-acp ») : Zed le rouvrirait sans shim, rien ne le verrait
      // revenir. On le dit tout de suite, sans une touche ni 30 s d'attente.
      const agent = this.machine.agents?.find((a) => a.id === thread.agentId)
      if (!agent?.wraps) {
        return this.error(conn, 'not_zra_thread',
          tr`Thread ouvert avec « ${thread.agentId ?? '?'} », hors ZRA : lecture seule depuis le mobile. Répondre dans Zed, ou ouvrir un thread ZRA.`,
          msg.threadId)
      }
      try {
        await this.zed.reopen(thread)
      } catch (err) {
        log.warn(tr`Réouverture de ${thread.threadId} impossible :`, err.message)
        return this.error(conn, 'inject_failed', err.message, msg.threadId)
      }
    }

    const mode = msg.mode === 'interrupt' ? 'interrupt' : 'queue'
    const state = this.states.get(msg.threadId)

    // File d'attente : le tour est occupé et on ne veut pas le couper. Avec le
    // backend `acp`, c'est le shim qui tient la file — seul à voir le trafic
    // réel : on transmet sans rien empiler ici.
    if (mode === 'queue' && state.turn === 'busy' && !this.backend.ownsQueue) {
      this.states.enqueue(msg.threadId, text)
      return
    }

    await this.inject(conn, msg.threadId, async () => {
      const blocks = await this.promptBlocks(thread, text)
      return this.backend.send(msg.threadId, text, mode, { blocks })
    }, { prompt: text })
  }

  /**
   * Liens de mention [@nom](file://…) → blocs ACP (D1), au départ. Backend
   * clavier ou mock : pas de conversion (le texte part tel quel).
   * @returns {Promise<Array|null>}
   */
  async promptBlocks(thread, text) {
    if (this.backend.name !== 'acp' && this.backend.name !== 'auto') return null
    return buildPromptBlocks(text, {
      folderPaths: thread.folderPaths ?? [],
      embeddedContext: Boolean(this.ops?.capsFor(thread)?.embedded),
    })
  }

  /** Fichiers et dossiers du projet pour les mentions @ (D5). */
  async files(conn, msg) {
    const thread = this.threads.get(msg.threadId)
    if (!thread) return this.error(conn, 'unknown_thread', tr`Thread inconnu.`, msg.threadId)
    try {
      const { entries, truncated } = await listFiles(thread.folderPaths ?? [])
      conn.send({ type: 'files', threadId: msg.threadId, entries, truncated })
    } catch (err) {
      this.error(conn, 'files_failed', err.message, msg.threadId)
    }
  }

  /** `queueId` inconnu => ignoré silencieusement (protocole §3). */
  async cancelQueued(conn, msg) {
    if (!this.backend.ownsQueue) {
      this.states.cancelQueued(msg.threadId, msg.queueId)
      return
    }
    await this.inject(conn, msg.threadId, () => this.backend.cancelQueued(msg.threadId, msg.queueId))
  }

  /**
   * Course mobile/poste : le premier qui répond gagne. C'est le shim
   * qui arbitre — lui seul sait si Zed a déjà tranché — et son accusé dit par
   * qui. Le daemon ne juge rien, il relaie un `optionId` produit par l'agent.
   */
  async respondPermission(conn, msg) {
    if (!this.backend.respondPermission) {
      return this.error(conn, 'permission_expired',
        tr`Aucune demande de permission en attente sur ce poste.`, msg.threadId)
    }
    try {
      const result = await this.backend.respondPermission(msg.threadId, msg.requestId, msg.optionId)
      this.permissionResolved(msg.threadId, {
        requestId: msg.requestId,
        optionId: result?.optionId ?? msg.optionId,
        optionName: result?.optionName ?? null,
        by: result?.by === 'desktop' ? 'desktop' : 'mobile',
      })
    } catch (err) {
      const code = err instanceof InjectionError ? err.code : (err.code || 'permission_expired')
      this.error(conn, code, err.message, msg.threadId)
    }
  }

  /** Réponse à une question de l'agent : même course que `respondPermission`, arbitrée par le shim. */
  async respondElicitation(conn, msg) {
    if (!this.backend.respondElicitation) {
      return this.error(conn, 'elicitation_expired', tr`Aucune question en attente sur ce poste.`, msg.threadId)
    }
    try {
      const result = await this.backend.respondElicitation(msg.threadId, msg.requestId, msg.action, msg.content)
      this.elicitationResolved(msg.threadId, { requestId: msg.requestId, action: result?.action ?? msg.action, by: 'mobile' })
    } catch (err) {
      const code = err instanceof InjectionError ? err.code : (err.code || 'elicitation_expired')
      this.error(conn, code, err.message, msg.threadId)
    }
  }

  async interrupt(conn, threadId) {
    const thread = this.requireWritable(conn, threadId)
    if (!thread) return
    if (this.states.get(threadId).turn !== 'busy') return
    await this.inject(conn, threadId, () => this.backend.interrupt(threadId))
  }

  async setOption(conn, msg) {
    const thread = this.requireWritable(conn, msg.threadId)
    if (!thread) return
    // Avec le backend `acp`, c'est le shim qui diffère l'option jusqu'à la fin
    // du tour : il connaît la vraie fin, le daemon n'en a qu'un miroir.
    if (!this.backend.ownsQueue && this.states.get(msg.threadId).turn === 'busy') {
      // Pas de changement d'option en plein tour : on applique à la fin.
      const list = this.pendingOptions.get(msg.threadId) || []
      list.push({ key: msg.key, value: msg.value })
      this.pendingOptions.set(msg.threadId, list)
      return
    }
    await this.inject(conn, msg.threadId, () => this.backend.setOption(msg.threadId, msg.key, msg.value))
  }

  /**
   * Renommage par ACP (`session/set_title` — docs/fr/acp.md). Le titre rendu
   * par l'agent (normalisé) arrive dans le `threads` rediffusé, pas d'accusé
   * dédié. Thread fermé : client jetable, sans rouvrir Zed.
   */
  async renameThread(conn, msg) {
    const thread = this.requireWritable(conn, msg.threadId)
    if (!thread) return
    if (!this.ops) {
      return this.error(conn, 'capability_missing', tr`Renommer indisponible sur ce poste.`, msg.threadId)
    }
    try {
      await this.ops.rename(msg.threadId, msg.title)
    } catch (err) {
      this.error(conn, err.code || 'inject_failed', err.message, msg.threadId)
    }
  }

  /**
   * Suppression par ACP (`session/delete`) : la session part côté agent, le
   * thread quitte la liste (tombstone). Zed garde son entrée jusqu'au
   * redémarrage, plus ouvrable — accepté (docs/fr/acp.md). La confirmation
   * est côté PWA.
   */
  async deleteThread(conn, msg) {
    const thread = this.requireWritable(conn, msg.threadId)
    if (!thread) return
    if (!this.ops) {
      return this.error(conn, 'capability_missing', tr`Supprimer indisponible sur ce poste.`, msg.threadId)
    }
    try {
      await this.ops.delete(msg.threadId)
    } catch (err) {
      this.error(conn, err.code || 'inject_failed', err.message, msg.threadId)
    }
  }

  /** Enveloppe commune : une erreur de backend devient un `error` du protocole.
   * `extra` : détail ACP (`details`) et prompt refusé (`prompt`), pour le callout. */
  async inject(conn, threadId, run, extra = null) {
    try {
      await run()
    } catch (err) {
      const code = err instanceof InjectionError ? err.code : 'inject_failed'
      log.warn(tr`Injection refusée sur ${threadId} :`, err.message)
      this.error(conn, code, err.message, threadId, { ...extra, ...(err.details ? { details: err.details } : {}) })
    }
  }

  /** Dépilage automatique en fin de tour. */
  async deliverQueued(threadId, entry) {
    try {
      // File d'attente : même texte, parsé au départ (protocole §3).
      const thread = this.threads.get(threadId)
      const blocks = thread ? await this.promptBlocks(thread, entry.text) : null
      await this.backend.send(threadId, entry.text, 'queue', { blocks })
    } catch (err) {
      log.warn(tr`File d'attente : envoi impossible sur ${threadId} :`, err.message)
      const msg = {
        type: 'error', code: 'inject_failed', threadId,
        message: tr`Message en attente non envoyé : ${err.message}`,
        prompt: entry.text,
      }
      if (err.details) msg.details = err.details
      this.broadcastToSubs(threadId, msg)
    }
  }

  requireWritable(conn, threadId) {
    const thread = this.threads.get(threadId)
    if (!thread) {
      this.error(conn, 'unknown_thread', tr`Thread inconnu de cet index.`, threadId)
      return null
    }
    if (!thread.sessionId) {
      this.error(conn, 'no_session', tr`Thread sans session : impossible d'y écrire.`, threadId)
      return null
    }
    return thread
  }

  /**
   * Nouvelle session d'agent depuis le **+**. `thread_created` part
   * **après** un `threads` qui contient le thread : sans ça la PWA ouvrirait un
   * écran sans titre (protocole §4).
   */
  async newThread(conn, { agentId, folderPaths }) {
    if (!this.zed?.enabled) {
      return this.error(conn, 'new_thread_failed',
        tr`Ouverture de session indisponible : pilotage de Zed désactivé sur ce poste (zedControl.enabled).`)
    }
    if (typeof agentId !== 'string' || !agentId) {
      return this.error(conn, 'new_thread_failed', tr`Agent non précisé.`)
    }
    let project = null
    if (folderPaths !== undefined && folderPaths !== null) {
      project = this.knownProject(folderPaths)
      if (!project) return this.error(conn, 'new_thread_failed', tr`Projet inconnu de ce poste : aucun thread ne porte ces dossiers.`)
    }
    try {
      // La CLI (`--classic`) retrouve la fenêtre du projet ou lui en ouvre une :
      // l'état « ouvert » de la base n'a pas à être deviné ici.
      const { thread, cwd } = await this.zed.newThread(agentId, { folderPaths: project })
      conn.send(this.threadsMessage())
      conn.send({ type: 'thread_created', threadId: thread.threadId, agentId: thread.agentId ?? agentId })
      // Zed a pu ouvrir la session ailleurs (fenêtre du projet introuvable,
      // focus volé) : le thread existe, on le dit dans son fil plutôt que de le taire.
      if (project && cwd && !samePath(cwd, project[0])) {
        this.publish(thread.threadId, {
          sessionUpdate: 'zra/notice', level: 'warn',
          text: tr`Session ouverte dans ${cwd}, pas dans ${project[0]}`,
        })
      }
    } catch (err) {
      log.warn(`new_thread ${agentId} :`, err.message)
      this.error(conn, 'new_thread_failed', err.message)
    }
  }

  /**
   * Nouveau projet : crée le dossier puis l'ouvre dans Zed (CLI `--classic`).
   * La CLI ne crée pas les dossiers manquants (« '{path}' does not exist »,
   * `workspace.rs` de Zed) : le `mkdir` est à nous, non récursif — un dossier
   * qui existe déjà est un refus, pas une ouverture silencieuse. Pas de thread
   * créé : le projet remonte par le poll de l'index, son « + » devient actif.
   * Voir `reference/conception-nouveau-projet.md`.
   */
  async newProject(conn, { name, parent }) {
    if (!this.zed?.enabled) {
      return this.error(conn, 'new_project_failed',
        tr`Création de projet indisponible : pilotage de Zed désactivé sur ce poste (zedControl.enabled).`)
    }
    const fail = (message) => this.error(conn, 'new_project_failed', message)
    if (typeof name !== 'string' || !name.trim()) return fail(tr`Nom de projet non précisé.`)
    const clean = name.trim()
    if (clean.length > 100 || /[\\/\u0000-\u001f]/.test(clean) || clean === '.' || clean === '..') {
      return fail(tr`Nom de projet invalide : un seul segment de dossier, sans « / » ni « \\ ».`)
    }
    if (typeof parent !== 'string' || !isAbsolute(parent)) return fail(tr`Dossier parent invalide : chemin absolu requis.`)
    const dir = join(parent, clean)
    try {
      await mkdir(dir)
    } catch (err) {
      if (err.code === 'EEXIST') return fail(tr`Le dossier « ${dir} » existe déjà.`)
      if (err.code === 'ENOENT') return fail(tr`Le dossier parent « ${parent} » n'existe pas.`)
      return fail(tr`Création du dossier impossible : ${err.message}`)
    }
    try {
      await this.zed.openProject([dir])
    } catch (err) {
      log.warn(`new_project ${dir} :`, err.message)
      // Le dossier reste : un dossier vide est inoffensif, le supprimer serait plus surprenant.
      return fail(tr`Dossier créé (${dir}), mais Zed ne l'a pas ouvert : ${err.message}`)
    }
    conn.send({ type: 'project_created', folderPaths: [dir] })
  }

  /**
   * Un projet se désigne par les dossiers d'un thread existant ou d'un groupe du
   * sidebar de Zed, jamais par un chemin libre : le mobile ne fait ouvrir à Zed
   * que ce que Zed a déjà ouvert.
   * @returns {string[]|null} les dossiers, tels que l'index les écrit
   */
  knownProject(folderPaths) {
    if (!Array.isArray(folderPaths) || !folderPaths.length || folderPaths.length > 16) return null
    if (!folderPaths.every((p) => typeof p === 'string' && p)) return null
    const key = projectKey(folderPaths)
    return this.threads.threads.find((t) => t.folderPaths?.length && projectKey(t.folderPaths) === key)?.folderPaths
      ?? this.threads.projects?.find((p) => projectKey(p.folderPaths) === key)?.folderPaths ?? null
  }

  // ---- notifications push ---------------------------------------------------

  pushSubscribe(client, msg) {
    if (!this.push) {
      return this.error(client.conn, 'internal_error', tr`Notifications indisponibles sur ce poste.`)
    }
    const ok = this.push.subscribe(msg.subscription ?? {}, {
      machineId: typeof msg.machineId === 'string' ? msg.machineId : null,
      clientId: client.clientId,
    })
    if (!ok) return this.error(client.conn, 'internal_error', tr`Abonnement push invalide.`)
    client.conn.send({ type: 'push_subscribed', endpoint: msg.subscription.endpoint })
  }

  pushUnsubscribe(client, msg) {
    this.push?.unsubscribe(msg.endpoint)
    client.conn.send({ type: 'push_unsubscribed', endpoint: msg.endpoint ?? null })
  }

  /**
   * Fin de tour : une réponse est arrivée. Personne ne regarde ce thread en
   * direct (aucun abonné connecté) : le push prend le relais, comme Zed
   * notifie un thread qui n'est pas actif.
   */
  notifyTurnEnd(threadId) {
    if (!this.push?.subscriptions.size) return
    for (const client of this.clients.values()) {
      if (client.authed && client.subs.has(threadId)) return
    }
    const thread = this.threads.get(threadId)
    if (!thread) return
    const body = lastAgentText(this.rings.read(threadId))
    this.push.notify({
      threadId,
      title: thread.title || tr`Nouveau Thread d'Agent`,
      body: body || tr`Réponse reçue.`,
      tag: threadId,
    }).catch((err) => log.warn(tr`Push :`, err.message))
  }

  // ---- sortie --------------------------------------------------------------

  /**
   * Publie un événement ACP. `update` est **verbatim** : le daemon ne le relit
   * pas, ne le normalise pas, ne le complète pas (invariant §6.1).
   */
  publish(threadId, update, at = new Date().toISOString()) {
    // Demande de permission : `toolCall` et `options` ensemble (protocole §4) ;
    // question de l'agent : `zra/elicitation`. Comme Zed (`has_pending_turn_action`),
    // l'une et l'autre mettent le thread en attente.
    if (update?.requestId && update.toolCall && Array.isArray(update.options)) this.setWaiting(threadId, update.requestId, true)
    if (update?.sessionUpdate === 'zra/elicitation' && update.requestId && !this.resolvedElicitations.has(`${threadId}|${update.requestId}`)) {
      this.setWaiting(threadId, update.requestId, true)
    }
    const event = this.rings.push(threadId, { update, at })
    this.broadcastToSubs(threadId, { type: 'acp_event', threadId, ...event })
  }

  /**
   * Zed recharge la session et l'agent va tout rejouer. Le ring
   * repart de zéro, et les mobiles qui regardent ce thread reçoivent un
   * historique vide que le replay, en direct, va remplir : sans ça, la
   * conversation s'afficherait une seconde fois à la suite de la première.
   */
  restart(threadId) {
    const until = this.rings.cursor()
    this.rings.clear(threadId)
    this.broadcastToSubs(threadId, { type: 'history', threadId, updates: [], complete: true, until })
  }

  /**
   * Verrouille l'encart de permission côté PWA (protocole §4). Idempotent : la
   * réponse du mobile et l'observation du shim peuvent arriver toutes les deux.
   */
  permissionResolved(threadId, { requestId, optionId, optionName = null, by = 'mobile' }) {
    if (requestId) this.setWaiting(threadId, requestId, false)
    if (!requestId || this.resolvedPermissions.has(requestId)) return
    this.resolvedPermissions.add(requestId)
    // Borne mémoire : on ne garde que l'histoire récente des arbitrages.
    if (this.resolvedPermissions.size > 500) {
      this.resolvedPermissions.delete(this.resolvedPermissions.values().next().value)
    }
    const msg = { type: 'permission_resolved', threadId, requestId, optionId, by }
    if (optionName) msg.optionName = optionName
    this.broadcastToSubs(threadId, msg)
    // La demande est dans le ring : sa réponse aussi, sinon un réabonnement ou
    // un historique (rechargement de la PWA) la rejoue comme encore ouverte.
    this.publish(threadId, {
      sessionUpdate: 'zra/permission_resolved', requestId, optionId, by,
      ...(optionName ? { optionName } : {}),
    })
  }

  /** Shim mort ou requête trop tardive : l'encart passe en lecture seule (§6.6). */
  permissionExpired(threadId, requestId) {
    if (requestId) this.setWaiting(threadId, requestId, false)
    if (requestId) this.resolvedPermissions.add(requestId)
    this.broadcastToSubs(threadId, {
      type: 'error', code: 'permission_expired', threadId,
      message: tr`La demande de permission a expiré : l'agent n'attend plus de réponse.`,
    })
  }

  /**
   * Question répondue (mobile, poste) ou retirée par l'agent : comme Zed, le
   * formulaire quitte le fil. Le ring garde la réponse, sinon un historique
   * rejouerait la question comme encore ouverte.
   */
  elicitationResolved(threadId, { requestId, action, by = 'mobile' }) {
    if (requestId) this.setWaiting(threadId, requestId, false)
    if (!requestId || this.resolvedElicitations.has(`${threadId}|${requestId}`)) return
    this.resolvedElicitations.add(`${threadId}|${requestId}`)
    if (this.resolvedElicitations.size > 500) {
      this.resolvedElicitations.delete(this.resolvedElicitations.values().next().value)
    }
    this.broadcastToSubs(threadId, { type: 'elicitation_resolved', threadId, requestId, action, by })
    this.publish(threadId, { sessionUpdate: 'zra/elicitation_resolved', requestId, action, by })
  }

  /** Shim mort : plus personne n'attend la réponse. */
  elicitationExpired(threadId, requestId) {
    if (!requestId) return
    this.elicitationResolved(threadId, { requestId, action: 'cancel', by: 'agent' })
  }

  pushState(threadId) {
    const thread = this.threads.get(threadId)
    const snapshot = this.states.snapshot(threadId, { state: thread?.state ?? 'unknown' })
    this.broadcastToSubs(threadId, snapshot)
    this.setTurn(threadId, snapshot.turn)

    // Retour au repos : on applique les options mises de côté pendant le tour.
    if (snapshot.turn === 'idle') this.flushOptions(threadId)
  }

  flushOptions(threadId) {
    const list = this.pendingOptions.get(threadId)
    if (!list?.length) return
    this.pendingOptions.delete(threadId)
    for (const { key, value } of list) {
      Promise.resolve(this.backend.setOption(threadId, key, value))
        .catch((err) => log.warn(tr`Option ${key} non appliquée :`, err.message))
    }
  }

  error(conn, code, message, threadId, extra = null) {
    const msg = { type: 'error', code, message }
    if (threadId) msg.threadId = threadId
    if (extra) Object.assign(msg, extra)
    conn.send(msg)
  }

  /** Aux clients reconnus seulement : un client pas encore appairé ne voit rien. */
  /** Les threads de l'index, avec leur activité (`turn`, `waiting`) et le gating ACP. */
  listThreads() {
    return this.threads.threads.map((t) => {
      const out = { ...t }
      // Capacités connues seulement : absent = inconnu, la PWA tente et découvre.
      const caps = this.ops?.capsFor(t)
      if (caps) {
        out.canRename = caps.title
        out.canDelete = caps.delete
      }
      const a = this.activity.get(t.threadId)
      if (a && (a.turn === 'busy' || a.waiting.size)) {
        out.turn = a.turn
        out.waiting = a.waiting.size > 0
      }
      return out
    })
  }

  /** Message `threads` : l'index et les projets du sidebar de Zed (protocole §4). */
  threadsMessage() {
    return { type: 'threads', threads: this.listThreads(), projects: this.threads.projects ?? null }
  }

  broadcastThreads() {
    this.broadcast(this.threadsMessage())
  }

  activityOf(threadId) {
    let a = this.activity.get(threadId)
    if (!a) this.activity.set(threadId, (a = { turn: 'idle', waiting: new Set() }))
    return a
  }

  /** Tour au repos : plus rien n'attend de réponse. Rediffuse la liste si l'activité change. */
  setTurn(threadId, turn) {
    if (!this.threads.get(threadId)) return
    const a = this.activityOf(threadId)
    const wasWaiting = a.waiting.size > 0
    const was = a.turn
    if (turn === 'idle') a.waiting.clear()
    if (a.turn === turn && wasWaiting === a.waiting.size > 0) return
    a.turn = turn
    this.broadcastThreads()
    if (was === 'busy' && turn === 'idle') this.notifyTurnEnd(threadId)
  }

  setWaiting(threadId, requestId, on) {
    const a = this.activityOf(threadId)
    const before = a.waiting.size > 0
    if (on) a.waiting.add(requestId)
    else a.waiting.delete(requestId)
    if (before !== a.waiting.size > 0) this.broadcastThreads()
  }

  broadcast(msg) {
    for (const client of this.clients.values()) if (client.authed) client.conn.send(msg)
  }

  broadcastToSubs(threadId, msg) {
    for (const client of this.clients.values()) {
      if (client.authed && client.subs.has(threadId)) client.conn.send(msg)
    }
  }
}

/** Chemins comparés comme Windows les compare : sans casse ni séparateur final. */
function samePath(a, b) {
  return normPath(a) === normPath(b)
}

/** Dernier texte de l'agent avant le prochain message utilisateur, tronqué pour la notification. */
function lastAgentText(events) {
  const parts = []
  for (let i = events.length - 1; i >= 0; i--) {
    const u = events[i]?.update
    const kind = u?.sessionUpdate
    if (kind === 'user_message_chunk') break
    if (kind === 'agent_message_chunk' && u.content?.type === 'text' && u.content.text) parts.unshift(u.content.text)
  }
  const text = parts.join('').trim()
  return text.length > 160 ? `${text.slice(0, 159)}…` : text
}
