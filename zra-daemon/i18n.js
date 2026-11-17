// Messages du daemon, du shim et des scripts en français (langue de référence, écrits dans le code) ou en
// anglais (i18n/en.json). tr`texte ${a} et ${b}` : la clé est le texte français, valeurs remplacées par {0},
// {1}… ; texte absent de en.json : français.
// Langue : ZRA_LANG (fr ou en), sinon celle du système ; anglais si ce n'est pas le français.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const system = () => process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || Intl.DateTimeFormat().resolvedOptions().locale
export const lang = /^fr/i.test(process.env.ZRA_LANG || system()) ? 'fr' : 'en'

export const catalogFile = join(import.meta.dirname, '..', 'i18n', 'en.json')
let catalog

export const keyOf = (strings) => strings.reduce((key, s, i) => key + `{${i - 1}}` + s)

export function tr(strings, ...values) {
  if (lang === 'en') {
    catalog ??= JSON.parse(readFileSync(catalogFile, 'utf8'))
    const text = catalog[keyOf(strings)]
    if (text) return text.replace(/\{(\d+)\}/g, (_, i) => String(values[i]))
  }
  return strings.reduce((out, s, i) => out + String(values[i - 1]) + s)
}

