// Index des threads — lecture de `sidebar_threads`.
//
// Ouverture **toujours** en lecture seule (`readOnly`). Le fichier
// est en WAL et Zed tourne en parallèle : jamais de connexion en écriture,
// jamais de lock. Poll toutes les 2 s, diff, et on ne pousse que si ça a bougé.

import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

import { logger } from './log.js'
import { tr } from './i18n.js'

const log = logger('threads')

/** Sans ces colonnes, l'index n'a plus de sens : on dégrade en « live seul ». */
const REQUIRED = ['thread_id', 'session_id', 'agent_id', 'title', 'updated_at']
/** Lues si présentes — une mise à jour de Zed peut les faire disparaître. */
const OPTIONAL = ['created_at', 'folder_paths', 'folder_paths_order', 'archived', 'interacted_at', 'title_override', 'remote_connection',
  'main_worktree_paths', 'main_worktree_paths_order']

/**
 * Normalise une date Zed en ISO 8601.
 *
 * Zed écrit du RFC 3339 à la nanoseconde (`...:58.919960600+00:00`) ; SQLite
 * peut aussi produire `YYYY-MM-DD HH:MM:SS`, interprété en UTC (protocole §2).
 */
export function toIso(value) {
  if (value === null || value === undefined || value === '') return null
  const raw = String(value).trim()

  let candidate = raw
  if (!candidate.includes('T') && candidate.includes(' ')) candidate = candidate.replace(' ', 'T') + 'Z'

  let d = new Date(candidate)
  if (Number.isNaN(d.getTime())) {
    // Repli : fraction de seconde trop longue pour un parseur strict.
    d = new Date(candidate.replace(/\.(\d{3})\d+/, '.$1'))
  }
  return Number.isNaN(d.getTime()) ? raw : d.toISOString()
}

/**
 * `folder_paths` et `folder_paths_order` (`PathList` de Zed) : chemins triés,
 * séparés par `\n`, et pour chacun son rang d'affichage (`"1,0"`). Rendus dans
 * l'ordre d'affichage, celui des noms de fenêtre et du `cwd` passé à l'agent.
 *
 * On ne découpe que si l'ordre annonce plusieurs entrées **et** que le découpage
 * retombe sur le bon compte — un chemin Windows peut contenir une virgule, et se
 * tromper vaut pire qu'un chemin unique.
 */
export function splitFolderPaths(raw, order) {
  if (raw === null || raw === undefined || raw === '') return []
  const text = String(raw)
  const ranks = order ? String(order).split(',').map((x) => x.trim()).filter((x) => x !== '') : []
  if (ranks.length <= 1) return [text]
  // Saut de ligne d'abord : aucun chemin n'en contient.
  for (const sep of ['\n', ',']) {
    const parts = text.split(sep).map((p) => p.trim()).filter(Boolean)
    if (parts.length !== ranks.length) continue
    // Rangs invalides : Zed retombe sur l'ordre trié (`PathList::deserialize`).
    const n = ranks.map(Number)
    const valid = [...n].sort((x, y) => x - y).every((r, i) => r === i)
    return valid ? parts.map((p, i) => [n[i], p]).sort((x, y) => x[0] - y[0]).map((e) => e[1]) : parts
  }
  return [text]
}

/** Chemin comparable : Windows ne distingue ni la casse ni les séparateurs. */
export function normPath(p) {
  return String(p).replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase()
}

/** Identité d'un projet : ses dossiers, sans ordre (égalité de `PathList`). */
export const projectKey = (paths) => paths.map(normPath).sort().join('|')

/** Titre affiché par Zed quand il n'en a pas (`DEFAULT_THREAD_TITLE`). */
export const DEFAULT_THREAD_TITLE = 'New Agent Thread'

/**
 * Titre d'une ligne, lu comme Zed (`impl Column for ThreadMetadata`) : un
 * `title_override` vide est ignoré, un `title` vide ou égal au titre par défaut
 * vaut absent. Absent : `''`.
 */
export function zedTitle(row) {
  const override = row.title_override ? String(row.title_override) : ''
  const title = row.title ? String(row.title) : ''
  return override || (title === DEFAULT_THREAD_TITLE ? '' : title)
}

/** Date qui ordonne et date un thread dans le sidebar de Zed (`thread_display_time`). */
export const displayTime = (t) => t.interactedAt ?? t.updatedAt

function hex(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return value
  return Buffer.from(value).toString('hex')
}

