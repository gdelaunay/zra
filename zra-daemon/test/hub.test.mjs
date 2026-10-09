// Le routage du protocole (`hub.js`) — PROTOCOL.md §3 et §4, pris directement.
//
// Le bout en bout réel est dans `protocol.test.mjs` ; ici on isole le hub avec
// des dépendances factices pour verrouiller ce que les messages du protocole
// garantissent : l'ordre du bootstrap, le verbatim des événements, l'idempotence
// du réabonnement, la file d'attente selon le backend, la course aux permissions
// et l'appairage.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { Hub } from '../hub.js'
import { RingBuffers } from '../ring-buffer.js'
import { ThreadStates } from '../thread-state.js'
import { ShimRegistry } from '../shim-registry.js'
import { InjectionError } from '../inject/backend.js'
import { AuthError, Pairing } from '../auth.js'
import { setLevel } from '../log.js'

setLevel('error')

const A = 'thread-a'
const B = 'thread-b'
const NO_SESSION = 'thread-sans-session'

/** Connexion PWA factice : ce que le hub en utilise. */
class FakeConn extends EventEmitter {
  static seq = 0
  constructor({ remoteAddress = '203.0.113.9', origin = 'https://zra.exemple.fr' } = {}) {
    super()
    this.id = `c${++FakeConn.seq}`
    this.remoteAddress = remoteAddress
    this.origin = origin
    this.sent = []
    this.closeCode = null
  }

  send(msg) { this.sent.push(msg); return true }
  close(code) { this.closeCode = code; this.emit('close') }

  /** Messages reçus depuis le dernier `mark()`. */
  types() { return this.sent.map((m) => m.type) }
  last() { return this.sent.at(-1) }
  mark() { this.sent.length = 0 }
  only(type) { return this.sent.filter((m) => m.type === type) }
}

/** Index de threads factice, avec ce que le hub en lit. */
class FakeThreads extends EventEmitter {
  constructor(threads = []) {
    super()
    this.threads = threads
    this.degraded = null
    this.bound = []
  }

  get(id) { return this.threads.find((t) => t.threadId === id) ?? null }
  getBySession(sessionId) { return this.threads.find((t) => t.sessionId === sessionId) ?? null }
  bindSession(threadId, sessionId) {
    this.bound.push([threadId, sessionId])
    const t = this.get(threadId)
    if (t) t.sessionId = sessionId
  }
}

const defaultThreads = () => new FakeThreads([
  { threadId: A, sessionId: 'sess-a', agentId: 'claude-zra', title: 'fil A', state: 'live', folderPaths: ['C:/proj/zra'], projectOpen: true },
  { threadId: B, sessionId: 'sess-b', agentId: 'codex-zra', title: 'fil B', state: 'closed', folderPaths: ['C:/proj/autre'], projectOpen: true },
  { threadId: NO_SESSION, sessionId: null, agentId: 'claude-zra', title: 'brouillon', state: 'closed', folderPaths: null },
])

/** Backend d'injection factice : enregistre, répond, ou échoue. */
function fakeBackend(over = {}) {
  const calls = []
  return {
    calls,
    name: 'acp',
    ownsQueue: true,
    fail: null,
    async send(threadId, text, mode) {
      calls.push(['send', threadId, text, mode])
      if (this.fail) throw this.fail
      return { sent: true }
    },
    async interrupt(threadId) { calls.push(['interrupt', threadId]); if (this.fail) throw this.fail },
    async setOption(threadId, key, value) { calls.push(['set_option', threadId, key, value]); if (this.fail) throw this.fail },
    async cancelQueued(threadId, queueId) { calls.push(['cancel_queued', threadId, queueId]) },
    async respondPermission(threadId, requestId, optionId) {
      calls.push(['respond_permission', threadId, requestId, optionId])
      if (this.fail) throw this.fail
      return { optionId, optionName: 'Autoriser', by: 'mobile' }
    },
    ...over,
  }
}

function fakeMachine(agents = [{ id: 'claude-zra', wraps: 'claude-acp' }, { id: 'codex-zra', wraps: 'codex-acp' }]) {
  return {
    name: 'poste-test',
    agents,
    zedRunning: true,
    describe: () => ({ name: 'poste-test', os: 'win32', version: '0.1.0', zedRunning: true, agents, urls: [] }),
  }
}

/** Monte un hub avec tout ce qu'il lui faut, factice sauf ring/états/registres. */
function boot({ threads = defaultThreads(), backend = fakeBackend(), pairing = null, zed = null, loader = null, covers = () => false, config = { auth: {} }, size = 2000 } = {}) {
  const rings = new RingBuffers({ size })
  const states = new ThreadStates()
  const shims = new ShimRegistry()
  const recorded = []
  const hub = new Hub({
    config,
    threads,
    states,
    rings,
    shims,
    backend,
    machine: fakeMachine(),
    recordInjection: (e) => recorded.push(e),
    loader,
    zed,
    covers,
    pairing,
  })
  return { hub, threads, states, rings, shims, backend, recorded, zed, loader }
}

/** Hub démarré avec un client reconnu (loopback) et ses messages. */
function client(ctx, opts = {}) {
  const conn = new FakeConn(opts)
  ctx.hub.attach(conn)
  return conn
}

/** Client loopback, appairé d'office. */
function pairedClient(ctx) {
  return client(ctx, { remoteAddress: '127.0.0.1' })
}

const tick = () => new Promise((r) => setTimeout(r, 0))

// ---------------------------------------------------------------------------
// Bootstrap et cycle de vie
// ---------------------------------------------------------------------------

test('hello : machine, threads, puis un thread_state par thread — dans cet ordre', () => {
  const ctx = boot()
  const conn = pairedClient(ctx)
  conn.emit('message', { type: 'hello', clientId: 'mobile-1' })

  assert.deepEqual(conn.types().slice(0, 2), ['machine', 'threads'])
  assert.equal(conn.sent[0].name, 'poste-test')
  assert.equal(conn.sent[1].threads.length, 3)
  assert.deepEqual(conn.types().slice(2), ['thread_state', 'thread_state', 'thread_state'])
  assert.deepEqual(conn.only('thread_state').map((m) => m.threadId), [A, B, NO_SESSION])
  assert.equal(conn.only('thread_state')[0].state, 'live', 'l’état vient de l’index, pas du miroir')
  assert.equal(conn.only('thread_state')[0].turn, 'idle')
})

test('hello sans clientId, ou avec un clientId non texte : accepté', () => {
  const ctx = boot()
  const conn = pairedClient(ctx)
  conn.emit('message', { type: 'hello' })
  assert.equal(conn.types()[0], 'machine')
  const conn2 = pairedClient(ctx)
  conn2.emit('message', { type: 'hello', clientId: 42 })
  assert.equal(conn2.types()[0], 'machine')
})

test('un index dégradé le dit après le bootstrap', () => {
  const ctx = boot()
  ctx.threads.degraded = 'base Zed verrouillée'
  const conn = pairedClient(ctx)
  conn.emit('message', { type: 'hello' })
  assert.deepEqual(conn.last(), { type: 'error', code: 'index_degraded', message: 'base Zed verrouillée' })
})

test('ping → pong, et rien d’autre', () => {
  const ctx = boot()
  const conn = pairedClient(ctx)
  conn.emit('message', { type: 'ping' })
  assert.deepEqual(conn.sent, [{ type: 'pong' }])
})

