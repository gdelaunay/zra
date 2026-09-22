// Backend d'injection `acp` — spec §6.1, backend par défaut.
//
// Le shim émet lui-même un `session/prompt` vers l'agent, comme s'il venait de
// Zed : rapide, robuste, sans dépendance à l'état de la fenêtre.
//
// **Limite connue et assumée** (risque 🟡6) : Zed n'ayant pas émis ce prompt, le
// message de l'utilisateur n'apparaîtra pas dans son panel. La réponse de
// l'agent, elle, transite par le shim et s'affiche normalement des deux côtés.
//
// Ce backend ne décide de rien : il traduit un `threadId` en `session_id` et
// transmet. La machine à états, la file d'attente et la course aux permissions
// vivent dans le shim, seul à voir le trafic réel (spec §6.4).

import { InjectionError } from './backend.js'

export class AcpBackend {
  /**
   * @param {{
   *   host: import('../shim-link.js').ShimHost,
   *   threads: import('../threads-index.js').ThreadsIndex,
   * }} ctx
   */
  constructor({ host, threads }) {
    this.host = host
    this.threads = threads
    this.name = 'acp'
    /**
     * Le daemon ne met rien en file : c'est le shim qui tient la file et le tour
     * (spec §6.4). Le hub s'appuie sur ce drapeau pour ne pas doubler l'état.
     */
    this.ownsQueue = true
  }

  /** @returns {string} le `session_id` ACP d'un thread, ou une erreur du protocole. */
  session(threadId) {
    const thread = this.threads.get(threadId)
    if (!thread) throw new InjectionError('unknown_thread', 'thread inconnu de cet index')
    if (!thread.sessionId) throw new InjectionError('no_session', "thread sans session : impossible d'y écrire")
    return thread.sessionId
  }

  /** Toute erreur venue du shim ressort avec un code du protocole (§4). */
  async run(threadId, cmd, payload) {
    const sessionId = this.session(threadId)
    try {
      return await this.host.command(sessionId, cmd, payload)
    } catch (err) {
      if (err instanceof InjectionError) throw err
      throw new InjectionError(err?.code || 'inject_failed', err?.message || 'injection refusée')
    }
  }

  send(threadId, text, mode = 'queue') {
    return this.run(threadId, 'prompt', { text, mode })
  }

  interrupt(threadId) {
    return this.run(threadId, 'cancel', {})
  }

  setOption(threadId, key, value) {
    return this.run(threadId, 'set_option', { key, value })
  }

  cancelQueued(threadId, queueId) {
    return this.run(threadId, 'cancel_queued', { queueId })
  }

  respondPermission(threadId, requestId, optionId) {
    return this.run(threadId, 'respond_permission', { requestId, optionId })
  }
}
