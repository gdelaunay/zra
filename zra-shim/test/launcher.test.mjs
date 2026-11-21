// Le launcher de preload (zra-shim/launcher.mjs), en vrais processus node :
//  · l'agent tourne enveloppé : le shim est dans la chaîne, NODE_OPTIONS ne
//    cascade pas, les arguments et le code de sortie passent ;
//  · fail-open : launcher absent, shim absent, double preload ⇒ l'agent
//    démarre quand même, sans ZRA, avec son code de sortie.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, copyFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { preloadFlag } from '../../zra-daemon/agent-commands.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

const TMP = mkdtempSync(join(tmpdir(), 'zra-launcher-'))
test.after(() => rmSync(TMP, { recursive: true, force: true }))

// Un faux agent : dit ce qu'il voit de son environnement, sort en code 42.
const AGENT = join(TMP, 'agent.mjs')
writeFileSync(AGENT, `
process.stdout.write(JSON.stringify({
  shimmed: process.env.ZRA_SHIMMED ?? null,
  nodeOptions: process.env.NODE_OPTIONS ?? null,
  args: process.argv.slice(2),
}) + '\\n')
process.exit(42)
`)

/** Payload `--import data:` pointant vers un launcher (existant ou pas). */
const payloadFor = (launcher) =>
  `--import data:text/javascript,${encodeURIComponent(`try{await import(${JSON.stringify(pathToFileURL(launcher).href)})}catch{}`)}`

/** Lance le faux agent avec ce NODE_OPTIONS ; rend { code, stdout, stderr }. */
function run(env, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [AGENT, ...args], {
      env: {
        ...process.env,
        ZRA_LOG_FILE: join(TMP, 'shim.log'),
        // Port mort : le test ne parle à aucun daemon réel (lien fail-open).
        ZRA_DAEMON_URL: 'ws://127.0.0.1:9/shim',
        ...env,
      },
      windowsHide: true,
    })
    let stdout = '', stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('error', reject)
    child.on('exit', (code) => resolve({ code, stdout, stderr }))
    setTimeout(() => { child.kill(); reject(new Error('timeout')) }, 20000).unref()
  })
}

const seen = (stdout) => JSON.parse(stdout.trim().split('\n').at(-1))

test('launcher : l\'agent tourne enveloppé, sans NODE_OPTIONS en cascade, args et code de sortie transmis', async () => {
  const r = await run({ NODE_OPTIONS: preloadFlag(ROOT) }, ['--acp', 'x y'])
  assert.equal(r.code, 42, 'code de sortie de l\'agent')
  const agent = seen(r.stdout)
  assert.equal(agent.shimmed, '1', 'le marqueur ZRA_SHIMMED est posé')
  assert.equal(agent.nodeOptions, null, 'NODE_OPTIONS retiré : pas de re-preload en cascade')
  assert.deepEqual(agent.args, ['--acp', 'x y'], 'arguments de l\'agent transmis')
  assert.match(r.stderr, /zra-shim/, 'le shim a journalisé : il est dans la chaîne')
})

test('launcher : fail-open si le launcher a disparu (ZRA supprimé)', async () => {
  const r = await run({ NODE_OPTIONS: payloadFor(join(TMP, 'absent', 'launcher.mjs')) })
  assert.equal(r.code, 42)
  const agent = seen(r.stdout)
  assert.equal(agent.shimmed, null, 'l\'agent tourne sans ZRA')
  assert.ok(!/zra-shim/.test(r.stderr), 'pas de shim dans la chaîne')
})

test('launcher : fail-open si le shim a disparu (launcher seul)', async () => {
  const lone = join(TMP, 'lone-launcher.mjs')
  copyFileSync(join(ROOT, 'zra-shim', 'launcher.mjs'), lone)
  const r = await run({ NODE_OPTIONS: payloadFor(lone) })
  assert.equal(r.code, 42)
  assert.equal(seen(r.stdout).shimmed, null)
})

test('launcher : double preload — ZRA_SHIMMED déjà posé, l\'agent tourne direct', async () => {
  const r = await run({ NODE_OPTIONS: preloadFlag(ROOT), ZRA_SHIMMED: '1' })
  assert.equal(r.code, 42)
  assert.equal(seen(r.stdout).shimmed, '1')
  assert.ok(!/zra-shim/.test(r.stderr), 'pas de second enveloppement')
})