// Lecteur d'index, contre la fixture SQLite — sans Zed installé (spec §10.4).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ThreadsIndex } from '../threads-index.js'
import { ShimRegistry } from '../shim-registry.js'
import { ensureFixture, FIXTURE } from '../../scripts/make-fixture.mjs'

ensureFixture(FIXTURE)

/** Ouvre l'index sur la fixture, fermé automatiquement en fin de test. */
function open(t, { shims = null, file = FIXTURE } = {}) {
  const index = new ThreadsIndex({ file, pollMs: 50, shims })
  t.after(() => index.stop())
  index.refresh({ force: true })
  return index
}

test('index : projection complète en ThreadSummary', (t) => {
  const index = open(t)
  assert.equal(index.threads.length, 6)

  const [first] = index.threads
  // Tri par récence décroissante.
  assert.equal(first.title, 'Refonte du lecteur d’index')
  assert.equal(first.threadId, '0000000000000000000000000000000a', 'BLOB rendu en hexadécimal')
  assert.equal(first.agentId, 'claude-acp')
  assert.equal(first.updatedAt, '2026-09-22T16:35:58.919Z')
  assert.deepEqual(first.folderPaths, ['C:\\Users\\Dev\\Documents\\Développement\\projet-café'])
  assert.equal(first.archived, false)
})

test('index : title_override prime sur title', (t) => {
  const index = open(t)
  const th = index.get('0000000000000000000000000000000b')
  assert.equal(th.title, 'Titre choisi par l’utilisateur')
  assert.equal(th.titleOverridden, true)
  assert.equal(index.get('0000000000000000000000000000000a').titleOverridden, false)
})

test('index : deux dossiers découpés, un seul sinon', (t) => {
  const index = open(t)
  assert.equal(index.get('0000000000000000000000000000000c').folderPaths.length, 2)
  assert.deepEqual(index.get('0000000000000000000000000000000e').folderPaths, [])
})

test('index : états live / closed / unknown', (t) => {
  const shims = new ShimRegistry()
  const index = open(t, { shims })

  // Aucun shim : tout ce qui a une session est `closed`.
  assert.equal(index.get('0000000000000000000000000000000a').state, 'closed')
  // session_id NULL => `unknown`, affiché grisé et jamais masqué (spec §4).
  assert.equal(index.get('0000000000000000000000000000000d').state, 'unknown')

  // Un shim qui apparaît bascule le thread en `live` sans attendre le poll.
  shims.register({ shimId: 's1', agentId: 'claude-acp', sessions: ['aaaaaaaa-0000-4000-8000-000000000001'] })
  assert.equal(index.get('0000000000000000000000000000000a').state, 'live')

  shims.unregister('s1')
  assert.equal(index.get('0000000000000000000000000000000a').state, 'closed')
})

test('index : un thread sans agent reste lisible', (t) => {
  const index = open(t)
  const th = index.get('0000000000000000000000000000000e')
  assert.equal(th.agentId, null)
  assert.equal(th.state, 'closed', 'un agent inconnu n’empêche pas la session d’exister')
  assert.equal(th.updatedAt, '2026-09-19T18:30:00.000Z', 'date SQLite interprétée en UTC')
})

test('index : les archivés sont présents et marqués', (t) => {
  const index = open(t)
  assert.equal(index.get('0000000000000000000000000000000f').archived, true)
})

test('index : `change` n’est émis que si la projection bouge', (t) => {
  const index = open(t)
  let changes = 0
  index.on('change', () => changes++)
  index.refresh()
  index.refresh()
  assert.equal(changes, 0, 'une base inchangée ne réveille pas les clients')
})

test('index : base absente => dégradation explicite, pas de plantage', (t) => {
  const index = open(t, { file: join(tmpdir(), 'zra-inexistante.sqlite') })
  assert.deepEqual(index.threads, [])
  assert.match(index.degraded, /introuvable/)
})

test('index : schéma inattendu => « live seul » annoncé (risque 🟡5)', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'zra-schema-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'db.sqlite')
  const db = new DatabaseSync(file)
  // Colonnes requises manquantes : Zed a changé sa table sous nos pieds.
  db.exec('create table sidebar_threads (thread_id blob primary key, title text)')
  db.close()

  const index = open(t, { file })
  assert.deepEqual(index.threads, [])
  assert.match(index.degraded, /colonnes manquantes.*session_id/s)
})
