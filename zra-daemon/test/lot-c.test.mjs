// Le lot C sans Zed : ouvrir une session, rouvrir un thread, injecter au clavier.
//
// Le clavier est remplacé par un **faux lanceur** qui, au lieu d'envoyer des
// touches, fait ce que Zed ferait en les recevant : lancer un shim qui ouvre
// une session, recharger un thread, émettre un prompt. Tout le reste est réel —
// daemon, WebSocket, processus shim, agent bouchon — et la preuve attendue est
// la même qu'au test réel : ce que le shim voit passer.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadConfig } from '../config.js'
import { startDaemon } from '../daemon.js'
import { setLevel } from '../log.js'
import { buildCustom } from '../../scripts/make-fixture.mjs'
import { FakeZed } from '../../zra-shim/test/fake-zed.mjs'
import { ZedDriver, expandRecipe, checkRecipe, KeyboardRunner, ZedCli, ZedControlError } from '../zed/driver.js'

setLevel('error')

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const FAKE_AGENT = join(ROOT, 'zra-shim', 'test', 'fake-agent.mjs')
const SHIM = join(ROOT, 'zra-shim', 'index.js')
const FIXTURE = join(HERE, 'fixtures', 'lot-c.sqlite')
const SETTINGS = join(HERE, 'fixtures', 'settings-lot-c.json')

const PORT = 7815
const HOST = '127.0.0.1'
const CWD = ROOT

const VIVANT = 'c0000000000000000000000000000001'
const SESSION_VIVANT = 'lotc-session-live'
const FERME = 'c0000000000000000000000000000002'
const SESSION_FERME = 'lotc-session-closed'

// Le poste déclare un agent ZRA qui enveloppe l'agent bouchon, comme
// `npm run setup` le poserait.
writeFileSync(SETTINGS, JSON.stringify({
  agent_servers: {
    'fake-zra': { type: 'custom', command: process.execPath, args: [SHIM], env: { ZRA_AGENT_ID: 'fake-acp' } },
  },
}))

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

function freshFixture() {
  buildCustom(FIXTURE, [
    { thread_id: VIVANT, session_id: SESSION_VIVANT, agent_id: 'fake-zra', title: 'Thread ouvert dans Zed',
      updated_at: '2026-09-23T10:00:00.000000000+00:00', folder_paths: CWD, folder_paths_order: '0' },
    { thread_id: FERME, session_id: SESSION_FERME, agent_id: 'fake-zra', title: 'Thread fermé',
      updated_at: '2026-09-22T10:00:00.000000000+00:00', folder_paths: CWD, folder_paths_order: '0' },
  ])
}

/** Zed écrit la ligne d'un thread neuf dans son index, avec un temps de retard. */
function indexRow(threadId, sessionId, agentId = 'fake-zra') {
  const db = new DatabaseSync(FIXTURE)
  db.prepare(`insert into sidebar_threads (thread_id, session_id, agent_id, title, updated_at, folder_paths, folder_paths_order)
    values (?, ?, ?, 'Nouveau thread', ?, ?, '0')`)
    .run(Buffer.from(threadId, 'hex'), sessionId, agentId, new Date().toISOString(), CWD)
  db.close()
}

/**
 * Faux clavier : reconnaît la recette à sa première touche et joue la réaction
 * de Zed. `react` reçoit la requête et le texte éventuel.
 */
function fakeKeyboard(react = async () => {}) {
  const calls = []
  return {
    calls,
    async run(req) {
      calls.push(req)
      const first = req.steps?.[0]?.keys
      const recipe = first === 'ctrl+n' ? 'newThread' : first === 'ctrl+o' ? 'openThread' : 'submit'
      const text = req.steps?.find((s) => typeof s.text === 'string')?.text
      await react(recipe, text, req)
      return { ok: true, log: [] }
    },
  }
}

const RECIPES = {
  newThread: [{ keys: 'ctrl+n' }],
  openThread: [{ keys: 'ctrl+o' }, { text: '{title}' }],
  submit: [{ text: '{text}' }, { keys: 'enter' }],
}

