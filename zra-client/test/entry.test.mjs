// Le rendu d'une entrée de timeline (`js/views/entry.js`).
//
// C'est la fonction la plus appelée de la PWA — à chaque événement ACP, et en
// boucle pendant le streaming. On y verrouille : un type d'entrée = un rendu,
// le découpage en morceaux qui alimente `patchHtml`, la révélation progressive
// du texte, l'échappement du HTML venu de l'agent, et les états de l'encart de
// permission (protocole §6.6).

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true })
const win = dom.window
for (const k of ['window', 'document', 'Node', 'HTMLElement', 'Event', 'MouseEvent', 'getComputedStyle', 'requestAnimationFrame']) {
  Object.defineProperty(globalThis, k, { value: win[k], configurable: true, writable: true })
}
const mem = new Map()
globalThis.localStorage = {
  getItem: (k) => mem.get(k) ?? null,
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
}
after(() => { dom.window.close() })

const { renderEntry, blocksPieces, blocksHtml, textLength, revealBlocks, messageBody } = await import('../js/views/entry.js')
const { settings } = await import('../js/settings.js')

// `.click()` natif : comme dans un navigateur, un bouton `disabled` ne réagit pas.
const click = (el) => el.click()
const entry = (over = {}) => ({ id: 'e1', rev: 0, at: Date.now(), ...over })
const text = (t) => ({ type: 'text', text: t })
/** Monte une entrée dans un conteneur et rend les deux. */
function render(e, ctx = {}) {
  const root = dom.window.document.createElement('div')
  const node = renderEntry(e, ctx)
  root.append(node)
  return { root, node }
}
const q = (node, sel) => node.querySelector(sel)
const qa = (node, sel) => [...node.querySelectorAll(sel)]

// ---------------------------------------------------------------------------
// renderEntry — socle commun
// ---------------------------------------------------------------------------

test('renderEntry() marque l’entrée : classe, id et révision', () => {
  const { node } = render(entry({ type: 'agent', rev: 7, blocks: [text('salut')] }))
  assert.equal(node.classList.contains('entry'), true)
  assert.equal(node.dataset.entry, 'e1')
  assert.equal(node.dataset.rev, '7')
})

test('un type d’entrée inconnu s’affiche en brut, pas en trou', () => {
  const { node } = render(entry({ type: 'zra/mystère', payload: { a: 1 } }))
  assert.equal(node.classList.contains('raw'), true)
  assert.match(q(node, '.raw__head').textContent, /événement non reconnu : zra\/mystère/)
  assert.match(q(node, '.raw__body').textContent, /"a": 1/)
})

test('un notice devient une ligne de système, avertie si level=warn', () => {
  const info = render(entry({ type: 'notice', text: 'tour interrompu', level: 'info' })).node
  assert.equal(info.className.includes('sysline'), true)
  assert.equal(info.className.includes('warn'), false)
  assert.equal(info.textContent, 'tour interrompu')

  const warn = render(entry({ type: 'notice', text: 'shim parti', level: 'warn' })).node
  assert.equal(warn.className.includes('warn'), true)
})

// ---------------------------------------------------------------------------
// Messages utilisateur et agent
// ---------------------------------------------------------------------------

test('message utilisateur : la bulle porte le markdown, sans en-tête', () => {
  const { node } = render(entry({ type: 'user', blocks: [text('bonjour **toi**')] }))
  assert.equal(node.className.includes('msg--user'), true)
  assert.equal(node.querySelector('.msg__status'), null)
  assert.equal(node.textContent.includes('bonjour'), true)
  assert.ok(q(node, '.msg__body.md strong'), 'le markdown est rendu')
})

test('message en attente est estompé, message non envoyé le dit', () => {
  const pending = render(entry({ type: 'user', pending: true, blocks: [text('x')] })).node
  assert.equal(pending.className.includes('is-pending'), true)

  const failed = render(entry({ type: 'user', failed: true, blocks: [text('x')] })).node
  assert.equal(failed.className.includes('is-failed'), true)
  assert.equal(q(failed, '.msg__status').textContent, 'non envoyé')
})

