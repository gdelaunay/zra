// La page d'onboarding du tray (zra-tray/src/onboarding.html), dans un DOM
// headless : la ligne « Installer sur ce poste » (5.7) — visible en layout
// archive, cochée par défaut, masquée en layout dépôt ; le payload /done
// porte le choix. Le serveur Rust est simulé (mêmes réponses qu'onboarding.rs).
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

function fakeFetch(info) {
  return async (url, opts = {}) => {
    const path = String(url).split('?')[0]
    calls.push({ path, method: opts.method ?? 'GET', body: opts.body ? JSON.parse(opts.body) : null })
    const json = (v) => ({ json: async () => v })
    if (path === '/info') return json(info)
    if (path === '/discover') return json({ ok: true, discover: { zed: { settingsExists: true, channel: 'stable', cli: 'zed' }, agents: [{ id: 'claude-acp', ok: true, source: 'npx' }], wayland: false, autostart: { backend: 'schtasks', installed: false } } })
    if (path === '/done') return json({ ok: true, steps: [], installed: info.appLayout ? 'C:/local/Programs/zra' : null })
    return json({ ok: false, error: 'inattendu : ' + path })
  }
}

async function loadPage(info, i18n) {
  dom?.window?.close()
  const html = (await readFile(join(ROOT, 'src', 'onboarding.html'), 'utf8'))
    .replace('<!--logo-->', '<svg></svg>')
  dom = new JSDOM(html, {
    url: 'http://127.0.0.1:9999/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window) {
      window.fetch = fakeFetch(info)
      window.confirm = () => true
      if (i18n) window.ZRA_I18N = i18n
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

const NODE_INFO = { node: { path: 'C:/nodejs/node.exe', version: 'v24.1.0' } }

test('ligne « Installer sur ce poste » : layout archive, cochée par défaut, emplacement affiché', async () => {
  const win = await loadPage({ ...NODE_INFO, appLayout: true, installTarget: 'C:/local/Programs/zra' })
  const $ = (id) => win.document.getElementById(id)
  await until(() => !$('install-row').classList.contains('hidden'))
  assert.ok($('install').checked, 'cochée par défaut (décision de distribution)')
  assert.match($('install-desc').textContent, /C:\/local\/Programs\/zra/)
  // La ligne est dans la liste principale, pas dans les réglages avancés.
  assert.ok(!$('install-row').closest('#custom-settings'), 'pas repliée avec les réglages avancés')
})

test('layout dépôt : pas de ligne d’installation', async () => {
  const win = await loadPage({ ...NODE_INFO, appLayout: false, installTarget: null })
  const $ = (id) => win.document.getElementById(id)
  await until(() => $('node-version').textContent.includes('v24.1.0'))
  assert.ok($('install-row').classList.contains('hidden'))
})

test('payload /done : install true si coché, false si décoché', async () => {
  const win = await loadPage({ ...NODE_INFO, appLayout: true, installTarget: 'C:/local/Programs/zra' })
  const $ = (id) => win.document.getElementById(id)
  await until(() => !$('start').disabled)
  calls.length = 0
  $('start').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
  await until(() => calls.some((c) => c.path === '/done'))
  assert.equal(calls.find((c) => c.path === '/done').body.install, true)
  await until(() => !$('done').classList.contains('hidden'))
  assert.match($('done').textContent, /installé dans C:\/local\/Programs\/zra/)
  dom.window.close()

  // Décoché : portable, install false.
  const win2 = await loadPage({ ...NODE_INFO, appLayout: true, installTarget: 'C:/local/Programs/zra' })
  const $2 = (id) => win2.document.getElementById(id)
  await until(() => !$2('start').disabled)
  $2('install').checked = false
  $2('install').dispatchEvent(new win2.Event('change', { bubbles: true }))
  calls.length = 0
  $2('start').dispatchEvent(new win2.MouseEvent('click', { bubbles: true }))
  await until(() => calls.some((c) => c.path === '/done'))
  assert.equal(calls.find((c) => c.path === '/done').body.install, false)
})

test('portable mémorisé (setup.json) : case décochée par défaut, payload install false', async () => {
  const win = await loadPage({ ...NODE_INFO, appLayout: true, installTarget: 'C:/local/Programs/zra', portable: true })
  const $ = (id) => win.document.getElementById(id)
  await until(() => !$('install-row').classList.contains('hidden'))
  assert.ok(!$('install').checked, 'le choix portable mémorisé décoche la case')
  await until(() => !$('start').disabled)
  calls.length = 0
  $('start').dispatchEvent(new win.MouseEvent('click', { bubbles: true }))
  await until(() => calls.some((c) => c.path === '/done'))
  assert.equal(calls.find((c) => c.path === '/done').body.install, false)
})

test('i18n : catalogue injecté (en) → texte statique traduit', async () => {
  const en = {
    'Configuration initiale': 'Initial setup',
    'Enregistrer et démarrer': 'Save and start',
    'Installer sur ce poste': 'Install on this machine',
  }
  const win = await loadPage({ ...NODE_INFO, appLayout: true, installTarget: 'C:/local/Programs/zra' }, { lang: 'en', en })
  const $ = (id) => win.document.getElementById(id)
  await until(() => !$('install-row').classList.contains('hidden'))
  assert.equal(win.document.documentElement.lang, 'en')
  assert.equal(win.document.querySelector('.sw-pagetitle').textContent, 'Initial setup')
  assert.equal($('start').textContent, 'Save and start')
  assert.equal(win.document.querySelector('#install-row .srow-title').textContent, 'Install on this machine')
})