/** Fausse CLI de Zed : retient les dossiers qu'on lui demande d'ouvrir. */
function fakeCli() {
  const calls = []
  return { calls, async open(folderPaths) { calls.push(folderPaths) } }
}

async function boot(t, { keyboard, cli = fakeCli(), enabled = true, recipes = RECIPES, injection = 'acp', timeoutMs = 4000 } = {}) {
  freshFixture()
  const config = await loadConfig({
    overrides: {
      port: PORT,
      requireTunnel: false,
      bindLan: false,
      bindTunnel: false,
      zedDb: FIXTURE,
      zedSettings: SETTINGS,
      pollMs: 40,
      zedProbeMs: 60_000,
      logFile: null,
      injection,
      injectConfirmMs: 1500,
      agentCommands: { 'fake-acp': { command: process.execPath, args: [FAKE_AGENT] } },
      zedControl: { enabled, runner: keyboard ?? fakeKeyboard(), cli, recipes, timeoutMs },
    },
  })
  const daemon = await startDaemon(config)
  t.after(() => daemon.close())
  return daemon
}

/** Un shim lancé comme Zed le lancerait. `resume` : réouverture d'un thread existant. */
async function startShim(t, { sessionId, resume = false, env = {}, cwd = CWD } = {}) {
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
  const zed = new FakeZed({ toShim: child.stdin, fromShim: child.stdout })
  if (resume) await zed.resume(sessionId, { cwd })
  else await zed.boot({ cwd })
  return { child, zed }
}

class Client {
  constructor(ws) {
    this.ws = ws
    this.messages = []
    ws.addEventListener('message', (ev) => this.messages.push(JSON.parse(ev.data)))
  }

  static async open(t) {
    const ws = new WebSocket(`ws://${HOST}:${PORT}/ws`)
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true })
      ws.addEventListener('error', rej, { once: true })
    })
    t.after(() => ws.close())
    const client = new Client(ws)
    client.send({ type: 'hello', clientId: 'test-lot-c' })
    await client.until((m) => m.type === 'threads', { label: 'bootstrap' })
    return client
  }

  send(msg) { this.ws.send(JSON.stringify(msg)); return this }

  async until(pred, { timeout = 8000, label = 'condition' } = {}) {
    const t0 = Date.now()
    for (;;) {
      const hit = this.messages.find((m) => pred(m))
      if (hit) return hit
      if (Date.now() - t0 > timeout) {
        throw new Error(`${label} jamais atteinte — reçus : ${this.messages.map((m) => m.type + (m.code ? `:${m.code}` : '')).join(', ')}`)
      }
      await wait(10)
    }
  }

  index(pred) { return this.messages.findIndex(pred) }
}

const live = (threadId) => (m) => m.type === 'threads' && m.threads.find((x) => x.threadId === threadId)?.state === 'live'

// ===========================================================================
// Recettes et pilote
// ===========================================================================

test('recettes : variables substituées dans le texte seulement, étapes validées', () => {
  const steps = expandRecipe([{ keys: 'ctrl+{x}' }, { text: 'agent {agentName} : {text}' }, { wait: 10 }],
    { agentName: 'Claude', text: '{title} littéral' })
  assert.deepEqual(steps, [{ keys: 'ctrl+{x}' }, { text: 'agent Claude : {title} littéral' }, { wait: 10 }])

  assert.throws(() => checkRecipe('x', []), /vide/)
  assert.throws(() => checkRecipe('x', [{ keys: 'a', text: 'b' }]), /étape invalide/)
  assert.throws(() => checkRecipe('x', [{ wait: 60_000 }]), /pause invalide/)
  assert.throws(() => checkRecipe('x', [{ keys: '' }]), /touches invalides/)
})

