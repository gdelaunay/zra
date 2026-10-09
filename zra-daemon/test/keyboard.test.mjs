// Backends clavier Linux (portage, étape 5) — `zra-daemon/zed/keyboard.js`.
//
// Rien ici ne touche au clavier réel : les sorties vers les outils (`exec`,
// `tool`) sont bouchonnées et enregistrent les appels, comme dans
// `lot-c.test.mjs`. Sous `node --test`, `run()` refuse de toute façon une
// recette non simulée (`refuseUnderTest`) — les tests d'orchestration passent
// donc par `execute()`, le garde-fou restant vérifié par ailleurs.
//
// Le backend Windows (`KeyboardRunner` / `keyboard.ps1`) est gelé : ses tests
// vivent dans `lot-c.test.mjs` et ne sont pas rejoués ici.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  KEY_NAMES, NoneKeyboard, XdotoolKeyboard,
  createKeyboard, defaultKeyboardRunner, parseChord, toX11Keysym,
} from '../zed/keyboard.js'
import { KeyboardRunner } from '../zed/driver.js'
import { KEYBOARD_BACKENDS } from '../platform.js'
import { loadConfig } from '../config.js'

// ---------------------------------------------------------------------------
// Fonctions pures : le vocabulaire des recettes, commun à tous les backends
// ---------------------------------------------------------------------------

test('parseChord : accords valides, dans le vocabulaire de keyboard.ps1', () => {
  assert.deepEqual(parseChord('ctrl+shift+p'), { tokens: ['ctrl', 'shift', 'p'], mods: ['ctrl', 'shift'], key: 'p' })
  assert.deepEqual(parseChord('Enter').mods, [])
  assert.equal(parseChord('ENTER').key, 'enter', 'insensible à la casse, comme Resolve-Chord')
  assert.equal(parseChord('ctrl+shift+P').key, 'p')
  assert.equal(parseChord('a').key, 'a')
  assert.equal(parseChord('f12').key, 'f12')
  assert.equal(parseChord('ctrl').key, null, 'modificateur seul : pas de touche (TapAlt du .ps1)')
  for (const name of ['backspace', 'escape', 'tab', 'space', 'pageup', 'pagedown', 'home', 'end', 'up', 'down']) {
    assert.ok(KEY_NAMES.has(name), name)
  }
})

test('parseChord : touche inconnue et accord mal formé sont refusés AVANT toute frappe', () => {
  assert.throws(() => parseChord('ctrl+touche-imaginaire'), /touche inconnue/)
  assert.throws(() => parseChord('ctrl++p'), /accord mal formé/)
  assert.throws(() => parseChord('+'), /accord mal formé/)
  assert.throws(() => parseChord('ctrl+enter+p'), /plusieurs touches/)
})

test('toX11Keysym : ce que `xdotool key` attend', () => {
  assert.equal(toX11Keysym('ctrl+shift+p'), 'ctrl+shift+p')
  assert.equal(toX11Keysym('enter'), 'Return')
  assert.equal(toX11Keysym('escape'), 'Escape')
  assert.equal(toX11Keysym('backspace'), 'BackSpace')
  assert.equal(toX11Keysym('pageup'), 'Page_Up')
  assert.equal(toX11Keysym('win+l'), 'super+l')
  assert.equal(toX11Keysym('f5'), 'f5', 'F1-F12 : keysyms X11 littéraux')
  assert.throws(() => toX11Keysym('ctrl+inconnu'), /touche inconnue/)
})

// ---------------------------------------------------------------------------
// Orchestration : le contrat de keyboard.ps1, côté Linux
// ---------------------------------------------------------------------------

/** XdotoolKeyboard dont chaque appel outil est enregistré, jamais exécuté. */
function stubXdotool({ active = '111', windows = [{ title: 'zra — driver.js', id: '111', pid: 4242 }] } = {}) {
  const k = new XdotoolKeyboard({ timeoutMs: 2000 })
  const calls = []
  k.exec = async (cmd, args) => {
    calls.push([cmd, ...args])
    if (cmd === 'pgrep') return '4242\n'
    if (cmd === 'xdotool' && args[0] === 'search') return windows.map((w) => w.id).join('\n') + '\n'
    if (cmd === 'xdotool' && args[0] === 'getwindowpid') return `${windows.find((w) => w.id === args[1])?.pid ?? 4242}\n`
    if (cmd === 'xdotool' && args[0] === 'getwindowname') return `${windows.find((w) => w.id === args[1])?.title ?? active}\n`
    if (cmd === 'xdotool' && args[0] === 'getactivewindow') return `${active}\n`
    return ''
  }
  return { k, calls }
}

