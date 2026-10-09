#!/usr/bin/env node
// Lancer le daemon à l'ouverture de session.
//
//   npm run service                       état : tâche, daemon, journal
//   npm run service -- install            montre la tâche qui serait créée, ne crée rien
//   npm run service -- install --apply    la crée (ou la remplace)
//   npm run service -- uninstall --apply  la supprime
//   npm run service -- start | stop       la lance, l'arrête
//   npm run service -- logs [--lines 60]  fin du journal du daemon
//
// Deux backends, MÊMES sous-commandes — celui de l'OS est choisi par
// `platform.js`, pas par un test dispersé ici :
//
//   Windows : tâche planifiée (`schtasks`) — **gelée**, inchangée, vérifiée sur
//             la machine cible et impossible à retester depuis Linux.
//   Linux   : service `systemd --user` (`scripts/lib/systemd.mjs`), vérifié sur
//             la machine de portage.
//
// Dans les deux cas c'est **celui de l'utilisateur**, sans élévation : déclenché
// à son ouverture de session, dans sa session interactive. C'est nécessaire au
// pilotage de Zed au clavier (on ne tape pas dans un bureau depuis une session
// de service) et ça évite de stocker un mot de passe.
//
// Windows lance `scripts/daemon-task.ps1` dans une console PowerShell masquée ;
// Linux laisse systemd journaliser, et le daemon écrit aussi dans
// `.zra/logs/daemon.log` (`--log`) — même fichier des deux côtés.

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadConfig } from '../zra-daemon/config.js'
import { serviceBackend } from '../zra-daemon/platform.js'
import { npmSafeArgs } from './lib/args.mjs'
import { daemonStatus } from './lib/daemon-status.mjs'
import { commands as systemdCommands, UNIT } from './lib/systemd.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const TASK = 'ZRA daemon'
const LAUNCHER = join(ROOT, 'scripts', 'daemon-task.ps1')
const LOG = join(ROOT, '.zra', 'logs', 'daemon.log')
const XML_FILE = join(ROOT, '.zra', 'service', 'zra-daemon.xml')

function parseArgs(argv) {
  const out = { command: 'status', apply: false, lines: 40 }
  const rest = npmSafeArgs(argv, ['apply'])
  if (rest[0] && !rest[0].startsWith('-')) out.command = rest.shift()
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (a === '--apply') out.apply = true
    else if (a === '--lines') out.lines = Number(rest[++i])
    else if (a === '--help' || a === '-h') out.command = 'help'
    else throw new Error(`option inconnue : ${a}`)
  }
  if (!['status', 'install', 'uninstall', 'start', 'stop', 'logs', 'help'].includes(out.command)) {
    throw new Error(`commande inconnue : ${out.command}`)
  }
  return out
}

const USAGE = `zra service — le daemon lancé à l'ouverture de session

  npm run service [-- <commande>] [options]

  status               tâche, daemon, fin du journal (défaut)
  install              crée la tâche planifiée « ${TASK} » (Windows)
                       ou le service systemd --user « ${UNIT} » (Linux)
  uninstall            la supprime
  start | stop         la lance, l'arrête
  logs                 fin du journal (.zra/logs/daemon.log, ou journalctl --user)

  --apply              pour install/uninstall : agir pour de vrai (sans : simulation)
  --lines <n>          pour logs : nombre de lignes (défaut 40)
`

// ---------------------------------------------------------------------------
// La tâche
// ---------------------------------------------------------------------------

const xmlEscape = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Argument de ligne de commande Windows, entre guillemets. */
const quote = (s) => `"${String(s).replace(/"/g, '\\"')}"`

/**
 * Définition de la tâche (schéma Task Scheduler 1.2).
 *
 * - déclencheur : ouverture de session de l'utilisateur, 15 s après (laisser
 *   le réseau et WireGuard se monter) ;
 * - session interactive, sans élévation, sans mot de passe stocké ;
 * - aucune limite de durée, pas d'arrêt sur batterie, une seule instance ;
 * - relance par le lanceur lui-même (`daemon-task.ps1`), qui sait distinguer
 *   un arrêt propre d'un plantage.
 */
