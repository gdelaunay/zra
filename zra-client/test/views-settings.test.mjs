// La feuille de réglages (`js/views/settings.js`), dans un DOM headless et avec
// le store en mode mock : les postes, le thème, les préférences d'affichage.
//
// Ce qui compte ici : une action de la feuille écrit dans les réglages persistés
// **et** se voit immédiatement à l'écran (libellé du thème, reconstruction de la
// liste des postes), sans jamais rouvrir une seconde feuille.

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

const store = await import('../js/store.js')
const settingsModule = await import('../js/settings.js')
const { openSettings } = await import('../js/views/settings.js')
const { closeAllOverlays } = await import('../js/ui.js')
const { THEMES } = await import('../js/themes.js')

store.init({ mock: true })
// `main.js` fait le lien entre `?mock=1` et les réglages persistés ; ici on le
// pose à la main pour que le store et les réglages disent la même chose.
settingsModule.update({ mock: true })

after(() => {
  closeAllOverlays()
  for (const id of [...store.state.machines.keys()]) store.dropMachine(id)
  dom.window.close()
})

const $ = (sel) => doc.querySelector(sel)
const $$ = (sel, root = doc) => [...root.querySelectorAll(sel)]
const click = (el) => el.click()
/** Ouvre les réglages frais, et rend le corps de la feuille. */
function open() {
  closeAllOverlays()
  openSettings()
  return $('.sheet')
}
const sections = (sheet) => $$('section.field').map((s) => s.querySelector('.label').textContent)
const section = (sheet, label) => $$('section.field').find((s) => s.querySelector('.label').textContent === label)
const toasts = () => $$('.toast').map((n) => n.textContent)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

test('la feuille s’ouvre avec ses quatre sections', () => {
  const sheet = open()
  assert.equal(sheet.querySelector('.sheet__title span').textContent, 'Réglages')
  assert.deepEqual(sections(sheet), ['Postes', 'Thème', 'Affichage', 'À propos'])
  assert.equal($$('.sheet').length, 1, 'une seule feuille')
})

// ---------------------------------------------------------------------------
// Postes
// ---------------------------------------------------------------------------

test('Postes : les postes du store sont listés, avec leur badge en mode mock', () => {
  const sheet = open()
  const rows = $$('.row', sheet).filter((r) => r.querySelector('.dot'))
  const list = section(sheet, 'Postes').querySelectorAll('.dot')
  assert.equal(list.length, store.state.machines.size)
  assert.ok(rows.length >= 2)
  const badges = section(sheet, 'Postes').querySelectorAll('.thread-row__badge')
  assert.equal(badges.length, store.state.machines.size)
  assert.deepEqual([...badges].map((b) => b.textContent), ['mock', 'mock'])
  assert.equal(section(sheet, 'Postes').querySelector('button[title="Retirer"]'), null,
    'rien à retirer en mode mock')
})

test('Postes : une adresse valide est ajoutée, le champ vidé, la liste reconstruite', () => {
  const sheet = open()
  const input = section(sheet, 'Postes').querySelector('input.input')
  const avant = store.state.machines.size
  input.value = '10.0.0.9'
  click(section(sheet, 'Postes').querySelector('button.btn'))

  assert.equal(store.state.machines.size, avant + 1)
  assert.equal(input.value, '', 'le champ est vidé')
  const added = settingsModule.settings.machines.at(-1)
  assert.equal(added.url, 'http://10.0.0.9:7777', 'l’adresse est normalisée')
  assert.ok(toasts().some((t) => t.includes('ajouté')), 'un toast confirme')

  const apres = section($('.sheet'), 'Postes')
  assert.equal(apres.querySelectorAll('.dot').length, avant + 1, 'la liste est reconstruite')
  assert.ok(apres.textContent.includes('10.0.0.9'))

  settingsModule.removeMachine(added.id)
  store.dropMachine(added.id)
})

test('Postes : Entrée dans le champ ajoute, comme le bouton', () => {
  const sheet = open()
  const input = section(sheet, 'Postes').querySelector('input.input')
  input.value = 'http://10.0.0.10:7777'
  input.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  assert.ok(settingsModule.settings.machines.some((m) => m.url === 'http://10.0.0.10:7777'))
  const added = settingsModule.settings.machines.at(-1)
  settingsModule.removeMachine(added.id)
  store.dropMachine(added.id)
})

