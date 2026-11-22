// Toute la spécificité plateforme de ZRA vit ici — et nulle part ailleurs.
//
// Aucun `if (process.platform === 'win32')` dispersé dans le code : les modules
// appelants demandent un chemin, un nom de processus ou un ordre de préférence
// à ce module ; ils ne savent pas sur quel OS ils tournent.
//
// Les valeurs Linux sont relevées sur un poste réel, pas déduites de la
// documentation :
//
//   $ cat /etc/os-release → PRETTY_NAME="Ubuntu 24.04.3 LTS"
//   $ uname -a            → Linux <hôte> 6.17.0-14-generic … x86_64
//   $ echo $XDG_SESSION_TYPE $WAYLAND_DISPLAY $DISPLAY $XDG_CURRENT_DESKTOP
//     wayland wayland-0 :0 ubuntu:GNOME
//   $ zed --version       → Zed 1.23.2 c0199504… – ~/.local/zed.app/libexec/zed-editor
//   $ which zed           → ~/.local/bin/zed
//     (symlink → ~/.local/zed.app/bin/zed)
//   $ ls -la ~/.local/share/zed
//     db/ debug_adapters/ extensions/ external_agents/ hang_traces/ languages/
//     logs/ node/ prettier/ prompts/ threads/ zed-stable.sock
//   $ ls -la ~/.local/share/zed/db          → 0-global/  0-stable/
//   $ ls -la ~/.local/share/zed/db/0-stable → db.sqlite db.sqlite-shm db.sqlite-wal
//   $ ls -la ~/.config/zed                  → settings.json  themes/   (pas de keymap.json)
//   $ ls -la ~/.local/share/zed/external_agents/registry
//     registry.json  icons/
//   $ echo "$XDG_DATA_HOME|$XDG_CONFIG_HOME|$XDG_STATE_HOME" → "||"  (vides)
//   $ zed --help | grep -A2 user-data-dir
//     "… overrides the default platform-specific data directory location:
//      `$XDG_DATA_HOME/zed`"   ← Zed lui-même annonce le chemin XDG
//
// macOS n'a pas été vérifié : la
// branche non-Windows est la branche XDG, elle n'affirme rien sur Darwin.

import { execFile } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Les trois paramètres arrivent par l'appelant : c'est ce qui rend tout testable. */
function ctx(opts) {
  const platform = opts?.platform ?? process.platform
  return {
    platform,
    env: opts?.env ?? process.env,
    home: opts?.home ?? homedir(),
    // Le séparateur suit la plateforme VISÉE, pas l'OS hôte : un chemin Windows
    // reste un chemin Windows même quand il est calculé — et vérifié — depuis
    // Linux, et réciproquement. Sur chaque OS, `join` de la cible est celui
    // que le code utilisait déjà : aucun comportement ne change.
    join: platform === 'win32' ? win32.join : posix.join,
  }
}

// ---------------------------------------------------------------------------
// Chemins
// ---------------------------------------------------------------------------

/**
 * Chemins de Zed et de ZRA sur ce poste.
 *
 * Aucun accès à l'environnement en dehors des paramètres : la fonction est
 * pure, donc testable avec les valeurs réelles de Windows **et** celles de
 * Linux, côte à côte.
 *
 * `channel` : canal de Zed (`stable` par défaut, voir `ZED_CHANNELS`). Seuls
 * la base et la CLI en dépendent : réglages, registry et processus sont communs.
 *
 * @param {{ platform?:string, env?:object, home?:string, channel?:string }} [opts]
 * @returns {{
 *   platform:string, channel:string, dataDir:string, configDir:string, db:string, settings:string,
 *   keymap:string, registryDir:string, appDir:string, injectionLog:string,
 *   recordsDir:string,
 * }}
 */
export function zedPaths(opts = {}) {
  const { platform, env, home, join } = ctx(opts)
  const channel = opts.channel ?? 'stable'

  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || join(home, 'AppData', 'Local')
    const roaming = env.APPDATA || join(home, 'AppData', 'Roaming')
    const dataDir = join(local, 'Zed')
    const configDir = join(roaming, 'Zed')
    return finish(platform, join, channel, {
      dataDir,
      configDir,
      appDir: join(local, 'zra'),
      registryDir: join(dataDir, 'external_agents', 'registry'),
    })
  }

  // Linux : XDG Base Directory. `zed --help` annonce `$XDG_DATA_HOME/zed`, et
  // les trois variables sont vides sur la machine de portage → valeurs par
  // défaut `~/.local/share`, `~/.config`, `~/.local/state`.
  const data = env.XDG_DATA_HOME || join(home, '.local', 'share')
  const config = env.XDG_CONFIG_HOME || join(home, '.config')
  const state = env.XDG_STATE_HOME || join(home, '.local', 'state')
  const dataDir = join(data, 'zed')
  const configDir = join(config, 'zed')
  return finish(platform, join, channel, {
    dataDir,
    configDir,
    // Journaux et enregistrements de ZRA : `XDG_STATE_HOME` est le rôle prévu
    // par la spec XDG pour ce qui s'écrit en continu (Windows : `%LOCALAPPDATA%\zra`).
    appDir: join(state, 'zra'),
    registryDir: join(dataDir, 'external_agents', 'registry'),
  })
}

