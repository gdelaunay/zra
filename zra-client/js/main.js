// Amorçage : thème, transport (réel ou mock), routeur.

import { h, clear } from './dom.js'
import { settings, applyTheme, update as updateSettings } from './settings.js'
import * as store from './store.js'
import { ThreadsView } from './views/threads.js'
import { ThreadView } from './views/thread.js'
import { DevBar } from './views/devbar.js'
import { toast, closeAllOverlays } from './ui.js'

const app = document.getElementById('app')
let currentView = null
let currentDev = null
let currentKey = null

function isMock() {
  const p = new URLSearchParams(location.search)
  if (p.has('mock')) {
    const on = p.get('mock') !== '0'
    if (on !== settings.mock) updateSettings({ mock: on })
    return on
  }
  // file:// ne peut de toute façon pas charger les modules ESM ; si on y arrive
  // quand même (WebView embarquée), il n'y a aucun daemon joignable : mock.
  if (location.protocol === 'file:') return true
  return settings.mock === true
}

function navigate(hash) {
  if (location.hash === hash) render()
  else location.hash = hash
}

function render() {
  closeAllOverlays()
  currentView?.destroy?.()
  currentDev?.destroy?.()
  currentView = null
  currentDev = null
  clear(app)

  const route = parseRoute(location.hash)
  currentKey = route.name === 'thread' ? store.key(route.machineId, route.threadId) : null

  const view = route.name === 'thread'
    ? ThreadView({ key: currentKey, navigate })
    : ThreadsView({ navigate })

  currentView = view
  app.append(view.el)
  currentDev = DevBar({ currentKey: () => currentKey })
  app.append(currentDev.el)

  if (route.name === 'thread') updateSettings({ lastThread: currentKey })
}

function parseRoute(hash) {
  const m = /^#\/t\/([^/]+)\/(.+)$/.exec(hash || '')
  if (m) return { name: 'thread', machineId: decodeURIComponent(m[1]), threadId: decodeURIComponent(m[2]) }
  return { name: 'threads' }
}

function boot() {
  applyTheme(settings.theme)

  const mock = isMock()
  store.init({ mock })

  store.on('error', (err) => {
    toast(err.message || err.code || 'erreur daemon', { level: 'error' })
  })

  // Nouvelle session créée dans Zed : on l'ouvre tout de suite.
  store.on('thread_created', ({ machineId, threadId }) => {
    navigate(`#/t/${machineId}/${threadId}`)
  })

  window.addEventListener('hashchange', render)
  render()

  // Retour au premier plan : on réveille les liens plutôt que d'attendre le backoff.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') store.refreshAll()
  })
  window.addEventListener('online', () => store.refreshAll())

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('[sw]', err))
  }

  // Sonde de test : permet de piloter la PWA depuis un script (voir test/e2e).
  window.ZRA = { store, navigate, render, settings, mock }
  if (mock) console.info('[ZRA] mode mock — daemon simulé, aucun Zed requis')
}

boot()
