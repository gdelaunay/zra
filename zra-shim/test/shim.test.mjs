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
import { AcpBridge, projectOptions } from '../acp.js'
import { createRecorder } from '../record.js'
import { FakeZed } from './fake-zed.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const FAKE_AGENT = join(HERE, 'fake-agent.mjs')

/** Monte un shim entre un faux Zed (en mémoire) et l'agent bouchon (un vrai processus). */
async function boot(t, { zed = {}, env = {}, shimOpts = {} } = {}) {
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
    ...shimOpts,
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

test('projection des options : les autres sélecteurs passent dans `options`, mode et modèle exclus', () => {
  const p = projectOptions({
    configOptions: [
      { id: 'mode', type: 'select', category: 'mode', currentValue: 'plan', options: [{ value: 'plan', name: 'Plan' }] },
      { id: 'model', type: 'select', category: 'model', currentValue: 'a', options: [{ value: 'a', name: 'A' }] },
      { id: 'effort', type: 'select', name: 'Effort', category: 'thought_level', currentValue: 'high',
        options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] },
      { id: 'fast', type: 'boolean', name: 'Fast mode', category: 'model_config', currentValue: true, description: 'plus vite' },
      { id: 'futur', type: 'slider', name: 'Inconnu', currentValue: 3 },
    ],
  })
  // Sans `modes`, le mode courant se lit dans son sélecteur.
  assert.equal(p.currentModeId, 'plan')
  assert.deepEqual(p.options, [
    { id: 'effort', name: 'Effort', category: 'thought_level', type: 'select',
      values: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], currentValue: 'high' },
    { id: 'fast', name: 'Fast mode', category: 'model_config', description: 'plus vite', type: 'boolean', currentValue: true },
  ])
})

test('projection des options : des « modes » qui doublent un sélecteur disparaissent (pi)', () => {
  const levels = ['off', 'low', 'high']
  const p = projectOptions({
    modes: { currentModeId: 'low', availableModes: levels.map((id) => ({ id, name: id })) },
    configOptions: [
      { id: 'thinking', type: 'select', name: 'Réflexion', category: 'thought_level', currentValue: 'low',
        options: levels.map((value) => ({ value, name: value })) },
    ],
  })
  // Un seul réglage, affiché une fois : le sélecteur typé, pas un faux mode.
  assert.deepEqual(p.modes, [])
  assert.equal(p.currentModeId, null)
  assert.deepEqual(p.options.map((o) => o.id), ['thinking'])
})

