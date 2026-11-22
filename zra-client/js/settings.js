// Réglages persistés (localStorage) : postes, thème, préférences d'envoi.

import { emitter } from './dom.js'
import { THEMES } from './themes.js'
import { tr } from './i18n.js'

const KEY = 'zra.settings.v2'

const e = emitter()
export const onSettings = e.on

/**
 * Mode relais : la PWA est servie par `zra-relay` (même origine), qui joint
 * les postes par leur IP (`/to/<ip>/ws`). Détecté au démarrage par le marqueur
 * `/zra-relay` ; sinon, comportement direct (proxy par poste).
 */
let relayOn = false
export const isRelay = () => relayOn
export function setRelayMode(on) { relayOn = Boolean(on) }

export async function detectRelayMode() {
  if (!globalThis.location?.protocol?.startsWith('http')) return setRelayMode(false)
  try {
    const res = await fetch(`${location.origin}/zra-relay`, { cache: 'no-store', signal: AbortSignal.timeout(3000) })
    setRelayMode(res.ok && (await res.json())?.relay === true)
  } catch { setRelayMode(false) }
  return relayOn
}

function load() {
  let raw = null
  try { raw = JSON.parse(localStorage.getItem(KEY) || 'null') } catch { /* stockage corrompu */ }
  const s = raw && typeof raw === 'object' ? raw : {}
  // Postes : la cible (IP ou adresse) est la seule référence persistée ; l'URL
  // de connexion se reconstruit selon le mode courant (`machineUrl`) — le
  // serveur derrière un domaine peut changer (daemon ↔ relais) sans casser
  // les postes enregistrés. Ancien format : URL construite → cible extraite.
  const targetOf = (m) => {
    if (m.target) return m.target
    const route = /^https?:\/\/[^/]+\/to\/([^/]+)/.exec(m.url || '')
    return route ? route[1] : (m.url || '')
  }
  const machines = []
  const tokens = s.tokens && typeof s.tokens === 'object' ? { ...s.tokens } : {}
  for (const m of Array.isArray(s.machines) ? s.machines : []) {
    const target = targetOf(m)
    if (!target || machines.some((x) => x.target === target)) continue
    machines.push({ id: m.id, target, label: m.label })
    // Jetons anciennement par URL construite → par cible : le même poste garde
    // son jeton entre mode relais et direct.
    if (m.url && m.url !== target && tokens[m.url] && !tokens[target]) {
      tokens[target] = tokens[m.url]
      delete tokens[m.url]
    }
  }
  return {
    machines,
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
    /** « Tu-dum » de fin de tour quand la PWA est ouverte ; vrai par défaut. */
    turnEndSound: s.turnEndSound !== false,
    mock: s.mock === true,
    lastThread: s.lastThread || null,
    /** Jetons d'appairage, par cible de poste (IP ou adresse). */
    tokens,
  }
}

export const settings = load()

function persist() {
  const { machines, theme, lang, textScale, iconSet, clientId, defaultSendMode, alwaysShowThoughts, expandTools, threadFilter, notifications, turnEndSound, mock, lastThread, tokens } = settings
  try {
    localStorage.setItem(KEY, JSON.stringify({
      machines, theme, lang, textScale, iconSet, clientId, defaultSendMode, alwaysShowThoughts, expandTools, threadFilter, notifications, turnEndSound, mock, lastThread, tokens,
    }))
  } catch { /* mode privé : on tourne en mémoire */ }
}

export function update(patch) {
  Object.assign(settings, patch)
  persist()
  e.emit('change', settings)
}

/** IPv4 littérale — le relais ne vise que ça (pas de DNS). */
const isIPv4 = (s) => /^\d{1,3}(\.\d{1,3}){3}$/.test(s) && s.split('.').every((p) => Number(p) <= 255)

/**
 * Cible d'un poste : la référence persistée, indépendante du mode de service.
 * Relais : IP littérale (schéma et port ignorés, le relais vise 7777).
 * Direct : adresse normalisée — sans schéma, celui de la page (une PWA en
 * HTTPS ne peut ouvrir que du `wss://`) ; sans port, 7777 en HTTP, 443 en
 * HTTPS (reverse proxy, docs/fr/deploy.md §4) ; port explicite respecté,
 * chemin du proxy gardé.
 */
