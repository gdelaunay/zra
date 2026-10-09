// Mode enregistrement — spec §10.3.
//
// `ZRA_RECORD=1` fait vider au shim toutes les trames dans un JSONL horodaté.
// C'est la première chose à activer au test réel : une session enregistrée
// devient une fixture de non-régression, et le seul moyen de savoir ce que Zed
// et l'agent se disent vraiment.
//
// Best-effort comme le reste du shim : si le fichier n'est pas écrivable, on
// laisse tomber l'enregistrement, jamais le relai.

import { createWriteStream, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { PATHS } from '../zra-daemon/platform.js'

/**
 * Âge au-delà duquel un JSONL enregistré est purgé au démarrage du shim.
 * Sans plafond, le mode permanent installé par `npm run setup` remplit le
 * disque sans fin (~55 Mo/semaine mesurés sur le poste de dev).
 */
const RECORD_MAX_AGE_DAYS = 14

/** Best-effort : une purge qui échoue ne doit jamais empêcher d'enregistrer. */
function purge(dir, maxAgeDays) {
  try {
    const cutoff = Date.now() - maxAgeDays * 86_400_000
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.jsonl')) continue
      const file = join(dir, name)
      try {
        if (statSync(file).mtimeMs < cutoff) rmSync(file, { force: true })
      } catch { /* fichier disparu entre-temps */ }
    }
  } catch { /* dossier illisible : pas de purge, tant pis */ }
}

/** @returns {{ write:(dir:string, raw:Buffer)=>void, close:()=>void, file:string|null }} */
export function createRecorder({ enabled, agentId, dir = process.env.ZRA_RECORD_DIR || PATHS.recordsDir, maxAgeDays = RECORD_MAX_AGE_DAYS } = {}) {
  if (!enabled) return { write: () => {}, close: () => {}, file: null }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const file = join(dir, `${stamp}-${agentId || 'agent'}-${process.pid}.jsonl`)
  let stream = null
  try {
    mkdirSync(dir, { recursive: true })
    purge(dir, maxAgeDays)
    stream = createWriteStream(file, { flags: 'a' })
    stream.on('error', () => { stream = null })
  } catch {
    stream = null
  }

  return {
    file,
    /** @param {'zed→agent'|'agent→zed'|'zra→agent'} direction */
    write(direction, raw) {
      if (!stream) return
      try {
        stream.write(JSON.stringify({ at: new Date().toISOString(), direction, frame: raw.toString('utf8').trim() }) + '\n')
      } catch { /* enregistrement best-effort */ }
    },
    close() {
      try { stream?.end() } catch { /* déjà fermé */ }
      stream = null
    },
  }
}
