// La fenêtre de réglages (`js/views/settings.js`), dans un DOM headless et avec
// le store en mode mock : les postes, le thème, les préférences d'affichage.
//
// Ce qui compte ici : une action de la fenêtre écrit dans les réglages persistés
// **et** se voit immédiatement à l'écran (libellé du thème, reconstruction de la
// liste des postes), sans jamais rouvrir une seconde fenêtre. La confirmation
// de retrait s'empile dessus (elle ne remplace plus les réglages).

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
const { ICON_SETS } = await import('../js/file-icons.js')

const { MockLink } = await import('../js/mock/mock-link.js')
store.init({ mock: MockLink })
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
/** Ouvre les réglages frais, et rend la fenêtre. */
function open() {
  closeAllOverlays()
  openSettings()
  return $('.swindow')
}
const sectionName = (s) => s.querySelector('.ssh-label')?.textContent
const sections = (w) => $$('.sw-section', w).map(sectionName)
const section = (w, label) => $$('.sw-section', w).find((s) => sectionName(s) === label)
/** Ligne de réglage par son titre, dans une section. */
const row = (w, sec, title) => $$('.srow', section(w, sec)).find((r) => r.querySelector('.srow-title').textContent === title)
const dropdownOf = (w, sec, title) => row(w, sec, title).querySelector('.dropdown')
const toasts = () => $$('.toast').map((n) => n.textContent)

test('la fenêtre s’ouvre avec sa page Général et ses cinq sections', () => {
  const w = open()
  assert.equal(w.querySelector('.sw-title').textContent, 'Réglages')
  assert.equal($('.sw-pagetitle').textContent, 'Général')
  assert.deepEqual(sections(w), ['Postes', 'Apparence', 'Langue et texte', 'Affichage', 'À propos'])
  assert.equal($$('.swindow').length, 1, 'une seule fenêtre')
  // Nav : une racine Général, un enfant par section.
  assert.equal($$('.tvi--root').length, 1)
  assert.deepEqual($$('.tvi--child .tvi-label').map((n) => n.textContent), sections(w))
})

// ---------------------------------------------------------------------------
// Postes
// ---------------------------------------------------------------------------

test('Postes : les postes du store sont listés, badge mock et retrait testable', () => {
  const w = open()
  const postes = section(w, 'Postes')
  assert.equal($$('.machine-row', postes).length, store.state.machines.size)
  assert.equal($$('.dot', postes).length, store.state.machines.size)
  const badges = $$('.thread-row__badge', postes)
  assert.equal(badges.length, store.state.machines.size)
  assert.deepEqual(badges.map((b) => b.textContent), ['mock', 'mock'])
  assert.ok(postes.querySelector('button[title="Retirer"]'), 'le retrait est possible même en mock')
})

test('Postes : une adresse valide est ajoutée, le champ vidé, la liste reconstruite', () => {
  const w = open()
  const postes = section(w, 'Postes')
  const input = postes.querySelector('input.inputfield')
  const avant = store.state.machines.size
  input.value = '10.0.0.9'
  click(postes.querySelector('button.btn--md'))

  assert.equal(store.state.machines.size, avant + 1)
  const added = settingsModule.settings.machines.at(-1)
  assert.equal(added.target, 'http://10.0.0.9:7777', 'l’adresse est normalisée')
  assert.ok(toasts().some((t) => t.includes('ajouté')), 'un toast confirme')

  const apres = section($('.swindow'), 'Postes')
  assert.equal(apres.querySelector('input.inputfield').value, '', 'le champ est vidé (reconstruit)')
  assert.equal($$('.machine-row', apres).length, avant + 1, 'la liste est reconstruite')
  assert.ok(apres.textContent.includes('10.0.0.9'))

  settingsModule.removeMachine(added.id)
  store.dropMachine(added.id)
})

test('Postes : Entrée dans le champ ajoute, comme le bouton', () => {
  const w = open()
  const input = section(w, 'Postes').querySelector('input.inputfield')
  input.value = 'http://10.0.0.10:7777'
  input.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  assert.ok(settingsModule.settings.machines.some((m) => m.target === 'http://10.0.0.10:7777'))
  const added = settingsModule.settings.machines.at(-1)
  settingsModule.removeMachine(added.id)
  store.dropMachine(added.id)
})

