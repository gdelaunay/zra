// Le jeu d'icônes (`js/icons.js`) et les glyphes d'agents (`js/agent-icons.js`).
//
// Les identifiants d'agents sont libres (`claude-acp`, `claude-zra`, `my-claude`…) :
// la reconnaissance se fait par motif, et un agent inconnu doit toujours donner
// une icône — jamais un trou dans la liste des threads.

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
const win = dom.window
for (const k of ['window', 'document', 'Node', 'HTMLElement']) {
  Object.defineProperty(globalThis, k, { value: win[k], configurable: true, writable: true })
}
after(() => { dom.window.close() })

const { icon, toolIcon, agentIcon, agentGlyphId, TOOL_KIND_ICON } = await import('../js/icons.js')
const { AGENT_GLYPHS } = await import('../js/agent-icons.js')

const paths = (svg) => [...svg.querySelectorAll('path')].map((p) => p.getAttribute('d'))
const SVG_NS = 'http://www.w3.org/2000/svg'

// ---------------------------------------------------------------------------
// icon()
// ---------------------------------------------------------------------------

test('icon() rend un SVG de trait, décoratif, sur grille 24', () => {
  const svg = icon('send')
  assert.equal(svg.namespaceURI, SVG_NS)
  assert.equal(svg.getAttribute('viewBox'), '0 0 24 24')
  assert.equal(svg.getAttribute('fill'), 'none')
  assert.equal(svg.getAttribute('stroke'), 'currentColor')
  assert.equal(svg.getAttribute('aria-hidden'), 'true', 'une icône ne se lit pas')
  assert.equal(svg.getAttribute('class'), 'icon')
  assert.equal(svg.children.length, 1)
  assert.ok(paths(svg)[0].length > 5)
})

test('icon() ajoute la classe demandée, sans espace de trop', () => {
  assert.equal(icon('x', 'icon--sm').getAttribute('class'), 'icon icon--sm')
  assert.equal(icon('x', '').getAttribute('class'), 'icon')
})

test('icon() inconnu : un cercle plutôt qu’un tracé vide', () => {
  const fallback = icon('cette-icone-n-existe-pas')
  assert.deepEqual(paths(fallback), paths(icon('circle')))
  assert.equal(paths(fallback)[0].length > 0, true)
})

test('deux icônes distinctes ont des tracés distincts', () => {
  assert.notDeepEqual(paths(icon('send')), paths(icon('stop')))
})

// ---------------------------------------------------------------------------
// toolIcon()
// ---------------------------------------------------------------------------

test('toolIcon() suit le `kind` du tool call ACP, comme le panel de Zed', () => {
  assert.deepEqual(paths(toolIcon('edit')), paths(icon('pencil')))
  assert.deepEqual(paths(toolIcon('execute')), paths(icon('terminal')))
  assert.deepEqual(paths(toolIcon('think')), paths(icon('lightbulb')))
  assert.equal(toolIcon('read', 'icon--sm').getAttribute('class'), 'icon icon--sm')
})

test('toolIcon() : kind inconnu ou absent → la clé à molette', () => {
  for (const kind of ['inconnu', undefined, null, '']) {
    assert.deepEqual(paths(toolIcon(kind)), paths(icon('wrench')), String(kind))
  }
})

test('TOOL_KIND_ICON couvre les kinds de l’ACP, et ne pointe que des icônes existantes', () => {
  assert.deepEqual(Object.keys(TOOL_KIND_ICON).sort(), [
    'delete', 'edit', 'execute', 'fetch', 'move', 'other', 'read', 'search', 'switch_mode', 'think',
  ])
  for (const [kind, name] of Object.entries(TOOL_KIND_ICON)) {
    assert.notDeepEqual(paths(icon(name)), paths(icon('circle')), `${kind} pointe une icône qui existe`)
  }
})

// ---------------------------------------------------------------------------
// agentGlyphId()
// ---------------------------------------------------------------------------

test('agentGlyphId() reconnaît par motif, quel que soit l’identifiant', () => {
  const cases = {
    claude: ['claude', 'claude-acp', 'claude-zra', 'my-claude', 'Claude-3.5', 'anthropic-x'],
    gemini: ['gemini', 'gemini-zra', 'google-ai'],
    openai: ['codex', 'codex-acp', 'openai', 'open-ai', 'gpt-4o', 'GPT'],
    xai: ['grok', 'xai', 'x-ai'],
    mistral: ['mistral', 'codestral'],
    opencode: ['opencode', 'open-code'],
    zed: ['zed', 'zeta', 'zed-agent'],
  }
  for (const [glyph, ids] of Object.entries(cases)) {
    for (const id of ids) assert.equal(agentGlyphId(id), glyph, id)
  }
})

