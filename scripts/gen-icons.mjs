// Génère le jeu d'icônes de la PWA depuis le mark « Z deux triangles »
// (deux triangles ouverts, trait arrondi 76, pattes courtes). Source unique :
// un SVG (mark bicolore neutre gruvbox + accent), décliné en PNG pour les
// usages qui n'acceptent pas le SVG (Safari, iOS, badge Android).
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

// Géométrie du mark (viewBox 512) : deux triangles ouverts tracés au trait
// arrondi, cadre 80..432, pattes 95. Le mark est centré sur (256, 256).
const Z_TOP = 'M80 175 V80 H432 L296 216'
const Z_BOT = 'M432 337 V432 H80 L216 296'
const TRAIT = 76

// Boîte englobante trait compris : carré de côté 428 (42..470), demi-côté 214.
// RMAX = point peint le plus éloigné du centre (arrondi des coins haut-droit /
// bas-gauche du cadre) : distance centre→coin + demi-trait. Sert à dimensionner
// les variantes.
const CX = 256, CY = 256, RMAX = 176 * Math.SQRT2 + TRAIT / 2 // 286.9
// BIG : marges ~42 px/côté (~8 %) — favicon, header, badge, tray ; le mark a
// déjà cette marge à l'échelle 1. SAFE : tient dans la zone sûre maskable
// (cercle Ø 410, rayon 205) pour les icônes à masque arrondi.
const BIG = (256 - 42) / 214 // 1.0
const SAFE = 205 / RMAX // 0.7145

function markInner(topAttr, accAttr) {
  return `
  <g fill="none" stroke-width="${TRAIT}" stroke-linecap="round" stroke-linejoin="round">
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
const markColor = markInner(`stroke="${NEUTRE}"`, `stroke="${ACCENT_DARK}"`)
// Variante claire du mark (neutre sombre + accent foncé), pour fonds clairs.
const markLight = markInner(`stroke="${FOND}"`, `stroke="${ACCENT_LIGHT}"`)
const markWhite = markInner('stroke="#fff"', 'stroke="#fff"')
// Favicon : classes .n (neutre) / .a (accent) pilotées par prefers-color-scheme.
const markFav = markInner('class="n"', 'class="a"')
const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512"><style>.n{stroke:${NEUTRE}}.a{stroke:${ACCENT_DARK}}@media (prefers-color-scheme:light){.n{stroke:${FOND}}.a{stroke:${ACCENT_LIGHT}}}</style>${place(markFav, BIG)}</svg>`

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
