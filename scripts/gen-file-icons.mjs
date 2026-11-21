// Génère zra-client/js/file-icons-data.js : associations nom/extension -> type
// d'icône lues dans les sources Zed (`icon_theme.rs`), et cartes type -> SVG
// des thèmes colorés vendored (`zra-client/icon-themes/colored-zed/theme.json`,
// extension TheRedXD/zed-icons-colored-theme). Le fichier produit est committé :
// la PWA n'a aucun build.
//   node scripts/gen-file-icons.mjs
import { readFileSync, writeFileSync } from 'node:fs'

const ZED = '_upstream/zed/crates/theme/src/icon_theme.rs'
const THEME = 'zra-client/icon-themes/colored-zed/theme.json'
const OUT = 'zra-client/js/file-icons-data.js'

// Constantes Rust `("type", &["suffixe", …]),` (multi-lignes) -> { suffixe: type }.
// Zed les inverse de la même façon (`icon_keys_by_association`).
function associations(src, name) {
  const block = src.match(new RegExp(`const ${name}: &\\[\\(&str, &\\[&str\\]\\)\\] = &\\[([\\s\\S]*?)\\n\\];`))
  if (!block) throw new Error(`${name} introuvable dans ${ZED}`)
  const out = {}
  for (const m of block[1].matchAll(/\(\s*"([^"]+)"\s*,\s*&\[([^\]]*)\]\s*,?\s*\)/g)) {
    for (const s of m[2].matchAll(/"([^"]+)"/g)) out[s[1]] = m[1]
  }
  return out
}

const src = readFileSync(ZED, 'utf8')
const stems = associations(src, 'FILE_STEMS_BY_ICON_KEY')
const suffixes = associations(src, 'FILE_SUFFIXES_BY_ICON_KEY')

// Chaque thème n'écrase que quelques associations ; Zed fusionne sur le défaut
// (registry.rs). Les chemins "./icons/…" sont relatifs à la racine de l'extension.
const family = JSON.parse(readFileSync(THEME, 'utf8'))
const themes = {}
for (const t of family.themes) {
  const id = `colored-${t.appearance}`
  const fileIcons = {}
  for (const [type, def] of Object.entries(t.file_icons)) {
    fileIcons[type] = `icon-themes/colored-zed/${def.path.replace(/^\.\//, '')}`
  }
  themes[id] = { stems: t.file_stems || {}, suffixes: t.file_suffixes || {}, fileIcons }
}

const json = (o) => JSON.stringify(o, null, 2)
writeFileSync(OUT, `// Généré par scripts/gen-file-icons.mjs — ne pas éditer à la main.
// Associations : Zed ${ZED} (FILE_STEMS_BY_ICON_KEY, FILE_SUFFIXES_BY_ICON_KEY).
// Thèmes : extension « Colored Zed Icons Theme » (TheRedXD), vendored dans
// zra-client/icon-themes/colored-zed/ avec ses licences (LICENSES).

/** Nom de fichier exact (Dockerfile…) -> type d'icône, défaut Zed. */
export const BASE_STEMS = ${json(stems)}

/** Extension ou suffixe composé (docker-compose.yml…) -> type, défaut Zed. */
export const BASE_SUFFIXES = ${json(suffixes)}

/** Par jeu coloré : surcharges d'associations et type -> URL du SVG (relatif à la page). */
export const COLORED_THEMES = ${json(themes)}
`)
console.log(`${OUT} : ${Object.keys(stems).length} stems, ${Object.keys(suffixes).length} suffixes, ${Object.keys(themes).length} thèmes`)