// Les surcouches (`js/ui.js`) : menus ancrés, modales, toasts.
//
// Le contrat qui compte pour le mobile : une pile d'overlays cohérente (Échap
// ferme celle du dessus, un formulaire remplace tout, un menu ou une
// confirmation s'empile), un clic sur le voile ferme, et aucun toast qui
// reste accroché indéfiniment.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body><div id="overlays" class="overlays"></div><button id="ancre">ancre</button></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
})
const win = dom.window
const doc = win.document
for (const k of ['window', 'document', 'navigator', 'location', 'getComputedStyle', 'Node', 'HTMLElement', 'requestAnimationFrame', 'cancelAnimationFrame', 'MouseEvent', 'Event', 'KeyboardEvent']) {
  Object.defineProperty(globalThis, k, { value: win[k], configurable: true, writable: true })
}
after(() => { dom.window.close() })

const { openMenu, formDialog, closeOverlay, closeAllOverlays, toast, activity, confirmDialog, switchEl } = await import('../js/ui.js')

const layer = () => doc.getElementById('overlays')
const anchor = () => doc.getElementById('ancre')
const click = (el) => el.dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
// Événement lancé depuis le corps : c'est le cas réel (le focus est dans la page),
// et ça exerce l'écoute en capture posé sur `document`.
const esc = () => doc.body.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const menus = () => [...doc.querySelectorAll('.menu')]
const dialogs = () => [...doc.querySelectorAll('.modal')]
const items = (root = doc) => [...root.querySelectorAll('.menu__item')]

/** Ferme tout entre deux tests : la pile est un état global du module. */
function reset(t) {
  closeAllOverlays()
  for (const el of [...doc.querySelectorAll('.toast')]) el.remove()
  t.after(() => { closeAllOverlays() })
  assert.deepEqual(menus().concat(dialogs()), [], 'on part d’un calque vide')
}

// ---------------------------------------------------------------------------
// openMenu
// ---------------------------------------------------------------------------

test('openMenu() construit un menu ancré, avec son libellé et ses entrées', (t) => {
  reset(t)
  const menu = openMenu(anchor(), {
    label: 'Choisir',
    items: [
      { label: 'Un', onSelect: () => {} },
      { separator: true },
      { label: 'Deux', icon: 'check' },
    ],
  })
  assert.equal(menu.getAttribute('role'), 'menu')
  assert.equal(menu.querySelector('.menu__label').textContent, 'Choisir')
  assert.equal(items(menu).length, 2)
  assert.equal(menu.querySelectorAll('.menu__sep').length, 1)
  assert.equal(items(menu)[0].querySelector('.truncate').textContent, 'Un')
  assert.ok(items(menu)[1].querySelector('svg'), 'une entrée avec icône en affiche une')
  assert.equal(items(menu)[0].getAttribute('role'), 'menuitem')
})

test('openMenu() positionne le menu dans l’écran', (t) => {
  reset(t)
  const menu = openMenu(anchor(), { items: [{ label: 'x' }] })
  assert.match(menu.style.left, /^\d+px$/)
  assert.match(menu.style.top, /^\d+px$/)
  const left = parseInt(menu.style.left, 10)
  assert.ok(left >= 8, 'jamais collé au bord')
})

test('choisir une entrée appelle onSelect et ferme le menu', (t) => {
  reset(t)
  let chosen = null
  openMenu(anchor(), { items: [{ label: 'Oui', onSelect: () => { chosen = 'oui' } }] })
  click(items()[0])
  assert.equal(chosen, 'oui')
  assert.equal(menus().length, 0, 'le menu est fermé')
})

test('une entrée sans onSelect ferme quand même', (t) => {
  reset(t)
  openMenu(anchor(), { items: [{ label: 'Rien' }] })
  click(items()[0])
  assert.equal(menus().length, 0)
})

test('un clic ailleurs ferme le menu, sans rien déclencher', (t) => {
  reset(t)
  let chosen = false
  openMenu(anchor(), { items: [{ label: 'x', onSelect: () => { chosen = true } }] })
  // Plus de voile sur les menus (Zed) : le clic extérieur ferme et traverse.
  doc.body.dispatchEvent(new win.MouseEvent('pointerdown', { bubbles: true }))
  assert.equal(menus().length, 0)
  assert.equal(chosen, false)
})

test('Échap ferme le menu', (t) => {
  reset(t)
  openMenu(anchor(), { items: [{ label: 'x' }] })
  esc()
  assert.equal(menus().length, 0)
})

