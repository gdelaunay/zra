// Routage du protocole ZRA — PROTOCOL.md §3 et §4.
//
// Le hub est le seul endroit qui connaît les clients. Il applique les invariants
// du §6 : verbatim, ordre, ring buffer, idempotence, aucun état par client,
// `thread_state` après toute action, journalisation de toute écriture.

import { logger } from './log.js'
import { InjectionError } from './inject/backend.js'

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
   * }} deps
   */
  constructor({ config, threads, states, rings, shims, backend, machine, recordInjection, loader = null }) {
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
    const client = { conn, clientId: null, subs: new Set() }
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
        return this.subscribe(client, msg.threadId)

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
        // Ouvrir une session demande de piloter Zed par UI Automation : lot C.
        return this.error(conn, 'new_thread_failed',
          "ouverture de session indisponible : ce poste n'a pas encore le pilotage de Zed")

      case 'zra/trigger':
        // Marqueur explicite : un daemon réel n'a pas de scénarios à déclencher.
        return this.error(conn, 'unknown_message', 'déclencheur de scénario refusé : ce daemon n’est pas un bouchon')

      default:
        return this.error(conn, 'unknown_message', `message inconnu : ${msg.type}`)
    }
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

  /** Idempotent : un `subscribe` rejoué à la reconnexion doit être inoffensif. */
  subscribe(client, threadId) {
    const thread = this.threads.get(threadId)
    if (!thread) return this.error(client.conn, 'unknown_thread', 'thread inconnu de cet index', threadId)
    client.subs.add(threadId)
    client.conn.send(this.states.snapshot(threadId, { state: thread.state }))
    for (const event of this.rings.read(threadId)) {
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
    if (!this.loader) {
      return this.error(conn, 'history_unavailable',
        "historique indisponible : ce poste ne sait pas relire une session fermée", threadId)
    }
    try {
      const { updates, complete } = await this.loader.load(threadId)
      conn.send({ type: 'history', threadId, updates, complete })
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

  broadcast(msg) {
    for (const { conn } of this.clients.values()) conn.send(msg)
  }

  broadcastToSubs(threadId, msg) {
    for (const client of this.clients.values()) {
      if (client.subs.has(threadId)) client.conn.send(msg)
    }
  }
}
