// Le lot B de bout en bout : PWA ↔ daemon ↔ shim ↔ agent — spec §10.
//
// Tout est réel sauf Zed et l'agent : un vrai daemon, un vrai WebSocket, un vrai
// processus shim lancé comme Zed le lancerait, un agent bouchon en sous-processus.
// Le « Zed » est le client bouchon du §10.2, branché sur le stdio du shim.
//
//   critère de sortie du lot B : `npm test` vert et PWA pilotable de bout en
//   bout contre l'agent bouchon, **sans Zed lancé**.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadConfig } from '../config.js'
import { startDaemon } from '../daemon.js'
import { setLevel } from '../log.js'
import { buildCustom } from '../../scripts/make-fixture.mjs'
import { FakeZed } from '../../zra-shim/test/fake-zed.mjs'

setLevel('error')

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const FAKE_AGENT = join(ROOT, 'zra-shim', 'test', 'fake-agent.mjs')
const SHIM = join(ROOT, 'zra-shim', 'index.js')
const FIXTURE = join(HERE, 'fixtures', 'lot-b.sqlite')

const PORT = 7814
const HOST = '127.0.0.1'
const ORIGIN = 'https://zra.exemple.fr'

/** Le `cwd` doit exister : relire un thread fermé y relance l'agent (spec §5.2). */
const CWD = ROOT
const SESSION_VIVANT = 'lotb-session-0001'
const VIVANT = '00000000000000000000000000000001'
const FERME = '00000000000000000000000000000002'
const SANS_SESSION = '00000000000000000000000000000003'

buildCustom(FIXTURE, [
  {
    thread_id: VIVANT,
    session_id: SESSION_VIVANT,
    agent_id: 'fake-acp',
    title: 'Thread piloté depuis le mobile',
    updated_at: '2026-09-22T16:35:58.919960600+00:00',
    folder_paths: CWD,
    folder_paths_order: '0',
  },
  {
    thread_id: FERME,
    session_id: 'lotb-session-0002',
    agent_id: 'fake-acp',
    title: 'Thread fermé, à relire',
    updated_at: '2026-09-21T09:00:00.000000000+00:00',
    folder_paths: CWD,
    folder_paths_order: '0',
  },
  {
    thread_id: SANS_SESSION,
    session_id: null,
    agent_id: 'fake-acp',
    title: 'Thread avorté',
    updated_at: '2026-09-20T09:00:00.000000000+00:00',
    folder_paths: CWD,
    folder_paths_order: '0',
  },
])

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function boot(t, overrides = {}) {
  const config = await loadConfig({
    overrides: {
      port: PORT,
      requireTunnel: false,
      bindLan: false,
      bindTunnel: false,
      zedDb: FIXTURE,
      zedSettings: null,
      pollMs: 40,
      zedProbeMs: 60_000,
      logFile: null,
      injection: 'acp',
      allowedOrigins: [ORIGIN],
      // L'agent bouchon remplace le vrai agent, pour le shim comme pour la
      // relecture d'un thread fermé.
      agentCommands: { 'fake-acp': { command: process.execPath, args: [FAKE_AGENT] } },
      ...overrides,
    },
  })
  const daemon = await startDaemon(config)
  t.after(() => daemon.close())
  return daemon
}

/** Lance un shim comme Zed le ferait, et lui branche un faux Zed sur stdio. */
async function startShim(t, { sessionId = SESSION_VIVANT, zed = {}, env = {} } = {}) {
  const child = spawn(process.execPath, [SHIM, '--', process.execPath, FAKE_AGENT], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ZRA_AGENT_ID: 'fake-acp',
      ZRA_DAEMON_URL: `ws://${HOST}:${PORT}/shim`,
      ZRA_FAKE_SESSION_ID: sessionId,
      ZRA_LOG_LEVEL: 'error',
      ...env,
    },
  })
  t.after(() => child.kill())

  const fakeZed = new FakeZed({ toShim: child.stdin, fromShim: child.stdout, ...zed })
  await fakeZed.boot({ cwd: CWD })
  return { child, zed: fakeZed }
}

