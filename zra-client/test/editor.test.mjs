// Façade contenteditable du composer (editor.js, conception 0.5.2 D2) :
// sérialisation texte ↔ DOM (br, placeholder de rendu, blocs du navigateur),
// offsets de sélection, insertion, collage texte brut, hint fantôme exclu du
// texte. Le comportement IME réel (Gboard Android) se teste en navigateur.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
const win = dom.window
for (const k of ['window', 'document', 'Node', 'HTMLElement', 'Event', 'KeyboardEvent', 'requestAnimationFrame', 'cancelAnimationFrame']) {
  Object.defineProperty(globalThis, k, { value: win[k], configurable: true, writable: true })
}
after(() => { dom.window.close() })

const { editable } = await import('../js/editor.js')

function make(value = '') {
  const el = editable(document.createElement('div'))
  el.className = 'composer__input'
  document.body.append(el)
  el.value = value
  return el
}

/** Place la sélection DOM (façon navigateur) sur un nœud texte. */
function select(node, a, b = a) {
  const r = document.createRange()
  r.setStart(node, a)
  r.setEnd(node, b)
  const sel = win.getSelection()
  sel.removeAllRanges()
  sel.addRange(r)
}

test('value : round-trip texte ↔ DOM, sauts de ligne en <br>', () => {
  const el = make('a\nb\n')
  assert.equal(el.value, 'a\nb\n')
  // a <br> b <br> + <br> de rendu pour la ligne vide finale.
  assert.deepEqual([...el.childNodes].map((n) => n.nodeName), ['#text', 'BR', '#text', 'BR', 'BR'])
  el.value = ''
  assert.equal(el.childNodes.length, 0, 'vide : DOM vide (placeholder CSS :empty)')
})

test('le <br> final unique est un placeholder de rendu, pas du contenu', () => {
  const el = make()
  el.innerHTML = 'a<br>'
  assert.equal(el.value, 'a')
  el.innerHTML = 'a<br><br>'
  assert.equal(el.value, 'a\n')
  el.innerHTML = '<br>'
  assert.equal(el.value, '')
})

test('blocs du navigateur aplatis : div par ligne, div placeholder final', () => {
  const el = make()
  el.innerHTML = '<div>a</div><div>b</div>'
  assert.equal(el.value, 'a\nb')
  el.dispatchEvent(new win.Event('input', { bubbles: true }))
  assert.deepEqual([...el.childNodes].map((n) => n.nodeName), ['#text', 'BR', '#text'], 'DOM aplati')
  el.innerHTML = '<div>a</div><div><br></div>'
  assert.equal(el.value, 'a\n', 'le div vide final de Chrome ne compte pas double')
})

test('sélection : offsets texte sauvegardés hors focus, calculés depuis le DOM en focus', () => {
  const el = make('hello')
  el.selectionStart = 2
  el.selectionEnd = 4
  assert.equal(el.selectionStart, 2)
  assert.equal(el.selectionEnd, 4)
  // Sélection DOM réelle (le div a la sélection → « focus » pour la façade).
  select(el.firstChild, 3)
  assert.equal(el.selectionStart, 3, 'offset calculé depuis la position DOM')
  // À travers un saut de ligne : « ab\ncd », caret dans « cd » à 1 → offset 4.
  el.value = 'ab\ncd'
  const cd = [...el.childNodes].find((n) => n.nodeType === 3 && n.data === 'cd')
  select(cd, 1)
  assert.equal(el.selectionStart, 4)
})

test('insertText : saut de ligne en fin de texte, placeholder de rendu maintenu', () => {
  const el = make('ab')
  el.selectionStart = el.selectionEnd = 2
  let inputs = 0
  el.addEventListener('input', () => inputs++)
  el.insertText('\n')
  assert.equal(el.value, 'ab\n')
  assert.equal(el.selectionStart, 3)
  assert.equal(inputs, 1, 'insertText émet input')
  // Le caret est sur la ligne vide finale ; la frappe y atterrit.
  el.insertText('c')
  assert.equal(el.value, 'ab\nc')
  assert.equal(el.selectionStart, 4)
})

test('insertText : sauts de ligne consécutifs en fin — un seul placeholder de rendu', () => {
  const el = make('ab')
  el.selectionStart = el.selectionEnd = 2
  el.insertText('\n')
  el.insertText('\n')
  assert.equal(el.value, 'ab\n\n')
  assert.equal(el.selectionStart, 4)
  assert.deepEqual([...el.childNodes].map((n) => n.nodeName), ['#text', 'BR', 'BR', 'BR'])
  el.insertText('c')
  assert.equal(el.value, 'ab\n\nc')
})

test('insertText : remplace la sélection, au milieu et sur plusieurs lignes', () => {
  const el = make('abcd')
  el.selectionStart = 1
  el.selectionEnd = 3
  el.insertText('X')
  assert.equal(el.value, 'aXd')
  assert.equal(el.selectionStart, 2)
  el.value = 'fin'
  el.selectionStart = el.selectionEnd = 3
  el.insertText('\n suite\n')
  assert.equal(el.value, 'fin\n suite\n')
  assert.equal(el.selectionStart, 11)
})