test('message agent : le curseur n’apparaît que sur le dernier message d’un tour en cours', () => {
  const blocks = [text('en train')]
  assert.equal(q(render(entry({ type: 'agent', blocks }), { busy: true, isLast: true }).node, '.cursor') !== null, true)
  assert.equal(q(render(entry({ type: 'agent', blocks }), { busy: true, isLast: false }).node, '.cursor'), null)
  assert.equal(q(render(entry({ type: 'agent', blocks }), { busy: false, isLast: true }).node, '.cursor'), null)
  assert.equal(q(render(entry({ type: 'agent', blocks }), {}).node, '.cursor'), null)
})

test('messageBody() retrouve le corps écrit par le streaming, pour chaque forme', () => {
  const agent = render(entry({ type: 'agent', blocks: [text('a')] })).node
  assert.equal(messageBody(agent).className, 'msg__body md')
  const user = render(entry({ type: 'user', blocks: [text('a')] })).node
  assert.equal(messageBody(user).className, 'msg__body md')
  const thought = render(entry({ type: 'thought', blocks: [text('a')] })).node
  assert.equal(messageBody(thought).className, 'md', 'le corps d’une réflexion est enfant direct')
  const tool = render(entry({ type: 'tool', status: 'completed', kind: 'read', content: [{ type: 'content', content: text('a') }] })).node
  assert.equal(messageBody(tool), null, 'un tool call n’est pas un corps streamé')
})

// ---------------------------------------------------------------------------
// Réflexion
// ---------------------------------------------------------------------------

test('réflexion : repliée selon le réglage, et le choix survit au re-rendu', () => {
  const e = entry({ type: 'thought', blocks: [text('je réfléchis')] })
  const open = render(e).node
  assert.equal(open.className.includes('is-open'), true, 'showThoughts vaut true par défaut')
  assert.equal(q(open, '.thought__head').getAttribute('aria-expanded'), 'true')

  click(q(open, '.thought__head'))
  assert.equal(open.className.includes('is-open'), false)
  assert.equal(q(open, '.thought__head').getAttribute('aria-expanded'), 'false')
  assert.equal(e.open, false, 'le choix est écrit sur l’entrée')

  const again = render(e).node
  assert.equal(again.className.includes('is-open'), false, 'un re-rendu respecte le choix')
  click(q(again, '.thought__head'))
  assert.equal(e.open, true)
})

test('réflexion : le réglage showThoughts=false replie par défaut', () => {
  const before = settings.showThoughts
  settings.showThoughts = false
  try {
    const node = render(entry({ type: 'thought', blocks: [text('x')] })).node
    assert.equal(node.className.includes('is-open'), false)
    const forced = render(entry({ type: 'thought', open: true, blocks: [text('x')] })).node
    assert.equal(forced.className.includes('is-open'), true, 'entry.open a priorité')
  } finally {
    settings.showThoughts = before
  }
})

// ---------------------------------------------------------------------------
// blocksPieces / blocksHtml / textLength / revealBlocks
// ---------------------------------------------------------------------------

test('blocksPieces() découpe le markdown par bloc de premier niveau', () => {
  assert.deepEqual(blocksPieces([text('un\n\ndeux')]), ['<p>un</p>', '<p>deux</p>'])
  assert.deepEqual(blocksPieces([text('a'), text('b')]), ['<p>a</p>', '<p>b</p>'])
  assert.deepEqual(blocksPieces([text('- a\n- b')]), ['<ul><li>a</li><li>b</li></ul>'], 'une liste reste un morceau')
  assert.deepEqual(blocksPieces([]), [])
  assert.deepEqual(blocksPieces(null), [])
  assert.deepEqual(blocksPieces(undefined), [])
})

