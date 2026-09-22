// Backend d'injection bouchon — spec §10.6.
//
// Valide toute la chaîne mobile → daemon → backend sans agent, sans UIA et sans
// Zed. Délibérément pauvre : les scénarios riches (diffs, terminaux,
// permissions) vivent dans le bouchon côté client (`zra-client/js/mock/`), et
// les dupliquer ici ne ferait que créer deux vérités à maintenir.

import { InjectionError } from './backend.js'

export class MockBackend {
  /** @param {{ states, emit:(threadId:string, update:object)=>void, threads, delayMs?:number }} ctx */
  constructor({ states, emit, threads, delayMs = 60 }) {
    this.states = states
    this.emit = emit
    this.threads = threads
    this.delayMs = delayMs
    this.name = 'mock'
    /** @type {Map<string, NodeJS.Timeout[]>} */
    this.timers = new Map()
  }

  /** Un thread sans `session_id` n'est pas adressable (spec §4). */
  assertAddressable(threadId) {
    const thread = this.threads?.get(threadId)
    if (thread && !thread.sessionId) {
      throw new InjectionError('no_session', "thread sans session : impossible d'y écrire")
    }
    return thread
  }

  async send(threadId, text, mode = 'queue') {
    this.assertAddressable(threadId)
    if (mode === 'interrupt' && this.states.get(threadId).turn === 'busy') {
      this.stop(threadId)
      this.emit(threadId, { sessionUpdate: 'zra/notice', text: 'tour interrompu', level: 'warn' })
    }
    this.emit(threadId, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text } })
    this.states.setTurn(threadId, 'busy')
    this.later(threadId, this.delayMs, () => {
      this.emit(threadId, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: `*(backend bouchon)* message reçu : ${text.length} caractère(s).` },
      })
      this.states.setTurn(threadId, 'idle')
    })
  }

  async setOption(threadId, key, value) {
    this.assertAddressable(threadId)
    this.states.setOption(threadId, key, value)
    this.emit(threadId, key === 'mode'
      ? { sessionUpdate: 'current_mode_update', currentModeId: value }
      : { sessionUpdate: 'zra/notice', text: `option ${key} : ${String(value)}` })
  }

  async interrupt(threadId) {
    if (this.states.get(threadId).turn !== 'busy') return
    this.stop(threadId)
    this.emit(threadId, { sessionUpdate: 'zra/notice', text: 'tour interrompu', level: 'warn' })
    this.states.setTurn(threadId, 'idle')
  }

  // ---- minuteries ----

  later(threadId, ms, fn) {
    const list = this.timers.get(threadId) || []
    const id = setTimeout(() => {
      this.timers.set(threadId, (this.timers.get(threadId) || []).filter((t) => t !== id))
      fn()
    }, ms)
    id.unref?.()
    list.push(id)
    this.timers.set(threadId, list)
  }

  stop(threadId) {
    for (const id of this.timers.get(threadId) || []) clearTimeout(id)
    this.timers.delete(threadId)
  }

  close() {
    for (const list of this.timers.values()) for (const id of list) clearTimeout(id)
    this.timers.clear()
  }
}