/** Client de test : même forme que celui du lot A. */
class Client {
  constructor(ws) {
    this.ws = ws
    this.messages = []
    ws.addEventListener('message', (ev) => this.messages.push(JSON.parse(ev.data)))
  }

  static async open(t) {
    const ws = new WebSocket(`ws://${HOST}:${PORT}/ws`)
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true })
      ws.addEventListener('error', reject, { once: true })
    })
    const client = new Client(ws)
    t.after(() => ws.close())
    return client
  }

  send(msg) {
    this.ws.send(JSON.stringify(msg))
    return this
  }

  async until(pred, { timeout = 8000, label = 'condition' } = {}) {
    const t0 = Date.now()
    for (;;) {
      const hit = this.messages.filter((m) => pred(m)).at(-1)
      if (hit) return hit
      if (Date.now() - t0 > timeout) {
        throw new Error(`${label} jamais atteinte — reçus : ${this.messages.map((m) => m.type).join(', ')}`)
      }
      await wait(10)
    }
  }

  of(type) {
    return this.messages.filter((m) => m.type === type)
  }

  events(threadId) {
    return this.of('acp_event').filter((m) => m.threadId === threadId).map((m) => m.update)
  }

  clear() {
    this.messages.length = 0
    return this
  }

  async hello() {
    this.send({ type: 'hello', clientId: 'test-lot-b' })
    await this.until((m) => m.type === 'threads', { label: 'bootstrap' })
    return this
  }
}

/** Ouvre un thread et attend que le daemon ait tout envoyé. */
async function subscribe(client, threadId) {
  client.send({ type: 'subscribe', threadId })
  return client.until((m) => m.type === 'thread_state' && m.threadId === threadId, { label: 'thread_state' })
}

// ===========================================================================
// Le shim rend un thread vivant
// ===========================================================================

test('un shim connecté fait passer le thread à live (protocole §4 threads)', async (t) => {
  const daemon = await boot(t)
  const client = await (await Client.open(t)).hello()

  // Sans shim, tout est fermé (lot A).
  assert.equal(client.of('threads').at(-1).threads.find((x) => x.threadId === VIVANT).state, 'closed')

  await startShim(t)
  const threads = await client.until(
    (m) => m.type === 'threads' && m.threads.find((x) => x.threadId === VIVANT)?.state === 'live',
    { label: 'thread live' },
  )
  assert.equal(threads.threads.find((x) => x.threadId === VIVANT).state, 'live')
  assert.equal(daemon.shims.hasSession(SESSION_VIVANT), true)
})

test('subscribe : le thread_state porte les modes et modèles lus par le shim', async (t) => {
  await boot(t)
  await startShim(t)
  const client = await (await Client.open(t)).hello()
  await client.until((m) => m.type === 'threads' && m.threads.find((x) => x.threadId === VIVANT)?.state === 'live',
    { label: 'thread live' })

  const state = await client.until(
    (m) => m.type === 'thread_state' && m.threadId === VIVANT && m.modes,
    { label: 'options de session' },
  )
  assert.deepEqual(state.modes, [{ id: 'default', name: 'Normal' }, { id: 'plan', name: 'Plan' }])
  assert.deepEqual(state.models, [{ id: 'rapide', name: 'Rapide' }, { id: 'lent', name: 'Appliqué' }])
  assert.equal(state.currentModeId, 'default')
  assert.equal(state.turn, 'idle')
  // Les autres réglages de l'agent suivent, le mode et le modèle n'y sont pas répétés.
  assert.deepEqual(state.options.map((o) => o.id), ['effort', 'fast'])
})

// ===========================================================================
// Lecture live
// ===========================================================================

