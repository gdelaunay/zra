// Chemins Linux — inventaire A du portage, vérifié sur la machine de portage.
//
// Ces tests s'ajoutent AUX fixtures Windows existantes
// (`fixtures/registry`, `fixtures/registry-args`), ils ne les remplacent pas :
// la branche Windows est gelée et ses tests continuent de la tenir.
//
// Les deux fixtures Linux ci-dessous reproduisent ce que Zed a réellement posé
// sur cette machine, relevé à la commande :
//
//   $ find ~/.local/share/zed/external_agents/registry/npx -maxdepth 4
//     …/npx/pi-acp/package.json
//     …/npx/pi-acp/node_modules/pi-acp/package.json
//   $ … son package.json → {"name":"pi-acp","version":"0.0.34",
//                            "bin":{"pi-acp":"dist/index.js"},"type":"module"}
//   $ … registry.json → distribution.binary.linux-x86_64.cmd = "./amp-acp"
//     (19 entrées `linux-x86_64` ; aucune n'a de `.exe`, toutes sont relatives)

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { discoverAgents, resolveAgentCommand } from '../agent-commands.js'
import { isZedRunning } from '../agents.js'
import { PATHS } from '../platform.js'
import { createRecorder } from '../../zra-shim/record.js'

const run = promisify(execFile)
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const LINUX_ONLY = process.platform === 'win32' && 'fixture Linux : la clé `linux-x86_64` du registry n’existe pas en Windows'

// ---------------------------------------------------------------------------
// Le registry, version Linux
// ---------------------------------------------------------------------------

test('linux : un agent npx du registry est résolu comme en Windows', { skip: LINUX_ONLY }, async () => {
  // Arborescence relevée sur cette machine pour `pi-acp`, au nom près.
  const registryDir = join(FIXTURES, 'registry-linux')
  const pkgDir = join(registryDir, 'npx', 'faux-acp', 'node_modules', 'faux-acp')
  mkdirSync(join(pkgDir, 'dist'), { recursive: true })
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
    name: 'faux-acp', version: '0.0.34', type: 'module', bin: { 'faux-acp': 'dist/index.js' },
  }), 'utf8')
  writeFileSync(join(pkgDir, 'dist', 'index.js'), '#!/usr/bin/env node\n// agent\n', 'utf8')
  writeFileSync(join(registryDir, 'registry.json'), JSON.stringify({
    version: '1.0.0',
    agents: [{ id: 'faux-acp', distribution: { npx: { package: 'faux-acp@0.0.34' } } }],
  }), 'utf8')

  const cmd = await resolveAgentCommand('faux-acp', { registryDir })
  assert.equal(cmd.source, 'registry/npx')
  // Node lance Node : pas de `npx` du PATH, pas de téléchargement.
  assert.equal(cmd.command, process.execPath)
  assert.equal(cmd.args[0], join(pkgDir, 'dist', 'index.js'))
})

test('linux : un agent binaire du registry porte la clé linux-x86_64 et n’a pas de .exe', { skip: LINUX_ONLY }, async () => {
  const registryDir = join(FIXTURES, 'registry-linux')
  const binDir = join(registryDir, 'faux-binaire', 'v0.1.0')
  mkdirSync(binDir, { recursive: true })
  const bin = join(binDir, 'faux-agent')
  writeFileSync(bin, '#!/bin/sh\nexit 0\n', 'utf8')
  chmodSync(bin, 0o755) // Zed détarre une archive : le bit exécutable doit suivre
  const registry = JSON.parse(readFileSync(join(registryDir, 'registry.json'), 'utf8'))
  registry.agents.push({
    id: 'faux-binaire',
    distribution: {
      // Forme exacte relevée dans le registry de cette machine : `cmd` relatif,
      // préfixé `./`, sans extension.
      binary: { 'linux-x86_64': { cmd: './faux-agent', args: ['acp'], archive: 'https://exemple/faux.tar.gz' } },
    },
  })
  writeFileSync(join(registryDir, 'registry.json'), JSON.stringify(registry), 'utf8')

  const cmd = await resolveAgentCommand('faux-binaire', { registryDir })
  assert.equal(cmd.source, 'registry/binary')
  assert.equal(cmd.command, bin, 'le `./` relatif du registry devient un chemin absolu')
  assert.deepEqual(cmd.args, ['acp'])
  assert.ok(!cmd.command.endsWith('.exe'), 'pas de .exe supposé sous Linux')
  assert.ok(statSync(cmd.command).mode & 0o111, 'exécutable, sinon le spawn échouerait en EACCES')

  // Un agent déclaré mais jamais lancé dans Zed n'est pas sur le disque.
  await assert.rejects(() => resolveAgentCommand('jamais-lance', { registryDir }), /introuvable/)
})

