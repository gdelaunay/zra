// Formulaire d'une question de l'agent (élicitation ACP en mode `form`) :
// lecture du schéma et validation, reprises de Zed
// (`crates/agent_ui/src/conversation_view/elicitation.rs` : `validate`,
// `validate_*_value`, `single_select_options`, `multi_select_default_value`).
// Sans DOM : le rendu est dans `views/entry.js`.

import { tr } from './i18n.js'

/** Au-delà, Zed refuse de valider un motif (`MAX_ELICITATION_PATTERN_*`). */
const MAX_PATTERN_BYTES = 16 * 1024
const MAX_PATTERN_INPUT_BYTES = 1024 * 1024

/** Libellé d'un champ : son `title`, à défaut son nom (`property_title`). */
export const fieldTitle = (name, prop) => prop?.title || name

/**
 * Nature d'un champ, comme les variantes de `ElicitationPropertySchema` :
 * `select` (texte à choix), `multi`, `boolean`, `number`, `integer`, `text`.
 * `null` : rien que Zed sache rendre.
 */
export function fieldKind(prop) {
  if (!prop || typeof prop !== 'object') return null
  if (prop.type === 'array') return 'multi'
  if (prop.type === 'boolean') return 'boolean'
  if (prop.type === 'number') return 'number'
  if (prop.type === 'integer') return 'integer'
  if (prop.type === 'string') return options(prop) ? 'select' : 'text'
  return null
}

/**
 * Choix proposés : `oneOf` (`const`, `title`, `description`) ou `enum`
 * (valeur seule) ; pour un choix multiple, ceux de `items` (`anyOf` ou `enum`).
 * @returns {Array<{value:string, label:string, description:string|null}>|null}
 */
export function options(prop) {
  const src = prop?.type === 'array' ? prop.items || {} : prop || {}
  const titled = src.oneOf || src.anyOf
  if (Array.isArray(titled)) {
    return titled.filter((o) => o && o.const !== undefined)
      .map((o) => ({ value: String(o.const), label: o.title || String(o.const), description: o.description || null }))
  }
  if (Array.isArray(src.enum)) return src.enum.map((v) => ({ value: String(v), label: String(v), description: null }))
  return null
}

/**
 * Valeurs de départ du formulaire. Comme Zed, un défaut qui ne correspond pas
 * au schéma (choix inconnu, mauvais nombre de choix) est ignoré.
 */
export function initialValues(schema) {
  const values = {}
  for (const [name, prop] of Object.entries(schema?.properties || {})) {
    const kind = fieldKind(prop)
    const d = prop?.default
    if (d === undefined || !kind) continue
    if (kind === 'select') {
      if (options(prop).some((o) => o.value === String(d))) values[name] = String(d)
    } else if (kind === 'multi') {
      const offered = new Set((options(prop) || []).map((o) => o.value))
      const ok = Array.isArray(d) && d.every((v) => offered.has(String(v)))
        && (prop.minItems === undefined || d.length >= prop.minItems)
        && (prop.maxItems === undefined || d.length <= prop.maxItems)
      if (ok) values[name] = d.map(String)
    } else if (kind === 'boolean') {
      values[name] = Boolean(d)
    } else {
      values[name] = String(d)
    }
  }
  return values
}

/**
 * Valide les réponses et prépare le contenu à envoyer (`validate` de Zed) :
 * champ vide et facultatif absent, nombres convertis, choix multiples triés.
 * @returns {{ content: object, errors: Record<string,string> }}
 */
