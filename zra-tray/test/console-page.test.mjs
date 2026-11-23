// La page de console du tray (zra-tray/src/console.html), dans un DOM headless :
// rendu de l'état, actions. Le serveur Rust est simulé par un fetch bouchonné —
// mêmes réponses que console.rs (state_json, /logs, /autostart, /restart).
// Français seulement (outil de dev).

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { JSDOM } from 'jsdom'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

let dom
const calls = []

const STATE = {
  mode: 'poste', run: 'running', adopted: false, up: true,
  url: 'http://127.0.0.1:7777', live: 2, clients: 1,
  version: '0.6.0', trayVersion: '0.6.0-dev',
  node: 'C:/nodejs/node.exe', port: 7777,
  relay: { port: 7777, host: '0.0.0.0', tlsCert: null, tlsKey: null },
  root: 'C:/zra', logFile: 'C:/zra/.zra/logs/daemon.log',
}

// Layout dépôt par défaut : pas d'update par le tray (flux contributeur).
let UPDATE = {
  supported: false, autoUpdate: true, current: '0.6.0',
  pending: null, latest: null, lastCheck: null, error: null,
}

function fakeFetch(state) {
  return async (url, opts = {}) => {
    const path = String(url).split('?')[0]
    const method = opts.method ?? 'GET'
    calls.push({ path, method, body: opts.body ? JSON.parse(opts.body) : null })
    const json = (v) => ({ json: async () => v })
    if (path === '/state') return json(state)
    if (path === '/logs') return json({ ok: true, lines: ['ligne un', 'ligne deux'] })
    if (path === '/autostart') return json(method === 'POST' ? { ok: true } : { ok: true, autostart: { backend: 'schtasks', installed: true } })
    if (path === '/restart') return json({ ok: true })
    if (path === '/mode') return json({ ok: true })
    if (path === '/open-logs') return json({ ok: true })
    if (path === '/quit') return json({ ok: true })
    if (path === '/update') return json(UPDATE)
    if (path === '/update/check') return json({ ...UPDATE, latest: '0.7.0', pending: '0.7.0', lastCheck: '1700000000' })
    if (path === '/update/toggle') return json({ ok: true })
    if (path === '/update/apply') return json({ ok: true })
    if (path === '/uninstall') return json({ ok: true, steps: [{ label: 'Dé-câblage de Zed', ok: true, output: 'retiré' }], exported: null, removed: 'C:/zra' })
    if (path === '/install') return json({ ok: true, steps: [{ label: 'Agents Zed (recâblage)', ok: true, output: 'recâblé' }], target: 'C:/local/Programs/zra' })
    return json({ ok: false, error: 'inattendu : ' + path })
  }
}

async function loadPage(state, i18n) {
  dom?.window?.close() // les setInterval de la page précédente ne doivent pas survivre
  const html = (await readFile(join(ROOT, 'src', 'console.html'), 'utf8'))
    .replace('<!--logo-->', '<svg></svg>')
  dom = new JSDOM(html, {
    url: 'http://127.0.0.1:9999/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.fetch = fakeFetch(state)
      window.confirm = () => true
      if (i18n) window.ZRA_I18N = i18n
      window.addEventListener('error', (ev) => { throw ev.error ?? new Error(ev.message) })
    },
  })
  return dom.window
}

const until = async (pred, ms = 3000) => {
  const t0 = Date.now()
  for (;;) {
    let v
    try { v = pred() } catch { v = false }
    if (v) return v
    if (Date.now() - t0 > ms) throw new Error('condition jamais atteinte')
    await new Promise((r) => setTimeout(r, 20))
  }
}

after(() => dom?.window?.close())

test('état rendu : badge, URL, versions, mode, autostart, journal', async () => {
  const win = await loadPage(STATE)
  const $ = (id) => win.document.getElementById(id)
  await until(() => $('about-version').textContent === '0.6.0')
  assert.equal($('svc-badge').textContent, '✓ en ligne')
  assert.match($('svc-desc').textContent, /http:\/\/127\.0\.0\.1:7777/)
  assert.match($('svc-desc').textContent, /2 thread\(s\) en cours/)
  assert.equal($('open-zra').href, 'http://127.0.0.1:7777/')
  assert.equal($('about-tray').textContent, '0.6.0-dev')
  assert.equal($('about-root').textContent, 'C:/zra')
  assert.equal($('about-node').textContent, 'C:/nodejs/node.exe')
  assert.ok(win.document.querySelector('#mode button[data-v="poste"]').classList.contains('selected'))
  await until(() => $('autostart').checked && !$('autostart').disabled)
  assert.match($('autostart-desc').textContent, /schtasks/)
  await until(() => $('log-view').textContent.includes('ligne deux'))
  assert.equal($('log-path').textContent, 'C:/zra/.zra/logs/daemon.log')
})

