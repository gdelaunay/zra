// Les surcouches (`js/ui.js`) : menus ancrés, feuilles, toasts.
//
// Le contrat qui compte pour le mobile : une pile d'overlays cohérente (Échap
// ferme celle du dessus, une feuille remplace tout, un menu s'empile), un clic
// sur le voile ferme, et aucun toast qui reste accroché indéfiniment.

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

const { openMenu, openSheet, closeOverlay, closeAllOverlays, toast, activity, confirmSheet, switchEl } = await import('../js/ui.js')

const layer = () => doc.getElementById('overlays')
const anchor = () => doc.getElementById('ancre')
const click = (el) => el.dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
// Événement lancé depuis le corps : c'est le cas réel (le focus est dans la page),
// et ça exerce l'écoute en capture posé sur `document`.
const esc = () => doc.body.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const menus = () => [...doc.querySelectorAll('.menu')]
const sheets = () => [...doc.querySelectorAll('.sheet')]
const items = (root = doc) => [...root.querySelectorAll('.menu__item')]

/** Ferme tout entre deux tests : la pile est un état global du module. */
function reset(t) {
  closeAllOverlays()
  for (const el of [...doc.querySelectorAll('.toast')]) el.remove()
  t.after(() => { closeAllOverlays() })
  assert.deepEqual(menus().concat(sheets()), [], 'on part d’un calque vide')
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

test('le voile ferme le menu, sans rien déclencher', (t) => {
  reset(t)
  let chosen = false
  openMenu(anchor(), { items: [{ label: 'x', onSelect: () => { chosen = true } }] })
  click(doc.querySelector('.scrim'))
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

test('une feuille remplace tout ce qui est ouvert', (t) => {
  reset(t)
  openMenu(anchor(), { items: [{ label: 'x' }] })
  openSheet('Titre', () => {})
  assert.equal(menus().length, 0, 'le menu a été remplacé')
  assert.equal(sheets().length, 1)
})

test('un menu s’empile sur une feuille (le sélecteur de thème sur les réglages)', (t) => {
  reset(t)
  openSheet('Réglages', () => {})
  openMenu(anchor(), { items: [{ label: 'Thème' }] })
  assert.equal(sheets().length, 1)
  assert.equal(menus().length, 1)

  esc()                                  // Échap ferme le dessus seulement
  assert.equal(menus().length, 0)
  assert.equal(sheets().length, 1)

  esc()
  assert.equal(sheets().length, 0, 'le second Échap ferme la feuille')
})

test('closeOverlay() sur une pile vide ne fait rien', (t) => {
  reset(t)
  closeOverlay()
  closeOverlay()
  assert.deepEqual(menus().concat(sheets()), [])
})

test('closeAllOverlays() vide la pile, quel que soit son contenu', (t) => {
  reset(t)
  openSheet('Une', () => {})
  openMenu(anchor(), { items: [{ label: 'x' }] })
  openMenu(anchor(), { items: [{ label: 'y' }] })
  closeAllOverlays()
  assert.deepEqual(menus().concat(sheets()), [])
})

test('le close() rendu à une feuille ferme aussi ce qui s’est empilé dessus', (t) => {
  reset(t)
  let close
  openSheet('Réglages', (body, api) => { close = api.close })
  openMenu(anchor(), { items: [{ label: 'Thème' }] })
  close()
  assert.deepEqual(menus().concat(sheets()), [], 'tout est parti')
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
// openSheet
// ---------------------------------------------------------------------------

test('openSheet() : titre, bouton fermer, et un corps construit par l’appelant', (t) => {
  reset(t)
  const sheet = openSheet('Nouveau thread', (body) => body.append(doc.createElement('p')), { titleIcon: 'plus' })
  assert.equal(sheet.getAttribute('role'), 'dialog')
  assert.equal(sheet.getAttribute('aria-modal'), 'true')
  assert.equal(sheet.querySelector('.sheet__title span').textContent, 'Nouveau thread')
  assert.ok(sheet.querySelector('.sheet__title svg'), 'l’icône de titre est rendue')
  assert.equal(sheet.querySelector('button[aria-label="fermer"]') !== null, true)
  assert.equal(sheet.querySelectorAll('p').length, 1)

  click(sheet.querySelector('button[aria-label="fermer"]'))
  assert.equal(sheets().length, 0)
})

test('openSheet() : rebuild reconstruit le corps sans rouvrir la feuille', (t) => {
  reset(t)
  let rebuild
  let body
  let count = 0
  const sheet = openSheet('Compteur', (b, api) => {
    body = b
    // `rebuild` ne repasse que `close` : une vue qui veut reconstruire à répétition
    // pose son propre `rebuild` stable, comme le fait `views/settings.js`.
    rebuild ??= api.rebuild
    count++
    body.append(Object.assign(doc.createElement('span'), { textContent: `passage ${count}` }))
  })
  assert.equal(sheet.textContent.includes('passage 1'), true)
  rebuild()
  rebuild()
  assert.equal(body.textContent, 'passage 3', 'le corps est vidé puis reconstruit')
  assert.equal(body.querySelectorAll('span').length, 1)
  assert.equal(sheets().length, 1, 'toujours une seule feuille')
})

test('openSheet() : le close passé au constructeur ferme depuis l’intérieur', (t) => {
  reset(t)
  openSheet('Confirmer', (body, { close }) => {
    const btn = doc.createElement('button')
    btn.textContent = 'ok'
    btn.addEventListener('click', close)
    body.append(btn)
  })
  click(sheets()[0].querySelector('button'))
  assert.equal(sheets().length, 0)
})

test('le voile d’une feuille la ferme', (t) => {
  reset(t)
  openSheet('Titre', () => {})
  click(doc.querySelector('.scrim'))
  assert.equal(sheets().length, 0)
})

// ---------------------------------------------------------------------------
// confirmSheet
// ---------------------------------------------------------------------------

test('confirmSheet() : Annuler ferme sans rappeler, Confirmer ferme et rappelle', (t) => {
  reset(t)
  let yes = 0
  confirmSheet('Supprimer ?', 'Ce thread sera oublié.', () => { yes++ }, { danger: true, yes: 'Supprimer' })
  assert.equal(sheets().length, 1)
  assert.equal(sheets()[0].querySelector('.sheet__title span').textContent, 'Supprimer ?')
  assert.equal(sheets()[0].querySelector('p').textContent, 'Ce thread sera oublié.')

  const [annuler, confirmer] = [...sheets()[0].querySelectorAll('button')].filter((b) => b.textContent !== '')
  assert.equal(confirmer.textContent, 'Supprimer')
  assert.equal(confirmer.className.includes('btn--danger'), true)

  click(annuler)
  assert.equal(sheets().length, 0)
  assert.equal(yes, 0)

  confirmSheet('Encore ?', 'msg', () => { yes++ })
  const [, ok] = [...sheets()[0].querySelectorAll('button')].filter((b) => b.textContent !== '')
  assert.equal(ok.textContent, 'Confirmer', 'libellé par défaut')
  assert.equal(ok.className.includes('btn--accent'), true)
  click(ok)
  assert.equal(yes, 1)
  assert.equal(sheets().length, 0)
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

test('switchEl() rend un interrupteur, décoratif, reflet de l’état', () => {
  const off = switchEl(false)
  assert.equal(off.className, 'switch')
  assert.equal(off.getAttribute('aria-hidden'), 'true')
  assert.equal(off.querySelector('.switch__knob') !== null, true)
  assert.equal(switchEl(true).className, 'switch switch--on')
  assert.equal(switchEl(true, 'menu__switch').className, 'switch switch--on menu__switch')
})
