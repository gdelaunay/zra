// Registry des agents et présence de Zed — alimentent le message `machine`.

import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { hostname, platform, release, type as osType } from 'node:os'
import { promisify } from 'node:util'

import { parseJsonc } from './jsonc.js'
import { logger } from './log.js'

const log = logger('agents')
const run = promisify(execFile)

/** Suffixes de convention dans les ids d'agents Zed, retirés pour l'affichage. */
const SUFFIXES = ['-acp', '-vibe', '-cli', '-zra']

/** `claude-acp` -> `Claude`, `mistral-vibe` -> `Mistral`. */
export function agentLabel(id) {
  let s = String(id)
  for (const suffix of SUFFIXES) {
    if (s.endsWith(suffix)) { s = s.slice(0, -suffix.length); break }
  }
  return s.split(/[-_]/).filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ') || String(id)
}

/**
 * Lit `agent_servers` dans le `settings.json` de Zed (spec §6.7).
 *
 * Le fichier est du JSONC : commentaires et virgules traînantes sont la norme
 * dans Zed, `JSON.parse` s'y casse les dents.
 */
export async function readAgents(file) {
  if (!file) return []
  let raw
  try {
    raw = await readFile(file, 'utf8')
  } catch (err) {
    log.debug(`settings.json illisible (${file}) : ${err.message}`)
    return []
  }
  let settings
  try {
    settings = parseJsonc(raw)
  } catch (err) {
    log.warn(`settings.json de Zed non analysable : ${err.message}`)
    return []
  }
  const servers = settings?.agent_servers
  if (!servers || typeof servers !== 'object') return []

  return Object.entries(servers).map(([id, conf]) => ({
    id,
    name: agentLabel(id),
    // `registry` = agent connu de Zed, `custom` = binaire déclaré à la main
    // (c'est par là que passera `zra-shim`, lot B).
    kind: conf?.type ?? null,
  }))
}

/**
 * Zed tourne-t-il ? Utilisé pour le bandeau « Zed fermé » de la PWA.
 *
 * Détection par processus : c'est le seul signal fiable. La présence du fichier
 * `db.sqlite-shm` dirait seulement qu'une connexion SQLite est ouverte — vrai
 * aussi pour nous.
 */
export async function isZedRunning() {
  try {
    if (platform() === 'win32') {
      const { stdout } = await run('tasklist', ['/FI', 'IMAGENAME eq zed.exe', '/NH'], { windowsHide: true })
      return /zed\.exe/i.test(stdout)
    }
    const { stdout } = await run('pgrep', ['-x', platform() === 'darwin' ? 'Zed' : 'zed'])
    return stdout.trim().length > 0
  } catch {
    // `pgrep` sort en 1 quand rien ne correspond : ce n'est pas une erreur.
    return false
  }
}

/** Sonde de présence, mise en cache : inutile de lancer `tasklist` à chaque client. */
export class ZedPresence {
  constructor({ intervalMs = 5000 } = {}) {
    this.intervalMs = intervalMs
    this.running = false
    this.checkedAt = 0
    this.timer = null
    this.listeners = new Set()
  }

  onChange(fn) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  async probe() {
    const running = await isZedRunning()
    this.checkedAt = Date.now()
    if (running !== this.running) {
      this.running = running
      for (const fn of this.listeners) fn(running)
    }
    return running
  }

  start() {
    this.probe().catch(() => {})
    this.timer = setInterval(() => this.probe().catch(() => {}), this.intervalMs)
    this.timer.unref?.()
    return this
  }

  stop() {
    clearInterval(this.timer)
    this.timer = null
  }
}

export function machineName(configured) {
  return configured || hostname()
}

export function osLabel() {
  return `${osType()} ${release()}`
}