test('une entrée cochée porte sa coche, et une entrée à interrupteur son aria-checked', (t) => {
  reset(t)
  openMenu(anchor(), {
    items: [
      { label: 'Choisi', on: true },
      { label: 'Actif', toggle: true, onSelect: () => {} },
      { label: 'Inactif', toggle: false },
      { label: ' Dangereux', danger: true },
    ],
  })
  const [on, actif, inactif, danger] = items()
  assert.equal(on.className.includes('menu__item--on'), true)
  assert.ok(on.querySelector('svg'), 'la coche est une icône')
  assert.equal(actif.getAttribute('role'), 'menuitemcheckbox')
  assert.equal(actif.getAttribute('aria-checked'), 'true')
  assert.equal(inactif.getAttribute('aria-checked'), 'false')
  assert.ok(actif.querySelector('.switch'), 'l’interrupteur est à droite')
  assert.equal(danger.style.color, 'var(--error)')
})

test('une entrée d’agent affiche le glyphe de l’agent', (t) => {
  reset(t)
  openMenu(anchor(), { items: [{ label: 'Claude', agentId: 'claude-zra' }] })
  assert.equal(items()[0].querySelector('svg').getAttribute('fill'), 'currentColor', 'glyphe de marque, pas icône de trait')
})

test('un en-tête d’entrée s’affiche comme libellé, pas comme bouton', (t) => {
  reset(t)
  openMenu(anchor(), { items: [{ label: 'Poste', header: true }, { label: 'x' }] })
  assert.equal(items().length, 1)
  assert.equal(doc.querySelectorAll('.menu__label').length, 1)
})

// ---------------------------------------------------------------------------
// La pile d'overlays
// ---------------------------------------------------------------------------

test('un formulaire remplace tout ce qui est ouvert', (t) => {
  reset(t)
  openMenu(anchor(), { items: [{ label: 'x' }] })
  formDialog('Titre', () => {})
  assert.equal(menus().length, 0, 'le menu a été remplacé')
  assert.equal(dialogs().length, 1)
})

test('un menu s’empile sur un formulaire (le sélecteur de thème sur les réglages)', (t) => {
  reset(t)
  formDialog('Réglages', () => {})
  openMenu(anchor(), { items: [{ label: 'Thème' }] })
  assert.equal(dialogs().length, 1)
  assert.equal(menus().length, 1)

  esc()                                  // Échap ferme le dessus seulement
  assert.equal(menus().length, 0)
  assert.equal(dialogs().length, 1)

  esc()
  assert.equal(dialogs().length, 0, 'le second Échap ferme le formulaire')
})

test('closeOverlay() sur une pile vide ne fait rien', (t) => {
  reset(t)
  closeOverlay()
  closeOverlay()
  assert.deepEqual(menus().concat(dialogs()), [])
})

test('closeAllOverlays() vide la pile, quel que soit son contenu', (t) => {
  reset(t)
  formDialog('Une', () => {})
  openMenu(anchor(), { items: [{ label: 'x' }] })
  openMenu(anchor(), { items: [{ label: 'y' }] })
  closeAllOverlays()
  assert.deepEqual(menus().concat(dialogs()), [])
})

test('le close() rendu à un formulaire ferme aussi ce qui s’est empilé dessus', (t) => {
  reset(t)
  let close
  formDialog('Réglages', (body, api) => { close = api.close })
  openMenu(anchor(), { items: [{ label: 'Thème' }] })
  close()
  assert.deepEqual(menus().concat(dialogs()), [], 'tout est parti')
})

test('Échap ne remonte pas au-delà du menu ouvert', (t) => {
  reset(t)
  let seen = 0
  doc.addEventListener('keydown', () => { seen++ })
  openMenu(anchor(), { items: [{ label: 'x' }] })
  esc()
  assert.equal(seen, 0, 'la surcouche arrête la propagation')
})

// ---------------------------------------------------------------------------
// formDialog
// ---------------------------------------------------------------------------

test('formDialog() : titre, bouton fermer, et un corps construit par l’appelant', (t) => {
  reset(t)
  const dlg = formDialog('Nouveau projet', (body) => body.append(doc.createElement('p')), { titleIcon: 'plus' })
  assert.equal(dlg.getAttribute('role'), 'dialog')
  assert.equal(dlg.getAttribute('aria-modal'), 'true')
  assert.equal(dlg.querySelector('.modal__title').textContent, 'Nouveau projet')
  assert.ok(dlg.querySelector('.modal__head svg'), 'l’icône de titre est rendue')
  assert.equal(dlg.querySelector('button[aria-label="Fermer"]') !== null, true)
  assert.equal(dlg.querySelectorAll('p').length, 1)

  click(dlg.querySelector('button[aria-label="Fermer"]'))
  assert.equal(dialogs().length, 0)
})

test('formDialog() : le close passé au constructeur ferme depuis l’intérieur', (t) => {
  reset(t)
  formDialog('Confirmer', (body, { close }) => {
    const btn = doc.createElement('button')
    btn.textContent = 'ok'
    btn.addEventListener('click', close)
    body.append(btn)
  })
  click(dialogs()[0].querySelector('.modal__body button'))
  assert.equal(dialogs().length, 0)
})

test('le voile d’un formulaire le ferme', (t) => {
  reset(t)
  formDialog('Titre', () => {})
  click(doc.querySelector('.scrim'))
  assert.equal(dialogs().length, 0)
})

