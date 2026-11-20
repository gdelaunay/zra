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

const { renderEntry, blocksPieces, blocksHtml, textLength, revealBlocks, messageBody, planPanel } = await import('../js/views/entry.js')
const { Timeline } = await import('../js/acp.js')
const { settings } = await import('../js/settings.js')

// `.click()` natif : comme dans un navigateur, un bouton `disabled` ne réagit pas.
const click = (el) => el.click()
const entry = (over = {}) => ({ id: 'e1', rev: 0, at: Date.now(), ...over })
const text = (t) => ({ type: 'text', text: t })
/** Monte une entrée dans un conteneur et rend les deux. `node` = l'enveloppe
 * centrée (entry-wrap), `inner` = le composant. */
function render(e, ctx = {}) {
  const root = dom.window.document.createElement('div')
  const node = renderEntry(e, ctx)
  root.append(node)
  return { root, node, inner: node.firstElementChild }
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
  const { inner } = render(entry({ type: 'zra/mystère', payload: { a: 1 } }))
  assert.equal(inner.classList.contains('raw'), true)
  assert.match(q(inner, '.raw__head').textContent, /événement non reconnu : zra\/mystère/)
  assert.match(q(inner, '.raw__body').textContent, /"a": 1/)
})

test('un notice devient une ligne de système, avertie si level=warn', () => {
  const info = render(entry({ type: 'notice', text: 'tour interrompu', level: 'info' })).inner
  assert.equal(info.className.includes('sysline'), true)
  assert.equal(info.className.includes('warn'), false)
  assert.equal(info.textContent, 'tour interrompu')

  const warn = render(entry({ type: 'notice', text: 'shim parti', level: 'warn' })).inner
  assert.equal(warn.className.includes('warn'), true)
})

// ---------------------------------------------------------------------------
// Messages utilisateur et agent
// ---------------------------------------------------------------------------

test('message utilisateur : bulle texte brut (éditeur Zed), sans en-tête', () => {
  const { node, inner } = render(entry({ type: 'user', blocks: [text('bonjour **toi**')] }))
  assert.equal(inner.classList.contains('user-msg'), true)
  assert.equal(node.querySelector('.msg__status'), null)
  // Comme Zed : le message utilisateur est un buffer, pas du markdown.
  assert.equal(q(inner, '.bubble').textContent, 'bonjour **toi**')
  assert.equal(q(inner, '.bubble strong'), null)
})

test('message en attente est estompé, message non envoyé le dit', () => {
  const pending = render(entry({ type: 'user', pending: true, blocks: [text('x')] })).inner
  assert.equal(pending.className.includes('is-pending'), true)

  const failed = render(entry({ type: 'user', failed: true, blocks: [text('x')] })).inner
  assert.equal(failed.className.includes('is-failed'), true)
  assert.equal(q(failed, '.msg__status').textContent, 'non envoyé')
})

test('message agent : pas de curseur de frappe (absent du panel agent de Zed)', () => {
  const blocks = [text('en train')]
  assert.equal(q(render(entry({ type: 'agent', blocks }), { busy: true, isLast: true }).node, '.cursor'), null)
})

test('messageBody() retrouve le corps écrit par le streaming, pour chaque forme', () => {
  const agent = render(entry({ type: 'agent', blocks: [text('a')] })).node
  assert.equal(messageBody(agent).className, 'msg__body md')
  const user = render(entry({ type: 'user', blocks: [text('a')] })).node
  assert.equal(messageBody(user), null, 'la bulle utilisateur est du texte brut, pas un corps streamé')
  const thought = render(entry({ type: 'thought', blocks: [text('a')] })).node
  assert.equal(messageBody(thought).className, 'md')
  const tool = render(entry({ type: 'tool', status: 'completed', kind: 'read', content: [{ type: 'content', content: text('a') }] })).node
  assert.equal(messageBody(tool), null, 'un tool call n’est pas un corps streamé')
})

// ---------------------------------------------------------------------------
// Réflexion
// ---------------------------------------------------------------------------