export function validate(schema, values) {
  const required = new Set(Array.isArray(schema?.required) ? schema.required : [])
  const content = {}
  const errors = {}
  for (const [name, prop] of Object.entries(schema?.properties || {})) {
    const kind = fieldKind(prop)
    if (!kind) continue
    const title = fieldTitle(name, prop)
    const isRequired = required.has(name)
    const raw = values?.[name]
    let result
    switch (kind) {
      case 'text': {
        const v = raw === undefined || raw === null ? '' : String(raw)
        result = !v ? (isRequired ? { error: tr`${title} : réponse requise` } : {})
          : check(validateString(title, prop, v), v)
        break
      }
      case 'select': {
        const v = raw === undefined || raw === null || raw === '' ? null : String(raw)
        if (v === null) result = isRequired ? { error: tr`${title} : réponse requise` } : {}
        else if (!options(prop).some((o) => o.value === v)) result = { error: tr`${title} : choisir une des options proposées` }
        else result = check(validateString(title, prop, v), v)
        break
      }
      case 'number':
      case 'integer': {
        const v = raw === undefined || raw === null ? '' : String(raw).trim()
        if (!v) result = isRequired ? { error: tr`${title} : réponse requise` } : {}
        else result = validateNumber(title, prop, v, kind === 'integer')
        break
      }
      case 'boolean': {
        const v = Boolean(raw)
        result = isRequired || v || prop.default !== undefined ? { value: v } : {}
        break
      }
      case 'multi': {
        const chosen = new Set(Array.isArray(raw) ? raw.map(String) : [])
        const v = (options(prop) || []).map((o) => o.value).filter((x) => chosen.has(x)).sort()
        if (!v.length && !isRequired) result = {}
        else if (prop.minItems !== undefined && v.length < prop.minItems) result = { error: tr`${title} : choisir davantage d’options` }
        else if (prop.maxItems !== undefined && v.length > prop.maxItems) result = { error: tr`${title} : trop d’options choisies` }
        else result = { value: v }
        break
      }
    }
    if (result.error) errors[name] = result.error
    else if (result.value !== undefined) content[name] = result.value
  }
  return { content, errors }
}

const check = (error, value) => (error ? { error } : { value })

function validateNumber(title, prop, v, integer) {
  const ok = integer ? /^[+-]?\d+$/.test(v) : /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(v)
  const n = Number(v)
  if (!ok || !Number.isFinite(n)) return { error: integer ? tr`${title} : nombre entier attendu` : tr`${title} : nombre attendu` }
  if (prop.minimum !== undefined && n < prop.minimum) return { error: tr`${title} : au moins ${prop.minimum}` }
  if (prop.maximum !== undefined && n > prop.maximum) return { error: tr`${title} : au plus ${prop.maximum}` }
  return { value: n }
}

/** Longueur, motif et format d'un texte (`validate_string_value`). */
function validateString(title, prop, v) {
  const length = [...v].length
  if (prop.minLength !== undefined && length < prop.minLength) return tr`${title} : trop court`
  if (prop.maxLength !== undefined && length > prop.maxLength) return tr`${title} : trop long`
  const format = FORMATS[prop.format]
  if (prop.pattern === undefined && !format) return null
  let ok = true
  if (prop.pattern !== undefined) {
    if (String(prop.pattern).length > MAX_PATTERN_BYTES) return tr`${title} : motif de validation invalide`
    if (v.length > MAX_PATTERN_INPUT_BYTES) return tr`${title} : trop long pour être vérifié`
    let re
    try { re = new RegExp(prop.pattern, 'u') } catch { return tr`${title} : motif de validation invalide` }
    ok = re.test(v)
  }
  if (ok && format && !format.test(v)) ok = false
  if (ok) return null
  if (prop.pattern !== undefined) return format ? tr`${title} : ne respecte pas les contraintes demandées` : tr`${title} : ne respecte pas le motif demandé`
  return format.message(title)
}

/** Formats reconnus par Zed (`string_format_json_name`), vérifiés comme JSON Schema. */
const FORMATS = {
  email: { test: (v) => /^[^\s@]+@[^\s@]+$/.test(v), message: (t) => tr`${t} : adresse e-mail attendue` },
  uri: { test: (v) => /^[a-z][a-z0-9+.-]*:\S*$/i.test(v) && canParseUrl(v), message: (t) => tr`${t} : URI attendue` },
  date: { test: (v) => isDate(v), message: (t) => tr`${t} : date attendue (AAAA-MM-JJ)` },
  'date-time': {
    test: (v) => {
      const m = /^(\d{4}-\d{2}-\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/.exec(v)
      return Boolean(m) && isDate(m[1]) && Number(m[2]) < 24 && Number(m[3]) < 60 && Number(m[4]) < 61
    },
    message: (t) => tr`${t} : date et heure attendues`,
  },
}

function canParseUrl(v) {
  try { new URL(v); return true } catch { return false }
}

function isDate(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v)
  if (!m) return false
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3])
}
