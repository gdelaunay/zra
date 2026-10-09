// Wayland : forcer Zed sous XWayland pour que xdotool voie ses fenêtres
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const STATE = join(process.cwd(), '.zra')

/**
 * Détecte si on est sous Wayland.
 */
export function isWayland(env = process.env) {
  return env.XDG_SESSION_TYPE === 'wayland' || Boolean(env.WAYLAND_DISPLAY)
}

/**
 * Trouve le .desktop de Zed.
 */
export function findZedDesktop() {
  const candidates = [
    join(process.env.HOME ?? '', '.local/share/applications/dev.zed.Zed.desktop'),
    join(process.env.HOME ?? '', '.local/share/applications/zed.desktop'),
    '/usr/share/applications/dev.zed.Zed.desktop',
    '/usr/share/applications/zed.desktop',
  ]
  for (const c of candidates) if (existsSync(c)) return c
  return null
}

/**
 * Modifie le .desktop pour forcer XWayland.
 */
export async function patchDesktopForXWayland(apply) {
  if (!isWayland()) return { action: 'skip', reason: 'X11 détecté, pas besoin de forcer XWayland' }
  const file = findZedDesktop()
  if (!file) return { action: 'skip', reason: '.desktop de Zed introuvable' }

  const original = await readFile(file, 'utf8')
  // Déjà patché ?
  if (/^Exec=env WAYLAND_DISPLAY= /m.test(original)) {
    return { action: 'unchanged', file }
  }

  // Modifier toutes les lignes Exec= qui lancent zed
  const patched = original.replace(
    /^(Exec=)(\/.+?\/zed)(.*)$/gm,
    '$1env WAYLAND_DISPLAY= $2$3'
  )

  if (patched === original) {
    return { action: 'skip', reason: 'aucune ligne Exec= trouvée dans le .desktop' }
  }

  if (!apply) {
    return { action: 'dry-run', file, original, patched }
  }

  // Sauvegarde
  const backups = join(STATE, 'backups')
  await mkdir(backups, { recursive: true })
  const backup = join(backups, `zed-desktop.${new Date().toISOString().replace(/[:.]/g, '-')}.desktop`)
  await copyFile(file, backup)
  await writeFile(file, patched, 'utf8')

  return { action: 'patched', file, backup }
}

/**
 * Restaure le .desktop de Zed à son état original.
 */
export async function unpatchDesktop(apply) {
  const file = findZedDesktop()
  if (!file) return { action: 'skip', reason: '.desktop de Zed introuvable' }

  const original = await readFile(file, 'utf8')
  // Pas patché ?
  if (!/^Exec=env WAYLAND_DISPLAY= /m.test(original)) {
    return { action: 'unchanged', file }
  }

  // Retirer le patch
  const restored = original.replace(
    /^(Exec=)env WAYLAND_DISPLAY= (\/.+?\/zed)(.*)$/gm,
    '$1$2$3'
  )

  if (!apply) {
    return { action: 'dry-run', file, original, restored }
  }

  // Sauvegarde avant restauration
  const backups = join(STATE, 'backups')
  await mkdir(backups, { recursive: true })
  const backup = join(backups, `zed-desktop.${new Date().toISOString().replace(/[:.]/g, '-')}.desktop`)
  await copyFile(file, backup)
  await writeFile(file, restored, 'utf8')

  return { action: 'restored', file, backup }
}