test('xdotool : la cible est résolue et visée avant la première frappe', async () => {
  const { k, calls } = stubXdotool()
  const res = await k.execute({ op: 'run', steps: [{ keys: 'ctrl+shift+p' }, { text: 'bonjour' }, { wait: 5 }] })
  assert.equal(res.ok, true)
  assert.deepEqual(res.window, { title: 'zra — driver.js', pid: 4242, id: '111' })
  assert.deepEqual(res.log, ['fenêtre : zra — driver.js', 'touches ctrl+shift+p', 'texte (7 caractère(s))', 'attente 5 ms'],
    'mêmes libellés que keyboard.ps1')
  const order = calls.map((c) => c.slice(0, 2).join(' '))
  assert.ok(order.indexOf('xdotool windowactivate') < order.indexOf('xdotool key'), 'activation avant la première touche')
  assert.ok(order.includes('xdotool key'), 'accord envoyé')
  assert.ok(order.includes('xdotool type'), 'texte envoyé')
  assert.ok(calls.some((c) => c[0] === 'xdotool' && c[1] === 'type' && c.includes('--') && c.at(-1) === 'bonjour'),
    'le texte est séparé par -- (il peut commencer par « - »)')
})

test('xdotool : dryRun résout tout et n’envoie rien', async () => {
  const { k, calls } = stubXdotool()
  const res = await k.execute({ op: 'run', dryRun: true, steps: [{ keys: 'ctrl+shift+p' }, { text: 'x' }] })
  assert.equal(res.ok, true)
  assert.deepEqual(res.log[0], 'fenêtre : zra — driver.js')
  const typed = calls.filter((c) => c[0] === 'xdotool' && ['key', 'type', 'windowactivate', 'windowfocus'].includes(c[1]))
  assert.deepEqual(typed, [], 'aucune frappe, aucune activation')
})

test('xdotool : une étape invalide est refusée avant la résolution de la fenêtre', async () => {
  const { k, calls } = stubXdotool()
  await assert.rejects(
    () => k.execute({ op: 'run', steps: [{ keys: 'ctrl+shift+p' }, { keys: 'ctrl+faux' }] }),
    /touche inconnue/,
  )
  assert.deepEqual(calls, [], 'rien n’est lancé : ni pgrep, ni xdotool')
})

test('xdotool : le garde-fou — une AUTRE fenêtre au premier plan arrête net', async () => {
  const { k, calls } = stubXdotool({ active: '999' })
  await assert.rejects(
    () => k.execute({ op: 'run', steps: [{ keys: 'enter' }] }),
    (e) => /premier plan/.test(e.message) && /999|zra/.test(e.message),
  )
  assert.ok(!calls.some((c) => c[0] === 'xdotool' && c[1] === 'key'), 'aucune frappe envoyée ailleurs')
})

test('xdotool : pas de WM (Xvfb nu) — getactivewindow muet, la recette continue', async () => {
  const k = new XdotoolKeyboard({ timeoutMs: 2000 })
  const seen = []
  k.exec = async (cmd, args) => {
    seen.push([cmd, ...args])
    if (cmd === 'pgrep') return '7\n'
    if (args?.[0] === 'search') return '55\n'
    if (args?.[0] === 'getwindowpid') return '7\n'
    if (args?.[0] === 'getwindowname') return 'test\n'
    if (args?.[0] === 'getactivewindow') throw new Error('getactivewindow: no current window')
    return ''
  }
  const res = await k.execute({ op: 'run', steps: [{ keys: 'enter' }] })
  assert.equal(res.ok, true)
  assert.ok(seen.some((c) => c[0] === 'xdotool' && c[1] === 'key'), 'la frappe part : l’absence de WM n’est pas une fenêtre différente')
})

