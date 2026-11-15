// Serveur WebSocket (RFC 6455) minimal — aucune dépendance runtime.
//
// Le daemon bouchon (`zra-client/tools/mock-server.mjs`) avait déjà prouvé qu'une
// centaine de lignes suffisent. Cette version durcit ce qui manquait pour du
// long-running : fragmentation, ping/pong, fermeture propre, taille bornée, et
// détection des pairs morts — un daemon qui sert des shims et des mobiles sur
// des heures ne peut pas se contenter d'attendre que le pair parle.

import { EventEmitter } from 'node:events'
import { createHash, randomUUID } from 'node:crypto'
import { STATUS_CODES } from 'node:http'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/**
 * Ligne d'eau des sockets : plafond du tampon d'écriture par connexion, donc
 * de ce qu'un client gelé peut faire gonfler la mémoire du daemon avant que
 * `send()` ne le coupe (G1). Au-delà, `write` rend `false` — c'est le signal de
 * saturation. Même esprit que `OUTBOX_MAX` côté shim (`zra-shim/daemon-link.js`) :
 * un bout du canal borné, l'autre aussi. La PWA coupée se reconnecte et rejoue
 * l'historique (protocole §6).
 */
export const SOCKET_HWM = 4 * 1024 * 1024

/** Garde-fou mémoire : un prompt mobile légitime ne pèse pas 16 Mo. */
const MAX_MESSAGE = 16 * 1024 * 1024

/**
 * Sonde de vie. `http.Server` ouvre ses sockets en `allowHalfOpen` : un pair qui
 * disparaît sans fermer — téléphone qui s'endort, tunnel coupé, shim tué — laisse
 * le socket ouvert pour toujours côté daemon. On ping donc périodiquement, et on
 * coupe qui ne répond pas. Navigateurs comme undici répondent au PING au niveau
 * protocole, sans code applicatif.
 */
const PING_MS = 20_000
/** Trois sondes sans réponse : le pair est parti, pas juste lent. */
const PONG_TIMEOUT_MS = 75_000
/** Délai laissé au pair pour boucler la fermeture après notre trame CLOSE. */
const CLOSE_GRACE_MS = 2_000

/**
 * Plafonds des connexions pas encore appairées : sans eux, un client du réseau
 * peut ouvrir autant de sockets qu'il veut et saturer la mémoire du daemon.
 * Tant que le jeton n'est pas présenté, les messages sont limités à
 * `UNPAIRED_MAX_MESSAGE` (l'appairage ne transporte que de petits objets) ;
 * le délai laisse le temps de lire le code dans le journal et de le saisir.
 */
const UNPAIRED_PER_IP = 8
const UNPAIRED_TOTAL = 64
const UNPAIRED_TIMEOUT_MS = 120_000
const UNPAIRED_MAX_MESSAGE = 64 * 1024

const OP = { CONT: 0x0, TEXT: 0x1, BIN: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa }

export function acceptKey(key) {
  return createHash('sha1').update(key + GUID).digest('base64')
}

/** Encode une trame serveur (jamais masquée). */
export function encodeFrame(payload, opcode = OP.TEXT) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8')
  const len = data.length
  let head
  if (len < 126) {
    head = Buffer.alloc(2)
    head[1] = len
  } else if (len < 65536) {
    head = Buffer.alloc(4)
    head[1] = 126
    head.writeUInt16BE(len, 2)
  } else {
    head = Buffer.alloc(10)
    head[1] = 127
    head.writeBigUInt64BE(BigInt(len), 2)
  }
  head[0] = 0x80 | opcode // FIN + opcode
  return Buffer.concat([head, data])
}

/**
 * Décodeur incrémental. Renvoie les événements complets contenus dans le tampon :
 * `{text}`, `{ping, payload}`, `{pong}`, `{close, code}`, `{error}`.
 * `maxMessage` peut être une fonction, réévaluée à chaque poussée (plafond
 * réduit tant qu'une connexion n'est pas appairée, voir `attachWebSocket`).
 */
