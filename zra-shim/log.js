// Journal du shim — **stderr**, et en option un fichier.
//
// La sortie standard du shim est le canal ACP de Zed : un seul `console.log`
// égaré y injecterait une ligne qui n'est pas du JSON-RPC et casserait l'agent.
// D'où ce module minuscule, qui ne partage rien avec `zra-daemon/log.js`.
//
// Zed collecte stderr, mais le mêle à ses propres journaux quand il le garde.
// `ZRA_LOG_FILE` double donc chaque ligne dans un fichier à nous — c'est là
// qu'on lit le shim au test réel. Écriture en flux, jamais bloquante, et une
// erreur de disque n'est jamais fatale.

import { createWriteStream, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 }
const threshold = LEVELS[process.env.ZRA_LOG_LEVEL] ?? LEVELS.info

let file = null
if (process.env.ZRA_LOG_FILE) {
  try {
    mkdirSync(dirname(process.env.ZRA_LOG_FILE), { recursive: true })
    file = createWriteStream(process.env.ZRA_LOG_FILE, { flags: 'a' })
    file.on('error', () => { file = null })
  } catch {
    file = null
  }
}

function emit(level, ...rest) {
  if (LEVELS[level] < threshold) return
  const line = `${new Date().toISOString().slice(11, 23)} ${level.padEnd(5)} zra-shim   ${rest.map(String).join(' ')}\n`
  try {
    process.stderr.write(line)
  } catch { /* stderr fermé : tant pis, jamais fatal */ }
  if (file) {
    // Plusieurs shims peuvent écrire le même fichier : le pid les distingue.
    try { file.write(`${new Date().toISOString().slice(0, 10)} [${process.pid}] ${line}`) } catch { file = null }
  }
}

export const log = {
  debug: (...a) => emit('debug', ...a),
  info: (...a) => emit('info', ...a),
  warn: (...a) => emit('warn', ...a),
  error: (...a) => emit('error', ...a),
}