test('message inconnu → error unknown_message, le daemon tient', () => {
  const ctx = boot()
  const conn = pairedClient(ctx)
  conn.emit('message', { type: 'teleporter' })
  assert.deepEqual(conn.last(), { type: 'error', code: 'unknown_message', message: 'message inconnu : teleporter' })
  conn.emit('message', { type: 'ping' })
  assert.deepEqual(conn.last(), { type: 'pong' })
})

test('zra/trigger est refusé par un vrai daemon', () => {
  const ctx = boot()
  const conn = pairedClient(ctx)
  conn.emit('message', { type: 'zra/trigger', scenario: 'permission' })
  assert.equal(conn.last().code, 'unknown_message')
  assert.match(conn.last().message, /pas un bouchon/)
})

test('un message sans type ne fait rien tomber', () => {
  const ctx = boot()
  const conn = pairedClient(ctx)
  conn.emit('message', {})
  assert.equal(conn.last().code, 'unknown_message')
  conn.emit('message', null)
  assert.equal(conn.sent.filter((m) => m.type === 'error').length, 2)
})

test('list_threads rend l’index tel quel', () => {
  const ctx = boot()
  const conn = pairedClient(ctx)
  conn.emit('message', { type: 'list_threads' })
  assert.deepEqual(conn.last(), { type: 'threads', threads: ctx.threads.threads })
})

test('un changement d’index est diffusé à tous les clients reconnus', () => {
  const ctx = boot()
  const one = pairedClient(ctx)
  const two = pairedClient(ctx)
  one.mark(); two.mark()
  ctx.threads.threads.push({ threadId: 'thread-c', sessionId: null, state: 'closed' })
  ctx.threads.emit('change', ctx.threads.threads)
  assert.equal(one.last().type, 'threads')
  assert.equal(one.last().threads.length, 4)
  assert.deepEqual(two.last(), one.last())
})

test('la fermeture d’une connexion l’oublie : plus aucun message après', () => {
  const ctx = boot()
  const conn = pairedClient(ctx)
  assert.equal(ctx.hub.clients.size, 1)
  conn.emit('close')
  assert.equal(ctx.hub.clients.size, 0)
  ctx.threads.emit('change', ctx.threads.threads)
  assert.equal(conn.only('threads').length, 0)
})

// ---------------------------------------------------------------------------
// subscribe / unsubscribe / rejeu
// ---------------------------------------------------------------------------

test('subscribe : thread_state d’abord, puis le rejeu du ring numéroté', () => {
  const ctx = boot()
  ctx.hub.publish(A, { sessionUpdate: 'agent_message_chunk', text: 'un' })
  ctx.hub.publish(A, { sessionUpdate: 'agent_message_chunk', text: 'deux' })

  const conn = pairedClient(ctx)
  conn.emit('message', { type: 'subscribe', threadId: A })

  assert.deepEqual(conn.types(), ['thread_state', 'acp_event', 'acp_event'])
  assert.equal(conn.sent[0].threadId, A)
  const [e1, e2] = conn.only('acp_event')
  assert.equal(e1.update.text, 'un')
  assert.ok(e2.seq > e1.seq, 'les seq sont croissants')
  assert.equal(e1.threadId, A)
  assert.ok(typeof e1.at === 'string')
})

test('subscribe sur un thread inconnu → unknown_thread, sans abonnement', () => {
  const ctx = boot()
  const conn = pairedClient(ctx)
  conn.emit('message', { type: 'subscribe', threadId: 'thread-fantôme' })
  assert.deepEqual(conn.last(), { type: 'error', code: 'unknown_thread', message: 'thread inconnu de cet index', threadId: 'thread-fantôme' })
  ctx.hub.publish('thread-fantôme', { sessionUpdate: 'x' })
  assert.equal(conn.only('acp_event').length, 0)
})

test('subscribe est idempotent : rejoué, il ne double pas l’abonnement', () => {
  const ctx = boot()
  const conn = pairedClient(ctx)
  conn.emit('message', { type: 'subscribe', threadId: A })
  conn.emit('message', { type: 'subscribe', threadId: A })
  conn.mark()
  ctx.hub.publish(A, { sessionUpdate: 'agent_message_chunk', text: 'une seule fois' })
  assert.equal(conn.only('acp_event').length, 1)
})

test('subscribe avec since : seulement la suite du ring', () => {
  const ctx = boot()
  const first = ctx.hub.rings.push(A, { update: { n: 1 }, at: 'x' })
  const second = ctx.hub.rings.push(A, { update: { n: 2 }, at: 'x' })
  ctx.hub.rings.push(A, { update: { n: 3 }, at: 'x' })

  const conn = pairedClient(ctx)
  conn.emit('message', { type: 'subscribe', threadId: A, since: second.seq })
  assert.deepEqual(conn.only('acp_event').map((m) => m.update.n), [3])
  assert.ok(first.seq < second.seq)
})

test('since trop ancien (ring évicté) : l’historique prend le relais', async () => {
  const loaded = []
  const ctx = boot({
    size: 2,
    loader: { load: async (threadId) => { loaded.push(threadId); return { updates: [{ n: 'replay' }], complete: true } } },
  })
  for (let i = 0; i < 5; i++) ctx.hub.publish(A, { n: i })
  const origin = ctx.rings.origin

  const conn = pairedClient(ctx)
  conn.emit('message', { type: 'subscribe', threadId: A, since: origin })
  await tick()
  assert.deepEqual(loaded, [A])
  assert.equal(conn.last().type, 'history')
  assert.deepEqual(conn.last().updates, [{ n: 'replay' }])
  assert.equal(conn.only('acp_event').length, 0, 'le rejeu partiel n’est pas mélangé à l’historique')
})

test('since sur un ring intact rend exactement la suite, sans historique', async () => {
  const ctx = boot({ loader: { load: async () => { throw new Error('ne doit pas être appelé') } } })
  ctx.rings.push(A, { update: { n: 1 }, at: 'x' })
  const last = ctx.rings.push(A, { update: { n: 2 }, at: 'x' })
  const conn = pairedClient(ctx)
  conn.emit('message', { type: 'subscribe', threadId: A, since: last.seq })
  await tick()
  assert.deepEqual(conn.types(), ['thread_state'])
})

test('unsubscribe coupe le flux de ce thread, pas celui des autres', () => {
  const ctx = boot()
  const conn = pairedClient(ctx)
  conn.emit('message', { type: 'subscribe', threadId: A })
  conn.emit('message', { type: 'subscribe', threadId: B })
  conn.mark()
  conn.emit('message', { type: 'unsubscribe', threadId: A })
  ctx.hub.publish(A, { n: 1 })
  ctx.hub.publish(B, { n: 2 })
  assert.deepEqual(conn.only('acp_event').map((m) => m.threadId), [B])
})

test('unsubscribe sur un thread jamais abonné : inoffensif', () => {
  const ctx = boot()
  const conn = pairedClient(ctx)
  conn.emit('message', { type: 'unsubscribe', threadId: A })
  assert.deepEqual(conn.sent, [])
})

test('les événements ne partent qu’aux abonnés', () => {
  const ctx = boot()
  const yes = pairedClient(ctx)
  const no = pairedClient(ctx)
  yes.emit('message', { type: 'subscribe', threadId: A })
  no.mark(); yes.mark()
  ctx.hub.publish(A, { n: 1 })
  assert.equal(yes.only('acp_event').length, 1)
  assert.deepEqual(no.sent, [])
})

