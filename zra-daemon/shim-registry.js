// Registre des shims connectés.
//
// Un shim est lancé par Zed pour un agent ; il peut porter plusieurs sessions
// (Zed lance un agent par fenêtre, pas par thread). C'est ce
// registre qui détermine si un thread est `live`.

import { EventEmitter } from 'node:events'

export class ShimRegistry extends EventEmitter {
  constructor() {
    super()
    /** @type {Map<string, { shimId:string, agentId:string|null, sessions:Set<string>, since:string }>} */
    this.shims = new Map()
    /** Index inverse `session_id -> shimId`, pour une résolution en O(1). */
    this.bySession = new Map()
  }

  /** @param {{ shimId:string, agentId?:string|null, capabilities?:object }} shim */
  register(shim) {
    const entry = {
      shimId: shim.shimId,
      agentId: shim.agentId ?? null,
      capabilities: shim.capabilities ?? {},
      sessions: new Set(),
      since: new Date().toISOString(),
    }
    this.shims.set(entry.shimId, entry)
    for (const s of shim.sessions ?? []) {
      // Une session déjà tenue par un autre shim vivant ne se prend pas :
      // sinon un faux shim local détourne le routage d'un thread existant.
      const holder = this.bySession.get(s)
      if (holder && holder !== entry.shimId) continue
      entry.sessions.add(s)
      this.bySession.set(s, entry.shimId)
    }
    this.emit('change', { added: entry.shimId })
    return entry
  }

  /** Un shim découvre une session à l'`initialize` ou à `session/new`. */
  addSession(shimId, sessionId) {
    const shim = this.shims.get(shimId)
    if (!shim || !sessionId || shim.sessions.has(sessionId)) return false
    const holder = this.bySession.get(sessionId)
    if (holder && holder !== shimId) return false
    shim.sessions.add(sessionId)
    this.bySession.set(sessionId, shimId)
    this.emit('change', { session: sessionId })
    return true
  }

  unregister(shimId) {
    const shim = this.shims.get(shimId)
    if (!shim) return false
    for (const s of shim.sessions) {
      if (this.bySession.get(s) === shimId) this.bySession.delete(s)
    }
    this.shims.delete(shimId)
    this.emit('change', { removed: shimId })
    return true
  }

  /** @returns {boolean} un shim porte-t-il cette session ACP ? */
  hasSession(sessionId) {
    return Boolean(sessionId) && this.bySession.has(sessionId)
  }

  forSession(sessionId) {
    const shimId = this.bySession.get(sessionId)
    return shimId ? this.shims.get(shimId) : null
  }

  liveSessionIds() {
    return new Set(this.bySession.keys())
  }
}
