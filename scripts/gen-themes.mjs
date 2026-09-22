// Génère zra-client/css/themes.css à partir des thèmes officiels de Zed.
//   node scripts/gen-themes.mjs
// Les JSON sources sont dans .cache/ (voir FAMILIES.url) — récupérés depuis
// le dépôt zed-industries/zed. Le CSS produit est committé : la PWA n'a aucun build.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'

const CACHE = '.cache'
const OUT = 'zra-client/css/themes.css'

const FAMILIES = [
  { file: 'gruvbox.json', url: 'https://raw.githubusercontent.com/zed-industries/zed/main/assets/themes/gruvbox/gruvbox.json' },
  { file: 'one.json', url: 'https://raw.githubusercontent.com/zed-industries/zed/main/assets/themes/one/one.json' },
  { file: 'ayu.json', url: 'https://raw.githubusercontent.com/zed-industries/zed/main/assets/themes/ayu/ayu.json' },
]

// Thèmes retenus, dans l'ordre d'affichage du sélecteur. Le premier est le défaut.
const WANTED = [
  ['Gruvbox Dark', 'gruvbox-dark'],
  ['Gruvbox Dark Hard', 'gruvbox-dark-hard'],
  ['Gruvbox Dark Soft', 'gruvbox-dark-soft'],
  ['Gruvbox Light', 'gruvbox-light'],
  ['One Dark', 'one-dark'],
  ['One Light', 'one-light'],
  ['Ayu Dark', 'ayu-dark'],
  ['Ayu Mirage', 'ayu-mirage'],
]

// Sous-ensemble utile des tokens Zed. On garde les noms de Zed tels quels :
// `border.variant` -> `--border-variant`.
const STYLE_KEYS = [
  'border', 'border.variant', 'border.focused', 'border.selected', 'border.disabled',
  'background', 'surface.background', 'elevated_surface.background', 'panel.background',
  'element.background', 'element.hover', 'element.active', 'element.selected', 'element.disabled',
  'ghost_element.background', 'ghost_element.hover', 'ghost_element.active', 'ghost_element.selected',
  'drop_target.background',
  'text', 'text.muted', 'text.placeholder', 'text.disabled', 'text.accent',
  'icon', 'icon.muted', 'icon.disabled', 'icon.accent',
  'status_bar.background', 'title_bar.background', 'toolbar.background', 'tab_bar.background',
  'tab.active_background', 'tab.inactive_background',
  'search.match_background',
  'scrollbar.thumb.background', 'scrollbar.thumb.hover_background', 'scrollbar.track.border',
  'editor.background', 'editor.foreground', 'editor.gutter.background', 'editor.line_number',
  'editor.active_line.background', 'editor.active_line_number', 'editor.subheader.background',
  'terminal.background', 'terminal.foreground', 'terminal.dim_foreground',
  'terminal.ansi.black', 'terminal.ansi.red', 'terminal.ansi.green', 'terminal.ansi.yellow',
  'terminal.ansi.blue', 'terminal.ansi.magenta', 'terminal.ansi.cyan', 'terminal.ansi.white',
  'terminal.ansi.bright_black', 'terminal.ansi.bright_red', 'terminal.ansi.bright_green',
  'terminal.ansi.bright_yellow', 'terminal.ansi.bright_blue', 'terminal.ansi.bright_magenta',
  'terminal.ansi.bright_cyan', 'terminal.ansi.bright_white',
  'link_text.hover',
  'created', 'created.background', 'created.border',
  'deleted', 'deleted.background', 'deleted.border',
  'modified', 'modified.background', 'modified.border',
  'renamed', 'conflict', 'ignored', 'hidden', 'predictive',
  'error', 'error.background', 'error.border',
  'warning', 'warning.background', 'warning.border',
  'success', 'success.background', 'success.border',
  'info', 'info.background', 'info.border',
  'hint', 'hint.background',
]

const SYNTAX_KEYS = [
  'comment', 'keyword', 'string', 'number', 'boolean', 'constant', 'function', 'type',
  'variable', 'property', 'operator', 'punctuation', 'tag', 'attribute', 'title',
  'emphasis', 'emphasis.strong', 'link_uri', 'link_text', 'text.literal',
]

const varName = (k) => '--' + k.replace(/[._]/g, '-')

function block(style, selector, appearance) {
  const lines = [`${selector} {`, `  color-scheme: ${appearance};`]
  for (const k of STYLE_KEYS) {
    const v = style[k]
    if (typeof v === 'string') lines.push(`  ${varName(k)}: ${v};`)
  }
  for (const k of SYNTAX_KEYS) {
    const v = style.syntax?.[k]?.color
    if (typeof v === 'string') lines.push(`  --syntax-${k.replace(/[._]/g, '-')}: ${v};`)
  }
  const player = style.players?.[0]
  if (player?.cursor) lines.push(`  --player-cursor: ${player.cursor};`)
  if (player?.selection) lines.push(`  --player-selection: ${player.selection};`)
  lines.push('}')
  return lines.join('\n')
}

function main() {
  if (!existsSync(CACHE)) mkdirSync(CACHE, { recursive: true })
  const byName = new Map()
  for (const fam of FAMILIES) {
    const path = `${CACHE}/${fam.file}`
    if (!existsSync(path)) {
      console.error(`manquant: ${path}\n  curl -sL ${fam.url} -o ${path}`)
      process.exit(1)
    }
    for (const t of JSON.parse(readFileSync(path, 'utf8')).themes) byName.set(t.name, t)
  }

  const out = [
    '/* Généré par scripts/gen-themes.mjs — ne pas éditer à la main.',
    ' * Source : thèmes officiels Zed (zed-industries/zed, assets/themes/).',
    ' * Les noms de variables reprennent les tokens de thème de Zed :',
    ' *   `element.hover` -> `--element-hover`, `syntax.keyword` -> `--syntax-keyword`.',
    ' */',
    '',
  ]
  const manifest = []
  for (const [name, slug] of WANTED) {
    const t = byName.get(name)
    if (!t) { console.error(`thème introuvable: ${name}`); process.exit(1) }
    manifest.push({ id: slug, name, appearance: t.appearance })
    const sel = slug === WANTED[0][1]
      ? `:root,\n[data-theme='${slug}']`
      : `[data-theme='${slug}']`
    out.push(block(t.style, sel, t.appearance), '')
  }
  writeFileSync(OUT, out.join('\n'))
  writeFileSync('zra-client/js/themes.js',
    '// Généré par scripts/gen-themes.mjs — ne pas éditer à la main.\n' +
    'export const THEMES = ' + JSON.stringify(manifest, null, 2) + '\n')
  console.log(`${OUT}: ${manifest.length} thèmes`)
}

main()
