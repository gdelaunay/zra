// Transport mobile <-> daemon : un WebSocket par poste, reconnexion à backoff.
// Le mode mock (js/mock/mock-link.js) expose exactement la même interface.

import { emitter } from './dom.js'

const BACKOFF = [1000, 2000, 4000, 8000, 16000, 30000]
/** Au-delà du backoff court : un poste mort est retenté à ce rythme, pas plus (RECONNECT-SPEC §1). */
const LONG_BACKOFF_MS = 60000
/**
 * Filet anti-bloqué-infini (RECONNECT-SPEC §2) : sans lui, un handshake qui ne
 * finit jamais (proxy qui retient la connexion, socket morte en `CONNECTING`)
 * ne déclenche ni `onopen` ni `onclose` — aucun timer ne tourne, la chaîne de
 * reconnexion est morte et `wake()` ne fait rien sur `'connecting'`.
 * Généreux à dessein : un faux positif coûte une connexion lente mais légitime.
 */
const CONNECT_TIMEOUT_MS = 15000
/** Un `ping` applicatif à cet intervalle : le navigateur n'expose pas ceux du protocole. */
const HEARTBEAT_MS = 15000
/** Sans aucune trame reçue dans ce délai après un `ping`, la connexion est morte. */
const PONG_TIMEOUT_MS = 6000
/** Au retour au premier plan, on veut savoir vite. */
const PROBE_TIMEOUT_MS = 3000
/** Silence au-delà duquel une connexion « ouverte » est suspecte avant un envoi. */
const STALE_MS = HEARTBEAT_MS + PONG_TIMEOUT_MS

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
    /** Dernière trame reçue (ms) : toute trame prouve que la connexion vit. */
    this.lastRx = 0
    /** Sonde en cours : les envois attendent sa réponse (voir `send`). */
    this.probing = false
    /** Threads auxquels la connexion courante s'est abonnée (voir `subscribedHere`). */
    this.subs = new Set()
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
    // RECONNECT-SPEC §2 : borner le handshake. S'il aboutit, `onopen` l'annule ;
    // sinon `lost()` relance le `scheduleRetry` normal (et donc le plateau §1).
    clearTimeout(this.connectTimer)
    this.connectTimer = setTimeout(() => this.lost(ws, 'délai de connexion dépassé'), CONNECT_TIMEOUT_MS)

    ws.onopen = () => {
      clearTimeout(this.connectTimer)
      this.attempt = 0
      this.lastError = null
      this.lastRx = Date.now()
      this.probing = false
      this.subs.clear()
      // `hello` d'abord : un poste qui exige l'appairage ignore tout ce qui le
      // précède. Le passage à `online` déclenche le réabonnement (store), qui
      // doit donc arriver après.
      const token = this.token()
      this.send(token ? { type: 'hello', clientId: this.clientId, token } : { type: 'hello', clientId: this.clientId })
      this.flush()
      this.startHeartbeat()
      this.setStatus('online')
    }

    ws.onmessage = (ev) => {
      this.lastRx = Date.now()
      if (this.probing) { this.probing = false; this.flush() }
      clearTimeout(this.pongTimer)
      let msg
      try { msg = JSON.parse(ev.data) } catch { return console.warn('[link] trame illisible', ev.data) }
      if (msg?.type === 'pong') return
      // Poste d'avant le heartbeat : il ne connaît pas `ping`, mais répond — ça suffit.
      if (msg?.type === 'error' && msg.code === 'unknown_message' && /\bping\b/.test(msg.message || '')) return
      this.emit('message', msg)
    }

    ws.onerror = () => { this.lastError = 'connexion impossible' }

    ws.onclose = (ev) => {
      console.debug(`[link] ${this.id} : socket fermée (code=${ev?.code ?? '?'} raison=${ev?.reason || '—'})`)
      this.lost(ws)
    }
  }

  /**
   * Connexion perdue, ou tenue pour morte. Sur mobile, une socket peut rester
   * `OPEN` alors que plus rien ne passe (onglet gelé, changement de réseau) ;
   * `close()` n'y changerait rien avant longtemps : on l'abandonne tout de suite.
   */
  lost(ws, reason) {
    if (ws !== this.ws) return
    clearTimeout(this.connectTimer)
    this.stopHeartbeat()
    this.probing = false
    ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null
    try { ws.close() } catch { /* déjà fermée */ }
    this.ws = null
    if (this.closedByUs) { this.setStatus('idle'); return }
    if (reason) this.lastError = reason
    console.debug(`[link] ${this.id} : connexion perdue (${reason || 'fermée'})`)
    this.setStatus('offline')
    this.scheduleRetry()
  }

  startHeartbeat() {
    this.stopHeartbeat()
    this.heartbeat = setInterval(() => this.probe(PONG_TIMEOUT_MS), HEARTBEAT_MS)
  }

  stopHeartbeat() {
    clearInterval(this.heartbeat)
    clearTimeout(this.pongTimer)
  }

  /** `ping` ; sans aucune trame en retour dans `timeout` ms, la connexion est abandonnée. */
  probe(timeout = PROBE_TIMEOUT_MS) {
    const ws = this.ws
    if (ws?.readyState !== WebSocket.OPEN) return
    this.probing = true
    clearTimeout(this.pongTimer)
    this.pongTimer = setTimeout(() => this.lost(ws, 'le poste ne répond plus'), timeout)
    try { ws.send(JSON.stringify({ type: 'ping' })) } catch { this.lost(ws, 'connexion coupée') }
  }

  flush() {
    const queued = this.pending
    this.pending = []
    for (const msg of queued) this.send(msg)
  }

  scheduleRetry() {
    // Backoff court doublé, puis plateau long : un poste définitivement hors
    // ligne est retenté toutes les ~60 s, pas toutes les 15 s pour toujours.
    const delay = this.attempt < BACKOFF.length ? BACKOFF[this.attempt] : LONG_BACKOFF_MS
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

  /**
   * Retour au premier plan, réseau revenu, bouton « réessayer ». En ligne, on
   * vérifie que la connexion vit encore ; sinon, reconnexion immédiate.
   */
  wake() {
    if (this.status === 'online') return this.probe()
    if (this.status === 'connecting') return
    clearTimeout(this.retryTimer)
    this.attempt = 0
    this.connect()
  }

  send(msg) {
    // Connexion silencieuse depuis trop longtemps (onglet gelé en arrière-plan) :
    // on s'assure qu'elle vit avant de lui confier un message, qui serait perdu
    // sans erreur sur une socket morte. Il part à la réponse, ou à la reconnexion.
    if (!this.probing && msg.type !== 'hello' && Date.now() - this.lastRx > STALE_MS) this.probe()
    if (this.probing && msg.type !== 'hello') {
      this.pending.push(msg)
      return false
    }
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg))
      if (msg.type === 'subscribe') this.subs.add(msg.threadId)
      else if (msg.type === 'unsubscribe') this.subs.delete(msg.threadId)
      return true
    }
    // Les intentions utilisateur (envoi, abonnement) sont rejouées à la reconnexion.
    if (msg.type !== 'hello') this.pending.push(msg)
    return false
  }

  /** L'abonnement est déjà parti sur cette connexion (file d'attente vidée à l'ouverture). */
  subscribedHere(threadId) { return this.subs.has(threadId) }

  close() {
    this.closedByUs = true
    clearTimeout(this.retryTimer)
    clearTimeout(this.connectTimer)
    this.stopHeartbeat()
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