test('projection des options : de vrais modes restent des modes (claude)', () => {
  const p = projectOptions({
    modes: { currentModeId: 'plan', availableModes: [{ id: 'default' }, { id: 'plan' }] },
    configOptions: [
      { id: 'effort', type: 'select', category: 'thought_level', currentValue: 'low',
        options: [{ value: 'default' }, { value: 'low' }] },
    ],
  })
  assert.deepEqual(p.modes.map((m) => m.id), ['default', 'plan'])
  assert.equal(p.currentModeId, 'plan')
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
  assert.deepEqual(st.options.map((o) => [o.id, o.type, o.currentValue]), [['effort', 'select', 'medium'], ['fast', 'boolean', false]])
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

test('le message du mobile est annoncé à Zed avant la réponse (🟠6)', async (t) => {
  const { bridge, zed } = await boot(t)
  await bridge.prompt(zed.sessionId, 'depuis le mobile')
  await until(() => zed.updates.some((u) => u.content?.text === 'reçu : depuis le mobile'), { label: 'réponse de l’agent' })

  const echo = zed.updates.findIndex((u) => u.sessionUpdate === 'user_message_chunk' && u.content?.text === 'depuis le mobile')
  const reply = zed.updates.findIndex((u) => u.content?.text === 'reçu : depuis le mobile')
  assert.ok(echo !== -1, 'écho reçu par Zed')
  assert.ok(echo < reply, 'la question avant la réponse')
  assert.equal(zed.updates[echo]._meta?.zra?.synthetic, true)
})

test('un message tapé dans Zed ne lui est jamais renvoyé', async (t) => {
  const { zed } = await boot(t)
  await zed.prompt('depuis Zed')
  assert.ok(!zed.updates.some((u) => u._meta?.zra?.synthetic), 'aucune trame fabriquée par ZRA')
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
  const notices = []
  bridge.on('update', (e) => { if (e.update.sessionUpdate === 'zra/notice') notices.push(e.update) })

  const turn = zed.prompt('lent: tour à couper')
  await until(() => bridge.sessions.get(zed.sessionId).turn === 'busy', { label: 'busy' })

  assert.deepEqual(await bridge.cancel(zed.sessionId), { interrupted: true })
  assert.equal(bridge.sessions.get(zed.sessionId).turn, 'idle')
  assert.equal((await turn).stopReason, 'cancelled')
  // Acquittement réel ⇒ l'avis nominal, et lui seul (protocole §7).
  assert.deepEqual(notices.map((n) => n.text), ['tour interrompu'])

  // Tour déjà à l'arrêt : ne rien faire (protocole §3 `interrupt`).
  assert.deepEqual(await bridge.cancel(zed.sessionId), { interrupted: false })
  assert.equal(notices.length, 1)
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

test('set_option : un réglage générique part sous son id, un booléen avec son type', async (t) => {
  const { bridge, zed } = await boot(t)
  const option = (id) => bridge.sessions.get(zed.sessionId).options.find((o) => o.id === id)

  await bridge.setOption(zed.sessionId, 'effort', 'high')
  assert.equal(option('effort').currentValue, 'high')
  // Le faux agent refuse un `fast` qui n'arriverait pas typé `boolean`.
  await bridge.setOption(zed.sessionId, 'fast', true)
  assert.equal(option('fast').currentValue, true)
})

test('config_option_update : la liste complète republiée par l’agent remplace la nôtre', async (t) => {
  const { bridge, zed } = await boot(t)
  await zed.prompt('effort: à fond')
  await until(
    () => bridge.sessions.get(zed.sessionId).options.find((o) => o.id === 'effort').currentValue === 'high',
    { label: 'effort changé par l’agent' },
  )
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

// ---- confirmation d'un prompt injecté (mode auto, lot C) --------------------

test('prompt confirmé : accepté au premier update, refusé sur erreur, muet au délai', async () => {
  const { AcpBridge } = await import('../acp.js')
  const sent = []
  const bridge = new AcpBridge({ toAgent: (raw) => sent.push(JSON.parse(raw.toString())) })
  // Une session ouverte par Zed, vue passer par le shim.
  bridge.observeFromZed({ jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: '/tmp' } })
  bridge.observeFromAgent({ jsonrpc: '2.0', id: 1, result: { sessionId: 's1' } })
  const failed = []
  bridge.on('prompt_failed', (e) => failed.push(e))

  // Accepté : le premier session/update tranche.
  const ok = bridge.prompt('s1', 'un', 'queue', { confirmMs: 1000 })
  await new Promise((r) => setImmediate(r))
  bridge.observeFromAgent({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } } } })
  assert.deepEqual(await ok, { queued: false, confirmed: true })
  bridge.observeFromAgent({ jsonrpc: '2.0', id: sent.at(-1).id, result: { stopReason: 'end_turn' } })

  // Refusé : l'erreur remonte à l'appelant, sans avis en double.
  const ko = bridge.prompt('s1', 'deux', 'queue', { confirmMs: 1000 })
  await new Promise((r) => setImmediate(r))
  bridge.observeFromAgent({ jsonrpc: '2.0', id: sent.at(-1).id, error: { code: -32000, message: 'non' } })
  await assert.rejects(ko, (e) => e.code === 'prompt_refused' && /non/.test(e.message))
  assert.equal(failed.length, 0)

  // Muet : envoyé, non confirmé — pas de repli qui doublerait le message.
  const mute = bridge.prompt('s1', 'trois', 'queue', { confirmMs: 50 })
  assert.deepEqual(await mute, { queued: false, confirmed: false })

  // Sans confirmation demandée, un refus reste un avis, comme au lot B.
  bridge.observeFromAgent({ jsonrpc: '2.0', id: sent.at(-1).id, result: {} })
  await bridge.prompt('s1', 'quatre')
  bridge.observeFromAgent({ jsonrpc: '2.0', id: sent.at(-1).id, error: { code: -32000, message: 'refus' } })
  assert.equal(failed.length, 1)
})

// ---------------------------------------------------------------------------
// Agent muet — tour clos d'office (panne réelle du 2026-10-03)
//
// `turn` est déduit des seuls `session/prompt` en vol : un agent qui ne répond
// jamais laissait le tour `busy` pour toujours, le mobile en chargement infini,
// et Stop n'y changeait rien — il affichait « tour interrompu » sans refermer le
// tour. Ce qui suit verrouille les trois sorties : interruption non acquittée,
// garde-fou sur silence, et réponse tardive d'un tour déjà clos.
// ---------------------------------------------------------------------------

/** Pont nu, sans processus, avec une session `s1` ouverte : pour les tests d'horloge. */
function bareBridge(sent, opts = {}) {
  const bridge = new AcpBridge({
    toAgent: (raw) => sent.push(JSON.parse(raw.toString())),
    turnTimeoutMs: 1000,
    ...opts,
  })
  bridge.observeFromZed({ jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: '/tmp' } })
  bridge.observeFromAgent({ jsonrpc: '2.0', id: 1, result: { sessionId: 's1' } })
  return bridge
}

const zedPrompt = (bridge, text, id = 2) =>
  bridge.observeFromZed({ jsonrpc: '2.0', id, method: 'session/prompt', params: { sessionId: 's1', prompt: [{ type: 'text', text }] } })

const agentChunk = () => ({
  jsonrpc: '2.0', method: 'session/update',
  params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '.' } } },
})