/** Les chemins qui se déduisent des deux dossiers racine, et ceux de ZRA. */
function finish(platform, join, channel, { dataDir, configDir, appDir, registryDir }) {
  return {
    platform,
    channel,
    dataDir,
    configDir,
    db: zedDbFile(dataDir, channel, join),
    settings: join(configDir, 'settings.json'),
    // Absent de cette machine tant que rien ne l'écrit (`npm run setup`) :
    // Zed fonctionne sans, le chemin reste le bon.
    keymap: join(configDir, 'keymap.json'),
    registryDir,
    appDir,
    injectionLog: join(appDir, 'injections.log'),
    recordsDir: join(appDir, 'records'),
  }
}

/**
 * Canaux de Zed. Chacun a sa base, `db/0-<canal>/db.sqlite` (Zed :
 * `crates/db/src/db.rs`, `db_path`), et son dossier d'installation (CLI).
 */
export const ZED_CHANNELS = ['stable', 'preview', 'nightly', 'dev']

function zedDbFile(dataDir, channel, join) {
  return join(dataDir, 'db', `0-${channel}`, 'db.sqlite')
}

/** Date de dernière écriture, `null` si le fichier n'existe pas. */
function mtimeOf(file) {
  try { return statSync(file).mtimeMs } catch { return null }
}

/**
 * Canal de Zed utilisé sur ce poste : celui dont la base a été écrite en
 * dernier (son `-wal` bouge à chaque écriture de Zed). Aucune base : `stable`.
 *
 * @param {{ platform?:string, env?:object, home?:string, mtime?:(file:string)=>number|null }} [opts]
 * @returns {string}
 */
export function detectZedChannel(opts = {}) {
  const { join } = ctx(opts)
  const { dataDir } = zedPaths(opts)
  const mtime = opts.mtime ?? mtimeOf
  let best = { channel: 'stable', at: -Infinity }
  for (const channel of ZED_CHANNELS) {
    const db = zedDbFile(dataDir, channel, join)
    const at = Math.max(mtime(db) ?? -Infinity, mtime(`${db}-wal`) ?? -Infinity)
    if (at > best.at) best = { channel, at }
  }
  return best.channel
}

/** Les chemins de ce poste, calculés une fois à l'import, pour le canal détecté. */
export const PATHS = zedPaths({ channel: detectZedChannel() })

// ---------------------------------------------------------------------------
// La CLI de Zed
// ---------------------------------------------------------------------------

/**
 * Candidats absolus, dans l'ordre, avant le repli sur `zed` dans le PATH.
 *
 * Le PATH n'est pas acquis : un service `systemd --user` démarre avec
 * un PATH minimal, et l'installeur de Zed pose un symlink dans `~/.local/bin`,
 * que `.profile` ajoute mais `.bashrc` non.
 *
 * Fait établi ici :
 *   $ which zed            → ~/.local/bin/zed
 *   $ ls -la ~/.local/bin/zed
 *     → ~/.local/zed.app/bin/zed
 *   $ zed --version        → … ~/.local/zed.app/libexec/zed-editor
 */
export function zedCliCandidates(opts = {}) {
  const { platform, env, home, join } = ctx(opts)
  const channel = opts.channel ?? 'stable'
  const stable = channel === 'stable'
  // Dossiers d'installation par canal, d'après les installeurs de Zed :
  // `script/bundle-windows.ps1` (« Zed Preview »…), `script/install.sh` (`zed-preview.app`…).
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || join(home, 'AppData', 'Local')
    const app = stable ? 'Zed' : `Zed ${channel[0].toUpperCase()}${channel.slice(1)}`
    return [join(local, 'Programs', app, 'bin', 'zed.exe')]
  }
  const app = join(home, '.local', stable ? 'zed.app' : `zed-${channel}.app`, 'bin', 'zed')
  // `~/.local/bin/zed` pointe vers le dernier canal installé : le dossier du
  // canal passe d'abord quand ce n'est pas stable.
  return stable
    ? [join(home, '.local', 'bin', 'zed'), app, '/usr/local/bin/zed', '/usr/bin/zed']
    : [app, join(home, '.local', 'bin', 'zed'), '/usr/local/bin/zed', '/usr/bin/zed']
}