test('blocksPieces() ajoute le curseur en dernier morceau', () => {
  assert.deepEqual(blocksPieces([text('x')], { cursor: true }), ['<p>x</p>', '<span class="cursor"></span>'])
  assert.deepEqual(blocksPieces([], { cursor: true }), ['<span class="cursor"></span>'])
})

test('blocksPieces() rend chaque sorte de ContentBlock', () => {
  const pieces = blocksPieces([
    { type: 'image', data: 'QUJD', mimeType: 'image/jpeg' },
    { type: 'image' },
    { type: 'audio', data: 'xx' },
    { type: 'resource_link', name: 'app.js', uri: 'file:///app.js' },
    { type: 'resource_link', uri: 'file:///sans-nom.js' },
    { type: 'resource', resource: { text: 'contenu', uri: 'file:///f' } },
    { type: 'resource', resource: { uri: 'file:///vide' } },
  ])
  assert.equal(pieces.length, 7)
  assert.match(pieces[0], /^<img alt="image".*src="data:image\/jpeg;base64,QUJD">$/)
  assert.equal(pieces[1], '<p class="muted">[image]</p>', 'une image sans données est annoncée')
  assert.equal(pieces[2], '<p class="muted">[audio]</p>')
  assert.equal(pieces[3], '<p><code>app.js</code></p>')
  assert.equal(pieces[4], '<p><code>file:///sans-nom.js</code></p>')
  assert.equal(pieces[5], '<pre><code>contenu</code></pre>')
  assert.equal(pieces[6], '<p><code>file:///vide</code></p>')
})

test('blocksPieces() échappe ce qui vient de l’agent', () => {
  const pieces = blocksPieces([
    { type: 'resource_link', name: '<img src=x onerror=alert(1)>' },
    { type: 'resource', resource: { text: '</pre><script>alert(1)</script>' } },
    { type: 'image', data: '"><script>alert(1)</script>', mimeType: 'a"onload="x' },
    { type: 'inconnu', v: '<b>' },
  ])
  for (const p of pieces) {
    assert.equal(p.includes('<script>'), false, p)
    assert.equal(p.includes('<img src=x'), false, p)
  }
  assert.match(pieces[3], /&lt;b&gt;/)
})

test('un bloc inconnu est rendu en JSON, et un bloc nul ignoré', () => {
  assert.deepEqual(blocksPieces([{ type: 'nouveau', x: 1 }]),
    ['<pre class="muted"><code>{\n  &quot;type&quot;: &quot;nouveau&quot;,\n  &quot;x&quot;: 1\n}</code></pre>'])
  assert.deepEqual(blocksPieces([null, undefined, text('x')]), ['<p>x</p>'])
})

test('blocksHtml() recolle les morceaux', () => {
  assert.equal(blocksHtml([text('un\n\ndeux')]), '<p>un</p><p>deux</p>')
  assert.equal(blocksHtml(null), '')
})

test('textLength() ne compte que le texte', () => {
  assert.equal(textLength([text('abc'), { type: 'image' }, text('de')]), 5)
  assert.equal(textLength([]), 0)
  assert.equal(textLength(null), 0)
  assert.equal(textLength([text()]), 0)
})

test('revealBlocks() coupe le texte au caractère près, sans toucher aux blocs', () => {
  const blocks = [text('bonjour'), { type: 'image', data: 'x' }, text(' le monde')]
  const blocksCopy = JSON.parse(JSON.stringify(blocks))

  assert.deepEqual(revealBlocks(blocks, 3), [text('bon')])
  assert.deepEqual(revealBlocks(blocks, 7), [text('bonjour')],
    'budget exactement épuisé : le bloc non textuel attend le caractère suivant')
  assert.deepEqual(revealBlocks(blocks, 8), [text('bonjour'), { type: 'image', data: 'x' }, text(' ')],
    'un reste de budget fait paraître l’image, puis le début du texte suivant')
  assert.deepEqual(revealBlocks(blocks, 100), blocks, 'au-delà, tout est rendu')
  assert.deepEqual(blocks, blocksCopy, 'les blocs reçus ne sont pas modifiés')
})

