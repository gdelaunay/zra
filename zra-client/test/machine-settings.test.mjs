// Les réglages d'un poste (`js/views/machine-settings.js`) : garde éveillé,
// dans la fenêtre style Zed, DOM headless, store en mode mock. Ce qui compte :
// le choix part au daemon (`set_keep_awake`), l'état affiché vient du
// `keep_awake` reçu (jamais d'optimisme), la fenêtre se repeint vivante et
// reste ouverte au choix (comme Zed : écriture immédiate).

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const dom = new JSDOM(await readFile(join(ROOT, 'index.html'), 'utf8'), {
  url: 'http://localhost:7777/?mock=1',
  pretendToBeVisual: true,
})
const win = dom.window
const doc = win.document
for (const k of ['window', 'document', 'location', 'localStorage', 'navigator', 'getComputedStyle',
  'HTMLElement', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'requestAnimationFrame', 'cancelAnimationFrame']) {
  Object.defineProperty(globalThis, k, { value: win[k], configurable: true, writable: true })
}
globalThis.WebSocket = win.WebSocket

const store = await import('../js/store.js')
const settingsModule = await import('../js/settings.js')
const { openMachineSettings, awakeLabel } = await import('../js/views/machine-settings.js')
const { closeAllOverlays } = await import('../js/ui.js')

const { MockLink } = await import('../js/mock/mock-link.js')
store.init({ mock: MockLink })
settingsModule.update({ mock: true })

after(() => {
  closeAllOverlays()
  for (const id of [...store.state.machines.keys()]) store.dropMachine(id)
  dom.window.close()
})

const $ = (sel) => doc.querySelector(sel)
const $$ = (sel, root = doc) => [...root.querySelectorAll(sel)]
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
// mock-laptop : pas de scénario automatique, l'état reste stable pour les assertions.
const laptop = () => store.state.machines.get('mock-laptop')

test('la fenêtre s’ouvre sur le garde éveillé, cinq modes dans le dropdown, off coché', async () => {
  await wait(400)
  closeAllOverlays()
  const w = openMachineSettings(laptop())
  assert.equal(w.querySelector('.sw-title').textContent, laptop().info.name)
  assert.equal($('.sw-pagetitle', w).textContent, 'Garde éveillé')
  assert.equal($('.sw-nav', w).classList.contains('hidden'), true, 'une seule page sans sections : pas de nav')
  const dropdown = $('.dropdown', w)
  assert.equal(dropdown.querySelector('span').textContent, 'Off')
  dropdown.click()
  const items = $$('.menu__item')
  assert.deepEqual(items.map((i) => i.textContent.trim()), ['Off', '1 heure', '4 heures', '12 heures', "Jusqu'à désactivation"])
  assert.equal(items[0].classList.contains('menu__item--on'), true)
  closeAllOverlays()
})

test('choisir 1 heure : la bascule part, l’état revient du daemon, la fenêtre reste ouverte', async () => {
  closeAllOverlays()
  const w = openMachineSettings(laptop())
  const sent = []
  const send = laptop().link.send.bind(laptop().link)
  laptop().link.send = (msg) => { sent.push(msg); return send(msg) }
  try {
    $('.dropdown', w).click()
    $$('.menu__item').find((i) => i.textContent.includes('1 heure')).click()
    assert.deepEqual(sent, [{ type: 'set_keep_awake', mode: '1h' }])
    assert.ok($('.swindow'), 'la fenêtre reste ouverte au choix (écriture immédiate, comme Zed)')
    await wait(120)
    const ka = laptop().keepAwake
    assert.equal(ka.mode, '1h')
    assert.equal(ka.active, true)
    assert.equal(ka.reason, 'manual')
    assert.ok(ka.until > Date.now())
    // Le keep_awake reçu a repeint la fenêtre : libellé et statut à jour.
    assert.equal($('.dropdown', w).querySelector('span').textContent, '1 heure')
    assert.match($('.machine-awake-status', w).textContent, /restantes/)
  } finally {
    laptop().link.send = send
  }
})

test('la fenêtre ouverte se repeint au keep_awake reçu (fin de tour, expiration)', async () => {
  closeAllOverlays()
  laptop().link.emit('message', { type: 'keep_awake', mode: 'off', until: null, active: false, reason: null, supported: true })
  const w = openMachineSettings(laptop())
  assert.equal($('.machine-awake-status', w), null)
  laptop().link.emit('message', { type: 'keep_awake', mode: 'on', until: null, active: true, reason: 'turn', supported: true })
  assert.match($('.machine-awake-status', w).textContent, /Un agent travaille/)
  laptop().link.emit('message', { type: 'keep_awake', mode: 'off', until: null, active: false, reason: null, supported: true })
  assert.equal($('.machine-awake-status', w), null)
  closeAllOverlays()
})

test('le TTL de la fenêtre se met à jour chaque seconde', (t) => {
  closeAllOverlays()
  const m = laptop()
  const ka = m.keepAwake
  const now = Date.now()
  m.keepAwake = { active: true, supported: true, mode: '1h', reason: 'manual', until: now + 3_600_000 }
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now })
  try {
    const w = openMachineSettings(m)
    const text = $('.machine-awake-status span', w)
    assert.match(text.textContent, /restantes/)
    const before = text.textContent
    t.mock.timers.tick(2000)
    assert.notEqual(text.textContent, before, 'le décompte avance sans événement daemon')
    closeAllOverlays()
  } finally {
    m.keepAwake = ka
  }
})

test('poste sans mécanisme : le dire, ne pas proposer de réglage', async () => {
  closeAllOverlays()
  laptop().link.emit('message', { type: 'keep_awake', mode: 'off', until: null, active: false, reason: null, supported: false })
  const w = openMachineSettings(laptop())
  assert.match(w.textContent, /ne sait pas empêcher la veille/)
  assert.equal($('.dropdown', w), null)
  closeAllOverlays()
})

test('poste ancien (pas de keep_awake) : indisponible, sans plante', () => {
  closeAllOverlays()
  const m = laptop()
  const ka = m.keepAwake
  m.keepAwake = null
  try {
    const w = openMachineSettings(m)
    assert.match(w.textContent, /Garde éveillé indisponible/)
    closeAllOverlays()
  } finally {
    m.keepAwake = ka
  }
})

test('awakeLabel : tour, durée restante, jusqu’à désactivation', () => {
  const now = 1_000_000
  assert.equal(awakeLabel({ active: false }, now), null)
  assert.match(awakeLabel({ active: true, reason: 'turn' }, now), /agent travaille/)
  assert.match(awakeLabel({ active: true, reason: 'manual', until: now + 3_600_000 }, now), /1 h 00 min restantes/)
  assert.match(awakeLabel({ active: true, reason: 'manual', until: null }, now), /jusqu'à désactivation/)
})
