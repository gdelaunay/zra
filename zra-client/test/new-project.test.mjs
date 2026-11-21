// « Nouveau projet » : le parent par défaut (`views/new-project.js`) et la
// feuille dans un DOM headless avec le store en mode mock — le dossier est
// créé, le projet rejoint la liste, les refus s'affichent dans la feuille.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const dom = new JSDOM(await readFile(join(ROOT, 'index.html'), 'utf8'), {
  url: 'http://localhost:7777/?mock=1',
  pretendToBeVisual: true,
})
const win = dom.window
const doc = win.document
for (const k of ['window', 'document', 'location', 'localStorage', 'navigator', 'getComputedStyle',
  'HTMLElement', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'requestAnimationFrame', 'cancelAnimationFrame']) {
  Object.defineProperty(globalThis, k, { value: win[k], configurable: true, writable: true })
}
globalThis.WebSocket = win.WebSocket
// Langue de référence figée avant l'import d'i18n (jsdom est en en-US).
win.localStorage.setItem('zra.settings.v2', JSON.stringify({ lang: 'fr' }))

const store = await import('../js/store.js')
const settingsModule = await import('../js/settings.js')
const { defaultParent, openProjectSheet } = await import('../js/views/new-project.js')
const { closeAllOverlays } = await import('../js/ui.js')
const { MockLink } = await import('../js/mock/mock-link.js')
store.init({ mock: MockLink })
settingsModule.update({ mock: true })

after(() => {
  closeAllOverlays()
  for (const id of [...store.state.machines.keys()]) store.dropMachine(id)
  dom.window.close()
})

const $ = (sel) => doc.querySelector(sel)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(pred, ms = 4000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (pred()) return
    await wait(20)
  }
  throw new Error('condition jamais atteinte')
}

// ---------------------------------------------------------------------------
// Parent par défaut
// ---------------------------------------------------------------------------

test('parent par défaut : le plus fréquent des premiers dossiers des projets', () => {
  const m = {
    projects: [
      { folderPaths: ['C:/dev/a'] }, { folderPaths: ['C:/dev/b'] }, { folderPaths: ['D:/src/c'] },
    ],
    threads: [],
  }
  assert.equal(defaultParent(m), 'C:/dev')
})

test('parent par défaut : un projet compte une fois, quel que soit son nombre de threads', () => {
  const m = {
    projects: [{ folderPaths: ['D:/src/b'] }],
    threads: [
      { folderPaths: ['C:/dev/a'] }, { folderPaths: ['C:/dev/a'] }, { folderPaths: ['C:/dev/a'] },
    ],
  }
  assert.equal(defaultParent(m), 'D:/src')
})

test('parent par défaut : égalité → le projet au thread le plus récent', () => {
  const m = {
    projects: [{ folderPaths: ['C:/dev/a'] }, { folderPaths: ['D:/src/b'] }],
    threads: [
      { folderPaths: ['C:/dev/a'], interactedAt: '2026-01-01T00:00:00Z' },
      { folderPaths: ['D:/src/b'], interactedAt: '2026-02-01T00:00:00Z' },
    ],
  }
  assert.equal(defaultParent(m), 'D:/src')
})

test('parent par défaut : aucun projet → home du poste ; rien → vide', () => {
  assert.equal(defaultParent({ projects: null, threads: [], info: { home: 'C:/Users/gd' } }), 'C:/Users/gd')
  assert.equal(defaultParent({ projects: null, threads: [] }), '')
})

test('parent par défaut : séparateurs Windows et racine de lecteur', () => {
  assert.equal(defaultParent({ projects: [{ folderPaths: ['C:\\dev\\zra'] }], threads: [] }), 'C:/dev')
  assert.equal(defaultParent({ projects: [{ folderPaths: ['C:/x'] }], threads: [] }), 'C:/')
  assert.equal(defaultParent({ projects: [{ folderPaths: ['/home/gd/x'] }], threads: [] }), '/home/gd')
})

// ---------------------------------------------------------------------------
// La feuille, en mode mock
// ---------------------------------------------------------------------------

/** Le poste mock en ligne, ses projets chargés. */
async function deskOnline() {
  const m = store.state.machines.get('mock-desk')
  await until(() => m.status === 'online' && m.projects)
  return m
}

function fill(sheet, { name, parent }) {
  const inputs = [...sheet.querySelectorAll('input.input')]
  if (name !== undefined) { inputs[0].value = name; inputs[0].dispatchEvent(new win.Event('input')) }
  if (parent !== undefined) { inputs[1].value = parent; inputs[1].dispatchEvent(new win.Event('input')) }
  return inputs
}

test('feuille : parent pré-rempli, aperçu du chemin, créer ajoute le projet', async () => {
  const m = await deskOnline()
  closeAllOverlays()
  openProjectSheet(m)
  const sheet = $('.sheet')
  const inputs = [...sheet.querySelectorAll('input.input')]
  assert.equal(inputs[1].value, 'C:/Users/gd/Documents/Développement', 'le parent le plus fréquent du mock')

  fill(sheet, { name: 'nouveau-truc' })
  assert.match(sheet.querySelector('p.muted').textContent, /Développement\/nouveau-truc$/)
  sheet.querySelector('.btn').click()
  await until(() => !$('.sheet'))
  assert.ok(m.projects.some((p) => p.folderPaths[0].endsWith('/nouveau-truc')), 'le projet rejoint le sidebar')
})

test('feuille : nom invalide → bouton désactivé ; dossier existant → erreur dans la feuille', async () => {
  const m = await deskOnline()
  closeAllOverlays()
  openProjectSheet(m)
  const sheet = $('.sheet')
  const ok = sheet.querySelector('.btn')

  fill(sheet, { name: 'a/b' })
  assert.equal(ok.disabled, true)
  fill(sheet, { name: '' })
  assert.equal(ok.disabled, true)

  fill(sheet, { name: 'zra' })   // déjà dans le sidebar du mock
  assert.equal(ok.disabled, false)
  ok.click()
  await until(() => sheet.querySelector('.callout--error').style.display !== 'none')
  assert.match(sheet.querySelector('.callout--error').textContent, /existe déjà/)
  assert.ok($('.sheet'), 'la feuille reste ouverte pour corriger')
  closeAllOverlays()
})
