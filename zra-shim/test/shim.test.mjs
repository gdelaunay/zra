// Le shim, entre un faux Zed et un vrai agent bouchon — spec §10.
//
// Lisible comme une check-list du §3.1 et du §6 : transparence du proxy, tour et
// file d'attente, injection, permissions et leur course, terminaux, options.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createShim } from '../index.js'
import { createFramer, parseFrame } from '../framing.js'
import { pipeFrames } from '../proxy.js'
import { projectOptions } from '../acp.js'
import { createRecorder } from '../record.js'
import { FakeZed } from './fake-zed.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const FAKE_AGENT = join(HERE, 'fake-agent.mjs')

/** Monte un shim entre un faux Zed (en mémoire) et l'agent bouchon (un vrai processus). */
async function boot(t, { zed = {}, env = {} } = {}) {
  const agent = spawn(process.execPath, [FAKE_AGENT], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  })

  const zedIn = new PassThrough()   // faux Zed -> shim
  const zedOut = new PassThrough()  // shim -> faux Zed

  const shim = createShim({
    zedIn,
    zedOut,
    agentIn: agent.stdin,
    agentOut: agent.stdout,
    agentId: 'fake-acp',
    daemonUrl: null,
    cancelTimeoutMs: 2000,
  })

  const fakeZed = new FakeZed({ toShim: zedIn, fromShim: zedOut, ...zed })

  t.after(() => {
    shim.stop()
    agent.kill()
  })

  await fakeZed.boot({ cwd: process.cwd() })
  return { shim, bridge: shim.bridge, zed: fakeZed, agent }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

/** Attend qu'une condition soit vraie, ou échoue avec un message parlant. */
async function until(pred, { timeout = 5000, label = 'condition' } = {}) {
  const t0 = Date.now()
  for (;;) {
    const value = pred()
    if (value) return value
    if (Date.now() - t0 > timeout) throw new Error(`${label} jamais atteinte`)
    await wait(10)
  }
}

// ---------------------------------------------------------------------------
// Transparence — la règle qui prime sur tout (spec §3.1)
// ---------------------------------------------------------------------------

test('framing : les octets ressortent tels quels, séparateur compris', () => {
  const framer = createFramer()
  const corpus = [
    '{"jsonrpc":"2.0","id":1,"method":"initialize"}\n',
    '{"champ_inconnu":{"imbriqué":[1,2,3]},"accents":"é à ü 😀"}\n',
    '{"crlf":true}\r\n',
  ]
  const frames = framer.push(Buffer.from(corpus.join(''), 'utf8'))
  assert.equal(frames.length, 3)
  assert.equal(Buffer.concat(frames).toString('utf8'), corpus.join(''))
  // Un CRLF n'est pas normalisé : on ne touche à rien.
  assert.ok(frames[2].toString('utf8').endsWith('\r\n'))
})

test('framing : une trame coupée en deux morceaux se recolle sans perte', () => {
  const framer = createFramer()
  assert.deepEqual(framer.push(Buffer.from('{"a":1', 'utf8')), [])
  const frames = framer.push(Buffer.from('23}\n{"b":2}\n', 'utf8'))
  assert.equal(frames.map((f) => f.toString()).join(''), '{"a":123}\n{"b":2}\n')
})

test('proxy : octets entrants ≡ octets sortants, même illisibles (spec §10.5)', async () => {
  const source = new PassThrough()
  const sink = new PassThrough()
  const seen = []
  pipeFrames({ source, sink, observe: (msg) => { seen.push(msg) } })

  const chunks = []
  sink.on('data', (c) => chunks.push(c))

  const corpus = '{"ok":1}\nceci n\'est pas du JSON\n{"encore":true}\n'
  source.write(Buffer.from(corpus, 'utf8'))
  source.end()
  await wait(30)

  assert.equal(Buffer.concat(chunks).toString('utf8'), corpus)
  // La trame illisible est relayée sans être observée : `null`, jamais une erreur.
  assert.deepEqual(seen.map((m) => (m ? 'lu' : 'illisible')), ['lu', 'illisible', 'lu'])
})

test('proxy : un observateur qui jette laisse quand même passer la trame (fail-open)', async () => {
  const source = new PassThrough()
  const sink = new PassThrough()
  const errors = []
  pipeFrames({
    source,
    sink,
    observe: () => { throw new Error('boum') },
    onError: (err) => errors.push(err.message),
  })
  const chunks = []
  sink.on('data', (c) => chunks.push(c))

  source.write('{"a":1}\n')
  await wait(20)
  assert.equal(Buffer.concat(chunks).toString(), '{"a":1}\n')
  assert.deepEqual(errors, ['boum'])
})