// ---------------------------------------------------------------------------
// publish / restart : verbatim et ring buffer
// ---------------------------------------------------------------------------

test('publish est verbatim : l’update n’est ni relu, ni normalisé, ni complété', () => {
  const ctx = boot()
  const conn = pairedClient(ctx)
  conn.emit('message', { type: 'subscribe', threadId: A })
  conn.mark()

  const update = { sessionUpdate: 'tool_call', titre: 'Bizarre 🎯', nested: { a: [1, { b: null }] }, extraInconnu: true }
  const frozen = JSON.parse(JSON.stringify(update))
  ctx.hub.publish(A, update)

  assert.deepEqual(conn.last().update, frozen)
  assert.deepEqual(update, frozen, 'l’update reçu n’est pas muté')
  assert.deepEqual(Object.keys(conn.last()).sort(), ['at', 'seq', 'threadId', 'type', 'update'])
})

test('publish accepte un horodatage imposé', () => {
  const ctx = boot()
  ctx.hub.publish(A, { n: 1 }, '2024-01-02T03:04:05.000Z')
  assert.equal(ctx.rings.read(A).at(-1).at, '2024-01-02T03:04:05.000Z')
})

test('restart vide le ring du thread et le dit aux abonnés', () => {
  const ctx = boot()
  const conn = pairedClient(ctx)
  conn.emit('message', { type: 'subscribe', threadId: A })
  ctx.hub.publish(A, { n: 1 })
  const until = ctx.rings.cursor()
  conn.mark()

  ctx.hub.restart(A)
  assert.deepEqual(conn.last(), { type: 'history', threadId: A, updates: [], complete: true, until })
  assert.deepEqual(ctx.rings.read(A), [])

  conn.mark()
  conn.emit('message', { type: 'subscribe', threadId: A })
  assert.deepEqual(conn.types(), ['thread_state'], 'le rejeu ne ramène pas l’avant-restart')
})

test('restart ne touche pas aux autres threads', () => {
  const ctx = boot()
  ctx.hub.publish(A, { n: 1 })
  ctx.hub.publish(B, { n: 2 })
  ctx.hub.restart(A)
  assert.deepEqual(ctx.rings.read(B).map((e) => e.update.n), [2])
})

// ---------------------------------------------------------------------------
// thread_state : le miroir
// ---------------------------------------------------------------------------

test('un changement d’état est poussé aux abonnés, avec l’état de l’index', () => {
  const ctx = boot()
  const conn = pairedClient(ctx)
  conn.emit('message', { type: 'subscribe', threadId: A })
  conn.mark()

  ctx.states.mirror(A, { turn: 'busy', queue: [{ queueId: 'q1', text: 'ensuite', at: 'x' }] })
  const msg = conn.last()
  assert.equal(msg.type, 'thread_state')
  assert.equal(msg.turn, 'busy')
  assert.equal(msg.state, 'live')
  assert.deepEqual(msg.queue.map((q) => q.queueId), ['q1'])
})

test('thread_state d’un thread sorti de l’index : état unknown, pas d’erreur', () => {
  const ctx = boot()
  const conn = pairedClient(ctx)
  conn.emit('message', { type: 'subscribe', threadId: A })
  conn.mark()
  ctx.states.mirror('thread-orphelin', { turn: 'busy' })
  assert.deepEqual(conn.sent, [])
  ctx.states.changed('thread-orphelin')
  assert.deepEqual(conn.sent, [], 'pas d’abonné, pas de message')
})

// ---------------------------------------------------------------------------
// send
// ---------------------------------------------------------------------------

test('send : le texte part au backend, avec son mode', async () => {
  const ctx = boot()
  const conn = pairedClient(ctx)
  conn.emit('message', { type: 'send', threadId: A, text: 'bonjour' })
  await tick()
  assert.deepEqual(ctx.backend.calls, [['send', A, 'bonjour', 'queue']])
  assert.deepEqual(conn.sent, [], 'pas d’accusé : la preuve vient du shim')
})

test('send en mode interrupt passe le mode au backend', async () => {
  const ctx = boot()
  const conn = pairedClient(ctx)
  conn.emit('message', { type: 'send', threadId: A, text: 'coupe', mode: 'interrupt' })
  await tick()
  assert.deepEqual(ctx.backend.calls, [['send', A, 'coupe', 'interrupt']])
})

test('send : un texte vide ou absent ne fait rien du tout', async () => {
  const ctx = boot()
  const conn = pairedClient(ctx)
  for (const msg of [{ type: 'send', threadId: A, text: '' }, { type: 'send', threadId: A }, { type: 'send', threadId: A, text: 42 }]) {
    conn.emit('message', msg)
  }
  await tick()
  assert.deepEqual(ctx.backend.calls, [])
  assert.deepEqual(conn.sent, [])
})

test('send sur thread inconnu / sans session → le code du protocole', async () => {
  const ctx = boot()
  const conn = pairedClient(ctx)
  conn.emit('message', { type: 'send', threadId: 'thread-fantôme', text: 'x' })
  conn.emit('message', { type: 'send', threadId: NO_SESSION, text: 'x' })
  await tick()
  assert.deepEqual(conn.only('error').map((m) => [m.code, m.threadId]), [
    ['unknown_thread', 'thread-fantôme'],
    ['no_session', NO_SESSION],
  ])
  assert.deepEqual(ctx.backend.calls, [])
})

test('send refusé par le backend : l’erreur devient un error du protocole', async () => {
  const ctx = boot()
  ctx.backend.fail = new InjectionError('shim_offline', 'le shim est parti')
  const conn = pairedClient(ctx)
  conn.emit('message', { type: 'send', threadId: A, text: 'x' })
  await tick()
  assert.deepEqual(conn.last(), { type: 'error', code: 'shim_offline', message: 'le shim est parti', threadId: A })
})

test('send : une erreur sans code du backend devient inject_failed', async () => {
  const ctx = boot()
  ctx.backend.fail = new Error('boom')
  const conn = pairedClient(ctx)
  conn.emit('message', { type: 'send', threadId: A, text: 'x' })
  await tick()
  assert.equal(conn.last().code, 'inject_failed')
  assert.equal(conn.last().threadId, A)
})

test('send sur un tour busy : le backend qui tient la file reçoit tout, l’autre empile ici', async () => {
  // Backend `acp` : la file vit dans le shim.
  const owned = boot()
  owned.states.mirror(A, { turn: 'busy' })
  const c1 = pairedClient(owned)
  c1.emit('message', { type: 'send', threadId: A, text: 'ensuite' })
  await tick()
  assert.deepEqual(owned.backend.calls, [['send', A, 'ensuite', 'queue']])
  assert.deepEqual(owned.states.get(A).queue, [], 'le daemon n’empile pas ce que le shim tient')

  // Backend sans file (mock) : le daemon empile et préviendra au retour à idle.
  const local = boot({ backend: fakeBackend({ ownsQueue: false }) })
  local.states.mirror(A, { turn: 'busy' })
  const c2 = pairedClient(local)
  c2.emit('message', { type: 'subscribe', threadId: A })
  c2.mark()
  c2.emit('message', { type: 'send', threadId: A, text: 'ensuite' })
  await tick()
  assert.deepEqual(local.backend.calls, [], 'rien n’est envoyé à un agent occupé')
  assert.deepEqual(local.states.get(A).queue.map((q) => q.text), ['ensuite'])
  assert.equal(c2.last().type, 'thread_state', 'la PWA voit la file se remplir')
  assert.deepEqual(c2.last().queue.map((q) => q.text), ['ensuite'])
})

