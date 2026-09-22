// Côté daemon de la liaison avec les shims — spec §3.2, lot B.
//
// Un shim est lancé par Zed pour un agent ; il se connecte ici en local et
// devient la source de vérité de tout ce qui est *vivant* : les `session/update`
// verbatim, le tour en cours, la file d'attente, les demandes de permission.
// Le daemon, lui, tient l'index des threads et parle à la PWA.
//
// Deux traductions, et elles n'ont lieu qu'ici :
//
//  · `session_id` → `threadId`. Le shim ne connaît que des sessions ACP, la PWA
//    que des `threadId` (protocole §2). Une session dont la ligne n'est pas
//    encore dans `sidebar_threads` — Zed l'écrit avec un temps de retard — voit
//    ses événements **mis de côté**, puis rejoués dès que l'index la nomme.
//    Sans ça, les premières trames d'un thread neuf seraient perdues.
//
//  · commande → accusé. Le hub veut une promesse qui échoue avec un code du
//    protocole ; le shim répond un `ack`. La correspondance est faite ici.

import { EventEmitter } from 'node:events'

import { logger } from './log.js'

const log = logger('shims')

/** Au-delà, une session sans thread connu n'est plus un décalage : c'est une fuite. */
const PENDING_MAX = 2000
/** Une commande sans accusé au-delà de ce délai est considérée perdue. */
const COMMAND_TIMEOUT = 20_000

export class ShimHost extends EventEmitter {
  /**
   * @param {{
   *   shims: import('./shim-registry.js').ShimRegistry,
   *   threads: import('./threads-index.js').ThreadsIndex,
   *   states: import('./thread-state.js').ThreadStates,
   *   commandTimeoutMs?: number,
   * }} deps
   */
  constructor({ shims, threads, states, commandTimeoutMs = COMMAND_TIMEOUT }) {
    super()
    this.shims = shims
    this.threads = threads
    this.states = states
    this.commandTimeoutMs = commandTimeoutMs

    /** @type {Map<object, { conn:object, shimId:string|null }>} */
    this.conns = new Map()
    /** `shimId` → connexion, pour router une commande vers le bon shim. */
    this.byShim = new Map()
    /** Commandes en vol : `id` → `{ resolve, reject, timer }`. */
    this.pending = new Map()
    /** Événements d'une session pas encore nommée par l'index. */
    this.parked = new Map()
    /** Dernier état connu par session, rejoué quand l'index rattrape son retard. */
    this.parkedState = new Map()
    /**
     * Sessions dont **tout** le contenu est passé par ce daemon : ouvertes
     * (`session/new`) ou rechargées (`session/load`, replay complet) pendant que
     * le shim lui était connecté. Pour elles, le ring buffer est l'historique.
     */
    this.whole = new Set()
    this.nextCommandId = 1

    // L'index vient de changer : une session inconnue l'est peut-être moins.
    this.onThreads = () => this.drainParked()
    threads.on('change', this.onThreads)
  }

  // =========================================================================
  // Connexions
  // =========================================================================

  attach(conn) {
    const entry = { conn, shimId: null }
    this.conns.set(conn, entry)
    log.info(`shim ${conn.id} connecté`)

    conn.on('message', (msg) => {
      try {
        this.handle(entry, msg)
      } catch (err) {
        log.warn(`shim ${conn.id} : ${msg?.type} a échoué —`, err.message)
      }
    })

    conn.on('close', () => this.detach(entry))
  }

