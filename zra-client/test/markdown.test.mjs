import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderMarkdown, inline } from '../js/markdown.js'

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
