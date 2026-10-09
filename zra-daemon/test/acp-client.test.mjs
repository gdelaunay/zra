// Le daemon en client ACP (`acp-client.js`) — spec §5.2.
//
// Client minimal et jetable : il ne sait qu'`initialize` et `session/load`, ne
// déclare aucune capacité, et meurt aussitôt après. L'agent en face est un
// bouchon (`test/fixtures/replay-agent.mjs`) lancé en vrai sous-processus — c'est
// le seul moyen de vérifier le découpage des trames, la mort de l'agent et le
// nettoyage du processus.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { AcpClient, PROTOCOL_VERSION } from '../acp-client.js'
import { setLevel } from '../log.js'

setLevel('error')

const HERE = dirname(fileURLToPath(import.meta.url))
const AGENT = join(HERE, 'fixtures', 'replay-agent.mjs')
const CWD = join(HERE, 'fixtures')

/** Lance le client sur l'agent bouchon, et le tue quoi qu'il arrive. */
function boot(t, { mode = 'replay', env = {}, command = process.execPath, args = [AGENT] } = {}) {
  const client = new AcpClient({
    command,
    args,
    cwd: CWD,
    env: { ZRA_TEST_MODE: mode, ...env },
  })
  t.after(() => client.kill())
  return client
}

/** Ramasse les notifications `session/update`. */
function collect(client) {
  const updates = []
  client.onNotification = (params) => updates.push(params)
  return updates
}

test('le client parle la version 1 du protocole', () => {
  assert.equal(PROTOCOL_VERSION, 1)
})

test('initialize : aucune capacité déclarée, et l’agent répond', async (t) => {
  const client = boot(t)
  const init = await client.initialize()

  assert.equal(init.agentCapabilities.loadSession, true)
  assert.deepEqual(init.agentInfo, { name: 'replay-agent', version: '2.0.0' })
  // Ce que l'agent a reçu de nous (renvoyé tel quel par le bouchon).
  assert.deepEqual(init.echo, {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: 'zra-daemon', version: '1' },
  })
})

test('session/load : les updates du replay arrivent verbatim, dans l’ordre', async (t) => {
  const client = boot(t)
  const updates = collect(client)
  await client.initialize()
  const result = await client.loadSession({ sessionId: 'sess-1', cwd: CWD })

  assert.deepEqual(result.received, { sessionId: 'sess-1', cwd: CWD, mcpServers: [] })
  assert.deepEqual(updates, [
    { sessionId: 'sess-1', update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'question archivée' } } },
    { sessionId: 'sess-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'réponse archivée' } } },
    // Le client ne filtre pas par session : c'est le rôle de la relecture.
    { sessionId: 'autre-session', update: { sessionUpdate: 'agent_message_chunk' } },
  ])
})

test('une notification qui n’est pas session/update est ignorée', async (t) => {
  const client = boot(t)
  const seen = []
  client.onNotification = (params) => seen.push(params)
  await client.initialize()
  await client.loadSession({ sessionId: 'sess-1', cwd: CWD })
  assert.equal(seen.filter((p) => p.rien).length, 0, 'zra/ignored ne remonte pas')
})

test('sans onNotification, le replay ne casse rien', async (t) => {
  const client = boot(t)
  await client.initialize()
  const result = await client.loadSession({ sessionId: 'sess-1', cwd: CWD })
  assert.equal(result.received.sessionId, 'sess-1')
})

test('deux requêtes en vol : chaque réponse revient à son appelant', async (t) => {
  const client = boot(t)
  await client.initialize()
  const [a, b] = await Promise.all([
    client.loadSession({ sessionId: 'sess-1', cwd: CWD }),
    client.loadSession({ sessionId: 'sess-2', cwd: CWD }),
  ])
  assert.equal(a.received.sessionId, 'sess-1')
  assert.equal(b.received.sessionId, 'sess-2')
})

test('réponse en erreur : le message et le code RPC remontent', async (t) => {
  const client = boot(t, { mode: 'error' })
  await client.initialize()
  await assert.rejects(() => client.loadSession({ sessionId: 'x', cwd: CWD }), (err) => {
    assert.equal(err.message, 'session introuvable sur le disque')
    assert.deepEqual(err.rpc, { code: -32602, message: 'session introuvable sur le disque' })
    return true
  })
  assert.equal(client.closed, false, 'un échec de requête n’arrête pas le client')
})