/** Premier candidat présent sur le disque, sinon `zed` (résolu par le PATH). */
export function defaultZedCli(opts = {}) {
  const found = zedCliCandidates(opts).find((p) => { try { return existsSync(p) } catch { return false } })
  return found ?? 'zed'
}

// ---------------------------------------------------------------------------
// Détection du processus Zed
// ---------------------------------------------------------------------------

/**
 * Noms de processus à chercher, dans l'ordre.
 *
 * Windows : `tasklist /FI "IMAGENAME eq zed.exe"` — branche gelée, inchangée.
 *
 * Linux : le binaire qui tourne s'appelle **`zed-editor`**, pas `zed`.
 * Fait établi, et c'était un bug réel (`agents.js` cherchait `pgrep -x zed`) :
 *   $ pgrep -x zed         → (vide) ; rc=1
 *   $ pgrep -x zed-editor  → 17496  17518
 *   $ cat /proc/17496/comm → zed-editor
 *   $ node -e '…isZedRunning()' → false, alors que Zed était ouvert
 * `zed` dans le PATH n'est qu'une CLI courte durée qui parle à l'éditeur par
 * un socket (`zed-cli:///tmp/.tmpXXXX/socket`) : elle ne dit rien de la
 * présence d'une fenêtre. Les deux noms sont proposés, dans cet ordre.
 *
 * @returns {string[]}
 */
export function zedProcessNames(opts = {}) {
  const { platform } = ctx(opts)
  if (platform === 'win32') return ['zed.exe']
  // macOS est hors périmètre du portage et n'a pas été vérifié : `Zed` est le
  // nom que le code antérieur cherchait déjà, il est conservé tel quel.
  if (platform === 'darwin') return ['Zed', 'zed-editor', 'zed']
  return ['zed-editor', 'zed']
}

/** Comment on cherche ces noms : `tasklist` en Windows, `pgrep` ailleurs. */
export function processProbe(opts = {}) {
  return ctx(opts).platform === 'win32' ? 'tasklist' : 'pgrep'
}

// ---------------------------------------------------------------------------
// Démarrage à l'ouverture de session
// ---------------------------------------------------------------------------

/**
 * Le backend de `npm run service`.
 *
 * Windows : la tâche planifiée `schtasks` + `scripts/daemon-task.ps1` — gelée,
 * intouchable, et la seule qui ait été vérifiée sous Windows.
 * Linux avec systemd en init : `systemd --user` (`scripts/lib/systemd.mjs`).
 * Linux sans systemd en init (MX Linux et ses dérivés) : entrée d'autostart XDG
 * (`scripts/lib/autostart.mjs`) — `~/.config/autostart`, lu par Xfce, GNOME,
 * KDE et LXQt à l'ouverture de session, sans sudo.
 *
 * Pourquoi pas `/etc/init.d` ni cron `@reboot` sur ces machines : ils partent
 * AVANT la session graphique, donc sans `DISPLAY` — et sans `DISPLAY`,
 * `xdotool` ne vise aucune fenêtre. Le pilotage de Zed impose la session.
 *
 * Les trois backends ont les MÊMES six verbes. Le choix est fait ici pour que
 * `service.mjs` n'ait pas à connaître l'OS. `systemdInit` est injectable
 * (comme `detect` pour `ZedPresence`) : il se teste sans machine.
 */
export function serviceBackend(opts = {}) {
  const { platform } = ctx(opts)
  if (platform === 'win32') return 'schtasks'
  const init = opts.systemdInit ?? systemdIsInit({ platform })
  return init ? 'systemd' : 'autostart'
}

/**
 * systemd est-il **l'init** de cette machine (PID 1) ?
 *
 * Le marqueur est celui de `sd_booted()` de systemd lui-même : le dossier
 * `/run/systemd/system` n'existe que si systemd tourne comme init. La version
 * du paquet ne dit rien : systemd peut être installé sans être l'init.
 *
 * Fait établi sur MX Linux 23 (HP Pavilion x2), où ce test vaut false :
 *   $ dpkg -l | grep -E 'systemd|sysvinit' → systemd 1:252.6-1mx23+1,
 *     sysvinit-core 3.06-4, systemd-shim 10-6
 *   $ cat /proc/1/comm                   → init      (sysvinit, pas systemd)
 *   $ ls /run/systemd/system             → inexistant
 *   $ systemctl --user is-system-running → offline
 *   $ loginctl show-user 1000 -p Linger
 *     System has not been booted with systemd as init system (PID 1). Can't operate.
 *   $ journalctl --user -n 5             → No journal files were found
 * systemd 252 est donc installé, et `systemd --user` y est impossible : ni user
 * manager, ni linger, ni journal.
 *
 * @param {{ platform?:string }} [opts]
 * @returns {boolean}
 */
export function systemdIsInit({ platform = process.platform } = {}) {
  if (platform === 'win32') return false
  return existsSync('/run/systemd/system')
}