test('Postes : une adresse vide ou déjà enregistrée est refusée, sans rien ajouter', () => {
  const w = open()
  const input = section(w, 'Postes').querySelector('input.inputfield')
  const avant = store.state.machines.size

  input.value = ''
  click(section(w, 'Postes').querySelector('button.btn--md'))
  assert.equal(store.state.machines.size, avant)
  assert.ok(toasts().some((t) => t.includes('Adresse invalide.')))

  settingsModule.addMachine('10.0.0.11')
  const url = settingsModule.settings.machines.at(-1).target
  input.value = url
  click(section($('.swindow'), 'Postes').querySelector('button.btn--md'))
  assert.equal(store.state.machines.size, avant, 'un doublon n’ouvre pas une seconde connexion')
  assert.ok(toasts().some((t) => t.includes('déjà enregistré')))

  for (const m of settingsModule.settings.machines.filter((x) => x.target === 'http://10.0.0.11:7777')) {
    settingsModule.removeMachine(m.id)
  }
})

test('Postes : un poste explicite se retire après confirmation, empilée sur les réglages', () => {
  settingsModule.addMachine('10.0.0.12')
  const added = settingsModule.settings.machines.at(-1)
  store.addMachine(added)

  // Hors mode mock, un poste non implicite propose le retrait.
  store.state.mock = false
  try {
    const w = open()
    const postes = section(w, 'Postes')
    const machineRow = $$('.machine-row', postes).find((r) => r.textContent.includes('10.0.0.12'))
    assert.ok(machineRow, 'le poste ajouté est listé')
    assert.equal(machineRow.querySelector('.thread-row__badge'), null)

    click(machineRow.querySelector('button[title="Retirer"]'))
    // La confirmation s'empile : les réglages restent dessous.
    const confirm = $('.modal')
    assert.ok(confirm)
    assert.ok($('.swindow'), 'les réglages restent ouverts')
    assert.match(confirm.textContent, /Retirer ce poste/)
    assert.match(confirm.textContent, /10\.0\.0\.12 sera supprimé/)

    const [annuler] = [...confirm.querySelectorAll('.modal__actions button')]
    click(annuler)
    assert.equal(settingsModule.settings.machines.some((m) => m.id === added.id), true, 'annuler ne retire rien')
    assert.equal($('.modal'), null, 'la confirmation est fermée')
    assert.ok($('.swindow'), 'les réglages sont toujours là')

    const row2 = $$('.machine-row', section($('.swindow'), 'Postes')).find((r) => r.textContent.includes('10.0.0.12'))
    click(row2.querySelector('button[title="Retirer"]'))
    const [, retirer2] = [...$('.modal').querySelectorAll('.modal__actions button')]
    assert.equal(retirer2.textContent, 'Retirer')
    assert.ok(retirer2.className.includes('btn--tinted-error'), 'suppression = bouton rouge')
    click(retirer2)

    assert.equal(settingsModule.settings.machines.some((m) => m.id === added.id), false, 'retiré des réglages')
    assert.equal(store.state.machines.has(added.id), false, 'et du store')
    assert.ok(!$('.swindow').textContent.includes('10.0.0.12'), 'la liste est repeinte sans lui')
  } finally {
    store.state.mock = true
  }
})

test('Postes : un poste implicite porte un badge, pas un bouton Retirer', () => {
  store.addMachine({ id: 'origin', url: 'http://localhost:7777', label: 'Ce poste', implicit: true })
  store.state.mock = false
  try {
    const postes = section(open(), 'Postes')
    const machineRow = $$('.machine-row', postes).find((r) => r.textContent.includes('Ce poste'))
    assert.ok(machineRow, 'le poste implicite est listé')
    assert.equal(machineRow.querySelector('.thread-row__badge').textContent, 'local')
    assert.equal(machineRow.querySelector('button[title="Retirer"]'), null, 'on ne retire pas le poste qui nous sert')
  } finally {
    store.state.mock = true
    store.dropMachine('origin')
  }
})

// ---------------------------------------------------------------------------
// Apparence : thème et jeu d'icônes
// ---------------------------------------------------------------------------

test('Thème : le dropdown affiche le thème courant et ouvre le choix', () => {
  const w = open()
  const btn = dropdownOf(w, 'Apparence', 'Thème')
  const current = THEMES.find((t) => t.id === settingsModule.currentThemeId())
  assert.equal(btn.querySelector('span').textContent, current.name)

  click(btn)
  const menu = $('.menu')
  assert.equal(menu.querySelectorAll('.menu__item').length, THEMES.length)
  assert.equal(menu.querySelectorAll('.menu__item--on').length, 1, 'le thème courant est coché')
  assert.ok($('.swindow'), 'le menu s’empile sur la fenêtre')
})