test('pilote : désactivé par défaut, recette openThread livrée', async () => {
  const keyboard = fakeKeyboard()
  const off = new ZedDriver({ runner: keyboard })
  await assert.rejects(() => off.newThread({ id: 'a' }), (e) => e instanceof ZedControlError && e.code === 'zed_control_disabled')
  assert.equal(keyboard.calls.length, 0, 'aucune touche demandée')

  const on = new ZedDriver({ runner: keyboard, enabled: true })
  assert.equal(on.has('openThread'), true)
  await on.openThread({ title: 'Mon thread' })
  assert.ok(keyboard.calls.at(-1).steps.some((s) => s.text === 'Mon thread'), 'titre tapé dans le filtre')
  await on.submit('bonjour\nà toi')
  assert.deepEqual(keyboard.calls.at(-1).steps.find((s) => s.text), { text: 'bonjour\nà toi' })
})

test('lanceur clavier : une requête à la fois', async () => {
  const runner = new KeyboardRunner()
  const order = []
  runner.exec = async (req) => {
    order.push(`début ${req.n}`)
    await wait(30)
    order.push(`fin ${req.n}`)
    return { ok: true }
  }
  await Promise.all([runner.run({ n: 1, dryRun: true }), runner.run({ n: 2, dryRun: true })])
  assert.deepEqual(order, ['début 1', 'fin 1', 'début 2', 'fin 2'])
})

test('sous node --test : ni frappe réelle, ni CLI de Zed, ni zra.config.json du poste', async () => {
  const runner = new KeyboardRunner()
  runner.exec = async () => assert.fail('clavier réel atteint')
  await assert.rejects(() => runner.run({ op: 'run', steps: [{ keys: 'enter' }] }), /refusé sous node --test/)
  await assert.rejects(() => new ZedCli({ command: 'zed-imaginaire' }).open(['C:/x']), /refusé sous node --test/)
  const config = await loadConfig()
  assert.equal(config.zedControl.enabled, false, 'défauts seuls, quel que soit le zra.config.json')
})

test('keyboard.ps1 : recette résolue en simulation, touche inconnue refusée avant toute frappe', { skip: process.platform !== 'win32' }, async () => {
  const runner = new KeyboardRunner({ timeoutMs: 60_000 })
  await assert.rejects(
    () => runner.run({ op: 'run', dryRun: true, steps: [{ keys: 'ctrl+enter' }, { keys: 'ctrl+touche-imaginaire' }] }),
    /touche inconnue/,
  )
  // Zed ouvert ou non sur la machine de test : les deux issues sont légitimes,
  // mais aucune ne doit envoyer de touche (dryRun).
  try {
    const res = await runner.run({ op: 'run', dryRun: true, steps: [{ keys: 'ctrl+shift+p' }, { text: 'é\nà' }, { wait: 1 }] })
    assert.deepEqual(res.log.slice(1), ['touches ctrl+shift+p', 'texte (3 caractère(s))', 'attente 1 ms'])
  } catch (err) {
    assert.match(err.message, /aucune fenêtre Zed/)
  }
})

// ===========================================================================
// new_thread (spec §6.7)
// ===========================================================================

test('new_thread désactivé : new_thread_failed explicite, aucune touche', async (t) => {
  const keyboard = fakeKeyboard()
  await boot(t, { enabled: false, keyboard })
  const client = await Client.open(t)
  client.send({ type: 'new_thread', agentId: 'fake-zra' })
  const err = await client.until((m) => m.type === 'error', { label: 'erreur' })
  assert.equal(err.code, 'new_thread_failed')
  assert.match(err.message, /pilotage de Zed désactivé/)
  assert.equal(keyboard.calls.length, 0)
})

test('machine.agents : l’entrée ZRA est nommée d’après l’agent enveloppé', async (t) => {
  await boot(t)
  const client = await Client.open(t)
  const machine = await client.until((m) => m.type === 'machine', { label: 'machine' })
  assert.deepEqual(machine.agents, [{ id: 'fake-zra', name: 'Fake (ZRA)', kind: 'custom', wraps: 'fake-acp' }])
})