test('projection des options : modes ACP et sélecteur de modèle → contrat PWA', () => {
  const p = projectOptions({
    modes: { currentModeId: 'plan', availableModes: [{ id: 'plan', name: 'Plan' }] },
    configOptions: [{
      id: 'model', type: 'select', category: 'model', currentValue: 'b',
      options: [{ group: 'g', name: 'Groupe', options: [{ value: 'a', name: 'A' }, { value: 'b', name: 'B' }] }],
    }],
  })
  assert.deepEqual(p.modes, [{ id: 'plan', name: 'Plan' }])
  assert.equal(p.currentModeId, 'plan')
  // Les valeurs groupées sont aplaties : la PWA n'affiche qu'une liste.
  assert.deepEqual(p.models, [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }])
  assert.equal(p.currentModelId, 'b')
})

// ---------------------------------------------------------------------------
// Observation
// ---------------------------------------------------------------------------

test("l'initialize et la session sont captés au passage (spec §3.1)", async (t) => {
  const { bridge, zed } = await boot(t)
  assert.equal(bridge.protocolVersion, 1)
  assert.equal(bridge.agentCapabilities.loadSession, true)
  assert.ok(bridge.sessions.has(zed.sessionId))

  const st = bridge.sessions.get(zed.sessionId)
  assert.equal(st.cwd, process.cwd())
  assert.deepEqual(st.modes, [{ id: 'default', name: 'Normal' }, { id: 'plan', name: 'Plan' }])
  assert.deepEqual(st.models, [{ id: 'rapide', name: 'Rapide' }, { id: 'lent', name: 'Appliqué' }])
})

test('un prompt de Zed fait passer le tour de idle à busy, puis revient', async (t) => {
  const { bridge, zed } = await boot(t)
  const seen = []
  bridge.sessions.on('change', (id) => seen.push(bridge.sessions.get(id).turn))

  const done = zed.prompt('lent: un long tour')
  await until(() => bridge.sessions.get(zed.sessionId).turn === 'busy', { label: 'busy' })
  await done
  await until(() => bridge.sessions.get(zed.sessionId).turn === 'idle', { label: 'idle' })
  assert.deepEqual(seen.slice(0, 2), ['busy', 'idle'])
})

test('les session/update sont republiées verbatim, sans être réécrites', async (t) => {
  const { bridge, zed } = await boot(t)
  const published = []
  bridge.on('update', (e) => published.push(e))

  await zed.prompt('bonjour')
  const agentChunk = published.find((e) => e.update.sessionUpdate === 'agent_message_chunk')
  assert.deepEqual(agentChunk.update, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'reçu : bonjour' },
  })
  // Et Zed les a reçues aussi : le shim ne détourne rien.
  assert.ok(zed.updates.some((u) => u.sessionUpdate === 'agent_message_chunk'))
})

// ---------------------------------------------------------------------------
// Injection (spec §6.1)
// ---------------------------------------------------------------------------

test('un prompt injecté part vers l’agent sans que Zed voie la requête', async (t) => {
  const { bridge, zed } = await boot(t)
  const before = zed.messages.length

  await bridge.prompt(zed.sessionId, 'salut depuis le mobile')
  await until(
    () => zed.updates.some((u) => u.content?.text === 'reçu : salut depuis le mobile'),
    { label: 'réponse de l’agent' },
  )

  // Zed reçoit la réponse de l'agent (notifications), mais aucune réponse à une
  // requête qu'il n'a pas émise : notre `id` `zra-N` ne lui parvient jamais.
  const nouveaux = zed.messages.slice(before)
  assert.ok(nouveaux.every((m) => m.method !== undefined || m.id === undefined || String(m.id).startsWith('zra-') === false))
  assert.ok(!zed.messages.some((m) => typeof m.id === 'string' && m.id.startsWith('zra-')))
})

test('mode queue : pendant un tour, le message est mis en file puis dépilé', async (t) => {
  const { bridge, zed } = await boot(t)
  const turn = zed.prompt('lent: tour occupé')
  await until(() => bridge.sessions.get(zed.sessionId).turn === 'busy', { label: 'busy' })

  const res = await bridge.prompt(zed.sessionId, 'à la suite', 'queue')
  assert.equal(res.queued, true)
  assert.equal(bridge.sessions.get(zed.sessionId).queue.length, 1)

  await turn
  // Fin de tour => la file part toute seule (spec §6.4).
  await until(
    () => zed.updates.some((u) => u.content?.text === 'reçu : à la suite'),
    { label: 'dépilage' },
  )
  assert.equal(bridge.sessions.get(zed.sessionId).queue.length, 0)
})

