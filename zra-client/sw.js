// Service worker : coquille de cache (v1) + point d'ancrage Web Push, inactif.
// Réseau d'abord partout (coquille comprise), cache en repli hors tunnel.

const VERSION = 'zra-v2'
/** Au-delà, le réseau est tenu pour absent (hors tunnel) : on sert le cache. */
const NETWORK_TIMEOUT_MS = 3000
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon.svg',
  './css/themes.css',
  './css/app.css',
  './js/main.js',
  './js/dom.js',
  './js/icons.js',
  './js/format.js',
  './js/markdown.js',
  './js/diff.js',
  './js/acp.js',
  './js/link.js',
  './js/store.js',
  './js/settings.js',
  './js/themes.js',
  './js/agent-icons.js',
  './js/ui.js',
  './js/views/threads.js',
  './js/views/thread.js',
  './js/views/entry.js',
  './js/views/settings.js',
  './js/views/devbar.js',
  './js/views/new-session.js',
  './js/views/pair.js',
  './js/mock/mock-link.js',
  './js/mock/scenarios.js',
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

// Web Push : câblé, inactif en v1 (§8). Le daemon n'envoie rien pour l'instant.
self.addEventListener('push', (ev) => {
  let data = {}
  try { data = ev.data?.json() || {} } catch { data = { body: ev.data?.text() } }
  if (!data.title) return
  ev.waitUntil(self.registration.showNotification(data.title, {
    body: data.body || '',
    icon: './icon.svg',
    badge: './icon.svg',
    data: { url: data.url || './' },
    tag: data.tag,
  }))
})

self.addEventListener('notificationclick', (ev) => {
  ev.notification.close()
  const url = ev.notification.data?.url || './'
  ev.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) if ('focus' in c) { c.navigate(url); return c.focus() }
    return self.clients.openWindow(url)
  }))
})
