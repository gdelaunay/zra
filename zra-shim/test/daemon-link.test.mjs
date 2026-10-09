// La liaison shim → daemon (`daemon-link.js`) — spec §3.1, fail-open.
//
// Le contrat tient en trois lignes : rien ne bloque, rien ne remonte, et un
// daemon absent ne fait pas enfler le shim. On le vérifie ici avec un faux
// WebSocket, sans réseau — les échanges réels sont couverts par `shim.test.mjs`
// et par les lots B/C côté daemon.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'

import { DaemonLink } from '../daemon-link.js'

const URL = 'ws://127.0.0.1:7777/shim'

/** Faux WebSocket : mêmes événements que le vrai, pilotés à la main. */
class FakeWS {
  static instances = []
  static last() { return this.instances.at(-1) }
  static reset() { this.instances = [] }

  constructor(url) {
    this.url = url
    this.readyState = 0
    this.sent = []
    this.closeCount = 0
    this.sendError = null
    this.listeners = new Map()
    FakeWS.instances.push(this)
  }

  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, [])
    this.listeners.get(type).push(fn)
  }

  dispatch(type, ev = {}) {
    for (const fn of this.listeners.get(type) || []) fn({ type, data: undefined, ...ev })
  }

  open() { this.readyState = 1; this.dispatch('open') }
  send(raw) {
    if (this.sendError) throw new Error(this.sendError)
    this.sent.push(JSON.parse(raw))
  }
  close() { this.closeCount++; this.readyState = 3; this.dispatch('close') }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const NativeWS = globalThis.WebSocket
const links = []
after(() => {
  for (const link of links.splice(0)) link.stop()
  globalThis.WebSocket = NativeWS
})

/** Monte un lien hors ligne, avec le faux WebSocket installé. */
function boot({ onCommand = async () => null, describe = () => ({ agentId: 'fake', pid: 1 }), logs = [] } = {}) {
  FakeWS.reset()
  globalThis.WebSocket = FakeWS
  const link = new DaemonLink({
    url: URL,
    shimId: 'shim-1',
    describe,
    onCommand,
    log: { debug: (...a) => logs.push(['debug', a.join(' ')]), info: (...a) => logs.push(['info', a.join(' ')]) },
  })
  links.push(link)
  return { link, logs }
}

/** Lien démarré et connecté. */
function online(opts = {}) {
  const ctx = boot(opts)
  ctx.link.start()
  FakeWS.last().open()
  return { ...ctx, ws: FakeWS.last() }
}

// ---------------------------------------------------------------------------
// Connexion
// ---------------------------------------------------------------------------

test('à l’ouverture : shim_hello avec l’identité du shim, avant toute autre trame', () => {
  const { ws } = online({ describe: () => ({ agentId: 'claude-zra', pid: 42, sessions: [] }) })
  assert.equal(ws.sent.length, 1)
  assert.deepEqual(ws.sent[0], { type: 'shim_hello', shimId: 'shim-1', agentId: 'claude-zra', pid: 42, sessions: [] })
})

test('start() se connecte à l’URL du daemon, et ne double pas la connexion', () => {
  const { link } = boot()
  link.start()
  link.connect()
  assert.equal(FakeWS.instances.length, 1)
  assert.equal(FakeWS.instances[0].url, URL)
})

test('describe() est appelé à chaque ouverture : l’annonce suit l’état courant', () => {
  let calls = 0
  const { link } = boot({ describe: () => ({ calls: ++calls }) })
  link.start()
  FakeWS.last().open()
  FakeWS.last().close()           // le lien se reprogramme…
  return wait(900).then(() => {
    assert.equal(FakeWS.instances.length, 2, 'reconnexion en arrière-plan')
    FakeWS.last().open()
    assert.deepEqual(FakeWS.instances[0].sent[0], { type: 'shim_hello', shimId: 'shim-1', calls: 1 })
    assert.deepEqual(FakeWS.instances[1].sent[0], { type: 'shim_hello', shimId: 'shim-1', calls: 2 })
  })
})