test('revealBlocks() : budget épuisé, plus rien n’est ajouté', () => {
  const blocks = [text('ab'), text('cd')]
  assert.deepEqual(revealBlocks(blocks, 2), [text('ab')])
  assert.deepEqual(revealBlocks(blocks, 3)[1], text('c'))
  assert.deepEqual(revealBlocks(blocks, 0), [], 'rien à révéler')
})

test('revealBlocks() : un bloc non textuel en tête paraît même sans budget', () => {
  const blocks = [{ type: 'image', data: 'x' }, text('après')]
  assert.deepEqual(revealBlocks(blocks, 0), [{ type: 'image', data: 'x' }])
})

// ---------------------------------------------------------------------------
// Tool call
// ---------------------------------------------------------------------------

const tool = (over = {}) => entry({ type: 'tool', toolCallId: 'tc1', status: 'completed', kind: 'edit', title: 'Écrire `app.js`', ...over })

test('tool call : statut, icône d’outil, titre avec code en ligne', () => {
  const { node } = render(tool())
  assert.equal(node.className.includes('tool--completed'), true)
  assert.ok(q(node, '.tool__icon'), 'l’icône du kind est là')
  assert.equal(q(node, '.tool__title code').textContent, 'app.js', 'les backticks deviennent du code')
  assert.ok(q(node, '.tool__status svg'))
})

test('tool call : chaque statut a sa marque', () => {
  const icons = {}
  for (const status of ['pending', 'in_progress', 'completed', 'failed', 'inconnu']) {
    const { node } = render(tool({ status }))
    assert.equal(node.className.includes(`tool--${status}`), true, status)
    icons[status] = q(node, '.tool__status path').getAttribute('d')
    assert.equal(q(node, '.tool__status svg').getAttribute('class').includes('spin'), status === 'in_progress', status)
  }
  assert.notEqual(icons.completed, icons.failed)
  assert.equal(icons.inconnu, icons.pending, 'un statut non prévu retombe sur le cercle')
})

test('tool call : le titre est échappé', () => {
  const { node } = render(tool({ title: '<script>alert(1)</script> `x`' }))
  assert.equal(node.querySelector('script'), null)
  assert.equal(q(node, '.tool__title').innerHTML.includes('&lt;script&gt;'), true)
})

test('tool call : replié/déplié selon le réglage, choix conservé sur l’entrée', () => {
  const e = tool({ open: false })
  const { node } = render(e)
  assert.equal(node.className.includes('is-open'), false, 'expandTools vaut false par défaut')
  click(q(node, '.tool__head'))
  assert.equal(node.className.includes('is-open'), true)
  assert.equal(e.open, true)

  const closedByDefault = render(tool()).node
  assert.equal(closedByDefault.className.includes('is-open'), false, 'expandTools vaut false par défaut')

  const before = settings.expandTools
  settings.expandTools = true
  try {
    assert.equal(render(tool()).node.className.includes('is-open'), true, 'le réglage déplie')
  } finally {
    settings.expandTools = before
  }
})

test('tool call : emplacements, sortie, et les replis de brut', () => {
  const { node } = render(tool({
    locations: [{ path: 'C:/proj/zra/src/app.js', line: 12 }, { path: 'C:/proj/zra/README.md' }],
    content: [{ type: 'content', content: text('fait') }],
    rawInput: { path: 'app.js' },
    rawOutput: { ok: true },
  }))
  const locs = qa(node, '.tool__locations span')
  assert.equal(locs.length, 2)
  assert.match(locs[0].textContent, /app\.js:12$/)
  assert.equal(locs[1].textContent.includes(':'), false, 'pas de ligne, pas de :')
  assert.equal(node.textContent.includes('fait'), true)
  assert.deepEqual(qa(node, '.raw__head span').map((n) => n.textContent), ['entrée brute', 'sortie brute'])
  assert.match(node.textContent, /"path": "app.js"/)
})

