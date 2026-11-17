// Markdown minimal, tolérant au flux (un bloc de code non refermé se rend quand même).
// Sortie HTML échappée : le texte de l'agent n'est jamais injecté brut.
//
// Les liens sont extraits par jetons en une seule passe linéaire, avant les
// passes d'emphase : du HTML déjà produit n'est jamais réanalysé (une passe
// pouvait sinon injecter des attributs dans un href), et un texte hostile
// (des `[a](` non refermés par milliers) ne provoque plus de retour arrière
// catastrophique. Chaque bloc est borné : un journal ou un fichier minifié
// ne gèle pas le rendu.

import { escapeHtml } from './dom.js'
import { tr } from './i18n.js'

const SAFE_URL = /^(https?:|mailto:|tel:|#|\/|\.\/|\.\.\/)/i

/** Garde-fou de rendu : au-delà, le bloc est tronqué (journal, fichier minifié). */
const MAX_BLOCK = 100_000
/** Bornes d'un lien : texte et URL démesurés ne sont pas des liens. */
const MAX_LINK_TEXT = 1_000
const MAX_LINK_URL = 4_096

function bounded(text) {
  return text.length > MAX_BLOCK ? text.slice(0, MAX_BLOCK) + tr`\n…(bloc tronqué)` : text
}

/**
 * @param {string} src
 * @param {{cursor?: boolean}} [opts] cursor: ajoute un curseur de frappe en fin de flux.
 */
export function renderMarkdown(src, opts = {}) {
  let html = markdownBlocks(src).join('')
  if (opts.cursor) html += '<span class="cursor"></span>'
  return html
}

/**
 * Le même rendu, un bloc de premier niveau par élément (paragraphe, liste,
 * bloc de code…). Pendant le streaming, seul le dernier bloc change : la vue
 * ne remplace que les blocs dont le HTML a bougé, pas tout le message.
 * @param {string} src
 * @returns {string[]}
 */
export function markdownBlocks(src) {
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n')
  const out = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    // bloc de code
    const fence = /^\s{0,3}(`{3,}|~{3,})\s*([\w.+-]*)/.exec(line)
    if (fence) {
      const [, marker, lang] = fence
      const body = []
      i++
      let closed = false
      while (i < lines.length) {
        if (new RegExp(`^\\s{0,3}${marker[0]}{${marker.length},}\\s*$`).test(lines[i])) { closed = true; i++; break }
        body.push(lines[i]); i++
      }
      const cls = lang ? ` class="language-${escapeHtml(lang)}"` : ''
      out.push(`<pre${closed ? '' : ' data-streaming="1"'}><code${cls}>${highlight(bounded(body.join('\n')), lang)}</code></pre>`)
      continue
    }

    if (/^\s*$/.test(line)) { i++; continue }

    // titre
    const head = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line)
    if (head) {
      const lvl = Math.min(head[1].length, 4)
      out.push(`<h${lvl}>${inline(head[2].replace(/\s+#+\s*$/, ''))}</h${lvl}>`)
      i++
      continue
    }

    // règle horizontale
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push('<hr>'); i++; continue }

    // citation
    if (/^\s{0,3}>/.test(line)) {
      const body = []
      while (i < lines.length && /^\s{0,3}>/.test(lines[i])) { body.push(lines[i].replace(/^\s{0,3}>\s?/, '')); i++ }
      out.push(`<blockquote>${renderMarkdown(bounded(body.join('\n')))}</blockquote>`)
      continue
    }

    // tableau
    if (isTableRow(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])) {
      const header = splitRow(line)
      i += 2
      const rows = []
      while (i < lines.length && isTableRow(lines[i])) { rows.push(splitRow(lines[i])); i++ }
      out.push(
        '<table><thead><tr>' + header.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>' +
        rows.map((r) => '<tr>' + r.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') +
        '</tbody></table>',
      )
      continue
    }

    // liste
    const item = listItem(line)
    if (item) {
      const ordered = item.ordered
      const items = []
      while (i < lines.length) {
        const it = listItem(lines[i])
        if (!it || it.ordered !== ordered) break
        const body = [it.text]
        i++
        // continuation indentée (y compris sous-listes)
        while (i < lines.length && /^(\s{2,}\S|\s*$)/.test(lines[i]) && !listItem(lines[i])?.top) {
          if (/^\s*$/.test(lines[i]) && !(i + 1 < lines.length && /^\s{2,}\S/.test(lines[i + 1]))) break
          body.push(lines[i].replace(/^ {1,4}/, ''))
          i++
        }
        const inner = body.length > 1 ? renderMarkdown(bounded(body.join('\n'))) : inline(body[0])
        items.push(`<li>${unwrapSingleP(inner)}</li>`)
      }
      const tag = ordered ? 'ol' : 'ul'
      out.push(`<${tag}>${items.join('')}</${tag}>`)
      continue
    }

    // paragraphe
    const para = []
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^\s{0,3}(#{1,6}\s|>|```|~~~)/.test(lines[i]) && !listItem(lines[i])) {
      para.push(lines[i]); i++
    }
    out.push(`<p>${inline(para.join('\n'))}</p>`)
  }

  return out
}

function isTableRow(l) { return /^\s*\|.*\|\s*$/.test(l) }
function splitRow(l) {
  return l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())
}

function listItem(line) {
  if (line === undefined) return null
  const m = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/.exec(line)
  if (!m) return null
  return { indent: m[1].length, ordered: /\d/.test(m[2]), text: m[3], top: m[1].length < 2 }
}

function unwrapSingleP(html) {
  const m = /^<p>([\s\S]*)<\/p>$/.exec(html)
  return m && !m[1].includes('<p>') ? m[1] : html
}

/** Emphase seule : barré, gras, italique. Jamais réappliquée à du HTML produit. */
function emphasis(s) {
  return s
    .replace(/~~([\s\S]+?)~~/g, '<del>$1</del>')
    .replace(/(\*\*|__)([\s\S]+?)\1/g, '<strong>$2</strong>')
    .replace(/(^|[^*\w])\*([^*\n]+?)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_([^_\n]+?)_(?!_)/g, '$1<em>$2</em>')
}

/**
 * Cherche `ch` à partir de `start`, en O(n) sur toute la passe : les positions
 * demandées sont croissantes, un résultat déjà trouvé (ou une absence jusqu'à
 * la fin) reste valable pour la demande suivante. Sans ça, des milliers de
 * liens non refermés re-scanneraient la fin du texte à chaque tentative.
 */
function finder(s, ch) {
  let at = -1
  let from = -1
  return (start) => {
    if (from === -1 || (at !== -1 && start > at)) { at = s.indexOf(ch, start); from = start }
    return at
  }
}

/**
 * Images, liens et autoliens, en une passe avant sur le texte échappé. Chaque
 * lien trouvé devient un jeton HTML final ; le reste du texte (entre les
 * jetons) subit seul les passes d'emphase. Les URL sont déjà échappées :
 * capturées dans le texte échappé, elles vont telles quelles dans le href.
 */
function linkScan(s, keep) {
  const nextBracket = finder(s, ']')
  const nextParen = finder(s, ')')
  let out = ''
  let i = 0
  while (i < s.length) {
    const image = s[i] === '!' && s[i + 1] === '['
    if (s[i] === '[' || image) {
      const open = image ? i + 1 : i
      const close = nextBracket(open + 1)
      const end = close === -1 ? -1 : nextParen(close + 2)
      if (close > open && close - open <= MAX_LINK_TEXT && s[close + 1] === '(' &&
          end !== -1 && end - close <= MAX_LINK_URL) {
        const text = s.slice(open + 1, close)
        const url = s.slice(close + 2, end).split(/\s/)[0]
        if ((image || text) && SAFE_URL.test(url)) {
          const label = image ? `🖼 ${text || 'image'}` : emphasis(text).replace(/\n/g, '<br>')
          out += keep(`<a href="${url}" target="_blank" rel="noreferrer">${label}</a>`)
          i = end + 1
          continue
        }
      }
      out += image ? '![' : '['
      i = open + 1
      continue
    }
    // autolien : http(s):// en début de texte ou après un espace/une parenthèse
    if (s[i] === 'h' && /^https?:\/\//.test(s.slice(i, i + 8)) && (i === 0 || /[\s(]/.test(s[i - 1]))) {
      let j = i
      while (j < s.length && !/[\s()<>]/.test(s[j])) j++
      const url = s.slice(i, j)
      out += keep(`<a href="${url}" target="_blank" rel="noreferrer">${url}</a>`)
      i = j
      continue
    }
    out += s[i]
    i++
  }
  return out
}

/** Rendu inline : code, liens, gras, italique, barré — dans cet ordre, par jetons. */
export function inline(src) {
  const slots = []
  const keep = (html) => `\u0000${slots.push(html) - 1}\u0000`
  let s = bounded(String(src ?? ''))
  // Le code d'abord, dans le texte brut : son contenu ne subit aucune passe.
  // Ouverture bornée à 32 backticks : une suite démesurée ne fait pas exploser
  // le retour arrière de la référence au même ouvreuse.
  s = s.replace(/(`{1,32})([\s\S]*?)\1/g, (_, _t, code) => keep(`<code>${escapeHtml(code.replace(/^ | $/g, ''))}</code>`))
  s = escapeHtml(s)
  s = linkScan(s, keep)
  s = emphasis(s)
  s = s.replace(/\n/g, '<br>')
  return s.replace(/\u0000(\d+)\u0000/g, (_, n) => slots[Number(n)])
}

// Coloration très grossière — assez pour que les blocs ne soient pas gris uniformes,
// sans embarquer de tokenizer. Les couleurs viennent du thème Zed actif.
const KEYWORDS = /\b(const|let|var|function|class|extends|return|if|else|for|while|await|async|import|from|export|new|try|catch|finally|throw|def|self|None|True|False|elif|fn|pub|impl|struct|enum|match|use|mut|type|interface|public|private|static|void|int|string|bool|end|then|do|local|nil|echo|set|param)\b/g

function highlight(code, lang) {
  const esc = escapeHtml(code)
  if (lang === 'diff') {
    return esc.split('\n').map((l) => {
      if (l.startsWith('+')) return `<span class="tok-str">${l}</span>`
      if (l.startsWith('-')) return `<span class="tok-com">${l}</span>`
      return l
    }).join('\n')
  }
  const slots = []
  const keep = (html) => `\u0001${slots.push(html) - 1}\u0001`
  let s = esc
    .replace(/(&quot;|&#39;|`)(?:(?!\1)[\s\S])*\1/g, (m) => keep(`<span class="tok-str">${m}</span>`))
    .replace(/(^|\s)(\/\/|#)[^\n]*/g, (m) => keep(`<span class="tok-com">${m}</span>`))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => keep(`<span class="tok-com">${m}</span>`))
  s = s.replace(KEYWORDS, '<span class="tok-kw">$1</span>')
  // Les index des emplacements réservés sont des chiffres : les colorer comme
  // des nombres cassait leur restauration (la chaîne cédait la place à son index).
  s = s.replace(/(?<!\u0001)\b(\d+(?:\.\d+)?)\b(?!\u0001)/g, '<span class="tok-num">$1</span>')
  return s.replace(/\u0001(\d+)\u0001/g, (_, n) => slots[Number(n)])
}