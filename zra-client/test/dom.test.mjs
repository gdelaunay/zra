// Les micro-helpers DOM (`js/dom.js`) — tout ce que les vues s'appuient dessus.
//
// Deux contrats méritent d'être verrouillés : `patchHtml` ne recrée pas les
// nœuds qui n'ont pas bougé (sinon le streaming perd la sélection et le
// défilement), et `rafBatch` n'événement perdu en route.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'

// DOM headless posé avant l'import : les helpers lisent `document` à l'appel,
// mais autant ne pas dépendre de l'ordre des hooks.
const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
  url: 'http://localhost/',
})
const win = dom.window
for (const k of ['window', 'document', 'Node', 'HTMLElement', 'Event', 'MouseEvent', 'requestAnimationFrame', 'cancelAnimationFrame']) {
  Object.defineProperty(globalThis, k, { value: win[k], configurable: true, writable: true })
}
after(() => { dom.window.close() })

const { h, button, clear, escapeHtml, emitter, rafBatch, debounce, patchHtml } = await import('../js/dom.js')

const $ = () => document.getElementById('app')

/** rAF piloté à la main : les tests n'attendent pas une vraie frame. */
let frames = []
function useFakeRaf(t) {
  frames = []
  globalThis.requestAnimationFrame = (fn) => { frames.push(fn); return frames.length }
  t.after(() => { globalThis.requestAnimationFrame = win.requestAnimationFrame })
}
const runFrames = () => { const due = frames; frames = []; for (const fn of due) fn() }

// ---------------------------------------------------------------------------
// h()
// ---------------------------------------------------------------------------

test('h() : tag, classes, et enfants dans l’ordre', () => {
  const el = h('div.thread-row.is-live', {}, h('span.a', {}, 'un'), 'deux')
  assert.equal(el.tagName, 'DIV')
  assert.equal(el.className, 'thread-row is-live')
  assert.equal(el.children.length, 1)
  assert.equal(el.textContent, 'undeux')
})

test('h() sans sélecteur de tag retombe sur un div', () => {
  assert.equal(h('.seul', {}).tagName, 'DIV')
  assert.equal(h('.seul', {}).className, 'seul')
})

test('h() : le deuxième argument peut être un enfant plutôt que des propriétés', () => {
  const kid = h('b', {}, 'gras')
  assert.equal(h('p', kid).firstChild, kid)
  assert.equal(h('p', 'texte').textContent, 'texte')
  assert.equal(h('p', null).childNodes.length, 0)
  assert.equal(h('p', ['a', 'b']).textContent, 'ab', 'un tableau est applati')
  assert.equal(h('p', [['a', ['b']]]).textContent, 'ab', 'sur plusieurs niveaux')
})

test('h() : null, undefined, false et true ne font aucun nœud', () => {
  const el = h('div', {}, null, undefined, false, true, 'x')
  assert.equal(el.childNodes.length, 1)
  assert.equal(el.textContent, 'x')
})

test('h() : propriétés spéciales — text, html, class, dataset, style', () => {
  const el = h('div.base', {
    text: 'brut <b>',
    class: 'ajoutee',
    dataset: { threadId: 't1' },
    style: { color: 'red' },
    title: 'infobulle',
  })
  assert.equal(el.textContent, 'brut <b>', 'text ne parse pas le HTML')
  assert.equal(el.innerHTML, 'brut &lt;b&gt;')
  assert.equal(el.className, 'base ajoutee')
  assert.equal(el.dataset.threadId, 't1')
  assert.equal(el.style.color, 'red')
  assert.equal(el.getAttribute('title'), 'infobulle')

  const raw = h('div', { html: '<i>italique</i>' })
  assert.equal(raw.innerHTML, '<i>italique</i>')
})

test('h() : les écouteurs on* sont attachés, les valeurs vides ignorées', () => {
  let clicks = 0
  const el = h('button', {
    onclick: () => { clicks++ },
    disabled: true,
    hidden: false,
    'data-rien': null,
    'data-aussi': undefined,
    role: 'menuitem',
  })
  el.dispatchEvent(new win.Event('click'))
  assert.equal(clicks, 1)
  assert.equal(el.getAttribute('disabled'), '', 'un booléen vrai pose l’attribut nu')
  assert.equal(el.hasAttribute('hidden'), false)
  assert.equal(el.hasAttribute('data-rien'), false)
  assert.equal(el.hasAttribute('data-aussi'), false)
  assert.equal(el.getAttribute('role'), 'menuitem')
})