test('redémarrer : POST /restart puis retour d’état, bannière de succès', async () => {
  const win = await loadPage(STATE)
  const $ = (id) => win.document.getElementById(id)
  await until(() => $('about-version').textContent === '0.6.0')
  calls.length = 0
  $('restart').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
  await until(() => calls.some((c) => c.path === '/restart' && c.method === 'POST'))
  await until(() => !$('ok-banner').classList.contains('hidden'))
  assert.match($('ok-text').textContent, /redémarré/i)
  await until(() => calls.some((c) => c.path === '/state'))
})

test('service externe (adopté) : redémarrer et bascule désactivés', async () => {
  const win = await loadPage({ ...STATE, adopted: true, run: 'adopted' })
  const $ = (id) => win.document.getElementById(id)
  await until(() => $('about-version').textContent === '0.6.0')
  assert.ok($('restart').disabled)
  assert.ok(win.document.querySelector('#mode button[data-v="relais"]').disabled)
  assert.match($('svc-desc').textContent, /service externe/)
})

test('service arrêté : badge ✗, pas de lien Ouvrir ZRA', async () => {
  const win = await loadPage({ ...STATE, up: false, run: 'stopped', url: undefined })
  const $ = (id) => win.document.getElementById(id)
  await until(() => $('svc-badge').textContent === '✗ arrêté')
  assert.ok($('open-zra').classList.contains('hidden'))
})

