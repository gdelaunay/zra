// Environnement du projet relevé comme Zed (`shell-env.js`), et son usage par
// la relecture d'un thread fermé (`session-loader.js`).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { captureCommand, parseCapture, projectEnvironment, clearProjectEnvironmentCache } from '../shell-env.js'
import { SessionLoader } from '../session-loader.js'
import { setLevel } from '../log.js'

setLevel('error')

const HERE = dirname(fileURLToPath(import.meta.url))
const REPLAY_AGENT = join(HERE, 'fixtures', 'replay-agent.mjs')

test('Windows : rien à relever, comme Zed (PowerShell -NoProfile rend l’environnement de session)', async () => {
  assert.deepEqual(await projectEnvironment('C:/projet', { platform: 'win32' }), {})
})

test('commande de relevé : shell de connexion interactif, cd dans le projet, comme `capture_unix`', () => {
  const bash = captureCommand('/bin/bash', "/home/ada/l'projet", '/usr/bin/node')
  assert.equal(bash.command, '/bin/bash')
  assert.deepEqual(bash.args.slice(0, 3), ['-l', '-i', '-c'])
  assert.match(bash.args[3], /^cd '\/home\/ada\/l'\\''projet'; '\/usr\/bin\/node' -e /)

  const fish = captureCommand('/usr/bin/fish', "/tmp/a'b", '/usr/bin/node')
  assert.match(fish.args[3], /^emit fish_prompt; cd '\/tmp\/a\\'b';/)
  // Un dossier qui commence par « - » n'est pas pris pour une option de `cd`.
  assert.match(captureCommand('/bin/sh', '-bizarre').args[3], /^cd '\.\/-bizarre'/)
  assert.equal(captureCommand('/usr/bin/nu', '/tmp'), null, 'shell non pris en charge')
})

test('sortie bavarde du shell : l’environnement est retrouvé derrière le repère', () => {
  const env = parseCapture('Bienvenue !\n{faux}\n__ZRA_ENV__{"PATH":"/a:/b","X":"{1}"}')
  assert.deepEqual(env, { PATH: '/a:/b', X: '{1}' })
  assert.throws(() => parseCapture('rien'), /Aucun environnement/)
})

test('relevé réel avec /bin/sh : variables du shell, dossier du projet', { skip: process.platform === 'win32' && 'pas de /bin/sh sous Windows' }, async (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'zra-env-')))
  t.after(() => { rmSync(dir, { recursive: true, force: true }); clearProjectEnvironmentCache() })
  const env = await projectEnvironment(dir, { platform: process.platform, shell: '/bin/sh' })
  assert.equal(env.PWD, dir)
  assert.ok(env.PATH, 'le PATH du shell')
})

test('shell introuvable : relevé vide, la relecture continue avec l’environnement du daemon', { skip: process.platform === 'win32' && 'relevé désactivé sous Windows' }, async (t) => {
  t.after(() => clearProjectEnvironmentCache())
  assert.deepEqual(await projectEnvironment(tmpdir(), { platform: process.platform, shell: '/nulle/part/bash' }), {})
})

test('relecture : environnement du projet, puis env des réglages de l’agent par-dessus (comme Zed)', async () => {
  const thread = { threadId: 't1', sessionId: 's1', agentId: 'bouchon', folderPaths: [HERE], updatedAt: '2026-01-01T00:00:00.000Z' }
  const seen = []
  const loader = (agentEnv) => new SessionLoader({
    threads: { get: () => thread },
    agentCommands: { bouchon: { command: process.execPath, args: [REPLAY_AGENT], env: agentEnv } },
    // Le projet demande un agent sans `loadSession` (mode du bouchon).
    projectEnv: async (dir) => { seen.push(dir); return { ZRA_TEST_MODE: 'noload' } },
  })

  // Seul, l'environnement du projet s'applique.
  await assert.rejects(loader({}).load('t1'), (err) => err.code === 'no_load_session')
  assert.deepEqual(seen, [HERE], 'relevé dans le dossier du thread')
  // L'env des réglages de l'agent l'emporte.
  const payload = await loader({ ZRA_TEST_MODE: 'replay' }).load('t1')
  assert.ok(payload.updates.length > 0)
})
