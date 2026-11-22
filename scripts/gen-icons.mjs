// Génère le jeu d'icônes de la PWA depuis le mark « Grand Z émetteur » (logo 09).
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

// Géométrie du mark (viewBox 512). Z fendu bicolore + deux ondes pivotées
// -45° dans l'angle haut-droit. Les transforms sont conservés tels quels :
// valides en SVG, rendus à l'identique par les navigateurs et par sharp.
const Z_TOP = 'M148 116 L384 116 L116 384 L116 324 L252 188 L116 188 L116 148 Z'
const Z_BOT = 'M396 138 L396 188 L260 324 L396 324 L396 364 L364 396 L138 396 Z'
const ARC1 = 'M336.8 152.6 A135 135 0 0 1 336.8 359.4 L304.6 321.1 A85 85 0 0 0 304.6 190.9 Z'
const ARC2 = 'M378.6 102.8 A200 200 0 0 1 378.6 409.2 L352.9 378.6 A160 160 0 0 0 352.9 133.4 Z'

// Boîte englobante du mark (coords naturelles) : centre et rayon du point le
// plus éloigné (coin bas-gauche du Z / pointe des ondes). Sert à recentrer et
// à dimensionner les variantes.
const CX = 281.7, CY = 225.8, RMAX = 245.6
// BIG : remplit le viewBox au max (marge ~12 px). SAFE : tient dans la zone
// sûre maskable (cercle Ø 410, rayon 205) pour les icônes à masque arrondi.
const BIG = (256 - 12) / 177.4 // 1.375
const SAFE = 205 / RMAX // 0.835

function markInner(topAttr, accAttr) {
  return `
  <g transform="translate(235 280) scale(0.88) translate(-256 -256)">
    <path ${topAttr} d="${Z_TOP}"/>
    <path ${accAttr} d="${Z_BOT}"/>
  </g>
  <g transform="translate(352 148) rotate(-45) scale(0.5) translate(-250 -256)">
    <path ${accAttr} d="${ARC1}"/>
    <path ${accAttr} d="${ARC2}"/>
  </g>`
}

// Recentre le mark sur (256,256) et le met à l'échelle voulue.
function place(inner, scale) {
  return `<g transform="translate(256 256) scale(${scale.toFixed(4)}) translate(${-CX} ${-CY})">${inner}</g>`
}

function doc(inner, bg = null) {
  const rect = bg ? `<rect width="512" height="512" fill="${bg}"/>` : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">${rect}${inner}</svg>`
}

// Mark couleur (accent sombre) pour les PNG sur fond sombre.
const markColor = markInner(`fill="${NEUTRE}"`, `fill="${ACCENT_DARK}"`)
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

// Badge de notification : silhouette monochrome blanche sur transparent.
await writeFile(join(OUT, 'badge.svg'), doc(place(markWhite, BIG)))
await png(doc(place(markWhite, BIG)), 96, 'badge.png')

// Icône « any » PNG (notifications + manifest) et fallback favicon Safari :
// fond sombre + accent sombre, mark au max (visibles sur fond clair).
await png(doc(place(markColor, BIG), FOND), 192, 'icon-192.png')
await png(doc(place(markColor, BIG), FOND), 32, 'favicon-32.png')

// Écran d'accueil iOS + maskable Android : fond plein, mark dans la zone sûre
// (masque arrondi : les pointes diagonales ne doivent pas être rognées).
await png(doc(place(markColor, SAFE), FOND), 180, 'apple-touch-icon.png')
await png(doc(place(markColor, SAFE), FOND), 512, 'icon-maskable.png')

console.log('Terminé.')