// ---------------------------------------------------------------------------
// confirmDialog
// ---------------------------------------------------------------------------

test('confirmDialog() : Annuler ferme sans rappeler, Confirmer ferme et rappelle', (t) => {
  reset(t)
  let yes = 0
  confirmDialog('Supprimer ?', 'Ce thread sera oublié.', () => { yes++ }, { level: 'critical', yes: 'Supprimer' })
  assert.equal(dialogs().length, 1)
  assert.equal(dialogs()[0].querySelector('.modal__message').textContent, 'Supprimer ?')
  assert.equal(dialogs()[0].querySelector('.modal__detail').textContent, 'Ce thread sera oublié.')
  assert.ok(dialogs()[0].querySelector('.modal__head svg'), 'icône de sévérité en tête')

  const [annuler, confirmer] = [...dialogs()[0].querySelectorAll('.modal__actions button')]
  assert.equal(annuler.textContent, 'Annuler')
  assert.equal(confirmer.textContent, 'Supprimer')
  assert.equal(confirmer.className.includes('btn--tinted-error'), true, 'suppression = bouton rouge')

  click(annuler)
  assert.equal(dialogs().length, 0)
  assert.equal(yes, 0)

  confirmDialog('Encore ?', 'msg', () => { yes++ })
  const [, ok] = [...dialogs()[0].querySelectorAll('.modal__actions button')]
  assert.equal(ok.textContent, 'Confirmer', 'libellé par défaut')
  assert.equal(ok.className.includes('btn--tinted-accent'), true, 'info = teinté accent')
  click(ok)
  assert.equal(yes, 1)
  assert.equal(dialogs().length, 0)
})

test('confirmDialog() s’empile sur un formulaire : Échap ne ferme que la confirmation', (t) => {
  reset(t)
  let yes = 0
  formDialog('Réglages', () => {})
  confirmDialog('Retirer ?', 'détail', () => { yes++ }, { level: 'critical', yes: 'Retirer' })
  assert.equal(dialogs().length, 2)
  esc()
  assert.equal(dialogs().length, 1, 'le formulaire reste dessous')
  assert.equal(yes, 0)
  assert.ok(doc.querySelector('.modal--form'))
})

test('confirmDialog() : le focus est sur l’action, Entrée confirme, Tab cycle', (t) => {
  reset(t)
  let yes = 0
  const dlg = confirmDialog('Ok ?', null, () => { yes++ })
  const [annuler, ok] = [...dlg.querySelectorAll('.modal__actions button')]
  assert.equal(doc.activeElement, ok, 'l’action est active (Entrée la confirme)')
  dlg.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
  assert.equal(doc.activeElement, annuler)
  dlg.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
  assert.equal(doc.activeElement, ok)
  ok.click()
  assert.equal(yes, 1)
})

// ---------------------------------------------------------------------------
// toasts
// ---------------------------------------------------------------------------

test('toast() empile dans un hôte unique, puis retire le message', async (t) => {
  reset(t)
  const a = toast('Envoyé', { ms: 20 })
  const b = toast('Erreur', { level: 'error', ms: 20 })
  assert.equal(doc.querySelectorAll('.toasts').length, 1, 'un seul hôte')
  assert.equal(a.className, 'toast toast--info')
  assert.equal(b.className, 'toast toast--error')
  assert.equal(a.textContent, 'Envoyé')
  assert.ok(b.querySelector('svg'), 'une icône accompagne le message')
  assert.notDeepEqual(a.querySelector('svg').querySelector('path').getAttribute('d'),
    b.querySelector('svg').querySelector('path').getAttribute('d'), 'info et erreur n’ont pas la même icône')

  await wait(60)
  assert.equal(doc.querySelectorAll('.toast').length, 0, 'les toasts disparaissent seuls')
})

test('activity() montre un chargeur et s’arrête à done()', async (t) => {
  reset(t)
  const act = activity('Zed piloté au clavier…', { maxMs: 40 })
  const el = doc.querySelector('.toast')
  assert.equal(el.className.includes('toast--info'), true)
  assert.ok(el.querySelector('svg.icon.spin'), 'l’icône tourne')
  assert.equal(typeof act.done, 'function')

  act.done()
  assert.equal(doc.querySelectorAll('.toast').length, 0)

  await wait(80)                                  // le filet maxMs ne ressuscite rien
  assert.equal(doc.querySelectorAll('.toast').length, 0)
})

test('switchEl() rend un interrupteur Zed, décoratif, reflet de l’état', () => {
  const off = switchEl(false)
  assert.equal(off.className, 'switch')
  assert.equal(off.getAttribute('aria-hidden'), 'true')
  assert.ok(off.querySelector('.switch__track .switch__thumb'), 'piste + pouce')
  assert.equal(switchEl(true).className, 'switch switch--on')
  assert.equal(switchEl(true, 'menu__switch').className, 'switch switch--on menu__switch')
})
