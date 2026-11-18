// Lecteur d'index, contre la fixture SQLite — sans Zed installé.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ThreadsIndex } from '../threads-index.js'
import { ShimRegistry } from '../shim-registry.js'
import { ensureFixture, FIXTURE, buildCustom } from '../../scripts/make-fixture.mjs'

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
  // session_id NULL => `unknown` : brouillon, que la PWA ne liste pas.
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

test('index : schéma inattendu => « live seul » annoncé', (t) => {
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
      remote_connection_id integer, session_id text, window_id integer, timestamp text)`)
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
  assert.equal(index.projects, null)
})

/**
 * Base avec le sidebar de Zed : `workspaces` de la session en cours et
 * `multi_workspace_state` par fenêtre (`scoped_kv_store`).
 * @param {{ ws:Array<[number, string, number, string]>, states?:Record<number, object>, rows?:object[] }} spec
 *   `ws` : [workspace_id, paths, window_id, timestamp]
 */
function sidebarDb(t, name, { ws, states = {}, rows = [] }) {
  const file = buildCustom(join(dirname(FIXTURE), `${name}.sqlite`), rows)
  const db = new DatabaseSync(file)
  db.exec(`create table kv_store (key text primary key, value text);
    create table scoped_kv_store (namespace text, key text, value text, primary key (namespace, key));
    create table workspaces (workspace_id integer primary key, paths text, paths_order text,
      remote_connection_id integer, session_id text, window_id integer, timestamp text)`)
  db.prepare("insert into kv_store values ('session_id', 'en-cours')").run()
  const insert = db.prepare("insert into workspaces values (?, ?, '0', null, 'en-cours', ?, ?)")
  for (const [id, paths, win, ts] of ws) insert.run(id, paths, win, ts)
  const state = db.prepare("insert into scoped_kv_store values ('multi_workspace_state', ?, ?)")
  for (const [win, value] of Object.entries(states)) state.run(win, JSON.stringify(value))
  db.close()
  return file
}

const group = (paths) => ({ path_list: { paths, order: '0' }, location: 'Local', expanded: true })

test('sidebar de Zed : groupes dans son ordre, un groupe non chargé est fermé', (t) => {
  const file = sidebarDb(t, 'sidebar-ordre', {
    ws: [[1, 'C:/zra', 7, '2026-11-18 10:00:00'], [2, 'C:/autre', 9, '2026-11-18 09:00:00']],
    states: {
      7: { active_workspace_id: 1, project_groups: [group('C:/runtimes'), group('C:/zra')] },
      9: { active_workspace_id: 2, project_groups: [group('C:/autre'), group('C:/zra')] },
    },
  })
  const index = open(t, { file })
  assert.deepEqual(index.projects, [
    { folderPaths: ['C:/runtimes'], open: false },
    { folderPaths: ['C:/zra'], open: true },
    { folderPaths: ['C:/autre'], open: true },
  ])
})

test('sidebar de Zed : entrée d’une autre session (window_id réutilisé) => espaces chargés', (t) => {
  const file = sidebarDb(t, 'sidebar-perime', {
    ws: [[1, 'C:/zra', 7, '2026-11-18 10:00:00']],
    states: { 7: { active_workspace_id: 232, project_groups: [group('C:/logos')] } },
  })
  const index = open(t, { file })
  assert.deepEqual(index.projects, [{ folderPaths: ['C:/zra'], open: true }])
})

test('sidebar de Zed : un espace chargé absent de l’entrée suit ses groupes', (t) => {
  const file = sidebarDb(t, 'sidebar-vide', {
    ws: [[1, 'C:/zra', 7, '2026-11-18 10:00:00']],
    states: { 7: { active_workspace_id: 1, project_groups: [] } },
  })
  const index = open(t, { file })
  assert.deepEqual(index.projects, [{ folderPaths: ['C:/zra'], open: true }])
})

test('sidebar de Zed : worktree lié chargé => le groupe de son dépôt est ouvert', (t) => {
  const file = sidebarDb(t, 'sidebar-worktree', {
    rows: [{ thread_id: '01', session_id: 's1', agent_id: 'a', title: 'wt', updated_at: '2026-11-18T10:00:00Z', folder_paths: 'C:/p-wt', main_worktree_paths: 'C:/p' }],
    ws: [[1, 'C:/p-wt', 7, '2026-11-18 10:00:00']],
  })
  const index = open(t, { file })
  assert.deepEqual(index.projects, [{ folderPaths: ['C:/p'], open: true }])
  assert.equal(index.get('01').projectOpen, true, 'les dossiers du thread sont chargés tels quels')
})

test('sidebar de Zed : Zed fermé => la dernière session, tout fermé', (t) => {
  const file = sidebarDb(t, 'sidebar-ferme', {
    ws: [[1, 'C:/zra', 7, '2026-11-18 10:00:00']],
    states: { 7: { active_workspace_id: 1, project_groups: [group('C:/runtimes'), group('C:/zra')] } },
  })
  const index = new ThreadsIndex({ file, zedRunning: () => false })
  t.after(() => index.stop())
  index.refresh({ force: true })
  assert.deepEqual(index.projects, [{ folderPaths: ['C:/runtimes'], open: false }, { folderPaths: ['C:/zra'], open: false }])
})

test('sidebar de Zed : un changement du seul sidebar émet `change`', (t) => {
  const file = sidebarDb(t, 'sidebar-change', {
    ws: [[1, 'C:/zra', 7, '2026-11-18 10:00:00']],
    states: { 7: { active_workspace_id: 1, project_groups: [group('C:/zra')] } },
  })
  const index = open(t, { file })
  let changes = 0
  index.on('change', () => changes++)
  const db = new DatabaseSync(file)
  db.prepare("update scoped_kv_store set value = ? where key = '7'")
    .run(JSON.stringify({ active_workspace_id: 1, project_groups: [group('C:/autre'), group('C:/zra')] }))
  db.close()
  index.refresh()
  assert.equal(changes, 1)
  assert.equal(index.projects[0].folderPaths[0], 'C:/autre')
})

test('index : tri sur interacted_at à défaut d’updated_at, dépôt principal des worktrees (comme Zed)', (t) => {
  const file = buildCustom(join(dirname(FIXTURE), 'list-zed.sqlite'), [
    { thread_id: '01', session_id: 's1', agent_id: 'a', title: 'récent pour l’agent', updated_at: '2026-11-18T10:00:00Z', interacted_at: '2026-11-01T10:00:00Z', folder_paths: 'C:/p' },
    { thread_id: '02', session_id: 's2', agent_id: 'a', title: 'touché par l’utilisateur', updated_at: '2026-11-10T10:00:00Z', interacted_at: '2026-11-17T10:00:00Z', folder_paths: 'C:/p-wt', main_worktree_paths: 'C:/p' },
  ])
  const index = open(t, { file })
  assert.deepEqual(index.threads.map((x) => x.title), ['touché par l’utilisateur', 'récent pour l’agent'])
  assert.deepEqual(index.get('02').mainPaths, ['C:/p'], 'worktree lié : son dépôt principal')
  assert.equal(index.get('01').mainPaths, undefined, 'identique aux dossiers : absent')
  assert.equal(index.get('02').interactedAt, '2026-11-17T10:00:00.000Z')
})