test('des lignes qui ne sont pas du JSON-RPC sur stdout sont ignorées', async (t) => {
  const client = boot(t, { mode: 'junk' })
  await client.initialize()
  const result = await client.loadSession({ sessionId: 'sess-1', cwd: CWD })
  assert.equal(result.received.sessionId, 'sess-1')
})

test('l’agent qui pose une requête reçoit une réponse explicite : permission annulée, méthode refusée', async (t) => {
  const client = boot(t, { mode: 'ask' })
  await client.initialize()
  const result = await client.loadSession({ sessionId: 'sess-1', cwd: CWD })

  assert.deepEqual(result.permission, { outcome: { outcome: 'cancelled' } }, 'personne devant l’écran : rien n’est autorisé')
  assert.equal(result.fs.startsWith('-32601:'), true)
  assert.match(result.fs, /méthode non supportée par ce client de relecture : fs\/read_text_file/)
})

test('l’agent meurt en cours de route : la requête en vol échoue, le client se ferme', async (t) => {
  const client = boot(t, { mode: 'exit', env: { ZRA_TEST_EXIT_CODE: '7' } })
  await assert.rejects(() => client.initialize(), (err) => {
    assert.match(err.message, /agent terminé \(code=7, signal=—\)/)
    return true
  })
  assert.equal(client.closed, true)
  assert.match(client.exitReason, /agent terminé \(code=7, signal=—\)/)
})

test('une requête après la mort de l’agent échoue immédiatement', async (t) => {
  const client = boot(t, { mode: 'exit' })
  await assert.rejects(() => client.initialize(), /agent terminé/)
  const reason = client.exitReason
  await assert.rejects(() => client.loadSession({ sessionId: 'x', cwd: CWD }), (err) => {
    assert.equal(err.message, reason)
    return true
  })
})

test('un agent non lançable le dit, sans exception nue', async (t) => {
  const client = boot(t, { command: 'node-qui-n-existe-pas-zra', args: [] })
  await assert.rejects(() => client.initialize(), (err) => {
    assert.match(err.message, /^agent non lançable : /)
    return true
  })
  assert.equal(client.closed, true)
})

test('stderr de l’agent est capturé, et borné', async (t) => {
  const client = boot(t, { env: { ZRA_TEST_STDERR: 'diagnostic important', ZRA_TEST_STDERR_LINES: '200' } })
  await client.initialize()
  await new Promise((r) => setTimeout(r, 150))
  assert.ok(client.stderr.length <= 4000, `borné à 4000, obtenu ${client.stderr.length}`)
  assert.ok(client.stderr.length > 3000, 'assez long pour que la borne ait joué')
  assert.ok(!client.stderr.includes('diagnostic important'), 'les premières lignes ont été évincées')
})

test('un agent muet est tué par kill(), et la requête en vol échoue', async (t) => {
  const client = boot(t, { mode: 'silent' })
  await client.initialize()
  const pending = client.loadSession({ sessionId: 'sess-1', cwd: CWD })
  const exited = new Promise((r) => client.child.once('exit', r))

  client.kill()
  client.kill()                                 // idempotent
  await assert.rejects(() => pending, /agent terminé/)
  await exited
  assert.equal(client.closed, true)
})

test('kill() sur un agent déjà parti ne fait rien', async (t) => {
  const client = boot(t, { mode: 'exit' })
  await assert.rejects(() => client.initialize(), /agent terminé/)
  client.kill()
  client.kill()
  assert.equal(client.closed, true)
})

test('un agent sans loadSession le déclare, le client ne juge pas', async (t) => {
  const client = boot(t, { mode: 'noload' })
  const init = await client.initialize()
  assert.equal(init.agentCapabilities.loadSession, false)
})

test('deux clients successifs ne se marchent pas dessus', async (t) => {
  const first = boot(t)
  await first.initialize()
  first.kill()

  const second = boot(t)
  const init = await second.initialize()
  assert.equal(init.agentInfo.name, 'replay-agent')
})