test('Thème : choisir un thème l’applique, le persiste et met le libellé à jour', () => {
  const before = settingsModule.settings.theme
  const w = open()
  click(dropdownOf(w, 'Apparence', 'Thème'))
  const target = THEMES.find((t) => t.id !== before)
  const item = $$('.menu__item').find((b) => b.querySelector('.truncate').textContent === target.name)
  click(item)

  assert.equal(settingsModule.settings.theme, target.id, 'réglage mis à jour')
  assert.equal(JSON.parse(localStorage.getItem('zra.settings.v2')).theme, target.id, 'et persisté')
  assert.equal(doc.documentElement.dataset.theme, target.id, 'appliqué à la page')
  assert.equal($('.menu'), null, 'le menu est refermé')
  assert.equal(dropdownOf($('.swindow'), 'Apparence', 'Thème').querySelector('span').textContent, target.name)
  assert.equal($$('.swindow').length, 1, 'la fenêtre est toujours là')

  settingsModule.update({ theme: before })
  settingsModule.applyTheme(before)
})

test('Jeu d’icônes : se choisit, se persiste et met le libellé à jour', () => {
  const w = open()
  const btn = dropdownOf(w, 'Apparence', "Jeu d'icônes")
  assert.equal(btn.querySelector('span').textContent, ICON_SETS.find((s) => s.id === settingsModule.settings.iconSet).name)

  click(btn)
  const menu = $('.menu')
  assert.equal(menu.querySelectorAll('.menu__item').length, ICON_SETS.length)
  assert.equal(menu.querySelectorAll('.menu__item--on').length, 1, 'le jeu courant est coché')

  const target = ICON_SETS.find((s) => s.id === 'colored-dark')
  click($$('.menu__item').find((b) => b.querySelector('.truncate').textContent === target.name))
  assert.equal(settingsModule.settings.iconSet, 'colored-dark', 'réglage mis à jour')
  assert.equal(JSON.parse(localStorage.getItem('zra.settings.v2')).iconSet, 'colored-dark', 'et persisté')
  assert.equal($('.menu'), null, 'le menu est refermé')
  assert.equal(dropdownOf($('.swindow'), 'Apparence', "Jeu d'icônes").querySelector('span').textContent, target.name,
    'libellé à jour sans rouvrir la fenêtre')

  settingsModule.update({ iconSet: 'default' })
})

// ---------------------------------------------------------------------------
// Affichage et à propos
// ---------------------------------------------------------------------------

test('Affichage : les interrupteurs reflètent les réglages et les écrivent', () => {
  const w = open()
  const sec = section(w, 'Affichage')
  const titles = $$('.srow-title', sec).map((n) => n.textContent)
  assert.deepEqual(titles, [
    'Toujours déplier les réflexions',
    'Déplier tous les outils',
    'Notifications (fin de tour)',
    'Son de fin de tour',
    'Mode mock (daemon simulé)',
  ])
  const boxes = $$('input[type="checkbox"]', sec)
  assert.equal(boxes.length, 5)
  assert.ok($$('.switch-wrap .switch', sec).length === 5, 'chaque interrupteur a son visuel Zed')
  assert.equal(boxes[0].checked, settingsModule.settings.alwaysShowThoughts)
  assert.equal(boxes[1].checked, settingsModule.settings.expandTools)
  assert.equal(boxes[2].disabled, true, 'pas de Web Push dans jsdom : l’interrupteur est désactivé')
  assert.match(row(w, 'Affichage', 'Notifications (fin de tour)').textContent, /Non supporté par ce navigateur/)
  assert.equal(boxes[3].checked, settingsModule.settings.turnEndSound)
  assert.equal(boxes[4].checked, settingsModule.settings.mock, 'le mode mock suit le réglage')

  boxes[1].checked = true
  boxes[1].dispatchEvent(new win.Event('change', { bubbles: true }))
  assert.equal(settingsModule.settings.expandTools, true)
  assert.equal(JSON.parse(localStorage.getItem('zra.settings.v2')).expandTools, true)
  assert.ok(boxes[1].closest('.switch-wrap').querySelector('.switch').classList.contains('switch--on'), 'le visuel suit')

  boxes[3].checked = false
  boxes[3].dispatchEvent(new win.Event('change', { bubbles: true }))
  assert.equal(settingsModule.settings.turnEndSound, false)
  assert.equal(JSON.parse(localStorage.getItem('zra.settings.v2')).turnEndSound, false)

  settingsModule.update({ expandTools: false, turnEndSound: true })
})

