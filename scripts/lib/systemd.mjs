// Backend `systemd --user` de `npm run service` — le pendant Linux de la tâche
// planifiée Windows.
//
// Mêmes sous-commandes, même UX : `status` / `install` / `uninstall` / `start`
// / `stop` / `logs`. La branche Windows (`schtasks`, `daemon-task.ps1`) est
// gelée : ce module s'y ajoute, il ne la remplace ni ne la modifie.
//
// Pourquoi `--user` et pas un service système : le pilotage de Zed au clavier
// doit tourner DANS la session graphique de l'utilisateur, exactement comme la
// tâche Windows en `InteractiveToken`. Un service système n'a ni le WAYLAND_DISPLAY
// ni le DISPLAY de la session, et il tournerait en root.
//
// **Le piège du sujet** : un service `--user` s'arrête à la déconnexion, et ne
// démarre qu'à l'ouverture de session — donc jamais au boot d'une machine sans
// session ouverte. `loginctl enable-linger` le fait démarrer au boot et
// survivre à la déconnexion. `install` le vérifie et le dit.
//
// Faits établis sur la machine de portage (Ubuntu 24.04.3) :
//   $ systemctl --version            → systemd 255 (255.4-1ubuntu8.17)
//   $ systemctl --user is-system-running → running
//   $ loginctl show-user $USER -p Linger → Linger=no   (avant)
//   $ loginctl enable-linger $USER         → (silencieux, rc=0, SANS sudo)
//   $ loginctl show-user $USER -p Linger → Linger=yes  (après)
//   $ ls ~/.config/systemd/user      → default.target.wants/  gnome-session.target.wants/

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdir, writeFile } from 'node:fs/promises'

import { daemonStatus } from './daemon-status.mjs'
import { trayBinary } from './tray-binary.mjs'
import { tr } from '../../zra-daemon/i18n.js'
import { configRoot } from '../../zra-daemon/platform.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Nom de l'unité. Le daemon est le seul service de ZRA. */
export const UNIT = 'zra-daemon.service'
/** Journal du daemon, le même que la tâche Windows (`daemon-task.ps1 --log`). */
export const LOG = join(configRoot({ root: ROOT, platform: 'linux' }), '.zra', 'logs', 'daemon.log')

/** `~/.config/systemd/user/zra-daemon.service`, en suivant XDG_CONFIG_HOME. */
export function unitFile({ env = process.env, home = homedir() } = {}) {
  const config = env.XDG_CONFIG_HOME || join(home, '.config')
  return join(config, 'systemd', 'user', UNIT)
}

// ---------------------------------------------------------------------------
// L'unité
// ---------------------------------------------------------------------------

/**
 * Un argument d'`ExecStart` : systemd découpe sur les espaces, donc tout ce qui
 * en contient doit être entre guillemets doubles. Les chemins Windows ne sont
 * pas concernés (cette unité ne sert que sous Linux), mais un dépôt cloné sous
 * `/home/moi/Mes projets/zra` l'est.
 */