export class ThreadsIndex extends EventEmitter {
  /**
   * @param {{ file:string, pollMs?:number, shims?:import('./shim-registry.js').ShimRegistry,
   *   zedRunning?:()=>boolean, isDeleted?:(sessionId:string)=>boolean,
   *   renameOverlay?:(sessionId:string)=>string|null }} opts `zedRunning` : Zed fermé, aucun projet
   *   n'est ouvert, quoi que dise la base (elle garde la dernière session).
   *   `isDeleted` : sessions supprimées par ACP, masquées (`thread-ops.js`) ;
   *   `renameOverlay` : titre rendu par l'agent, superposé en attendant Zed.
   */
  constructor({ file, pollMs = 2000, shims = null, zedRunning = () => true, isDeleted = () => false, renameOverlay = () => null }) {
    super()
    this.file = file
    this.zedRunning = zedRunning
    this.isDeleted = isDeleted
    this.renameOverlay = renameOverlay
    this.pollMs = pollMs
    this.shims = shims
    this.db = null
    this.columns = []
    /** @type {import('./protocol.js').ThreadSummary[]} */
    this.threads = []
    /**
     * Projets du sidebar de Zed, dans son ordre (`readZedProjects`) ; `null` si
     * la base ne le dit pas.
     * @type {Array<{folderPaths:string[], open:boolean}>|null}
     */
    this.projects = null
    /** Cause de dégradation, exposée pour le diagnostic. */
    this.degraded = null
    this.timer = null
    this.snapshot = ''
    this.raw = new Map()
    /**
     * Sessions rattachées par ZRA à un thread neuf. Zed écrit la ligne dès la
     * création, mais son `session_id` reste NULL jusqu'au premier message ;
     * le shim, lui, a vu passer la session. `threadId` → `sessionId`, oublié
     * dès que Zed écrit le sien.
     * @type {Map<string, string>}
     */
    this.provisional = new Map()

    // Un shim qui apparaît ou disparaît change l'état `live` sans toucher à la
    // base : il faut re-projeter immédiatement, sans attendre le poll.
    this.onShims = () => this.refresh({ force: true })
    shims?.on('change', this.onShims)
  }

  open() {
    if (this.db) return true
    if (!existsSync(this.file)) {
      this.degrade(tr`Base introuvable : ${this.file}`)
      return false
    }
    try {
      // Chemin brut + `readOnly` (SQLITE_OPEN_READONLY), pas d'URI `file:` :
      // les premiers Node 22 unflaggés (22.13…) la prennent pour un nom de
      // fichier littéral => « unable to open database file ».
      this.db = new DatabaseSync(this.file, { readOnly: true })
      this.columns = this.readColumns()
      // De quoi savoir quels projets sont ouverts ; décidé ici, pas selon que Zed tourne.
      const tables = new Set(this.db.prepare("select name from sqlite_master where type='table'").all().map((r) => r.name))
      this.noWorkspaces = !(tables.has('kv_store') && tables.has('workspaces'))
      this.noScopedKv = !tables.has('scoped_kv_store')
      const missing = REQUIRED.filter((c) => !this.columns.includes(c))
      if (missing.length) {
        this.close()
        this.degrade(tr`Schéma sidebar_threads inattendu — colonnes manquantes : ${missing.join(', ')}. Une mise à jour de Zed a probablement changé la table. Dégradation en « live seul ».`)
        return false
      }
      this.degraded = null
      return true
    } catch (err) {
      this.close()
      this.degrade(tr`Ouverture impossible : ${err.message}`)
      return false
    }
  }

  readColumns() {
    const table = this.db.prepare("select name from sqlite_master where type='table' and name='sidebar_threads'").get()
    if (!table) return []
    return this.db.prepare('pragma table_info(sidebar_threads)').all().map((c) => c.name)
  }

  degrade(reason) {
    if (this.degraded === reason) return
    this.degraded = reason
    log.warn(reason)
    this.threads = []
    this.raw = new Map()
    this.projects = null
    this.snapshot = ''
    this.emit('degraded', reason)
    this.emit('change', this.threads)
  }

  close() {
    try { this.db?.close() } catch { /* déjà fermée */ }
    this.db = null
  }

