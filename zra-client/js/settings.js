// Réglages persistés (localStorage) : postes, thème, préférences d'envoi.

import { emitter } from './dom.js'
import { THEMES } from './themes.js'
import { tr } from './i18n.js'

const KEY = 'zra.settings.v2'

const e = emitter()
export const onSettings = e.on

function load() {
  let raw = null
  try { raw = JSON.parse(localStorage.getItem(KEY) || 'null') } catch { /* stockage corrompu */ }
  const s = raw && typeof raw === 'object' ? raw : {}
  return {
    machines: Array.isArray(s.machines) ? s.machines : [],
    /** Absent (`null`) = mode auto : One dark/light selon le navigateur, jusqu'au premier choix manuel. */
    theme: THEMES.some((t) => t.id === s.theme) ? s.theme : null,
    /** Langue des textes : auto (navigateur), fr ou en. */
    lang: s.lang === 'fr' || s.lang === 'en' ? s.lang : 'auto',
    /** Échelle des tailles de police (confort mobile) ; 1 = tailles de la feuille. */
    textScale: typeof s.textScale === 'number' && s.textScale >= 0.5 && s.textScale <= 2 ? s.textScale : 1,
    /** Jeu d'icônes de fichiers (mentions) ; défaut = génériques file-text/folder. */
    iconSet: ['default', 'colored-dark', 'colored-light'].includes(s.iconSet) ? s.iconSet : 'default',
    clientId: s.clientId || `zra-${Math.random().toString(36).slice(2, 10)}`,
    defaultSendMode: s.defaultSendMode === 'interrupt' ? 'interrupt' : 'queue',
    /** Faux (défaut) : comme Zed (`thinking_display: "auto"`), dépliées pendant leur écriture. */
    alwaysShowThoughts: s.alwaysShowThoughts === true,
    /** Faux (défaut) : comme Zed, diffs, terminaux et autorisations en attente dépliés. */
    expandTools: s.expandTools === true,
    /** Filtre de la liste des threads : tous, live ou archivés. */
    threadFilter: ['all', 'live', 'archived'].includes(s.threadFilter) ? s.threadFilter : 'all',
    /** Notifications push de fin de tour (Web Push) ; faux par défaut. */
    notifications: s.notifications === true,
    mock: s.mock === true,
    lastThread: s.lastThread || null,
    /** Jetons d'appairage, par adresse de poste. */
    tokens: s.tokens && typeof s.tokens === 'object' ? s.tokens : {},
  }
}

export const settings = load()

function persist() {
  const { machines, theme, lang, textScale, iconSet, clientId, defaultSendMode, alwaysShowThoughts, expandTools, threadFilter, notifications, mock, lastThread, tokens } = settings
  try {
    localStorage.setItem(KEY, JSON.stringify({
      machines, theme, lang, textScale, iconSet, clientId, defaultSendMode, alwaysShowThoughts, expandTools, threadFilter, notifications, mock, lastThread, tokens,
    }))
  } catch { /* mode privé : on tourne en mémoire */ }
}

export function update(patch) {
  Object.assign(settings, patch)
  persist()
  e.emit('change', settings)
}

/**
 * Normalise une saisie utilisateur : "10.77.0.1" -> "http://10.77.0.1:7777".
 *
 * Sans schéma, on prend celui de la page : une PWA servie en HTTPS ne peut
 * ouvrir qu'un `wss://` (contenu mixte bloqué). Sans port : en HTTP celui du
 * daemon, 7777 ; en HTTPS le port standard, 443 — le daemon est alors derrière
 * un reverse proxy (docs/fr/deploy.md §4). Un port explicite est toujours respecté.
 */
export function normalizeUrl(input, pageProtocol = globalThis.location?.protocol) {
  let s = String(input || '').trim()
  if (!s) return null
  if (!/^https?:\/\//i.test(s)) s = `${pageProtocol === 'https:' ? 'https' : 'http'}://${s}`
  const explicitPort = /^https?:\/\/(\[[^\]]*\]|[^/:]*):\d+/i.test(s)
  let u
  try { u = new URL(s) } catch { return null }
  if (!explicitPort && u.protocol === 'http:') u.port = '7777'
  u.pathname = u.pathname.replace(/\/+$/, '')
  return u.origin + (u.pathname === '/' ? '' : u.pathname)
}

export function addMachine(input, label) {
  const url = normalizeUrl(input)
  if (!url) return { error: tr`adresse invalide` }
  if (settings.machines.some((m) => m.url === url)) return { error: tr`poste déjà enregistré` }
  const machine = { id: `m${Date.now().toString(36)}`, url, label: label || hostLabel(url) }
  update({ machines: [...settings.machines, machine] })
  return { machine }
}

export function removeMachine(id) {
  update({ machines: settings.machines.filter((m) => m.id !== id) })
}

export function renameMachine(id, label) {
  update({ machines: settings.machines.map((m) => (m.id === id ? { ...m, label } : m)) })
}

export function hostLabel(url) {
  try { return new URL(url).hostname } catch { return url }
}

/** Thème résolu en mode auto : One dark/light selon le navigateur. */
export function autoThemeId() {
  return globalThis.matchMedia?.('(prefers-color-scheme: dark)')?.matches ? 'one-dark' : 'one-light'
}

/** Le thème effectif : choix manuel figé, ou résolution auto. */
export const currentThemeId = () => settings.theme ?? autoThemeId()

/**
 * Pose le thème sur `<html>` et aligne la barre du navigateur.
 * `id` absent ou inconnu = mode auto (résolution navigateur).
 */
export function applyTheme(id) {
  const theme = THEMES.find((t) => t.id === id) || THEMES.find((t) => t.id === autoThemeId()) || THEMES[0]
  document.documentElement.dataset.theme = theme.id
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) {
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--panel-background').trim()
    if (bg) meta.setAttribute('content', bg.slice(0, 7))
  }
  return theme
}

/** Échelle des tailles de police, posée sur `<html>` (consommée par `calc()` dans app.css). */
export function applyTextScale(scale = settings.textScale) {
  document.documentElement.style.setProperty('--text-scale', String(scale))
}

/**
 * Poste implicite — confort de dev, jamais une hypothèse.
 *
 * Le client est servi indépendamment du daemon : en production il vient d'un
 * hébergeur quelconque, et l'origine de la page ne dit **rien** de l'adresse des
 * postes. On ne pré-remplit donc que dans les deux cas où l'origine est
 * effectivement celle d'un daemon : servi par lui (port 7777) ou en local.
 * Partout ailleurs : liste vide, et les postes se saisissent dans Réglages.
 */
export function originMachine() {
  if (!location.protocol.startsWith('http')) return null

  const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)
  const servedByDaemon = location.port === '7777'
  if (!local && !servedByDaemon) return null

  // Le daemon écoute toujours sur 7777, y compris quand un serveur de dev sert
  // le client sur un autre port de la même machine.
  return {
    id: 'origin',
    url: `${location.protocol}//${location.hostname}:7777`,
    label: local ? tr`ce poste` : location.hostname,
    implicit: true,
  }
}

/** Jeton d'appairage d'un poste, ou `null`. */
export const tokenFor = (url) => settings.tokens[url] ?? null

export function setToken(url, token) {
  const tokens = { ...settings.tokens }
  if (token) tokens[url] = token
  else delete tokens[url]
  update({ tokens })
}