export function buildTaskXml({ user, node = process.execPath, root = ROOT, launcher = LAUNCHER, log = LOG }) {
  const args = [
    '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass',
    '-File', quote(launcher), '-Node', quote(node), '-Root', quote(root), '-Log', quote(log),
  ].join(' ')
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>ZRA — passerelle entre Zed et le mobile (zra-daemon). Créée par npm run service.</Description>
    <URI>\\${xmlEscape(TASK)}</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${xmlEscape(user)}</UserId>
      <Delay>PT15S</Delay>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xmlEscape(user)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>powershell.exe</Command>
      <Arguments>${xmlEscape(args)}</Arguments>
      <WorkingDirectory>${xmlEscape(root)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`
}

/** Sortie de `schtasks /Query /V /FO LIST` → { clé: valeur }, clés en minuscules. */
export function parseQuery(text) {
  const out = {}
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^([^:]+?):\s+(.*)$/.exec(line)
    if (m && !(m[1].trim().toLowerCase() in out)) out[m[1].trim().toLowerCase()] = m[2].trim()
  }
  return out
}

function schtasks(args) {
  const res = spawnSync(join(process.env.SystemRoot || 'C:/Windows', 'System32', 'schtasks.exe'), args, { encoding: 'utf8', windowsHide: true })
  return { ok: res.status === 0, out: `${res.stdout || ''}${res.stderr || ''}`.trim() }
}

function currentUser() {
  // Celui de Windows : sous Git Bash, un autre `whoami` répond « AzureAD+nom »,
  // que Task Scheduler ne connaît pas.
  const exe = join(process.env.SystemRoot || 'C:/Windows', 'System32', 'whoami.exe')
  const res = spawnSync(exe, [], { encoding: 'utf8', windowsHide: true })
  const user = res.stdout?.trim()
  if (res.status !== 0 || !user) throw new Error('whoami : utilisateur courant introuvable')
  return user
}

/** La tâche existe-t-elle ? Ses champs, localisés (« Statut », « Status »…). */
function queryTask() {
  const res = schtasks(['/Query', '/TN', TASK, '/V', '/FO', 'LIST'])
  return res.ok ? parseQuery(res.out) : null
}

const field = (q, ...names) => names.map((n) => q?.[n]).find(Boolean) ?? '?'

// ---------------------------------------------------------------------------
// Commandes
// ---------------------------------------------------------------------------

function tail(file, lines) {
  if (!existsSync(file)) return null
  const text = readFileSync(file, 'utf8').replace(/^﻿/, '')
  return text.split(/\r?\n/).filter(Boolean).slice(-lines)
}

async function status(opts, config) {
  const q = queryTask()
  if (!q) {
    console.log(`tâche « ${TASK} » : ✗ absente — \`npm run service -- install\` pour voir ce qui serait créé`)
  } else {
    console.log(`tâche « ${TASK} » : ✓ installée`)
    console.log(`  état : ${field(q, 'statut', 'status', 'état')}`)
    console.log(`  dernière exécution : ${field(q, 'heure de la dernière exécution', 'last run time')}` +
      ` (résultat ${field(q, 'dernier résultat', 'last result')})`)
  }

  const d = await daemonStatus(config.port)
  if (d.ok) {
    const t = d.threads ?? {}
    console.log(`daemon 127.0.0.1:${config.port} : ✓ ${d.scheme}, depuis ${d.startedAt}, ` +
      `${t.live ?? 0} live / ${t.closed ?? 0} fermé(s), ${d.shims?.length ?? 0} shim(s), ${d.clients ?? 0} client(s)`)
  } else {
    console.log(`daemon 127.0.0.1:${config.port} : ✗ injoignable (${d.reason})`)
  }

  const last = tail(LOG, 5)
  if (last) console.log(`journal ${LOG} :\n  ${last.join('\n  ')}`)
  else console.log(`journal ${LOG} : pas encore écrit`)
}