test('tool call sans sortie : « en attente… » tant que pending, « aucune sortie » sinon', () => {
  assert.match(render(tool({ status: 'pending', content: [] })).node.textContent, /en attente…/)
  assert.match(render(tool({ status: 'completed', content: [] })).node.textContent, /aucune sortie/)
  assert.match(render(tool({ content: null, locations: null })).node.textContent, /aucune sortie/)
})

test('tool call : un diff est rendu avec ses compteurs et se déplie', () => {
  const { node } = render(tool({
    content: [{ type: 'diff', path: 'C:/proj/zra/app.js', oldText: 'a\nb\nc\n', newText: 'a\nB\nc\nd\n' }],
  }))
  const diff = q(node, '.diff')
  assert.equal(q(diff, '.diff__head .truncate').textContent, '…/proj/zra/app.js')
  assert.equal(q(diff, '.plus').textContent, '+2')
  assert.equal(q(diff, '.minus').textContent, '−1')
  assert.equal(diff.className.includes('is-open'), false)
  click(q(diff, '.diff__head'))
  assert.equal(diff.className.includes('is-open'), true)
  const signs = qa(diff, '.diff__sign').map((n) => n.textContent)
  assert.ok(signs.includes('+') && signs.includes('−') && signs.includes(' '), 'ajouts, retraits et contexte')
})

test('tool call : un diff trop gros pour être aligné le dit, au lieu de calculer', () => {
  // Au-delà de 4 M de cellules, `lineDiff` renonce à l'alignement (garde-fou de
  // `js/diff.js`) : tout est rendu comme supprimé puis ajouté, et le diff l'écrit.
  const n = 2100
  const oldText = Array.from({ length: n }, (_, i) => `avant ${i}`).join('\n')
  const newText = Array.from({ length: n }, (_, i) => `après ${i}`).join('\n')
  const { node } = render(tool({ content: [{ type: 'diff', path: 'big.txt', oldText, newText }] }))
  assert.match(node.textContent, /fichier trop gros : diff non aligné/)
  assert.equal(q(node, '.plus').textContent, `+${n}`)
  assert.equal(q(node, '.minus').textContent, `−${n}`)
})

test('tool call : un long diff non modifié est replié en lignes sautées', () => {
  const unchanged = Array.from({ length: 40 }, (_, i) => `ligne ${i}`).join('\n')
  const { node } = render(tool({
    content: [{ type: 'diff', path: 'a.txt', oldText: unchanged, newText: `${unchanged}\nadded` }],
  }))
  assert.match(q(node, '.diff__body').textContent, /lignes inchangées/)
  assert.ok(qa(node, '.diff__line').length < 45, 'tout le contexte n’est pas rendu')
})

test('tool call : terminal en cours, réussi, en échec, et inconnu', () => {
  const timeline = { terminals: new Map() }
  const block = [{ type: 'terminal', terminalId: 'term-1' }]

  const running = render(tool({ content: block }), { timeline }).node
  assert.ok(q(running, '.term__exit svg.spin'), 'un terminal sans code de sortie tourne encore')
  assert.equal(q(running, '.term__out').textContent, '')

  timeline.terminals.set('term-1', { output: 'bonjour\n', exitStatus: { exitCode: 0 } })
  const ok = render(tool({ content: block }), { timeline }).node
  assert.equal(q(ok, '.term__exit').textContent, 'exit 0')
  assert.equal(q(ok, '.term__exit').className.includes('term__exit--ok'), true)
  assert.equal(q(ok, '.term__out').textContent, 'bonjour\n')

  timeline.terminals.set('term-1', { output: 'raté', exitStatus: { exitCode: 2 } })
  const ko = render(tool({ content: block }), { timeline }).node
  assert.equal(q(ko, '.term__exit').textContent, 'exit 2')
  assert.equal(q(ko, '.term__exit').className.includes('term__exit--ko'), true)

  const orphan = render(tool({ content: [{ type: 'terminal', terminalId: 'autre' }] }), { timeline }).node
  assert.ok(q(orphan, '.term__exit svg.spin'), 'terminal jamais vu : toujours en cours')
})