export function createDecoder({ maxMessage = MAX_MESSAGE } = {}) {
  let buf = Buffer.alloc(0)
  let fragments = []
  let fragmentOp = null

  return function push(chunk) {
    const limit = typeof maxMessage === 'function' ? maxMessage() : maxMessage
    buf = chunk ? Buffer.concat([buf, chunk]) : buf
    const out = []

    for (;;) {
      if (buf.length < 2) break
      const fin = (buf[0] & 0x80) === 0x80
      const rsv = buf[0] & 0x70
      const opcode = buf[0] & 0x0f
      const masked = (buf[1] & 0x80) === 0x80
      let len = buf[1] & 0x7f
      let off = 2

      if (rsv !== 0) { out.push({ error: 'bits RSV non supportés', code: 1002 }); break }

      if (len === 126) {
        if (buf.length < 4) break
        len = buf.readUInt16BE(2)
        off = 4
      } else if (len === 127) {
        if (buf.length < 10) break
        const big = buf.readBigUInt64BE(2)
        if (big > BigInt(limit)) { out.push({ error: 'trame trop grande', code: 1009 }); break }
        len = Number(big)
        off = 10
      }

      // RFC 6455 §5.1 : un client DOIT masquer.
      if (!masked) { out.push({ error: 'trame client non masquée', code: 1002 }); break }
      if (buf.length < off + 4 + len) break

      const mask = buf.subarray(off, off + 4)
      const body = Buffer.from(buf.subarray(off + 4, off + 4 + len))
      for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4]
      buf = buf.subarray(off + 4 + len)

      // Trames de contrôle : jamais fragmentées, charge ≤ 125 octets.
      if (opcode >= 0x8) {
        if (!fin || len > 125) { out.push({ error: 'trame de contrôle invalide', code: 1002 }); break }
        if (opcode === OP.CLOSE) {
          out.push({ close: true, code: len >= 2 ? body.readUInt16BE(0) : 1005 })
          break
        }
        if (opcode === OP.PING) out.push({ ping: true, payload: body })
        if (opcode === OP.PONG) out.push({ pong: true })
        continue
      }

      if (opcode === OP.CONT) {
        if (fragmentOp === null) { out.push({ error: 'continuation sans début', code: 1002 }); break }
        fragments.push(body)
      } else {
        if (fragmentOp !== null) { out.push({ error: 'nouvelle trame en pleine fragmentation', code: 1002 }); break }
        fragmentOp = opcode
        fragments = [body]
      }

      const total = fragments.reduce((n, f) => n + f.length, 0)
      if (total > limit) { out.push({ error: 'message trop grand', code: 1009 }); break }

      if (fin) {
        const full = fragments.length === 1 ? fragments[0] : Buffer.concat(fragments)
        const op = fragmentOp
        fragments = []
        fragmentOp = null
        // Le protocole ZRA est exclusivement textuel ; le binaire est ignoré.
        if (op === OP.TEXT) out.push({ text: full.toString('utf8') })
      }
    }

    return out
  }
}

/** Une connexion cliente. Émet `message` (objet JSON) et `close`. */
export class WsConnection extends EventEmitter {
  constructor(socket, { origin, remoteAddress, log }) {
    super()
    this.id = randomUUID().slice(0, 8)
    this.socket = socket
    this.origin = origin || null
    this.remoteAddress = remoteAddress || null
    this.alive = true
    /** Dernier signe de vie du pair : trame reçue, PONG, ou ouverture. */
    this.lastSeen = Date.now()
    /** Jeton validé (ou loopback exemptée) : la connexion n'est plus comptée. */
    this.authenticated = false
    /** Tranche le socket si le pair ne boucle pas la fermeture (voir `close()`). */
    this.killTimer = null
    this.log = log
    /** Tampon d'écriture bouché : `write` a rendu `false`, pas encore de `drain`. */
    this.plugged = false
    try { this.socket.on?.('drain', () => { this.plugged = false }) } catch { /* socket réduit */ }
  }

  /** Envoi best-effort : un client mort ne doit jamais faire tomber le daemon. */
  send(msg) {
    if (!this.alive) return false
    try {
      const flushed = this.socket.write(encodeFrame(JSON.stringify(msg)))
      // Backpressure (G1) : `write` rend `false` quand le tampon déborde sa
      // ligne d'eau. Un client vivant le draine (`drain` remet `plugged` à
      // faux) ; si on doit réécrire avant, le client est gelé (mobile bloqué,
      // cellule faible) — on le coupe plutôt que de gonfler la mémoire du
      // daemon sans plafond, même règle que `OUTBOX_MAX` côté shim
      // (`zra-shim/daemon-link.js`). La PWA se reconnecte et rejoue
      // l'historique (protocole §6).
      if (this.plugged) {
        this.log?.warn?.(`client ${this.id} : tampon d'écriture saturé, connexion coupée`)
        this.destroy()
        return false
      }
      if (flushed === false) this.plugged = true
      return true
    } catch (err) {
      this.log?.debug(`client ${this.id} : écriture impossible`, err.message)
      this.destroy()
      return false
    }
  }