test('new_thread : Zed ouvre la session, threads puis thread_created', async (t) => {
  const NOUVEAU = 'c00000000000000000000000000000aa'
  const keyboard = fakeKeyboard(async (recipe) => {
    if (recipe !== 'newThread') return
    // Réaction de Zed : un shim s'ouvre avec une session neuve, puis la ligne
    // arrive dans l'index un peu plus tard.
    setTimeout(async () => {
      await startShim(t, { sessionId: 'lotc-session-new' })
      setTimeout(() => indexRow(NOUVEAU, 'lotc-session-new'), 150)
    }, 50)
  })
  await boot(t, { keyboard })
  const client = await Client.open(t)

  client.send({ type: 'new_thread', agentId: 'fake-zra' })
  const created = await client.until((m) => m.type === 'thread_created', { label: 'thread_created' })
  assert.equal(created.threadId, NOUVEAU)
  assert.equal(created.agentId, 'fake-zra')

  // Protocole §4 : un `threads` qui le contient **avant** `thread_created`.
  const at = client.index((m) => m.type === 'thread_created')
  const threadsBefore = client.messages.slice(0, at).filter((m) => m.type === 'threads')
  assert.ok(threadsBefore.at(-1).threads.some((x) => x.threadId === NOUVEAU && x.state === 'live'))
  assert.equal(keyboard.calls.length, 1)
})

test('new_thread : Zed écrit le thread sans session_id (avant le 1er message), ZRA le rattache', async (t) => {
  const NOUVEAU = 'c00000000000000000000000000000ae'
  const keyboard = fakeKeyboard(async (recipe) => {
    if (recipe !== 'newThread') return
    // Relevé sur le poste : la ligne arrive tout de suite, session_id NULL.
    setTimeout(async () => {
      indexRow(NOUVEAU, null)
      await startShim(t, { sessionId: 'lotc-session-brouillon' })
    }, 30)
  })
  const daemon = await boot(t, { keyboard })
  const client = await Client.open(t)

  client.send({ type: 'new_thread', agentId: 'fake-zra' })
  const created = await client.until((m) => m.type === 'thread_created', { label: 'thread_created' })
  assert.equal(created.threadId, NOUVEAU)
  const listed = client.messages.slice(0, client.index((m) => m.type === 'thread_created')).filter((m) => m.type === 'threads').at(-1)
  const row = listed.threads.find((x) => x.threadId === NOUVEAU)
  assert.equal(row.state, 'live', 'cliquable, pas grisé')

  // Premier message : Zed écrit enfin le session_id, le même.
  const db = new DatabaseSync(FIXTURE)
  db.prepare('update sidebar_threads set session_id = ? where thread_id = ?').run('lotc-session-brouillon', Buffer.from(NOUVEAU, 'hex'))
  db.close()
  daemon.threads.refresh()
  assert.equal(daemon.threads.get(NOUVEAU).sessionId, 'lotc-session-brouillon')
  assert.equal(daemon.threads.provisional.has(NOUVEAU), false, 'rattachement oublié : Zed a la main')
})

test('new_thread dans un projet : Zed ouvre ses dossiers, la recette vise sa fenêtre', async (t) => {
  const NOUVEAU = 'c00000000000000000000000000000ab'
  const keyboard = fakeKeyboard(async (recipe) => {
    if (recipe !== 'newThread') return
    setTimeout(async () => {
      await startShim(t, { sessionId: 'lotc-session-projet' })
      setTimeout(() => indexRow(NOUVEAU, 'lotc-session-projet'), 100)
    }, 30)
  })
  const cli = fakeCli()
  await boot(t, { keyboard, cli })
  const client = await Client.open(t)

  // Casse et séparateurs libres : Windows ne les distingue pas.
  client.send({ type: 'new_thread', agentId: 'fake-zra', folderPaths: [CWD.replace(/\\/g, '/').toUpperCase()] })
  const created = await client.until((m) => m.type === 'thread_created', { label: 'thread_created' })
  assert.equal(created.threadId, NOUVEAU)
  assert.deepEqual(cli.calls, [[CWD]], 'la CLI ouvre les dossiers tels que l’index les écrit')
  assert.equal(keyboard.calls[0].project, 'zra', 'la recette vise la fenêtre du projet')
  assert.equal(keyboard.calls[0].window, undefined)

  // Même dossier : aucune alerte dans le fil.
  client.send({ type: 'subscribe', threadId: NOUVEAU })
  await client.until((m) => m.type === 'thread_state' && m.threadId === NOUVEAU, { label: 'abonnement' })
  await wait(100)
  assert.ok(!client.messages.some((m) => m.type === 'acp_event' && m.update?.sessionUpdate === 'zra/notice'))
})