test('send en mode interrupt sur un tour busy : pas de file, on coupe', async () => {
  const ctx = boot({ backend: fakeBackend({ ownsQueue: false }) })
  ctx.states.mirror(A, { turn: 'busy' })
  const conn = pairedClient(ctx)
  conn.emit('message', { type: 'send', threadId: A, text: 'maintenant', mode: 'interrupt' })
  await tick()
  assert.deepEqual(ctx.backend.calls, [['send', A, 'maintenant', 'interrupt']])
  assert.deepEqual(ctx.states.get(A).queue, [])
})

test('retour à idle : la file locale est dépilée vers le backend', async () => {
  const ctx = boot({ backend: fakeBackend({ ownsQueue: false }) })
  ctx.states.mirror(A, { turn: 'busy' })
  const conn = pairedClient(ctx)
  conn.emit('message', { type: 'subscribe', threadId: A })
  conn.emit('message', { type: 'send', threadId: A, text: 'ensuite' })
  await tick()
  conn.mark()

  ctx.states.setTurn(A, 'idle')
  await tick()
  assert.deepEqual(ctx.backend.calls.map((c) => c.slice(0, 3)), [['send', A, 'ensuite']])
  assert.deepEqual(ctx.states.get(A).queue, [])
  assert.equal(conn.only('thread_state').length >= 1, true)
})

test('dépilage impossible : les abonnés du thread sont prévenus', async () => {
  const ctx = boot({ backend: fakeBackend({ ownsQueue: false }) })
  ctx.states.mirror(A, { turn: 'busy' })
  const conn = pairedClient(ctx)
  conn.emit('message', { type: 'subscribe', threadId: A })
  conn.emit('message', { type: 'send', threadId: A, text: 'ensuite' })
  await tick()
  ctx.backend.fail = new Error('agent parti')
  conn.mark()

  ctx.states.setTurn(A, 'idle')
  await tick()
  const err = conn.only('error')[0]
  assert.equal(err.code, 'inject_failed')
  assert.equal(err.threadId, A)
  assert.match(err.message, /message en attente non envoyé : agent parti/)
})

test('cancel_queued : backend à file → commande, backend local → retrait du miroir', async () => {
  const owned = boot()
  const c1 = pairedClient(owned)
  c1.emit('message', { type: 'cancel_queued', threadId: A, queueId: 'q1' })
  await tick()
  assert.deepEqual(owned.backend.calls, [['cancel_queued', A, 'q1']])

  const local = boot({ backend: fakeBackend({ ownsQueue: false }) })
  local.states.enqueue(A, 'en attente')
  const [entry] = local.states.get(A).queue
  const c2 = pairedClient(local)
  c2.emit('message', { type: 'cancel_queued', threadId: A, queueId: entry.queueId })
  await tick()
  assert.deepEqual(local.backend.calls, [])
  assert.deepEqual(local.states.get(A).queue, [])
})

test('cancel_queued avec un queueId inconnu est ignoré silencieusement', async () => {
  const ctx = boot({ backend: fakeBackend({ ownsQueue: false }) })
  const conn = pairedClient(ctx)
  conn.emit('message', { type: 'cancel_queued', threadId: A, queueId: 'qinconnu' })
  await tick()
  assert.deepEqual(conn.only('error'), [])
  assert.deepEqual(ctx.backend.calls, [])
})

// ---------------------------------------------------------------------------
// interrupt
// ---------------------------------------------------------------------------

test('interrupt sur un tour busy coupe, au repos il ne fait rien', async () => {
  const busy = boot()
  busy.states.mirror(A, { turn: 'busy' })
  const c1 = pairedClient(busy)
  c1.emit('message', { type: 'interrupt', threadId: A })
  await tick()
  assert.deepEqual(busy.backend.calls, [['interrupt', A]])

  const idle = boot()
  const c2 = pairedClient(idle)
  c2.emit('message', { type: 'interrupt', threadId: A })
  await tick()
  assert.deepEqual(idle.backend.calls, [], 'rien à couper')
  assert.deepEqual(c2.sent, [], 'et rien à dire')
})

test('interrupt sur thread inconnu ou sans session → le code du protocole', async () => {
  const ctx = boot()
  ctx.states.mirror('thread-fantôme', { turn: 'busy' })
  const conn = pairedClient(ctx)
  conn.emit('message', { type: 'interrupt', threadId: 'thread-fantôme' })
  conn.emit('message', { type: 'interrupt', threadId: NO_SESSION })
  await tick()
  assert.deepEqual(conn.only('error').map((m) => m.code), ['unknown_thread', 'no_session'])
})

// ---------------------------------------------------------------------------
// set_option — spec §6.5
// ---------------------------------------------------------------------------

test('set_option au repos part tout de suite', async () => {
  const ctx = boot()
  const conn = pairedClient(ctx)
  conn.emit('message', { type: 'set_option', threadId: A, key: 'mode', value: 'plan' })
  await tick()
  assert.deepEqual(ctx.backend.calls, [['set_option', A, 'mode', 'plan']])
})

test('set_option en plein tour, backend qui tient la file : transmis quand même', async () => {
  const ctx = boot()
  ctx.states.mirror(A, { turn: 'busy' })
  const conn = pairedClient(ctx)
  conn.emit('message', { type: 'set_option', threadId: A, key: 'mode', value: 'plan' })
  await tick()
  assert.deepEqual(ctx.backend.calls, [['set_option', A, 'mode', 'plan']], 'le shim diffère lui-même')
})

test('set_option en plein tour, backend local : différé jusqu’au retour à idle', async () => {
  const ctx = boot({ backend: fakeBackend({ ownsQueue: false }) })
  ctx.states.mirror(A, { turn: 'busy' })
  const conn = pairedClient(ctx)
  conn.emit('message', { type: 'set_option', threadId: A, key: 'mode', value: 'plan' })
  conn.emit('message', { type: 'set_option', threadId: A, key: 'effort', value: 'high' })
  await tick()
  assert.deepEqual(ctx.backend.calls, [], 'pas de changement d’option en plein tour')
  assert.deepEqual(conn.sent, [])

  ctx.states.mirror(A, { turn: 'idle' })
  await tick()
  assert.deepEqual(ctx.backend.calls, [
    ['set_option', A, 'mode', 'plan'],
    ['set_option', A, 'effort', 'high'],
  ], 'appliquées dans l’ordre de demande')
})

test('les options différées ne sont appliquées qu’une fois', async () => {
  const ctx = boot({ backend: fakeBackend({ ownsQueue: false }) })
  ctx.states.mirror(A, { turn: 'busy' })
  pairedClient(ctx).emit('message', { type: 'set_option', threadId: A, key: 'mode', value: 'plan' })
  await tick()
  ctx.states.mirror(A, { turn: 'idle' })
  await tick()
  ctx.states.mirror(A, { turn: 'idle' })
  ctx.states.changed(A)
  await tick()
  assert.deepEqual(ctx.backend.calls, [['set_option', A, 'mode', 'plan']])
})