const noticesOf = (bridge) => {
  const notices = []
  bridge.on('update', (e) => { if (e.update.sessionUpdate === 'zra/notice') notices.push(e.update) })
  return notices
}

test('stop sur un agent muet : le tour est clos d’office et le fil le dit', async (t) => {
  const { bridge, zed } = await boot(t, { shimOpts: { cancelTimeoutMs: 200 } })
  const notices = noticesOf(bridge)

  // L'agent accepte le prompt puis se tait : il n'acquittera pas le cancel.
  let rendu = false
  const turn = zed.prompt('muet: ne répondra jamais')
  turn.then(() => { rendu = true }, () => { rendu = true })
  await until(() => bridge.sessions.get(zed.sessionId).turn === 'busy', { label: 'busy' })

  assert.deepEqual(await bridge.cancel(zed.sessionId), { interrupted: true })
  assert.equal(bridge.sessions.get(zed.sessionId).turn, 'idle')
  // Pas « tour interrompu » : ce serait mentir, l'agent n'a rien acquitté.
  assert.equal(notices.length, 1)
  assert.match(notices[0].text, /pas acquitté/)
  assert.match(notices[0].text, /Rouvre le thread dans Zed/)
  assert.equal(notices[0].level, 'warn')
  // Zed, lui, attend toujours sa réponse : on a cessé d'y croire, pas lui.
  assert.equal(rendu, false)
})

test('stop et envoie sur un agent muet : un seul prompt en vol, pas d’orphelin', async (t) => {
  const { bridge, zed } = await boot(t, { shimOpts: { cancelTimeoutMs: 200 } })

  zed.prompt('muet: premier tour')
  await until(() => bridge.sessions.get(zed.sessionId).turn === 'busy', { label: 'busy' })

  await bridge.prompt(zed.sessionId, 'muet: second tour', 'interrupt')
  // Sans clôture d'office, le tour non acquitté s'ajouterait au nouveau prompt :
  // `turn` ne reviendrait plus jamais à `idle`, même l'agent reparti.
  assert.equal(bridge.sessions.get(zed.sessionId).pendingPrompts.size, 1)
})