test('linux : la découverte liste ce que le registry contient vraiment', { skip: LINUX_ONLY }, async () => {
  const registryDir = join(FIXTURES, 'registry-linux')
  const found = await discoverAgents({ registryDir })
  assert.deepEqual(found.map((a) => a.id).sort(), ['faux-acp', 'faux-binaire'])
  assert.ok(found.every((a) => a.ok), JSON.stringify(found))
})

// ---------------------------------------------------------------------------
// Sur le vrai Zed de cette machine — les faits, pas les fixtures
// ---------------------------------------------------------------------------

test('machine de portage : l’agent que Zed a installé est résolu depuis son vrai registry', { skip: LINUX_ONLY }, async (t) => {
  if (!existsSync(join(PATHS.registryDir, 'registry.json'))) return t.skip(`pas de registry ici : ${PATHS.registryDir}`)
  const registry = JSON.parse(readFileSync(join(PATHS.registryDir, 'registry.json'), 'utf8'))
  // Premier agent réellement installé par Zed sur ce poste (dossier `npx/<id>`).
  const installed = registry.agents.find((a) => existsSync(join(PATHS.registryDir, 'npx', a.id)))
  if (!installed) return t.skip('Zed n’a encore installé aucun agent de son registry sur ce poste')

  const cmd = await resolveAgentCommand(installed.id, { registryDir: PATHS.registryDir })
  assert.equal(cmd.source, 'registry/npx', `agent « ${installed.id} » résolu depuis le disque`)
  assert.equal(cmd.command, process.execPath)
  assert.ok(existsSync(cmd.args[0]), `point d'entrée absent : ${cmd.args[0]}`)
})

test('machine de portage : isZedRunning dit ce que pgrep dit', { skip: LINUX_ONLY }, async () => {
  // `pgrep -x zed` ne trouvait rien alors que Zed était ouvert : le processus
  // s'appelle `zed-editor`. Le test compare à la vérité du système, quelle
  // qu'elle soit, pour ne pas dépendre d'un Zed ouvert ou fermé.
  const truth = await run('sh', ['-c', 'pgrep -x zed-editor || pgrep -x zed || true'])
  assert.equal(await isZedRunning(), truth.stdout.trim().length > 0)
})

// ---------------------------------------------------------------------------
// Enregistrements du shim : le mécanisme de surcharge est conservé
// ---------------------------------------------------------------------------

test('linux : ZRA_RECORD_DIR garde la main sur le dossier des trames', { skip: LINUX_ONLY }, async (t) => {
  // Inventaire A : `zra-shim/record.js` était déjà surchargeable par
  // `ZRA_RECORD_DIR`, ce mécanisme ne change pas. Seul le défaut suit XDG.
  const dir = mkdtempSync(join(tmpdir(), 'zra-record-linux-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const prev = process.env.ZRA_RECORD_DIR
  process.env.ZRA_RECORD_DIR = dir
  try {
    const rec = createRecorder({ enabled: true, agentId: 'faux-acp' })
    assert.equal(dirname(rec.file), dir, 'la variable prime sur le défaut XDG')
    rec.write('zed→agent', Buffer.from('{"id":1,"method":"initialize"}\n'))
    rec.close()
    await new Promise((r) => setTimeout(r, 50))
    assert.ok(existsSync(rec.file), `trame attendue : ${rec.file}`)
    assert.equal(JSON.parse(readFileSync(rec.file, 'utf8').trim()).direction, 'zed→agent')
  } finally {
    if (prev === undefined) delete process.env.ZRA_RECORD_DIR
    else process.env.ZRA_RECORD_DIR = prev
  }
  assert.equal(PATHS.recordsDir, join(PATHS.appDir, 'records'))
})
