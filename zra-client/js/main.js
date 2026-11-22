// Amorçage : thème, transport (réel ou mock), routeur.

import { h, clear, revealScrollbar } from './dom.js'
import { settings, applyTheme, applyTextScale, detectRelayMode, detectDaemonOrigin, update as updateSettings } from './settings.js'
import * as store from './store.js'
import { ThreadsView } from './views/threads.js'
import { ThreadView } from './views/thread.js'
import { NewThreadView } from './views/new-thread.js'
import { DevBar } from './views/devbar.js'
import { toast, closeAllOverlays } from './ui.js'
import { syncPush } from './push.js'
import { tr, lang } from './i18n.js'

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
    : route.name === 'new-thread'
      ? NewThreadView({ machineId: route.machineId, navigate })
      : ThreadsView({ navigate })

  currentView = view
  app.append(view.el)
  // Ce qui dépend de la mise en page (défilement) attend que la vue soit dans le document.
  view.mounted?.()
  currentDev = DevBar({ currentKey: () => currentKey })
  app.append(currentDev.el)

  if (route.name === 'thread') {
    updateSettings({ lastThread: currentKey })
    syncPush() // le push suit le poste du thread ouvert
  }
}

function parseRoute(hash) {
  const m = /^#\/t\/([^/]+)\/(.+)$/.exec(hash || '')
  if (m) return { name: 'thread', machineId: decodeURIComponent(m[1]), threadId: decodeURIComponent(m[2]) }
  const n = /^#\/new\/([^/]+)$/.exec(hash || '')
  if (n) return { name: 'new-thread', machineId: decodeURIComponent(n[1]) }
  return { name: 'threads' }
}

async function boot() {
  applyTheme(settings.theme)
  applyTextScale()
  // Mode auto (aucun choix manuel) : le thème suit le navigateur, y compris
  // ses changements en cours de session. Un choix manuel fige le thème.
  globalThis.matchMedia?.('(prefers-color-scheme: dark)')
    ?.addEventListener('change', () => { if (!settings.theme) applyTheme(null) })
  document.documentElement.lang = lang

  const mock = isMock()
  // Mode relais (PWA servie par zra-relay) : détecté avant de construire les
  // postes — la saisie d'une IP devient une route `/to/<ip>` sur l'origine.
  // Puis marqueur daemon : servi par lui, le poste implicite est cette origine
  // (tout port), plus une hypothèse de port.
  if (!mock) await detectRelayMode()
  if (!mock) await detectDaemonOrigin()
  store.init({ mock: mock ? (await import('./mock/mock-link.js')).MockLink : null })

  store.on('error', (err) => {
    // Erreur d'agent détaillée : le callout du thread la rend, pas un toast.
    // Échec de création routé vers l'écran de création (`handled`) : de même.
    if (err.details || err.handled) return
    toast(err.message || err.code || tr`Erreur daemon.`, { level: 'error' })
  })

  // Un poste passe en ligne : (ré)abonnement push si l'utilisateur l'a activé.
  store.on('machines', () => { syncPush() })

  // Nouvelle session créée dans Zed : on l'ouvre si on est sur son écran de
  // création ; sinon seulement si aucune création n'était suivie (recharge
  // pendant la création) — pas de focus volé si l'utilisateur est parti ailleurs.
  store.on('thread_created', ({ machineId, threadId, pending }) => {
    const route = parseRoute(location.hash)
    const onCreating = route.name === 'new-thread' && route.machineId === machineId
    if (onCreating || !pending) navigate(`#/t/${machineId}/${threadId}`)
  })

  window.addEventListener('hashchange', render)
  render()

  // Copier d'un bloc de code (bouton au survol / au tap), par délégation : le
  // markdown est repeint pendant le streaming, les boutons ne survivent pas.
  document.addEventListener('click', (ev) => {
    const btn = ev.target.closest?.('.cb-copy')
    if (!btn) return
    const pre = btn.closest('.codeblock')?.querySelector('pre')
    if (!pre) return
    navigator.clipboard?.writeText(pre.textContent).then(
      () => toast(tr`Copié`),
      () => toast(tr`Copie impossible.`, { level: 'error' }),
    )
  })

  // Scrollbar auto-masquée comme Zed : révélée au scroll, retirée après 1 s
  // de repos (le fondu est en CSS). Capture : l'événement scroll ne bulle pas.
  // Les éléments marqués sbGestures (fil du thread) se révèlent sur geste :
  // leur tail-following déclenche `scroll` à chaque chunk de l'agent.
  document.addEventListener('scroll', (ev) => {
    const el = ev.target
    if (!el || el.nodeType !== 1 || 'sbGestures' in el.dataset) return
    revealScrollbar(el)
  }, { capture: true, passive: true })

  // Retour au premier plan : on réveille les liens plutôt que d'attendre le backoff.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') store.refreshAll()
  })
  // Réseau revenu : la pile vient de changer (route, tunnel), les tentatives
  // immédiates échouent en quelques ms — on laisse le chemin s'établir.
  window.addEventListener('online', () => setTimeout(() => store.refreshAll(), 1000))

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('[sw]', err))
  }

  // Sonde de test : permet de piloter la PWA depuis un script (voir test/e2e).
  window.ZRA = { store, navigate, render, settings, mock }
  if (mock) console.info(tr`[ZRA] mode mock — daemon simulé, aucun Zed requis`)
}

await boot()
