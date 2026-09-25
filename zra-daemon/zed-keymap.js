// Raccourcis « nouveau thread » de ZRA dans le `keymap.json` de Zed — lot C.
//
// Le menu « nouveau thread » de Zed ouvre le dernier agent utilisé, pas celui
// choisi sur le mobile. L'action `agent::NewExternalAgentThread`, elle, prend
// l'agent en paramètre ; il lui faut une touche. `npm run setup` en lie une par
// entrée ZRA, et le pilote la joue.
//
// Forme de l'argument, relevée dans le code de Zed (`crates/agent_ui`,
// `deserialize_external_agent_id`) : un id d'agent en chaîne, ou l'ancienne
// forme `{ "custom": { "name": id } }`. On écrit l'ancienne : acceptée par les
// versions récentes comme par les plus vieilles.
//
// Même discipline que `zed-settings.js` : le fichier n'est jamais re-sérialisé.
// Le bloc de ZRA est un élément du tableau racine, encadré de deux commentaires
// repères ; l'ajouter ou le retirer ne touche à rien d'autre.

import { readFile } from 'node:fs/promises'

import { parseJsonc } from './jsonc.js'
import { SettingsEditError, eol, indentUnit, tokenize } from './zed-settings.js'

export const BEGIN = '// >>> zra : nouveaux threads depuis le mobile (npm run setup) — retiré par uninstall'
export const END = '// <<< zra'

export const ACTION = 'agent::NewExternalAgentThread'

/**
 * Touches proposées, dans l'ordre. Ctrl+Alt+Shift+F1…F12 : liées à rien dans
 * Zed ni dans Windows, et le pilote sait les taper.
 */
export const KEY_POOL = Array.from({ length: 12 }, (_, i) => `ctrl-alt-shift-f${i + 1}`)

/** Touche Zed (`ctrl-alt-f1`) → accord du pilote clavier (`ctrl+alt+f1`). */
export const toChord = (keystroke) => String(keystroke).split('-').join('+')

/** Tranche du bloc ZRA dans le texte : de la ligne de `BEGIN` à celle de `END` comprises. */
function span(text) {
  const b = text.indexOf(BEGIN)
  if (b === -1) return null
  const e = text.indexOf(END, b)
  if (e === -1) throw new SettingsEditError('keymap.json : repère de fin du bloc ZRA introuvable, on n’y touche pas')
  const from = text.lastIndexOf('\n', b - 1) + 1
  const nl = text.indexOf('\n', e)
  const to = nl === -1 ? text.length : nl + 1
  return { from, to, inner: text.slice(text.indexOf('\n', b) + 1, text.lastIndexOf('\n', e - 1) + 1) }
}

function agentOf(args) {
  const a = args?.agent
  if (typeof a === 'string') return a
  return a?.custom?.name ?? null
}

/**
 * Raccourcis posés par ZRA : id d'agent → touche Zed.
 * @returns {Map<string, string>}
 */
export function readZraKeys(text) {
  const out = new Map()
  const s = text ? span(text) : null
  if (!s) return out
  let block
  try {
    block = parseJsonc(s.inner.trim().replace(/,$/, ''))
  } catch {
    return out
  }
  for (const [key, binding] of Object.entries(block?.bindings ?? {})) {
    if (!Array.isArray(binding) || binding[0] !== ACTION) continue
    const agent = agentOf(binding[1])
    if (agent) out.set(agent, key)
  }
  return out
}

/** Touche liée à cet agent dans le `keymap.json`, ou `null` (fichier absent, pas de bloc). */
export async function readAgentKey(file, agentId) {
  if (!file) return null
  let text
  try { text = await readFile(file, 'utf8') } catch { return null }
  return readZraKeys(text).get(agentId) ?? null
}

/**
 * Attribue une touche à chaque agent : celles déjà posées restent, les autres
 * prennent la première libre du `KEY_POOL`.
 * @param {string[]} agentIds @param {Map<string,string>} existing
 * @returns {Map<string, string>} agent → touche
 */
export function assignKeys(agentIds, existing = new Map()) {
  const out = new Map()
  const taken = new Set()
  for (const id of agentIds) {
    const k = existing.get(id)
    if (k && !taken.has(k)) { out.set(id, k); taken.add(k) }
  }
  for (const id of agentIds) {
    if (out.has(id)) continue
    const k = KEY_POOL.find((x) => !taken.has(x))
    if (!k) throw new SettingsEditError(`plus de ${KEY_POOL.length} agents ZRA : pas assez de touches`)
    out.set(id, k)
    taken.add(k)
  }
  return out
}

/** Retire le bloc ZRA, et lui seul. @returns {{ text:string, action:'removed'|'absent' }} */
export function removeZraKeymap(text) {
  const s = span(text)
  if (!s) return { text, action: 'absent' }
  return { text: text.slice(0, s.from) + text.slice(s.to), action: 'removed' }
}

/**
 * Pose (ou remplace) le bloc ZRA en tête du tableau racine. Un fichier absent
 * ou vide devient un tableau qui ne contient que lui.
 * @param {string|null} text @param {Map<string,string>} keys agent → touche
 * @returns {{ text:string, action:'added'|'replaced'|'unchanged' }}
 */
export function upsertZraKeymap(text, keys) {
  const had = text ? span(text) : null
  const base = had ? removeZraKeymap(text).text : (text ?? '')
  const unit = base.trim() ? indentUnit(base) : '  '
  const nl = base ? eol(base) : '\n'

  // Une ligne par touche : le bloc se lit d'un coup d'œil dans le fichier.
  const lines = [...keys].map(([agent, key], i, all) =>
    `${unit}${unit}${JSON.stringify(key)}: ["${ACTION}", { "agent": { "custom": { "name": ${JSON.stringify(agent)} } } }]` +
    (i < all.length - 1 ? ',' : ''))
  const json = [`{`, `${unit}"bindings": {`, ...lines, `${unit}}`, `}`].join(nl + unit)

  const tokens = base.trim() ? tokenize(base) : []
  let next
  if (!tokens.length) {
    // Fichier absent, vide, ou rien que des commentaires : ils restent au-dessus.
    const head = base && !/\n$/.test(base) ? base + nl : base
    next = `${head}[${nl}${unit}${BEGIN}${nl}${unit}${json}${nl}${unit}${END}${nl}]${nl}`
  } else {
    if (tokens[0].t !== '[') throw new SettingsEditError("la racine du keymap.json n'est pas un tableau")
    // Une virgule seulement s'il reste des éléments après le bloc.
    const comma = tokens[1] && tokens[1].t !== ']' ? ',' : ''
    const at = tokens[0].end
    // Le repère de fin doit clore sa ligne : le retrait coupe à la ligne entière.
    const rest = base.slice(at)
    const tail = rest.startsWith('\n') || rest.startsWith('\r\n') ? rest : nl + rest
    next = `${base.slice(0, at)}${nl}${unit}${BEGIN}${nl}${unit}${json}${comma}${nl}${unit}${END}${tail}`
  }
  const action = !had ? 'added' : next === text ? 'unchanged' : 'replaced'
  return { text: action === 'unchanged' ? text : next, action }
}
