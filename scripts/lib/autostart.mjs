// Backend « autostart XDG » de `npm run service` — pour les machines Linux dont
// l'init n'est pas systemd.
//
// Mêmes sous-commandes, même UX que les deux autres backends : `status` /
// `install` / `uninstall` / `start` / `stop` / `logs`. La branche Windows
// (`schtasks`, `daemon-task.ps1`) est gelée : ce module s'y ajoute, il ne la
// remplace ni ne la modifie.
//
// Pourquoi ce backend existe — faits mesurés sur MX Linux 23 (HP Pavilion x2),
// où `npm run service -- install --apply` échouait :
//   $ cat /proc/1/comm                   → init        (sysvinit, pas systemd)
//   $ dpkg -l | grep -E 'systemd|sysvinit'
//     systemd 1:252.6-1mx23+1  sysvinit-core 3.06-4  systemd-shim 10-6
//   $ ls /run/systemd/system             → inexistant  (le marqueur sd_booted())
//   $ systemctl --user is-system-running → offline
//   $ systemctl --user daemon-reload
//     Failed to reload daemon: Process org.freedesktop.systemd1 exited with status 1
//   $ ls /run/user/1000/systemd          → inexistant  (aucun user manager)
//   $ journalctl --user -n 5             → No journal files were found
// systemd 252 est installé, mais il n'est pas l'init : `systemd --user` n'a
// personne à qui parler. La version du paquet n'est pas le critère, l'init l'est.
//
// Pourquoi l'autostart XDG et pas `/etc/init.d` ni cron `@reboot` : ces deux-là
// partent AVANT la session graphique, donc sans `DISPLAY`. Or tout le pilotage
// de Zed passe par `xdotool`, qui ne vise rien hors session — c'est exactement
// ce que disent les `Environment=DISPLAY=:0` de l'unité systemd. Une entrée de
// `~/.config/autostart` est lue à l'ouverture de session, par Xfce comme par
// GNOME, KDE et LXQt, et sans sudo.
//
// Les deux limites à connaître (elles sont affichées par `status`) :
//   1. aucune supervision : pas d'équivalent à `Restart=on-failure`. Si le
//      daemon plante, il reste arrêté jusqu'à la prochaine ouverture de session.
//   2. aucune équivalence à `loginctl enable-linger` : le daemon s'arrête à la
//      fermeture de session et ne démarre pas au boot d'une machine sans session.