test('réflexion : dépliée pendant son écriture, repliée ensuite (Zed), le choix survit au re-rendu', () => {
  const e = entry({ type: 'thought', blocks: [text('je réfléchis')] })
  assert.equal(render(e).inner.className.includes('is-open'), false, 'écrite : repliée')
  const open = render(e, { busy: true, isLast: true }).inner
  assert.equal(open.className.includes('is-open'), true, 'en cours d’écriture : dépliée')
  assert.ok(!q(open, '.thought__body').classList.contains('streaming'), 'hauteur libre pendant l’écriture (défaut Zed « auto »)')
  assert.equal(q(open, '.thought__head').getAttribute('aria-expanded'), 'true')

  click(q(open, '.thought__head'))
  assert.equal(open.className.includes('is-open'), false)
  assert.equal(q(open, '.thought__head').getAttribute('aria-expanded'), 'false')
  assert.equal(e.open, false, 'le choix est écrit sur l’entrée')

  const again = render(e).inner
  assert.equal(again.className.includes('is-open'), false, 'un re-rendu respecte le choix')
  click(q(again, '.thought__head'))
  assert.equal(e.open, true)
})

test('réflexion : alwaysShowThoughts laisse déplié ; entry.open a priorité', () => {
  const before = settings.alwaysShowThoughts
  settings.alwaysShowThoughts = true
  try {
    assert.equal(render(entry({ type: 'thought', blocks: [text('x')] })).inner.className.includes('is-open'), true)
    const forced = render(entry({ type: 'thought', open: false, blocks: [text('x')] })).inner
    assert.equal(forced.className.includes('is-open'), false, 'entry.open a priorité')
  } finally {
    settings.alwaysShowThoughts = before
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

test('blocksPieces() ne produit pas de curseur de frappe', () => {
  assert.deepEqual(blocksPieces([text('x')]), ['<p>x</p>'])
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
  assert.equal(pieces[5], '<div class="codeblock"><pre><code>contenu</code></pre></div>')
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
    ['<div class="codeblock"><pre class="muted"><code>{\n  &quot;type&quot;: &quot;nouveau&quot;,\n  &quot;x&quot;: 1\n}</code></pre></div>'])
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
  const { inner } = render(tool())
  assert.equal(inner.className.includes('tool--completed'), true)
  assert.ok(q(inner, '.tool-label svg'), 'l’icône du kind est là')
  assert.equal(q(inner, '.tool-label code').textContent, 'app.js', 'les backticks deviennent du code')
})

test('tool call : chaque statut a sa marque (Zed : échec seul, en croix)', () => {
  for (const status of ['pending', 'in_progress', 'completed', 'failed', 'inconnu']) {
    const { inner } = render(tool({ status }))
    assert.equal(inner.className.includes(`tool--${status}`), true, status)
    assert.equal(Boolean(q(inner, '.tool__status')), status === 'failed', status)
    assert.equal(inner.className.includes('failed'), status === 'failed', 'bordure pointillés si échec')
  }
})

test('tool call : le titre est échappé', () => {
  const { node } = render(tool({ title: '<script>alert(1)</script> `x`' }))
  assert.equal(node.querySelector('script'), null)
  assert.equal(q(node, '.tool-label .md').innerHTML.includes('&lt;script&gt;'), true)
})

test('tool call : replié/déplié selon le réglage, choix conservé sur l’entrée', () => {
  const e = tool({ open: false })
  const { inner } = render(e)
  assert.equal(inner.className.includes('is-open'), false, 'expandTools vaut false par défaut')
  click(q(inner, '.tool-head'))
  assert.equal(inner.className.includes('is-open'), true)
  assert.equal(e.open, true)

  const closedByDefault = render(tool()).inner
  assert.equal(closedByDefault.className.includes('is-open'), false, 'expandTools vaut false par défaut')

  const before = settings.expandTools
  settings.expandTools = true
  try {
    assert.equal(render(tool()).inner.className.includes('is-open'), true, 'le réglage déplie')
  } finally {
    settings.expandTools = before
  }
})

test('tool call : diff, terminal et autorisation en attente dépliés d’office (comme Zed)', () => {
  const diff = tool({ content: [{ type: 'diff', path: 'a.js', oldText: 'a', newText: 'b' }] })
  assert.equal(render(diff).inner.className.includes('is-open'), true)
  const term = tool({ content: [{ type: 'terminal', terminalId: 't' }] })
  assert.equal(render(term).inner.className.includes('is-open'), true)
  const waiting = tool({ toolCallId: 'tc-9' })
  const timeline = { pendingPermissions: () => [{ toolCall: { toolCallId: 'tc-9' } }], terminals: new Map() }
  assert.equal(render(waiting, { timeline }).inner.className.includes('is-open'), true)
})

test('tool call simple : emplacements, sortie, et le brut en en-têtes mono', () => {
  const { node } = render(tool({
    kind: 'read',
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
  assert.deepEqual(qa(node, '.io-header').map((n) => n.textContent), ['entrée brute', 'sortie brute'])
  assert.match(node.textContent, /"path": "app.js"/)
})

test('tool call carte : le brut est repliable (View Raw Input)', () => {
  const { node } = render(tool({ rawInput: { path: 'app.js' } }))
  const raw = q(node, '.raw-input')
  assert.ok(raw, 'une carte porte son entrée brute repliable')
  assert.match(q(raw, '.io-header').textContent, /entrée brute/)
  click(q(raw, '.ri-toggle'))
  assert.equal(raw.className.includes('is-open'), true)
})

test('tool call sans sortie : « en attente… » tant que pending, « aucune sortie » sinon', () => {
  assert.match(render(tool({ status: 'pending', content: [] })).node.textContent, /en attente…/)
  assert.match(render(tool({ status: 'completed', content: [] })).node.textContent, /aucune sortie/)
  assert.match(render(tool({ content: null, locations: null })).node.textContent, /aucune sortie/)
})

test('tool call : un diff est rendu sans gouttière, avec ses compteurs en tête', () => {
  const { node } = render(tool({
    content: [{ type: 'diff', path: 'C:/proj/zra/app.js', oldText: 'a\nb\nc\n', newText: 'a\nB\nc\nd\n' }],
  }))
  const diff = q(node, '.diff')
  assert.equal(q(node, '.diffstat .add').textContent, '+2')
  assert.equal(q(node, '.diffstat .del').textContent, '−1')
  assert.ok(q(diff, '.ln.add'), 'lignes ajoutées')
  assert.ok(q(diff, '.ln.del'), 'lignes supprimées')
  assert.equal(q(diff, '.diff__num'), null, 'pas de gouttière, comme Zed')
})

test('tool call : un diff trop gros pour être aligné le dit, au lieu de calculer', () => {
  // Au-delà de 4 M de cellules, `lineDiff` renonce à l'alignement (garde-fou de
  // `js/diff.js`) : tout est rendu comme supprimé puis ajouté, et le diff l'écrit.
  const n = 2100
  const oldText = Array.from({ length: n }, (_, i) => `avant ${i}`).join('\n')
  const newText = Array.from({ length: n }, (_, i) => `après ${i}`).join('\n')
  const { node } = render(tool({ content: [{ type: 'diff', path: 'big.txt', oldText, newText }] }))
  assert.match(node.textContent, /fichier trop gros : diff non aligné/)
  assert.equal(q(node, '.diffstat .add').textContent, `+${n}`)
  assert.equal(q(node, '.diffstat .del').textContent, `−${n}`)
})

test('tool call : un long diff non modifié est replié en lignes sautées', () => {
  const unchanged = Array.from({ length: 40 }, (_, i) => `ligne ${i}`).join('\n')
  const { node } = render(tool({
    content: [{ type: 'diff', path: 'a.txt', oldText: unchanged, newText: `${unchanged}\nadded` }],
  }))
  assert.match(q(node, '.diff').textContent, /lignes inchangées/)
  assert.ok(qa(node, '.diff .ln').length < 45, 'tout le contexte n’est pas rendu')
})

test('tool call : terminal en cours, réussi, en échec, interrompu, et inconnu', () => {
  const timeline = { terminals: new Map() }
  const block = [{ type: 'terminal', terminalId: 'term-1' }]

  const running = render(tool({ content: block }), { timeline }).node
  assert.ok(q(running, '.term-row svg.spin'), 'un terminal sans statut de sortie tourne encore')
  assert.equal(q(running, '.term-body').textContent, '')

  timeline.terminals.set('term-1', { output: 'bonjour\n', exitStatus: { exitCode: 0 } })
  const ok = render(tool({ content: block }), { timeline }).node
  assert.equal(q(ok, '.term-row svg.spin'), null, 'fini : plus de spinner')
  assert.equal(q(ok, '.term__failed'), null, 'succès : pas de croix, pas de texte « exit 0 »')
  assert.equal(q(ok, '.term-body').textContent, 'bonjour\n')

  timeline.terminals.set('term-1', { output: 'raté', exitStatus: { exitCode: 2 } })
  const ko = render(tool({ content: block }), { timeline }).node
  assert.ok(q(ko, '.term__failed'), 'échec : croix rouge')
  assert.equal(q(ko, '.term__failed').getAttribute('title'), 'code de sortie 2', 'le code en infobulle, comme Zed')

  timeline.terminals.set('term-1', { output: '', exitStatus: { exitCode: null, signal: 'SIGINT' } })
  const sig = render(tool({ content: block }), { timeline }).node
  assert.ok(q(sig, '.term__failed'), 'un signal est un échec, même sans code')
  assert.equal(q(sig, '.term__failed').getAttribute('title'), 'interrompu par un signal')

  const orphan = render(tool({ content: [{ type: 'terminal', terminalId: 'autre' }] }), { timeline }).node
  assert.ok(q(orphan, '.term-row svg.spin'), 'terminal jamais vu : toujours en cours')
})

test('tool call : terminal — cwd de l’agent, sinon le projet, sinon générique', () => {
  const block = [{ type: 'terminal', terminalId: 't' }]
  const timeline = { terminals: new Map([['t', { output: '', exitStatus: null, cwd: '/home/user/projet' }]]) }
  const withCwd = render(tool({ content: block }), { timeline, folderPaths: ['/autre'] }).node
  assert.equal(q(withCwd, '.cwd').textContent, '/home/user/projet', 'le cwd de l’agent prime (pi-acp)')

  timeline.terminals.set('t', { output: '', exitStatus: null, cwd: null })
  const withProject = render(tool({ content: block }), { timeline, folderPaths: ['C:\\Users\\Goulwen\\Documents\\Dev\\zra'] }).node
  assert.equal(q(withProject, '.cwd').textContent, 'C:\\Users\\Goulwen\\Documents\\Dev\\zra', 'claude-agent-acp : le projet du thread')

  const generic = render(tool({ content: block }), { timeline }).node
  assert.equal(q(generic, '.cwd').textContent, 'répertoire courant', 'le repli de Zed')
})

test('tool call : terminal — durée figée à la fin, live en cours, rien sous 10 s', () => {
  const block = [{ type: 'terminal', terminalId: 't' }]
  const timeline = { terminals: new Map([['t', {
    output: '', exitStatus: { exitCode: 0 },
    startedAt: '2026-01-01T00:00:00.000Z', endedAt: '2026-01-01T00:01:11.000Z',
  }]]) }
  const done = render(tool({ content: block }), { timeline }).node
  assert.equal(q(done, '.term__elapsed').textContent, '(1m 11s)')
  assert.equal(q(done, '.term__elapsed').hasAttribute('data-started'), false, 'finie : figée')

  timeline.terminals.set('t', { output: '', exitStatus: { exitCode: 0 }, startedAt: '2026-01-01T00:00:00.000Z', endedAt: '2026-01-01T00:00:05.000Z' })
  const short = render(tool({ content: block }), { timeline }).node
  assert.equal(q(short, '.term__elapsed').textContent, '', 'sous 10 s : rien, comme Zed')

  timeline.terminals.set('t', { output: '', exitStatus: null, startedAt: new Date(Date.now() - 71_000).toISOString(), endedAt: null })
  const running = render(tool({ content: block }), { timeline }).node
  assert.ok(q(running, '.term__elapsed').hasAttribute('data-started'), 'en cours : vit via le ticker du tour')
  assert.match(q(running, '.term__elapsed').textContent, /^\(1m \d+s\)$/)
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

test('plan : pas dans le fil, comme Zed (au-dessus du composer)', () => {
  const { node } = render(entry({ type: 'plan', items: [{ content: 'fait', status: 'completed' }] }))
  assert.ok(q(node, '.entry--placeholder'))
  assert.equal(q(node, '.plan'), null)
})

test('plan : résumé sur l’étape en cours, liste dépliée à la demande', () => {
  let toggled = 0
  const plan = entry({ type: 'plan', items: [{ content: 'fait', status: 'completed' }, { content: 'en cours', status: 'in_progress' }] })
  const closed = planPanel(plan, { onToggle: () => toggled++ })
  assert.match(q(closed, '.act-summary').textContent, /en cours/)
  assert.equal(q(closed, '.plan-list'), null, 'replié par défaut, comme Zed')
  assert.doesNotMatch(closed.textContent, /null/, 'rien d’autre que le résumé')
  click(q(closed, '.act-summary'))
  assert.equal(toggled, 1)
})

test('plan : progression, statut de chaque étape, priorité haute', () => {
  const node = planPanel(entry({
    type: 'plan',
    items: [
      { content: 'fait', status: 'completed' },
      { content: 'en cours', status: 'in_progress', priority: 'high' },
      { content: 'à venir', status: 'pending' },
      { content: 'sans statut' },
    ],
  }), { open: true })
  assert.equal(q(node, '.plan-left').textContent, '1/4')
  const items = qa(node, '.plan-row')
  assert.deepEqual(items.map((li) => li.className.match(/plan-row--(\w+)/)[1]),
    ['completed', 'in_progress', 'pending', 'pending'])
  assert.equal(qa(node, '.plan__prio').length, 1)
  assert.equal(qa(node, '.plan__prio')[0].textContent, '!')
  assert.ok(q(items[1], 'svg.spin'), 'l’étape en cours tourne')
  assert.deepEqual(items.map((li) => li.textContent.replace(/!$/, '')), ['fait', 'en cours', 'à venir', 'sans statut'])
})

test('plan vide : 0/0, pas d’erreur', () => {
  const node = planPanel(entry({ type: 'plan', items: [] }), { open: true })
  assert.equal(q(node, '.plan-left').textContent, '0/0')
  assert.equal(qa(node, '.plan-row').length, 0)
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

test('permission ouverte et répondable : deux options actives, refus en rouge', () => {
  const calls = []
  const { node } = permRender({}, { canRespond: true, onPermission: (entryArg, o) => calls.push([entryArg, o.optionId]) })
  const [allow, reject] = qa(node, '.perm button')
  assert.equal(allow.textContent, 'Autoriser')
  assert.equal(allow.disabled, false)
  // Comme Zed : icône colorée (coche verte / croix rouge), bouton fantôme.
  assert.equal(q(reject, 'svg').style.color, 'var(--error)')
  assert.equal(q(allow, 'svg').style.color, 'var(--success)')
  assert.equal(q(node, '.perm__note'), null, 'aucune note tant que rien n’est tranché')
  assert.equal(q(node, '.md code').textContent, 'app.js')

  click(allow)
  assert.equal(calls.length, 1)
  assert.equal(calls[0][1], 'allow')
  assert.equal(calls[0][0].requestId, 'r1', 'le callback reçoit l’entrée entière')
})

test('permission en cours d’envoi : l’option choisie tourne, tout est verrouillé', () => {
  const { node } = permRender({ pendingOptionId: 'allow' }, { canRespond: true })
  const [allow, reject] = qa(node, '.perm button')
  assert.ok(q(allow, 'svg.spin'), 'spinner sur l’option envoyée')
  assert.equal(allow.disabled, true, 'on ne renvoie pas une réponse déjà en vol')
  assert.equal(reject.disabled, true, 'on ne change plus d’avis')
  assert.equal(q(node, '.perm__note'), null)
})

test('permission tranchée : coche sur l’option, encart clos, plus rien de cliquable', () => {
  const { inner } = permRender({ pendingOptionId: 'allow', resolved: true, outcome: 'allow' }, { canRespond: true })
  assert.equal(inner.className.includes('perm-card--done'), true)
  const [allow, reject] = qa(inner, '.perm button')
  assert.ok(q(allow, 'svg'), 'la coche marque l’option choisie')
  assert.equal(allow.disabled, true)
  assert.equal(reject.disabled, true, 'changer d’avis n’est plus possible')
  assert.equal(q(inner, '.perm__note'), null, 'la réponse se lit sur l’option')
})

// L'option choisie d'un encart tranché restait cliquable (`disabled: locked &&
// !chosen`) et un second appui renvoyait une écriture que le daemon refusait en
// `permission_expired`. Verrouillé = tout le monde muet.
test('une permission tranchée ne se rejoue pas, même sur l’option choisie', () => {
  let calls = 0
  const { node } = permRender({ pendingOptionId: 'allow', resolved: true, outcome: 'allow' },
    { canRespond: true, onPermission: () => { calls++ } })
  const allow = qa(node, '.perm button')[0]
  assert.equal(allow.disabled, true)
  click(allow)
  assert.equal(calls, 0, 'un bouton désactivé ne répond pas au clic')
})

test('permission tranchée par une option absente : la note donne le verdict', () => {
  const { node } = permRender({ pendingOptionId: 'autre', resolved: true, outcome: 'cancelled' }, { canRespond: true })
  assert.equal(q(node, '.perm__note').textContent, 'réponse : cancelled')
  assert.deepEqual(qa(node, '.perm button').map((b) => b.disabled), [true, true])
})

test('permission sur thread injoignable : lecture seule et note explicite', () => {
  let calls = 0
  const { node } = permRender({}, { canRespond: false, onPermission: () => { calls++ } })
  const [allow] = qa(node, '.perm button')
  assert.equal(allow.disabled, true)
  assert.equal(allow.getAttribute('title'), 'thread injoignable : à traiter sur le poste')
  assert.equal(q(node, '.perm__note').textContent, 'thread injoignable — à traiter sur le poste')
  click(allow)
  assert.equal(calls, 0, 'un bouton désactivé ne répond pas au clic')
})

test('permission sans options : la note porte le verdict', () => {
  const { node } = permRender({ options: [], pendingOptionId: 'x', resolved: true, outcome: 'selected' }, { canRespond: true })
  assert.equal(qa(node, '.perm button').length, 0)
  assert.equal(q(node, '.perm__note').textContent, 'réponse : selected')
})

test('permission : l’heure de la demande est affichée', () => {
  const { node } = permRender({ at: new Date(Date.now() - 60_000).toISOString() }, { canRespond: true })
  assert.match(q(node, '.perm-card__head .muted').textContent, /min|minute|s/)
})

test('permission sans callback : un clic ne fait rien, mais ne casse pas', () => {
  const { inner } = permRender({}, { canRespond: true })
  click(qa(inner, '.perm button')[0])
  assert.equal(inner.className.includes('perm-card'), true)
})

// ---------------------------------------------------------------------------
// JSON brut
// ---------------------------------------------------------------------------

test('une valeur non sérialisable s’affiche quand même', () => {
  const circular = { nom: 'x' }
  circular.self = circular
  const { node, inner } = render(entry({ type: 'raw', kind: 'zra/bizarre', payload: circular }))
  assert.match(q(node, '.raw__body').textContent, /\[object Object\]/)
  click(q(node, '.raw__head'))
  assert.equal(inner.className.includes('is-open'), true)
})

test('un payload absent s’affiche « null »', () => {
  const { node } = render(entry({ type: 'raw', kind: 'zra/vide' }))
  assert.equal(q(node, '.raw__body').textContent.trim(), 'null')
})

// ---------------------------------------------------------------------------
// Permission dans son tool call (Zed : `render_permission_buttons`)
// ---------------------------------------------------------------------------

test('permission rattachée à un tool call : boutons au pied de sa carte, rien à part dans le fil', () => {
  const tl = new Timeline()
  tl.apply({ requestId: 'p1', toolCall: { toolCallId: 't1', title: 'rm -rf', kind: 'execute' }, options: OPTIONS })
  assert.deepEqual(tl.entries.map((e) => e.type), ['tool', 'permission'], 'le tool call est créé, comme Zed')
  const [tool, perm] = tl.entries
  const ctx = { timeline: tl, canRespond: true }
  assert.ok(render(perm, ctx).node.querySelector('.entry--placeholder'))
  const card = render(tool, ctx).node
  assert.deepEqual(qa(card, '.perm button').map((b) => b.textContent), ['Autoriser', 'Refuser'])
  assert.ok(card.querySelector('.tool').classList.contains('is-open'), 'une carte en attente est dépliée')

  tl.resolvePermission('p1', { optionId: 'allow', by: 'mobile' })
  assert.equal(q(render(tool, ctx).node, '.perm'), null, 'tranchée : les boutons disparaissent')
})

test('permission : un tool call déjà connu est mis à jour, pas dupliqué', () => {
  const tl = new Timeline()
  tl.apply({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'avant', kind: 'edit', status: 'pending' })
  tl.apply({ requestId: 'p1', toolCall: { toolCallId: 't1', title: 'après' }, options: OPTIONS })
  assert.deepEqual(tl.entries.map((e) => e.type), ['tool', 'permission'])
  assert.equal(tl.entries[0].title, 'après')
})


// ---------------------------------------------------------------------------
// Question de l'agent (Zed : `ElicitationCard`)
// ---------------------------------------------------------------------------

const question = (over = {}) => entry({
  type: 'elicitation', requestId: 'number:3', message: 'Quel framework ?', values: {}, resolved: false,
  schema: {
    type: 'object', required: ['question_0'],
    properties: {
      question_0: { type: 'string', title: 'Framework', oneOf: [{ const: 'React', title: 'React' }, { const: 'Vue', title: 'Vue', description: 'plus léger' }] },
      question_1: { type: 'array', title: 'Outils', items: { anyOf: [{ const: 'vite', title: 'Vite' }, { const: 'jest', title: 'Jest' }] } },
      question_0_custom: { type: 'string', title: 'Other' },
      ok: { type: 'boolean', title: 'Confirmer' },
    },
  },
  ...over,
})

test('question : choix unique, multiple, texte libre et case, avec Envoyer, Refuser, Annuler', () => {
  const calls = []
  const { node } = render(question(), { canRespond: true, agentName: 'Claude', onElicitation: (e, action, content) => calls.push([action, content]) })
  assert.match(q(node, '.elicit__head').textContent, /Saisie demandée par Claude/)
  assert.equal(qa(node, 'input[type=radio]').length, 2)
  assert.equal(qa(node, 'input[type=checkbox]').length, 3, 'deux choix multiples et la case')
  assert.equal(qa(node, 'input[type=text]').length, 1)
  assert.deepEqual(qa(node, '.elicit__actions button').map((b) => b.textContent), ['Envoyer', 'Refuser', 'Annuler'])

  // Requis non rempli : rien ne part, l'erreur s'affiche.
  click(qa(node, '.elicit__actions button')[0])
  assert.deepEqual(calls, [])
  assert.match(q(node, '.elicit__error:not(.hidden)').textContent, /requise/)

  const change = (el, prop, v) => { el[prop] = v; el.dispatchEvent(new dom.window.Event(prop === 'value' ? 'input' : 'change')) }
  change(qa(node, 'input[type=radio]')[1], 'checked', true)
  change(qa(node, 'input[type=checkbox]')[0], 'checked', true)
  change(q(node, 'input[type=text]'), 'value', 'avec Pinia')
  click(qa(node, '.elicit__actions button')[0])
  assert.deepEqual(calls, [['accept', { question_0: 'Vue', question_1: ['vite'], question_0_custom: 'avec Pinia' }]])

  click(qa(node, '.elicit__actions button')[1])
  assert.deepEqual(calls.at(-1), ['decline', undefined])
})

test('question en cours d’envoi ou thread injoignable : tout est verrouillé', () => {
  const sending = render(question({ pendingAction: 'decline' }), { canRespond: true }).node
  assert.ok(qa(sending, '.elicit__actions button').every((b) => b.disabled))
  assert.ok(q(qa(sending, '.elicit__actions button')[1], '.spin'), 'le choix envoyé tourne')
  const offline = render(question(), { canRespond: false }).node
  assert.ok(qa(offline, 'input').every((i) => i.disabled))
  assert.match(offline.textContent, /injoignable/)
})

test('question répondue : elle quitte le fil, comme dans Zed', () => {
  const { node } = render(question({ resolved: true, action: 'accept' }))
  assert.ok(q(node, '.entry--placeholder'))
})

test('lien à ouvrir : destination et adresse, « Ouvrir » grisé, Refuser et Annuler actifs', () => {
  const calls = []
  const { node } = render(question({ mode: 'url', url: 'https://xn--exmple-cua.test/login?x=1', schema: {} }), {
    canRespond: true, onElicitation: (e, action) => calls.push(action),
  })
  assert.match(q(node, '.elicit__url').textContent, /Destination xn--exmple-cua\.test/)
  assert.match(q(node, '.elicit__link').textContent, /login\?x=1/)
  assert.ok(q(node, '.elicit__warn'), 'domaine internationalisé signalé, comme Zed')
  assert.equal(qa(node, 'input').length, 0, 'aucun champ')
  assert.match(node.textContent, /sur le poste/)
  const [open, decline, cancel] = qa(node, '.elicit__actions button')
  assert.match(open.textContent, /Ouvrir/)
  assert.equal(open.disabled, true)
  click(decline)
  click(cancel)
  assert.deepEqual(calls, ['decline', 'cancel'])
})
