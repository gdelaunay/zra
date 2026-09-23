// Diagnostic : pourquoi un thread n'est pas vu `live`. Lecture seule.
//
//   node --no-warnings scripts/probe-sessions.mjs pi
//
// Met côte à côte les `session_id` que Zed stocke pour les threads d'un agent
// (sidebar_threads) et ceux que le shim a vus passer (enregistrements de trames,
// `.zra/records/`). `live` exige que les deux coïncident.

import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'

import { loadConfig, ROOT } from '../zra-daemon/config.js'

const needle = (process.argv[2] || '').toLowerCase()
const config = await loadConfig()

console.log(`== Zed (${config.zedDb}) — threads dont l'agent contient « ${needle} »`)
const db = new DatabaseSync(config.zedDb, { readOnly: true })
const rows = db.prepare('select agent_id, session_id, title, updated_at from sidebar_threads order by updated_at desc').all()
for (const r of rows.filter((x) => String(x.agent_id ?? '').toLowerCase().includes(needle)).slice(0, 10)) {
  console.log(`  ${r.updated_at}  ${r.agent_id}  session=${r.session_id}  « ${r.title} »`)
}
db.close()

const dir = join(ROOT, '.zra', 'records')
const files = readdirSync(dir).filter((f) => f.toLowerCase().includes(needle) && f.endsWith('.jsonl')).sort().slice(-3)
for (const f of files) {
  console.log(`\n== shim ${f}`)
  const pending = new Map()
  for (const line of readFileSync(join(dir, f), 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    let rec, m
    try {
      rec = JSON.parse(line)
      m = typeof rec.frame === 'string' ? JSON.parse(rec.frame) : rec.frame
    } catch { continue }
    if (!m) continue
    const dirTag = rec.direction ?? '?'
    if (m.method && m.method !== 'session/update') {
      if (m.id !== undefined) pending.set(m.id, m.method)
      console.log(`  ${dirTag}  ${m.method}${m.params?.sessionId ? `  session=${m.params.sessionId}` : ''}`)
    } else if (m.id !== undefined && pending.has(m.id)) {
      const method = pending.get(m.id)
      pending.delete(m.id)
      const sid = m.result?.sessionId
      console.log(`  ${dirTag}  ← ${method} ${m.error ? `ERREUR ${m.error.message}` : 'ok'}${sid ? `  session=${sid}` : ''}`)
    }
  }
}
