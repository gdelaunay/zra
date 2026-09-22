#!/usr/bin/env node
// Daemon bouchon : sert la PWA et parle le protocole ZRA sur un vrai WebSocket.
//
//   node zra-client/tools/mock-server.mjs           -> :7777 (DESK-ZED) + :7778 (LAPTOP-ZED)
//   node zra-client/tools/mock-server.mjs --port 8080 --machine mock-laptop
//
// Aucune dépendance : le WebSocket (RFC 6455) tient en une centaine de lignes,
// et le moteur de scénario est celui de la PWA (js/mock/mock-link.js), donc les
// deux modes mock racontent exactement la même histoire.

import { createServer } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, normalize, extname } from 'node:path'

import { MockLink } from '../js/mock/mock-link.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}

function parseArgs(argv) {
  const out = { instances: null }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') out.port = Number(argv[++i])
    else if (argv[i] === '--machine') out.machine = argv[++i]
    else if (argv[i] === '--host') out.host = argv[++i]
  }
  if (out.port || out.machine) {
    out.instances = [{ port: out.port || 7777, machine: out.machine || 'mock-desk' }]
  } else {
    out.instances = [
      { port: 7777, machine: 'mock-desk' },
      { port: 7778, machine: 'mock-laptop' },
    ]
  }
  out.host = out.host || '127.0.0.1'
  return out
}

// ---- WebSocket minimal ----

function accept(key) {
  return createHash('sha1').update(key + GUID).digest('base64')
}

function frame(payload) {
  const data = Buffer.from(payload, 'utf8')
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
  head[0] = 0x81 // FIN + texte
  return Buffer.concat([head, data])
}

/** Décodeur incrémental : renvoie les messages complets présents dans le tampon. */
function createDecoder() {
  let buf = Buffer.alloc(0)
  return function push(chunk) {
    buf = Buffer.concat([buf, chunk])
    const msgs = []
    for (;;) {
      if (buf.length < 2) break
      const opcode = buf[0] & 0x0f
      const masked = (buf[1] & 0x80) === 0x80
      let len = buf[1] & 0x7f
      let off = 2
      if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4 }
      else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10 }
      const maskLen = masked ? 4 : 0
      if (buf.length < off + maskLen + len) break
      const mask = masked ? buf.subarray(off, off + 4) : null
      const body = Buffer.from(buf.subarray(off + maskLen, off + maskLen + len))
      if (mask) for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4]
      buf = buf.subarray(off + maskLen + len)
      if (opcode === 0x8) { msgs.push({ close: true }); break }
      if (opcode === 0x1) msgs.push({ text: body.toString('utf8') })
      // ping/pong/binaire : ignorés, le client ZRA n'en émet pas
    }
    return msgs
  }
}

// ---- serveur ----

async function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost')
  let path = decodeURIComponent(url.pathname)
  if (path === '/' || path === '') path = '/index.html'
  const full = normalize(join(ROOT, path))
  if (!full.startsWith(ROOT)) { res.writeHead(403).end('interdit'); return }
  try {
    const body = await readFile(full)
    res.writeHead(200, {
      'content-type': MIME[extname(full)] || 'application/octet-stream',
      'cache-control': 'no-store',
    }).end(body)
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('introuvable')
  }
}

function start({ port, machine, host }) {
  const server = createServer(serveStatic)

  server.on('upgrade', (req, socket) => {
    if (!req.url.startsWith('/ws')) { socket.destroy(); return }
    const key = req.headers['sec-websocket-key']
    if (!key) { socket.destroy(); return }
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept(key)}\r\n\r\n`,
    )
    socket.setNoDelay(true)

    const id = randomUUID().slice(0, 8)
    const link = new MockLink({ id: machine, url: `ws://${host}:${port}`, clientId: id })
    const decode = createDecoder()
    let alive = true

    link.on('message', (msg) => {
      if (!alive) return
      try { socket.write(frame(JSON.stringify(msg))) } catch { /* socket fermé */ }
    })

    socket.on('data', (chunk) => {
      for (const m of decode(chunk)) {
        if (m.close) { socket.end(); return }
        let msg
        try { msg = JSON.parse(m.text) } catch { continue }
        log(port, '←', msg.type, msg.threadId || '')
        link.send(msg)
      }
    })

    const bye = () => { alive = false; link.close() }
    socket.on('close', bye)
    socket.on('error', bye)

    link.connect()
    log(port, '·', `client ${id} connecté`)
  })

  server.listen(port, host, () => {
    console.log(`  ${machine.padEnd(12)} http://${host}:${port}  (ws://${host}:${port}/ws)`)
  })
  return server
}

function log(port, arrow, ...rest) {
  if (process.env.ZRA_MOCK_QUIET) return
  console.log(`[${port}] ${arrow}`, ...rest)
}

const args = parseArgs(process.argv.slice(2))
console.log('ZRA — daemon bouchon (aucun Zed, aucun agent)')
const servers = args.instances.map((inst) => start({ ...inst, host: args.host }))
console.log(`\n  PWA branchée sur le daemon simulé : http://${args.host}:${args.instances[0].port}/`)
console.log(`  PWA en mock intégral (sans WS)    : http://${args.host}:${args.instances[0].port}/?mock=1\n`)

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { servers.forEach((s) => s.close()); process.exit(0) })
}