test('Postes : une adresse vide ou déjà enregistrée est refusée, sans rien ajouter', () => {
  const sheet = open()
  const input = section(sheet, 'Postes').querySelector('input.input')
  const avant = store.state.machines.size

  input.value = ''
  click(section(sheet, 'Postes').querySelector('button.btn'))
  assert.equal(store.state.machines.size, avant)
  assert.ok(toasts().some((t) => t.includes('adresse invalide')))

  input.value = settingsModule.settings.machines[0]?.url ?? 'http://10.0.0.9:7777'
  settingsModule.addMachine('10.0.0.11')
  const url = settingsModule.settings.machines.at(-1).url
  input.value = url
  click($('.sheet').querySelector('section.field button.btn'))
  assert.equal(store.state.machines.size, avant, 'un doublon n’ouvre pas une seconde connexion')
  assert.ok(toasts().some((t) => t.includes('déjà enregistré')))

  for (const m of settingsModule.settings.machines.filter((x) => x.url === 'http://10.0.0.11:7777')) {
    settingsModule.removeMachine(m.id)
  }
})

test('Postes : un poste explicite se retire après confirmation', () => {
  settingsModule.addMachine('10.0.0.12')
  const added = settingsModule.settings.machines.at(-1)
  store.addMachine(added)

  // Hors mode mock, un poste non implicite propose le retrait.
  store.state.mock = false
  try {
    const sheet = open()
    const postes = section(sheet, 'Postes')
    const row = [...postes.querySelectorAll('.row')].find((r) => r.textContent.includes('10.0.0.12'))
    assert.ok(row, 'le poste ajouté est listé')
    assert.equal(row.querySelector('.thread-row__badge'), null)

    click(row.querySelector('button[title="Retirer"]'))
    // Une feuille en remplace une autre : la confirmation prend la place des réglages.
    const confirm = $('.sheet')
    assert.equal($$('.sheet').length, 1)
    assert.match(confirm.textContent, /Retirer ce poste/)
    assert.match(confirm.textContent, /10\.0\.0\.12 sera supprimé/)

    const [annuler] = [...confirm.querySelectorAll('button')].filter((b) => b.textContent.trim() !== '')
    click(annuler)
    assert.equal(settingsModule.settings.machines.some((m) => m.id === added.id), true, 'annuler ne retire rien')
    assert.equal($$('.sheet').length, 0, 'et tout est refermé')

    const sheet2 = open()
    const row2 = [...section(sheet2, 'Postes').querySelectorAll('.row')]
      .find((r) => r.textContent.includes('10.0.0.12'))
    click(row2.querySelector('button[title="Retirer"]'))
    const [, retirer2] = [...$('.sheet').querySelectorAll('button')].filter((b) => b.textContent.trim() !== '')
    assert.equal(retirer2.textContent, 'Retirer')
    click(retirer2)

    assert.equal(settingsModule.settings.machines.some((m) => m.id === added.id), false, 'retiré des réglages')
    assert.equal(store.state.machines.has(added.id), false, 'et du store')
  } finally {
    store.state.mock = true
  }
})

test('Postes : un poste implicite porte un badge, pas un bouton Retirer', () => {
  store.addMachine({ id: 'origin', url: 'http://localhost:7777', label: 'ce poste', implicit: true })
  store.state.mock = false
  try {
    const postes = section(open(), 'Postes')
    const row = [...postes.querySelectorAll('.row')].find((r) => r.textContent.includes('ce poste'))
    assert.ok(row, 'le poste implicite est listé')
    assert.equal(row.querySelector('.thread-row__badge').textContent, 'local')
    assert.equal(row.querySelector('button[title="Retirer"]'), null, 'on ne retire pas le poste qui nous sert')
  } finally {
    store.state.mock = true
    store.dropMachine('origin')
  }
})

// ---------------------------------------------------------------------------
// Thème
// ---------------------------------------------------------------------------

