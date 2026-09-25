// Lecteur d'index, contre la fixture SQLite — sans Zed installé (spec §10.4).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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

// ---------------------------------------------------------------------------
// Projets ouverts dans Zed (`kv_store.session_id` × `workspaces`)
// ---------------------------------------------------------------------------

test('projets ouverts : fenêtres de la session Zed en cours, et rien quand Zed est fermé', (t) => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'open-projects')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'db.sqlite')
  rmSync(file, { force: true })
  copyFileSync(FIXTURE, file)

  const probe = new ThreadsIndex({ file })
  const paths = probe.read().map((x) => x.folderPaths)
  probe.close()
  const [a, b] = [...new Map(paths.filter((p) => p.length).map((p) => [p.join('|'), p])).values()]
  assert.ok(a && b, 'la fixture a au moins deux projets')

  const db = new DatabaseSync(file)
  db.exec(`create table kv_store (key text primary key, value text);
    create table workspaces (workspace_id integer primary key, paths text, paths_order text,
      remote_connection_id integer, session_id text, timestamp text)`)
  db.prepare("insert into kv_store values ('session_id', 'en-cours')").run()
  const ws = db.prepare('insert into workspaces (paths, paths_order, session_id) values (?, ?, ?)')
  // Projet a : ouvert maintenant, chemin écrit autrement (casse, séparateurs).
  ws.run(a.join('\n').replace(/\\/g, '/').toUpperCase(), a.map((_, i) => i).join(','), 'en-cours')
  // Projet b : resté d'une session précédente — fermé.
  ws.run(b.join('\n'), b.map((_, i) => i).join(','), 'ancienne')
  db.close()

  let running = true
  const index = new ThreadsIndex({ file, zedRunning: () => running })
  t.after(() => { index.stop(); rmSync(file, { force: true }) })
  index.refresh({ force: true })
  const stateOf = (p) => index.threads.find((x) => x.folderPaths.join('|') === p.join('|')).projectOpen
  assert.equal(stateOf(a), true)
  assert.equal(stateOf(b), false)

  running = false
  index.refresh()
  assert.equal(stateOf(a), false, 'Zed fermé : la base garde la dernière session, pas nous')
})

test('projets ouverts : base sans ces tables (autre version de Zed) => projectOpen null', (t) => {
  const index = open(t)
  assert.ok(index.threads.every((x) => x.projectOpen === null))
})