test('les événements de l’agent arrivent en acp_event, verbatim (§6.1)', async (t) => {
  await boot(t)
  const { zed } = await startShim(t)
  const client = await (await Client.open(t)).hello()
  await subscribe(client, VIVANT)

  await zed.prompt('bonjour')
  await client.until(
    (m) => m.type === 'acp_event' && m.update.content?.text === 'reçu : bonjour',
    { label: 'réponse de l’agent' },
  )
  const chunk = client.events(VIVANT).find((u) => u.sessionUpdate === 'agent_message_chunk')
  assert.deepEqual(chunk, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'reçu : bonjour' } })
})

test('le ring buffer est rejoué au subscribe (protocole §3)', async (t) => {
  await boot(t)
  const { zed } = await startShim(t)
  const client = await (await Client.open(t)).hello()

  // Événements produits **avant** tout abonnement.
  await zed.prompt('avant abonnement')
  await wait(200)

  await subscribe(client, VIVANT)
  await client.until(
    (m) => m.type === 'acp_event' && m.update.content?.text === 'reçu : avant abonnement',
    { label: 'rejeu du ring buffer' },
  )
})

// ===========================================================================
// Écriture
// ===========================================================================

test('send : le message part vers l’agent et le tour bascule busy puis idle', async (t) => {
  await boot(t)
  await startShim(t)
  const client = await (await Client.open(t)).hello()
  await subscribe(client, VIVANT)
  client.clear()

  client.send({ type: 'send', threadId: VIVANT, text: 'salut depuis le mobile', mode: 'queue' })

  await client.until(
    (m) => m.type === 'acp_event' && m.update.content?.text === 'reçu : salut depuis le mobile',
    { label: 'réponse à l’injection' },
  )
  assert.ok(client.of('thread_state').some((s) => s.turn === 'busy'), 'un thread_state busy a été publié')
  await client.until((m) => m.type === 'thread_state' && m.turn === 'idle', { label: 'retour au repos' })
})

test('send en file pendant un tour, puis dépilage automatique (§6.4)', async (t) => {
  await boot(t)
  await startShim(t)
  const client = await (await Client.open(t)).hello()
  await subscribe(client, VIVANT)

  client.send({ type: 'send', threadId: VIVANT, text: 'lent: tour occupé', mode: 'queue' })
  await client.until((m) => m.type === 'thread_state' && m.turn === 'busy', { label: 'busy' })

  client.send({ type: 'send', threadId: VIVANT, text: 'à la suite', mode: 'queue' })
  const enFile = await client.until(
    (m) => m.type === 'thread_state' && m.queue.length === 1,
    { label: 'file d’attente' },
  )
  assert.equal(enFile.queue[0].text, 'à la suite')
  assert.match(enFile.queue[0].queueId, /^q/)

  await client.until(
    (m) => m.type === 'acp_event' && m.update.content?.text === 'reçu : à la suite',
    { label: 'dépilage' },
  )
  const dernier = client.of('thread_state').at(-1)
  assert.deepEqual(dernier.queue, [])
})

test('cancel_queued retire l’entrée et republie l’état (§3)', async (t) => {
  await boot(t)
  await startShim(t)
  const client = await (await Client.open(t)).hello()
  await subscribe(client, VIVANT)

  client.send({ type: 'send', threadId: VIVANT, text: 'lent: tour occupé', mode: 'queue' })
  await client.until((m) => m.type === 'thread_state' && m.turn === 'busy', { label: 'busy' })
  client.send({ type: 'send', threadId: VIVANT, text: 'à annuler', mode: 'queue' })
  const enFile = await client.until((m) => m.type === 'thread_state' && m.queue.length === 1, { label: 'file' })

  client.send({ type: 'cancel_queued', threadId: VIVANT, queueId: enFile.queue[0].queueId })
  await client.until((m) => m.type === 'thread_state' && m.queue.length === 0, { label: 'file vidée' })

  // Idempotence : un rejeu de reconnexion ne doit rien casser (protocole §6.4).
  client.send({ type: 'cancel_queued', threadId: VIVANT, queueId: enFile.queue[0].queueId })
  await wait(100)
  assert.equal(client.of('error').length, 0)
})