export function quoteUnitArg(value) {
  const s = String(value)
  return /[\s"\\]/.test(s) ? `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : s
}

/**
 * Variables d'environnement de la session graphique à recopier dans l'unité.
 *
 * Un service `--user` reçoit `XDG_RUNTIME_DIR` de systemd, mais **ni `DISPLAY`
 * ni `WAYLAND_DISPLAY`** : sans eux, aucun backend clavier ne peut viser une
 * fenêtre. Elles sont relevées au moment de l'installation — c'est-à-dire
 * depuis la session graphique, donc des valeurs réelles, pas devinées.
 *
 * `PATH` aussi, et c'est un bug réel vu en vrai : systemd donne au service un
 * PATH minimal (`/usr/local/sbin:…:/snap/bin`), qui ne contient ni
 * `~/.pi/agent/bin` ni `~/.local/bin`. Conséquence observée : la relecture d'un
 * thread fermé lance `pi-acp`, qui ne trouve pas `pi` et répond
 * « Could not start pi: executable not found … Pi needs to be installed » —
 * alors que tout fonctionne dans Zed, lancé depuis la session interactive.
 * (`pi-acp` accepte `PI_ACP_PI_COMMAND`, mais recopier le PATH de la session
 * règle le problème pour TOUS les agents, pas seulement pi.)
 *
 * Fait établi ici : `DISPLAY=:0`, `WAYLAND_DISPLAY=wayland-0`,
 * `XDG_SESSION_TYPE=wayland`, `XDG_CURRENT_DESKTOP=ubuntu:GNOME`, et
 * `cat /proc/<pid daemon>/environ | tr '\0' '\n' | grep ^PATH=` →
 * `PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/games:/usr/local/games:/snap/bin`
 * (le PATH minimal de systemd, sans `~/.pi/agent/bin` où vit `pi`).
 */
export const GRAPHICS_ENV = ['XDG_SESSION_TYPE', 'WAYLAND_DISPLAY', 'DISPLAY', 'XDG_CURRENT_DESKTOP', 'XDG_RUNTIME_DIR', 'PATH']

/**
 * Contenu de l'unité. Fonction pure : les tests la vérifient sans rien
 * installer.
 *
 * @param {{ node?:string, root?:string, log?:string, env?:object, description?:string, tray?:string|null }} opts
 */
export function buildUnit({ node = process.execPath, root = ROOT, log = LOG, env = process.env, description = null, tray = null } = {}) {
  // Avec le tray : il lance node lui-même (--wait-tunnel, journal,
  // single-instance) ; l'unité n'a qu'à le lancer. S'il sort proprement parce
  // qu'un autre tray tient le verrou, Restart=on-failure ne relance pas — voulu.
  const exec = tray
    ? quoteUnitArg(tray)
    : [node, '--no-warnings', join(root, 'zra-daemon', 'index.js'), '--wait-tunnel', '--log', log].map(quoteUnitArg).join(' ')
  const vars = GRAPHICS_ENV.filter((k) => env[k]).map((k) => `Environment=${k}=${env[k]}`)
  return `# Généré par \`npm run service -- install --apply\` — ne pas éditer à la main.
# ZRA — backend systemd --user, pendant de la tâche planifiée Windows.
[Unit]
Description=${description ?? 'ZRA — passerelle entre Zed et le mobile (zra-daemon)'}
# Le daemon attend le tunnel WireGuard (--wait-tunnel) : autant partir après le réseau.
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${quoteUnitArg(root)}
ExecStart=${exec}
# Parité avec daemon-task.ps1 : relancé s'il s'arrête en erreur, pas s'il sort
# proprement (code 0 = Ctrl+C ou \`npm run service -- stop\`).
Restart=on-failure
RestartSec=5
# Session graphique : sans elles, le pilotage de Zed au clavier est impossible.
# PATH : celui de la session, sans lequel les agents lancés par le daemon
# (relecture d'un thread fermé) ne trouvent pas leurs exécutables (~/.pi, ~/.local).
${vars.join('\n') || '# (aucune variable de session graphique relevée à l’installation)'}

[Install]
WantedBy=default.target
`
}

// ---------------------------------------------------------------------------
// systemctl / journalctl / loginctl
// ---------------------------------------------------------------------------

function systemctl(args) {
  const res = spawnSync('systemctl', ['--user', ...args], { encoding: 'utf8' })
  return { ok: res.status === 0, out: `${res.stdout || ''}${res.stderr || ''}`.trim(), status: res.status }
}

/** `systemctl --user show -p A -p B` → { a: …, b: … }, clés en minuscules. */
export function parseShow(text) {
  const out = {}
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^([^=]+)=(.*)$/.exec(line)
    if (m) out[m[1].trim().toLowerCase()] = m[2].trim()
  }
  return out
}

/** `journalctl --user -u … -n N --no-pager` → lignes, ou null si indisponible. */
export function journal(lines) {
  const res = spawnSync('journalctl', ['--user', '--unit', UNIT, '--lines', String(lines), '--no-pager', '--output', 'short-iso'], { encoding: 'utf8' })
  if (res.status !== 0 && res.error) return null
  const out = `${res.stdout || ''}`.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('-- ') && !l.startsWith('Hint:'))
  return out.length ? out : null
}

function tailLog(file, lines) {
  if (!existsSync(file)) return null
  return readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean).slice(-lines)
}

