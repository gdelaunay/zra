// Serveur WebSocket (RFC 6455) minimal — aucune dépendance runtime.
//
// Le daemon bouchon (`zra-client/tools/mock-server.mjs`) avait déjà prouvé qu'une
// centaine de lignes suffisent. Cette version durcit ce qui manquait pour du
// long-running : fragmentation, ping/pong, fermeture propre, taille bornée.

import { EventEmitter } from 'node:events'
import { createHash, randomUUID } from 'node:crypto'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** Garde-fou mémoire : un prompt mobile légitime ne pèse pas 16 Mo. */
const MAX_MESSAGE = 16 * 1024 * 1024

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
 */
export function createDecoder({ maxMessage = MAX_MESSAGE } = {}) {
  let buf = Buffer.alloc(0)
  let fragments = []
  let fragmentOp = null

  return function push(chunk) {
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
        if (big > BigInt(maxMessage)) { out.push({ error: 'trame trop grande', code: 1009 }); break }
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
      if (total > maxMessage) { out.push({ error: 'message trop grand', code: 1009 }); break }

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
    this.log = log
  }

  /** Envoi best-effort : un client mort ne doit jamais faire tomber le daemon. */
  send(msg) {
    if (!this.alive) return false
    try {
      this.socket.write(encodeFrame(JSON.stringify(msg)))
      return true
    } catch (err) {
      this.log?.debug(`client ${this.id} : écriture impossible`, err.message)
      this.destroy()
      return false
    }
  }

  close(code = 1000) {
    if (!this.alive) return
    this.alive = false
    const payload = Buffer.alloc(2)
    payload.writeUInt16BE(code, 0)
    try {
      this.socket.write(encodeFrame(payload, OP.CLOSE))
      this.socket.end()
    } catch { /* déjà fermé */ }
    this.emit('close')
  }

  destroy() {
    if (!this.alive) return
    this.alive = false
    try { this.socket.destroy() } catch { /* déjà fermé */ }
    this.emit('close')
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
export function attachWebSocket(server, { path = '/ws', verify, onConnection, routes, log } = {}) {
  const clients = new Set()
  const table = routes?.length ? routes : [{ path, verify, onConnection }]

  server.on('upgrade', (req, socket) => {
    const url = (req.url || '').split('?')[0].replace(/\/+$/, '') || '/'
    const route = table.find((r) => (r.path || '/ws') === url)
    if (!route) return refuse(socket, 404, 'chemin inconnu')

    const key = req.headers['sec-websocket-key']
    const version = req.headers['sec-websocket-version']
    if (!key || String(version) !== '13') return refuse(socket, 400, 'handshake invalide')

    const origin = req.headers.origin || null
    const verdict = route.verify ? route.verify({ req, origin }) : true
    if (verdict !== true) {
      const { status = 403, reason = 'refusé' } = verdict || {}
      log?.warn(`upgrade refusé (${reason}) origin=${origin ?? '—'} ip=${req.socket.remoteAddress}`)
      return refuse(socket, status, reason)
    }

    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
    )
    socket.setNoDelay(true)

    const conn = new WsConnection(socket, { origin, remoteAddress: req.socket.remoteAddress, log })
    clients.add(conn)

    const decode = createDecoder()
    socket.on('data', (chunk) => {
      for (const ev of decode(chunk)) {
        if (ev.error) { log?.debug(`client ${conn.id} : ${ev.error}`); conn.close(ev.code); return }
        if (ev.close) { conn.close(1000); return }
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
    conn.on('close', () => clients.delete(conn))

    route.onConnection?.(conn)
  })

  return {
    clients,
    closeAll(code = 1001) {
      for (const c of [...clients]) c.close(code)
      clients.clear()
    },
  }
}

function refuse(socket, status, reason) {
  const text = `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`
  try { socket.write(text); socket.destroy() } catch { /* déjà fermé */ }
}