async function install(opts) {
  if (!existsSync(LAUNCHER)) throw new Error(`lanceur introuvable : ${LAUNCHER}`)
  const user = currentUser()
  const xml = buildTaskXml({ user })
  console.log(`tâche « ${TASK} » pour ${user} : à l'ouverture de session (+15 s), sans fenêtre, sans élévation`)
  console.log(`  powershell.exe → ${LAUNCHER}`)
  console.log(`  node ${process.execPath}`)
  console.log(`  journal ${LOG}`)
  if (!opts.apply) {
    console.log('\nsimulation : rien créé. Relancer avec --apply pour créer la tâche.')
    return
  }
  // Task Scheduler attend un XML en UTF-16 : on l'écrit comme tel, BOM compris.
  await mkdir(dirname(XML_FILE), { recursive: true })
  await writeFile(XML_FILE, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]))
  const res = schtasks(['/Create', '/TN', TASK, '/XML', XML_FILE, '/F'])
  if (!res.ok) throw new Error(`schtasks /Create a échoué : ${res.out}`)
  console.log(`✓ tâche créée. Elle démarrera à la prochaine ouverture de session ; tout de suite : npm run service -- start`)
}

function uninstall(opts) {
  if (!queryTask()) return console.log(`tâche « ${TASK} » : déjà absente`)
  if (!opts.apply) return console.log(`simulation : la tâche « ${TASK} » serait arrêtée puis supprimée. Relancer avec --apply.`)
  schtasks(['/End', '/TN', TASK])
  killTaskDaemon()
  const res = schtasks(['/Delete', '/TN', TASK, '/F'])
  if (!res.ok) throw new Error(`schtasks /Delete a échoué : ${res.out}`)
  console.log('✓ tâche supprimée (le journal reste dans .zra/logs/)')
}

async function start(config) {
  if (!queryTask()) throw new Error(`tâche « ${TASK} » absente : npm run service -- install --apply`)
  const already = await daemonStatus(config.port)
  if (already.ok) return console.log(`un daemon répond déjà sur 127.0.0.1:${config.port} (dev ?) : rien lancé`)
  const res = schtasks(['/Run', '/TN', TASK])
  if (!res.ok) throw new Error(`schtasks /Run a échoué : ${res.out}`)
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250))
    const d = await daemonStatus(config.port, { timeoutMs: 500 })
    if (d.ok) return console.log(`✓ daemon lancé (${d.scheme}://127.0.0.1:${config.port})`)
  }
  console.log(`tâche lancée, mais le daemon ne répond pas encore : npm run service -- logs`)
}

/**
 * `schtasks /End` arrête le lanceur PowerShell, pas forcément le node qu'il a
 * lancé : on termine aussi le daemon de la tâche, reconnu à sa ligne de
 * commande (`zra-daemon\index.js --wait-tunnel`) — jamais un daemon de dev.
 */
function killTaskDaemon() {
  const script = [
    "$d = '" + join(ROOT, 'zra-daemon', 'index.js').replace(/'/g, "''") + "'",
    "Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" |",
    "  Where-Object { $_.CommandLine -and $_.CommandLine.Contains($d) -and $_.CommandLine.Contains('--wait-tunnel') } |",
    '  ForEach-Object { Stop-Process -Id $_.ProcessId -Force; $_.ProcessId }',
  ].join('\n')
  const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true })
  return (res.stdout || '').split(/\r?\n/).filter(Boolean)
}

function stop() {
  if (!queryTask()) return console.log(`tâche « ${TASK} » absente`)
  const res = schtasks(['/End', '/TN', TASK])
  const killed = killTaskDaemon()
  console.log(res.ok ? '✓ tâche arrêtée' : `schtasks /End : ${res.out}`)
  if (killed.length) console.log(`  daemon de la tâche terminé (pid ${killed.join(', ')})`)
}

function logs(opts) {
  const last = tail(LOG, opts.lines)
  if (!last) return console.log(`pas de journal : ${LOG}`)
  console.log(last.join('\n'))
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.command === 'help') return console.log(USAGE)
  const config = await loadConfig()

  // Linux : mêmes verbes, autre mécanisme. La branche Windows ci-dessous est
  // gelée — elle n'est pas modifiée, elle n'est plus atteinte que sous Windows.
  if (serviceBackend() === 'systemd') {
    const run = systemdCommands[opts.command]
    if (!run) throw new Error(`commande inconnue : ${opts.command}`)
    return run(opts, config)
  }

  switch (opts.command) {
    case 'status': return status(opts, config)
    case 'install': return install(opts)
    case 'uninstall': return uninstall(opts)
    case 'start': return start(config)
    case 'stop': return stop()
    case 'logs': return logs(opts)
  }
}

// Importé par les tests : ne rien lancer.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`✗ ${err.message}`)
    process.exit(1)
  })
}