test('une option différée qui échoue est journalisée, pas renvoyée au client', async () => {
  const ctx = boot({ backend: fakeBackend({ ownsQueue: false }) })
  ctx.states.mirror(A, { turn: 'busy' })
  const conn = pairedClient(ctx)
  conn.emit('message', { type: 'set_option', threadId: A, key: 'mode', value: 'plan' })
  await tick()
  ctx.backend.fail = new Error('agent muet')
  conn.mark()
  ctx.states.mirror(A, { turn: 'idle' })
  await tick()
  await tick()
  assert.deepEqual(conn.sent.filter((m) => m.type === 'error'), [])
})

test('set_option sur thread inconnu → unknown_thread', async () => {
  const ctx = boot()
  const conn = pairedClient(ctx)
  conn.emit('message', { type: 'set_option', threadId: 'thread-fantôme', key: 'mode', value: 'x' })
  await tick()
  assert.deepEqual(conn.only('error').map((m) => m.code), ['unknown_thread'])
  assert.deepEqual(ctx.backend.calls, [])
})

// ---------------------------------------------------------------------------
// respond_permission — spec §6.6
// ---------------------------------------------------------------------------

test('permission tranchée du mobile : encart verrouillé et réponse dans le ring', async () => {
  const ctx = boot()
  const conn = pairedClient(ctx)
  conn.emit('message', { type: 'subscribe', threadId: A })
  conn.mark()

  conn.emit('message', { type: 'respond_permission', threadId: A, requestId: 'req-1', optionId: 'allow' })
  await tick()
  assert.deepEqual(ctx.backend.calls, [['respond_permission', A, 'req-1', 'allow']])

  const resolved = conn.only('permission_resolved')[0]
  assert.deepEqual(resolved, { type: 'permission_resolved', threadId: A, requestId: 'req-1', optionId: 'allow', optionName: 'Autoriser', by: 'mobile' })

  const inRing = ctx.rings.read(A).at(-1).update
  assert.equal(inRing.sessionUpdate, 'zra/permission_resolved')
  assert.equal(inRing.requestId, 'req-1')
  assert.equal(inRing.optionName, 'Autoriser')
})

test('permission tranchée depuis Zed : le verdict le dit', async () => {
  const ctx = boot()
  ctx.backend.respondPermission = async () => ({ optionId: 'reject', by: 'desktop' })
  const conn = pairedClient(ctx)
  conn.emit('message', { type: 'subscribe', threadId: A })
  conn.mark()
  conn.emit('message', { type: 'respond_permission', threadId: A, requestId: 'req-2', optionId: 'reject' })
  await tick()
  assert.equal(conn.only('permission_resolved')[0].by, 'desktop')
})

test('une réponse sans optionName du backend n’en invente pas', async () => {
  const ctx = boot()
  ctx.backend.respondPermission = async (t, r, o) => ({ optionId: o })
  const conn = pairedClient(ctx)
  conn.emit('message', { type: 'subscribe', threadId: A })
  conn.mark()
  conn.emit('message', { type: 'respond_permission', threadId: A, requestId: 'req-3', optionId: 'allow' })
  await tick()
  assert.equal('optionName' in conn.only('permission_resolved')[0], false)
  assert.equal('optionName' in ctx.rings.read(A).at(-1).update, false)
})

test('permission déjà tranchée : une seconde réponse ne reverrouille pas l’encart', async () => {
  const ctx = boot()
  const conn = pairedClient(ctx)
  conn.emit('message', { type: 'subscribe', threadId: A })
  conn.emit('message', { type: 'respond_permission', threadId: A, requestId: 'req-4', optionId: 'allow' })
  await tick()
  conn.mark()
  ctx.hub.permissionResolved(A, { requestId: 'req-4', optionId: 'allow', by: 'desktop' })
  await tick()
  assert.deepEqual(conn.only('permission_resolved'), [], 'idempotent')
  assert.equal(ctx.rings.read(A).filter((e) => e.update.sessionUpdate === 'zra/permission_resolved').length, 1)
})

test('permission expirée : l’encart passe en lecture seule, et une réponse tardive se tait', async () => {
  const ctx = boot()
  const conn = pairedClient(ctx)
  conn.emit('message', { type: 'subscribe', threadId: A })
  conn.mark()

  ctx.hub.permissionExpired(A, 'req-5')
  const err = conn.only('error')[0]
  assert.equal(err.code, 'permission_expired')
  assert.equal(err.threadId, A)
  assert.match(err.message, /expiré/)

  conn.mark()
  ctx.hub.permissionResolved(A, { requestId: 'req-5', optionId: 'allow' })
  await tick()
  assert.deepEqual(conn.only('permission_resolved'), [])
})

test('permissionExpired sans requestId : le message part quand même', () => {
  const ctx = boot()
  const conn = pairedClient(ctx)
  conn.emit('message', { type: 'subscribe', threadId: A })
  conn.mark()
  ctx.hub.permissionExpired(A, null)
  assert.equal(conn.only('error')[0].code, 'permission_expired')
})

test('respond_permission refusé par le backend : le code remonte', async () => {
  const ctx = boot()
  ctx.backend.fail = new InjectionError('permission_expired', 'déjà tranchée depuis le poste')
  const conn = pairedClient(ctx)
  conn.emit('message', { type: 'respond_permission', threadId: A, requestId: 'req-6', optionId: 'allow' })
  await tick()
  assert.deepEqual(conn.last(), { type: 'error', code: 'permission_expired', message: 'déjà tranchée depuis le poste', threadId: A })
  assert.deepEqual(conn.only('permission_resolved'), [])
})

test('un backend sans permission (mock) le dit explicitement', async () => {
  const backend = fakeBackend()
  delete backend.respondPermission
  const ctx = boot({ backend })
  const conn = pairedClient(ctx)
  conn.emit('message', { type: 'respond_permission', threadId: A, requestId: 'req-7', optionId: 'allow' })
  await tick()
  assert.equal(conn.last().code, 'permission_expired')
  assert.match(conn.last().message, /aucune demande de permission en attente/)
})

test('le jeu des permissions résolues est borné', () => {
  const ctx = boot()
  for (let i = 0; i < 600; i++) ctx.hub.permissionResolved(A, { requestId: `req-${i}`, optionId: 'allow' })
  assert.ok(ctx.hub.resolvedPermissions.size <= 500, `borne respectée, obtenu ${ctx.hub.resolvedPermissions.size}`)
})

// ---------------------------------------------------------------------------
// load_history — spec §5.2
// ---------------------------------------------------------------------------

test('load_history d’un thread vivant couvert par le ring : pas de seconde instance d’agent', async () => {
  const ctx = boot({
    covers: (sessionId) => sessionId === 'sess-a',
    loader: { load: async () => { throw new Error('ne doit pas être appelé') } },
  })
  ctx.shims.register({ shimId: 'shim-1', agentId: 'claude-zra', sessions: ['sess-a'] })
  ctx.hub.publish(A, { sessionUpdate: 'agent_message_chunk', text: 'direct' })
  const until = ctx.rings.cursor()

  const conn = pairedClient(ctx)
  conn.emit('message', { type: 'load_history', threadId: A })
  await tick()
  assert.deepEqual(conn.last(), {
    type: 'history', threadId: A,
    updates: [{ sessionUpdate: 'agent_message_chunk', text: 'direct' }],
    complete: true, until,
  })
})