test('cancel_queued retire une entrée, un queueId inconnu est sans effet', async (t) => {
  const { bridge, zed } = await boot(t)
  const turn = zed.prompt('lent: tour occupé')
  await until(() => bridge.sessions.get(zed.sessionId).turn === 'busy', { label: 'busy' })

  const { queueId } = await bridge.prompt(zed.sessionId, 'à annuler', 'queue')
  assert.deepEqual(bridge.cancelQueued(zed.sessionId, 'inconnu'), { removed: false })
  assert.deepEqual(bridge.cancelQueued(zed.sessionId, queueId), { removed: true })
  assert.equal(bridge.sessions.get(zed.sessionId).queue.length, 0)
  await turn
})

test('interrupt coupe le tour et rend la main sur l’acquittement', async (t) => {
  const { bridge, zed } = await boot(t)
  const turn = zed.prompt('lent: tour à couper')
  await until(() => bridge.sessions.get(zed.sessionId).turn === 'busy', { label: 'busy' })

  assert.deepEqual(await bridge.cancel(zed.sessionId), { interrupted: true })
  assert.equal(bridge.sessions.get(zed.sessionId).turn, 'idle')
  assert.equal((await turn).stopReason, 'cancelled')

  // Tour déjà à l'arrêt : ne rien faire (protocole §3 `interrupt`).
  assert.deepEqual(await bridge.cancel(zed.sessionId), { interrupted: false })
})

test('mode interrupt : on coupe, puis le message part', async (t) => {
  const { bridge, zed } = await boot(t)
  const turn = zed.prompt('lent: tour à couper')
  await until(() => bridge.sessions.get(zed.sessionId).turn === 'busy', { label: 'busy' })

  await bridge.prompt(zed.sessionId, 'stop et envoie', 'interrupt')
  assert.equal((await turn).stopReason, 'cancelled')
  await until(
    () => zed.updates.some((u) => u.content?.text === 'reçu : stop et envoie'),
    { label: 'envoi après interruption' },
  )
})

test('set_option : appliqué tout de suite au repos, différé pendant un tour', async (t) => {
  const { bridge, zed } = await boot(t)

  assert.deepEqual(await bridge.setOption(zed.sessionId, 'mode', 'plan'), { deferred: false })
  await until(
    () => zed.updates.some((u) => u.sessionUpdate === 'current_mode_update' && u.currentModeId === 'plan'),
    { label: 'changement de mode' },
  )

  const turn = zed.prompt('lent: tour occupé')
  await until(() => bridge.sessions.get(zed.sessionId).turn === 'busy', { label: 'busy' })
  assert.deepEqual(await bridge.setOption(zed.sessionId, 'model', 'lent'), { deferred: true })
  await turn
  // Retour au repos => l'option différée est appliquée (spec §6.5).
  await until(() => bridge.sessions.get(zed.sessionId).currentModelId === 'lent', { label: 'option différée' })
})

// ---------------------------------------------------------------------------
// Permissions (spec §6.6)
// ---------------------------------------------------------------------------

test('permission : le mobile répond à la place de Zed, qui n’a pas encore cliqué', async (t) => {
  const { bridge, zed } = await boot(t, { zed: { answerPermission: null } })
  const demandes = []
  bridge.on('permission', (p) => demandes.push(p))
  const resolutions = []
  bridge.on('permission_resolved', (r) => resolutions.push(r))

  const turn = zed.prompt('permission: écrire un fichier')
  const demande = await until(() => demandes[0], { label: 'demande de permission' })

  // La demande est publiée telle quelle : `toolCall` + `options` de l'agent.
  assert.equal(demande.options.length, 2)
  assert.deepEqual(demande.options.map((o) => o.optionId), ['allow', 'reject'])

  const res = bridge.respondPermission(zed.sessionId, demande.requestId, 'allow')
  assert.deepEqual(res, { by: 'mobile', optionId: 'allow', optionName: 'Autoriser' })
  assert.deepEqual(resolutions, [{
    sessionId: zed.sessionId, requestId: demande.requestId,
    optionId: 'allow', optionName: 'Autoriser', by: 'mobile',
  }])

  await turn
  const fin = zed.updates.find((u) => u.sessionUpdate === 'tool_call_update')
  assert.equal(fin.status, 'completed')
})

