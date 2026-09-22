// Journalisation : console lisible + journal d'injections (spec §9).

import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

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
