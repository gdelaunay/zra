// Textes de la PWA en français (langue de référence, écrits dans le code) ou en anglais (en.js), selon la
// langue du navigateur : anglais si ce n'est pas le français. Sous Node (tests), ZRA_LANG l'emporte.
// tr`texte ${a}` : la clé est le texte français, valeurs remplacées par {0}, {1}… ; texte absent de en.js : français.

import en from './en.js'

export const lang = /^fr\b/i.test(globalThis.process?.env?.ZRA_LANG || globalThis.navigator?.language || 'fr') ? 'fr' : 'en'

export function tr(strings, ...values) {
  const text = lang === 'en' ? en[strings.reduce((key, s, i) => key + `{${i - 1}}` + s)] : undefined
  return text
    ? text.replace(/\{(\d+)\}/g, (_, i) => String(values[i]))
    : strings.reduce((out, s, i) => out + String(values[i - 1]) + s)
}

/** Locale des nombres et des dates, alignée sur la langue des textes. */
export const locale = lang === 'fr' ? 'fr-FR' : 'en-US'
