// Journal du shim — **stderr uniquement**.
//
// La sortie standard du shim est le canal ACP de Zed : un seul `console.log`
// égaré y injecterait une ligne qui n'est pas du JSON-RPC et casserait l'agent.
// D'où ce module minuscule, qui ne partage rien avec `zra-daemon/log.js`.
// Zed collecte stderr dans ses journaux : c'est là qu'on lira le shim.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 }
const threshold = LEVELS[process.env.ZRA_LOG_LEVEL] ?? LEVELS.info

function emit(level, ...rest) {
  if (LEVELS[level] < threshold) return
  const at = new Date().toISOString().slice(11, 23)
  try {
    process.stderr.write(`${at} ${level.padEnd(5)} zra-shim   ${rest.map(String).join(' ')}\n`)
  } catch { /* stderr fermé : tant pis, jamais fatal */ }
}

export const log = {
  debug: (...a) => emit('debug', ...a),
  info: (...a) => emit('info', ...a),
  warn: (...a) => emit('warn', ...a),
  error: (...a) => emit('error', ...a),
}
