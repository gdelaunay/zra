#!/usr/bin/env node
// Reproduction des « shims fantômes » — ISSUES.md, item `priorité`.
//
//   node scripts/repro-shim-ghosts.mjs [--mode=term|kill|group] [--shims=3] [--port=7899]
//
// Le scénario est celui de la campagne `2fd075c` (Debian 13 / KDE / X11) : Zed se
// ferme, ses shims meurent avec lui, mais le daemon garde leurs entrées au
// registre — `status` annonce des shims pour zéro processus, et `hasSession()`
// reste vrai si longtemps que `hub.send()` n'emprunte jamais la branche
// `zed.reopen(thread)` : envoyer depuis la PWA vers un thread « Zed fermé »
// timeout au lieu de réveiller Zed.
//
// Rien ici n'est bouchonné sauf Zed et l'agent : vrai daemon, vrai WebSocket,
// vrais processus shims lancés comme Zed les lance.
//
// Les trois morts possibles d'un shim :
//
//   term   SIGTERM — le shim transmet à l'agent, l'agent sort, `shim.stop()`
//          ferme le lien puis `process.exit()` : la trame CLOSE part (le plus
//          souvent), le daemon ferme proprement.
//   kill   SIGKILL — l'OS ferme le socket : FIN brut, **sans** trame CLOSE.
//          C'est le cas qui produisait le fantôme (sockets en `allowHalfOpen`).
//   group  SIGKILL sur le groupe de processus — Zed qui emporte ses enfants.
//
// Depuis le correctif (`zra-daemon/ws.js` : `'end'` pris comme fin de
// connexion, délai de 2 s après notre trame CLOSE, sonde de vie PING/PONG), les
// trois modes doivent rendre « non reproduit ». Ce script reste l'outil de
// vérification croisée sur la machine qui a vu le bug.
//
// Sortie si le bug revient : `shims` ne retombe pas à 0, des sockets restent en
// `CLOSE-WAIT` côté daemon, et le `send` final échoue après ~20 s
// (`le shim n'a pas répondu à temps`) au lieu de revenir vite.
//
// Un `send` qui répond `not_zra_thread` en ~100 ms est le signe **sain** : la
// session n'est plus au registre, `hub.send()` a donc bien pris la branche
// `zed.reopen()` — il ne reste qu'à refuser l'agent bouchon, que ZRA
// n'enveloppe pas. Rien à voir avec le bug.
//
// Windows ne livre pas les signaux POSIX aux processus enfants : `term` et
// `group` y dégénèrent en `kill`, et un socket fermé par `TerminateProcess`
// repart en RST plutôt qu'en FIN — la plateforme ne couvre donc pas le chemin
// fautif. À lancer sous Linux.

import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadConfig } from '../zra-daemon/config.js'
import { startDaemon } from '../zra-daemon/daemon.js'
import { setLevel } from '../zra-daemon/log.js'
import { buildCustom } from './make-fixture.mjs'
import { FakeZed } from '../zra-shim/test/fake-zed.mjs'

setLevel(process.env.ZRA_VERBOSE ? 'info' : 'error')

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const FAKE_AGENT = join(ROOT, 'zra-shim', 'test', 'fake-agent.mjs')
const SHIM = join(ROOT, 'zra-shim', 'index.js')

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.split('=')[1] : fallback
}
const MODE = arg('mode', 'term')
const COUNT = Number(arg('shims', 3))
const HOST = '127.0.0.1'
const PORT = Number(arg('port', 7899))
const ORIGIN = 'https://zra.exemple.fr'
/** Délai de commande côté daemon (`COMMAND_TIMEOUT`) : le timeout attendu. */
const SETTLE_MS = Number(arg('settle', 10_000))

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const say = (...a) => console.log('[repro]', ...a)

const dir = mkdtempSync(join(tmpdir(), 'zra-ghost-'))
const FIXTURE = join(dir, 'ghosts.sqlite')
const threads = Array.from({ length: COUNT }, (_, i) => ({
  threadId: `0000000000000000000000000000000${i + 1}`,
  sessionId: `ghost-session-${i + 1}`,
}))

buildCustom(FIXTURE, threads.map((t, i) => ({
  thread_id: t.threadId,
  session_id: t.sessionId,
  agent_id: 'fake-acp',
  title: `Thread fantôme ${i + 1}`,
  updated_at: '2026-09-22T16:35:58.919960600+00:00',
  folder_paths: ROOT,
  folder_paths_order: '0',
})))

const config = await loadConfig({
  overrides: {
    port: PORT,
    requireTunnel: false,
    bindLan: false,
    bindTunnel: false,
    zedDb: FIXTURE,
    zedSettings: null,
    pollMs: 40,
    zedProbeMs: 60_000,
    logFile: null,
    injection: 'acp',
    allowedOrigins: [ORIGIN],
    agentCommands: { 'fake-acp': { command: process.execPath, args: [FAKE_AGENT] } },
  },
})
const daemon = await startDaemon(config)
say(`daemon démarré sur ${HOST}:${PORT}, mode=${MODE}, ${COUNT} shim(s)`)

// ---------------------------------------------------------------------------
// 1. Lancer les shims comme Zed le ferait
// ---------------------------------------------------------------------------