test('Affichage : toucher au mode mock demande un rechargement, par-dessus les réglages', () => {
  const w = open()
  const box = $$('input[type="checkbox"]', section(w, 'Affichage'))[4]
  box.checked = false
  box.dispatchEvent(new win.Event('change', { bubbles: true }))

  const confirm = $('.modal')
  assert.ok(confirm, 'une confirmation s’ouvre')
  assert.ok($('.swindow'), 'les réglages restent dessous')
  assert.match(confirm.textContent, /Recharger \?/)
  assert.match(confirm.textContent, /la PWA doit être rechargée/)
  const [annuler, recharger] = [...confirm.querySelectorAll('.modal__actions button')]
  assert.equal(annuler.textContent, 'Annuler')
  assert.equal(recharger.textContent, 'Recharger')
  click(annuler)                                  // « Recharger » appellerait location.reload()
  assert.equal(settingsModule.settings.mock, false, 'le réglage est écrit, le rechargement est à la main')
  assert.ok($('.swindow'), 'annuler laisse les réglages ouverts')
  settingsModule.update({ mock: true })
})

test('Langue : se choisit et demande un rechargement', () => {
  const w = open()
  const btn = dropdownOf(w, 'Langue et texte', 'Langue')
  assert.equal(btn.querySelector('span').textContent, 'Auto')
  click(btn)
  const items = $$('.menu__item')
  assert.deepEqual(items.map((i) => i.querySelector('.truncate').textContent), ['Auto', 'Français', 'English'])
  click(items[1])
  assert.equal(settingsModule.settings.lang, 'fr')
  assert.match($('.modal').textContent, /Recharger \?/)
  const [annuler] = [...$('.modal').querySelectorAll('.modal__actions button')]
  click(annuler)
  settingsModule.update({ lang: 'auto' })
})

test('Taille du texte : s’applique sans rechargement', () => {
  const w = open()
  const btn = dropdownOf(w, 'Langue et texte', 'Taille du texte')
  assert.equal(btn.querySelector('span').textContent, 'Normale (14 px)')
  click(btn)
  const grande = $$('.menu__item').find((i) => i.querySelector('.truncate').textContent === 'Grande (16 px)')
  click(grande)
  assert.equal(settingsModule.settings.textScale, 1.15)
  assert.equal(doc.documentElement.style.getPropertyValue('--text-scale'), '1.15')
  assert.equal(dropdownOf($('.swindow'), 'Langue et texte', 'Taille du texte').querySelector('span').textContent, 'Grande (16 px)')
  settingsModule.update({ textScale: 1 })
  settingsModule.applyTextScale(1)
})

test('À propos : les postes et l’identifiant du client', () => {
  const w = open()
  const text = section(w, 'À propos').textContent
  assert.match(text, /ZRA — Zed Remote Agent/)
  assert.ok(text.includes(settingsModule.settings.clientId), 'le clientId est affiché')
})

// ---------------------------------------------------------------------------
// Nav et recherche
// ---------------------------------------------------------------------------

test('nav : cliquer un enfant le sélectionne (le scroll est no-op sans layout)', () => {
  const w = open()
  const kids = $$('.tvi--child', w)
  assert.ok(kids[0].classList.contains('selected') || $$('.tvi--root', w)[0].classList.contains('selected'), 'une entrée est sélectionnée à l’ouverture')
  click(kids[3])
  assert.ok(kids[3].classList.contains('selected'))
  assert.equal($$('.tvi.selected', w).length, 1, 'une seule sélection')
})

test('recherche : filtre les lignes, masque le reste, « Aucun résultat » si rien', () => {
  const w = open()
  const search = $('.sw-query', w)
  search.value = 'thème'
  search.dispatchEvent(new win.Event('input', { bubbles: true }))
  const visible = $$('.srow:not(.hidden)', w).map((r) => r.querySelector('.srow-title').textContent)
  assert.deepEqual(visible, ['Thème'])
  assert.ok(section(w, 'Postes').classList.contains('hidden'), 'les sections sans correspondance sont masquées')
  assert.ok($('.no-results', w).classList.contains('hidden'), 'pas de « Aucun résultat » quand ça matche')

  search.value = 'introuvable'
  search.dispatchEvent(new win.Event('input', { bubbles: true }))
  assert.equal($$('.srow:not(.hidden)', w).length, 0)
  assert.ok(!$('.no-results', w).classList.contains('hidden'))
  assert.match($('.no-results .nr-sub', w).textContent, /introuvable/)

  // La croix vide et restaure tout.
  click($('.sw-search-clear', w))
  assert.equal(search.value, '')
  assert.equal($$('.srow:not(.hidden)', w).length, 9, 'toutes les lignes reviennent')
  assert.ok($('.no-results', w).classList.contains('hidden'))
})

test('rouvrir les réglages ne laisse pas de fenêtre en double', () => {
  open()
  open()
  open()
  assert.equal($$('.swindow').length, 1)
  closeAllOverlays()
  assert.equal($$('.swindow').length, 0)
})