test('permission : le poste gagne la course, la réponse mobile est refusée', async (t) => {
  const { bridge, zed } = await boot(t, { zed: { answerPermission: 'reject' } })
  const demandes = []
  bridge.on('permission', (p) => demandes.push(p))
  const resolutions = []
  bridge.on('permission_resolved', (r) => resolutions.push(r))

  const turn = zed.prompt('permission: écrire un fichier')
  const demande = await until(() => demandes[0], { label: 'demande de permission' })
  await until(() => resolutions[0], { label: 'arbitrage du poste' })

  assert.equal(resolutions[0].by, 'desktop')
  assert.equal(resolutions[0].optionId, 'reject')
  assert.throws(
    () => bridge.respondPermission(zed.sessionId, demande.requestId, 'allow'),
    /permission_expired|déjà tranchée/,
  )
  await turn
})

test('permission : la réponse tardive du poste est avalée, l’agent n’en voit qu’une', async (t) => {
  const { bridge, zed, agent } = await boot(t, { zed: { answerPermission: 'reject', permissionDelayMs: 300 } })
  const erreurs = []
  agent.stderr.on('data', (c) => erreurs.push(c.toString()))
  const demandes = []
  bridge.on('permission', (p) => demandes.push(p))

  const turn = zed.prompt('permission: écrire un fichier')
  const demande = await until(() => demandes[0], { label: 'demande de permission' })

  bridge.respondPermission(zed.sessionId, demande.requestId, 'allow')
  await turn
  await wait(400) // laisse le temps à la réponse tardive du poste d'arriver

  // C'est le mobile qui a tranché, et l'agent n'a pas bronché.
  assert.equal(zed.updates.find((u) => u.sessionUpdate === 'tool_call_update').status, 'completed')
  assert.equal(erreurs.join(''), '')
})

test('permission : une option que l’agent n’a pas proposée est refusée', async (t) => {
  const { bridge, zed } = await boot(t, { zed: { answerPermission: null } })
  const demandes = []
  bridge.on('permission', (p) => demandes.push(p))
  const turn = zed.prompt('permission: écrire un fichier')
  const demande = await until(() => demandes[0], { label: 'demande de permission' })

  assert.throws(() => bridge.respondPermission(zed.sessionId, demande.requestId, 'inventée'), /proposée/)
  bridge.respondPermission(zed.sessionId, demande.requestId, 'reject')
  await turn
})

// ---------------------------------------------------------------------------
// Terminaux (protocole §5)
// ---------------------------------------------------------------------------

test('la sortie d’un terminal devient un zra/terminal_output', async (t) => {
  const { bridge, zed } = await boot(t)
  const published = []
  bridge.on('update', (e) => published.push(e.update))

  await zed.prompt('terminal: echo')
  const sortie = await until(
    () => published.find((u) => u.sessionUpdate === 'zra/terminal_output'),
    { label: 'sortie de terminal' },
  )
  assert.equal(sortie.terminalId, 'term-1')
  assert.equal(sortie.output, 'bonjour\n')
  assert.deepEqual(sortie.exitStatus, { exitCode: 0 })
})

// ---------------------------------------------------------------------------
// Agent sans loadSession (risque 🟠2)
// ---------------------------------------------------------------------------

test('un agent sans loadSession est capté comme tel', async (t) => {
  const { bridge } = await boot(t, { env: { ZRA_FAKE_NO_LOAD_SESSION: '1' } })
  assert.notEqual(bridge.agentCapabilities.loadSession, true)
})

// ---------------------------------------------------------------------------
// Enregistrement des trames (spec §10.3)
// ---------------------------------------------------------------------------

test('ZRA_RECORD : les trames des deux sens finissent dans un JSONL', async (t) => {
  const dir = join(HERE, 'fixtures-record')
  rmSync(dir, { recursive: true, force: true })
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const recorder = createRecorder({ enabled: true, agentId: 'fake-acp', dir })
  recorder.write('zed→agent', Buffer.from('{"id":1,"method":"initialize"}\n'))
  recorder.write('agent→zed', Buffer.from('{"id":1,"result":{}}\n'))
  recorder.close()
  await wait(50)

  const lignes = readFileSync(recorder.file, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.deepEqual(lignes.map((l) => l.direction), ['zed→agent', 'agent→zed'])
  assert.equal(lignes[0].frame, '{"id":1,"method":"initialize"}')
  assert.ok(lignes[0].at)
})

test('sans ZRA_RECORD, l’enregistreur ne touche à rien', () => {
  const recorder = createRecorder({ enabled: false, agentId: 'fake-acp' })
  assert.equal(recorder.file, null)
  recorder.write('zed→agent', Buffer.from('{}\n'))
  recorder.close()
})