test('interrupt coupe le tour sans rien envoyer (§3 interrupt)', async (t) => {
  await boot(t)
  await startShim(t)
  const client = await (await Client.open(t)).hello()
  await subscribe(client, VIVANT)

  client.send({ type: 'send', threadId: VIVANT, text: 'lent: tour à couper', mode: 'queue' })
  await client.until((m) => m.type === 'thread_state' && m.turn === 'busy', { label: 'busy' })

  client.send({ type: 'interrupt', threadId: VIVANT })
  // Le fil dit ce qui s'est passé (protocole §3 `interrupt`, §5 `zra/notice`).
  await client.until(
    (m) => m.type === 'acp_event' && m.update.sessionUpdate === 'zra/notice' && m.update.text === 'tour interrompu',
    { label: 'avis d’interruption' },
  )
  await client.until((m) => m.type === 'thread_state' && m.turn === 'idle', { label: 'tour coupé' })

  // Rien d'autre n'a été envoyé à l'agent.
  assert.ok(!client.events(VIVANT).some((u) => u.sessionUpdate === 'user_message_chunk' && u.content?.text !== 'lent: tour à couper'))
})

test('set_option : le mode change réellement côté agent', async (t) => {
  await boot(t)
  await startShim(t)
  const client = await (await Client.open(t)).hello()
  await subscribe(client, VIVANT)

  client.send({ type: 'set_option', threadId: VIVANT, key: 'mode', value: 'plan' })
  await client.until(
    (m) => m.type === 'acp_event' && m.update.sessionUpdate === 'current_mode_update' && m.update.currentModeId === 'plan',
    { label: 'current_mode_update' },
  )
  await client.until(
    (m) => m.type === 'thread_state' && m.currentModeId === 'plan',
    { label: 'thread_state à jour' },
  )
})

test('set_option : un réglage générique (effort, mode rapide) arrive jusqu’à l’agent', async (t) => {
  await boot(t)
  await startShim(t)
  const client = await (await Client.open(t)).hello()
  await subscribe(client, VIVANT)

  const value = (m, id) => m.options?.find((o) => o.id === id)?.currentValue
  client.send({ type: 'set_option', threadId: VIVANT, key: 'effort', value: 'low' })
  await client.until((m) => m.type === 'thread_state' && value(m, 'effort') === 'low', { label: 'effort' })
  client.send({ type: 'set_option', threadId: VIVANT, key: 'fast', value: true })
  await client.until((m) => m.type === 'thread_state' && value(m, 'fast') === true, { label: 'mode rapide' })
})

test('un thread sans session refuse l’écriture (no_session)', async (t) => {
  await boot(t)
  await startShim(t)
  const client = await (await Client.open(t)).hello()

  client.send({ type: 'send', threadId: SANS_SESSION, text: 'coucou', mode: 'queue' })
  const err = await client.until((m) => m.type === 'error', { label: 'erreur' })
  assert.equal(err.code, 'no_session')
})

test('écrire à un thread fermé échoue proprement (inject_failed)', async (t) => {
  await boot(t)
  await startShim(t)
  const client = await (await Client.open(t)).hello()

  client.send({ type: 'send', threadId: FERME, text: 'coucou', mode: 'queue' })
  const err = await client.until((m) => m.type === 'error', { label: 'erreur' })
  assert.equal(err.code, 'inject_failed')
  assert.match(err.message, /pas ouvert dans Zed/)
})

// ===========================================================================
// Permissions (spec §6.6)
// ===========================================================================

