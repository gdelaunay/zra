// Édition chirurgicale du `settings.json` de Zed — lot C, installation.
//
// Brancher ZRA, c'est ajouter **une** entrée sous `agent_servers`, et rien
// d'autre. Le fichier appartient à l'utilisateur et à Zed, qui le réécrit
// lui-même (options favorites, modes par défaut…) : on ne le re-sérialise
// jamais. On localise l'endroit exact dans le texte, on insère ou on retire une
// tranche, et tout le reste — commentaires, ordre, indentation, virgules
// traînantes — reste octet pour octet ce qu'il était.
//
// D'où un mini-analyseur qui ne sert qu'à *situer* : il produit l'arbre des
// objets avec leurs positions dans le texte. La lecture des valeurs, elle,
// reste l'affaire de `parseJsonc`.

import { parseJsonc } from './jsonc.js'

export class SettingsEditError extends Error {}

// ---------------------------------------------------------------------------
// Analyse positionnelle
// ---------------------------------------------------------------------------

/** Jetons significatifs : les blancs et les commentaires sont sautés. */
function tokenize(text) {
  const tokens = []
  let i = 0
  const n = text.length
  while (i < n) {
    const c = text[i]
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === '﻿') { i++; continue }
    if (c === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++
      continue
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      if (end === -1) throw new SettingsEditError('commentaire /* non refermé')
      i = end + 2
      continue
    }
    if (c === '"') {
      let j = i + 1
      while (j < n && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      if (j >= n) throw new SettingsEditError('chaîne non refermée')
      tokens.push({ t: 'str', start: i, end: j + 1, value: JSON.parse(text.slice(i, j + 1)) })
      i = j + 1
      continue
    }
    if ('{}[]:,'.includes(c)) {
      tokens.push({ t: c, start: i, end: i + 1 })
      i++
      continue
    }
    // Littéral : nombre, true, false, null.
    let j = i
    while (j < n && !' \t\r\n{}[]:,"/'.includes(text[j])) j++
    if (j === i) throw new SettingsEditError(`caractère inattendu à la position ${i}`)
    tokens.push({ t: 'lit', start: i, end: j })
    i = j
  }
  return tokens
}

/**
 * Arbre positionnel. Un objet : `{ kind:'object', start, end, members }`, où
 * chaque membre porte `start` (début de sa clé), `end` (fin de sa valeur) et
 * `comma` (position de la virgule qui le suit, ou `null`).
 */
export function locate(text) {
  const tokens = tokenize(text)
  let p = 0

  const expect = (t) => {
    const tok = tokens[p]
    if (!tok || tok.t !== t) throw new SettingsEditError(`« ${t} » attendu à la position ${tok?.start ?? text.length}`)
    p++
    return tok
  }

  function value() {
    const tok = tokens[p]
    if (!tok) throw new SettingsEditError('fin de fichier inattendue')
    if (tok.t === '{') return object()
    if (tok.t === '[') return array()
    if (tok.t === 'str' || tok.t === 'lit') { p++; return { kind: 'scalar', start: tok.start, end: tok.end } }
    throw new SettingsEditError(`valeur attendue à la position ${tok.start}`)
  }

  function object() {
    const open = expect('{')
    const members = []
    while (tokens[p] && tokens[p].t !== '}') {
      const key = expect('str')
      expect(':')
      const v = value()
      const member = { key: key.value, start: key.start, end: v.end, value: v, comma: null }
      if (tokens[p]?.t === ',') { member.comma = tokens[p].start; p++ }
      members.push(member)
      if (member.comma === null) break
    }
    const close = expect('}')
    return { kind: 'object', start: open.start, end: close.end, members }
  }

  function array() {
    const open = expect('[')
    while (tokens[p] && tokens[p].t !== ']') {
      value()
      if (tokens[p]?.t === ',') p++
      else break
    }
    const close = expect(']')
    return { kind: 'array', start: open.start, end: close.end }
  }

  const root = value()
  if (p !== tokens.length) throw new SettingsEditError(`contenu inattendu après la racine (position ${tokens[p].start})`)
  if (root.kind !== 'object') throw new SettingsEditError("la racine du settings.json n'est pas un objet")
  return root
}

// ---------------------------------------------------------------------------
// Mise en forme de ce qu'on insère
// ---------------------------------------------------------------------------

/** Indentation de la ligne qui contient `pos`. */
function lineIndent(text, pos) {
  const start = text.lastIndexOf('\n', pos - 1) + 1
  const m = /^[ \t]*/.exec(text.slice(start))
  return m ? m[0] : ''
}

/** Unité d'indentation du fichier : celle de sa première ligne indentée. */
function indentUnit(text) {
  const m = /\n([ \t]+)\S/.exec(text)
  return m ? m[1] : '  '
}

function eol(text) {
  return text.includes('\r\n') ? '\r\n' : '\n'
}

