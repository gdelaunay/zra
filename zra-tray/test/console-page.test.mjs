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
    return json({ ok: false, error: 'inattendu : ' + path })
  }
}

async function loadPage(state) {
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