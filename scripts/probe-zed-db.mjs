// Exploration : schéma réel de sidebar_threads sur la machine cible.
// Lecture seule, non destructif. Sert à caler zra-daemon/threads-index.js.
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const file = join(process.env.LOCALAPPDATA, 'Zed', 'db', '0-stable', 'db.sqlite')
const uri = pathToFileURL(file).href + '?mode=ro'
const db = new DatabaseSync(uri, { readOnly: true })

console.log(db.prepare("select sql from sqlite_master where name='sidebar_threads'").get().sql)
console.log('---')
for (const r of db.prepare('select * from sidebar_threads order by updated_at desc limit 3').all()) {
  console.log(JSON.stringify({ ...r, thread_id: Buffer.from(r.thread_id).toString('hex') }))
}
console.log('---')
console.log(JSON.stringify(db.prepare('select count(*) c, sum(session_id is null) nulls, sum(archived) arch from sidebar_threads').get()))
console.log(JSON.stringify(db.prepare('select agent_id, count(*) n from sidebar_threads group by agent_id').all()))
console.log('--- croisement session_id / agent_id / archived ---')
console.log(JSON.stringify(db.prepare('select session_id is null sn, agent_id is null an, archived, count(*) n from sidebar_threads group by 1,2,3').all()))
console.log('--- folder_paths multiples ---')
console.log(JSON.stringify(db.prepare('select distinct folder_paths_order, main_worktree_paths_order from sidebar_threads').all()))
console.log(JSON.stringify(db.prepare("select folder_paths from sidebar_threads where folder_paths_order like '%,%' or folder_paths_order like '%1%' limit 5").all()))
console.log('--- titres sans override ---')
console.log(JSON.stringify(db.prepare('select count(*) n from sidebar_threads where title_override is not null').get()))
db.close()