test('collage : texte brut uniquement, le HTML du presse-papiers est jeté', () => {
  const el = make('a')
  el.selectionStart = el.selectionEnd = 1
  const ev = new win.Event('paste', { bubbles: true, cancelable: true })
  ev.clipboardData = { getData: (t) => (t === 'text/plain' ? 'b\nc' : '<b>riche</b>') }
  el.dispatchEvent(ev)
  assert.ok(ev.defaultPrevented)
  assert.equal(el.value, 'ab\nc')
  assert.equal(el.selectionStart, 4)
})

test('hint fantôme : exclu du texte, caret conservé, retrait propre', () => {
  const el = make('/help')
  el.selectionStart = el.selectionEnd = 5
  el.setHint(' query', 5)
  assert.equal(el.value, '/help', 'le hint ne fait pas partie du texte')
  const span = el.querySelector('.composer__hint')
  assert.ok(span)
  assert.equal(span.contentEditable, 'false')
  assert.equal(span.textContent, ' query')
  assert.equal(el.selectionStart, 5, 'caret conservé')
  // Hint au milieu (« /help  », hint à 6) : les offsets après lui sont justes.
  el.value = '/help  '
  el.setHint('query', 6)
  assert.equal(el.value, '/help  ')
  el.selectionStart = el.selectionEnd = 7
  assert.equal(el.selectionStart, 7)
  el.setHint(null, 0)
  assert.equal(el.querySelector('.composer__hint'), null)
  assert.equal(el.value, '/help  ')
})

test('Delete à l\'offset du hint : supprime le caractère, pas le span', () => {
  const el = make('/help  ')
  el.setHint('query', 6)
  // Caret devant le hint (offset 6) : Delete doit manger l'espace après.
  const text = el.firstChild
  select(text, 6)
  const ev = new win.KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true })
  el.dispatchEvent(ev)
  assert.ok(ev.defaultPrevented)
  assert.equal(el.value, '/help ', 'un espace supprimé')
  assert.equal(el.selectionStart, 6)
})

test('disabled et placeholder : attributs contenteditable / data-placeholder', () => {
  const el = make()
  el.placeholder = 'Message agent…'
  assert.equal(el.dataset.placeholder, 'Message agent…')
  assert.equal(el.getAttribute('aria-label'), 'Message agent…')
  el.disabled = true
  assert.ok(el.disabled)
  assert.equal(el.getAttribute('contenteditable'), 'false')
  el.disabled = false
  assert.equal(el.getAttribute('contenteditable'), 'true')
  el.placeholder = ''
  assert.equal(el.hasAttribute('aria-label'), false)
})

test('normalisation : texte vide → DOM vidé (le placeholder CSS peut s\'afficher)', () => {
  const el = make('x')
  el.firstChild.data = ''
  el.dispatchEvent(new win.Event('input', { bubbles: true }))
  assert.equal(el.childNodes.length, 0)
})

test('puces de mention : round-trip D3 texte ↔ DOM, atomiques dans les offsets', () => {
  const link = '[@a.js](file:///p/a.js)'
  const el = make(`voici ${link} ok`)
  assert.equal(el.value, `voici ${link} ok`, 'la puce se sérialise en lien D3')
  const chip = el.querySelector('.mention')
  assert.ok(chip, 'le lien du brouillon devient une puce')
  assert.equal(chip.contentEditable, 'false')
  assert.equal(chip.dataset.uri, 'file:///p/a.js')
  assert.equal(chip.dataset.name, 'a.js')
  // Offsets : la puce compte pour la longueur de sa sérialisation.
  const after = 'voici '.length + link.length
  // Focus simulé : sélection vivante dans el (comme le ferait le navigateur).
  select(el.firstChild, 0)
  el.selectionStart = el.selectionEnd = after
  assert.equal(el.selectionStart, after)
  // Caret « dans » la puce : clampé devant (elle est atomique).
  el.selectionStart = el.selectionEnd = 'voici '.length + 3
  const sel = win.getSelection()
  assert.ok(el.contains(sel.anchorNode), 'sélection posée dans le DOM')
  assert.equal(sel.anchorNode, el)
  assert.equal(sel.anchorOffset, [...el.childNodes].indexOf(chip), 'devant la puce')
  assert.equal(el.selectionStart, 'voici '.length, 'offset clampé au bord de la puce')
  // Insertion en fin : le texte ne casse pas le lien.
  el.selectionStart = el.selectionEnd = el.value.length
  el.insertText('!')
  assert.equal(el.value, `voici ${link} ok!`)
  // Dossier : icône folder, URI à / final conservé.
  el.value = '[@d](file:///p/d/)'
  assert.equal(el.value, '[@d](file:///p/d/)')
  assert.ok(el.querySelector('.mention svg'), 'icône de la puce')
})

test('insertText : un lien collé devient une puce (reparse des liens collés, Zed)', () => {
  const el = make('')
  el.insertText('[@b.ts](file:///p/b.ts) ')
  assert.ok(el.querySelector('.mention'), 'lien collé → puce')
  assert.equal(el.value, '[@b.ts](file:///p/b.ts) ')
  assert.equal(el.selectionStart, el.value.length)
})