/** @type {{ child: import('node:child_process').ChildProcess, zed: FakeZed, sessionId: string }[]} */
const shims = []
for (const t of threads) {
  const child = spawn(process.execPath, [SHIM, '--', process.execPath, FAKE_AGENT], {
    stdio: ['pipe', 'pipe', 'pipe'],
    // `group` a besoin d'un groupe à lui pour le tuer d'un coup.
    detached: MODE === 'group' && process.platform !== 'win32',
    env: {
      ...process.env,
      ZRA_AGENT_ID: 'fake-acp',
      ZRA_DAEMON_URL: `ws://${HOST}:${PORT}/shim`,
      ZRA_FAKE_SESSION_ID: t.sessionId,
      ZRA_LOG_LEVEL: 'error',
    },
  })
  const zed = new FakeZed({ toShim: child.stdin, fromShim: child.stdout })
  await zed.boot({ cwd: ROOT })
  shims.push({ child, zed, sessionId: t.sessionId })
}

for (let i = 0; i < 400 && daemon.shims.shims.size < COUNT; i++) await wait(25)
say(`avant la mort : shims=${daemon.shims.shims.size}/${COUNT} conns=${daemon.host.conns.size}`)
if (daemon.shims.shims.size < COUNT) {
  say('ERREUR : les shims ne se sont pas tous enregistrés, repro non valable')
  await shutdown(1)
}

// ---------------------------------------------------------------------------
// 2. Les tuer
// ---------------------------------------------------------------------------

for (const { child } of shims) {
  if (MODE === 'group' && process.platform !== 'win32') {
    try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
  } else {
    child.kill(MODE === 'kill' || MODE === 'group' ? 'SIGKILL' : 'SIGTERM')
  }
}
say(`shims tués (${MODE})`)

// ---------------------------------------------------------------------------
// 3. Regarder le registre retomber — ou pas
// ---------------------------------------------------------------------------

const t0 = Date.now()
let ghost = true
for (let i = 0; i < 40; i++) {
  await wait(SETTLE_MS / 40)
  const n = daemon.shims.shims.size
  say(`+${String(Math.round(Date.now() - t0)).padStart(5)} ms : shims=${n} conns=${daemon.host.conns.size}` +
    ` sessions=${[...daemon.shims.bySession.keys()].join(',') || '—'}`)
  if (n === 0 && daemon.host.conns.size === 0) { ghost = false; break }
}

// La signature TCP du bug : le daemon a reçu le FIN mais n'a jamais fermé son
// côté. `ss` n'existe que là où le bug a été vu.
if (process.platform === 'linux') {
  try {
    const out = execFileSync('ss', ['-tnp'], { encoding: 'utf8' })
    const lines = out.split('\n').filter((l) => l.includes(`:${PORT}`))
    say('sockets du daemon :')
    for (const l of lines) say('  ', l.trim())
    const waiting = lines.filter((l) => /CLOSE-WAIT/.test(l)).length
    say(`${waiting} socket(s) en CLOSE-WAIT`)
  } catch (err) {
    say('ss indisponible :', err.message)
  }
}

// ---------------------------------------------------------------------------
// 4. L'effet fonctionnel : envoyer vers un thread dont Zed est « fermé »
// ---------------------------------------------------------------------------

const target = threads[0]
const ws = new WebSocket(`ws://${HOST}:${PORT}/ws`)
await new Promise((r, j) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', j, { once: true }) })
const seen = []
ws.addEventListener('message', (ev) => seen.push(JSON.parse(ev.data)))
const post = (m) => ws.send(JSON.stringify(m))

post({ type: 'hello', clientId: 'repro-ghosts' })
await wait(400)
say(`hasSession(${target.sessionId}) = ${daemon.shims.hasSession(target.sessionId)} — ` +
  'si vrai alors que le shim est mort, hub.send() n\'empruntera pas zed.reopen()')

const t1 = Date.now()
post({ type: 'send', threadId: target.threadId, text: 'réveille-toi', mode: 'queue' })
let verdict = 'rien reçu en 30 s'
for (let i = 0; i < 300; i++) {
  await wait(100)
  const hit = seen.find((m) => m.type === 'error' || m.type === 'ack' ||
    (m.type === 'acp_event' && m.update?.sessionUpdate === 'zra/notice'))
  if (hit) {
    verdict = `${hit.type} ${hit.code ?? ''} ${hit.update?.text ?? hit.message ?? ''}`.trim() +
      ` (${Date.now() - t1} ms)`
    break
  }
}
say('send →', verdict)
const slow = Date.now() - t1 > 5000
if (!slow && /not_zra_thread/.test(verdict)) say('  ↳ branche zed.reopen() empruntée : comportement sain')

// ---------------------------------------------------------------------------
// 5. Verdict
// ---------------------------------------------------------------------------

say('---')
say(ghost ? 'FANTÔME : le registre garde des shims morts' : 'registre vidé, pas de fantôme')
say(slow ? 'EFFET : le send a traîné (timeout shim) au lieu de réveiller Zed' : 'send revenu vite')
const failed = ghost || slow
say(failed ? 'REPRODUIT' : 'non reproduit sur cette machine')

try { ws.close() } catch { /* déjà fermé */ }
await shutdown(failed ? 1 : 0)

async function shutdown(code) {
  for (const { child } of shims) { try { child.kill('SIGKILL') } catch { /* déjà mort */ } }
  try { await daemon.close() } catch { /* déjà fermé */ }
  rmSync(dir, { recursive: true, force: true })
  process.exit(code)
}