  detach(entry) {
    this.conns.delete(entry.conn)
    if (!entry.shimId) return
    const shim = this.shims.shims.get(entry.shimId)
    const sessions = shim ? [...shim.sessions] : []
    this.byShim.delete(entry.shimId)
    this.shims.unregister(entry.shimId)
    log.info(`shim ${entry.shimId} déconnecté (${sessions.length} session(s))`)

    // Le shim meurt (Zed fermé) ⇒ la file est perdue, et le mobile doit
    // l'apprendre explicitement plutôt que de voir une file figée (spec §6.4).
    for (const sessionId of sessions) {
      this.whole.delete(sessionId)
      this.parked.delete(sessionId)
      this.parkedState.delete(sessionId)
      const thread = this.threads.getBySession(sessionId)
      if (!thread) continue
      const lost = this.states.get(thread.threadId).queue.length
      this.states.mirror(thread.threadId, { turn: 'idle', queue: [] })
      if (lost) {
        this.emit('update', {
          threadId: thread.threadId,
          update: {
            sessionUpdate: 'zra/notice',
            level: 'warn',
            text: `Zed a fermé l'agent : ${lost} message(s) en attente perdu(s)`,
          },
          at: new Date().toISOString(),
        })
      }
    }

    // Les commandes encore en vol vers ce shim n'auront jamais d'accusé.
    for (const [id, waiter] of this.pending) {
      if (waiter.shimId !== entry.shimId) continue
      this.pending.delete(id)
      clearTimeout(waiter.timer)
      waiter.reject(Object.assign(new Error("le shim s'est arrêté avant de répondre"), { code: 'inject_failed' }))
    }
  }

  // =========================================================================
  // Messages venus du shim
  // =========================================================================

  handle(entry, msg) {
    switch (msg.type) {
      case 'shim_hello': return this.hello(entry, msg)
      case 'session': return this.session(entry, msg)
      case 'acp_update': return this.update(msg)
      case 'state': return this.state(msg)
      case 'session_replay': return this.replay(msg)
      case 'permission_resolved': return this.permissionResolved(msg)
      case 'permission_expired': return this.permissionExpired(msg)
      case 'notice': return this.notice(msg)
      case 'ack': return this.ack(msg)
      default:
        // Ajouter un message ne doit jamais casser l'autre bout (protocole §2).
        log.debug(`shim ${entry.shimId ?? entry.conn.id} : message ignoré (${msg.type})`)
    }
  }

  hello(entry, msg) {
    const shimId = typeof msg.shimId === 'string' ? msg.shimId : entry.conn.id
    entry.shimId = shimId
    this.byShim.set(shimId, entry.conn)
    this.shims.register({
      shimId,
      agentId: msg.agentId ?? null,
      capabilities: msg.agentCapabilities ?? {},
      sessions: (msg.sessions ?? []).map((s) => s.sessionId).filter(Boolean),
    })
    log.info(`shim ${shimId} : agent ${msg.agentId ?? '—'}, ${(msg.sessions ?? []).length} session(s)` +
      (msg.agentCapabilities?.loadSession ? ', loadSession' : ''))
    for (const snapshot of msg.sessions ?? []) this.session(entry, snapshot)
  }

  session(entry, msg) {
    if (!msg.sessionId) return
    if (msg.source === 'new') this.whole.add(msg.sessionId)
    if (entry.shimId) this.shims.addSession(entry.shimId, msg.sessionId)
    this.state(msg)
    this.emit('session', { shimId: entry.shimId, ...msg })
  }

  /**
   * Zed recharge une session : l'agent va tout rejouer. Ce qu'on en avait est
   * redit par le replay — on repart de zéro pour ne pas l'avoir deux fois.
   */
  replay(msg) {
    if (!msg.sessionId) return
    this.parked.delete(msg.sessionId)
    this.whole.add(msg.sessionId)
    const thread = this.threads.getBySession(msg.sessionId)
    if (thread) this.emit('replay', { threadId: thread.threadId, sessionId: msg.sessionId })
  }

  /** Le ring buffer de cette session en est-il l'histoire complète ? */
  covers(sessionId) {
    return this.whole.has(sessionId)
  }

  update(msg) {
    if (!msg.sessionId || !msg.update) return
    const thread = this.threads.getBySession(msg.sessionId)
    if (!thread) return this.park(msg.sessionId, { update: msg.update, at: msg.at })
    this.emit('update', { threadId: thread.threadId, update: msg.update, at: msg.at ?? new Date().toISOString() })
  }

  state(msg) {
    if (!msg.sessionId) return
    const thread = this.threads.getBySession(msg.sessionId)
    if (!thread) {
      this.parkedState.set(msg.sessionId, msg)
      return
    }
    this.states.mirror(thread.threadId, msg)
  }