test('garde-fou : un tour sans signe de vie est clos, la file conservée', async () => {
  const sent = []
  const bridge = bareBridge(sent)
  const notices = noticesOf(bridge)
  const turns = []
  bridge.on('state', (s) => turns.push(s.turn))

  zedPrompt(bridge, 'bonjour')
  const st = bridge.sessions.get('s1')
  assert.equal(st.turn, 'busy')
  bridge.sessions.enqueue('s1', 'en attente')

  // Sous le délai : rien ne bouge.
  bridge.sessions.sweep(st.lastActivity + 999)
  assert.equal(st.turn, 'busy')
  assert.equal(notices.length, 0)

  // Délai atteint sans un seul `session/update` : clôture d'office.
  bridge.sessions.sweep(st.lastActivity + 1000)
  assert.equal(st.turn, 'idle')
  assert.equal(turns.at(-1), 'idle')
  // La file ne part pas dans le vide : elle reste visible et annulable.
  assert.equal(st.queue.length, 1)
  assert.equal(sent.length, 0, 'rien n’est écrit vers l’agent')
  assert.equal(notices.length, 1)
  assert.match(notices[0].text, /ne répond plus/)
  assert.match(notices[0].text, /1 message\(s\) en attente conservé/)
  bridge.shutdown()
})

test('garde-fou : le silence se mesure depuis le dernier signe de vie', () => {
  const bridge = bareBridge([])
  const st = bridge.sessions.get('s1')
  zedPrompt(bridge, 'un long tour')

  // Un tour long qui stream n'est pas un tour pendu : chaque `update` repousse
  // l'échéance. `lastActivity` est remis à une valeur synthétique pour balayer à
  // heure fixe, sans horloge simulée.
  for (const at of [10_000, 20_000, 30_000]) {
    const avant = st.lastActivity
    bridge.observeFromAgent(agentChunk())
    assert.ok(st.lastActivity >= avant, 'un update rafraîchit le dernier signe de vie')
    st.lastActivity = at
    bridge.sessions.sweep(at + 999)
    assert.equal(st.turn, 'busy', `tour coupé à tort après l'update de ${at}`)
  }

  st.lastActivity = 40_000
  bridge.sessions.sweep(41_000)
  assert.equal(st.turn, 'idle')
  bridge.shutdown()
})

test('une réponse tardive après clôture d’office ne dépile pas la file', async () => {
  const sent = []
  const bridge = bareBridge(sent)

  await bridge.prompt('s1', 'premier')
  bridge.sessions.enqueue('s1', 'second')
  const abandonne = sent.at(-1).id
  bridge.forceIdle('s1', 'agent muet')
  const avant = sent.length

  // L'agent se réveille et répond au prompt abandonné.
  bridge.observeFromAgent({ jsonrpc: '2.0', id: abandonne, result: { stopReason: 'end_turn' } })
  await wait(20)

  assert.equal(bridge.sessions.get('s1').turn, 'idle')
  assert.equal(bridge.sessions.get('s1').queue.length, 1, 'la file ne part pas toute seule')
  assert.equal(sent.length, avant, 'rien de plus n’est écrit vers l’agent')
  bridge.shutdown()
})

test('une réponse tardive ne confirme pas le verdict d’un autre prompt', async () => {
  const sent = []
  const bridge = bareBridge(sent)

  // Premier prompt, abandonné par une clôture d'office…
  const premier = bridge.prompt('s1', 'premier', 'queue', { confirmMs: 5000 })
  await new Promise((r) => setImmediate(r))
  const abandonne = sent.at(-1).id
  bridge.forceIdle('s1', 'agent muet')
  // …rendu à son appelant sans verdict, plutôt que de le laisser pendre.
  assert.deepEqual(await premier, { queued: false, confirmed: false })

  // Un second prompt, dont on attend le verdict.
  const second = bridge.prompt('s1', 'second', 'queue', { confirmMs: 5000 })
  await new Promise((r) => setImmediate(r))

  // La réponse du premier ne doit pas trancher pour le second.
  bridge.observeFromAgent({ jsonrpc: '2.0', id: abandonne, result: { stopReason: 'end_turn' } })
  await wait(20)
  assert.equal(bridge.sessions.get('s1').turn, 'busy', 'le second prompt est toujours en vol')

  bridge.observeFromAgent(agentChunk())
  assert.deepEqual(await second, { queued: false, confirmed: true })
  bridge.observeFromAgent({ jsonrpc: '2.0', id: sent.at(-1).id, result: { stopReason: 'end_turn' } })
  bridge.shutdown()
})
