// Service worker : coquille de cache (v1) + Web Push (fin de tour, `push.js`).
// Réseau d'abord partout (coquille comprise), cache en repli hors tunnel.

const VERSION = 'zra-v12'
/** Au-delà, le réseau est tenu pour absent (hors tunnel) : on sert le cache. */
const NETWORK_TIMEOUT_MS = 3000
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/favicon-32.png',
  './icons/apple-touch-icon.png',
  './icons/icon-192.png',
  './icons/icon-maskable.png',
  './icons/badge.png',
  './sounds/agent_done.wav',
  './css/themes.css',
  './css/app.css',
  './fonts/IBMPlexSans-Regular.ttf',
  './fonts/IBMPlexSans-Italic.ttf',
  './fonts/IBMPlexSans-SemiBold.ttf',
  './fonts/Lilex-Regular.ttf',
  './fonts/Lilex-Bold.ttf',
  './js/main.js',
  './js/theme-boot.js',
  './js/i18n.js',
  './js/en.js',
  './js/dom.js',
  './js/icons.js',
  './js/file-icons.js',
  './js/file-icons-data.js',
  './js/format.js',
  './js/elicitation.js',
  './js/markdown.js',
  './js/diff.js',
  './js/acp.js',
  './js/link.js',
  './js/store.js',
  './js/settings.js',
  './js/settings-window.js',
  './js/themes.js',
  './js/agent-icons.js',
  './js/ui.js',
  './js/push.js',
  './js/sound.js',
  './js/callout.js',
  './js/completion.js',
  './js/editor.js',
  './js/mentions.js',
  './js/views/threads.js',
  './js/views/thread.js',
  './js/views/entry.js',
  './js/views/bottombar.js',
  './js/views/settings.js',
  './js/views/machine-settings.js',
  './js/views/devbar.js',
  './js/views/new-session.js',
  './js/views/new-thread.js',
  './js/views/new-project.js',
  './js/views/pair.js',
]

self.addEventListener('install', (ev) => {
  ev.waitUntil(
    caches.open(VERSION)
      .then((c) => Promise.allSettled(SHELL.map((u) => c.add(u))))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (ev) => {
  ev.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (ev) => {
  const req = ev.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.pathname.endsWith('/ws') || url.origin !== self.location.origin) return

  // Réseau d'abord, cache en repli. Servir la coquille depuis le cache mélangerait,
  // après une mise à jour, des modules d'avant et d'après : des imports qui ne
  // correspondent plus, une app cassée jusqu'au rechargement suivant. Hors du
  // tunnel, le réseau ne répond pas : au bout de 3 s, le cache prend le relais.
  ev.respondWith((async () => {
    const cache = await caches.open(VERSION)
    try {
      const res = await fetch(req, { signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS) })
      if (res.ok) cache.put(req, res.clone())
      return res
    } catch {
      return (await cache.match(req)) || Response.error()
    }
  })())
})

// Web Push : le daemon envoie une notification de fin de tour (`push.js`),
// le clic ouvre le thread.
self.addEventListener('push', (ev) => {
  let data = {}
  try { data = ev.data?.json() || {} } catch { data = { body: ev.data?.text() } }
  if (!data.title) return
  ev.waitUntil(self.registration.showNotification(data.title, {
    body: data.body || '',
    icon: './icons/icon-192.png',
    badge: './icons/badge.png',
    data: { url: data.url || './' },
    tag: data.tag,
  }))
})

self.addEventListener('notificationclick', (ev) => {
  ev.notification.close()
  // Base = scope, pas le script : une URL fragment seul (`#/t/…`) se résoudrait
  // sinon sur `sw.js#/t/…` et le navigateur afficherait le source du worker.
  const url = new URL(ev.notification.data?.url || './', self.registration.scope).href
  ev.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) if ('focus' in c) { c.navigate(url); return c.focus() }
    return self.clients.openWindow(url)
  }))
})