test('agentGlyphId() : agent inconnu ou absent → null', () => {
  for (const id of ['mon-agent', '', null, undefined, 'acme-bot']) {
    assert.equal(agentGlyphId(id), null, String(id))
  }
})

test('agentGlyphId() : « zed » n’est reconnu qu’en début d’identifiant', () => {
  assert.equal(agentGlyphId('zed'), 'zed')
  assert.equal(agentGlyphId('mon-zed'), null, 'pas d’ancrage : pas de faux positif')
})

test('chaque glyphe atteint par un motif existe dans le fichier généré', () => {
  const ids = ['claude-acp', 'gemini-zra', 'codex-acp', 'grok', 'mistral', 'opencode', 'zed']
  for (const id of ids) {
    const glyph = agentGlyphId(id)
    assert.ok(AGENT_GLYPHS[glyph], `${id} → ${glyph} doit exister dans agent-icons.js`)
    assert.ok(Array.isArray(AGENT_GLYPHS[glyph].shapes) && AGENT_GLYPHS[glyph].shapes.length > 0, glyph)
    assert.match(AGENT_GLYPHS[glyph].viewBox, /^0 0 \d+ \d+$/, glyph)
  }
})

// ---------------------------------------------------------------------------
// agentIcon()
// ---------------------------------------------------------------------------

test('agentIcon() dessine le glyphe de la marque, en monochrome', () => {
  const svg = agentIcon('claude-zra', 'thread-row__agent icon--sm')
  assert.equal(svg.namespaceURI, SVG_NS)
  assert.equal(svg.getAttribute('viewBox'), AGENT_GLYPHS.claude.viewBox)
  assert.equal(svg.getAttribute('fill'), 'currentColor')
  assert.equal(svg.getAttribute('aria-hidden'), 'true')
  assert.equal(svg.getAttribute('class'), 'icon thread-row__agent icon--sm')
  assert.equal(svg.children.length, AGENT_GLYPHS.claude.shapes.length)
})

test('agentIcon() : agent inconnu → l’icône générique, jamais rien', () => {
  const fallback = agentIcon('mon-agent-maison')
  assert.equal(fallback.getAttribute('viewBox'), '0 0 24 24', 'c’est un `icon()`, pas un glyphe')
  assert.deepEqual(paths(fallback), paths(icon('sparkles')))
  assert.deepEqual(agentIcon(null).getAttribute('class'), 'icon')
  assert.deepEqual(paths(agentIcon(undefined)), paths(icon('sparkles')))
})

test('agentIcon() rend les formes rect comme des <rect> (Mistral)', () => {
  const svg = agentIcon('mistral-zra')
  const glyph = AGENT_GLYPHS.mistral
  const rects = [...svg.querySelectorAll('rect')]
  assert.equal(rects.length, glyph.shapes.filter((s) => s.rect).length)
  assert.ok(rects.length > 0, 'la fixture a bien des rectangles')
  const [first] = glyph.shapes.filter((s) => s.rect)
  assert.equal(rects[0].getAttribute('x'), String(first.rect[0]))
  assert.equal(rects[0].getAttribute('height'), String(first.rect[3]))
})

test('agentIcon() reporte le fill-rule quand le glyphe en porte un', () => {
  const withRule = Object.entries(AGENT_GLYPHS).find(([, g]) => g.shapes.some((s) => s.rule))
  assert.ok(withRule, 'au moins un glyphe porte une règle de remplissage')
  const [id, glyph] = withRule
  const svg = agentIcon(id)
  const expected = glyph.shapes.filter((s) => s.rule).length
  const got = [...svg.querySelectorAll('path')].filter((p) => p.getAttribute('fill-rule')).length
  assert.equal(got, expected)
})

test('chaque glyphe du fichier généré se dessine sans erreur', () => {
  for (const id of Object.keys(AGENT_GLYPHS)) {
    const svg = agentIcon(id)
    assert.equal(svg.tagName, 'svg', id)
    assert.ok(svg.children.length > 0, id)
  }
})
