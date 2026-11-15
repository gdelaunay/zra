// Chemins d'attaque de l'audit (A2) : Host forgé (DNS rebinding), Origin sur
// les routes locales et sur /shim, vol de session entre shims. Chaque maillon
// avait été constaté sur une instance isolée ; ces tests les verrouillent.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { connect } from 'node:net'
import { EventEmitter } from 'node:events'

import { createServers } from '../server.js'
import { ShimRegistry } from '../shim-registry.js'
import { ShimHost } from '../shim-link.js'
import { setLevel } from '../log.js'

setLevel('error')

const HOST = '127.0.0.1'
const PORT = 7818

async function servers(t, { status = null, admin = null, allowedOrigins = [] } = {}) {
  const s = await createServers({
    config: { port: PORT, allowedOrigins, serveStatic: false, staticDir: null, tls: null },
    addresses: [HOST],
    onConnection: () => {},
    onShim: () => {},
    status,
    admin,
  })
  await s.listen()
  t.after(() => s.close())
  return s
}

/** Requête HTTP brute : permet de forger Host et Origin librement. */
function http({ path = '/status', host = `${HOST}:${PORT}`, method = 'GET', origin } = {}) {
  return new Promise((resolve, reject) => {
    const socket = connect(PORT, HOST)
    let buf = ''
    socket.on('connect', () => socket.write(
      `${method} ${path} HTTP/1.1\r\nHost: ${host}\r\n` +
      (origin ? `Origin: ${origin}\r\n` : '') +
      'Connection: close\r\n\r\n',
    ))
    socket.on('data', (d) => { buf += d })
    socket.on('close', () => resolve(buf))
    socket.on('error', reject)
    setTimeout(() => { socket.destroy(); reject(new Error('pas de réponse')) }, 3000)
  })
}

/** Handshake WebSocket brut, avec ou sans Origin. */
function upgrade(path, origin) {
  return new Promise((resolve, reject) => {
    const socket = connect(PORT, HOST)
    socket.on('connect', () => socket.write(
      `GET ${path} HTTP/1.1\r\nHost: ${HOST}:${PORT}\r\n` +
      (origin ? `Origin: ${origin}\r\n` : '') +
      'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
    ))
    socket.once('data', (buf) => { socket.destroy(); resolve(String(buf).split('\r\n')[0]) })
    socket.once('error', reject)
    setTimeout(() => { socket.destroy(); reject(new Error('pas de réponse')) }, 3000)
  })
}

test('HTTP : un Host forgé est refusé, même depuis la loopback (DNS rebinding)', async (t) => {
  await servers(t, { status: () => ({ ok: true }), admin: (req, res) => {
    if (req.url === '/pair') { res.writeHead(200); res.end('{"code":"123456"}'); return true }
    return false
  } })
  for (const path of ['/status', '/pair']) {
    const forged = await http({ path, host: 'evil.example' })
    assert.match(forged, /403/, path)
    assert.doesNotMatch(forged, /123456/, path)
    const legit = await http({ path })
    assert.match(legit, /200/, path)
  }
})

test('HTTP : une Origin tierce est refusée sur les routes locales (CSRF)', async (t) => {
  let rotated = false
  await servers(t, { admin: (req, res) => {
    if (req.url === '/pair/rotate' && req.method === 'POST') { rotated = true; res.writeHead(200); res.end('{}'); return true }
    return false
  } })
  const forged = await http({ path: '/pair/rotate', method: 'POST', origin: 'http://evil.example' })
  assert.match(forged, /403/)
  assert.equal(rotated, false)
  // Sans Origin (client natif) ou avec la nôtre : accepté.
  assert.match(await http({ path: '/pair/rotate', method: 'POST' }), /200/)
  assert.match(await http({ path: '/pair/rotate', method: 'POST', origin: `http://${HOST}:${PORT}` }), /200/)
})

test('HTTP : une origine autorisée passe, y compris son Host (reverse proxy)', async (t) => {
  await servers(t, { status: () => ({}), allowedOrigins: ['https://zra.exemple.fr'] })
  assert.match(await http({ host: 'zra.exemple.fr', origin: 'https://zra.exemple.fr' }), /200/)
  // Navigation simple derrière le proxy : Host public, pas d'Origin.
  assert.match(await http({ host: 'zra.exemple.fr' }), /200/)
})

test('/shim : une Origin présente signe une page web, refusée ; un client natif passe', async (t) => {
  await servers(t)
  assert.match(await upgrade('/shim', 'http://evil.example'), /403/)
  assert.match(await upgrade('/shim', `http://${HOST}:${PORT}`), /403/)
  assert.match(await upgrade('/shim'), /101/)
})

test('registre : un second shim ne prend pas une session déjà tenue', () => {
  const reg = new ShimRegistry()
  reg.register({ shimId: 'a', sessions: ['s1'] })
  reg.register({ shimId: 'b', sessions: ['s1', 's2'] })
  assert.equal(reg.forSession('s1').shimId, 'a')
  assert.deepEqual([...reg.shims.get('b').sessions], ['s2'])
  assert.equal(reg.addSession('b', 's1'), false)
  assert.equal(reg.forSession('s1').shimId, 'a')
  assert.equal(reg.addSession('b', 's3'), true)
  // Le départ du faux shim ne libère pas la session du vrai.
  reg.unregister('b')
  assert.equal(reg.forSession('s1').shimId, 'a')
})

test('shim-host : un faux shim ne publie ni événements ni état dans la session d un autre', () => {
  const reg = new ShimRegistry()
  const threads = new EventEmitter()
  threads.getBySession = (sid) => (sid === 's1' ? { threadId: 't1' } : null)
  const mirrored = []
  const states = { mirror: (tid, msg) => mirrored.push({ tid, msg }), get: () => ({ queue: [] }) }
  const host = new ShimHost({ shims: reg, threads, states })
  const updates = []
  host.on('update', (u) => updates.push(u))

  const conn = (id) => Object.assign(new EventEmitter(), { id, send: () => true, close: () => {} })
  const a = conn('a')
  const b = conn('b')
  host.attach(a)
  host.attach(b)
  host.handle({ conn: a, shimId: null }, { type: 'shim_hello', shimId: 'a', sessions: [{ sessionId: 's1' }] })
  host.handle({ conn: b, shimId: null }, { type: 'shim_hello', shimId: 'b', sessions: [] })

  // Le vrai shim publie ; le faux tente la même session sous trois formes.
  const entryA = { conn: a, shimId: 'a' }
  const entryB = { conn: b, shimId: 'b' }
  host.handle(entryA, { type: 'acp_update', sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk' } })
  host.handle(entryB, { type: 'session', sessionId: 's1', source: 'new' })
  host.handle(entryB, { type: 'acp_update', sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk' } })
  host.handle(entryB, { type: 'state', sessionId: 's1', turn: 'idle' })
  host.handle(entryB, { type: 'notice', sessionId: 's1', text: 'faux' })

  assert.equal(updates.length, 1, 'seul le détenteur publie')
  // Le seul état miroité est l'instantané du vrai shim à son hello.
  assert.ok(mirrored.every((m) => m.msg.turn === undefined), 'aucun état du faux shim')
  assert.equal(reg.forSession('s1').shimId, 'a')
  host.close()
})