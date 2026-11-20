// Textes de la PWA en français (langue de référence, écrits dans le code) ou en anglais (en.js).
// Langue : réglage explicite (fr/en) s'il existe, sinon le navigateur (anglais si ce n'est pas
// le français). Sous Node (tests), ZRA_LANG l'emporte. Le réglage se lit dans le stockage, pas
// dans settings.js : ce module-ci en est une dépendance (pas de cycle).
// tr`texte ${a}` : la clé est le texte français, valeurs remplacées par {0}, {1}… ; texte absent de en.js : français.

import en from './en.js'

const pref = (() => {
  try { return JSON.parse(globalThis.localStorage?.getItem('zra.settings.v2') || '{}').lang } catch { return null }
})()

const source = globalThis.process?.env?.ZRA_LANG
  || (pref === 'fr' || pref === 'en' ? pref : null)
  || globalThis.navigator?.language || 'fr'

export const lang = /^fr\b/i.test(source) ? 'fr' : 'en'

export function tr(strings, ...values) {
  const text = lang === 'en' ? en[strings.reduce((key, s, i) => key + `{${i - 1}}` + s)] : undefined
  return text
    ? text.replace(/\{(\d+)\}/g, (_, i) => String(values[i]))
    : strings.reduce((out, s, i) => out + String(values[i - 1]) + s)
}

/** Locale des nombres et des dates, alignée sur la langue des textes. */
export const locale = lang === 'fr' ? 'fr-FR' : 'en-US'
