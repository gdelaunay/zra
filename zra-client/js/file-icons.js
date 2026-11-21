// Jeu d'icônes de fichiers (puces de mention, menu de complétion).
//
// Port de `FileIcons::get_icon` (crates/file_icons/src/file_icons.rs) : le nom
// complet d'abord, puis chaque suffixe après un point, puis le préfixe d'avant
// le premier point (Dockerfile.prod), les extensions composées, le nom de
// fichier caché (.gitignore), l'extension simple, et le type « default ».
// Les associations viennent du défaut Zed, écrasées par le jeu choisi
// (registry.rs fusionne de la même façon).
//
// Écart assumé : Zed retombe sur les SVG monochromes du thème par défaut pour
// un type absent du jeu actif ; nous retombons sur l'icône générique file-text.
// Les dossiers n'ont pas d'icône dédiée dans les jeux colorés : folder générique.

import { icon } from './icons.js'
import { settings } from './settings.js'
import { tr } from './i18n.js'
import { BASE_STEMS, BASE_SUFFIXES, COLORED_THEMES } from './file-icons-data.js'

/** Choix des réglages, dans l'ordre du menu. Noms propres non traduits. */
export const ICON_SETS = [
  { id: 'default', name: tr`Défaut` },
  { id: 'colored-dark', name: 'Colored Zed Dark' },
  { id: 'colored-light', name: 'Colored Zed Light' },
]

/** Extension au sens de Rust : pas de point initial (fichier caché) ni final. */
function extension(name) {
  const i = name.lastIndexOf('.')
  return i > 0 && i < name.length - 1 ? name.slice(i + 1) : null
}

/** File stem au sens de Rust : « .gitignore » reste entier, « a.tar.gz » -> « a.tar ». */
function fileStem(name) {
  const i = name.lastIndexOf('.')
  return i > 0 ? name.slice(0, i) : name
}

/**
 * Type d'icône d'un chemin, pour les cartes d'un jeu (pur, testable sans DOM).
 * @param {string} path
 * @param {{stems:Object, suffixes:Object}} maps
 */
export function fileIconType(path, maps) {
  const lookup = (s) => maps.stems[s] ?? maps.suffixes[s]
  const name = String(path || '').split(/[\\/]/).pop()
  if (!name) return 'default'

  let typ = lookup(name)
  if (typ) return typ

  // Chaque suffixe après un point, du plus long au plus court ; le premier
  // préfixe sert de repli (stems : Dockerfile.prod, Podfile.lock).
  let firstPrefix = null
  let rest = name
  for (;;) {
    const i = rest.indexOf('.')
    if (i < 0) break
    if (firstPrefix === null) firstPrefix = rest.slice(0, i)
    typ = lookup(rest.slice(i + 1))
    if (typ) return typ
    rest = rest.slice(i + 1)
  }
  if (firstPrefix !== null) {
    typ = lookup(firstPrefix)
    if (typ) return typ
  }

  // Extensions composées (Component.stories.tsx -> stories.tsx).
  const parts = name.split('.').slice(1)
  if (parts.length >= 2) {
    typ = lookup(parts.join('.'))
    if (typ) return typ
  }

  // Fichier caché (.gitignore -> gitignore), sinon extension ou stem.
  typ = lookup(name.startsWith('.') ? name.slice(1) : (extension(name) ?? fileStem(name)))
  if (typ) return typ

  const ext = extension(name)
  return (ext && lookup(ext)) || 'default'
}

/** Cartes fusionnées d'un jeu, ou null pour le jeu générique. */
function mapsFor(setId) {
  const t = COLORED_THEMES[setId]
  if (!t) return null
  return {
    stems: { ...BASE_STEMS, ...t.stems },
    suffixes: { ...BASE_SUFFIXES, ...t.suffixes },
    icons: t.fileIcons,
  }
}

/** URL du SVG d'un fichier pour le jeu choisi, ou null (icône générique). */
export function fileIconUrl(path, setId = settings.iconSet) {
  const maps = mapsFor(setId)
  if (!maps) return null
  return maps.icons[fileIconType(path, maps)] ?? null
}

/**
 * Icône d'un fichier ou dossier, selon le jeu des réglages : SVG générique
 * (défaut) ou <img> du thème coloré. Même gabarit que `icon()` (classes icon).
 */
export function fileIcon(path, isDir, cls = 'icon--sm') {
  const url = !isDir && fileIconUrl(path)
  if (url) {
    const img = document.createElement('img')
    img.className = `icon ${cls}`.trim()
    img.src = url
    img.alt = ''
    img.setAttribute('aria-hidden', 'true')
    return img
  }
  return icon(isDir ? 'folder' : 'file-text', cls)
}