  /** Lit toutes les lignes et les projette en `ThreadSummary` (protocole §4). */
  read() {
    // Arrêté : un rappel tardif (présence de Zed) ne doit pas rouvrir la base.
    if (this.stopped) return this.threads
    if (!this.open()) return []
    const cols = [...REQUIRED, ...OPTIONAL].filter((c) => this.columns.includes(c))
    let rows
    try {
      rows = this.db.prepare(`select ${cols.join(', ')} from sidebar_threads`).all()
    } catch (err) {
      // Base remplacée sous nos pieds (mise à jour de Zed) : on rouvre une fois.
      log.debug(tr`Relecture après erreur SQLite :`, err.message)
      this.close()
      if (!this.open()) return []
      try {
        rows = this.db.prepare(`select ${cols.join(', ')} from sidebar_threads`).all()
      } catch (err2) {
        this.degrade(tr`Lecture impossible : ${err2.message}`)
        return []
      }
    }

    const live = this.shims ? this.shims.liveSessionIds() : new Set()
    // Dépôt principal de chaque worktree lié : son espace de travail ouvre le
    // groupe du dépôt (`ProjectGroupKey` de Zed).
    const mainOf = new Map()
    for (const r of rows) {
      const main = splitFolderPaths(r.main_worktree_paths, r.main_worktree_paths_order)
      if (main.length) mainOf.set(projectKey(splitFolderPaths(r.folder_paths, r.folder_paths_order)), main)
    }
    this.projects = this.readZedProjects(mainOf)
    const open = this.projects && this.openKeys

    /** Titres bruts de la base (sans superposition), pour `ThreadOps.reconcile`. */
    this.raw = new Map()
    const threads = rows.map((r) => {
      // Supprimé côté agent par ACP : la ligne de Zed reste (cache), on la masque.
      if (r.session_id && this.isDeleted(r.session_id)) return null
      const threadId = hex(r.thread_id)
      const folderPaths = splitFolderPaths(r.folder_paths, r.folder_paths_order)
      // Dossiers du dépôt principal : un worktree git lié reste groupé sous son
      // projet (`ThreadMetadata::main_worktree_paths`). Absent s'il est identique.
      const mainPaths = splitFolderPaths(r.main_worktree_paths, r.main_worktree_paths_order)
      if (r.session_id) this.provisional.delete(threadId)
      const sessionId = r.session_id ?? this.provisional.get(threadId) ?? null
      if (r.session_id) this.raw.set(r.session_id, { title: zedTitle(r), override: r.title_override ? String(r.title_override) : null })
      const overlay = sessionId ? this.renameOverlay(sessionId) : null
      return {
        threadId,
        sessionId,
        agentId: r.agent_id ?? null,
        title: overlay ?? zedTitle(r),
        // Renommé par l'utilisateur dans Zed : ce titre prime sur celui que
        // l'agent annonce en direct (`session_info_update`).
        titleOverridden: Boolean(r.title_override),
        folderPaths,
        ...(mainPaths.length && projectKey(mainPaths) !== projectKey(folderPaths) ? { mainPaths } : {}),
        updatedAt: toIso(r.updated_at),
        // Dernière interaction de l'utilisateur dans Zed : ce qui ordonne et date
        // le sidebar (`thread_display_time`).
        interactedAt: toIso(r.interacted_at),
        createdAt: toIso(r.created_at),
        archived: Boolean(r.archived),
        // Projet distant (SSH, WSL) : l'agent tourne sur un autre hôte.
        remote: Boolean(r.remote_connection),
        // Projet ouvert dans une fenêtre Zed ; `null` si la base ne le dit pas.
        projectOpen: open ? open.has(projectKey(folderPaths)) : null,
        // `unknown` = session_id NULL : brouillon de Zed (`ThreadMetadata::is_draft`).
        state: !sessionId ? 'unknown' : live.has(sessionId) ? 'live' : 'closed',
      }
    }).filter(Boolean)

    threads.sort((a, b) => String(displayTime(b) ?? '').localeCompare(String(displayTime(a) ?? '')))
    return threads
  }

  /** Titre brut de la base pour une session (sans superposition), ou `null`. */
  rawOf(sessionId) {
    return this.raw?.get(sessionId) ?? null
  }

