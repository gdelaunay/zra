// Mode enregistrement — spec §10.3.
//
// `ZRA_RECORD=1` fait vider au shim toutes les trames dans un JSONL horodaté.
// C'est la première chose à activer au test réel : une session enregistrée
// devient une fixture de non-régression, et le seul moyen de savoir ce que Zed
// et l'agent se disent vraiment.
//
// Best-effort comme le reste du shim : si le fichier n'est pas écrivable, on
// laisse tomber l'enregistrement, jamais le relai.

import { createWriteStream, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const LOCALAPPDATA = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')

/** @returns {{ write:(dir:string, raw:Buffer)=>void, close:()=>void, file:string|null }} */
export function createRecorder({ enabled, agentId, dir = process.env.ZRA_RECORD_DIR || join(LOCALAPPDATA, 'zra', 'records') } = {}) {
  if (!enabled) return { write: () => {}, close: () => {}, file: null }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const file = join(dir, `${stamp}-${agentId || 'agent'}-${process.pid}.jsonl`)
  let stream = null
  try {
    mkdirSync(dir, { recursive: true })
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
