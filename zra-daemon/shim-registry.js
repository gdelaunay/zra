// Registre des shims connectés — spec §3.2.
//
// Un shim est lancé par Zed pour un agent ; il peut porter plusieurs sessions
// (risque 🟡4 : Zed lance un agent par fenêtre, pas par thread). C'est ce
// registre qui détermine si un thread est `live`.
//
// Lot A : toujours vide, aucun shim n'existe encore. L'API est complète pour que
// le lot B n'ait qu'à la remplir.

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
      sessions: new Set(shim.sessions ?? []),
      since: new Date().toISOString(),
    }
    this.shims.set(entry.shimId, entry)
    for (const s of entry.sessions) this.bySession.set(s, entry.shimId)
    this.emit('change', { added: entry.shimId })
    return entry
  }

  /** Un shim découvre une session à l'`initialize` ou à `session/new`. */
  addSession(shimId, sessionId) {
    const shim = this.shims.get(shimId)
    if (!shim || !sessionId || shim.sessions.has(sessionId)) return false
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
