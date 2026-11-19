// Génère tokens.css (couleurs One Dark) et icons.js (icônes Zed) depuis _upstream/zed.
// Usage : node reference/zed-agent-panel/gen.mjs
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const zed = join(here, '..', '..', '_upstream', 'zed')

// --- Couleurs : style du thème + valeurs dérivées que Zed calcule (theme_settings/src/schema.rs)
const one = JSON.parse(readFileSync(join(zed, 'assets/themes/one/one.json'), 'utf8'))
const style = one.themes.find((t) => t.name === 'One Dark').style

const vars = []
for (const [key, value] of Object.entries(style)) {
  if (typeof value !== 'string') continue
  vars.push(`  --${key.replaceAll('.', '-').replaceAll('_', '-')}: ${normalize(value)};`)
}
// Joueur « agent » = dernier joueur du thème (theme/src/styles/players.rs, fn agent)
const agent = style.players.at(-1)
vars.push(`  --player-agent-cursor: ${normalize(agent.cursor)};`)
vars.push(`  --player-local-cursor: ${normalize(style.players[0].cursor)};`)
vars.push(`  --player-local-selection: ${normalize(style.players[0].selection)};`)
// Coloration syntaxique utilisée par les blocs de code
for (const k of ['keyword', 'string', 'function', 'comment', 'type', 'number', 'constant', 'variable', 'property', 'punctuation', 'operator', 'attribute', 'tag']) {
  if (style.syntax[k]?.color) vars.push(`  --syntax-${k}: ${normalize(style.syntax[k].color)};`)
}

writeFileSync(join(here, 'tokens.css'), `/* Généré par gen.mjs depuis _upstream/zed/assets/themes/one/one.json (One Dark). Ne pas éditer. */
:root {
${vars.join('\n')}
}
`)

// --- Icônes utilisées par index.html : tracés noirs (masques GPUI) passés en currentColor
const iconDir = join(zed, 'assets/icons')
const html = readFileSync(join(here, 'index.html'), 'utf8')
const used = new Set([...html.matchAll(/data-i="([^"]+)"/g)].map((m) => m[1]))
// noms relatifs à assets/icons, sous-dossiers compris (file_icons/rust)
const exists = (name) => existsSync(join(iconDir, `${name}.svg`))
const missing = [...used].filter((name) => !exists(name))
if (missing.length) console.warn('icônes absentes de Zed :', missing.join(', '))
const icons = {}
for (const name of [...used].filter(exists).sort()) {
  const file = `${name}.svg`
  let raw = readFileSync(join(iconDir, file), 'utf8').replace(/<\?xml[^>]*>/, '')
  // Certains SVG Zed n'ont pas de viewBox (width/height seuls) : GPUI les met à l'échelle
  // de l'icône, mais en CSS sans viewBox les unités utilisateur restent en px → tracé
  // clipé et décentré (rotation asymétrique). On rétablit le viewBox depuis width/height.
  if (!/viewBox=/.test(raw)) {
    const w = /width="([^"]+)"/.exec(raw)?.[1]
    const h = /height="([^"]+)"/.exec(raw)?.[1]
    if (w && h) raw = raw.replace('<svg', `<svg viewBox="0 0 ${w} ${h}"`)
  }
  const svg = raw
    .replace(/\s(width|height)="[^"]*"/g, '')
    // GPUI ne garde que l'alpha : toute couleur devient celle de l'icône (sauf le blanc des masques/clips)
    .replace(/(fill|stroke)="(?!none|white|url)[^"]*"/g, '$1="currentColor"')
    .replace(/\s+/g, ' ')
    .trim()
  icons[name] = svg
}
writeFileSync(join(here, 'icons.js'), `// Généré par gen.mjs depuis _upstream/zed/assets/icons (licences : THIRD_PARTY_NOTICES.md). Ne pas éditer.
// <i class="icon" data-i="nom"></i> est remplacé par le SVG au chargement.
const ICONS = ${JSON.stringify(icons, null, 0).replaceAll('","', '",\n"')}
for (const el of document.querySelectorAll('i[data-i]')) {
  const svg = ICONS[el.dataset.i]
  if (svg) el.innerHTML = svg
  else console.debug('icône inconnue', el.dataset.i)
}
`)

console.log(`tokens.css : ${vars.length} variables ; icons.js : ${Object.keys(icons).length} icônes`)

// #rrggbbaa → #rrggbb quand opaque, sinon rgba() lisible
function normalize(hex) {
  const m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(hex)
  if (!m) return hex
  if (!m[2] || m[2].toLowerCase() === 'ff') return `#${m[1].toLowerCase()}`
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16))
  return `rgba(${r}, ${g}, ${b}, ${+(parseInt(m[2], 16) / 255).toFixed(3)})`
}