// ---------------------------------------------------------------------------
// Clavier
// ---------------------------------------------------------------------------

/**
 * Ordre de préférence des backends d'injection clavier, **avant** toute
 * vérification de ce qui est réellement installé (c'est le rôle de
 * `zed/keyboard.js`, qui a besoin de lancer des processus).
 *
 * **xdotool partout**.
 * Un client X11 ne voit pas les fenêtres Wayland natives, donc sous Wayland Zed
 * est forcé sous XWayland (`WAYLAND_DISPLAY=` dans son `.desktop`, voir
 * `scripts/lib/wayland.mjs`) — et xdotool retrouve ses fenêtres. Sous X11, rien
 * à forcer.
 *
 * Deux sessions mesurées :
 *   Ubuntu 24.04 / GNOME : `echo $XDG_SESSION_TYPE $WAYLAND_DISPLAY` → `wayland wayland-0`
 *   MX Linux 23 / Xfce   : `x11`, `DISPLAY=:0`, `WAYLAND_DISPLAY` vide
 * Dans les deux cas la préférence est la même : `xdotool`, puis `none`.
 *
 * @returns {string[]} du plus préféré au moins préféré, `none` en dernier
 */
export function keyboardPreference(opts = {}) {
  const { platform, env } = ctx(opts)
  if (platform === 'win32') return ['powershell', 'none']
  // Linux : xdotool partout (X11 natif, ou Wayland + XWayland pour Zed).
  // Zed est forcé sous XWayland via WAYLAND_DISPLAY= dans le .desktop.
  return ['xdotool', 'none']
}

/** Les backends que ZRA sait jouer. `none` = pas de clavier, refus explicite. */
export const KEYBOARD_BACKENDS = ['powershell', 'xdotool', 'none']

// ---------------------------------------------------------------------------
// Garde éveillé (inhibition de veille)
// ---------------------------------------------------------------------------

/**
 * Le helper résident qui interdit la veille automatique
 * (`reference/conception-zra-veille.md`). L'inhibition est portée par la durée
 * de vie de ce processus : le daemon le spawn pour inhiber, le tue pour
 * relâcher ; sa mort (crash du daemon compris) relâche tout côté OS.
 *
 * Windows : `keep-awake.ps1` appelle `SetThreadExecutionState` puis reste
 * vivant — un one-shot ne tiendrait rien, l'état meurt avec le processus.
 * Linux : `systemd-inhibit` (logind) autour d'un `sleep infinity`. La présence
 * de logind n'est pas acquise (MX Linux est sysvinit) : `keep-awake.js` la
 * constate à l'exécution, pas ici.
 * macOS : hors périmètre, pas de helper.
 *
 * @param {{ platform?:string, why?:string }} [opts]
 * @returns {{ command:string, args:string[] }|null}
 */
export function keepAwakeHelper(opts = {}) {
  const { platform } = ctx(opts)
  if (platform === 'win32') {
    const script = fileURLToPath(new URL('./keep-awake.ps1', import.meta.url))
    return { command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-File', script] }
  }
  if (platform === 'darwin') return null
  return {
    command: 'systemd-inhibit',
    args: ['--what=sleep', '--mode=block', '--who=ZRA', `--why=${opts.why ?? 'ZRA'}`, 'sleep', 'infinity'],
  }
}

// ---------------------------------------------------------------------------
// Réseaux marqués « Public »
// ---------------------------------------------------------------------------

/**
 * Noms des interfaces dont le réseau est marqué « Public » — le choix proposé
 * par Windows à la première connexion (café, hôtel). Le daemon n'y écoute pas.
 * Linux n'a pas d'équivalent standard : ensemble vide, `lanCidrs` fait le tri.
 *
 * Les tunnels (WireGuard, Tailscale) sont exclus : Windows les marque toujours
 * « Public » faute de pouvoir les identifier, alors qu'ils sont authentifiés.
 *
 * @returns {Promise<{ names:Set<string>, error?:string }>}
 */
export function publicNetworks({ platform = process.platform } = {}) {
  if (platform !== 'win32' || process.env.NODE_TEST_CONTEXT) return Promise.resolve({ names: new Set() })
  // `Get-NetAdapter` met plus de 10 s sur certains postes : l'API .NET répond vite.
  const script = '[Console]::OutputEncoding = [Text.Encoding]::UTF8; ' +
    '$tun = [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces() | ' +
    "Where-Object Description -match 'WireGuard|Tailscale|Wintun' | ForEach-Object Name; " +
    "Get-NetConnectionProfile | Where-Object NetworkCategory -eq 'Public' | " +
    'Where-Object { $tun -notcontains $_.InterfaceAlias } | ForEach-Object InterfaceAlias'
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 10_000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve({ names: new Set(), error: err.message })
      resolve({ names: new Set(stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) })
    })
  })
}
