// Génère le jeu d'icônes de la PWA depuis le mark « Z fendu bicolore ».
// Source unique : un SVG (mark bicolore neutre gruvbox + accent), décliné en
// PNG pour les usages qui n'acceptent pas le SVG (Safari, iOS, badge Android).
// Lancer depuis la racine du repo : node scripts/gen-icons.mjs
// Dépendance : sharp (résolu depuis le harness pi, aucune dep runtime du projet).
import { createRequire } from 'node:module'
import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const sharp = require('C:/Users/Goulwen/.pi/agent/npm/node_modules/sharp')

const OUT = 'zra-client/icons'
const NEUTRE = '#ebdbb2' // gruvbox dark fg
const ACCENT_DARK = '#b8bb26' // gruvbox dark green (mode sombre)
const ACCENT_LIGHT = '#98971a' // gruvbox neutral green (mode clair, plus lisible)
const FOND = '#282828' // gruvbox dark bg

// Géométrie du mark (viewBox 512) : Z fendu bicolore. Les transforms sont
// conservés tels quels : valides en SVG, rendus à l'identique par les
// navigateurs et par sharp.
const Z_TOP = 'M148 116 L384 116 L116 384 L116 324 L252 188 L116 188 L116 148 Z'
const Z_BOT = 'M396 138 L396 188 L260 324 L396 324 L396 364 L364 396 L138 396 Z'

// Boîte englobante du Z après transform : carré de côté 246.4 centré sur
// (235, 280). RMAX = distance du point le plus éloigné (pointes haut-droit /
// bas-gauche du Z). Sert à recentrer et à dimensionner les variantes.
const CX = 235, CY = 280, RMAX = 166.9
// BIG : remplit le viewBox au max (marge ~12 px). SAFE : tient dans la zone
// sûre maskable (cercle Ø 410, rayon 205) pour les icônes à masque arrondi.
const BIG = (256 - 12) / 123.2 // 1.9805
const SAFE = 205 / RMAX // 1.2283

function markInner(topAttr, accAttr) {
  return `
  <g transform="translate(235 280) scale(0.88) translate(-256 -256)">
    <path ${topAttr} d="${Z_TOP}"/>
    <path ${accAttr} d="${Z_BOT}"/>
  </g>`
}

// Recentre le mark sur (256,256) et le met à l'échelle voulue.
function place(inner, scale) {
  return `<g transform="translate(256 256) scale(${scale.toFixed(4)}) translate(${-CX} ${-CY})">${inner}</g>`
}

function doc(inner, bg = null, rx = 0) {
  const rect = bg ? `<rect width="512" height="512" rx="${rx}" fill="${bg}"/>` : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">${rect}${inner}</svg>`
}

// Mark couleur (accent sombre) pour les PNG sur fond sombre.
const markColor = markInner(`fill="${NEUTRE}"`, `fill="${ACCENT_DARK}"`)
// Variante claire du mark (neutre sombre + accent foncé), pour fonds clairs.
const markLight = markInner(`fill="${FOND}"`, `fill="${ACCENT_LIGHT}"`)
const markWhite = markInner('fill="#fff"', 'fill="#fff"')
// Favicon : classes .n (neutre) / .a (accent) pilotées par prefers-color-scheme.
const markFav = markInner('class="n"', 'class="a"')
const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512"><style>.n{fill:${NEUTRE}}.a{fill:${ACCENT_DARK}}@media (prefers-color-scheme:light){.n{fill:${FOND}}.a{fill:${ACCENT_LIGHT}}}</style>${place(markFav, BIG)}</svg>`

async function png(svgStr, size, file) {
  await sharp(Buffer.from(svgStr)).resize(size, size).png().toFile(join(OUT, file))
  console.log(`  ${file} (${size}²)`)
}

await mkdir(OUT, { recursive: true })
console.log('Génération des icônes ZRA →', OUT)

// Favicon SVG adaptatif clair/sombre (neutre + accent), mark au max.
await writeFile(join(OUT, 'icon.svg'), FAVICON)
console.log('  icon.svg (favicon adaptatif)')

// Badge de notification (barre de statut mobile) : silhouette monochrome
// blanche sur transparent.
await writeFile(join(OUT, 'badge.svg'), doc(place(markWhite, BIG)))
await png(doc(place(markWhite, BIG)), 96, 'badge.png')

// Tray système : mark couleur sur transparent, embarqué dans zra-tray (pas
// servi par la PWA). Variante sombre : Linux (fixe) + Windows barre sombre ;
// variante claire : Windows barre claire (swap selon le thème système).
await png(doc(place(markColor, BIG)), 64, 'tray.png')
await png(doc(place(markLight, BIG)), 64, 'tray-light.png')

// Icône « any » PNG (fallback lanceur) : fond sombre arrondi, mark en zone
// sûre (visible sur fond clair, pas de pointes rognées par un masque).
await png(doc(place(markColor, SAFE), FOND, 96), 192, 'icon-192.png')
await png(doc(place(markColor, BIG), FOND), 32, 'favicon-32.png')

// Écran d'accueil iOS + maskable Android : fond plein, mark dans la zone sûre
// (masque arrondi : les pointes diagonales ne doivent pas être rognées).
await png(doc(place(markColor, SAFE), FOND), 180, 'apple-touch-icon.png')
await png(doc(place(markColor, SAFE), FOND), 512, 'icon-maskable.png')

console.log('Terminé.')