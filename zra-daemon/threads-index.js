// Index des threads — lecture de `sidebar_threads` (spec §2.1).
//
// Ouverture **toujours** en lecture seule via URI `file:...?mode=ro`. Le fichier
// est en WAL et Zed tourne en parallèle : jamais de connexion en écriture,
// jamais de lock. Poll toutes les 2 s, diff, et on ne pousse que si ça a bougé.

import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'

import { logger } from './log.js'

const log = logger('threads')

/** Sans ces colonnes, l'index n'a plus de sens : on dégrade en « live seul ». */
const REQUIRED = ['thread_id', 'session_id', 'agent_id', 'title', 'updated_at']
/** Lues si présentes — une mise à jour de Zed peut les faire disparaître (risque 🟡5). */
const OPTIONAL = ['created_at', 'folder_paths', 'folder_paths_order', 'archived', 'interacted_at', 'title_override']

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
 * `folder_paths` accolé à `folder_paths_order` (une liste d'indices séparés par
 * des virgules). On ne découpe que si l'ordre annonce plusieurs entrées **et**
 * que le découpage retombe sur le bon compte — un chemin Windows peut contenir
 * une virgule, et se tromper vaut pire qu'un chemin unique (risque 🟡7).
 */
export function splitFolderPaths(raw, order) {
  if (raw === null || raw === undefined || raw === '') return []
  const text = String(raw)
  const count = order ? String(order).split(',').filter((x) => x.trim() !== '').length : 1
  if (count <= 1) return [text]
  const parts = text.split(',').map((p) => p.trim()).filter(Boolean)
  return parts.length === count ? parts : [text]
}

function hex(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return value
  return Buffer.from(value).toString('hex')
}

export class ThreadsIndex extends EventEmitter {
  /**
   * @param {{ file:string, pollMs?:number, shims?:import('./shim-registry.js').ShimRegistry }} opts
   */
  constructor({ file, pollMs = 2000, shims = null }) {
    super()
    this.file = file
    this.pollMs = pollMs
    this.shims = shims
    this.db = null
    this.columns = []
    /** @type {import('./protocol.js').ThreadSummary[]} */
    this.threads = []
    /** Cause de dégradation, exposée pour le diagnostic. */
    this.degraded = null
    this.timer = null
    this.snapshot = ''

    // Un shim qui apparaît ou disparaît change l'état `live` sans toucher à la
    // base : il faut re-projeter immédiatement, sans attendre le poll.
    this.onShims = () => this.refresh({ force: true })
    shims?.on('change', this.onShims)
  }

  open() {
    if (this.db) return true
    if (!existsSync(this.file)) {
      this.degrade(`base introuvable : ${this.file}`)
      return false
    }
    try {
      const uri = pathToFileURL(this.file).href + '?mode=ro'
      this.db = new DatabaseSync(uri, { readOnly: true })
      this.columns = this.readColumns()
      const missing = REQUIRED.filter((c) => !this.columns.includes(c))
      if (missing.length) {
        this.close()
        this.degrade(
          `schéma sidebar_threads inattendu — colonnes manquantes : ${missing.join(', ')}. ` +
          'Une mise à jour de Zed a probablement changé la table (risque 🟡5). Dégradation en « live seul ».',
        )
        return false
      }
      this.degraded = null
      return true
    } catch (err) {
      this.close()
      this.degrade(`ouverture impossible : ${err.message}`)
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
    if (!this.open()) return []
    const cols = [...REQUIRED, ...OPTIONAL].filter((c) => this.columns.includes(c))
    let rows
    try {
      rows = this.db.prepare(`select ${cols.join(', ')} from sidebar_threads`).all()
    } catch (err) {
      // Base remplacée sous nos pieds (mise à jour de Zed) : on rouvre une fois.
      log.debug('relecture après erreur SQLite :', err.message)
      this.close()
      if (!this.open()) return []
      try {
        rows = this.db.prepare(`select ${cols.join(', ')} from sidebar_threads`).all()
      } catch (err2) {
        this.degrade(`lecture impossible : ${err2.message}`)
        return []
      }
    }

    const live = this.shims ? this.shims.liveSessionIds() : new Set()

    const threads = rows.map((r) => {
      const sessionId = r.session_id ?? null
      return {
        threadId: hex(r.thread_id),
        sessionId,
        agentId: r.agent_id ?? null,
        title: (r.title_override ?? r.title ?? '').toString(),
        // Renommé par l'utilisateur dans Zed : ce titre prime sur celui que
        // l'agent annonce en direct (`session_info_update`).
        titleOverridden: r.title_override !== null && r.title_override !== undefined && r.title_override !== '',
        folderPaths: splitFolderPaths(r.folder_paths, r.folder_paths_order),
        updatedAt: toIso(r.updated_at),
        createdAt: toIso(r.created_at),
        archived: Boolean(r.archived),
        // `unknown` = session_id NULL (thread avorté) : affiché grisé, jamais masqué.
        state: !sessionId ? 'unknown' : live.has(sessionId) ? 'live' : 'closed',
      }
    })

    threads.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
    return threads
  }

  /** Relit et n'émet `change` que si la projection a bougé. */
  refresh({ force = false } = {}) {
    const threads = this.read()
    const snapshot = JSON.stringify(threads)
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
      try { this.refresh() } catch (err) { log.warn('poll :', err.message) }
    }, this.pollMs)
    this.timer.unref?.()
    return this
  }

  stop() {
    clearInterval(this.timer)
    this.timer = null
    this.shims?.off('change', this.onShims)
    this.close()
  }

  get(threadId) {
    return this.threads.find((t) => t.threadId === threadId) || null
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
