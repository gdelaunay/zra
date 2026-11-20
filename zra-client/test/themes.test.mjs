// Les thèmes (`js/themes.js`) et leur application (`applyTheme` de `js/settings.js`).
//
// `themes.js` est **généré** par `scripts/gen-themes.mjs` à partir de
// `css/themes.css` : ces tests verrouillent la cohérence des deux — un thème
// annoncé sans variables CSS, ou l'inverse, casserait l'écran de réglages ou
// laisserait la PWA sans couleurs.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const dom = new JSDOM(readFileSync(join(ROOT, 'index.html'), 'utf8'), { url: 'http://localhost/' })
const win = dom.window
for (const k of ['window', 'document', 'location', 'navigator', 'getComputedStyle', 'Node', 'HTMLElement']) {
  Object.defineProperty(globalThis, k, { value: win[k], configurable: true, writable: true })
}
const mem = new Map()
globalThis.localStorage = {
  getItem: (k) => mem.get(k) ?? null,
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
}
after(() => { dom.window.close() })

const { THEMES } = await import('../js/themes.js')
const { applyTheme } = await import('../js/settings.js')

const CSS = readFileSync(join(ROOT, 'css/themes.css'), 'utf8')
const ids = () => THEMES.map((t) => t.id)
/** Sélecteurs `[data-theme='…']` déclarés dans la feuille de thèmes. */
const cssThemes = () => [...CSS.matchAll(/\[data-theme='([^']+)'\]/g)].map((m) => m[1])

// ---------------------------------------------------------------------------
// Le manifeste généré
// ---------------------------------------------------------------------------

test('chaque thème a un id, un nom et une apparence', () => {
  assert.ok(THEMES.length > 0)
  for (const t of THEMES) {
    assert.equal(typeof t.id, 'string', JSON.stringify(t))
    assert.match(t.id, /^[a-z0-9-]+$/, `${t.id} : un id utilisable comme valeur d’attribut`)
    assert.ok(t.name.length > 0, t.id)
    assert.ok(['dark', 'light'].includes(t.appearance), `${t.id} : apparence connue`)
    assert.deepEqual(Object.keys(t).sort(), ['appearance', 'id', 'name'], `${t.id} : pas de champ en trop`)
  }
})

test('les ids sont uniques', () => {
  assert.equal(new Set(ids()).size, ids().length)
})

test('chaque thème annoncé a son bloc de variables dans themes.css', () => {
  const declared = new Set(cssThemes())
  for (const id of ids()) assert.ok(declared.has(id), `${id} absent de css/themes.css`)
})

test('chaque bloc de themes.css est annoncé : pas de thème orphelin', () => {
  const known = new Set(ids())
  for (const id of cssThemes()) assert.ok(known.has(id), `${id} présent dans le CSS, absent du manifeste`)
})

test('le repli CSS (:root) est le premier thème ; la page ne fige plus de thème', () => {
  const defaut = THEMES[0]
  assert.match(CSS, new RegExp(`:root,\\s*\\[data-theme='${defaut.id}'\\]`), ':root porte le thème de repli')
  // Le thème est posé avant le premier rendu par theme-boot.js (auto ou choix persisté).
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8')
  assert.doesNotMatch(html, /<html[^>]*data-theme/, 'pas de thème en dur sur <html>')
  assert.match(html, /theme-boot\.js/, 'le script de démarrage est chargé avant le corps')
  assert.match(readFileSync(join(ROOT, 'js/theme-boot.js'), 'utf8'), /prefers-color-scheme/, 'il résout le mode auto')
})

test('chaque thème définit toutes les variables de couleur que l’app emploie', () => {
  // Les tailles, polices et espacements ne dépendent pas du thème : ils sont
  // posés une fois dans `app.css`. Ici on vérifie qu’aucun thème n’oublie une
  // variable effectivement consommée.
  const app = readFileSync(join(ROOT, 'css/app.css'), 'utf8')
  const used = new Set([...`${app}\n${readFileSync(join(ROOT, 'index.html'), 'utf8')}`
    .matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]))
  const base = new Set([...app.matchAll(/(--[a-z0-9-]+):/g)].map((m) => m[1]))
  assert.ok(used.size > 20, 'la feuille de style consomme bien des variables')

  for (const id of ids()) {
    const bloc = CSS.split(`[data-theme='${id}']`)[1].split('}')[0]
    const defined = new Set([...bloc.matchAll(/(--[a-z0-9-]+):/g)].map((m) => m[1]))
    const missing = [...used].filter((v) => !defined.has(v) && !base.has(v))
    assert.deepEqual(missing, [], `${id} laisse des variables sans valeur`)
  }
})

test('tous les thèmes définissent exactement le même jeu de variables', () => {
  const jeux = ids().map((id) => [
    ...new Set([...CSS.split(`[data-theme='${id}']`)[1].split('}')[0].matchAll(/(--[a-z0-9-]+):/g)].map((m) => m[1])),
  ].sort().join(','))
  assert.equal(new Set(jeux).size, 1, 'un thème divergent casserait le rendu sur cet écran')
})

// ---------------------------------------------------------------------------
// applyTheme()
// ---------------------------------------------------------------------------

test('applyTheme() pose le thème sur <html> et rend l’entrée choisie', () => {
  const theme = applyTheme('one-light')
  assert.equal(theme.id, 'one-light')
  assert.equal(document.documentElement.dataset.theme, 'one-light')
  assert.equal(theme.appearance, 'light')
})

test('applyTheme() sur un id inconnu résout le mode auto', () => {
  globalThis.matchMedia = () => ({ matches: true })
  const theme = applyTheme('theme-qui-n-existe-pas')
  assert.equal(theme.id, 'one-dark')
  assert.equal(document.documentElement.dataset.theme, 'one-dark')
})

test('applyTheme() sans argument suit le thème du navigateur', () => {
  document.documentElement.dataset.theme = 'gruvbox-dark'
  globalThis.matchMedia = (q) => ({ matches: /dark/.test(q) })
  assert.equal(applyTheme().id, 'one-dark', 'navigateur sombre : One Dark')
  globalThis.matchMedia = () => ({ matches: false })
  assert.equal(applyTheme().id, 'one-light', 'navigateur clair : One Light')
  assert.equal(document.documentElement.dataset.theme, 'one-light')
})

test('applyTheme() aligne la couleur de la barre du navigateur sur le fond du thème', () => {
  const meta = document.querySelector('meta[name="theme-color"]')
  assert.ok(meta, 'index.html déclare une theme-color')

  // jsdom ne résout pas les variables posées par une feuille de style : on la
  // pose en ligne, ce qui suffit à exercer le chemin.
  const style = document.documentElement.style
  style.setProperty('--panel-background', '  #1d2021  ')
  applyTheme('gruvbox-dark-hard')
  assert.equal(meta.getAttribute('content'), '#1d2021', 'valeur tronquée à 7 caractères, sans espace')

  style.setProperty('--panel-background', 'rgb(20, 20, 20)')
  applyTheme('gruvbox-dark')
  assert.equal(meta.getAttribute('content'), 'rgb(20,', 'une couleur non hexadécimale est tronquée telle quelle')

  style.removeProperty('--panel-background')
  meta.setAttribute('content', '#282828')
  applyTheme('gruvbox-dark')
  assert.equal(meta.getAttribute('content'), '#282828', 'variable absente : la couleur existante est gardée')
})

test('tous les thèmes s’appliquent sans erreur', () => {
  for (const t of THEMES) {
    assert.equal(applyTheme(t.id).id, t.id)
    assert.equal(document.documentElement.dataset.theme, t.id)
  }
})