test('une URL refusée ne fait pas tomber le shim : la connexion est reprogrammée', async () => {
  const { link, logs } = boot()
  const Real = globalThis.WebSocket
  globalThis.WebSocket = class { constructor() { throw new Error('URL invalide') } }
  try {
    link.start()
  } finally {
    globalThis.WebSocket = Real
  }
  assert.equal(FakeWS.instances.length, 0)
  assert.ok(logs.some(([lvl, m]) => lvl === 'debug' && m.includes('URL invalide')), 'l’erreur est journalisée, pas propagée')
  // Le timer de reconnexion existe et est armé : on l’arrête proprement.
  link.stop()
})

test('après une coupure, le lien se reconnecte tout seul (backoff ~0,5 s)', async () => {
  const { link } = boot()
  link.start()
  const first = FakeWS.last()
  first.open()
  first.close()
  assert.equal(FakeWS.instances.length, 1, 'pas de reconnexion immédiate : on laisse passer le backoff')
  await wait(900)
  assert.equal(FakeWS.instances.length, 2, 'reconnécté en arrière-plan')
  link.stop()
  assert.equal(FakeWS.instances.length, 2, 'stop() arrête la boucle de reconnexion')
})

test('une socket périmée qui se ferme ne reprogramme rien', async () => {
  const { link } = boot()
  link.start()
  const first = FakeWS.last()
  first.open()
  first.close()
  await wait(900)
  const second = FakeWS.last()
  second.open()
  first.close()                     // le vieux socket annonce enfin sa fermeture
  link.stop()
  await wait(900)
  assert.equal(FakeWS.instances.length, 2, 'la connexion en cours n’est pas perturbée')
})

test('stop() ferme le socket et ne renvoie plus rien après', () => {
  const { link, ws } = online()
  link.stop()
  assert.equal(ws.closeCount, 1)
  assert.equal(link.ws, null)
  link.connect()                    // relancer un lien arrêté ne fait rien
  assert.equal(FakeWS.instances.length, 1)
})

// ---------------------------------------------------------------------------
// Envoi best-effort
// ---------------------------------------------------------------------------

test('push() en ligne écrit tout de suite et rend true', () => {
  const { link, ws } = online()
  assert.equal(link.push({ type: 'state', sessionId: 's1' }), true)
  assert.deepEqual(ws.sent.at(-1), { type: 'state', sessionId: 's1' })
})

test('push() hors ligne met en tampon, et le tampon part à l’ouverture', () => {
  const { link } = boot()
  assert.equal(link.push({ type: 'state', n: 1 }), false)
  assert.equal(link.push({ type: 'acp_update', n: 2 }), false)
  assert.equal(FakeWS.instances.length, 0, 'rien n’est encore connecté')

  link.start()
  const ws = FakeWS.last()
  ws.open()
  assert.deepEqual(ws.sent.map((m) => m.type), ['shim_hello', 'state', 'acp_update'], 'hello d’abord, puis l’ordre d’arrivée')
  assert.equal(link.outbox.length, 0, 'tampon vidé')
})

test('le tampon est borné : un daemon absent ne fait pas enfler le shim', () => {
  const { link } = boot()
  for (let i = 0; i < 1200; i++) link.push({ type: 'acp_update', i })
  assert.ok(link.outbox.length > 0)
  assert.ok(link.outbox.length <= 500, `tampon borné, obtenu ${link.outbox.length}`)
  assert.equal(link.outbox.at(-1).i, 1199, 'les trames les plus récentes sont gardées')
  assert.ok(link.outbox[0].i > 0, 'les plus anciennes sont jetées')
})

test('shim_hello hors ligne n’est pas mis en tampon : il sera reconstruit', () => {
  const { link } = boot()
  assert.equal(link.push({ type: 'shim_hello', shimId: 'shim-1' }), false)
  assert.equal(link.outbox.length, 0)
})

test('un send qui échoue retombe dans le tampon, sans exception', () => {
  const { link, ws } = online()
  ws.sendError = 'socket saturée'
  assert.equal(link.push({ type: 'state' }), false)
  assert.deepEqual(link.outbox, [{ type: 'state' }])
})

test('flush() ne renvoie pas deux fois les mêmes trames', () => {
  const { link } = boot()
  link.push({ type: 'state' })
  link.start()
  const ws = FakeWS.last()
  ws.open()                        // flush à l’ouverture
  link.flush()                     // un second flush est inoffensif
  assert.deepEqual(ws.sent.map((m) => m.type), ['shim_hello', 'state'])
})

