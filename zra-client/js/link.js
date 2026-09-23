// Transport mobile <-> daemon : un WebSocket par poste, reconnexion à backoff.
// Le mode mock (js/mock/mock-link.js) expose exactement la même interface.

import { emitter } from './dom.js'

const BACKOFF = [500, 1000, 2000, 4000, 8000, 15000]

export function wsUrl(base) {
  const u = new URL(base, location.href)
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
  u.pathname = u.pathname.replace(/\/+$/, '') + '/ws'
  u.search = ''
  u.hash = ''
  return u.toString()
}

export class DaemonLink {
  /**
   * @param {{id:string, url:string, clientId:string, token?:()=>string|null}} opts
   *   `token` : lu à chaque connexion — il arrive après l'appairage.
   */
  constructor({ id, url, clientId, token = () => null }) {
    this.id = id
    this.url = url
    this.clientId = clientId
    this.token = token
    this.status = 'idle' // idle | connecting | online | offline
    this.lastError = null
    this.attempt = 0
    this.ws = null
    this.closedByUs = false
    this.pending = []
    const e = emitter()
    this.on = e.on
    this.emit = e.emit
  }

  get isMock() { return false }

  connect() {
    this.closedByUs = false
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return
    this.setStatus('connecting')
    let ws
    try {
      ws = new WebSocket(wsUrl(this.url))
    } catch (err) {
      this.fail(err)
      return
    }
    this.ws = ws

    ws.onopen = () => {
      this.attempt = 0
      this.lastError = null
      this.setStatus('online')
      const token = this.token()
      this.send(token ? { type: 'hello', clientId: this.clientId, token } : { type: 'hello', clientId: this.clientId })
      const queued = this.pending
      this.pending = []
      for (const msg of queued) this.send(msg)
    }

    ws.onmessage = (ev) => {
      let msg
      try { msg = JSON.parse(ev.data) } catch { return console.warn('[link] trame illisible', ev.data) }
      this.emit('message', msg)
    }

    ws.onerror = () => { this.lastError = 'connexion impossible' }

    ws.onclose = () => {
      this.ws = null
      if (this.closedByUs) { this.setStatus('idle'); return }
      this.setStatus('offline')
      this.scheduleRetry()
    }
  }

  scheduleRetry() {
    const delay = BACKOFF[Math.min(this.attempt, BACKOFF.length - 1)]
    this.attempt++
    clearTimeout(this.retryTimer)
    this.retryTimer = setTimeout(() => this.connect(), delay + Math.random() * 300)
    this.emit('retry', { in: delay, attempt: this.attempt })
  }

  fail(err) {
    this.lastError = String(err?.message || err)
    this.setStatus('offline')
    this.scheduleRetry()
  }

  /** Reconnexion immédiate (retour au premier plan, bouton « réessayer »). */
  wake() {
    if (this.status === 'online' || this.status === 'connecting') return
    clearTimeout(this.retryTimer)
    this.attempt = 0
    this.connect()
  }

  send(msg) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg))
      return true
    }
    // Les intentions utilisateur (envoi, abonnement) sont rejouées à la reconnexion.
    if (msg.type !== 'hello') this.pending.push(msg)
    return false
  }

  close() {
    this.closedByUs = true
    clearTimeout(this.retryTimer)
    this.ws?.close()
    this.ws = null
    this.setStatus('idle')
  }

  setStatus(s) {
    if (this.status === s) return
    this.status = s
    this.emit('status', s)
  }
}