  /** Un signe du pair — trame quelconque, PONG compris — suffit à le dire vivant. */
  touch() {
    this.lastSeen = Date.now()
  }

  /** Le client a présenté un jeton valide (ou la loopback en est exemptée). */
  authenticate() {
    if (this.authenticated) return
    this.authenticated = true
    this.emit('authenticated')
  }

  /** Sonde de vie : PING protocol-level, le pair doit répondre PONG. */
  ping() {
    if (!this.alive) return false
    try {
      this.socket.write(encodeFrame(Buffer.alloc(0), OP.PING))
      return true
    } catch {
      this.destroy()
      return false
    }
  }

  /**
   * Fermeture WebSocket propre : trame CLOSE puis FIN.
   *
   * `socket.end()` seul est un **half-close** : il attend le FIN retour. Un pair
   * déjà mort ne l'enverra jamais, et le socket reste en CLOSE_WAIT côté daemon
   * sans que l'événement `close` ne se déclenche — c'est ainsi que les shims
   * fantômes s'accumulaient au registre après la fermeture de Zed (ISSUES.md).
   * On laisse au pair un court délai pour boucler, puis on tranche.
   */
  close(code = 1000) {
    if (!this.alive) return
    this.alive = false
    const payload = Buffer.alloc(2)
    payload.writeUInt16BE(code, 0)
    try {
      this.socket.write(encodeFrame(payload, OP.CLOSE))
      this.socket.end()
    } catch { /* déjà fermé */ }
    this.killTimer = setTimeout(() => this.destroySocket(), CLOSE_GRACE_MS)
    this.killTimer.unref?.()
    this.emit('close')
  }

  /** Coupe net : pas de trame CLOSE, pas d'attente. `close` n'est émis qu'une fois. */
  destroy() {
    const was = this.alive
    this.alive = false
    this.destroySocket()
    if (was) this.emit('close')
  }

  destroySocket() {
    if (this.killTimer) { clearTimeout(this.killTimer); this.killTimer = null }
    try { this.socket.destroy() } catch { /* déjà fermé */ }
  }
}

/**
 * Greffe le WebSocket sur un serveur HTTP/HTTPS.
 *
 * Plusieurs chemins cohabitent sur le même port : `/ws` pour la PWA (protocole
 * §1) et `/shim` pour les shims locaux (lot B). Chacun a sa propre vérification
 * — l'allowlist d'`Origin` d'un côté, la loopback de l'autre.
 *
 * `verify({ req, origin })` retourne `true`, ou `{ ok:false, status, reason }`
 * pour refuser avant l'upgrade (allowlist d'Origin, `authenticate()`).
 */