/** État de l'unité : installée, activée au démarrage, active, dernier départ. */
export function unitState() {
  const file = unitFile()
  if (!existsSync(file)) return { installed: false, file }
  const show = parseShow(systemctl(['show', UNIT,
    '--property=LoadState', '--property=UnitFileState', '--property=ActiveState',
    '--property=SubState', '--property=ExecMainPID', '--property=ActiveEnterTimestamp',
    '--property=Result', '--property=NRestarts']).out)
  return {
    installed: true,
    file,
    load: show.loadstate ?? '?',
    enabled: show.unitfilestate ?? '?',
    active: show.activestate ?? '?',
    sub: show.substate ?? '?',
    // Le pid n'a de sens que si l'unité tourne : après un arrêt propre,
    // ExecMainPID peut garder la dernière valeur vue (rendu « stale »).
    pid: show.activestate === 'active' && show.execmainpid && show.execmainpid !== '0' ? show.execmainpid : null,
    since: show.activeentertimestamp || null,
    result: show.result || null,
    restarts: show.nrestarts || '0',
  }
}

/** `Linger=yes|no`, et pourquoi c'est LE piège d'un service --user. */
export function lingerState({ user = process.env.USER || process.env.LOGNAME } = {}) {
  const res = spawnSync('loginctl', ['show-user', String(user), '--property=Linger'], { encoding: 'utf8' })
  const m = /^Linger=(\w+)/m.exec(`${res.stdout || ''}${res.stderr || ''}`)
  return m ? m[1] === 'yes' : null
}

// ---------------------------------------------------------------------------
// Les sous-commandes, mêmes verbes que la branche Windows
// ---------------------------------------------------------------------------

async function status(opts, config) {
  const s = unitState()
  if (!s.installed) {
    console.log(tr`Unité « ${UNIT} » : ✗ absente — \`npm run service -- install\` pour voir ce qui serait créé.`)
  } else {
    console.log(tr`Unité « ${UNIT} » : ✓ installée (${s.file}).`)
    console.log(tr`  État : ${s.active}` + (s.sub && s.sub !== 'running' ? ` (${s.sub})` : '') +
      (s.pid ? `, pid ${s.pid}` : '') + (s.since ? tr`, depuis ${s.since}` : ''))
    console.log(tr`  Au démarrage : ${s.enabled}` + (s.enabled === 'enabled' ? '' : tr` — \`systemctl --user enable\` ne l’a pas fait.`))
    if (Number(s.restarts) > 0 || (s.result && s.result !== 'success')) {
      console.log(tr`  Relances : ${s.restarts}, dernier résultat : ${s.result}`)
    }
  }

  const linger = lingerState()
  if (linger === false) {
    console.log(tr`  ⚠ linger désactivé : le daemon s’arrêtera à la déconnexion et ne démarrera pas au boot.`)
    console.log(`    → loginctl enable-linger ${process.env.USER || tr`<utilisateur>`}`)
  } else if (linger === true) {
    console.log(tr`  Linger : ✓ activé (survit à la déconnexion, démarre au boot).`)
  }

  const d = await daemonStatus(config.port)
  if (d.ok) {
    const t = d.threads ?? {}
    console.log(tr`Daemon 127.0.0.1:${config.port} : ✓ ${d.scheme}, depuis ${d.startedAt}, ${t.live ?? 0} live / ${t.closed ?? 0} fermé(s), ${d.shims?.length ?? 0} shim(s), ${d.clients ?? 0} client(s).`)
  } else {
    console.log(tr`Daemon 127.0.0.1:${config.port} : ✗ injoignable (${d.reason}).`)
  }

  const tray = trayBinary(ROOT)
  console.log(tray ? tr`Tray : ✓ ${tray}.` : tr`Tray : ✗ absent — l’unité lance node directement.`)

  const last = journal(5) ?? tailLog(LOG, 5)
  if (last) console.log(tr`Journal :\n  ${last.join('\n  ')}`)
  else console.log(tr`Journal : pas encore écrit (${LOG}).`)
}

