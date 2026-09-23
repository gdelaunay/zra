// Réglages persistés (localStorage) : postes, thème, préférences d'envoi.

import { emitter } from './dom.js'
import { THEMES } from './themes.js'

const KEY = 'zra.settings.v2'
const DEFAULT_THEME = THEMES[0].id

const e = emitter()
export const onSettings = e.on

function load() {
  let raw = null
  try { raw = JSON.parse(localStorage.getItem(KEY) || 'null') } catch { /* stockage corrompu */ }
  const s = raw && typeof raw === 'object' ? raw : {}
  return {
    machines: Array.isArray(s.machines) ? s.machines : [],
    theme: THEMES.some((t) => t.id === s.theme) ? s.theme : DEFAULT_THEME,
    clientId: s.clientId || `zra-${Math.random().toString(36).slice(2, 10)}`,
    defaultSendMode: s.defaultSendMode === 'interrupt' ? 'interrupt' : 'queue',
    showThoughts: s.showThoughts !== false,
    expandTools: s.expandTools === true,
    mock: s.mock === true,
    lastThread: s.lastThread || null,
    /** Projets repliés dans la liste, clé `${machineId}|${projectKey}`. */
    collapsedProjects: Array.isArray(s.collapsedProjects) ? s.collapsedProjects.filter((k) => typeof k === 'string') : [],
  }
}

export const settings = load()

function persist() {
  const { machines, theme, clientId, defaultSendMode, showThoughts, expandTools, mock, lastThread, collapsedProjects } = settings
  try {
    localStorage.setItem(KEY, JSON.stringify({
      machines, theme, clientId, defaultSendMode, showThoughts, expandTools, mock, lastThread, collapsedProjects,
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
 * ouvrir qu'un `wss://` (contenu mixte bloqué). Sans port, celui du daemon,
 * 7777, en HTTP comme en HTTPS — un port explicite est toujours respecté.
 */
export function normalizeUrl(input, pageProtocol = globalThis.location?.protocol) {
  let s = String(input || '').trim()
  if (!s) return null
  if (!/^https?:\/\//i.test(s)) s = `${pageProtocol === 'https:' ? 'https' : 'http'}://${s}`
  const explicitPort = /^https?:\/\/(\[[^\]]*\]|[^/:]*):\d+/i.test(s)
  let u
  try { u = new URL(s) } catch { return null }
  if (!explicitPort) u.port = '7777'
  u.pathname = u.pathname.replace(/\/+$/, '')
  return u.origin + (u.pathname === '/' ? '' : u.pathname)
}

export function addMachine(input, label) {
  const url = normalizeUrl(input)
  if (!url) return { error: 'adresse invalide' }
  if (settings.machines.some((m) => m.url === url)) return { error: 'poste déjà enregistré' }
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

export function applyTheme(id) {
  const theme = THEMES.find((t) => t.id === id) || THEMES[0]
  document.documentElement.dataset.theme = theme.id
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) {
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--panel-background').trim()
    if (bg) meta.setAttribute('content', bg.slice(0, 7))
  }
  return theme
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
    label: local ? 'ce poste' : location.hostname,
    implicit: true,
  }
}