import { spawn } from 'node:child_process'
import { chmodSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { daemonStatus } from './daemon-status.mjs'
// Une seule liste de variables de session, partagée avec l'unité systemd : ce
// sont les mêmes faits (DISPLAY absent d'un service lancé hors session), et les
// deux backends doivent recopier exactement la même chose.
import { GRAPHICS_ENV } from './systemd.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Nom de l'entrée d'autostart. Le daemon est le seul service de ZRA. */
export const DESKTOP = 'zra-daemon.desktop'
/** Délai avant le premier lancement, aligné sur la tâche Windows (15 s). */
export const DELAY_S = 15
/** Journal du daemon, le même fichier que les deux autres backends. */
export const LOG = join(ROOT, '.zra', 'logs', 'daemon.log')

/**
 * Tous les chemins du backend, en suivant XDG_CONFIG_HOME comme l'unité systemd
 * suit XDG_CONFIG_HOME. Fonction pure : les tests la vérifient sans rien écrire.
 *
 * @param {{ env?:object, home?:string, root?:string }} [opts]
 */
export function paths({ env = process.env, home = homedir(), root = ROOT } = {}) {
  const config = env.XDG_CONFIG_HOME || join(home, '.config')
  const service = join(root, '.zra', 'service')
  return {
    /** `~/.config/autostart/zra-daemon.desktop` — ce que la session lit. */
    desktop: join(config, 'autostart', DESKTOP),
    /** Le lanceur : une entrée .desktop n'a pas de clé `Environment=`. */
    launcher: join(service, 'zra-daemon.sh'),
    /** `stop` n'a pas de `systemctl` : il lui faut le pid, validé avant kill. */
    pid: join(service, 'zra-daemon.pid'),
    /** Écrit par le daemon lui-même (`--log`). */
    log: join(root, '.zra', 'logs', 'daemon.log'),
    /** Ce que node écrit hors du logger : un crash au démarrage, par exemple. */
    serviceLog: join(root, '.zra', 'logs', 'service.log'),
    /** Le point d'entrée du daemon. */
    daemon: join(root, 'zra-daemon', 'index.js'),
    root,
  }
}

/** `~/.config/autostart/zra-daemon.desktop`, en suivant XDG_CONFIG_HOME. */
export function desktopFile(opts) {
  return paths(opts).desktop
}

// ---------------------------------------------------------------------------
// Le lanceur et l'entrée .desktop
// ---------------------------------------------------------------------------

/**
 * Un argument de shell POSIX : tout est mis entre apostrophes, et une apostrophe
 * dans la valeur se ferme/rouvre (`'\''`). Un dépôt cloné sous
 * `/home/moi/Mes projets/zra` ne doit pas casser le lanceur.
 */
export function quoteShellArg(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

/**
 * Un argument de la clé `Exec=` d'une entrée .desktop.
 *
 * La spécification « Desktop Entry » de freedesktop.org découpe `Exec=` sur les
 * espaces, admet les guillemets doubles, et réserve `` ` ``, `$`, `\` et `"` :
 * dans une valeur entre guillemets, elles s'écrivent précédées d'une
 * contre-oblique.
 */
export function quoteDesktopArg(value) {
  const s = String(value)
  return /[\s"`$\\]/.test(s) ? `"${s.replace(/([`$\\"])/g, '\\$1')}"` : s
}

/**
 * Le lanceur. Fonction pure : les tests la vérifient sans rien installer.
 *
 * Il porte ce que l'entrée .desktop ne peut pas porter : l'environnement de la
 * session graphique, relevé au moment de l'installation — donc depuis la
 * session, des valeurs réelles et non devinées (même raison, même bug réel que
 * les `Environment=` de l'unité systemd : sans le PATH de la session, les
 * agents relancés par le daemon ne trouvent pas leurs exécutables).
 *
 * @param {{ node?:string, log?:string, env?:object }} opts et chemins de `paths()`
 */
export function buildLauncher({
  node = process.execPath, env = process.env,
  root = ROOT, daemon = paths().daemon, log = LOG,
  pid = paths().pid, serviceLog = paths().serviceLog, delayS = DELAY_S,
} = {}) {
  const vars = GRAPHICS_ENV.filter((k) => env[k]).map((k) => `export ${k}=${quoteShellArg(env[k])}`)
  const args = [node, '--no-warnings', daemon, '--wait-tunnel', '--log', log].map(quoteShellArg).join(' ')
  return `#!/bin/sh
# Généré par \`npm run service -- install --apply\` — ne pas éditer à la main.
# ZRA — backend « autostart XDG », pour les machines dont l'init n'est pas
# systemd. Lancé par la session graphique à l'ouverture, ou par
# \`npm run service -- start\` (qui passe --now).

# Le pid avant tout le reste : \`stop\` doit pouvoir arrêter le lanceur même
# pendant la temporisation ci-dessous, avant l'exec.
echo $$ > ${quoteShellArg(pid)}

# --now : lancé à la main, on ne temporise pas.
# Sans argument : lancé par la session, on laisse le réseau et le tunnel
# WireGuard se monter (même délai que la tâche planifiée Windows).
if [ "$1" != "--now" ]; then
  sleep ${Number(delayS) || 0}
fi

cd ${quoteShellArg(root)} || exit 1
# Session graphique : sans DISPLAY, xdotool ne vise aucune fenêtre.
# PATH : celui de la session, sans lequel les agents lancés par le daemon
# (relecture d'un thread fermé) ne trouvent pas leurs exécutables.
${vars.join('\n') || '# (aucune variable de session graphique relevée à l’installation)'}

# stdout/stderr hors du journal du daemon : ce fichier ne récupère que ce que
# node écrit sans passer par le logger (crash au démarrage, erreur d'exec).
# Le dossier doit exister AVANT la redirection, sinon sh échoue et le daemon ne
# part jamais. Fait mesuré sur MX Linux 23, premier essai :
#   cannot create …/.zra/logs/service.log: Directory nonexistent
mkdir -p ${quoteShellArg(dirname(serviceLog))} || exit 1
exec ${args} >> ${quoteShellArg(serviceLog)} 2>&1
`
}

/**
 * L'entrée d'autostart. Fonction pure.
 *
 * Seules des clés de la spécification « Desktop Entry » (Type, Version, Name,
 * Comment, Exec, Terminal) : rien de spécifique à un bureau, donc rien à
 * désapprendre d'une session à l'autre. La présence du fichier dans
 * `~/.config/autostart` suffit à Xfce, GNOME, KDE et LXQt.
 *
 * @param {{ launcher?:string }} opts
 */
export function buildDesktop({ launcher = paths().launcher } = {}) {
  return `[Desktop Entry]
# Généré par \`npm run service -- install --apply\` — ne pas éditer à la main.
# ZRA — pendant de la tâche planifiée Windows et du service systemd --user.
Type=Application
Version=1.0
Name=ZRA daemon
Comment=Passerelle entre Zed et le mobile, lancée à l'ouverture de session
Exec=${quoteDesktopArg(launcher)}
Terminal=false
`
}

// ---------------------------------------------------------------------------
// État : le fichier, et le processus
// ---------------------------------------------------------------------------

/** Contenu d'un pidfile → nombre, ou null. Rien n'est deviné. */
export function parsePid(text) {
  const n = Number(String(text ?? '').trim())
  return Number.isInteger(n) && n > 0 ? n : null
}

/**
 * Ligne de commande d'un pid, lue dans `/proc`. `null` si le processus n'existe
 * pas (ou si `/proc` n'est pas là — ce backend est Linux de toute façon).
 */
export function pidCmdline(pid) {
  try {
    return readFileSync(`/proc/${Number(pid)}/cmdline`, 'utf8').replace(/\0/g, ' ').trim() || null
  } catch {
    return null
  }
}

/**
 * Le pid du pidfile est-il bien NOTRE daemon ?
 *
 * Un pidfile peut rester d'un lancement précédent et le pid être recyclé par un
 * processus sans rapport : `stop` tuerait alors n'importe quoi. La ligne de
 * commande doit contenir le chemin du daemon, ou celui du lanceur (pendant la
 * temporisation, avant l'`exec`).
 */
export function pidMatches(cmdline, { daemon, launcher }) {
  const c = String(cmdline ?? '')
  return c.includes(String(daemon)) || c.includes(String(launcher))
}

/**
 * État complet du backend : installé, lancé, et par quoi.
 *
 * @param {{ env?:object, home?:string, root?:string }} [opts]
 */
export function autostartState(opts = {}) {
  const p = paths(opts)
  const installed = existsSync(p.desktop)
  const launcher = existsSync(p.launcher)
  const raw = existsSync(p.pid) ? readFileSync(p.pid, 'utf8') : null
  const pid = parsePid(raw)
  const cmdline = pid ? pidCmdline(pid) : null
  const running = Boolean(cmdline && pidMatches(cmdline, p))
  return {
    installed,
    launcher,
    running,
    desktop: p.desktop,
    launcherPath: p.launcher,
    pidFile: p.pid,
    pid: running ? pid : null,
    /** Un pidfile dont le pid est mort ou recyclé : à nettoyer, pas à tuer. */
    stalePid: pid && !running ? pid : null,
    cmdline: running ? cmdline : null,
    paths: p,
  }
}

function tailLog(file, lines) {
  if (!existsSync(file)) return null
  const out = readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean).slice(-lines)
  return out.length ? out : null
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------------------
// Les sous-commandes, mêmes verbes que les deux autres backends
// ---------------------------------------------------------------------------

async function status(opts, config, ctx = {}) {
  const s = autostartState(ctx)
  if (!s.installed) {
    console.log(`entrée « ${DESKTOP} » : ✗ absente — \`npm run service -- install\` pour voir ce qui serait créé`)
  } else {
    console.log(`entrée « ${DESKTOP} » : ✓ installée (${s.desktop})`)
    console.log(`  lanceur : ${s.launcherPath}${s.launcher ? '' : ' — ✗ absent'}`)
    console.log(s.running
      ? `  processus : ✓ lancé, pid ${s.pid}`
      : '  processus : ✗ arrêté')
    if (s.stalePid) console.log(`  pidfile périmé (pid ${s.stalePid} mort ou recyclé) — \`stop\` le nettoiera`)
    console.log('  au démarrage : à l’ouverture de session (autostart XDG, sans sudo)')
    console.log('  ⚠ pas de supervision : aucun équivalent à Restart=on-failure, un daemon planté reste arrêté')
    console.log('  ⚠ pas d’équivalent à loginctl enable-linger : arrêt à la fermeture de session')
  }

  const d = await daemonStatus(config.port)
  if (d.ok) {
    const t = d.threads ?? {}
    console.log(`daemon 127.0.0.1:${config.port} : ✓ ${d.scheme}, depuis ${d.startedAt}, ` +
      `${t.live ?? 0} live / ${t.closed ?? 0} fermé(s), ${d.shims?.length ?? 0} shim(s), ${d.clients ?? 0} client(s)`)
  } else {
    console.log(`daemon 127.0.0.1:${config.port} : ✗ injoignable (${d.reason})`)
  }

  const last = tailLog(s.paths.log, 5) ?? tailLog(s.paths.serviceLog, 5)
  if (last) console.log(`journal :\n  ${last.join('\n  ')}`)
  else console.log(`journal : pas encore écrit (${s.paths.log})`)
}

async function install(opts, config, ctx = {}) {
  const p = paths(ctx)
  const env = ctx.env ?? process.env
  const launcher = buildLauncher({ node: ctx.node, env, ...p })
  const desktop = buildDesktop({ launcher: p.launcher })
  console.log(`entrée « ${DESKTOP} » pour ${env.USER || 'l’utilisateur courant'} : à l'ouverture de session, sans élévation, dans la session graphique`)
  console.log(`  node ${process.execPath}`)
  console.log(`  journal ${p.log} (et ${p.serviceLog} pour les crashs au démarrage)`)
  console.log(`  fichiers ${p.desktop}\n           ${p.launcher}`)
  console.log('\n--- lanceur ---\n' + launcher.split(/\r?\n/).map((l) => `  │ ${l}`).join('\n'))
  console.log('\n--- entrée .desktop ---\n' + desktop.split(/\r?\n/).map((l) => `  │ ${l}`).join('\n'))
  if (!opts.apply) {
    console.log('\nsimulation : rien créé. Relancer avec --apply pour écrire l’entrée et le lanceur.')
    return
  }
  await mkdir(dirname(p.launcher), { recursive: true })
  await mkdir(dirname(p.log), { recursive: true })
  await writeFile(p.launcher, launcher, 'utf8')
  chmodSync(p.launcher, 0o755)
  await mkdir(dirname(p.desktop), { recursive: true })
  await writeFile(p.desktop, desktop, 'utf8')
  console.log('\n✓ lanceur et entrée écrits. L’entrée prend effet à la prochaine ouverture de session ; tout de suite : npm run service -- start')
  console.log('  (que la session la lise vraiment ne se vérifie qu’en se déconnectant/reconnectant)')
}

async function uninstall(opts, config, ctx = {}) {
  const s = autostartState(ctx)
  if (!s.installed && !s.launcher && !s.stalePid) return console.log(`entrée « ${DESKTOP} » : déjà absente`)
  if (!opts.apply) {
    return console.log(`simulation : le daemon serait arrêté, puis ${s.desktop} et ${s.launcherPath} supprimés. Relancer avec --apply.`)
  }
  const stopped = await stopDaemon(s)
  rmSync(s.desktop, { force: true })
  rmSync(s.launcherPath, { force: true })
  rmSync(s.pidFile, { force: true })
  console.log(`✓ entrée et lanceur supprimés${stopped ? ' (daemon arrêté)' : ''} — le journal reste dans .zra/logs/`)
}

/** Arrête le processus du pidfile, s'il est bien le nôtre. Renvoie true si tué. */
async function stopDaemon(s) {
  if (!s.pid) {
    if (s.stalePid) rmSync(s.pidFile, { force: true })
    return false
  }
  try {
    process.kill(s.pid, 'SIGTERM')
  } catch {
    rmSync(s.pidFile, { force: true })
    return false
  }
  // SIGTERM d'abord : le daemon ferme ses sockets et ses shims proprement.
  // SIGKILL ensuite seulement, si un tunnel qui pend le retient.
  for (let i = 0; i < 20; i++) {
    if (!pidCmdline(s.pid)) break
    await sleep(250)
    if (!pidCmdline(s.pid)) break
    if (i === 10) { try { process.kill(s.pid, 'SIGKILL') } catch { break } }
  }
  rmSync(s.pidFile, { force: true })
  return true
}

async function start(opts, config, ctx = {}) {
  const s = autostartState(ctx)
  if (!s.installed || !s.launcher) throw new Error(`entrée « ${DESKTOP} » absente : npm run service -- install --apply`)
  const already = await daemonStatus(config.port)
  if (already.ok) return console.log(`un daemon répond déjà sur 127.0.0.1:${config.port} (dev ?) : rien lancé`)
  if (s.pid) return console.log(`le lanceur tourne déjà (pid ${s.pid}) mais le daemon ne répond pas : npm run service -- logs`)
  // Détaché : le lanceur doit survivre à la fin de `npm run service`.
  const child = spawn(s.launcherPath, ['--now'], { detached: true, stdio: 'ignore', cwd: s.paths.root })
  child.unref()
  for (let i = 0; i < 40; i++) {
    await sleep(250)
    const d = await daemonStatus(config.port, { timeoutMs: 500 })
    if (d.ok) {
      const pid = existsSync(s.pidFile) ? parsePid(readFileSync(s.pidFile, 'utf8')) : null
      return console.log(`✓ daemon lancé (${d.scheme}://127.0.0.1:${config.port}${pid ? `, pid ${pid}` : ''})`)
    }
  }
  console.log(`lanceur parti, mais le daemon ne répond pas encore : npm run service -- logs`)
}

async function stop(opts, config, ctx = {}) {
  const s = autostartState(ctx)
  if (!s.installed) return console.log(`entrée « ${DESKTOP} » absente`)
  if (s.stalePid) {
    rmSync(s.pidFile, { force: true })
    console.log(`pidfile périmé nettoyé (pid ${s.stalePid} n’était pas le daemon)`)
  }
  if (!s.pid) return console.log('daemon : déjà arrêté')
  console.log(await stopDaemon(s) ? `✓ daemon arrêté (pid ${s.pid})` : `✗ impossible d’arrêter le pid ${s.pid}`)
}

function logs(opts, config, ctx = {}) {
  const p = paths(ctx)
  const fromDaemon = tailLog(p.log, opts.lines)
  if (fromDaemon) return console.log(fromDaemon.join('\n'))
  const fromService = tailLog(p.serviceLog, opts.lines)
  if (fromService) return console.log(`(${p.log} vide, lu depuis ${p.serviceLog})\n${fromService.join('\n')}`)
  console.log(`pas de journal : ${p.log} et ${p.serviceLog} absents ou vides`)
  console.log('(pas de journalctl ici : cette machine n’a pas systemd comme init)')
}

/** Les six verbes de la CLI, mêmes noms que les deux autres backends. */
export const commands = { status, install, uninstall, start, stop, logs }