test('permission : le mobile tranche, permission_resolved by mobile', async (t) => {
  await boot(t)
  const { zed } = await startShim(t, { zed: { answerPermission: null } })
  const client = await (await Client.open(t)).hello()
  await subscribe(client, VIVANT)

  const turn = zed.prompt('permission: écrire un fichier')
  const demande = await client.until(
    (m) => m.type === 'acp_event' && m.update.options && m.update.toolCall,
    { label: 'demande de permission' },
  )
  assert.deepEqual(demande.update.options.map((o) => o.optionId), ['allow', 'reject'])

  client.send({
    type: 'respond_permission', threadId: VIVANT,
    requestId: demande.update.requestId, optionId: 'allow',
  })
  const resolu = await client.until((m) => m.type === 'permission_resolved', { label: 'permission_resolved' })
  assert.equal(resolu.by, 'mobile')
  assert.equal(resolu.optionId, 'allow')
  assert.equal(resolu.optionName, 'Autoriser')

  await turn
  await client.until(
    (m) => m.type === 'acp_event' && m.update.sessionUpdate === 'tool_call_update' && m.update.status === 'completed',
    { label: 'reprise du tour' },
  )
})

test('permission : le poste tranche en premier, by desktop puis permission_expired', async (t) => {
  await boot(t)
  const { zed } = await startShim(t, { zed: { answerPermission: 'reject' } })
  const client = await (await Client.open(t)).hello()
  await subscribe(client, VIVANT)

  const turn = zed.prompt('permission: écrire un fichier')
  const demande = await client.until(
    (m) => m.type === 'acp_event' && m.update.options && m.update.toolCall,
    { label: 'demande de permission' },
  )
  const resolu = await client.until((m) => m.type === 'permission_resolved', { label: 'arbitrage' })
  assert.equal(resolu.by, 'desktop')
  assert.equal(resolu.optionId, 'reject')

  client.send({
    type: 'respond_permission', threadId: VIVANT,
    requestId: demande.update.requestId, optionId: 'allow',
  })
  const err = await client.until((m) => m.type === 'error', { label: 'permission_expired' })
  assert.equal(err.code, 'permission_expired')
  await turn
})

// ===========================================================================
// Historique d'un thread fermé (spec §5.2)
// ===========================================================================

test('load_history rejoue la session fermée par session/load', async (t) => {
  await boot(t)
  const client = await (await Client.open(t)).hello()

  client.send({ type: 'load_history', threadId: FERME })
  const history = await client.until((m) => m.type === 'history', { label: 'history' })
  assert.equal(history.threadId, FERME)
  assert.equal(history.complete, true)
  assert.deepEqual(history.updates.map((u) => u.sessionUpdate), ['user_message_chunk', 'agent_message_chunk'])
})

test('load_history : deuxième appel servi par le cache, sans relancer l’agent', async (t) => {
  const daemon = await boot(t)
  const client = await (await Client.open(t)).hello()

  client.send({ type: 'load_history', threadId: FERME })
  await client.until((m) => m.type === 'history', { label: 'history' })
  const premier = daemon.loader.cache.get('lotb-session-0002')
  assert.ok(premier)

  client.send({ type: 'load_history', threadId: FERME })
  await client.until((m) => m.type === 'history' && client.of('history').length === 2, { label: '2e history' })
  // Même entrée de cache : aucune nouvelle instance d'agent n'a été lancée.
  assert.equal(daemon.loader.cache.get('lotb-session-0002'), premier)
})

test('agent sans loadSession : no_load_session, composer actif (risque 🟠2)', async (t) => {
  await boot(t, {
    agentCommands: {
      'fake-acp': {
        command: process.execPath,
        args: [FAKE_AGENT],
        env: { ZRA_FAKE_NO_LOAD_SESSION: '1' },
      },
    },
  })
  const client = await (await Client.open(t)).hello()

  client.send({ type: 'load_history', threadId: FERME })
  const err = await client.until((m) => m.type === 'error', { label: 'erreur' })
  assert.equal(err.code, 'no_load_session')
  assert.match(err.message, /loadSession/)
})