export function parseTarget(input, pageProtocol = globalThis.location?.protocol) {
  let s = String(input || '').trim()
  if (!s) return null
  if (!/^https?:\/\//i.test(s)) s = `${pageProtocol === 'https:' ? 'https' : 'http'}://${s}`
  let u
  try { u = new URL(s) } catch { return null }
  if (relayOn) return isIPv4(u.hostname) ? u.hostname : null
  const explicitPort = /^https?:\/\/(\[[^\]]*\]|[^/:]*):\d+/i.test(s)
  if (!explicitPort && u.protocol === 'http:') u.port = '7777'
  u.pathname = u.pathname.replace(/\/+$/, '')
  return u.origin + (u.pathname === '/' ? '' : u.pathname)
}

/**
 * URL de connexion d'une cible, selon le mode courant — jamais persistée.
 * Une IP nue saisie en mode relais suit les règles directes quand la page est
 * servie par un daemon (et inversement, une adresse dont l'hôte est une IP
 * repasse par la route du relais). Une adresse à hostname reste joignable en
 * direct même sous le relais : le mode ne casse aucune entrée enregistrée.
 */
export function machineUrl(target, pageProtocol = globalThis.location?.protocol, origin = globalThis.location?.origin) {
  if (!target) return null
  if (relayOn) {
    if (isIPv4(target)) return `${origin}/to/${target}`
    try {
      const u = new URL(target)
      if (isIPv4(u.hostname)) return `${origin}/to/${u.hostname}`
    } catch { /* cible nue non IP : adresse directe */ }
    return target
  }
  if (/^https?:\/\//i.test(target)) return target
  // IP nue (saisie en mode relais) : schéma de la page, 7777 en http, 443 en https.
  return pageProtocol === 'https:' ? `https://${target}` : `http://${target}:7777`
}

/** Saisie utilisateur → URL de connexion dans le mode courant. */
export function normalizeUrl(input, pageProtocol = globalThis.location?.protocol, origin = globalThis.location?.origin) {
  const target = parseTarget(input, pageProtocol)
  return target ? machineUrl(target, pageProtocol, origin) : null
}

/** Poste persisté → poste connectable : l'URL est dérivée, pas stockée. */
export const withUrl = (m) => ({ ...m, url: machineUrl(m.target) })

export function addMachine(input, label) {
  const target = parseTarget(input)
  if (!target) return { error: tr`Adresse invalide.` }
  if (settings.machines.some((m) => m.target === target)) return { error: tr`Poste déjà enregistré.` }
  const machine = { id: `m${Date.now().toString(36)}`, target, label: label || hostLabel(machineUrl(target)) }
  update({ machines: [...settings.machines, machine] })
  return { machine: { ...machine, url: machineUrl(target) } }
}

export function removeMachine(id) {
  update({ machines: settings.machines.filter((m) => m.id !== id) })
}

export function renameMachine(id, label) {
  update({ machines: settings.machines.map((m) => (m.id === id ? { ...m, label } : m)) })
}

export function hostLabel(url) {
  try {
    const u = new URL(url)
    // Route relais : le poste se nomme par l'IP visée, pas par l'hôte du relais.
    const m = /^\/to\/([^/]+)/.exec(u.pathname)
    return m ? m[1] : u.hostname
  } catch { return url }
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
  // Servi par le relais : l'origine est celle du homelab, pas d'un poste.
  if (relayOn) return null

  const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)
  const servedByDaemon = location.port === '7777'
  if (!local && !servedByDaemon) return null

  // Le daemon écoute toujours sur 7777, y compris quand un serveur de dev sert
  // le client sur un autre port de la même machine.
  const url = `${location.protocol}//${location.hostname}:7777`
  return {
    id: 'origin',
    url,
    target: url,
    label: local ? tr`Ce poste` : location.hostname,
    implicit: true,
  }
}

/** Jeton d'appairage d'un poste (par cible), ou `null`. */
export const tokenFor = (target) => settings.tokens[target] ?? null

export function setToken(target, token) {
  const tokens = { ...settings.tokens }
  if (token) tokens[target] = token
  else delete tokens[target]
  update({ tokens })
}
