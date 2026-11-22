// Le binaire du tray, s'il est là : point d'entrée unique des trois backends
// de `npm run service` (tâche Windows, unité systemd --user, autostart XDG).
// Le tray supervise node lui-même (restart, journal, single-instance) ;
// absent, chaque backend retombe sur son lancement historique du daemon.
//
// Cherché dans l'ordre : téléchargé au setup, build release, build dev, puis
// racine de l'archive « app » (le binaire est à côté de app/, root = app/).

import { existsSync } from 'node:fs'
import { join } from 'node:path'

export function trayBinary(root, platform = process.platform) {
  const exe = platform === 'win32' ? 'zra-tray.exe' : 'zra-tray'
  const candidates = [
    join(root, '.zra', 'bin', exe),
    join(root, 'zra-tray', 'target', 'release', exe),
    join(root, 'zra-tray', 'target', 'debug', exe),
    join(root, '..', exe),
  ]
  return candidates.find((p) => existsSync(p)) ?? null
}