// Liaison shim → daemon — spec §3.1.
//
// **Fail-open, règle absolue.** Daemon injoignable, planté ou lent ⇒ le shim
// reste un tuyau parfaitement transparent. Tout est donc non bloquant et
// best-effort : aucune écriture n'attend d'accusé, aucune erreur ne remonte
// jusqu'au proxy, et la reconnexion se fait en arrière-plan avec backoff.
//
// Le lien est local (`127.0.0.1`) : c'est une conversation entre deux processus
// du même poste, distincte du protocole PWA ↔ daemon du `PROTOCOL.md`.
//
//   shim → daemon   shim_hello · session · acp_update · state ·
//                   permission_resolved · permission_expired · notice · ack
//   daemon → shim   cmd { id, cmd: prompt|cancel|set_option|
//                                 respond_permission|cancel_queued }

const BACKOFF_MIN = 500
const BACKOFF_MAX = 15_000
/** Tampon de sortie borné : un daemon absent ne doit pas faire enfler le shim. */
const OUTBOX_MAX = 500

export class DaemonLink {
  /**
   * @param {{
   *   url:string, shimId:string, describe:()=>object,
   *   onCommand:(cmd:object)=>Promise<object>, log?:object,
   * }} opts
   */
  constructor({ url, shimId, describe, onCommand, log = null }) {
    this.url = url
    this.shimId = shimId
    this.describe = describe
    this.onCommand = onCommand
    this.log = log

    this.ws = null
    this.stopped = false
    this.backoff = BACKOFF_MIN
    this.timer = null
    /** @type {object[]} */
    this.outbox = []
  }

  start() {
    this.stopped = false
    this.connect()
    return this
  }

  connect() {
    if (this.stopped || this.ws) return
    let ws
    try {
      ws = new WebSocket(this.url)
    } catch (err) {
      this.log?.debug('daemon injoignable :', err.message)
      return this.retry()
    }
    this.ws = ws
    let opened = false

    ws.addEventListener('open', () => {
      opened = true
      this.backoff = BACKOFF_MIN
      // Une fois par connexion effective : c'est l'étape 2 du test réel.
      this.log?.info(`daemon connecté (${this.url})`)
      this.push({ type: 'shim_hello', shimId: this.shimId, ...this.describe() })
      this.flush()
    })

    ws.addEventListener('message', (ev) => {
      let msg
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)) } catch { return }
      if (!msg || typeof msg.type !== 'string') return
      this.handle(msg).catch((err) => this.log?.debug('commande :', err.message))
    })

    const gone = () => {
      if (this.ws !== ws) return
      if (opened) this.log?.info('lien daemon perdu, reconnexion en arrière-plan')
      this.ws = null
      this.retry()
    }
    ws.addEventListener('close', gone)
    ws.addEventListener('error', () => {
      // `error` précède toujours `close` : on laisse `close` reprogrammer.
      this.log?.debug('lien daemon en erreur')
    })
  }

  retry() {
    if (this.stopped || this.timer) return
    const jitter = Math.floor(Math.random() * 250)
    this.timer = setTimeout(() => {
      this.timer = null
      this.connect()
    }, this.backoff + jitter)
    this.timer.unref?.()
    this.backoff = Math.min(this.backoff * 2, BACKOFF_MAX)
  }

  /** Envoi best-effort. Hors ligne, on garde les dernières trames, bornées. */
  push(msg) {
    if (this.ws && this.ws.readyState === 1) {
      try {
        this.ws.send(JSON.stringify(msg))
        return true
      } catch (err) {
        this.log?.debug('envoi impossible :', err.message)
      }
    }
    // `shim_hello` est reconstruit à chaque ouverture : inutile de l'empiler.
    if (msg.type === 'shim_hello') return false
    this.outbox.push(msg)
    if (this.outbox.length > OUTBOX_MAX) this.outbox.splice(0, this.outbox.length - OUTBOX_MAX)
    return false
  }

  flush() {
    const pending = this.outbox
    this.outbox = []
    for (const msg of pending) this.push(msg)
  }

  async handle(msg) {
    if (msg.type !== 'cmd') return
    try {
      const result = await this.onCommand(msg)
      this.push({ type: 'ack', id: msg.id, ok: true, result: result ?? null })
    } catch (err) {
      this.push({
        type: 'ack',
        id: msg.id,
        ok: false,
        code: err?.code || 'inject_failed',
        message: err?.message || 'échec',
      })
    }
  }

  stop() {
    this.stopped = true
    clearTimeout(this.timer)
    this.timer = null
    try { this.ws?.close() } catch { /* déjà fermé */ }
    this.ws = null
  }
}
