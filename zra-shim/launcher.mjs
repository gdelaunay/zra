// zra-shim/launcher.mjs — preload node injecté par l'env de l'entrée registry.
//
// Chargé par `NODE_OPTIONS=--import data:text/javascript,…` (posé par
// `scripts/setup.mjs`) avant le code de l'agent. Coquille : spawn le shim
// autour de la commande que Zed allait lancer — ce node, ce script, ces
// arguments — stdio inherit, et sort avec le code de sortie de l'enfant. Le
// code de l'agent ne tourne jamais dans ce processus.
//
// **Fail-open, règle absolue** : toute erreur — fichier introuvable, spawn
// raté, exception — ne fait rien et laisse l'agent démarrer ici, sans ZRA.
// ZRA supprimé : l'import dynamique du payload échoue, ce fichier n'est même
// pas chargé.
//
// Journal : fichier ZRA uniquement, jamais stdout (c'est le canal ACP de Zed).

import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SHIM = fileURLToPath(new URL('./index.js', import.meta.url))

function journal(msg) {
  const file = process.env.ZRA_LOG_FILE
  if (!file) return
  try {
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, `${new Date().toISOString()} [${process.pid}] launcher  ${msg}\n`)
  } catch { /* erreur de disque : jamais fatale */ }
}

// Filet async le temps du lancement : un rejet non rattrapé tuerait node avant
// le code de l'agent. Retiré quand on laisse la main à l'agent (fail-open) :
// ses propres exceptions doivent garder le comportement par défaut de node.
const swallow = (err) => journal(`exception : ${err?.stack || err}`)
process.on('uncaughtException', swallow)
process.on('unhandledRejection', swallow)

try {
  // ZRA_SHIMMED : déjà enveloppé (double preload) — ne rien faire. Sans script
  // principal (`node -e`, REPL) : rien à envelopper non plus.
  if (!process.env.ZRA_SHIMMED && process.argv[1] && existsSync(SHIM)) {
    const args = [SHIM, '--', process.execPath, process.argv[1], ...process.argv.slice(2)]
    const env = { ...process.env, ZRA_SHIMMED: '1' }
    // Pas de re-preload en cascade : ni l'agent ni ses sous-process node
    // (ex. le CLI claude) ne reçoivent NODE_OPTIONS.
    delete env.NODE_OPTIONS
    const child = spawn(process.execPath, args, { stdio: 'inherit', env, windowsHide: true })
    // Zed coupe le launcher comme il couperait l'agent : on transmet.
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      process.on(sig, () => { try { child.kill(sig) } catch { /* déjà mort */ } })
    }
    const code = await new Promise((resolve, reject) => {
      child.on('error', reject)
      child.on('exit', (code) => resolve(code ?? 0))
    })
    process.exit(code)
  }
} catch (err) {
  journal(`fail-open : ${err?.stack || err}`)
} finally {
  process.removeListener('uncaughtException', swallow)
  process.removeListener('unhandledRejection', swallow)
}