test('load_history sur un thread sans session : no_session', async (t) => {
  await boot(t)
  const client = await (await Client.open(t)).hello()
  client.send({ type: 'load_history', threadId: SANS_SESSION })
  const err = await client.until((m) => m.type === 'error', { label: 'erreur' })
  assert.equal(err.code, 'no_session')
})

// ===========================================================================
// Mort du shim
// ===========================================================================

test('shim perdu : le thread redevient closed et la file perdue est annoncée', async (t) => {
  await boot(t)
  const { child } = await startShim(t)
  const client = await (await Client.open(t)).hello()
  await subscribe(client, VIVANT)
  await client.until((m) => m.type === 'threads' && m.threads.find((x) => x.threadId === VIVANT)?.state === 'live',
    { label: 'live' })

  client.send({ type: 'send', threadId: VIVANT, text: 'lent: tour occupé', mode: 'queue' })
  await client.until((m) => m.type === 'thread_state' && m.turn === 'busy', { label: 'busy' })
  client.send({ type: 'send', threadId: VIVANT, text: 'jamais envoyé', mode: 'queue' })
  await client.until((m) => m.type === 'thread_state' && m.queue.length === 1, { label: 'file' })

  child.kill()

  await client.until(
    (m) => m.type === 'acp_event' && m.update.sessionUpdate === 'zra/notice' && /file d'attente|perdu/.test(m.update.text),
    { label: 'avis de perte de la file' },
  )
  await client.until(
    (m) => m.type === 'threads' && m.threads.find((x) => x.threadId === VIVANT)?.state === 'closed',
    { label: 'retour à closed' },
  )
  const dernier = client.of('thread_state').at(-1)
  assert.equal(dernier.turn, 'idle')
  assert.deepEqual(dernier.queue, [])
})

// ===========================================================================
// Le shim tel que l'installe `npm run setup` (lot C)
// ===========================================================================

