// Archive « app » (CI) : version lue dans Cargo.toml, nom de l'archive,
// layout staging (binaire à la racine + app/ avec les quatre dossiers runtime
// et package.json). Pas de zip ici — outil de l'OS, testé en CI.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { APP_DIRS, SCRIPT_DIRS, SCRIPT_FILES, archiveName, stageApp, trayVersion } from '../../scripts/ci-package-app.mjs'

const WIN = 'x86_64-pc-windows-msvc'
const LINUX = 'x86_64-unknown-linux-gnu'

/** Faux dépôt minimal : Cargo.toml, les quatre dossiers, package.json, binaire. */
function fakeRoot(t, target = WIN, { binary = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'zra-package-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'zra-tray'), { recursive: true })
  writeFileSync(join(root, 'zra-tray', 'Cargo.toml'), '[package]\nname = "zra-tray"\nversion = "0.6.0-dev"\n')
  for (const d of APP_DIRS) {
    mkdirSync(join(root, d), { recursive: true })
    writeFileSync(join(root, d, 'index.js'), '// fake\n')
    mkdirSync(join(root, d, 'test'), { recursive: true })
    writeFileSync(join(root, d, 'test', 'x.test.mjs'), '// dev-only\n')
  }
  mkdirSync(join(root, 'zra-client', 'tools'), { recursive: true })
  writeFileSync(join(root, 'zra-client', 'tools', 'mock-server.mjs'), '// dev-only\n')
  mkdirSync(join(root, 'scripts', 'lib'), { recursive: true })
  for (const f of SCRIPT_FILES) writeFileSync(join(root, 'scripts', f), '// fake\n')
  for (const d of SCRIPT_DIRS) writeFileSync(join(root, 'scripts', d, 'args.mjs'), '// fake\n')
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'zra', version: '0.6.0-dev' }))
  if (binary) {
    const exe = target.includes('windows') ? '.exe' : ''
    const dir = join(root, 'zra-tray', 'target', target, 'release')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `zra-tray${exe}`), 'MZ-faux-binaire')
  }
  return root
}

test('trayVersion : lue dans zra-tray/Cargo.toml (source unique du gate)', (t) => {
  assert.equal(trayVersion(fakeRoot(t)), '0.6.0-dev')
})

test('archiveName : zra-<version>-<target>.zip', () => {
  assert.equal(archiveName('0.6.0-dev', WIN), 'zra-0.6.0-dev-x86_64-pc-windows-msvc.zip')
  assert.equal(archiveName('0.6.0', LINUX), 'zra-0.6.0-x86_64-unknown-linux-gnu.zip')
})

test('stageApp : binaire à la racine, app/ avec les quatre dossiers + package.json', (t) => {
  const root = fakeRoot(t)
  const outDir = join(root, 'dist')
  const staging = stageApp({ root, target: WIN, outDir })
  assert.equal(staging, join(outDir, 'zra-0.6.0-dev-x86_64-pc-windows-msvc'))
  assert.ok(existsSync(join(staging, 'zra-tray.exe')), 'point d’entrée à la racine')
  for (const d of APP_DIRS) {
    assert.ok(existsSync(join(staging, 'app', d, 'index.js')), `app/${d}`)
  }
  // Le daemon lit ROOT/package.json pour sa version : il doit être dans app/.
  assert.deepEqual(JSON.parse(readFileSync(join(staging, 'app', 'package.json'), 'utf8')).name, 'zra')
  assert.equal(existsSync(join(staging, 'app', 'zra-tray.exe')), false, 'pas de binaire dans app/')
  // Dev-only exclu : tests, fixtures, outils.
  for (const d of APP_DIRS) assert.equal(existsSync(join(staging, 'app', d, 'test')), false, `app/${d}/test exclu`)
  assert.equal(existsSync(join(staging, 'app', 'zra-client', 'tools')), false, 'tools exclu')
  // Orchestration : setup/service + libs embarqués (le tray les spawn).
  for (const f of SCRIPT_FILES) assert.ok(existsSync(join(staging, 'app', 'scripts', f)), `app/scripts/${f}`)
  for (const d of SCRIPT_DIRS) assert.ok(existsSync(join(staging, 'app', 'scripts', d, 'args.mjs')), `app/scripts/${d}/`)
})

test('stageApp : cible Linux → binaire sans .exe', (t) => {
  const root = fakeRoot(t, LINUX)
  const staging = stageApp({ root, target: LINUX, outDir: join(root, 'dist') })
  assert.ok(existsSync(join(staging, 'zra-tray')))
  assert.equal(existsSync(join(staging, 'zra-tray.exe')), false)
})

test('stageApp : binaire non buildé → erreur explicite', (t) => {
  const root = fakeRoot(t, WIN, { binary: false })
  assert.throws(() => stageApp({ root, target: WIN, outDir: join(root, 'dist') }), /Binaire absent/)
})