async function install(opts) {
  const tray = trayBinary(ROOT)
  const unit = buildUnit({ env: process.env, tray })
  const file = unitFile()
  console.log(tr`Unité « ${UNIT} » pour ${process.env.USER || tr`L’utilisateur courant`} : à l'ouverture de session, sans élévation, dans la session graphique.`)
  if (tray) {
    console.log(tr`  tray ${tray} — supervise le daemon (restart, journal, single-instance).`)
  } else {
    console.log(`  node ${process.execPath}`)
    console.log(tr`  Tray absent — l’unité lance node directement (cargo build dans zra-tray/ pour le tray).`)
  }
  console.log(tr`  Journal ${LOG} + journalctl --user -u ${UNIT}`)
  console.log(tr`  Fichier ${file}`)
  console.log('\n' + unit.split(/\r?\n/).map((l) => `  │ ${l}`).join('\n'))
  if (!opts.apply) {
    console.log(tr`\nSimulation : rien créé. Relancer avec --apply pour écrire l’unité.`)
    return
  }
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, unit, 'utf8')
  const reload = systemctl(['daemon-reload'])
  if (!reload.ok) throw new Error(tr`systemctl --user daemon-reload a échoué : ${reload.out}`)
  const enable = systemctl(['enable', UNIT])
  if (!enable.ok) throw new Error(tr`systemctl --user enable a échoué : ${enable.out}`)
  console.log(tr`\n✓ unité écrite et activée. Elle démarrera à la prochaine ouverture de session ; tout de suite : npm run service -- start.`)
  if (lingerState() === false) {
    console.log(tr`⚠ linger désactivé : sans lui, le daemon meurt à la déconnexion et ne part pas au boot.`)
    console.log(`   loginctl enable-linger ${process.env.USER || tr`<utilisateur>`}   ` + tr`(vérifié : passe sans sudo ici).`)
  }
}

function uninstall(opts) {
  const s = unitState()
  if (!s.installed) return console.log(tr`Unité « ${UNIT} » : déjà absente.`)
  if (!opts.apply) return console.log(tr`Simulation : l’unité « ${UNIT} » serait arrêtée, désactivée puis supprimée (${s.file}). Relancer avec --apply.`)
  // --keep-running (migration de mode par le tray) : disable seul, le
  // processus courant survit jusqu'à la bascule suivante.
  systemctl(opts.keepRunning ? ['disable', UNIT] : ['disable', '--now', UNIT])
  rmSync(s.file, { force: true })
  const reload = systemctl(['daemon-reload'])
  console.log(reload.ok
    ? (opts.keepRunning
      ? tr`✓ unité désactivée et supprimée (processus courant laissé vivant).`
      : tr`✓ unité supprimée (le journal reste dans .zra/logs/ et dans journalctl).`)
    : `systemctl --user daemon-reload : ${reload.out}`)
}

async function start(opts, config) {
  if (!unitState().installed) throw new Error(tr`Unité « ${UNIT} » absente : npm run service -- install --apply.`)
  const already = await daemonStatus(config.port)
  if (already.ok) return console.log(tr`Un daemon répond déjà sur 127.0.0.1:${config.port} (dev ?) : rien lancé.`)
  const res = systemctl(['start', UNIT])
  if (!res.ok) throw new Error(tr`systemctl --user start a échoué : ${res.out}`)
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250))
    const d = await daemonStatus(config.port, { timeoutMs: 500 })
    if (d.ok) return console.log(tr`✓ daemon lancé (${`${d.scheme}://127.0.0.1:${config.port}`})`)
  }
  console.log(tr`Unité démarrée, mais le daemon ne répond pas encore : npm run service -- logs.`)
}

function stop(opts, config) {
  if (!unitState().installed) return console.log(tr`Unité « ${UNIT} » absente.`)
  // `systemctl --user stop` arrête le processus de l'unité, et lui seul : pas
  // besoin du pendant de `killTaskDaemon()` de Windows.
  const res = systemctl(['stop', UNIT])
  console.log(res.ok ? tr`✓ daemon arrêté` : `systemctl --user stop : ${res.out}`)
}

function logs(opts) {
  const fromJournal = journal(opts.lines)
  if (fromJournal) return console.log(fromJournal.join('\n'))
  const fromFile = tailLog(LOG, opts.lines)
  if (fromFile) return console.log(tr`(journalctl muet, lu depuis ${LOG}).` + `\n${fromFile.join('\n')}`)
  console.log(tr`Pas de journal : journalctl --user -u ${UNIT} vide, et ${LOG} absent.`)
}

/** Les six verbes de la CLI, mêmes noms que la branche Windows. Appelés en `(opts, config)`. */
export const commands = { status, install, uninstall, start, stop, logs }
