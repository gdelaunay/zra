// Garde éveillé (`keep-awake.js`) — le veto de veille, sans OS réel :
// spawn factice, horloge injectable, persistance sur fichier temporaire.
// Ce qui est verrouillé : helper résident spawn/killed selon l'état dérivé
// (busy ou bascule), TTL, dégradation honnête, aucun état orphelin.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { KeepAwake, MODES } from '../keep-awake.js'
import { setLevel } from '../log.js'

setLevel('error')

/** Child process factice : vit jusqu'à `kill()`. `exitCode` : quitte seul, vite. */
function makeSpawn({ exitCode = null } = {}) {
  const calls = []
  const children = []
  const spawn = (command, args) => {
    const child = new EventEmitter()
    child.command = command
    child.args = args
    child.killed = false
    child.kill = () => { child.killed = true; child.emit('exit', null, 'SIGTERM') }
    calls.push({ command, args, child })
    children.push(child)
    if (exitCode !== null) process.nextTick(() => child.emit('exit', exitCode))
    return child
  }
  return { spawn, calls, children }
}

function setup(opts = {}) {
  const clock = { t: 1_000_000 }
  const { spawn, calls, children } = makeSpawn(opts)
  const ka = new KeepAwake({
    file: opts.file ?? null,
    spawn,
    platform: opts.platform ?? 'win32',
    now: () => clock.t,
  })
  return { ka, clock, calls, children }
}

test('tour en cours : helper spawné ; fin de tour : helper tué', () => {
  const { ka, calls, children } = setup()
  assert.equal(ka.state().active, false)
  ka.setBusy(true)
  assert.equal(calls.length, 1)
  assert.match(calls[0].command, /powershell/)
  assert.deepEqual(ka.state(), { mode: 'off', until: null, active: true, reason: 'turn', supported: true })
  ka.setBusy(false)
  assert.equal(children[0].killed, true)
  assert.equal(ka.state().active, false)
  ka.close()
})

test('Linux : systemd-inhibit sleep block, avec le why', () => {
  const { ka, calls } = setup({ platform: 'linux' })
  ka.setBusy(true)
  assert.equal(calls[0].command, 'systemd-inhibit')
  assert.ok(calls[0].args.includes('--what=sleep'))
  assert.ok(calls[0].args.includes('--mode=block'))
  assert.ok(calls[0].args.some((a) => a.startsWith('--why=')))
  ka.close()
})

test('bascule 1 h : inhibe, expire au TTL, retombe à off', () => {
  const { ka, clock, children } = setup()
  ka.setMode('1h')
  assert.equal(ka.state().active, true)
  assert.equal(ka.state().reason, 'manual')
  assert.equal(ka.state().until, clock.t + 3_600_000)
  clock.t += 3_599_999
  ka.tick()
  assert.equal(ka.state().active, true)
  clock.t += 1
  ka.tick()
  assert.deepEqual(ka.state(), { mode: 'off', until: null, active: false, reason: null, supported: true })
  assert.equal(children[0].killed, true)
  ka.close()
})

test('« jusqu’à désactivation » : pas d’échéance, off explicite seul relâche', () => {
  const { ka, clock, children } = setup()
  ka.setMode('on')
  assert.equal(ka.state().until, null)
  clock.t += 7 * 86_400_000
  ka.tick()
  assert.equal(ka.state().active, true)
  ka.setMode('off')
  assert.equal(children[0].killed, true)
  ka.close()
})

test('tour + bascule : la fin du tour ne relâche pas la bascule', () => {
  const { ka, children } = setup()
  ka.setMode('4h')
  ka.setBusy(true)
  assert.equal(ka.state().reason, 'turn')
  ka.setBusy(false)
  assert.equal(children[0].killed, false)
  assert.equal(ka.state().reason, 'manual')
  ka.setMode('off')
  assert.equal(children[0].killed, true)
  ka.close()
})

test('un seul helper à la fois : busy puis bascule ne respawnent pas', () => {
  const { ka, calls } = setup()
  ka.setBusy(true)
  ka.setMode('1h')
  ka.setBusy(false)
  assert.equal(calls.length, 1)
  ka.close()
})

test('mode inconnu : refus, l’état ne bouge pas', () => {
  const { ka, calls } = setup()
  assert.throws(() => ka.setMode('toujours'), /inconnu/)
  assert.equal(ka.state().mode, 'off')
  assert.equal(calls.length, 0)
  assert.deepEqual(MODES, ['off', '1h', '4h', '12h', 'on'])
  ka.close()
})

test('macOS : pas de helper, dégradation honnête', () => {
  const { ka, calls } = setup({ platform: 'darwin' })
  ka.setBusy(true)
  ka.setMode('on')
  assert.equal(calls.length, 0)
  assert.deepEqual(ka.state(), { mode: 'on', until: null, active: false, reason: null, supported: false })
  ka.close()
})

test('helper qui quitte tôt en erreur : poste non supporté, pas de retente', () => {
  const { ka, calls } = setup({ platform: 'linux', exitCode: 1 })
  const changes = []
  ka.on('change', (s) => changes.push(s))
  ka.setBusy(true)
  return new Promise((resolve) => setImmediate(() => {
    assert.equal(ka.state().supported, false)
    assert.equal(ka.state().active, false)
    assert.ok(changes.some((s) => s.supported === false))
    ka.setBusy(false)
    ka.setBusy(true)
    assert.equal(calls.length, 1)
    ka.close()
    resolve()
  }))
})

test('persistance : la bascule survit au restart, l’échéance écoulée non', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'zra-awake-'))
  const file = join(dir, 'keep-awake.json')
  try {
    const clock = { t: 1_000_000 }
    const first = makeSpawn()
    const ka = new KeepAwake({ file, spawn: first.spawn, platform: 'win32', now: () => clock.t })
    ka.setMode('12h')
    ka.close()
    const saved = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(saved.mode, '12h')
    assert.equal(saved.until, clock.t + 43_200_000)

    // Restart dans la fenêtre : la bascule est reprise, le helper respawné.
    const second = makeSpawn()
    const kb = new KeepAwake({ file, spawn: second.spawn, platform: 'win32', now: () => clock.t })
    assert.equal(kb.state().active, true)
    assert.equal(second.calls.length, 1)
    kb.close()

    // Restart après l'échéance : off, rien ne spawn.
    clock.t += 43_200_001
    const third = makeSpawn()
    const kc = new KeepAwake({ file, spawn: third.spawn, platform: 'win32', now: () => clock.t })
    assert.equal(kc.state().mode, 'off')
    assert.equal(third.calls.length, 0)
    kc.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('close : helper tué, plus rien ne tourne', () => {
  const { ka, children } = setup()
  ka.setMode('on')
  ka.close()
  assert.equal(children[0].killed, true)
  assert.equal(ka.helper, null)
})