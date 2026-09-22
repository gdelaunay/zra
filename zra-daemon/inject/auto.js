// Backend d'injection `auto` — spec §6.2 : `acp` d'abord, `uia` en repli.
//
// Le repli n'a lieu que sur un **refus explicite** de l'agent (`prompt_refused`,
// risque 🔴1) : l'agent a répondu en erreur au `session/prompt` injecté, donc
// rien n'est parti. Un silence de 5 s, lui, ne déclenche pas le repli, contrai-
// rement à la lettre de la spec : un agent lent qui aurait bien reçu le message
// le recevrait deux fois. L'envoi est alors considéré fait, non confirmé.

import { InjectionError } from './backend.js'
import { AcpBackend } from './acp.js'
import { UiaBackend } from './uia.js'
import { logger } from '../log.js'

const log = logger('inject')

export class AutoBackend {
  constructor(ctx) {
    this.acp = new AcpBackend(ctx)
    this.uia = new UiaBackend(ctx)
    this.confirmMs = ctx.confirmMs ?? 5000
    this.name = 'auto'
    this.ownsQueue = true
  }

  async send(threadId, text, mode = 'queue') {
    try {
      return await this.acp.send(threadId, text, mode, { confirmMs: this.confirmMs })
    } catch (err) {
      if (!(err instanceof InjectionError) || err.code !== 'prompt_refused') throw err
      log.warn(`injection ACP refusée sur ${threadId} (${err.message}) : repli clavier`)
    }
    try {
      return await this.uia.send(threadId, text, mode)
    } catch (err) {
      throw new InjectionError('inject_failed', `l'agent a refusé le message, et le repli clavier a échoué : ${err.message}`)
    }
  }

  interrupt(threadId) { return this.acp.interrupt(threadId) }
  setOption(threadId, key, value) { return this.acp.setOption(threadId, key, value) }
  cancelQueued(threadId, queueId) { return this.acp.cancelQueued(threadId, queueId) }
  respondPermission(threadId, requestId, optionId) { return this.acp.respondPermission(threadId, requestId, optionId) }
}