export function attachWebSocket(server, {
  path = '/ws', verify, onConnection, routes, log, unpaired = false,
  pingMs = PING_MS, pongTimeoutMs = PONG_TIMEOUT_MS,
  unpairedPerIp = UNPAIRED_PER_IP, unpairedTotal = UNPAIRED_TOTAL,
  unpairedTimeoutMs = UNPAIRED_TIMEOUT_MS,
} = {}) {
  const clients = new Set()
  const table = routes?.length ? routes : [{ path, verify, onConnection, unpaired }]
  /** Connexions comptées, en attente d'un jeton, par adresse distante. */
  const unpairedByIp = new Map()
  let unpairedCount = 0

  server.on('upgrade', (req, socket) => {
    const url = (req.url || '').split('?')[0].replace(/\/+$/, '') || '/'
    const route = table.find((r) => (r.path || '/ws') === url)
    if (!route) return refuse(socket, 404, 'chemin inconnu')

    const key = req.headers['sec-websocket-key']
    const version = req.headers['sec-websocket-version']
    if (!key || String(version) !== '13') return refuse(socket, 400, 'handshake invalide')

    const ip = req.socket.remoteAddress || '?'
    const counted = route.unpaired === true
    if (counted && ((unpairedByIp.get(ip) ?? 0) >= unpairedPerIp || unpairedCount >= unpairedTotal)) {
      log?.warn(`upgrade refusé (trop de connexions non appairées) ip=${ip}`)
      return refuse(socket, 429, 'trop de connexions non appairées')
    }

    const origin = req.headers.origin || null
    const verdict = route.verify ? route.verify({ req, origin }) : true
    if (verdict !== true) {
      const { status = 403, reason = 'refusé' } = verdict || {}
      log?.warn(`upgrade refusé (${reason}) origin=${origin ?? '—'} ip=${ip}`)
      return refuse(socket, status, reason)
    }

    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
    )
    socket.setNoDelay(true)

    const conn = new WsConnection(socket, { origin, remoteAddress: ip, log })
    clients.add(conn)

    let tracked = false
    let authTimer = null
    if (counted) {
      tracked = true
      unpairedByIp.set(ip, (unpairedByIp.get(ip) ?? 0) + 1)
      unpairedCount++
      const release = () => {
        if (!tracked) return
        tracked = false
        clearTimeout(authTimer)
        const left = (unpairedByIp.get(ip) ?? 1) - 1
        if (left > 0) unpairedByIp.set(ip, left)
        else unpairedByIp.delete(ip)
        unpairedCount--
      }
      authTimer = setTimeout(() => {
        if (conn.authenticated) return release()
        log?.info(`client ${conn.id} : appairage non terminé après ${Math.round(unpairedTimeoutMs / 1000)} s, connexion coupée`)
        release()
        conn.close(4401)
      }, unpairedTimeoutMs)
      authTimer.unref?.()
      conn.once('authenticated', release)
      conn.once('close', release)
    }

    const decode = createDecoder({
      maxMessage: counted ? () => (conn.authenticated ? MAX_MESSAGE : UNPAIRED_MAX_MESSAGE) : MAX_MESSAGE,
    })
    socket.on('data', (chunk) => {
      conn.touch()
      for (const ev of decode(chunk)) {
        if (ev.error) { log?.debug(`client ${conn.id} : ${ev.error}`); conn.close(ev.code); return }
        if (ev.close) { conn.closeCode = ev.code; conn.close(1000); return }
        if (ev.ping) { try { socket.write(encodeFrame(ev.payload, OP.PONG)) } catch { /* fermé */ } continue }
        if (ev.pong) continue
        if (!ev.text) continue
        let msg
        try { msg = JSON.parse(ev.text) } catch { log?.debug(`client ${conn.id} : trame illisible`); continue }
        if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') continue
        conn.emit('message', msg)
      }
    })

    const bye = () => { clients.delete(conn); conn.destroy() }
    socket.on('close', bye)
    socket.on('error', bye)
    // Le pair a fermé son côté en écriture : un shim tué par Zed n'envoie qu'un
    // FIN, sans trame CLOSE. En `allowHalfOpen`, `close` ne viendrait jamais de
    // lui-même — le FIN **est** la fin de la connexion, on la prend comme telle.
    socket.on('end', bye)
    conn.on('close', () => clients.delete(conn))

    route.onConnection?.(conn)
  })

  // Balayage de vie : qui n'a rien dit depuis `pongTimeoutMs` est parti.
  const sweeper = pingMs > 0 ? setInterval(() => {
    const now = Date.now()
    for (const conn of [...clients]) {
      if (now - conn.lastSeen > pongTimeoutMs) {
        log?.info(`client ${conn.id} : muet depuis ${Math.round((now - conn.lastSeen) / 1000)} s, connexion coupée`)
        clients.delete(conn)
        conn.destroy()
        continue
      }
      conn.ping()
    }
  }, pingMs) : null
  sweeper?.unref?.()

  return {
    clients,
    closeAll(code = 1001) {
      for (const c of [...clients]) c.close(code)
      clients.clear()
    },
    /** Arrête le balayage : à appeler quand l'écoute est fermée. */
    stop() {
      if (sweeper) clearInterval(sweeper)
    },
  }
}

function refuse(socket, status, reason) {
  // La raison détaillée va au journal ; le statut HTTP reste ASCII.
  const text = `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? 'Error'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`
  try { socket.write(text); socket.destroy() } catch { /* déjà fermé */ }
}
