// Le jeu d'icônes de fichiers (`js/file-icons.js`) : résolution du type d'icône
// (port de FileIcons::get_icon), URL du SVG coloré, élément rendu.
//
// Ce qui compte ici : les cas tordus de Zed (Dockerfile.prod, .gitignore,
// eslint.config.js, extensions composées) tombent sur le bon type, et le jeu
// générique ne produit jamais d'<img>.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
const win = dom.window
for (const k of ['window', 'document', 'Node', 'HTMLElement']) {
  Object.defineProperty(globalThis, k, { value: win[k], configurable: true, writable: true })
}
const mem = new Map()
globalThis.localStorage ??= {
  getItem: (k) => mem.get(k) ?? null,
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
}
after(() => { dom.window.close() })

const { BASE_STEMS, BASE_SUFFIXES, COLORED_THEMES } = await import('../js/file-icons-data.js')
const { fileIconType, fileIconUrl, fileIcon, ICON_SETS } = await import('../js/file-icons.js')
const { settings, update } = await import('../js/settings.js')

const maps = {
  stems: { ...BASE_STEMS, ...COLORED_THEMES['colored-dark'].stems },
  suffixes: { ...BASE_SUFFIXES, ...COLORED_THEMES['colored-dark'].suffixes },
}
const type = (p) => fileIconType(p, maps)

// ---------------------------------------------------------------------------
// fileIconType — l'algorithme de Zed
// ---------------------------------------------------------------------------

test('type : extension simple, chemins Windows ou POSIX', () => {
  assert.equal(type('src/main.rs'), 'rust')
  assert.equal(type('C:\\projet\\app.js'), 'javascript')
  assert.equal(type('styles.css'), 'css')
})

test('type : nom complet et suffixes composés avant l’extension', () => {
  assert.equal(type('Dockerfile'), 'docker')
  assert.equal(type('.dockerignore'), 'docker')
  assert.equal(type('docker-compose.yml'), 'docker', 'suffixe composé prioritaire sur yml')
  assert.equal(type('eslint.config.js'), 'eslint', 'nom complet listé dans les suffixes Zed')
  assert.equal(type('vite.config.js'), 'javascript', 'config.js inconnu -> js')
})

test('type : suffixes itérés puis premier préfixe (Dockerfile.prod, go.mod)', () => {
  assert.equal(type('Dockerfile.prod'), 'docker', 'préfixe stem quand aucun suffixe ne matche')
  assert.equal(type('Podfile'), 'ruby')
  assert.equal(type('Podfile.lock'), 'lock', 'suffixe connu prioritaire sur le stem Podfile')
  assert.equal(type('go.mod'), 'go')
  assert.equal(type('mod.rs'), 'rust', 'le suffixe gagne sur le préfixe')
})

test('type : fichier caché, extensions composées, repli', () => {
  assert.equal(type('.gitignore'), 'vcs')
  assert.equal(type('Component.stories.tsx'), 'react', 'stories.tsx absent -> tsx (react dans Zed)')
  assert.equal(type('data.unknown'), 'default', 'extension inconnue -> type par défaut')
  assert.equal(type('LICENSE'), 'default')
  assert.equal(type(''), 'default')
  assert.equal(type('src/'), 'default')
})

// ---------------------------------------------------------------------------
// fileIconUrl — le jeu choisi
// ---------------------------------------------------------------------------

test('URL : jeu générique par défaut, jamais d’URL', () => {
  assert.equal(settings.iconSet, 'default')
  assert.equal(fileIconUrl('main.rs'), null)
  assert.equal(fileIconUrl('main.rs', 'default'), null)
})

test('URL : jeux colorés, dark et light, repli générique sur type absent', () => {
  assert.equal(fileIconUrl('src/main.rs', 'colored-dark'), 'icon-themes/colored-zed/icons/dark/rust_dark.svg')
  assert.equal(fileIconUrl('src/main.rs', 'colored-light'), 'icon-themes/colored-zed/icons/light/rust_light.svg')
  assert.equal(fileIconUrl('Dockerfile', 'colored-dark'), 'icon-themes/colored-zed/icons/dark/docker_dark.svg')
  assert.equal(fileIconUrl('song.mp3', 'colored-dark'), null, 'audio absent du jeu coloré -> générique')
  assert.equal(fileIconUrl('notes.txt', 'colored-dark'), 'icon-themes/colored-zed/icons/dark/book_dark.svg', 'document -> book')
})

test('URL : tous les SVG pointés existent dans les assets vendored', async () => {
  const { existsSync } = await import('node:fs')
  for (const t of Object.values(COLORED_THEMES)) {
    for (const url of Object.values(t.fileIcons)) {
      assert.ok(existsSync(`zra-client/${url}`), url)
    }
  }
})

// ---------------------------------------------------------------------------
// fileIcon — l'élément rendu
// ---------------------------------------------------------------------------

test('élément : SVG générique par défaut, img coloré sinon, folder toujours générique', () => {
  update({ iconSet: 'default' })
  assert.equal(fileIcon('main.rs', false).tagName, 'svg')

  update({ iconSet: 'colored-dark' })
  const img = fileIcon('main.rs', false)
  assert.equal(img.tagName, 'IMG')
  assert.equal(img.getAttribute('src'), 'icon-themes/colored-zed/icons/dark/rust_dark.svg')
  assert.ok(img.classList.contains('icon') && img.classList.contains('icon--sm'))
  assert.equal(img.getAttribute('aria-hidden'), 'true')

  assert.equal(fileIcon('src/', true).tagName, 'svg', 'dossier : pas d’icône dédiée dans le jeu coloré')
  assert.equal(fileIcon('song.mp3', false).tagName, 'svg', 'type absent : repli générique')

  update({ iconSet: 'default' })
})

test('ICON_SETS : trois jeux, ids validés par les réglages', () => {
  assert.deepEqual(ICON_SETS.map((s) => s.id), ['default', 'colored-dark', 'colored-light'])
  update({ iconSet: 'colored-light' })
  assert.equal(JSON.parse(localStorage.getItem('zra.settings.v2')).iconSet, 'colored-light')
  update({ iconSet: 'default' })
})