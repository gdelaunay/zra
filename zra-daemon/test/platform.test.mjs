// Module plateforme — le seul endroit où ZRA connaît l'OS.
//
// Deux jeux de valeurs, côte à côte et jamais en remplacement :
//   - Windows : le comportement **gelé** (règle n°1 du portage). Les chemins
//     attendus sont recopiés de ce que `config.js` et `agent-commands.js`
//     produisaient avant le module plateforme ; le test dit « rien n'a bougé ».
//   - Linux : les chemins **réels** de la machine de portage, relevés à la
//     commande (Ubuntu 24.04.3, Zed 1.23.2, voir l'en-tête de `platform.js`).
//
// `zedPaths()` prend la plateforme, l'environnement et le home en paramètres :
// les deux jeux se vérifient depuis n'importe quel OS hôte, et le séparateur
// suit la plateforme visée (`C:\…` reste `C:\…` même calculé depuis Linux).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'

import {
  KEYBOARD_BACKENDS, PATHS, defaultZedCli, keyboardPreference, processProbe,
  zedCliCandidates, zedPaths, zedProcessNames,
} from '../platform.js'

// ---- fixtures Windows : ce que le code produisait avant le portage ----------

const WIN_HOME = 'C:\\Users\\test'
const WIN_ENV = {
  LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local',
  APPDATA: 'C:\\Users\\test\\AppData\\Roaming',
}
const win = zedPaths({ platform: 'win32', env: WIN_ENV, home: WIN_HOME })

test('windows (gelé) : les chemins de Zed sont ceux d’avant le module plateforme', () => {
  assert.equal(win.db, 'C:\\Users\\test\\AppData\\Local\\Zed\\db\\0-stable\\db.sqlite')
  assert.equal(win.settings, 'C:\\Users\\test\\AppData\\Roaming\\Zed\\settings.json')
  assert.equal(win.keymap, 'C:\\Users\\test\\AppData\\Roaming\\Zed\\keymap.json')
  assert.equal(win.registryDir, 'C:\\Users\\test\\AppData\\Local\\Zed\\external_agents\\registry')
  assert.equal(win.dataDir, 'C:\\Users\\test\\AppData\\Local\\Zed')
  assert.equal(win.configDir, 'C:\\Users\\test\\AppData\\Roaming\\Zed')
})

test('windows (gelé) : les fichiers de ZRA restent sous %LOCALAPPDATA%\\zra', () => {
  assert.equal(win.appDir, 'C:\\Users\\test\\AppData\\Local\\zra')
  assert.equal(win.injectionLog, 'C:\\Users\\test\\AppData\\Local\\zra\\injections.log')
  assert.equal(win.recordsDir, 'C:\\Users\\test\\AppData\\Local\\zra\\records')
})

test('windows (gelé) : sans variables d’environnement, on retombe sur le home', () => {
  const p = zedPaths({ platform: 'win32', env: {}, home: WIN_HOME })
  assert.equal(p.db, 'C:\\Users\\test\\AppData\\Local\\Zed\\db\\0-stable\\db.sqlite')
  assert.equal(p.settings, 'C:\\Users\\test\\AppData\\Roaming\\Zed\\settings.json')
})

test('windows (gelé) : CLI, processus et clavier', () => {
  assert.deepEqual(zedCliCandidates({ platform: 'win32', env: WIN_ENV, home: WIN_HOME }),
    ['C:\\Users\\test\\AppData\\Local\\Programs\\Zed\\bin\\zed.exe'])
  assert.deepEqual(zedProcessNames({ platform: 'win32' }), ['zed.exe'])
  assert.equal(processProbe({ platform: 'win32' }), 'tasklist')
  assert.deepEqual(keyboardPreference({ platform: 'win32', env: {} }), ['powershell', 'none'])
})

// ---- Linux : les chemins réels de la machine de portage ---------------------
// Relevés sur Ubuntu 24.04.3 / Zed 1.23.2 :
//   $ ls ~/.local/share/zed/db/0-stable → db.sqlite db.sqlite-shm db.sqlite-wal
//   $ ls ~/.config/zed                  → settings.json themes/
//   $ ls ~/.local/share/zed/external_agents/registry → registry.json icons/
//   $ echo "$XDG_DATA_HOME|$XDG_CONFIG_HOME|$XDG_STATE_HOME" → "||"

const LX_HOME = '/home/test'
const lx = zedPaths({ platform: 'linux', env: {}, home: LX_HOME })

test('linux : les chemins de Zed suivent XDG, comme sur la machine de portage', () => {
  assert.equal(lx.dataDir, '/home/test/.local/share/zed')
  assert.equal(lx.configDir, '/home/test/.config/zed')
  assert.equal(lx.db, '/home/test/.local/share/zed/db/0-stable/db.sqlite')
  assert.equal(lx.settings, '/home/test/.config/zed/settings.json')
  assert.equal(lx.keymap, '/home/test/.config/zed/keymap.json')
  assert.equal(lx.registryDir, '/home/test/.local/share/zed/external_agents/registry')
})

