// Transport mobile <-> daemon : un WebSocket par poste, reconnexion à backoff.
// Le mode mock (js/mock/mock-link.js) expose exactement la même interface.

import { emitter } from './dom.js'
import { tr } from './i18n.js'

const BACKOFF = [1000, 2000, 4000, 8000, 16000, 30000]
/** Au-delà du backoff court : un poste mort est retenté à ce rythme, pas plus. */
const LONG_BACKOFF_MS = 60000
/**
 * Filet anti-bloqué-infini : sans lui, un handshake qui ne
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

/**
 * File hors ligne : les lectures (abonnements, historique, liste) se rejouent
 * toujours ; les écritures périment. Un « supprime le dossier build » tapé dans
 * le métro ne doit pas partir deux heures plus tard, dans un contexte qui a
 * changé : au-delà du délai, il est abandonné et le texte revient au composeur
 * (événement `dropped`, repris par le store).
 */
const WRITE_TTL_MS = 10_000
const PENDING_MAX = 100
const READS = new Set(['subscribe', 'unsubscribe', 'load_history', 'list_threads', 'pair'])

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
    /** Explication posée par `diagnose()` : prime sur les messages génériques. */
    this.diag = null
    /** Échecs consécutifs : à partir de trois, `diagnose()` dit pourquoi. */
    this.failStreak = 0
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
    // Diagnostic rafales de retries (ISSUES.md) : chaque tentative est datée,
    // pour corréler avec le journal daemon ce qui n'arrive jamais jusqu'à lui.
    console.debug(`[link] ${this.id} : connexion → ${this.url} (tentative ${this.attempt + 1})`)
    const t0 = Date.now()
    let ws
    try {
      ws = new WebSocket(wsUrl(this.url))
    } catch (err) {
      this.fail(err)
      return
    }
    this.ws = ws
    // Borner le handshake. S'il aboutit, `onopen` l'annule ;
    // sinon `lost()` relance le `scheduleRetry` normal (et donc le plateau §1).
    clearTimeout(this.connectTimer)
    this.connectTimer = setTimeout(() => this.lost(ws, tr`Délai de connexion dépassé.`), CONNECT_TIMEOUT_MS)

    ws.onopen = () => {
      console.debug(`[link] ${this.id} : socket ouverte en ${Date.now() - t0} ms`)
      clearTimeout(this.connectTimer)
      this.attempt = 0
      this.failStreak = 0
      this.diag = null
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

    ws.onerror = () => {
      console.debug(`[link] ${this.id} : erreur socket après ${Date.now() - t0} ms (état=${ws.readyState})`)
      this.lastError = this.diag || tr`Connexion impossible.`
    }

    ws.onclose = (ev) => {
      console.debug(`[link] ${this.id} : socket fermée après ${Date.now() - t0} ms (code=${ev?.code ?? '?'} raison=${ev?.reason || '—'})`)
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
    this.failStreak++
    if (reason) this.lastError = this.diag || reason
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
    this.pongTimer = setTimeout(() => this.lost(ws, tr`Le poste ne répond plus.`), timeout)
    try { ws.send(JSON.stringify({ type: 'ping' })) } catch { this.lost(ws, tr`Connexion coupée.`) }
  }

  flush() {
    const queued = this.pending
    this.pending = []
    for (const { msg, at } of queued) {
      if (!READS.has(msg.type) && Date.now() - at > WRITE_TTL_MS) {
        this.emit('dropped', msg)
        continue
      }
      this.send(msg)
    }
  }

  /** File bornée : au plafond, le plus ancien part (une écriture est signalée). */
  queue(msg) {
    if (this.pending.length >= PENDING_MAX) {
      const old = this.pending.shift()
      if (!READS.has(old.msg.type)) this.emit('dropped', old.msg)
    }
    this.pending.push({ msg, at: Date.now() })
  }

  scheduleRetry() {
    // Backoff court doublé, puis plateau long : un poste définitivement hors
    // ligne est retenté toutes les ~60 s, pas toutes les 15 s pour toujours.
    const delay = this.attempt < BACKOFF.length ? BACKOFF[this.attempt] : LONG_BACKOFF_MS
    this.attempt++
    clearTimeout(this.retryTimer)
    console.debug(`[link] ${this.id} : retry dans ${delay} ms (tentative ${this.attempt})`)
    this.retryTimer = setTimeout(() => this.connect(), delay + Math.random() * 300)
    this.emit('retry', { in: delay, attempt: this.attempt })
    // Le WebSocket ne dit pas pourquoi il échoue (`onerror` est opaque) : après
    // trois échecs, un GET sur la même adresse tranche (réseau, proxy, refus).
    if (this.failStreak >= 3 && (this.failStreak - 3) % 5 === 0) this.diagnose()
  }

  /**
   * Diagnostic des échecs répétés : un GET sur l'adresse du poste distingue le
   * réseau coupé du proxy qui répond mais d'un poste éteint, et du refus de
   * configuration. Le message remplace le « connexion impossible » aveugle
   * jusqu'à la reconnexion (`diag` prime sur les messages génériques).
   */
  async diagnose() {
    let msg
    try {
      const res = await fetch(this.url, { cache: 'no-store', signal: AbortSignal.timeout(5000) })
      if (res.status === 403) msg = tr`Accès refusé (403) — origine ou IP non autorisée (proxy, allowedOrigins).`
      else if (res.status === 502 || res.status === 503 || res.status === 504) msg = tr`Le proxy répond mais pas le poste — machine éteinte ou daemon arrêté ?`
      else if (!res.ok) msg = tr`Le serveur répond ${res.status} — configuration à vérifier.`
      else msg = tr`Le poste répond, mais le WebSocket échoue — réessai en cours.`
    } catch {
      msg = tr`Poste injoignable — réseau ou VPN coupé ?`
    }
    if (this.status === 'online') return
    this.diag = msg
    this.lastError = msg
    if (this.status === 'offline') this.emit('status', 'offline')
  }

  fail(err) {
    this.lastError = String(err?.message || err)
    this.failStreak++
    this.setStatus('offline')
    this.scheduleRetry()
  }

  /**
   * Retour au premier plan, réseau revenu, bouton « réessayer ». En ligne, on
   * vérifie que la connexion vit encore ; sinon, reconnexion immédiate.
   * `reset` (bouton explicite seul) remet le backoff à zéro ; les événements
   * automatiques le préservent — sinon chaque refocus relance une rafale.
   */
  wake(reset = false) {
    console.debug(`[link] ${this.id} : wake (état=${this.status})`)
    if (this.status === 'online') return this.probe()
    if (this.status === 'connecting') return
    clearTimeout(this.retryTimer)
    if (reset) this.attempt = 0
    this.connect()
  }

  send(msg) {
    // Connexion silencieuse depuis trop longtemps (onglet gelé en arrière-plan) :
    // on s'assure qu'elle vit avant de lui confier un message, qui serait perdu
    // sans erreur sur une socket morte. Il part à la réponse, ou à la reconnexion.
    if (!this.probing && msg.type !== 'hello' && Date.now() - this.lastRx > STALE_MS) this.probe()
    if (this.probing && msg.type !== 'hello') {
      this.queue(msg)
      return false
    }
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg))
      if (msg.type === 'subscribe') this.subs.add(msg.threadId)
      else if (msg.type === 'unsubscribe') this.subs.delete(msg.threadId)
      return true
    }
    // Les lectures sont rejouées à la reconnexion ; les écritures périment (flush).
    if (msg.type !== 'hello') this.queue(msg)
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
