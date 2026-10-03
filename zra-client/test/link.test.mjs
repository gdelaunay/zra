// Le lien vers le daemon face à une connexion mobile qui meurt sans prévenir :
// onglet gelé en arrière-plan, changement de réseau. Relevé à l'usage : le
// stream s'arrêtait, et seul un rechargement le relançait.

import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'

/** WebSocket de navigateur, piloté à la main. */
class FakeSocket {
  static CONNECTING = 0
  static OPEN = 1
  static all = []
  constructor(url) {
    this.url = url
    this.readyState = FakeSocket.CONNECTING
    this.sent = []
    FakeSocket.all.push(this)
  }
  send(data) { this.sent.push(JSON.parse(data)) }
  close() { this.readyState = 3 }
  open() { this.readyState = FakeSocket.OPEN; this.onopen?.() }
  deliver(msg) { this.onmessage?.({ data: JSON.stringify(msg) }) }
  types() { return this.sent.map((m) => m.type) }
}

globalThis.WebSocket = FakeSocket
globalThis.location ??= { href: 'http://poste.local:7777/' }
const mem = new Map()
globalThis.localStorage ??= {
  getItem: (k) => mem.get(k) ?? null,
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
}

const { DaemonLink } = await import('../js/link.js')

let clock
beforeEach(() => { FakeSocket.all.length = 0 })
afterEach(() => clock?.reset())

function link(t, token = 'jeton') {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  clock = t.mock.timers
  const l = new DaemonLink({ id: 'desk', url: 'http://poste.local:7777/', clientId: 'c1', token: () => token })
  t.after(() => l.close())
  l.connect()
  return l
}

test('à l’ouverture, hello part avant tout le reste, file d’attente comprise', (t) => {
  const l = link(t)
  l.on('status', (s) => { if (s === 'online') l.send({ type: 'subscribe', threadId: 'a' }) })
  l.send({ type: 'load_history', threadId: 'a' })
  FakeSocket.all[0].open()
  assert.deepEqual(FakeSocket.all[0].types(), ['hello', 'load_history', 'subscribe'])
})

test('une connexion muette est abandonnée, puis rouverte', (t) => {
  const l = link(t)
  FakeSocket.all[0].open()
  clock.tick(15000)
  assert.equal(FakeSocket.all[0].types().at(-1), 'ping')
  clock.tick(6000)
  assert.equal(l.status, 'offline')
  assert.equal(l.lastError, 'le poste ne répond plus')
  clock.tick(1400)
  assert.equal(FakeSocket.all.length, 2, 'reconnexion')
})

test('le pong garde la connexion, sans remonter au store', (t) => {
  const l = link(t)
  const seen = []
  l.on('message', (m) => seen.push(m.type))
  FakeSocket.all[0].open()
  for (let i = 0; i < 4; i++) {
    clock.tick(15000)
    FakeSocket.all[0].deliver({ type: 'pong' })
  }
  clock.tick(5000)
  assert.equal(l.status, 'online')
  assert.equal(FakeSocket.all.length, 1)
  assert.deepEqual(seen, [])
})

test('retour au premier plan : sonde courte, et les envois attendent sa réponse', (t) => {
  const l = link(t)
  const ws = FakeSocket.all[0]
  ws.open()
  l.wake()
  l.send({ type: 'send', threadId: 'a', text: 'coucou' })
  assert.deepEqual(ws.types(), ['hello', 'ping'], 'le message attend la sonde')
  ws.deliver({ type: 'pong' })
  assert.deepEqual(ws.types(), ['hello', 'ping', 'send'])
})

test('sonde sans réponse : le message part sur la connexion suivante', (t) => {
  const l = link(t)
  FakeSocket.all[0].open()
  l.wake()
  l.send({ type: 'send', threadId: 'a', text: 'coucou' })
  clock.tick(3000)
  assert.equal(l.status, 'offline')
  clock.tick(1400)
  FakeSocket.all[1].open()
  assert.deepEqual(FakeSocket.all[1].types(), ['hello', 'send'])
  assert.deepEqual(FakeSocket.all[0].types(), ['hello', 'ping'], 'rien de perdu sur la socket morte')
})

test('envoi après un long silence : la connexion est vérifiée d’abord', (t) => {
  const l = link(t)
  const ws = FakeSocket.all[0]
  ws.open()
  l.stopHeartbeat() // onglet gelé : les minuteries n'ont pas tourné
  clock.tick(60000)
  l.send({ type: 'send', threadId: 'a', text: 'coucou' })
  assert.deepEqual(ws.types(), ['hello', 'ping'])
})

test('poste d’avant le heartbeat : son refus du ping suffit, sans toast', (t) => {
  const l = link(t)
  const seen = []
  l.on('message', (m) => seen.push(m.type))
  FakeSocket.all[0].open()
  clock.tick(15000)
  FakeSocket.all[0].deliver({ type: 'error', code: 'unknown_message', message: 'message inconnu : ping' })
  clock.tick(6000)
  assert.equal(l.status, 'online')
  assert.deepEqual(seen, [])
})

// ---- Handshake qui ne finit jamais : le timeout rend la main au backoff -----

test('handshake interminable : le timeout rend la main au backoff', (t) => {
  const l = link(t)
  // La socket reste en CONNECTING : ni onopen ni onclose (proxy qui retient).
  assert.equal(l.status, 'connecting')
  l.wake() // avant le filet : rien n’y faisait — toujours pas de timer côté wake()
  clock.tick(14999)
  assert.equal(l.status, 'connecting', 'pas encore échoué')
  clock.tick(1)
  assert.equal(l.status, 'offline')
  assert.equal(l.lastError, 'délai de connexion dépassé')
  clock.tick(1400)
  assert.equal(FakeSocket.all.length, 2, 'une nouvelle tentative repart')
})

test('handshake réussi : le timeout de connexion ne tue pas la socket ouverte', (t) => {
  const l = link(t)
  FakeSocket.all[0].open()
  clock.tick(20000) // > CONNECT_TIMEOUT_MS : onopen l’a annulé
  assert.equal(l.status, 'online')
  assert.equal(FakeSocket.all.length, 1)
})

// ---- Backoff doublé, puis plateau long -------------------------------------

test('backoff doublé, puis plateau à 60 s pour un poste mort', (t) => {
  const l = link(t)
  const retries = []
  l.on('retry', (r) => retries.push(r.in))
  // Huit échecs successifs sans jamais aboutir : le backoff court doublé,
  // puis le plateau. (Ouvrir la socket remettrait `attempt` à zéro.)
  for (let i = 0; i < 8; i++) l.scheduleRetry()
  assert.deepEqual(retries, [1000, 2000, 4000, 8000, 16000, 30000, 60000, 60000])
})

test('une reconnexion réussie remet le backoff à zéro', (t) => {
  const l = link(t)
  const retries = []
  l.on('retry', (r) => retries.push(r.in))
  FakeSocket.all[0].open()
  l.lost(FakeSocket.all[0], 'perdue')
  clock.tick(1400) // 1000 + jitter ≤ 300
  l.lost(FakeSocket.all[1], 'perdue')
  clock.tick(2400) // 2000 + jitter
  FakeSocket.all[2].open()
  assert.equal(l.attempt, 0)
  l.lost(FakeSocket.all[2], 'perdue')
  assert.equal(retries.at(-1), 1000, 'repart du premier échelon')
})
