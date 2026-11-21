// Wayland : forcer Zed sous XWayland pour que xdotool voie ses fenêtres.
// Étape explicite du setup (`setup xwayland --apply`) : elle change le rendu
// de Zed pour tout le poste, l'installation ne la fait plus d'office.
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tr } from '../../zra-daemon/i18n.js'

// La racine du dépôt, comme ailleurs — pas le répertoire courant.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const STATE = join(ROOT, '.zra')

/** Message clair quand le .desktop est système et non inscriptible. */
function unwritable(file, err) {
  return new Error(
    tr`.desktop de Zed non inscriptible (${file}) : ${err.code}. Copier ce fichier dans ~/.local/share/applications/ (il prime sur celui du système) puis relancer, ou modifier le fichier système avec les droits adaptés.`,
  )
}

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
  if (!isWayland()) return { action: 'skip', reason: tr`X11 détecté, pas besoin de forcer XWayland.` }
  const file = findZedDesktop()
  if (!file) return { action: 'skip', reason: tr`.desktop de Zed introuvable.` }

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
    return { action: 'skip', reason: tr`Aucune ligne Exec= trouvée dans le .desktop.` }
  }

  if (!apply) {
    return { action: 'dry-run', file, original, patched }
  }

  // Sauvegarde
  const backups = join(STATE, 'backups')
  await mkdir(backups, { recursive: true })
  const backup = join(backups, `zed-desktop.${new Date().toISOString().replace(/[:.]/g, '-')}.desktop`)
  await copyFile(file, backup)
  try {
    await writeFile(file, patched, 'utf8')
  } catch (err) {
    if (err.code === 'EACCES' || err.code === 'EPERM') throw unwritable(file, err)
    throw err
  }

  return { action: 'patched', file, backup }
}

/**
 * Restaure le .desktop de Zed à son état original.
 */
export async function unpatchDesktop(apply) {
  const file = findZedDesktop()
  if (!file) return { action: 'skip', reason: tr`.desktop de Zed introuvable.` }

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
  try {
    await writeFile(file, restored, 'utf8')
  } catch (err) {
    if (err.code === 'EACCES' || err.code === 'EPERM') return { action: 'unwritable', file, reason: unwritable(file, err).message }
    throw err
  }

  return { action: 'restored', file, backup }
}