test('load_history d’un thread vivant au ring évicté : complete false', async () => {
  const ctx = boot({ size: 2, covers: () => true, loader: { load: async () => { throw new Error('appelé à tort') } } })
  ctx.shims.register({ shimId: 'shim-1', agentId: 'claude-zra', sessions: ['sess-a'] })
  for (let i = 0; i < 5; i++) ctx.hub.publish(A, { n: i })
  const conn = pairedClient(ctx)
  conn.emit('message', { type: 'load_history', threadId: A })
  await tick()
  assert.equal(conn.last().complete, false)
  assert.deepEqual(conn.last().updates.map((u) => u.n), [3, 4], 'seulement ce que le ring a gardé')
})

test('load_history d’un thread fermé passe par la relecture, avec son until', async () => {
  const calls = []
  const ctx = boot({
    loader: { load: async (threadId) => { calls.push(threadId); return { updates: [{ n: 'replay' }], complete: true } } },
  })
  ctx.hub.publish(B, { n: 'ring' })
  const until = ctx.rings.cursor()
  const conn = pairedClient(ctx)
  conn.emit('message', { type: 'load_history', threadId: B })
  await tick()
  assert.deepEqual(calls, [B])
  assert.deepEqual(conn.last(), { type: 'history', threadId: B, updates: [{ n: 'replay' }], complete: true, until })
})

test('load_history sans loader : history_unavailable', async () => {
  const ctx = boot()
  const conn = pairedClient(ctx)
  conn.emit('message', { type: 'load_history', threadId: B })
  await tick()
  assert.equal(conn.last().code, 'history_unavailable')
  assert.match(conn.last().message, /ne sait pas relire/)
})

test('load_history en échec : le code de la relecture remonte', async () => {
  const ctx = boot({
    loader: { load: async () => { throw Object.assign(new Error('session introuvable'), { code: 'session_not_found' }) } },
  })
  const conn = pairedClient(ctx)
  conn.emit('message', { type: 'load_history', threadId: B })
  await tick()
  assert.deepEqual(conn.last(), { type: 'error', code: 'session_not_found', message: 'session introuvable', threadId: B })
})

test('load_history en échec sans code : history_unavailable', async () => {
  const ctx = boot({ loader: { load: async () => { throw new Error('agent muet') } } })
  const conn = pairedClient(ctx)
  conn.emit('message', { type: 'load_history', threadId: B })
  await tick()
  assert.equal(conn.last().code, 'history_unavailable')
})

test('load_history : thread inconnu ou sans session', async () => {
  const ctx = boot({ loader: { load: async () => ({ updates: [], complete: true }) } })
  const conn = pairedClient(ctx)
  conn.emit('message', { type: 'load_history', threadId: 'thread-fantôme' })
  conn.emit('message', { type: 'load_history', threadId: NO_SESSION })
  await tick()
  assert.deepEqual(conn.only('error').map((m) => m.code), ['unknown_thread', 'no_session'])
})

// ---------------------------------------------------------------------------
// Réouverture d’un thread fermé — spec §6.3
// ---------------------------------------------------------------------------

test('send sur un thread fermé : Zed le rouvre, puis injection normale', async () => {
  const reopened = []
  const ctx = boot({ zed: { enabled: true, canReopen: true, reopen: async (t) => { reopened.push(t.threadId) } } })
  ctx.backend.name = 'acp'
  const conn = pairedClient(ctx)
  conn.emit('message', { type: 'send', threadId: B, text: 'réveille-toi' })
  await tick()
  await tick()
  assert.deepEqual(reopened, [B])
  assert.deepEqual(ctx.backend.calls, [['send', B, 'réveille-toi', 'queue']])
  assert.deepEqual(conn.only('error'), [])
})

test('send sur un thread déjà vivant ne touche pas à Zed', async () => {
  const reopened = []
  const ctx = boot({ zed: { enabled: true, canReopen: true, reopen: async (t) => reopened.push(t.threadId) } })
  ctx.shims.register({ shimId: 's1', agentId: 'claude-zra', sessions: ['sess-a'] })
  const conn = pairedClient(ctx)
  conn.emit('message', { type: 'send', threadId: A, text: 'x' })
  await tick()
  assert.deepEqual(reopened, [])
  assert.deepEqual(ctx.backend.calls.length, 1)
})

test('thread d’un agent hors ZRA : refus immédiat, aucune touche', async () => {
  const reopened = []
  const ctx = boot({ zed: { enabled: true, canReopen: true, reopen: async (t) => reopened.push(t.threadId) } })
  ctx.threads.get(B).agentId = 'claude-acp'          // l’agent nu, pas l’entrée ZRA
  const conn = pairedClient(ctx)
  conn.emit('message', { type: 'send', threadId: B, text: 'x' })
  await tick()
  assert.deepEqual(reopened, [], 'Zed n’est pas piloté pour rien')
  assert.deepEqual(ctx.backend.calls, [])
  const err = conn.last()
  assert.equal(err.code, 'not_zra_thread')
  assert.equal(err.threadId, B)
  assert.match(err.message, /lecture seule/)
})

test('un agent inconnu du registry compte comme hors ZRA', async () => {
  const ctx = boot({ zed: { enabled: true, canReopen: true, reopen: async () => {} } })
  ctx.threads.get(B).agentId = 'agent-mystère'
  const conn = pairedClient(ctx)
  conn.emit('message', { type: 'send', threadId: B, text: 'x' })
  await tick()
  assert.equal(conn.last().code, 'not_zra_thread')
})

test('réouverture impossible : inject_failed, et rien n’est envoyé', async () => {
  const ctx = boot({ zed: { enabled: true, canReopen: true, reopen: async () => { throw new Error('fenêtre introuvable') } } })
  const conn = pairedClient(ctx)
  conn.emit('message', { type: 'send', threadId: B, text: 'x' })
  await tick()
  assert.deepEqual(conn.last(), { type: 'error', code: 'inject_failed', message: 'fenêtre introuvable', threadId: B })
  assert.deepEqual(ctx.backend.calls, [])
})

test('backend mock : pas de réouverture, même sur thread fermé', async () => {
  const reopened = []
  const ctx = boot({
    zed: { enabled: true, canReopen: true, reopen: async (t) => reopened.push(t.threadId) },
    backend: fakeBackend({ name: 'mock', ownsQueue: false }),
  })
  const conn = pairedClient(ctx)
  conn.emit('message', { type: 'send', threadId: B, text: 'x' })
  await tick()
  assert.deepEqual(reopened, [])
  assert.deepEqual(ctx.backend.calls, [['send', B, 'x', 'queue']])
})

test('sans pilotage de Zed, un thread fermé part au backend tel quel', async () => {
  const ctx = boot({ zed: null })
  const conn = pairedClient(ctx)
  conn.emit('message', { type: 'send', threadId: B, text: 'x' })
  await tick()
  assert.deepEqual(ctx.backend.calls, [['send', B, 'x', 'queue']])
})

// ---------------------------------------------------------------------------
// new_thread — spec §6.7
// ---------------------------------------------------------------------------

function fakeZedControl(over = {}) {
  return {
    enabled: true,
    canReopen: true,
    calls: [],
    async reopen(thread) { this.calls.push(['reopen', thread.threadId]) },
    async newThread(agentId, opts) {
      this.calls.push(['newThread', agentId, opts])
      const threadId = 'thread-neuf'
      return { thread: { threadId, agentId }, cwd: opts.folderPaths?.[0] ?? 'C:/ailleurs' }
    },
    ...over,
  }
}

