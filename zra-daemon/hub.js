// Routage du protocole ZRA — PROTOCOL.md §3 et §4.
//
// Le hub est le seul endroit qui connaît les clients. Il applique les invariants
// du §6 : verbatim, ordre, ring buffer, idempotence, aucun état par client,
// `thread_state` après toute action, journalisation de toute écriture.

import { logger } from './log.js'
import { InjectionError } from './inject/backend.js'
import { AuthError } from './auth.js'
import { isLoopback } from './server.js'
import { normPath, projectKey } from './threads-index.js'

const log = logger('hub')

/** Messages entrants qui constituent une écriture, donc à journaliser (§9). */
const WRITES = new Set(['send', 'set_option', 'respond_permission', 'new_thread', 'interrupt', 'cancel_queued'])

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
   * }} deps `pairing` : absent, aucun appairage exigé (tests, mode dev).
   */
  constructor({ config, threads, states, rings, shims, backend, machine, recordInjection, loader = null, zed = null, covers = () => false, pairing = null }) {
    this.pairing = pairing
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

    /** @type {Map<object, { conn:object, clientId:string|null, subs:Set<string> }>} */
    this.clients = new Map()
    /** Options demandées pendant un tour, appliquées au retour à `idle` (§3 `set_option`). */
    this.pendingOptions = new Map()

    threads.on('change', (list) => this.broadcast({ type: 'threads', threads: list }))
    states.on('change', (threadId) => this.pushState(threadId))
    states.on('dequeue', (threadId, entry) => this.deliverQueued(threadId, entry))
  }

  // ---- cycle de vie des clients -------------------------------------------

  attach(conn) {
    // La loopback, c'est le poste lui-même : rien à appairer.
    const trusted = !this.pairing || (this.config.auth?.exemptLoopback !== false && isLoopback(conn.remoteAddress))
    const client = { conn, clientId: null, subs: new Set(), authed: trusted, pairedId: null }
    this.clients.set(conn, client)
    log.info(`client ${conn.id} connecté (origin=${conn.origin ?? '—'}, ip=${conn.remoteAddress})`)

    conn.on('message', (msg) => {
      try {
        this.handle(client, msg)
      } catch (err) {
        // Un message malformé ne doit jamais faire tomber le daemon.
        log.warn(`client ${conn.id} : ${msg?.type} a échoué —`, err.message)
        this.error(conn, err instanceof InjectionError ? err.code : 'internal_error', err.message, msg?.threadId)
      }
    })

    conn.on('close', () => {
      this.clients.delete(conn)
      log.info(`client ${conn.id} déconnecté`)
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
      })
    }

    switch (msg.type) {
      case 'hello':
        client.clientId = typeof msg.clientId === 'string' ? msg.clientId : null
        this.bootstrap(client)
        return

      case 'list_threads':
        conn.send({ type: 'threads', threads: this.threads.threads })
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

      case 'interrupt':
        return this.interrupt(conn, msg.threadId)

      case 'cancel_queued':
        return this.cancelQueued(conn, msg)

      case 'set_option':
        return this.setOption(conn, msg)

      case 'respond_permission':
        return this.respondPermission(conn, msg)

      case 'new_thread':
        return this.newThread(conn, msg)

      case 'zra/trigger':
        // Marqueur explicite : un daemon réel n'a pas de scénarios à déclencher.
        return this.error(conn, 'unknown_message', 'déclencheur de scénario refusé : ce daemon n’est pas un bouchon')

      default:
        return this.error(conn, 'unknown_message', `message inconnu : ${msg.type}`)
    }
  }

  // ---- appairage (spec §9) ---------------------------------------------------

  /**
   * Client pas encore reconnu : seuls `hello` (avec un jeton) et `pair` (avec
   * le code) passent. Le reste est ignoré sans réponse — une PWA rejoue sa file
   * à la connexion, on ne l'inonde pas d'erreurs.
   */
  handleUnpaired(client, msg) {
    const { conn } = client
    if (msg.type === 'hello') {
      client.clientId = typeof msg.clientId === 'string' ? msg.clientId : null
      const paired = this.pairing.verify(msg.token)
      if (paired) return this.admit(client, paired)
      conn.send({ type: 'auth_required', name: this.machine.name, reason: msg.token ? 'jeton inconnu ou révoqué' : null })
      return
    }
    if (msg.type === 'pair') {
      try {
        const label = typeof msg.label === 'string' && msg.label ? msg.label : (client.clientId ?? 'appareil')
        const { token, client: paired } = this.pairing.pair(msg.code, { label, address: conn.remoteAddress })
        log.info(`client ${conn.id} appairé (« ${paired.label} », ${conn.remoteAddress}) — nouveau code : ${this.pairing.display}`)
        conn.send({ type: 'paired', token, clientId: paired.id })
        this.admit(client, paired)
      } catch (err) {
        if (!(err instanceof AuthError)) throw err
        log.warn(`appairage refusé (${err.code}) depuis ${conn.remoteAddress}`)
        this.error(conn, err.code, err.message)
      }
      return
    }
    log.debug(`client ${conn.id} non appairé : ${msg.type} ignoré`)
  }

  admit(client, paired) {
    client.authed = true
    client.pairedId = paired.id
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
    conn.send({ type: 'threads', threads: this.threads.threads })
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
    if (!thread) return this.error(client.conn, 'unknown_thread', 'thread inconnu de cet index', threadId)
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
   * Replay complet d'un thread (spec §5.2). Opération coûteuse : le daemon lance
   * l'agent, collecte, tue l'instance, et met en cache 10 minutes.
   */
  async loadHistory(conn, threadId) {
    const thread = this.threads.get(threadId)
    if (!thread) return this.error(conn, 'unknown_thread', 'thread inconnu de cet index', threadId)
    if (!thread.sessionId) {
      return this.error(conn, 'no_session', 'thread sans session : historique indisponible', threadId)
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
        "historique indisponible : ce poste ne sait pas relire une session fermée", threadId)
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
    // — une seule session, aucune divergence (spec §6.3).
    if (!this.shims.hasSession(thread.sessionId) && this.zed?.canReopen && this.backend.name !== 'mock') {
      // Thread d'un agent que ZRA n'enveloppe pas (créé avant ZRA, avec
      // « claude-acp ») : Zed le rouvrirait sans shim, rien ne le verrait
      // revenir. On le dit tout de suite, sans une touche ni 30 s d'attente.
      const agent = this.machine.agents?.find((a) => a.id === thread.agentId)
      if (!agent?.wraps) {
        return this.error(conn, 'not_zra_thread',
          `thread ouvert avec « ${thread.agentId ?? '?'} », hors ZRA : lecture seule depuis le mobile. Répondre dans Zed, ou ouvrir un thread ZRA`,
          msg.threadId)
      }
      try {
        await this.zed.reopen(thread)
      } catch (err) {
        log.warn(`réouverture de ${thread.threadId} impossible :`, err.message)
        return this.error(conn, 'inject_failed', err.message, msg.threadId)
      }
    }

    const mode = msg.mode === 'interrupt' ? 'interrupt' : 'queue'
    const state = this.states.get(msg.threadId)

    // File d'attente : le tour est occupé et on ne veut pas le couper. Avec le
    // backend `acp`, c'est le shim qui tient la file — seul à voir le trafic
    // réel (spec §6.4) : on transmet sans rien empiler ici.
    if (mode === 'queue' && state.turn === 'busy' && !this.backend.ownsQueue) {
      this.states.enqueue(msg.threadId, text)
      return
    }

    await this.inject(conn, msg.threadId, () => this.backend.send(msg.threadId, text, mode))
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
   * Course mobile/poste : le premier qui répond gagne (spec §6.6). C'est le shim
   * qui arbitre — lui seul sait si Zed a déjà tranché — et son accusé dit par
   * qui. Le daemon ne juge rien, il relaie un `optionId` produit par l'agent.
   */
  async respondPermission(conn, msg) {
    if (!this.backend.respondPermission) {
      return this.error(conn, 'permission_expired',
        'aucune demande de permission en attente sur ce poste', msg.threadId)
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
      // Pas de changement d'option en plein tour (spec §6.5) : on applique à la fin.
      const list = this.pendingOptions.get(msg.threadId) || []
      list.push({ key: msg.key, value: msg.value })
      this.pendingOptions.set(msg.threadId, list)
      return
    }
    await this.inject(conn, msg.threadId, () => this.backend.setOption(msg.threadId, msg.key, msg.value))
  }

  /** Enveloppe commune : une erreur de backend devient un `error` du protocole. */
  async inject(conn, threadId, run) {
    try {
      await run()
    } catch (err) {
      const code = err instanceof InjectionError ? err.code : 'inject_failed'
      log.warn(`injection refusée sur ${threadId} :`, err.message)
      this.error(conn, code, err.message, threadId)
    }
  }

  /** Dépilage automatique en fin de tour (spec §6.4). */
  async deliverQueued(threadId, entry) {
    try {
      await this.backend.send(threadId, entry.text, 'queue')
    } catch (err) {
      log.warn(`file d'attente : envoi impossible sur ${threadId} :`, err.message)
      this.broadcastToSubs(threadId, {
        type: 'error', code: 'inject_failed', threadId,
        message: `message en attente non envoyé : ${err.message}`,
      })
    }
  }

  requireWritable(conn, threadId) {
    const thread = this.threads.get(threadId)
    if (!thread) {
      this.error(conn, 'unknown_thread', 'thread inconnu de cet index', threadId)
      return null
    }
    if (!thread.sessionId) {
      this.error(conn, 'no_session', "thread sans session : impossible d'y écrire", threadId)
      return null
    }
    return thread
  }

  /**
   * Nouvelle session d'agent depuis le **+** (spec §6.7). `thread_created` part
   * **après** un `threads` qui contient le thread : sans ça la PWA ouvrirait un
   * écran sans titre (protocole §4).
   */
  async newThread(conn, { agentId, folderPaths }) {
    if (!this.zed?.enabled) {
      return this.error(conn, 'new_thread_failed',
        'ouverture de session indisponible : pilotage de Zed désactivé sur ce poste (zedControl.enabled)')
    }
    if (typeof agentId !== 'string' || !agentId) {
      return this.error(conn, 'new_thread_failed', 'agent non précisé')
    }
    let project = null
    if (folderPaths !== undefined && folderPaths !== null) {
      project = this.knownProject(folderPaths)
      if (!project) return this.error(conn, 'new_thread_failed', 'projet inconnu de ce poste : aucun thread ne porte ces dossiers')
    }
    try {
      // Projet fermé dans Zed : il s'ouvre dans sa propre fenêtre.
      const key = project ? projectKey(project) : null
      const newWindow = Boolean(key) && this.threads.threads.some((t) => t.projectOpen === false && t.folderPaths?.length && projectKey(t.folderPaths) === key)
      const { thread, cwd } = await this.zed.newThread(agentId, { folderPaths: project, newWindow })
      conn.send({ type: 'threads', threads: this.threads.threads })
      conn.send({ type: 'thread_created', threadId: thread.threadId, agentId: thread.agentId ?? agentId })
      // Zed a pu ouvrir la session ailleurs (fenêtre du projet introuvable,
      // focus volé) : le thread existe, on le dit dans son fil plutôt que de le taire.
      if (project && cwd && !samePath(cwd, project[0])) {
        this.publish(thread.threadId, {
          sessionUpdate: 'zra/notice', level: 'warn',
          text: `session ouverte dans ${cwd}, pas dans ${project[0]}`,
        })
      }
    } catch (err) {
      log.warn(`new_thread ${agentId} :`, err.message)
      this.error(conn, 'new_thread_failed', err.message)
    }
  }

  /**
   * Un projet se désigne par les dossiers d'un thread existant, jamais par un
   * chemin libre : le mobile ne fait ouvrir à Zed que ce que Zed a déjà ouvert.
   * @returns {string[]|null} les dossiers, tels que l'index les écrit
   */
  knownProject(folderPaths) {
    if (!Array.isArray(folderPaths) || !folderPaths.length || folderPaths.length > 16) return null
    if (!folderPaths.every((p) => typeof p === 'string' && p)) return null
    const key = projectKey(folderPaths)
    return this.threads.threads.find((t) => t.folderPaths?.length && projectKey(t.folderPaths) === key)?.folderPaths ?? null
  }

  // ---- sortie --------------------------------------------------------------

  /**
   * Publie un événement ACP. `update` est **verbatim** : le daemon ne le relit
   * pas, ne le normalise pas, ne le complète pas (invariant §6.1).
   */
  publish(threadId, update, at = new Date().toISOString()) {
    const event = this.rings.push(threadId, { update, at })
    this.broadcastToSubs(threadId, { type: 'acp_event', threadId, ...event })
  }

  /**
   * Zed recharge la session et l'agent va tout rejouer (spec §2.3). Le ring
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
    if (requestId) this.resolvedPermissions.add(requestId)
    this.broadcastToSubs(threadId, {
      type: 'error', code: 'permission_expired', threadId,
      message: "la demande de permission a expiré : l'agent n'attend plus de réponse",
    })
  }

  pushState(threadId) {
    const thread = this.threads.get(threadId)
    const snapshot = this.states.snapshot(threadId, { state: thread?.state ?? 'unknown' })
    this.broadcastToSubs(threadId, snapshot)

    // Retour au repos : on applique les options mises de côté pendant le tour.
    if (snapshot.turn === 'idle') this.flushOptions(threadId)
  }

  flushOptions(threadId) {
    const list = this.pendingOptions.get(threadId)
    if (!list?.length) return
    this.pendingOptions.delete(threadId)
    for (const { key, value } of list) {
      Promise.resolve(this.backend.setOption(threadId, key, value))
        .catch((err) => log.warn(`option ${key} non appliquée :`, err.message))
    }
  }

  error(conn, code, message, threadId) {
    const msg = { type: 'error', code, message }
    if (threadId) msg.threadId = threadId
    conn.send(msg)
  }

  /** Aux clients reconnus seulement : un client pas encore appairé ne voit rien. */
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
