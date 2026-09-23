import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderMarkdown, markdownBlocks, inline } from '../js/markdown.js'

test('titres, paragraphes et listes', () => {
  const html = renderMarkdown('# Titre\n\ntexte\n\n- a\n- b\n')
  assert.match(html, /<h1>Titre<\/h1>/)
  assert.match(html, /<p>texte<\/p>/)
  assert.match(html, /<ul><li>a<\/li><li>b<\/li><\/ul>/)
})

test('liste ordonnée', () => {
  assert.match(renderMarkdown('1. un\n2. deux\n'), /<ol><li>un<\/li><li>deux<\/li><\/ol>/)
})

test('bloc de code fermé', () => {
  const html = renderMarkdown('```js\nconst a = 1\n```')
  assert.match(html, /<pre><code class="language-js">/)
  assert.doesNotMatch(html, /data-streaming/)
})

test('bloc de code non refermé : rendu quand même (flux en cours)', () => {
  const html = renderMarkdown('```js\nconst a = 1\n')
  assert.match(html, /data-streaming="1"/)
  assert.match(html, /const/)
})

test('le HTML est échappé', () => {
  const html = renderMarkdown('<img src=x onerror=alert(1)>')
  assert.doesNotMatch(html, /<img/)
  assert.match(html, /&lt;img/)
})

test('code inline échappé, hors markdown', () => {
  const html = inline('voir `a < b && *gras*`')
  assert.match(html, /<code>a &lt; b &amp;&amp; \*gras\*<\/code>/)
})

test('liens : schéma sûr accepté, javascript: refusé', () => {
  assert.match(inline('[zed](https://zed.dev)'), /<a href="https:\/\/zed.dev"/)
  const bad = inline('[x](javascript:alert(1))')
  assert.doesNotMatch(bad, /<a /)
})

test('gras et italique', () => {
  assert.match(inline('**gras** et *ital*'), /<strong>gras<\/strong> et <em>ital<\/em>/)
})

test('citation et règle horizontale', () => {
  const html = renderMarkdown('> cité\n\n---\n')
  assert.match(html, /<blockquote>/)
  assert.match(html, /<hr>/)
})

test('tableau', () => {
  const html = renderMarkdown('| a | b |\n|---|---|\n| 1 | 2 |\n')
  assert.match(html, /<table>/)
  assert.match(html, /<th>a<\/th>/)
  assert.match(html, /<td>2<\/td>/)
})

test('curseur de frappe optionnel', () => {
  assert.match(renderMarkdown('hop', { cursor: true }), /<span class="cursor"><\/span>$/)
})

test('rendu incrémental : un préfixe ne casse jamais', () => {
  const full = '# T\n\ntexte **gras** et `code`\n\n```js\nconst a = 1\n```\n- item\n'
  for (let i = 1; i <= full.length; i++) {
    assert.doesNotThrow(() => renderMarkdown(full.slice(0, i)), `préfixe de ${i} caractères`)
  }
})

test('bloc de code : les chaînes survivent à la coloration des nombres (test réel, Read de package.json)', () => {
  const html = renderMarkdown('```\n1\t{\n2\t  "name": "zra",\n3\t  "private": true,\n4\t  "n": 12\n```')
  assert.match(html, /&quot;name&quot;/)
  assert.match(html, /&quot;zra&quot;/)
  assert.doesNotMatch(html, /\u0001/)
  assert.match(html, /<span class="tok-num">12<\/span>/)
})

test('rendu par blocs : un élément par bloc de premier niveau, même HTML au total', () => {
  const src = '# Titre\n\nUn paragraphe.\n\n- a\n- b\n\n```js\nconst x = 1\n```\n\nFin'
  const blocks = markdownBlocks(src)
  assert.equal(blocks.length, 5)
  assert.equal(blocks.join(''), renderMarkdown(src))
  // En streaming, écrire la suite ne change que le dernier bloc.
  const next = markdownBlocks(src + ' du message')
  assert.deepEqual(next.slice(0, 4), blocks.slice(0, 4))
  assert.notEqual(next[4], blocks[4])
})