// ---------------------------------------------------------------------------
// Commandes du daemon
// ---------------------------------------------------------------------------

test('une commande reçue est exécutée, puis acquittée avec son résultat', async () => {
  const seen = []
  const { link, ws } = online({
    onCommand: async (cmd) => { seen.push(cmd); return { queued: true } },
  })
  ws.dispatch('message', { data: JSON.stringify({ type: 'cmd', id: 7, cmd: 'prompt', sessionId: 's1', text: 'bonjour' }) })
  await wait(0)
  assert.equal(seen.length, 1)
  assert.equal(seen[0].cmd, 'prompt')
  assert.deepEqual(ws.sent.at(-1), { type: 'ack', id: 7, ok: true, result: { queued: true } })
})

test('un onCommand qui ne rend rien est acquitté result: null', async () => {
  const { ws } = online({ onCommand: async () => undefined })
  ws.dispatch('message', { data: JSON.stringify({ type: 'cmd', id: 1, cmd: 'cancel' }) })
  await wait(0)
  assert.deepEqual(ws.sent.at(-1), { type: 'ack', id: 1, ok: true, result: null })
})

test('échec de la commande : l’ack porte le code de l’erreur, ou inject_failed', async () => {
  const codes = [Object.assign(new Error('session inconnue'), { code: 'unknown_session' }), new Error('boom')]
  const { ws } = online({ onCommand: async () => { throw codes.shift() } })

  ws.dispatch('message', { data: JSON.stringify({ type: 'cmd', id: 1, cmd: 'prompt' }) })
  await wait(0)
  assert.deepEqual(ws.sent.at(-1), { type: 'ack', id: 1, ok: false, code: 'unknown_session', message: 'session inconnue' })

  ws.dispatch('message', { data: JSON.stringify({ type: 'cmd', id: 2, cmd: 'prompt' }) })
  await wait(0)
  assert.deepEqual(ws.sent.at(-1), { type: 'ack', id: 2, ok: false, code: 'inject_failed', message: 'boom' })
})

test('un ack hors ligne part quand même au retour du daemon', async () => {
  const { link, ws } = online({ onCommand: async () => ({ ok: 1 }) })
  await link.handle({ type: 'cmd', id: 9, cmd: 'cancel' })
  ws.sendError = 'cassé'
  await link.handle({ type: 'cmd', id: 10, cmd: 'cancel' })
  assert.equal(link.outbox.length, 1, 'l’ack non parti est conservé')
  ws.sendError = null
  link.flush()
  assert.deepEqual(ws.sent.map((m) => m.id).filter(Boolean), [9, 10])
})

test('messages reçus malformés : ignorés sans accusé', async () => {
  const seen = []
  const { ws } = online({ onCommand: async (m) => { seen.push(m); return null } })
  ws.dispatch('message', { data: '{ pas du json' })
  ws.dispatch('message', { data: JSON.stringify({ id: 1, cmd: 'prompt' }) })          // pas de type
  ws.dispatch('message', { data: JSON.stringify({ type: 42 }) })                       // type non texte
  ws.dispatch('message', { data: JSON.stringify({ type: 'ping' }) })                   // autre chose qu’une commande
  ws.dispatch('message', { data: JSON.stringify(null) })
  await wait(0)
  assert.equal(seen.length, 0)
  assert.deepEqual(ws.sent.filter((m) => m.type === 'ack'), [])
})

test('un onCommand qui rejette ne casse pas le lien : les commandes suivantes passent', async () => {
  let n = 0
  const { ws } = online({ onCommand: async () => { if (++n === 1) throw new Error('non') ; return { n } } })
  ws.dispatch('message', { data: JSON.stringify({ type: 'cmd', id: 1, cmd: 'cancel' }) })
  await wait(0)
  ws.dispatch('message', { data: JSON.stringify({ type: 'cmd', id: 2, cmd: 'cancel' }) })
  await wait(0)
  assert.deepEqual(ws.sent.filter((m) => m.type === 'ack').map((m) => [m.id, m.ok]), [[1, false], [2, true]])
})

test('handle() sur autre chose qu’une commande ne renvoie rien', async () => {
  const { link, ws } = online()
  const before = ws.sent.length
  await link.handle({ type: 'state', sessionId: 's1' })
  assert.equal(ws.sent.length, before)
})