test('tool call : la sortie du terminal est échappée', () => {
  const timeline = { terminals: new Map([['t1', { output: '<img src=x onerror=alert(1)>', exitStatus: null }]]) }
  const { node } = render(tool({ content: [{ type: 'terminal', terminalId: 't1' }] }), { timeline })
  assert.equal(node.querySelector('img'), null)
})

test('tool call : un contenu inattendu s’affiche en markdown plutôt que de disparaître', () => {
  const { node } = render(tool({ content: [{ type: 'inconnu', v: 1 }] }))
  assert.match(node.textContent, /"type": "inconnu"/)
})

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

test('plan : progression, statut de chaque étape, priorité haute', () => {
  const { node } = render(entry({
    type: 'plan',
    items: [
      { content: 'fait', status: 'completed' },
      { content: 'en cours', status: 'in_progress', priority: 'high' },
      { content: 'à venir', status: 'pending' },
      { content: 'sans statut' },
    ],
  }))
  assert.equal(q(node, '.plan__head .muted').textContent, '1/4')
  const items = qa(node, '.plan__item')
  assert.deepEqual(items.map((li) => li.className.match(/plan__item--(\w+)/)[1]),
    ['completed', 'in_progress', 'pending', 'pending'])
  assert.equal(qa(node, '.plan__prio').length, 1)
  assert.equal(qa(node, '.plan__prio')[0].textContent, '!')
  assert.ok(q(items[1], 'svg.spin'), 'l’étape en cours tourne')
  assert.deepEqual(items.map((li) => li.textContent.replace(/!$/, '')), ['fait', 'en cours', 'à venir', 'sans statut'])
})

test('plan vide : 0/0, pas d’erreur', () => {
  const { node } = render(entry({ type: 'plan', items: [] }))
  assert.equal(q(node, '.plan__head .muted').textContent, '0/0')
  assert.equal(qa(node, '.plan__item').length, 0)
})

// ---------------------------------------------------------------------------
// Permission — protocole §6.6
// ---------------------------------------------------------------------------

const OPTIONS = [
  { optionId: 'allow', name: 'Autoriser', kind: 'allow_once' },
  { optionId: 'reject', name: 'Refuser', kind: 'reject_once' },
]
const permRender = (over = {}, ctx = {}) => render(entry({
  type: 'permission', requestId: 'r1', toolCall: { title: 'Écrire `app.js`' }, options: OPTIONS, ...over,
}), ctx)

test('permission ouverte et répondable : deux options actives, refus en danger', () => {
  const calls = []
  const { node } = permRender({}, { canRespond: true, onPermission: (entryArg, o) => calls.push([entryArg, o.optionId]) })
  const [allow, reject] = qa(node, '.perm__options button')
  assert.equal(allow.textContent, 'Autoriser')
  assert.equal(allow.disabled, false)
  assert.equal(reject.className.includes('btn--danger'), true, 'un kind « reject… » est rouge')
  assert.equal(allow.className.includes('btn--accent'), true)
  assert.equal(q(node, '.perm__note'), null, 'aucune note tant que rien n’est tranché')
  assert.equal(q(node, '.md code').textContent, 'app.js')

  click(allow)
  assert.equal(calls.length, 1)
  assert.equal(calls[0][1], 'allow')
  assert.equal(calls[0][0].requestId, 'r1', 'le callback reçoit l’entrée entière')
})

test('permission en cours d’envoi : l’option choisie tourne, tout est verrouillé', () => {
  const { node } = permRender({ pendingOptionId: 'allow' }, { canRespond: true })
  const [allow, reject] = qa(node, '.perm__options button')
  assert.ok(q(allow, 'svg.spin'), 'spinner sur l’option envoyée')
  assert.equal(allow.disabled, true, 'on ne renvoie pas une réponse déjà en vol')
  assert.equal(reject.disabled, true, 'on ne change plus d’avis')
  assert.equal(q(node, '.perm__note'), null)
})