test('new_thread : un projet inconnu du poste est refusé, sans une touche', async (t) => {
  const keyboard = fakeKeyboard()
  const cli = fakeCli()
  await boot(t, { keyboard, cli })
  const client = await Client.open(t)
  client.send({ type: 'new_thread', agentId: 'fake-zra', folderPaths: ['C:/Windows/System32'] })
  const err = await client.until((m) => m.type === 'error', { label: 'erreur' })
  assert.equal(err.code, 'new_thread_failed')
  assert.match(err.message, /projet inconnu/)
  assert.equal(keyboard.calls.length, 0)
  assert.equal(cli.calls.length, 0)
})

test('new_thread : session ouverte dans un autre dossier => le fil le signale', async (t) => {
  const NOUVEAU = 'c00000000000000000000000000000ac'
  const AILLEURS = join(ROOT, 'zra-client')
  const keyboard = fakeKeyboard(async (recipe) => {
    if (recipe !== 'newThread') return
    setTimeout(async () => {
      await startShim(t, { sessionId: 'lotc-session-ailleurs', cwd: AILLEURS })
      setTimeout(() => indexRow(NOUVEAU, 'lotc-session-ailleurs'), 100)
    }, 30)
  })
  await boot(t, { keyboard })
  const client = await Client.open(t)
  client.send({ type: 'new_thread', agentId: 'fake-zra', folderPaths: [CWD] })
  await client.until((m) => m.type === 'thread_created', { label: 'thread_created' })
  client.send({ type: 'subscribe', threadId: NOUVEAU })
  const notice = await client.until((m) => m.type === 'acp_event' && m.update?.sessionUpdate === 'zra/notice', { label: 'alerte' })
  assert.match(notice.update.text, /zra-client/)
})

test('new_thread : aucune réaction de Zed => new_thread_failed au timeout', async (t) => {
  await boot(t, { timeoutMs: 400 })
  const client = await Client.open(t)
  client.send({ type: 'new_thread', agentId: 'fake-zra' })
  const err = await client.until((m) => m.type === 'error', { label: 'erreur' })
  assert.equal(err.code, 'new_thread_failed')
  assert.match(err.message, /aucune session/)
})

test('new_thread : Zed ouvre un autre agent (le dernier utilisé) => échec immédiat et explicite', async (t) => {
  const keyboard = fakeKeyboard(async (recipe) => {
    // Zed ouvre le thread avec son dernier agent, qui ne passe pas par ZRA : aucun shim, une ligne d'un autre agent.
    if (recipe === 'newThread') setTimeout(() => indexRow('c00000000000000000000000000000ad', 'lotc-autre-agent', 'fake-acp'), 30)
  })
  await boot(t, { keyboard, timeoutMs: 20_000 })
  const client = await Client.open(t)
  const t0 = Date.now()
  client.send({ type: 'new_thread', agentId: 'fake-zra' })
  const err = await client.until((m) => m.type === 'error', { label: 'erreur' })
  assert.equal(err.code, 'new_thread_failed')
  assert.match(err.message, /« fake-acp »/)
  assert.ok(Date.now() - t0 < 10_000, 'sans attendre le délai')
})

test('new_thread : session ouverte mais jamais indexée => raison explicite', async (t) => {
  const keyboard = fakeKeyboard(async (recipe) => {
    if (recipe === 'newThread') setTimeout(() => startShim(t, { sessionId: 'lotc-jamais-indexee' }), 20)
  })
  await boot(t, { keyboard, timeoutMs: 4000 }) // large : un shim lancé sous charge met du temps à s’annoncer
  const client = await Client.open(t)
  client.send({ type: 'new_thread', agentId: 'fake-zra' })
  const err = await client.until((m) => m.type === 'error', { label: 'erreur' })
  assert.equal(err.code, 'new_thread_failed')
  assert.match(err.message, /pas encore dans son index/)
})

