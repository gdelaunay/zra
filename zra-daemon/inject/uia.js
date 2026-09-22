// Backend d'injection `uia` — spec §6.2, repli du risque 🔴1.
//
// C'est Zed qui émet le prompt : ZRA amène le thread au premier plan, tape le
// message dans le composer et valide. **Fidélité parfaite** — le message
// apparaît des deux côtés — au prix de la fragilité : fenêtre, focus, langue,
// version de Zed. Zed n'exposant rien à UI Automation, c'est du clavier
// (`zed/keyboard.ps1`) ; le nom `uia` reste celui de la spec et de la config.
//
// Seul `send` passe par le clavier. Couper un tour, changer d'option, répondre
// à une permission restent des commandes ACP du shim : le risque 🔴1 ne porte
// que sur `session/prompt`, et le clavier n'apporterait que de la fragilité.
//
// La preuve que Zed a bien envoyé le message vient du shim : le tour du thread
// visé passe `busy` dans les secondes qui suivent. Sans elle, l'envoi échoue
// explicitement — un message tapé au mauvais endroit ne doit pas passer pour
// un succès.

import { InjectionError } from './backend.js'
import { AcpBackend } from './acp.js'

export class UiaBackend {
  /**
   * @param {{
   *   host: import('../shim-link.js').ShimHost,
   *   threads: import('../threads-index.js').ThreadsIndex,
   *   states: import('../thread-state.js').ThreadStates,
   *   control: import('../zed/control.js').ZedControl,
   *   confirmMs?: number,
   * }} ctx
   */
  constructor({ host, threads, states, control, confirmMs = 5000 }) {
    this.acp = new AcpBackend({ host, threads })
    this.threads = threads
    this.states = states
    this.control = control
    this.confirmMs = confirmMs
    this.name = 'uia'
    /** Tour et file restent tenus par le shim (spec §6.4). */
    this.ownsQueue = true
  }

  async send(threadId, text, mode = 'queue') {
    const thread = this.threads.get(threadId)
    if (!thread) throw new InjectionError('unknown_thread', 'thread inconnu de cet index')
    if (!thread.sessionId) throw new InjectionError('no_session', "thread sans session : impossible d'y écrire")
    if (!this.control?.enabled) {
      throw new InjectionError('inject_failed',
        'injection clavier indisponible : pilotage de Zed désactivé (zedControl.enabled dans zra.config.json)')
    }

    if (this.states.get(threadId).turn === 'busy') {
      if (mode !== 'interrupt') {
        // La file du shim dépile par ACP : la mélanger au clavier enverrait les
        // messages par deux voies différentes. On refuse franchement.
        throw new InjectionError('inject_failed',
          "tour en cours : pas de file d'attente avec l'injection clavier — réessayer à la fin du tour, ou interrompre")
      }
      await this.acp.interrupt(threadId)
    }

    try {
      await this.control.focus(thread)
      const busy = this.waitBusy(threadId)
      try {
        await this.control.driver.submit(text)
      } catch (err) {
        busy.cancel()
        throw err
      }
      if (!(await busy.promise)) {
        throw new InjectionError('inject_failed',
          `Zed n'a pas émis le message en ${Math.round(this.confirmMs / 1000)} s : focus, fenêtre ou recette clavier à vérifier`)
      }
    } catch (err) {
      if (err instanceof InjectionError) throw err
      throw new InjectionError('inject_failed', err.message)
    }
    return { queued: false, via: 'uia' }
  }

  /** Le tour du thread passe `busy` : Zed a émis un `session/prompt`, vu par le shim. */
  waitBusy(threadId) {
    let cancel = () => {}
    const promise = new Promise((resolve) => {
      const onChange = (id) => {
        if (id !== threadId || this.states.get(threadId).turn !== 'busy') return
        cancel()
        resolve(true)
      }
      const timer = setTimeout(() => { cancel(); resolve(false) }, this.confirmMs)
      timer.unref?.()
      cancel = () => {
        clearTimeout(timer)
        this.states.off('change', onChange)
      }
      this.states.on('change', onChange)
    })
    return { promise, cancel: () => cancel() }
  }

  interrupt(threadId) { return this.acp.interrupt(threadId) }
  setOption(threadId, key, value) { return this.acp.setOption(threadId, key, value) }
  cancelQueued(threadId, queueId) { return this.acp.cancelQueued(threadId, queueId) }
  respondPermission(threadId, requestId, optionId) { return this.acp.respondPermission(threadId, requestId, optionId) }
}