test('xdotool : le projet est reconnu sur le début du titre, comme Test-ProjectTitle', () => {
  const m = XdotoolKeyboard.matchesProject
  assert.equal(m('zra — driver.js', 'zra'), true)
  assert.equal(m('zra - driver.js', 'zra'), true)
  assert.equal(m('zra, 2 fichiers', 'zra'), true)
  assert.equal(m('zra', 'zra'), true)
  assert.equal(m('ZRA — x', 'zra'), true, 'insensible à la casse')
  assert.equal(m('zra-autre — x', 'zra'), false, 'pas de préfixe approximatif')
  assert.equal(m('autre — zra', 'zra'), false)
})

test('xdotool : aucune fenêtre Zed — erreur explicite, aucune frappe', async () => {
  const k = new XdotoolKeyboard({ timeoutMs: 2000 })
  k.exec = async (cmd) => { if (cmd === 'pgrep') throw new Error('rc=1') ; return '' }
  await assert.rejects(() => k.execute({ op: 'run', steps: [{ keys: 'enter' }] }), /aucune fenêtre Zed ouverte/)
})

test('xdotool : probe liste les fenêtres, uiaDescendants à -1 (GPUI ne publie rien sous X11 non plus)', async () => {
  const { k } = stubXdotool()
  const res = await k.execute({ op: 'probe' })
  assert.equal(res.ok, true)
  assert.deepEqual(res.windows, [{ title: 'zra — driver.js', pid: 4242, uiaDescendants: -1 }])
})

test('xdotool : le filtre --pid est revérifié fenêtre par fenêtre (getwindowpid)', async () => {
  // Fait établi sous Xvfb : `xdotool search --pid <absurde> --name ''` renvoie
  // TOUTES les fenêtres ; une fenêtre sans _NET_WM_PID n'est pas fiable. Ce
  // que `windows()` retient doit être prouvé par getwindowpid.
  const k = new XdotoolKeyboard({ timeoutMs: 2000 })
  k.exec = async (cmd, args) => {
    if (cmd === 'pgrep') return '4242\n'
    if (args?.[0] === 'search') return '10\n20\n30\n'
    if (args?.[0] === 'getwindowpid') {
      if (args[1] === '10') return '4242\n'      // au bon processus
      if (args[1] === '20') return '9999\n'      // d'un autre processus
      throw new Error('no pid')                  // sans _NET_WM_PID
    }
    if (args?.[0] === 'getwindowname') return `fenêtre ${args[1]}\n`
    return ''
  }
  const found = await k.windows()
  assert.deepEqual(found, [{ id: '10', title: 'fenêtre 10', pid: 4242 }],
    'ni la fenêtre d’un autre pid, ni celle sans preuve de pid')
})

test('LinuxKeyboard : deux recettes ne s’entrelacent pas (le clavier est une ressource globale)', async () => {
  const k = new XdotoolKeyboard({ timeoutMs: 2000 })
  const order = []
  k.exec = async (cmd, args) => {
    if (cmd === 'pgrep') return '4242\n'
    if (args?.[0] === 'search') return '111\n'
    if (args?.[0] === 'getwindowpid') return '4242\n'
    if (args?.[0] === 'getwindowname') return 'zra\n'
    if (args?.[0] === 'getactivewindow') return '111\n'
    return ''
  }
  // `run()` enchaîne les recettes ; sous node --test seules les simulations
  // passent, d'où dryRun + des étapes `wait` qui matérialisent l'ordre.
  const dry = (ms, n) => k.run({ op: 'run', dryRun: true, steps: [{ wait: ms }] })
    .then(() => order.push(`fin ${n}`))
  const wrapped = k.execute.bind(k)
  k.execute = async (req) => { order.push(`début ${req.steps[0].wait}`); const r = await wrapped(req); await new Promise((s) => setTimeout(s, req.steps[0].wait)); return r }
  await Promise.all([dry(40, 1), dry(5, 2)])
  assert.deepEqual(order, ['début 40', 'fin 1', 'début 5', 'fin 2'])
})