test('new_thread : agent inconnu du poste', async (t) => {
  await boot(t)
  const client = await Client.open(t)
  client.send({ type: 'new_thread', agentId: 'inconnu' })
  const err = await client.until((m) => m.type === 'error', { label: 'erreur' })
  assert.equal(err.code, 'new_thread_failed')
  assert.match(err.message, /absent du registry/)
})

// ===========================================================================
// Répondre à un thread fermé (spec §6.3)
// ===========================================================================

test('thread fermé : Zed le rouvre, le shim le recharge, le message part par ACP', async (t) => {
  const keyboard = fakeKeyboard(async (recipe, text) => {
    if (recipe !== 'openThread') return
    assert.equal(text, 'Thread fermé', 'la recette reçoit le titre du thread')
    setTimeout(() => startShim(t, { sessionId: SESSION_FERME, resume: true }), 30)
  })
  const cli = fakeCli()
  await boot(t, { keyboard, cli })
  const client = await Client.open(t)
  client.send({ type: 'subscribe', threadId: FERME })

  client.send({ type: 'send', threadId: FERME, text: 'on reprend ?', mode: 'queue' })
  await client.until(live(FERME), { label: 'thread rouvert' })
  await client.until((m) => m.type === 'acp_event' && m.update.content?.text === 'reçu : on reprend ?', { label: 'réponse' })
  assert.equal(client.messages.filter((m) => m.type === 'error').length, 0)
  // Le projet du thread est ouvert (ou ramené devant) avant la recette, qui vise sa fenêtre.
  assert.deepEqual(cli.calls, [[CWD]])
  assert.equal(keyboard.calls[0].project, 'zra')
})

test('thread fermé sans recette openThread : inject_failed, aucune touche', async (t) => {
  const keyboard = fakeKeyboard()
  await boot(t, { keyboard, recipes: { ...RECIPES, openThread: null } })
  const client = await Client.open(t)
  client.send({ type: 'send', threadId: FERME, text: 'coucou', mode: 'queue' })
  const err = await client.until((m) => m.type === 'error', { label: 'erreur' })
  assert.equal(err.code, 'inject_failed')
  assert.match(err.message, /pas ouvert dans Zed/)
  assert.equal(keyboard.calls.length, 0)
})

