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
// Clavier
// ---------------------------------------------------------------------------

/**
 * Ordre de préférence des backends d'injection clavier, **avant** toute
 * vérification de ce qui est réellement installé (c'est le rôle de
 * `zed/keyboard.js`, qui a besoin de lancer des processus).
 *
 * Fait établi ici : la session est Wayland sous GNOME.
 *   $ echo $XDG_SESSION_TYPE $WAYLAND_DISPLAY → wayland wayland-0
 *   $ loginctl show-session … -p Type         → Type=wayland
 * Un client X11 (`xdotool`) ne voit pas les fenêtres Wayland natives : Zed est
 * un client Wayland (GPUI), donc `xdotool` est inopérant dans cette session,
 * même installé. `DISPLAY=:0` est posé quand même — c'est XWayland, pour les
 * applications X11.
 *
 * La cible de production du projet est Debian 13 / KDE / **X11** : `xdotool`
 * reste donc le backend principal à terme, il est seulement inutile *ici*.
 *
 * @returns {string[]} du plus préféré au moins préféré, `none` en dernier
 */
export function keyboardPreference(opts = {}) {
  const { platform, env } = ctx(opts)
  if (platform === 'win32') return ['powershell', 'none']
  // Wayland : ydotool passe par `/dev/uinput` (noyau), donc indépendant du
  // compositeur ; wtype passe par le protocole `virtual-keyboard`, que les
  // compositeurs n'implémentent pas tous. X11 (ou inconnu) : xdotool d'abord.
  const wayland = env.XDG_SESSION_TYPE === 'wayland' || Boolean(env.WAYLAND_DISPLAY)
  return wayland
    ? ['ydotool', 'wtype', 'xdotool', 'none']
    : ['xdotool', 'ydotool', 'wtype', 'none']
}

/** Les backends que ZRA sait jouer. `none` = pas de clavier, refus explicite. */
export const KEYBOARD_BACKENDS = ['powershell', 'xdotool', 'ydotool', 'wtype', 'none']
