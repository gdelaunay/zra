#!/usr/bin/env node
// Génère la fixture SQLite de l'index des threads (spec §10.4).
//
//   node scripts/make-fixture.mjs
//
// Le schéma est celui relevé sur la machine cible (Zed stable, septembre 2026),
// recopié à l'identique. Les lignes, elles, sont **synthétiques** : plutôt
// qu'anonymiser une copie — et risquer d'y laisser un chemin ou un titre réel —
// on fabrique un jeu qui couvre exactement les cas limites que le lecteur doit
// savoir traiter :
//
//   · session_id NULL            -> state "unknown", grisé côté PWA
//   · agent_id NULL mais session -> thread lisible, icône d'agent inconnue
//   · title_override renseigné   -> prime sur title
//   · archived = 1
//   · folder_paths NULL, unique, et multiple (folder_paths_order "0,1")
//   · dates RFC 3339 à la nanoseconde, et une date au format SQLite
//   · chemins UTF-8 accentués

import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const FIXTURE = join(ROOT, 'zra-daemon', 'test', 'fixtures', 'sidebar_threads.sqlite')

/** DDL relevée telle quelle sur la machine cible. */
const DDL = `CREATE TABLE "sidebar_threads" (
  thread_id BLOB PRIMARY KEY,
  session_id TEXT,
  agent_id TEXT,
  title TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_at TEXT,
  folder_paths TEXT,
  folder_paths_order TEXT,
  archived INTEGER DEFAULT 0,
  main_worktree_paths TEXT,
  main_worktree_paths_order TEXT,
  remote_connection TEXT
, interacted_at TEXT, title_override TEXT) STRICT`

const PROJET = 'C:\\Users\\Dev\\Documents\\Développement\\projet-café'
const AUTRE = 'C:\\Users\\Dev\\Documents\\autre-projet'

/** @type {Array<Record<string, unknown>>} */
export const ROWS = [
  {
    thread_id: '0000000000000000000000000000000a',
    session_id: 'aaaaaaaa-0000-4000-8000-000000000001',
    agent_id: 'claude-acp',
    title: 'Refonte du lecteur d’index',
    updated_at: '2026-09-22T16:35:58.919960600+00:00',
    created_at: '2026-09-22T16:19:12.887216+00:00',
    folder_paths: PROJET,
    folder_paths_order: '0',
    archived: 0,
    title_override: null,
  },
  {
    thread_id: '0000000000000000000000000000000b',
    session_id: 'aaaaaaaa-0000-4000-8000-000000000002',
    agent_id: 'claude-acp',
    title: 'Titre généré par l’agent',
    updated_at: '2026-09-22T16:22:22.358926200+00:00',
    created_at: '2026-09-22T11:12:08.159878+00:00',
    folder_paths: PROJET,
    folder_paths_order: '0',
    archived: 0,
    // Doit primer sur `title` (protocole §4).
    title_override: 'Titre choisi par l’utilisateur',
  },
  {
    thread_id: '0000000000000000000000000000000c',
    session_id: 'aaaaaaaa-0000-4000-8000-000000000003',
    agent_id: 'mistral-vibe',
    title: 'Deux dossiers ouverts',
    updated_at: '2026-09-21T09:00:00.000000000+00:00',
    created_at: '2026-09-21T08:00:00.000000+00:00',
    folder_paths: `${PROJET},${AUTRE}`,
    folder_paths_order: '0,1',
    archived: 0,
    title_override: null,
  },
  {
    thread_id: '0000000000000000000000000000000d',
    // Thread avorté : state "unknown", affiché grisé, jamais masqué (spec §4).
    session_id: null,
    agent_id: 'claude-acp',
    title: 'Thread sans session',
    updated_at: '2026-09-20T12:00:00.000000000+00:00',
    created_at: null,
    folder_paths: PROJET,
    folder_paths_order: '0',
    archived: 0,
    title_override: null,
  },
  {
    thread_id: '0000000000000000000000000000000e',
    session_id: 'aaaaaaaa-0000-4000-8000-000000000005',
    // Agent inconnu : la PWA retombe sur une icône générique.
    agent_id: null,
    title: 'Ancien thread sans agent',
    // Format SQLite, sans fuseau : interprété en UTC (protocole §2).
    updated_at: '2026-09-19 18:30:00',
    created_at: null,
    folder_paths: null,
    folder_paths_order: null,
    archived: 0,
    title_override: null,
  },
  {
    thread_id: '0000000000000000000000000000000f',
    session_id: 'aaaaaaaa-0000-4000-8000-000000000006',
    agent_id: 'claude-acp',
    title: 'Thread archivé',
    updated_at: '2026-09-18T07:15:00.000000000+00:00',
    created_at: null,
    folder_paths: AUTRE,
    folder_paths_order: '0',
    archived: 1,
    title_override: null,
  },
]

export function build(file = FIXTURE) {
  mkdirSync(dirname(file), { recursive: true })
  rmSync(file, { force: true })
  rmSync(`${file}-wal`, { force: true })
  rmSync(`${file}-shm`, { force: true })

  const db = new DatabaseSync(file)
  db.exec(DDL)
  const insert = db.prepare(`insert into sidebar_threads
    (thread_id, session_id, agent_id, title, updated_at, created_at,
     folder_paths, folder_paths_order, archived, main_worktree_paths,
     main_worktree_paths_order, remote_connection, interacted_at, title_override)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)

  for (const r of ROWS) {
    insert.run(
      Buffer.from(r.thread_id, 'hex'),
      r.session_id, r.agent_id, r.title, r.updated_at, r.created_at,
      r.folder_paths, r.folder_paths_order, r.archived,
      r.folder_paths, r.folder_paths_order, null, r.created_at, r.title_override,
    )
  }
  db.close()
  return file
}

/**
 * Garantit une fixture utilisable sans la reconstruire à chaque fois.
 *
 * Le fichier est committé ; on ne le régénère que s'il manque ou s'il a dérivé
 * de `ROWS`. `node --test` lance un process par fichier de test : deux
 * reconstructions simultanées se verrouilleraient mutuellement, d'où le
 * repli silencieux sur le fichier déjà présent.
 */
export function ensureFixture(file = FIXTURE) {
  if (existsSync(file)) {
    try {
      const db = new DatabaseSync(file, { readOnly: true })
      const { n } = db.prepare('select count(*) n from sidebar_threads').get()
      db.close()
      if (n === ROWS.length) return file
    } catch { /* fixture illisible : on la refait */ }
  }
  try {
    return build(file)
  } catch (err) {
    if (existsSync(file)) return file // un autre process l'écrit au même instant
    throw err
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('make-fixture.mjs')) {
  console.log(`fixture écrite : ${build()} (${ROWS.length} lignes)`)
}