test('thread fermé : Zed ne le rouvre pas => inject_failed au timeout', async (t) => {
  await boot(t, { timeoutMs: 400 })
  const client = await Client.open(t)
  client.send({ type: 'send', threadId: FERME, text: 'coucou', mode: 'queue' })
  const err = await client.until((m) => m.type === 'error', { label: 'erreur' })
  assert.equal(err.code, 'inject_failed')
  assert.match(err.message, /n'a pas rouvert/)
})

// ===========================================================================
// Backend uia (spec §6.2) et auto
// ===========================================================================

test('uia : Zed émet le message tapé, le shim en apporte la preuve', async (t) => {
  let zed
  const keyboard = fakeKeyboard(async (recipe, text) => {
    // Zed reçoit la frappe et envoie le prompt lui-même.
    if (recipe === 'submit') zed.prompt(text)
  })
  await boot(t, { keyboard, injection: 'uia' });
  ({ zed } = await startShim(t, { sessionId: SESSION_VIVANT }))
  const client = await Client.open(t)
  await client.until(live(VIVANT), { label: 'live' })
  client.send({ type: 'subscribe', threadId: VIVANT })

  client.send({ type: 'send', threadId: VIVANT, text: 'tapé au clavier', mode: 'queue' })
  await client.until((m) => m.type === 'acp_event' && m.update.content?.text === 'reçu : tapé au clavier', { label: 'réponse' })
  // Le prompt a bien été émis par Zed (id numérique), pas injecté par le shim.
  // La réponse lui parvient par son propre tuyau, sans ordre garanti avec le mobile.
  for (let i = 0; i < 200 && !zed.messages.some((m) => m.result && m.id === 3); i++) await wait(10)
  assert.ok(zed.messages.some((m) => m.result && m.id === 3), 'réponse au prompt de Zed')
  assert.equal(client.messages.filter((m) => m.type === 'error').length, 0)
  assert.deepEqual(keyboard.calls.map((c) => c.steps[0].keys ?? 'texte'), ['ctrl+o', 'texte'])
})

test('uia : Zed ne réagit pas => inject_failed, rien ne passe pour un succès', async (t) => {
  await boot(t, { injection: 'uia' })
  await startShim(t, { sessionId: SESSION_VIVANT })
  const client = await Client.open(t)
  await client.until(live(VIVANT), { label: 'live' })
  client.send({ type: 'send', threadId: VIVANT, text: 'perdu', mode: 'queue' })
  const err = await client.until((m) => m.type === 'error', { label: 'erreur' })
  assert.equal(err.code, 'inject_failed')
  assert.match(err.message, /n'a pas émis le message/)
})

test('uia sans recette openThread : on ne tape pas dans un thread que ZRA n’a pas ouvert', async (t) => {
  const keyboard = fakeKeyboard()
  await boot(t, { keyboard, injection: 'uia', recipes: { ...RECIPES, openThread: null } })
  await startShim(t, { sessionId: SESSION_VIVANT })
  const client = await Client.open(t)
  await client.until(live(VIVANT), { label: 'live' })
  client.send({ type: 'send', threadId: VIVANT, text: 'où ça ?', mode: 'queue' })
  const err = await client.until((m) => m.type === 'error', { label: 'erreur' })
  assert.match(err.message, /ne sait pas amener ce thread au premier plan/)
  assert.equal(keyboard.calls.length, 0)
})

test('auto : l’agent refuse le prompt injecté (🔴1), repli clavier transparent', async (t) => {
  let zed
  const keyboard = fakeKeyboard(async (recipe, text) => {
    if (recipe === 'submit') zed.prompt(text)
  })
  await boot(t, { keyboard, injection: 'auto' });
  ({ zed } = await startShim(t, { sessionId: SESSION_VIVANT, env: { ZRA_FAKE_REFUSE_INJECTED: '1' } }))
  const client = await Client.open(t)
  await client.until(live(VIVANT), { label: 'live' })
  client.send({ type: 'subscribe', threadId: VIVANT })

  client.send({ type: 'send', threadId: VIVANT, text: 'par le clavier', mode: 'queue' })
  await client.until((m) => m.type === 'acp_event' && m.update.content?.text === 'reçu : par le clavier', { label: 'réponse' })
  assert.equal(client.messages.filter((m) => m.type === 'error').length, 0)
  // Pas d'avis « refusé » en double : c'est le repli qui a répondu.
  assert.ok(!client.messages.some((m) => m.type === 'acp_event' && /refusé/.test(m.update.text ?? '')))
})

test('auto : l’agent accepte, aucune touche envoyée', async (t) => {
  const keyboard = fakeKeyboard()
  await boot(t, { keyboard, injection: 'auto' })
  await startShim(t, { sessionId: SESSION_VIVANT })
  const client = await Client.open(t)
  await client.until(live(VIVANT), { label: 'live' })
  client.send({ type: 'subscribe', threadId: VIVANT })
  client.send({ type: 'send', threadId: VIVANT, text: 'par ACP', mode: 'queue' })
  await client.until((m) => m.type === 'acp_event' && m.update.content?.text === 'reçu : par ACP', { label: 'réponse' })
  assert.equal(keyboard.calls.length, 0)
})

test('acp : un refus de l’agent arrive en avis inject_failed (risque 🔴1 visible au test réel)', async (t) => {
  await boot(t)
  await startShim(t, { sessionId: SESSION_VIVANT, env: { ZRA_FAKE_REFUSE_INJECTED: '1' } })
  const client = await Client.open(t)
  await client.until(live(VIVANT), { label: 'live' })
  client.send({ type: 'subscribe', threadId: VIVANT })
  client.send({ type: 'send', threadId: VIVANT, text: 'refusé', mode: 'queue' })
  const notice = await client.until(
    (m) => m.type === 'acp_event' && m.update.sessionUpdate === 'zra/notice' && /refusé/.test(m.update.text),
    { label: 'avis de refus' },
  )
  assert.match(notice.update.text, /prompt non émis par le client/)
})