test('shim installé : journal dans un fichier, trames enregistrées, /status à jour', async (t) => {
  const { mkdirSync, readFileSync, readdirSync, rmSync } = await import('node:fs')
  const dir = join(HERE, 'fixtures', 'shim-state')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const logFile = join(dir, 'logs', 'shim.log')

  await boot(t)
  const { zed } = await startShim(t, {
    env: { ZRA_LOG_LEVEL: 'info', ZRA_LOG_FILE: logFile, ZRA_RECORD: '1', ZRA_RECORD_DIR: join(dir, 'records') },
  })
  await zed.prompt('trace-moi')

  // Le diagnostic local voit le shim et sa session, rattachée au bon thread.
  const status = await (await fetch(`http://${HOST}:${PORT}/status`)).json()
  assert.equal(status.injection, 'acp')
  assert.equal(status.threads.live, 1)
  assert.deepEqual(status.shims[0].sessions, [{ sessionId: SESSION_VIVANT, threadId: VIVANT }])
  assert.equal(status.shims[0].loadSession, true)

  await wait(150)
  const log = readFileSync(logFile, 'utf8')
  assert.match(log, /daemon connecté/)
  assert.match(log, /initialize : .*loadSession=oui/)
  assert.match(log, new RegExp(`session ouverte : ${SESSION_VIVANT}`))

  const [record] = readdirSync(join(dir, 'records'))
  const frames = readFileSync(join(dir, 'records', record), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  const directions = new Set(frames.map((f) => f.direction))
  assert.ok(directions.has('zed→agent') && directions.has('agent→zed'), [...directions].join(', '))
  assert.ok(frames.some((f) => f.frame.includes('trace-moi')))
})

// ===========================================================================
// Relevé au test réel (round 1)
// ===========================================================================

test('le message utilisateur est publié par le shim, qu’il vienne de Zed ou du mobile', async (t) => {
  await boot(t)
  const { zed } = await startShim(t)
  const client = await (await Client.open(t)).hello()
  await subscribe(client, VIVANT)

  // L'agent réel ne renvoie pas le message : sans le shim, le mobile ne verrait que les réponses.
  await zed.prompt('depuis Zed')
  const deZed = await client.until((m) => m.type === 'acp_event' && m.update.content?.text === 'depuis Zed', { label: 'message de Zed' })
  assert.equal(deZed.update.sessionUpdate, 'user_message_chunk')
  assert.deepEqual(deZed.update._meta, { zra: { synthetic: true, origin: 'zed' } })

  client.send({ type: 'send', threadId: VIVANT, text: 'depuis le mobile', mode: 'queue' })
  const duMobile = await client.until((m) => m.type === 'acp_event' && m.update.content?.text === 'depuis le mobile', { label: 'message du mobile' })
  assert.equal(duMobile.update._meta.zra.origin, 'mobile')
  // Rien de fabriqué ne part vers Zed.
  assert.ok(!zed.updates.some((u) => u?.sessionUpdate === 'user_message_chunk'))
})

test('load_history sur un thread live : le ring, sans relancer l’agent, borné par until', async (t) => {
  const daemon = await boot(t)
  daemon.loader.load = () => { throw new Error('un thread live ne doit pas relancer l’agent') }
  const { zed } = await startShim(t)
  const client = await (await Client.open(t)).hello()
  await client.until((m) => m.type === 'threads' && m.threads.find((x) => x.threadId === VIVANT)?.state === 'live', { label: 'live' })
  await zed.prompt('réponds juste OK')
  await wait(150)

  client.clear()
  client.send({ type: 'subscribe', threadId: VIVANT })
  client.send({ type: 'load_history', threadId: VIVANT })
  const history = await client.until((m) => m.type === 'history', { label: 'history' })
  assert.equal(history.complete, true)
  assert.deepEqual(history.updates.filter((u) => u.content).map((u) => u.content.text), ['réponds juste OK', 'reçu : réponds juste OK'])

  // Chaque événement rejoué au subscribe est couvert par l'historique : la PWA l'écarte.
  const replayed = client.of('acp_event')
  assert.ok(replayed.length >= 2)
  assert.ok(replayed.every((e) => typeof e.seq === 'number' && e.seq <= history.until))
})

test('Zed recharge la session : les abonnés repartent d’un historique vide, le ring aussi', async (t) => {
  const daemon = await boot(t)
  const { zed } = await startShim(t)
  const client = await (await Client.open(t)).hello()
  await subscribe(client, VIVANT)
  await zed.prompt('avant rechargement')
  await client.until((m) => m.type === 'acp_event' && m.update.content?.text === 'reçu : avant rechargement', { label: 'tour' })

  client.clear()
  await zed.request('session/load', { sessionId: SESSION_VIVANT, cwd: CWD, mcpServers: [] })
  const reset = await client.until((m) => m.type === 'history', { label: 'historique remis à zéro' })
  assert.deepEqual(reset.updates, [])
  await client.until((m) => m.type === 'acp_event' && m.update.content?.text === 'réponse archivée', { label: 'replay' })

  const ring = daemon.rings.read(VIVANT).map((e) => e.update.content?.text).filter(Boolean)
  assert.deepEqual(ring, ['question archivée', 'réponse archivée'])
})

test('le modèle choisi par Zed (options par défaut au rechargement) remonte au mobile', async (t) => {
  await boot(t)
  const { zed } = await startShim(t)
  const client = await (await Client.open(t)).hello()
  await subscribe(client, VIVANT)
  await client.until((m) => m.type === 'thread_state' && m.threadId === VIVANT && m.currentModelId === 'rapide', { label: 'modèle initial' })

  await zed.request('session/set_config_option', { sessionId: SESSION_VIVANT, configId: 'model', value: 'lent' })
  await client.until((m) => m.type === 'thread_state' && m.threadId === VIVANT && m.currentModelId === 'lent', { label: 'modèle changé par Zed' })
})