/** `"clé": valeur` en JSON indenté, décalé pour s'aligner sur `indent`. */
function renderMember(key, value, indent, unit, nl) {
  const body = JSON.stringify(value, null, unit).split('\n').join(nl + indent)
  return `${JSON.stringify(key)}: ${body}`
}

// ---------------------------------------------------------------------------
// Opérations
// ---------------------------------------------------------------------------

/**
 * Ajoute ou remplace `agent_servers.<key>`. Seule la tranche concernée change.
 *
 * @returns {{ text:string, action:'added'|'replaced'|'unchanged' }}
 */
export function upsertAgentServer(text, key, value) {
  const root = locate(text)
  const unit = indentUnit(text)
  const nl = eol(text)
  const servers = root.members.find((m) => m.key === 'agent_servers')

  // Pas encore d'`agent_servers` : on le crée en tête de la racine.
  if (!servers) {
    const indent = lineIndent(text, root.members[0]?.start ?? root.start) || unit
    const inner = indent + unit
    const block = `${JSON.stringify('agent_servers')}: {${nl}${inner}${renderMember(key, value, inner, unit, nl)}${nl}${indent}}`
    const after = root.members.length ? ',' : ''
    const insert = `${nl}${indent}${block}${after}`
    const at = root.start + 1
    return { text: text.slice(0, at) + insert + (root.members.length ? '' : nl) + text.slice(at), action: 'added' }
  }

  if (servers.value.kind !== 'object') throw new SettingsEditError("« agent_servers » n'est pas un objet")
  const obj = servers.value
  const existing = obj.members.find((m) => m.key === key)

  if (existing) {
    const indent = lineIndent(text, existing.start)
    const rendered = renderMember(key, value, indent, unit, nl)
    if (text.slice(existing.start, existing.end) === rendered) return { text, action: 'unchanged' }
    return { text: text.slice(0, existing.start) + rendered + text.slice(existing.end), action: 'replaced' }
  }

  // Nouvelle entrée, en dernière position : c'est là que l'utilisateur s'attend
  // à trouver ce qui vient d'être ajouté, et le reste du bloc ne bouge pas.
  const last = obj.members.at(-1)
  const indent = last ? lineIndent(text, last.start) : lineIndent(text, servers.start) + unit
  const rendered = renderMember(key, value, indent, unit, nl)
  if (!last) {
    const closeIndent = lineIndent(text, servers.start)
    const at = obj.start + 1
    const insert = `${nl}${indent}${rendered}${nl}${closeIndent}`
    // `{}` ou `{ }` : on remplace l'intérieur, qui ne contient au mieux que des blancs.
    const inside = text.slice(at, obj.end - 1)
    if (/\S/.test(inside)) {
      return { text: text.slice(0, at) + insert + text.slice(at), action: 'added' }
    }
    return { text: text.slice(0, at) + insert + text.slice(obj.end - 1), action: 'added' }
  }
  if (last.comma !== null) {
    // Virgule traînante déjà présente : on insère après elle et on en remet une,
    // pour respecter le style du fichier.
    const at = last.comma + 1
    return { text: `${text.slice(0, at)}${nl}${indent}${rendered},${text.slice(at)}`, action: 'added' }
  }
  const at = last.end
  return { text: `${text.slice(0, at)},${nl}${indent}${rendered}${text.slice(at)}`, action: 'added' }
}

/**
 * Retire `agent_servers.<key>` et la virgule qui l'accompagne. La ligne est
 * supprimée entière quand l'entrée l'occupait seule.
 *
 * @returns {{ text:string, action:'removed'|'absent' }}
 */
export function removeAgentServer(text, key) {
  const root = locate(text)
  const servers = root.members.find((m) => m.key === 'agent_servers')
  if (!servers || servers.value.kind !== 'object') return { text, action: 'absent' }
  const members = servers.value.members
  const idx = members.findIndex((m) => m.key === key)
  if (idx === -1) return { text, action: 'absent' }
  const m = members[idx]

  let from = m.start
  let to = m.end
  if (m.comma !== null) {
    to = m.comma + 1
  } else if (idx > 0 && members[idx - 1].comma !== null) {
    // Dernier membre sans virgule : c'est celle du précédent qui disparaît.
    from = members[idx - 1].comma
  }

  // Élargir à la ligne entière si elle ne contient que l'entrée.
  const lineStart = text.lastIndexOf('\n', from - 1) + 1
  if (!/\S/.test(text.slice(lineStart, from)) && from === m.start) {
    const nextNl = text.indexOf('\n', to)
    if (nextNl !== -1 && !/\S/.test(text.slice(to, nextNl))) {
      from = lineStart
      to = nextNl + 1
    }
  }
  return { text: text.slice(0, from) + text.slice(to), action: 'removed' }
}

/** Vérifie qu'une édition a produit un fichier que Zed pourra relire. */
export function assertParsable(text) {
  try {
    return parseJsonc(text)
  } catch (err) {
    throw new SettingsEditError(`le résultat ne serait plus un JSONC valide : ${err.message}`)
  }
}