test('none : refus explicite qui renvoie vers acp, probe inoffensif', async () => {
  const k = new NoneKeyboard()
  await assert.rejects(() => k.execute({ op: 'run', dryRun: true, steps: [{ keys: 'enter' }] }),
    (e) => /backend clavier indisponible/.test(e.message) && /acp/.test(e.message))
  const res = await k.execute({ op: 'probe' })
  assert.equal(res.ok, true)
  assert.deepEqual(res.windows, [])
})

test('opération inconnue : refusée, comme keyboard.ps1', async () => {
  const { k } = stubXdotool()
  await assert.rejects(() => k.execute({ op: 'autre' }), /opération inconnue/)
})

// ---------------------------------------------------------------------------
// createKeyboard : le choix du backend
// ---------------------------------------------------------------------------

test('createKeyboard : backend inconnu refusé, les noms admis sont ceux de platform.js', async () => {
  await assert.rejects(() => createKeyboard({ backend: 'magique' }), /backend clavier inconnu/)
  for (const b of KEYBOARD_BACKENDS) {
    const k = await createKeyboard({ backend: b, platform: 'linux', env: {} })
    assert.equal(k.constructor.name !== 'NoneKeyboard' || b === 'none', true, b)
  }
})

test('createKeyboard : Windows → KeyboardRunner, sans rien sonder', async () => {
  const k = await createKeyboard({ platform: 'win32', env: {} })
  assert.ok(k instanceof KeyboardRunner)
  assert.equal(k.name, 'powershell')
  assert.equal(k.canTargetWindows, true)
})

test('createKeyboard : none imposé → NoneKeyboard, quel que soit l\'OS', async () => {
  const k = await createKeyboard({ backend: 'none', platform: 'linux', env: {} })
  assert.ok(k instanceof NoneKeyboard)
})

test('defaultKeyboardRunner : KeyboardRunner sous Windows, résolution paresseuse ailleurs', async () => {
  assert.ok(defaultKeyboardRunner({ platform: 'win32', env: {} }) instanceof KeyboardRunner)
  const lazy = defaultKeyboardRunner({ platform: 'linux', env: { XDG_SESSION_TYPE: 'wayland' } })
  assert.equal(lazy.name, 'auto', 'rien n’est résolu avant le premier run()')
  assert.equal(lazy.canTargetWindows, false)
  // Sous node --test, run() refuse même un probe (garde-fou gelé) : on déclenche
  // la résolution puis on sonde le backend résolu directement.
  await assert.rejects(() => lazy.run({ op: 'probe' }), /refusé sous node --test/)
  const res = await lazy.resolved.execute({ op: 'probe' })
  assert.equal(res.ok, true)
  assert.ok(['xdotool', 'none'].includes(lazy.name), lazy.name)
  assert.notEqual(lazy.name, 'auto', 'résolu après le premier run()')
})

// ---------------------------------------------------------------------------
// Configuration : zedControl.keyboard / unsafeFocus
// ---------------------------------------------------------------------------

test('config : défauts auto/false, validation, surcharge ZRA_ZED_KEYBOARD', async () => {
  const cfg = await loadConfig()
  assert.equal(cfg.zedControl.keyboard, 'auto')
  assert.equal(cfg.zedControl.unsafeFocus, false)

  await assert.rejects(() => loadConfig({ overrides: { zedControl: { keyboard: 'magique' } } }), /zedControl\.keyboard inconnu/)
  await assert.rejects(() => loadConfig({ overrides: { zedControl: { unsafeFocus: 'oui' } } }), /unsafeFocus : booléen/)

  process.env.ZRA_ZED_KEYBOARD = 'none'
  try {
    const forced = await loadConfig()
    assert.equal(forced.zedControl.keyboard, 'none')
  } finally {
    delete process.env.ZRA_ZED_KEYBOARD
  }
})

test('config : une surcharge partielle de zedControl ne perd pas keyboard', async () => {
  const cfg = await loadConfig({ overrides: { zedControl: { enabled: true } } })
  assert.equal(cfg.zedControl.enabled, true)
  assert.equal(cfg.zedControl.keyboard, 'auto', 'la fusion d’un niveau conserve les défauts')
})
