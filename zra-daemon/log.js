// Journalisation : console lisible + journal d'injections (spec §9).

import { appendFile, mkdir } from 'node:fs/promises'
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { format } from 'node:util'

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 }
let threshold = LEVELS[process.env.ZRA_LOG_LEVEL] ?? LEVELS.info

export function setLevel(name) {
  if (LEVELS[name]) threshold = LEVELS[name]
}

function emit(level, scope, ...rest) {
  if (LEVELS[level] < threshold) return
  const at = new Date().toISOString().slice(11, 23)
  const line = `${at} ${level.padEnd(5)} ${scope.padEnd(10)}`
  if (level === 'error') console.error(line, ...rest)
  else if (level === 'warn') console.warn(line, ...rest)
  else console.log(line, ...rest)
  if (file) toFile(`${new Date().toISOString().slice(0, 10)} ${line} ${format(...rest)}\n`)
}

// ---- journal sur disque --------------------------------------------------
//
// Lancé par la tâche planifiée, le daemon n'a pas de console : sans fichier, son
// journal serait perdu. Rotation simple — `daemon.log`, `.1`, `.2` — pour ne
// jamais remplir le disque d'un poste qui tourne des mois.

const KEEP = 2
let rotateBytes = 5 * 1024 * 1024
let file = null
let written = 0

/**
 * Double le journal console dans `path` (`null` : console seule).
 *
 * Écriture synchrone, ligne à ligne, sans descripteur gardé ouvert : sous
 * Windows, un fichier ouvert ne se renomme pas, et la rotation échouerait.
 * Le daemon journalise quelques lignes par minute, le coût est nul.
 */
export function setLogFile(path, { maxBytes = 5 * 1024 * 1024 } = {}) {
  file = path || null
  rotateBytes = maxBytes
  if (!file) return
  mkdirSync(dirname(file), { recursive: true })
  try { written = statSync(file).size } catch { written = 0 }
  if (written >= rotateBytes) rotate()
}

function rotate() {
  for (let i = KEEP; i >= 1; i--) {
    const from = i === 1 ? file : `${file}.${i - 1}`
    try { renameSync(from, `${file}.${i}`) } catch { /* absent, ou verrouillé : on écrit quand même */ }
  }
  written = 0
}

function toFile(text) {
  try {
    appendFileSync(file, text, 'utf8')
  } catch {
    // Disque plein, fichier verrouillé : le service passe avant son journal.
    return
  }
  written += Buffer.byteLength(text)
  if (written >= rotateBytes) rotate()
}

/** Logger attaché à un sous-système : `const log = logger('threads')`. */
export function logger(scope) {
  return {
    debug: (...a) => emit('debug', scope, ...a),
    info: (...a) => emit('info', scope, ...a),
    warn: (...a) => emit('warn', scope, ...a),
    error: (...a) => emit('error', scope, ...a),
  }
}

/**
 * Journal d'injections — spec §9 : toute écriture venue du mobile est tracée.
 * Best-effort : une erreur d'écriture ne doit jamais interrompre le service.
 */
export function injectionLog(file) {
  let ready = null
  return async function record(entry) {
    if (!file) return
    const line = JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n'
    try {
      ready ??= mkdir(dirname(file), { recursive: true })
      await ready
      await appendFile(file, line, 'utf8')
    } catch (err) {
      emit('warn', 'log', "journal d'injections indisponible :", err.message)
    }
  }
}
