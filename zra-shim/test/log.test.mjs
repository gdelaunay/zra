// Le journal du shim (`log.js`).
//
// La règle qui prime : **rien sur stdout** — c'est le canal ACP de Zed, une
// seule ligne parasite casserait l'agent. Le module lit son environnement à
// l'import, donc chaque cas tourne dans un sous-processus.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
// URL de fichier : `import 'C:/…'` n’est pas une URL ESM valide sous Windows.
const LOG = pathToFileURL(resolve(HERE, '../log.js')).href

/** Lance un script qui journalise, et rend ses trois sorties. */
function run({ env = {}, script = `
  import { log } from '${LOG}'
  log.debug('d', 1)
  log.info('i', { a: 1 })
  log.warn('w')
  log.error('e')
` } = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('error', reject)
    child.on('exit', (code) => resolveRun({ code, out, err }))
  })
}

/** Découpe stderr en lignes, en champs (heure, niveau, tag, message). */
const lines = (err) => err.split('\n').filter(Boolean)
const level = (line) => line.split(/\s+/)[1]

test('rien sur stdout, jamais : le canal ACP reste intact', async () => {
  const { code, out, err } = await run()
  assert.equal(code, 0)
  assert.equal(out, '', 'stdout est le canal JSON-RPC de Zed')
  assert.equal(lines(err).length, 3, 'debug filtré au niveau par défaut (info)')
})

test('format d’une ligne : heure, niveau cadré, tag, message', async () => {
  const { err } = await run()
  const [line] = lines(err)
  assert.match(line, /^\d{2}:\d{2}:\d{2}\.\d{3} info\s+zra-shim\s+i \[object Object\]$/)
  assert.deepEqual(lines(err).map(level), ['info', 'warn', 'error'])
})

test('les arguments sont joints par des espaces et convertis en texte', async () => {
  const { err } = await run({
    script: `
      import { log } from '${LOG}'
      log.info('a', 1, true, null, undefined, { k: 'v' })
    `,
  })
  assert.equal(lines(err)[0].replace(/^.*zra-shim\s+/, ''), 'a 1 true null undefined [object Object]')
})

test('ZRA_LOG_LEVEL filtre : debug tout montre, warn masque info', async () => {
  const debug = await run({ env: { ZRA_LOG_LEVEL: 'debug' } })
  assert.deepEqual(lines(debug.err).map(level), ['debug', 'info', 'warn', 'error'])

  const warn = await run({ env: { ZRA_LOG_LEVEL: 'warn' } })
  assert.deepEqual(lines(warn.err).map(level), ['warn', 'error'])

  const error = await run({ env: { ZRA_LOG_LEVEL: 'error' } })
  assert.deepEqual(lines(error.err).map(level), ['error'])
})

test('un niveau inconnu retombe sur info', async () => {
  const { err } = await run({ env: { ZRA_LOG_LEVEL: 'bavard' } })
  assert.deepEqual(lines(err).map(level), ['info', 'warn', 'error'])
})

test('ZRA_LOG_FILE double chaque ligne dans un fichier, avec date et pid', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zra-log-'))
  const file = join(dir, 'sous', 'dossier', 'shim.log')   // les parents sont créés
  const { err, code } = await run({ env: { ZRA_LOG_FILE: file } })
  assert.equal(code, 0)
  assert.ok(existsSync(file), 'le fichier et ses dossiers sont créés')

  const written = readFileSync(file, 'utf8').split('\n').filter(Boolean)
  assert.equal(written.length, lines(err).length)
  assert.match(written[0], /^\d{4}-\d{2}-\d{2} \[\d+\] \d{2}:\d{2}:\d{2}\.\d{3} info\s+zra-shim\s/)
  for (const [i, line] of lines(err).entries()) {
    assert.ok(written[i].endsWith(line), 'le fichier porte la même ligne que stderr')
  }
})

test('le fichier est ouvert en ajout : deux shims ne s’écrasent pas', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zra-log-'))
  const file = join(dir, 'shim.log')
  appendFileSync(file, 'ligne déjà là\n')
  await run({ env: { ZRA_LOG_FILE: file } })
  const written = readFileSync(file, 'utf8').split('\n').filter(Boolean)
  assert.equal(written[0], 'ligne déjà là')
  assert.ok(written.length > 1)
})

test('un fichier impossible à ouvrir ne casse pas le journal (stderr seul)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zra-log-'))
  const blocker = join(dir, 'pas-un-dossier')
  writeFileSync(blocker, 'x')
  const { code, err, out } = await run({ env: { ZRA_LOG_FILE: join(blocker, 'shim.log') } })
  assert.equal(code, 0, 'le shim ne meurt pas sur une erreur de disque')
  assert.equal(out, '')
  assert.deepEqual(lines(err).map(level), ['info', 'warn', 'error'])
})

test('le niveau du fichier suit ZRA_LOG_LEVEL comme stderr', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zra-log-'))
  const file = join(dir, 'shim.log')
  await run({ env: { ZRA_LOG_FILE: file, ZRA_LOG_LEVEL: 'error' } })
  const written = readFileSync(file, 'utf8').split('\n').filter(Boolean)
  assert.equal(written.length, 1)
  assert.ok(written[0].includes(' error '))
})