  /**
   * Projets du sidebar de Zed, dans son ordre, relevés dans sa base.
   *
   * `kv_store.session_id` est la session de Zed (la dernière si Zed est fermé) ;
   * chaque espace de travail chargé est une ligne de `workspaces` qui la porte,
   * avec sa fenêtre (`window_id`). Les groupes du sidebar d'une fenêtre sont dans
   * `scoped_kv_store` (`multi_workspace_state`, clé `window_id`), dans l'ordre
   * affiché ; un groupe sans espace de travail chargé est fermé. Zed ne réécrit
   * cette entrée qu'à un changement du sidebar, et Windows réutilise les
   * `window_id` : une entrée dont l'espace actif n'est pas de la fenêtre date
   * d'une autre session, on s'en tient alors aux espaces chargés.
   * Fenêtres : la plus récemment touchée d'abord (`session_window_stack`
   * n'existe pas sous Windows).
   * @param {Map<string,string[]>} mainOf clé d'un worktree lié → dossiers de son dépôt
   * @returns {Array<{folderPaths:string[], open:boolean}>|null} `null` si la base ne le dit pas
   */
  readZedProjects(mainOf = new Map()) {
    // Tables absentes (autre version de Zed), ou illisibles : on ne devine pas.
    if (this.noWorkspaces) return null
    try {
      const session = this.db.prepare("select value from kv_store where key = 'session_id'").get()?.value
      this.openKeys = new Set()
      if (!session) return []
      const rows = this.db.prepare(
        'select workspace_id, paths, paths_order, window_id, timestamp from workspaces where session_id = ? and remote_connection_id is null order by timestamp desc',
      ).all(session)
      const windows = new Map()
      for (const r of rows) {
        const w = windows.get(r.window_id) ?? { ids: new Set(), loaded: [] }
        windows.set(r.window_id, w)
        w.ids.add(r.workspace_id)
        const paths = splitFolderPaths(r.paths, r.paths_order)
        if (paths.length) w.loaded.push(mainOf.get(projectKey(paths)) ?? paths)
      }
      const states = this.noScopedKv ? null : this.db.prepare(
        "select value from scoped_kv_store where namespace = 'multi_workspace_state' and key = ?",
      )

      const running = this.zedRunning()
      // Dossiers chargés tels quels (un worktree lié n'est pas son dépôt) : `projectOpen`.
      this.openKeys = new Set(running ? rows.map((r) => splitFolderPaths(r.paths, r.paths_order)).filter((p) => p.length).map(projectKey) : [])
      const projects = new Map()
      for (const [windowId, w] of windows) {
        const loaded = new Set(w.loaded.map(projectKey))
        let state = null
        try { state = windowId !== null && states ? JSON.parse(states.get(String(windowId))?.value ?? 'null') : null } catch { /* illisible */ }
        const fresh = state && w.ids.has(state.active_workspace_id) && Array.isArray(state.project_groups)
        // Un espace chargé a toujours son groupe chez Zed (`ensure_project_group_state`) :
        // ceux que l'entrée ne cite pas (vide, périmée) suivent.
        const groups = fresh
          ? state.project_groups.filter((g) => g?.location === 'Local' && g.path_list)
            .map((g) => splitFolderPaths(g.path_list.paths, g.path_list.order)).filter((p) => p.length)
          : []
        for (const folderPaths of [...groups, ...w.loaded]) {
          const k = projectKey(folderPaths)
          const open = running && loaded.has(k)
          const known = projects.get(k)
          if (known) known.open ||= open
          else projects.set(k, { folderPaths, open })
        }
      }
      return [...projects.values()]
    } catch (err) {
      // Schéma d'une autre version de Zed : on ne sait pas, on ne devine pas.
      log.debug(tr`Projets ouverts illisibles :`, err.message)
      this.noWorkspaces = true
      return null
    }
  }

  /** Relit et n'émet `change` que si la projection a bougé. */
  refresh({ force = false } = {}) {
    const threads = this.read()
    const snapshot = JSON.stringify([threads, this.projects])
    if (!force && snapshot === this.snapshot) return false
    const changed = snapshot !== this.snapshot
    this.threads = threads
    this.snapshot = snapshot
    if (changed) this.emit('change', threads)
    return changed
  }

  start() {
    this.refresh({ force: true })
    this.timer = setInterval(() => {
      try { this.refresh() } catch (err) { log.warn(tr`Poll :`, err.message) }
    }, this.pollMs)
    this.timer.unref?.()
    return this
  }

  stop() {
    this.stopped = true
    clearInterval(this.timer)
    this.timer = null
    this.shims?.off('change', this.onShims)
    this.close()
  }

  get(threadId) {
    return this.threads.find((t) => t.threadId === threadId) || null
  }

  /** Rattache une session à un thread que Zed a écrit sans (voir `provisional`). */
  bindSession(threadId, sessionId) {
    this.provisional.set(threadId, sessionId)
    this.refresh()
  }

  /**
   * Résolution inverse `session_id` → thread : le shim ne connaît que les
   * sessions ACP, la PWA ne connaît que les `threadId` (protocole §2). C'est
   * l'index qui fait le pont, et lui seul.
   */
  getBySession(sessionId) {
    if (!sessionId) return null
    return this.threads.find((t) => t.sessionId === sessionId) || null
  }
}