test('new_thread : threads d’abord, thread_created ensuite', async () => {
  const zed = fakeZedControl()
  const ctx = boot({ zed })
  const conn = pairedClient(ctx)
  conn.emit('message', { type: 'new_thread', agentId: 'claude-zra' })
  await tick()

  assert.deepEqual(conn.types(), ['threads', 'thread_created'])
  assert.deepEqual(conn.last(), { type: 'thread_created', threadId: 'thread-neuf', agentId: 'claude-zra' })
  assert.deepEqual(zed.calls, [['newThread', 'claude-zra', { folderPaths: null, newWindow: false }]])
})

test('new_thread avec un projet connu : les dossiers de l’index, pas un chemin libre', async () => {
  const zed = fakeZedControl({
    async newThread(agentId, opts) {
      this.calls.push(['newThread', agentId, opts])
      return { thread: { threadId: 'thread-neuf', agentId }, cwd: opts.folderPaths[0] }
    },
  })
  const ctx = boot({ zed })
  const conn = pairedClient(ctx)
  conn.emit('message', { type: 'new_thread', agentId: 'claude-zra', folderPaths: ['C:/PROJ/zra'] })
  await tick()

  assert.deepEqual(zed.calls[0][2].folderPaths, ['C:/proj/zra'], 'normalisé et rendu tel que l’index l’écrit')
  assert.deepEqual(conn.only('error'), [])
  assert.equal(conn.types().includes('thread_created'), true)
})

test('new_thread sur un projet fermé dans Zed : demandé dans une nouvelle fenêtre', async () => {
  const zed = fakeZedControl()
  const ctx = boot({ zed })
  ctx.threads.threads.push({ threadId: 'thread-fermé', sessionId: 'sess-c', agentId: 'gemini-zra', state: 'closed', folderPaths: ['C:/proj/ferme'], projectOpen: false })
  const conn = pairedClient(ctx)
  conn.emit('message', { type: 'new_thread', agentId: 'gemini-zra', folderPaths: ['C:/proj/ferme'] })
  await tick()
  assert.equal(zed.calls[0][2].newWindow, true)
})

test('new_thread : projet inconnu du poste → refus, Zed n’est pas piloté', async () => {
  const zed = fakeZedControl()
  const ctx = boot({ zed })
  const conn = pairedClient(ctx)
  for (const folderPaths of [['C:/inconnu'], [], 'C:/proj/zra', [null], new Array(17).fill('C:/proj/zra')]) {
    conn.mark()
    conn.emit('message', { type: 'new_thread', agentId: 'claude-zra', folderPaths })
    await tick()
    assert.equal(conn.last().code, 'new_thread_failed', JSON.stringify(folderPaths))
    assert.match(conn.last().message, /projet inconnu/)
  }
  assert.deepEqual(zed.calls, [])
})

test('new_thread sans agent, ou pilotage désactivé → refus', async () => {
  const ctx = boot({ zed: fakeZedControl() })
  const conn = pairedClient(ctx)
  conn.emit('message', { type: 'new_thread' })
  await tick()
  assert.equal(conn.last().code, 'new_thread_failed')
  assert.match(conn.last().message, /agent non précisé/)

  const off = boot({ zed: fakeZedControl({ enabled: false }) })
  const c2 = pairedClient(off)
  c2.emit('message', { type: 'new_thread', agentId: 'claude-zra' })
  await tick()
  assert.match(c2.last().message, /pilotage de Zed désactivé/)

  const none = boot({ zed: null })
  const c3 = pairedClient(none)
  c3.emit('message', { type: 'new_thread', agentId: 'claude-zra' })
  await tick()
  assert.equal(c3.last().code, 'new_thread_failed')
})

test('new_thread en échec côté Zed : l’erreur devient new_thread_failed', async () => {
  const zed = fakeZedControl({ async newThread() { throw new Error('Zed ne répond pas') } })
  const ctx = boot({ zed })
  const conn = pairedClient(ctx)
  conn.emit('message', { type: 'new_thread', agentId: 'claude-zra' })
  await tick()
  assert.deepEqual(conn.last(), { type: 'error', code: 'new_thread_failed', message: 'Zed ne répond pas' })
})

test('new_thread ouvert ailleurs que dans le projet demandé : le fil le dit', async () => {
  const zed = fakeZedControl({
    async newThread(agentId, opts) {
      this.calls.push(['newThread', agentId, opts])
      return { thread: { threadId: 'thread-neuf', agentId }, cwd: 'C:/tout/autre' }
    },
  })
  const ctx = boot({ zed })
  const conn = pairedClient(ctx)
  conn.emit('message', { type: 'subscribe', threadId: 'thread-neuf' })   // inconnu pour l’instant
  conn.mark()
  conn.emit('message', { type: 'new_thread', agentId: 'claude-zra', folderPaths: ['C:/proj/zra'] })
  await tick()
  const event = ctx.rings.read('thread-neuf').at(-1)?.update
  assert.equal(event.sessionUpdate, 'zra/notice')
  assert.equal(event.level, 'warn')
  assert.match(event.text, /session ouverte dans C:\/tout\/autre, pas dans C:\/proj\/zra/i)
})

test('new_thread ouvert dans le bon dossier : aucun avertissement', async () => {
  const zed = fakeZedControl({
    async newThread(agentId, opts) { return { thread: { threadId: 'thread-neuf', agentId }, cwd: opts.folderPaths[0] } },
  })
  const ctx = boot({ zed })
  const conn = pairedClient(ctx)
  conn.emit('message', { type: 'new_thread', agentId: 'claude-zra', folderPaths: ['C:/proj/zra'] })
  await tick()
  assert.deepEqual(ctx.rings.read('thread-neuf'), [])
})

// ---------------------------------------------------------------------------
// Journalisation des écritures — §9
// ---------------------------------------------------------------------------

test('toute écriture est journalisée, aucune lecture', async () => {
  const ctx = boot()
  ctx.states.mirror(A, { turn: 'busy' })
  const conn = pairedClient(ctx)
  const writes = [
    { type: 'send', threadId: A, text: 'x', mode: 'interrupt' },
    { type: 'set_option', threadId: A, key: 'mode', value: 'plan' },
    { type: 'respond_permission', threadId: A, requestId: 'r', optionId: 'allow' },
    { type: 'new_thread', agentId: 'claude-zra' },
    { type: 'interrupt', threadId: A },
    { type: 'cancel_queued', threadId: A, queueId: 'q' },
  ]
  for (const msg of writes) conn.emit('message', msg)
  for (const msg of [{ type: 'ping' }, { type: 'hello' }, { type: 'list_threads' }, { type: 'subscribe', threadId: A }, { type: 'load_history', threadId: A }, { type: 'unknown' }]) {
    conn.emit('message', msg)
  }
  await tick()
  assert.deepEqual(ctx.recorded.map((e) => e.type), writes.map((m) => m.type))
  assert.deepEqual(Object.keys(ctx.recorded[0]).sort(), [
    'agentId', 'client', 'ip', 'key', 'optionId', 'text', 'threadId', 'type', 'value',
  ])
  assert.equal(ctx.recorded[0].client, null, 'hello n’est pas encore passé : clientId inconnu')
  assert.equal(ctx.recorded[0].ip, '127.0.0.1')
  assert.equal(ctx.recorded[0].text, 'x')
  assert.equal(ctx.recorded[1].key, 'mode')
  assert.equal(ctx.recorded[1].value, 'plan')
  assert.equal(ctx.recorded[2].optionId, 'allow')
  assert.equal(ctx.recorded[3].agentId, 'claude-zra')
})