  permissionResolved(msg) {
    const thread = this.threads.getBySession(msg.sessionId)
    if (!thread) return
    this.emit('permission_resolved', {
      threadId: thread.threadId,
      requestId: msg.requestId,
      optionId: msg.optionId,
      optionName: msg.optionName ?? null,
      by: msg.by === 'desktop' ? 'desktop' : 'mobile',
    })
  }

  permissionExpired(msg) {
    const thread = this.threads.getBySession(msg.sessionId)
    if (!thread) return
    this.emit('permission_expired', { threadId: thread.threadId, requestId: msg.requestId })
  }

  /** Un avis du shim, rendu dans le fil comme n'importe quel événement (protocole §5). */
  notice(msg) {
    if (!msg.sessionId) return
    this.update({
      sessionId: msg.sessionId,
      at: msg.at,
      update: { sessionUpdate: 'zra/notice', text: msg.text, level: msg.level ?? 'info' },
    })
  }

  // ---- sessions pas encore dans l'index ------------------------------------

  park(sessionId, event) {
    let list = this.parked.get(sessionId)
    if (!list) { list = []; this.parked.set(sessionId, list) }
    list.push(event)
    if (list.length > PENDING_MAX) list.splice(0, list.length - PENDING_MAX)
  }

  /** L'index a bougé : on rejoue ce qui attendait un nom, dans l'ordre. */
  drainParked() {
    for (const [sessionId, list] of [...this.parked]) {
      const thread = this.threads.getBySession(sessionId)
      if (!thread) continue
      this.parked.delete(sessionId)
      const state = this.parkedState.get(sessionId)
      if (state) {
        this.parkedState.delete(sessionId)
        this.states.mirror(thread.threadId, state)
      }
      for (const event of list) {
        this.emit('update', { threadId: thread.threadId, update: event.update, at: event.at ?? new Date().toISOString() })
      }
    }
    for (const [sessionId, state] of [...this.parkedState]) {
      const thread = this.threads.getBySession(sessionId)
      if (!thread) continue
      this.parkedState.delete(sessionId)
      this.states.mirror(thread.threadId, state)
    }
  }

  // =========================================================================
  // Commandes vers le shim
  // =========================================================================

  /** @returns {{ shimId:string, conn:object, sessionId:string }} */
  route(sessionId) {
    const shim = this.shims.forSession(sessionId)
    const conn = shim ? this.byShim.get(shim.shimId) : null
    if (!shim || !conn) {
      throw Object.assign(
        new Error("ce thread n'est pas ouvert dans Zed : aucun agent ne l'écoute"),
        { code: 'inject_failed' },
      )
    }
    return { shimId: shim.shimId, conn, sessionId }
  }

  /**
   * Envoie une commande et attend son accusé. Un `ack` en échec devient une
   * erreur portant le code du protocole (`inject_failed`, `permission_expired`…).
   */
  command(sessionId, cmd, payload = {}) {
    // Le routage a lieu **dans** la promesse : un thread sans shim doit se
    // refuser par un rejet, comme n'importe quel autre échec d'injection, pas
    // par une exception synchrone que l'appelant devrait attraper autrement.
    return new Promise((resolve, reject) => {
      const { shimId, conn } = this.route(sessionId)
      const id = `c${this.nextCommandId++}`
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(Object.assign(new Error("le shim n'a pas répondu à temps"), { code: 'inject_failed' }))
      }, this.commandTimeoutMs)
      timer.unref?.()
      this.pending.set(id, { resolve, reject, timer, shimId })
      if (!conn.send({ type: 'cmd', id, cmd, sessionId, ...payload })) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(Object.assign(new Error('shim injoignable'), { code: 'inject_failed' }))
      }
    })
  }

  ack(msg) {
    const waiter = this.pending.get(msg.id)
    if (!waiter) return
    this.pending.delete(msg.id)
    clearTimeout(waiter.timer)
    if (msg.ok) waiter.resolve(msg.result ?? null)
    else waiter.reject(Object.assign(new Error(msg.message || 'échec'), { code: msg.code || 'inject_failed' }))
  }

  close() {
    this.threads.off('change', this.onThreads)
    for (const waiter of this.pending.values()) clearTimeout(waiter.timer)
    this.pending.clear()
    for (const { conn } of this.conns.values()) conn.close(1001)
    this.conns.clear()
    this.byShim.clear()
  }
}