test('Thème : le bouton affiche le thème courant et ouvre le choix', () => {
  const sheet = open()
  const btn = section(sheet, 'Thème').querySelector('button.btn')
  const current = THEMES.find((t) => t.id === settingsModule.settings.theme)
  assert.equal(btn.querySelector('span').textContent, current.name)

  click(btn)
  const menu = $('.menu')
  assert.equal(menu.querySelector('.menu__label').textContent, 'Thème')
  assert.equal(menu.querySelectorAll('.menu__item').length, THEMES.length)
  assert.equal(menu.querySelectorAll('.menu__item--on').length, 1, 'le thème courant est coché')
  assert.equal($('.sheet') !== null, true, 'le menu s’empile sur la feuille')
})

test('Thème : choisir un thème l’applique, le persiste et met le libellé à jour', () => {
  const before = settingsModule.settings.theme
  const sheet = open()
  click(section(sheet, 'Thème').querySelector('button.btn'))
  const target = THEMES.find((t) => t.id !== before)
  const item = $$('.menu__item').find((b) => b.querySelector('.truncate').textContent === target.name)
  click(item)

  assert.equal(settingsModule.settings.theme, target.id, 'réglage mis à jour')
  assert.equal(JSON.parse(localStorage.getItem('zra.settings.v2')).theme, target.id, 'et persisté')
  assert.equal(doc.documentElement.dataset.theme, target.id, 'appliqué à la page')
  assert.equal($('.menu'), null, 'le menu est refermé')
  assert.equal(section($('.sheet'), 'Thème').querySelector('button.btn span').textContent, target.name)
  assert.equal($$('.sheet').length, 1, 'la feuille est toujours là')

  settingsModule.update({ theme: before })
  settingsModule.applyTheme(before)
})

// ---------------------------------------------------------------------------
// Affichage et à propos
// ---------------------------------------------------------------------------

test('Affichage : les cases reflètent les réglages et les écrivent', () => {
  const sheet = open()
  const boxes = section(sheet, 'Affichage').querySelectorAll('input[type="checkbox"]')
  const labels = [...section(sheet, 'Affichage').querySelectorAll('label.row span')].map((s) => s.textContent)
  assert.deepEqual(labels, [
    'Déplier les réflexions par défaut',
    'Déplier les outils par défaut',
    'Mode mock (daemon simulé)',
  ])
  assert.equal(boxes[0].checked, settingsModule.settings.showThoughts)
  assert.equal(boxes[1].checked, settingsModule.settings.expandTools)
  assert.equal(boxes[2].checked, settingsModule.settings.mock, 'le mode mock suit le réglage')
  assert.equal(boxes[2].checked, true, 'on est en mode mock')

  boxes[1].checked = true
  boxes[1].dispatchEvent(new win.Event('change', { bubbles: true }))
  assert.equal(settingsModule.settings.expandTools, true)
  assert.equal(JSON.parse(localStorage.getItem('zra.settings.v2')).expandTools, true)

  settingsModule.update({ expandTools: false })
})

test('Affichage : toucher au mode mock demande un rechargement', () => {
  const sheet = open()
  const box = section(sheet, 'Affichage').querySelectorAll('input[type="checkbox"]')[2]
  box.checked = false
  box.dispatchEvent(new win.Event('change', { bubbles: true }))

  const confirm = $('.sheet')
  assert.equal($$('.sheet').length, 1, 'la confirmation remplace les réglages')
  assert.match(confirm.textContent, /Recharger \?/)
  assert.match(confirm.textContent, /la PWA doit être rechargée/)
  const [annuler, recharger] = [...confirm.querySelectorAll('button')].filter((b) => b.textContent.trim() !== '')
  assert.equal(annuler.textContent, 'Annuler')
  assert.equal(recharger.textContent, 'Recharger')
  click(annuler)                                  // « Recharger » appellerait location.reload()
  assert.equal(settingsModule.settings.mock, false, 'le réglage est écrit, le rechargement est à la main')
  settingsModule.update({ mock: true })
})

test('À propos : les postes et l’identifiant du client', () => {
  const sheet = open()
  const text = section(sheet, 'À propos').textContent
  assert.match(text, /ZRA — Zed Remote Agent/)
  assert.ok(text.includes(settingsModule.settings.clientId), 'le clientId est affiché')
})

test('rouvrir les réglages ne laisse pas de feuille en double', async () => {
  open()
  open()
  open()
  assert.equal($$('.sheet').length, 1)
  closeAllOverlays()
  assert.equal($$('.sheet').length, 0)
  await wait(0)
})