test('le clientId du hello est repris dans le journal', () => {
  const ctx = boot()
  const conn = pairedClient(ctx)
  conn.emit('message', { type: 'hello', clientId: 'mobile-1' })
  conn.emit('message', { type: 'interrupt', threadId: A })
  assert.equal(ctx.recorded.at(-1).client, 'mobile-1')
})

// ---------------------------------------------------------------------------
// Appairage — spec §9
// ---------------------------------------------------------------------------

test('client distant non appairé : hello sans jeton → auth_required, le reste est ignoré', () => {
  const pairing = new Pairing({ file: null })
  const ctx = boot({ pairing })
  const conn = client(ctx)                                  // 203.0.113.9 : pas la loopback
  conn.emit('message', { type: 'hello', clientId: 'mobile' })
  assert.deepEqual(conn.last(), { type: 'auth_required', name: 'poste-test', reason: null })

  conn.mark()
  conn.emit('message', { type: 'list_threads' })
  conn.emit('message', { type: 'subscribe', threadId: A })
  conn.emit('message', { type: 'send', threadId: A, text: 'x' })
  assert.deepEqual(conn.sent, [], 'aucune réponse : la PWA rejoue sa file, on ne l’inonde pas')
  assert.deepEqual(ctx.backend.calls, [])
  ctx.threads.emit('change', ctx.threads.threads)
  assert.deepEqual(conn.sent, [], 'aucun broadcast non plus')
})

test('ping est répondu même avant appairage : le heartbeat tient pendant la saisie du code', () => {
  // Écart avec le commentaire de `handleUnpaired` (« le reste est ignoré sans
  // réponse ») : `ping` est traité avant le contrôle d’appairage. Voir
  // FINDINGS.md — rien ne fuit, mais le contrat écrit n’est pas celui-là.
  const pairing = new Pairing({ file: null })
  const ctx = boot({ pairing })
  const conn = client(ctx)
  conn.emit('message', { type: 'hello' })
  conn.mark()
  conn.emit('message', { type: 'ping' })
  assert.deepEqual(conn.sent, [{ type: 'pong' }])
})

test('hello avec un jeton inconnu → auth_required et la raison', () => {
  const pairing = new Pairing({ file: null })
  const ctx = boot({ pairing })
  const conn = client(ctx)
  conn.emit('message', { type: 'hello', token: 'x'.repeat(32) })
  assert.deepEqual(conn.last(), { type: 'auth_required', name: 'poste-test', reason: 'jeton inconnu ou révoqué' })
})

test('pair avec le bon code : jeton rendu, puis bootstrap', () => {
  const pairing = new Pairing({ file: null })
  const ctx = boot({ pairing })
  const conn = client(ctx)
  conn.emit('message', { type: 'hello', clientId: 'mobile-1' })
  conn.mark()
  conn.emit('message', { type: 'pair', code: pairing.code, label: 'mon téléphone' })

  assert.equal(conn.sent[0].type, 'paired')
  assert.equal(typeof conn.sent[0].token, 'string')
  assert.ok(conn.sent[0].token.length >= 20, 'un jeton réutilisable au hello suivant')
  assert.equal(typeof conn.sent[0].clientId, 'string')
  assert.deepEqual(conn.types().slice(1, 3), ['machine', 'threads'], 'le bootstrap suit immédiatement')
  assert.equal(pairing.clients.length, 1)
  assert.equal(pairing.clients[0].label, 'mon téléphone')

  conn.mark()
  conn.emit('message', { type: 'list_threads' })
  assert.equal(conn.last().type, 'threads', 'le client est reconnu')
})

test('pair sans label : le clientId du hello sert de nom', () => {
  const pairing = new Pairing({ file: null })
  const ctx = boot({ pairing })
  const conn = client(ctx)
  conn.emit('message', { type: 'hello', clientId: 'pixel-7' })
  conn.emit('message', { type: 'pair', code: pairing.code })
  assert.equal(pairing.clients[0].label, 'pixel-7')
})

test('pair avec un code faux → error pair_failed, toujours pas reconnu', () => {
  const pairing = new Pairing({ file: null })
  const ctx = boot({ pairing })
  const conn = client(ctx)
  conn.emit('message', { type: 'pair', code: '000000' })
  assert.equal(conn.last().type, 'error')
  assert.equal(conn.last().code, pairing.code === '000000' ? 'pair_locked' : 'pair_failed')
  conn.mark()
  conn.emit('message', { type: 'list_threads' })
  assert.deepEqual(conn.sent, [])
})

test('hello avec le jeton reçu au pair : reconnu d’emblée', () => {
  const pairing = new Pairing({ file: null })
  const ctx = boot({ pairing })
  const first = client(ctx)
  first.emit('message', { type: 'pair', code: pairing.code })
  const token = first.sent[0].token

  const second = client(ctx)
  second.emit('message', { type: 'hello', token, clientId: 'autre-appareil' })
  assert.deepEqual(second.types().slice(0, 2), ['machine', 'threads'])
  assert.equal(second.only('auth_required').length, 0)
})

test('revoke() coupe les connexions du client révoqué, avec le code 4401', () => {
  const pairing = new Pairing({ file: null })
  const ctx = boot({ pairing })
  const conn = client(ctx)
  conn.emit('message', { type: 'pair', code: pairing.code })
  const id = conn.sent[0].clientId
  const loopback = pairedClient(ctx)

  assert.equal(ctx.hub.revoke(id), true)
  assert.equal(conn.closeCode, 4401)
  assert.equal(loopback.closeCode, null, 'les autres clients restent')
  assert.equal(ctx.hub.revoke('inconnu'), false)
})

test('la loopback est reconnue sans appairage', () => {
  const pairing = new Pairing({ file: null })
  const ctx = boot({ pairing })
  for (const remoteAddress of ['127.0.0.1', '::1', '127.9.9.9', '::ffff:127.0.0.1']) {
    const conn = client(ctx, { remoteAddress })
    conn.emit('message', { type: 'list_threads' })
    assert.equal(conn.last().type, 'threads', remoteAddress)
  }
})

test('auth.exemptLoopback = false : la loopback doit s’appairer aussi', () => {
  const pairing = new Pairing({ file: null })
  const ctx = boot({ pairing, config: { auth: { exemptLoopback: false } } })
  const conn = client(ctx, { remoteAddress: '127.0.0.1' })
  conn.emit('message', { type: 'hello' })
  assert.equal(conn.last().type, 'auth_required')
})

test('sans pairing (mode dev), tout client est reconnu', () => {
  const ctx = boot()
  const conn = client(ctx)
  conn.emit('message', { type: 'list_threads' })
  assert.equal(conn.last().type, 'threads')
})

test('revoke() sans pairing ne fait rien', () => {
  const ctx = boot()
  assert.equal(ctx.hub.revoke('qui'), false)
})

test('AuthError d’appairage verrouillé : le code passe au client', () => {
  const ctx = boot({ pairing: null })
  const hub = ctx.hub
  hub.pairing = { verify: () => null, pair: () => { throw new AuthError('pair_locked', 'trop d’essais', { retryIn: 12 }) }, revoke: () => false }
  const conn = client(ctx)
  conn.emit('message', { type: 'pair', code: '123456' })
  assert.deepEqual(conn.last(), { type: 'error', code: 'pair_locked', message: 'trop d’essais' })
})