test('linux : XDG_DATA_HOME / XDG_CONFIG_HOME / XDG_STATE_HOME priment', () => {
  const p = zedPaths({
    platform: 'linux',
    env: { XDG_DATA_HOME: '/data', XDG_CONFIG_HOME: '/conf', XDG_STATE_HOME: '/state' },
    home: LX_HOME,
  })
  assert.equal(p.db, '/data/zed/db/0-stable/db.sqlite')
  assert.equal(p.settings, '/conf/zed/settings.json')
  assert.equal(p.registryDir, '/data/zed/external_agents/registry')
  assert.equal(p.injectionLog, '/state/zra/injections.log')
  assert.equal(p.recordsDir, '/state/zra/records')
})

test('linux : les fichiers de ZRA vont dans XDG_STATE_HOME, par défaut ~/.local/state/zra', () => {
  assert.equal(lx.appDir, '/home/test/.local/state/zra')
  assert.equal(lx.injectionLog, '/home/test/.local/state/zra/injections.log')
  assert.equal(lx.recordsDir, '/home/test/.local/state/zra/records')
})

test('linux : le séparateur suit la plateforme visée, pas l’OS hôte', () => {
  // Calculé depuis Linux comme depuis Windows, un chemin Windows garde ses
  // antislashes et un chemin Linux ses slashes : c'est ce qui permet de
  // vérifier la branche gelée sans machine Windows.
  assert.ok(win.db.includes('\\') && !win.db.includes('/'))
  assert.ok(lx.db.includes('/') && !lx.db.includes('\\'))
})

test('linux : Zed tourne sous le nom zed-editor, pas zed', () => {
  // Fait établi : `pgrep -x zed` → rc=1 ; `pgrep -x zed-editor` → deux pid ;
  // `cat /proc/<pid>/comm` → zed-editor.
  assert.deepEqual(zedProcessNames({ platform: 'linux' }), ['zed-editor', 'zed'])
  assert.equal(processProbe({ platform: 'linux' }), 'pgrep')
})

test('linux : l’ordre des backends clavier suit la session', () => {
  // Wayland (cette machine) : xdotool ne voit pas les fenêtres Wayland natives.
  assert.deepEqual(keyboardPreference({ platform: 'linux', env: { XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-0' } }),
    ['ydotool', 'wtype', 'xdotool', 'none'])
  // X11 (Debian 13 / KDE, la cible de production) : xdotool d'abord.
  assert.deepEqual(keyboardPreference({ platform: 'linux', env: { XDG_SESSION_TYPE: 'x11', DISPLAY: ':0' } }),
    ['xdotool', 'ydotool', 'wtype', 'none'])
  // Session inconnue : on ne devine pas, on garde l'ordre X11.
  assert.deepEqual(keyboardPreference({ platform: 'linux', env: {} }),
    ['xdotool', 'ydotool', 'wtype', 'none'])
  for (const order of ['wayland', 'x11', 'inconnue']) {
    const env = order === 'wayland' ? { XDG_SESSION_TYPE: 'wayland' } : order === 'x11' ? { XDG_SESSION_TYPE: 'x11' } : {}
    const pref = keyboardPreference({ platform: 'linux', env })
    assert.equal(pref.at(-1), 'none', 'none reste toujours le dernier repli')
    assert.ok(pref.every((b) => KEYBOARD_BACKENDS.includes(b)), `backend inconnu dans ${pref}`)
  }
})

// ---- sur CETTE machine (Linux uniquement : les faits, pas des fixtures) -----

test('machine de portage : les chemins par défaut pointent sur des fichiers qui existent', { skip: process.platform === 'win32' && 'Windows : rien à vérifier ici' }, () => {
  assert.equal(PATHS.platform, process.platform)
  assert.ok(existsSync(PATHS.db), `db.sqlite attendu ici : ${PATHS.db}`)
  assert.ok(existsSync(PATHS.settings), `settings.json attendu ici : ${PATHS.settings}`)
  assert.ok(existsSync(PATHS.registryDir), `registry attendu ici : ${PATHS.registryDir}`)
  // Le keymap.json n'existe pas tant que `npm run setup` ne l'a pas écrit.
  assert.equal(PATHS.keymap, `${PATHS.configDir}/keymap.json`)
})

test('machine de portage : la CLI de Zed est trouvée sans dépendre du PATH', { skip: process.platform === 'win32' && 'Windows : branche gelée' }, () => {
  // Fait établi : `which zed` → /home/gdelaunay/.local/bin/zed, symlink vers
  // ~/.local/zed.app/bin/zed. Un service systemd --user n'aura pas ce PATH.
  const cli = defaultZedCli()
  assert.notEqual(cli, 'zed', 'un candidat absolu doit exister sur cette machine')
  assert.ok(existsSync(cli), `CLI introuvable : ${cli}`)
  assert.ok(zedCliCandidates().includes(cli))
})
