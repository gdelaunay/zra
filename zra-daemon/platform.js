// Toute la spécificité plateforme de ZRA vit ici — et nulle part ailleurs.
//
// Règle du portage Linux : aucun `if (process.platform === 'win32')` dispersé
// dans le code. Les modules appelants demandent un chemin, un nom de processus
// ou un ordre de préférence à ce module ; ils ne savent pas sur quel OS ils
// tournent. Le comportement Windows existant est **inchangé** : il est gelé, il
// ne peut plus être testé d'ici, donc on ajoute des branches à côté, on ne
// corrige rien.
//
// Chaque valeur Linux ci-dessous est un FAIT ÉTABLI sur la machine de portage,
// recopié depuis la sortie réelle d'une commande (SPEC.md §2, discipline
// appliquée de l'autre côté). Jamais une déduction de la documentation.
//
//   $ cat /etc/os-release → PRETTY_NAME="Ubuntu 24.04.3 LTS"
//   $ uname -a            → Linux Pavilion 6.17.0-14-generic … x86_64
//   $ echo $XDG_SESSION_TYPE $WAYLAND_DISPLAY $DISPLAY $XDG_CURRENT_DESKTOP
//     wayland wayland-0 :0 ubuntu:GNOME
//   $ zed --version       → Zed 1.23.2 c0199504… – /home/gdelaunay/.local/zed.app/libexec/zed-editor
//   $ which zed           → /home/gdelaunay/.local/bin/zed
//     (symlink → /home/gdelaunay/.local/zed.app/bin/zed)
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
// macOS n'est pas dans le périmètre du portage et n'a pas été vérifié : la
// branche non-Windows est la branche XDG, elle n'affirme rien sur Darwin.

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'

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
 * @param {{ platform?:string, env?:object, home?:string }} [opts]
 * @returns {{
 *   platform:string, dataDir:string, configDir:string, db:string, settings:string,
 *   keymap:string, registryDir:string, appDir:string, injectionLog:string,
 *   recordsDir:string,
 * }}
 */
export function zedPaths(opts = {}) {
  const { platform, env, home, join } = ctx(opts)

  if (platform === 'win32') {
    // Inchangé depuis la version Windows vérifiée (SPEC.md §2.1, §2.2).
    const local = env.LOCALAPPDATA || join(home, 'AppData', 'Local')
    const roaming = env.APPDATA || join(home, 'AppData', 'Roaming')
    const dataDir = join(local, 'Zed')
    const configDir = join(roaming, 'Zed')
    return finish(platform, join, {
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
  return finish(platform, join, {
    dataDir,
    configDir,
    // Journaux et enregistrements de ZRA : `XDG_STATE_HOME` est le rôle prévu
    // par la spec XDG pour ce qui s'écrit en continu (Windows : `%LOCALAPPDATA%\zra`).
    appDir: join(state, 'zra'),
    registryDir: join(dataDir, 'external_agents', 'registry'),
  })
}

/** Les chemins qui se déduisent des deux dossiers racine, et ceux de ZRA. */
function finish(platform, join, { dataDir, configDir, appDir, registryDir }) {
  return {
    platform,
    dataDir,
    configDir,
    // Fait établi ici : `~/.local/share/zed/db/0-stable/db.sqlite`, même
    // disposition qu'en Windows, même schéma `sidebar_threads` (relu en
    // lecture seule : 1 ligne, `agent_id: "pi-acp"`).
    db: join(dataDir, 'db', '0-stable', 'db.sqlite'),
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

/** Les chemins de ce poste, calculés une fois à l'import. */
export const PATHS = zedPaths()

// ---------------------------------------------------------------------------
// La CLI de Zed
// ---------------------------------------------------------------------------

/**
 * Candidats absolus, dans l'ordre, avant le repli sur `zed` dans le PATH.
 *
 * Le PATH n'est pas acquis : un service `systemd --user` (étape 4) démarre avec
 * un PATH minimal, et l'installeur de Zed pose un symlink dans `~/.local/bin`,
 * que `.profile` ajoute mais `.bashrc` non.
 *
 * Fait établi ici :
 *   $ which zed            → /home/gdelaunay/.local/bin/zed
 *   $ ls -la ~/.local/bin/zed
 *     → /home/gdelaunay/.local/zed.app/bin/zed
 *   $ zed --version        → … /home/gdelaunay/.local/zed.app/libexec/zed-editor
 */
export function zedCliCandidates(opts = {}) {
  const { platform, env, home, join } = ctx(opts)
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || join(home, 'AppData', 'Local')
    return [join(local, 'Programs', 'Zed', 'bin', 'zed.exe')]
  }
  return [
    join(home, '.local', 'bin', 'zed'),
    join(home, '.local', 'zed.app', 'bin', 'zed'),
    '/usr/local/bin/zed',
    '/usr/bin/zed',
  ]
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
 * `d911219` a simplifié : **xdotool partout**, `ydotool`/`wtype` supprimés.
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