test('bascule de mode : confirmation puis POST /mode', async () => {
  const win = await loadPage(STATE)
  const $ = (id) => win.document.getElementById(id)
  await until(() => $('about-version').textContent === '0.6.0')
  calls.length = 0
  win.document.querySelector('#mode button[data-v="relais"]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
  await until(() => calls.some((c) => c.path === '/mode' && c.method === 'POST'))
  assert.deepEqual(calls.find((c) => c.path === '/mode').body, { mode: 'relais' })
  // Le handler finit par refresh() + loadLogs() : les attendre avant de clore,
  // sinon leur activité async survit au test (window.close() dans after).
  await until(() => calls.some((c) => c.path === '/state'))
  await until(() => calls.some((c) => c.path === '/logs'))
})
test('updates : layout dépôt → message git, contrôles masqués', async () => {
  UPDATE = { supported: false, autoUpdate: true, current: '0.6.0', pending: null, latest: null, lastCheck: null, error: null }
  const win = await loadPage(STATE)
  const $ = (id) => win.document.getElementById(id)
  await until(() => $('about-version').textContent === '0.6.0')
  await until(() => !$('update-git').classList.contains('hidden'))
  assert.ok($('update-block').classList.contains('hidden'))
  assert.match($('update-git').textContent, /git/)
})

test('updates : pending → bouton installer, statut, toggle et vérifier', async () => {
  UPDATE = { supported: true, autoUpdate: true, current: '0.6.0', pending: null, latest: '0.6.0', lastCheck: null, error: null }
  const win = await loadPage(STATE)
  const $ = (id) => win.document.getElementById(id)
  await until(() => $('about-version').textContent === '0.6.0')
  await until(() => !$('update-block').classList.contains('hidden'))
  assert.ok($('auto-update').checked, 'auto activé par défaut')
  assert.ok($('update-apply').classList.contains('hidden'), 'pas de pending : pas de bouton installer')
  assert.match($('update-status').textContent, /À jour/)

  // Toggle : POST avec l'état inversé.
  calls.length = 0
  $('auto-update').checked = false
  $('auto-update').dispatchEvent(new win.Event('change', { bubbles: true }))
  await until(() => calls.some((c) => c.path === '/update/toggle'))
  assert.deepEqual(calls.find((c) => c.path === '/update/toggle').body, { enabled: false })

  // Vérifier : le fake renvoie un pending → bouton installer visible.
  $('update-check').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
  await until(() => !$('update-apply').classList.contains('hidden'))
  assert.match($('update-status').textContent, /0\.7\.0 prête/)
  assert.match($('ok-text').textContent, /téléchargée/)
})

test('désinstallation : panneau, deux choix, étapes rendues', async () => {
  const win = await loadPage({ ...STATE, appLayout: true })
  const $ = (id) => win.document.getElementById(id)
  await until(() => $('about-version').textContent === '0.6.0')
  assert.ok($('uninstall-panel').classList.contains('hidden'), 'panneau caché au repos')
  $('uninstall').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
  assert.ok(!$('uninstall-panel').classList.contains('hidden'), 'panneau de confirmation ouvert')
  $('uninstall-cancel').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
  assert.ok($('uninstall-panel').classList.contains('hidden'), 'annuler referme')

  calls.length = 0
  $('uninstall').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
  $('uninstall-keep').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
  await until(() => calls.some((c) => c.path === '/uninstall'))
  assert.deepEqual(calls.find((c) => c.path === '/uninstall').body, { keepSettings: true })
  await until(() => $('uninstall-steps').textContent.includes('Dé-câblage de Zed'))
  assert.match($('ok-text').textContent, /Désinstallation terminée/)

  // Tout désinstaller : keepSettings false.
  calls.length = 0
  $('uninstall').disabled = false
  $('uninstall').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
  $('uninstall-all').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
  await until(() => calls.some((c) => c.path === '/uninstall'))
  assert.deepEqual(calls.find((c) => c.path === '/uninstall').body, { keepSettings: false })
})

test('désinstallation en layout dépôt : le dossier cloné est conservé (dit)', async () => {
  const win = await loadPage({ ...STATE, appLayout: false })
  const $ = (id) => win.document.getElementById(id)
  await until(() => $('about-version').textContent === '0.6.0')
  await until(() => /dossier cloné/.test($('uninstall-desc').textContent))
})

test('self-install : bouton en layout app non installé, POST /install, étapes', async () => {
  const win = await loadPage({ ...STATE, appLayout: true, installed: false, installTarget: 'C:/local/Programs/zra' })
  const $ = (id) => win.document.getElementById(id)
  await until(() => $('about-version').textContent === '0.6.0')
  await until(() => !$('install-row').classList.contains('hidden'))
  assert.ok(!$('install-btn').classList.contains('hidden'))
  assert.match($('install-desc').textContent, /C:\/local\/Programs\/zra/)
  calls.length = 0
  $('install-btn').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
  await until(() => calls.some((c) => c.path === '/install' && c.method === 'POST'))
  await until(() => $('install-steps').textContent.includes('recâblage'))
  assert.match($('ok-text').textContent, /installé/)
})

test('self-install : installé → pas de bouton, emplacement affiché ; dépôt → section masquée', async () => {
  const win = await loadPage({ ...STATE, appLayout: true, installed: true, installTarget: 'C:/local/Programs/zra' })
  const $ = (id) => win.document.getElementById(id)
  await until(() => $('about-version').textContent === '0.6.0')
  await until(() => $('install-title').textContent === 'Installé sur ce poste')
  assert.ok($('install-btn').classList.contains('hidden'), 'pas de retour arrière')
  assert.match($('install-desc').textContent, /désinstallation/)
  dom.window.close()

  const win2 = await loadPage({ ...STATE, appLayout: false })
  const $2 = (id) => win2.document.getElementById(id)
  await until(() => $2('about-version').textContent === '0.6.0')
  assert.ok($2('install-row').classList.contains('hidden'), 'layout dépôt : pas de self-install')
})

test('i18n : catalogue injecté (en) → texte statique et chaînes JS traduits', async () => {
  const en = {
    'Console de gestion': 'Management console',
    'Ouvrir ZRA': 'Open ZRA',
    'Poste': 'Machine',
    '✓ en ligne': '✓ online',
    ' — {0} thread(s) en cours, {1} client(s)': ' — {0} active thread(s), {1} client(s)',
  }
  const win = await loadPage(STATE, { lang: 'en', en })
  const $ = (id) => win.document.getElementById(id)
  await until(() => $('about-version').textContent === '0.6.0')
  assert.equal(win.document.documentElement.lang, 'en')
  assert.equal(win.document.querySelector('.sw-pagetitle').textContent, 'Management console')
  assert.equal($('open-zra').textContent, 'Open ZRA')
  assert.equal($('svc-badge').textContent, '✓ online')
  assert.match($('svc-desc').textContent, /Machine : http:\/\/127\.0\.0\.1:7777/)
  assert.match($('svc-desc').textContent, /2 active thread\(s\), 1 client\(s\)/)
})