test('h() : une valeur numérique devient un attribut texte', () => {
  const el = h('input', { tabindex: 0, maxlength: 12 })
  assert.equal(el.getAttribute('tabindex'), '0')
  assert.equal(el.getAttribute('maxlength'), '12')
})

// ---------------------------------------------------------------------------
// button(), clear(), escapeHtml()
// ---------------------------------------------------------------------------

test('button() : type=button par défaut, jamais submit', () => {
  assert.equal(button('.btn', {}, 'ok').getAttribute('type'), 'button')
  assert.equal(button('button.btn', {}).tagName, 'BUTTON')
  assert.equal(button('.btn', { type: 'submit' }).getAttribute('type'), 'submit', 'un type demandé est respecté')
  assert.equal(button('btn--accent', {}).className, 'btn--accent')
})

test('clear() vide un élément, et ne fait rien sur un élément vide', () => {
  const el = h('div', {}, h('span', {}, 'a'), 'b')
  clear(el)
  assert.equal(el.childNodes.length, 0)
  clear(el)
  assert.equal(el.childNodes.length, 0)
})

test('escapeHtml() échappe les cinq caractères dangereux', () => {
  assert.equal(escapeHtml(`<>&"'`), '&lt;&gt;&amp;&quot;&#39;')
  assert.equal(escapeHtml('rien à fuir'), 'rien à fuir')
  assert.equal(escapeHtml(12), '12')
  assert.equal(escapeHtml(null), 'null')
})

// ---------------------------------------------------------------------------
// emitter()
// ---------------------------------------------------------------------------

test('emitter() : on/emit, et la fonction rendue désabonne', () => {
  const bus = emitter()
  const seen = []
  const off = bus.on('x', (p) => seen.push(['a', p]))
  bus.on('x', (p) => seen.push(['b', p]))
  bus.emit('x', 1)
  off()
  bus.emit('x', 2)
  assert.deepEqual(seen, [['a', 1], ['b', 1], ['b', 2]])
})

test('emitter() : émettre un sujet sans écouteur ne fait rien', () => {
  const bus = emitter()
  bus.emit('jamais-inscrit', { a: 1 })
  assert.equal(1, 1)
})

test('emitter() : un écouteur qui échoue n’empêche pas les autres', () => {
  const bus = emitter()
  const errors = []
  const realError = console.error
  console.error = (...a) => errors.push(a)
  try {
    const seen = []
    bus.on('x', () => { throw new Error('cassé') })
    bus.on('x', () => seen.push('second'))
    bus.emit('x')
    assert.deepEqual(seen, ['second'])
  } finally {
    console.error = realError
  }
  assert.equal(errors.length, 1)
  assert.equal(errors[0][1], 'x')
})

test('emitter() : se désabonner deux fois est inoffensif', () => {
  const bus = emitter()
  const off = bus.on('x', () => {})
  off()
  off()
  bus.emit('x')
})

// ---------------------------------------------------------------------------
// rafBatch() / debounce()
// ---------------------------------------------------------------------------

test('rafBatch() regroupe les appels d’une même frame, sans en perdre', (t) => {
  useFakeRaf(t)
  const batches = []
  const push = rafBatch((list) => batches.push(list))

  push('a')
  push('b')
  assert.deepEqual(batches, [], 'rien avant la frame')
  runFrames()
  assert.deepEqual(batches, [['a', 'b']])

  push('c')
  runFrames()
  assert.deepEqual(batches, [['a', 'b'], ['c']], 'un nouveau lot par frame')
})

test('rafBatch() : un appel pendant le traitement part à la frame suivante', (t) => {
  useFakeRaf(t)
  const seen = []
  const push = rafBatch((list) => { seen.push(list); if (list[0] === 'a') push('b') })
  push('a')
  runFrames()
  assert.deepEqual(seen, [['a']])
  runFrames()
  assert.deepEqual(seen, [['a'], ['b']])
})

