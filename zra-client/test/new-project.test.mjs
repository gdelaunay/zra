// « Nouveau projet » : le parent par défaut (`views/new-project.js`) et la
// modale de formulaire dans un DOM headless avec le store en mode mock — le
// dossier est créé, le projet rejoint la liste, les refus s'y affichent.

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
const { defaultParent, openProjectDialog } = await import('../js/views/new-project.js')
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
// La modale, en mode mock
// ---------------------------------------------------------------------------

/** Le poste mock en ligne, ses projets chargés. */
async function deskOnline() {
  const m = store.state.machines.get('mock-desk')
  await until(() => m.status === 'online' && m.projects)
  return m
}

function fill(dlg, { name, parent }) {
  const inputs = [...dlg.querySelectorAll('input.inputfield')]
  if (name !== undefined) { inputs[0].value = name; inputs[0].dispatchEvent(new win.Event('input')) }
  if (parent !== undefined) { inputs[1].value = parent; inputs[1].dispatchEvent(new win.Event('input')) }
  return inputs
}

test('modale : parent pré-rempli, aperçu du chemin, créer ajoute le projet', async () => {
  const m = await deskOnline()
  closeAllOverlays()
  openProjectDialog(m)
  const dlg = $('.modal--form')
  const inputs = [...dlg.querySelectorAll('input.inputfield')]
  assert.equal(inputs[1].value, 'C:/Users/gd/Documents/Développement', 'le parent le plus fréquent du mock')

  fill(dlg, { name: 'nouveau-truc' })
  assert.match(dlg.querySelector('.form-preview').textContent, /Développement\/nouveau-truc$/)
  dlg.querySelector('.btn').click()
  await until(() => !$('.modal--form'))
  assert.ok(m.projects.some((p) => p.folderPaths[0].endsWith('/nouveau-truc')), 'le projet rejoint le sidebar')
})

test('modale : pas de filet de 30 s sans envoi — l’erreur n’arrive qu’après Créer', async (t) => {
  const m = await deskOnline()
  closeAllOverlays()
  openProjectDialog(m)
  const dlg = $('.modal--form')
  t.mock.timers.enable({ apis: ['setTimeout'], now: Date.now() })
  try {
    t.mock.timers.tick(31_000)
    assert.equal(dlg.querySelector('.banner--error').style.display, 'none', 'rien ne se passe tant qu’on n’a pas envoyé')
  } finally {
    t.mock.timers.reset()
    closeAllOverlays()
  }
})

test('modale : nom invalide → bouton désactivé ; dossier existant → erreur dans la modale', async () => {
  const m = await deskOnline()
  closeAllOverlays()
  openProjectDialog(m)
  const dlg = $('.modal--form')
  const ok = dlg.querySelector('.btn')

  fill(dlg, { name: 'a/b' })
  assert.equal(ok.disabled, true)
  fill(dlg, { name: '' })
  assert.equal(ok.disabled, true)

  fill(dlg, { name: 'zra' })   // déjà dans le sidebar du mock
  assert.equal(ok.disabled, false)
  ok.click()
  await until(() => dlg.querySelector('.banner--error').style.display !== 'none')
  assert.match(dlg.querySelector('.banner--error').textContent, /existe déjà/)
  assert.ok($('.modal--form'), 'la modale reste ouverte pour corriger')
  closeAllOverlays()
})