test('permission tranchée : coche sur l’option, encart clos, plus rien de cliquable', () => {
  const { node } = permRender({ pendingOptionId: 'allow', resolved: true, outcome: 'allow' }, { canRespond: true })
  assert.equal(node.className.includes('perm--done'), true)
  const [allow, reject] = qa(node, '.perm__options button')
  assert.ok(q(allow, 'svg'), 'la coche marque l’option choisie')
  assert.equal(allow.disabled, true)
  assert.equal(reject.disabled, true, 'changer d’avis n’est plus possible')
  assert.equal(q(node, '.perm__note'), null, 'la réponse se lit sur l’option')
})

// L'option choisie d'un encart tranché restait cliquable (`disabled: locked &&
// !chosen`) et un second appui renvoyait une écriture que le daemon refusait en
// `permission_expired`. Corrigé (FINDINGS.md) : verrouillé = tout le monde muet.
test('une permission tranchée ne se rejoue pas, même sur l’option choisie', () => {
  let calls = 0
  const { node } = permRender({ pendingOptionId: 'allow', resolved: true, outcome: 'allow' },
    { canRespond: true, onPermission: () => { calls++ } })
  const allow = qa(node, '.perm__options button')[0]
  assert.equal(allow.disabled, true)
  click(allow)
  assert.equal(calls, 0, 'un bouton désactivé ne répond pas au clic')
})

test('permission tranchée par une option absente : la note donne le verdict', () => {
  const { node } = permRender({ pendingOptionId: 'autre', resolved: true, outcome: 'cancelled' }, { canRespond: true })
  assert.equal(q(node, '.perm__note').textContent, 'réponse : cancelled')
  assert.deepEqual(qa(node, '.perm__options button').map((b) => b.disabled), [true, true])
})

test('permission sur thread injoignable : lecture seule et note explicite', () => {
  let calls = 0
  const { node } = permRender({}, { canRespond: false, onPermission: () => { calls++ } })
  const [allow] = qa(node, '.perm__options button')
  assert.equal(allow.disabled, true)
  assert.equal(allow.getAttribute('title'), 'thread injoignable : à traiter sur le poste')
  assert.equal(q(node, '.perm__note').textContent, 'thread injoignable — à traiter sur le poste')
  click(allow)
  assert.equal(calls, 0, 'un bouton désactivé ne répond pas au clic')
})

test('permission sans options : la note porte le verdict', () => {
  const { node } = permRender({ options: [], pendingOptionId: 'x', resolved: true, outcome: 'selected' }, { canRespond: true })
  assert.equal(qa(node, '.perm__options button').length, 0)
  assert.equal(q(node, '.perm__note').textContent, 'réponse : selected')
})

test('permission : l’heure de la demande est affichée', () => {
  const { node } = permRender({ at: new Date(Date.now() - 60_000).toISOString() }, { canRespond: true })
  assert.match(q(node, '.perm__head .muted').textContent, /min|minute|s/)
})

test('permission sans callback : un clic ne fait rien, mais ne casse pas', () => {
  const { node } = permRender({}, { canRespond: true })
  click(qa(node, '.perm__options button')[0])
  assert.equal(node.className.includes('perm'), true)
})

// ---------------------------------------------------------------------------
// JSON brut
// ---------------------------------------------------------------------------

test('une valeur non sérialisable s’affiche quand même', () => {
  const circular = { nom: 'x' }
  circular.self = circular
  const { node } = render(entry({ type: 'raw', kind: 'zra/bizarre', payload: circular }))
  assert.match(q(node, '.raw__body').textContent, /\[object Object\]/)
  click(q(node, '.raw__head'))
  assert.equal(node.className.includes('is-open'), true)
})

test('un payload absent s’affiche « null »', () => {
  const { node } = render(entry({ type: 'raw', kind: 'zra/vide' }))
  assert.equal(q(node, '.raw__body').textContent.trim(), 'null')
})