test('debounce() ne garde que le dernier appel', async (t) => {
  const calls = []
  const run = debounce((v) => calls.push(v), 10)
  run(1); run(2); run(3)
  assert.deepEqual(calls, [])
  await new Promise((r) => setTimeout(r, 40))
  assert.deepEqual(calls, [3])
})

// ---------------------------------------------------------------------------
// patchHtml()
// ---------------------------------------------------------------------------

test('patchHtml() remplace un contenu préexistant au premier passage', () => {
  const box = h('div', { html: '<p>ancien</p><p>contenu</p>' })
  patchHtml(box, ['<b>neuf</b>'])
  assert.equal(box.innerHTML, '<b>neuf</b>')
})

test('patchHtml() ne recrée pas les morceaux inchangés', () => {
  const box = h('div')
  patchHtml(box, ['<p>un</p>', '<p>deux</p>', '<p>trois</p>'])
  const [first, second] = [...box.childNodes]

  patchHtml(box, ['<p>un</p>', '<p>deux</p>', '<p>trois modifié</p>'])
  assert.equal(box.childNodes[0], first, 'le premier nœud est le même objet')
  assert.equal(box.childNodes[1], second, 'le deuxième aussi')
  assert.notEqual(box.childNodes[2], undefined)
  assert.equal(box.textContent, 'undeuxtrois modifié')
})

test('patchHtml() : un morceau qui raccourcit supprime la suite', () => {
  const box = h('div')
  patchHtml(box, ['<p>a</p>', '<p>b</p>', '<p>c</p>'])
  patchHtml(box, ['<p>a</p>'])
  assert.equal(box.childNodes.length, 1)
  assert.equal(box.textContent, 'a')
})

test('patchHtml() : rien à faire si les morceaux sont identiques', () => {
  const box = h('div')
  patchHtml(box, ['<p>a</p>', '<p>b</p>'])
  const nodes = [...box.childNodes]
  patchHtml(box, ['<p>a</p>', '<p>b</p>'])
  assert.deepEqual([...box.childNodes], nodes)
})

test('patchHtml() : un morceau de plusieurs nœuds compte pour un', () => {
  const box = h('div')
  patchHtml(box, ['<p>a</p><p>b</p>', '<p>c</p>'])
  assert.equal(box.childNodes.length, 3)
  const head = box.childNodes[0]
  patchHtml(box, ['<p>a</p><p>b</p>', '<p>z</p>'])
  assert.equal(box.childNodes[0], head, 'le morceau à deux nœuds n’est pas retouché')
  assert.equal(box.textContent, 'abz')
})

test('patchHtml() garde sa mémoire sur le conteneur : vidé derrière son dos, il ne ressuscite rien', () => {
  // Limite assumée : l'état vit sur le conteneur (`_zraPieces`). Les vues ne
  // mélangent pas `clear()` et `patchHtml` sur un même nœud — `thread.js` jette
  // le nœud entier quand il vide le fil.
  const box = h('div')
  patchHtml(box, ['<p>a</p>'])
  clear(box)
  patchHtml(box, ['<p>a</p>'])
  assert.equal(box.childNodes.length, 0, 'morceaux identiques : rien à repeindre')

  patchHtml(box, ['<p>a modifié</p>'])
  assert.equal(box.textContent, 'a modifié', 'un morceau changé est repeint')
})

test('patchHtml() ne modifie pas le tableau reçu', () => {
  const box = h('div')
  const pieces = ['<p>a</p>']
  patchHtml(box, pieces)
  pieces.push('<p>b</p>')
  assert.equal(box.childNodes.length, 1, 'le conteneur ne suit pas le tableau d’origine')
  patchHtml(box, pieces)
  assert.equal(box.childNodes.length, 2)
})

test('patchHtml() sur deux conteneurs ne les mélange pas', () => {
  const a = h('div')
  const b = h('div')
  patchHtml(a, ['<p>a1</p>'])
  patchHtml(b, ['<p>b1</p>', '<p>b2</p>'])
  assert.equal(a.textContent, 'a1')
  assert.equal(b.textContent, 'b1b2')
})
