// Raccourcis « nouveau thread » dans le keymap.json de Zed : l'agent choisi sur
// le mobile est celui qui s'ouvre, et le fichier de l'utilisateur ne bouge pas
// d'un octet hors du bloc ZRA.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseJsonc } from '../jsonc.js'
import {
  ACTION, BEGIN, KEY_POOL, assignKeys, readAgentKey, readZraKeys, removeZraKeymap, toChord, upsertZraKeymap,
} from '../zed-keymap.js'
import { ZedDriver, expandRecipe } from '../zed/driver.js'
import { keymapFor } from '../../scripts/setup.mjs'

const WORK = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'keymap')
mkdirSync(WORK, { recursive: true })

const keys = (...pairs) => new Map(pairs)

const USER = `// Zed keymap
//
// For information on binding keys, see the Zed
// documentation: https://zed.dev/docs/key-bindings
[
  {
    "context": "Workspace",
    "bindings": {
      // "shift shift": "file_finder::Toggle"
    },
  },
]
`

test('pose puis retrait : le fichier revient octet pour octet', () => {
  const added = upsertZraKeymap(USER, keys(['claude-zra', 'ctrl-alt-shift-f1']))
  assert.equal(added.action, 'added')
  assert.ok(added.text.includes(BEGIN))
  const parsed = parseJsonc(added.text)
  assert.equal(parsed.length, 2, 'un élément de plus, en tête')
  assert.deepEqual(parsed[0].bindings['ctrl-alt-shift-f1'], [ACTION, { agent: { custom: { name: 'claude-zra' } } }])
  assert.equal(parsed[1].context, 'Workspace', 'le bloc de l’utilisateur suit, intact')

  assert.equal(removeZraKeymap(added.text).text, USER)
})

test('CRLF : même aller-retour, fins de ligne du fichier respectées', () => {
  const crlf = USER.replace(/\n/g, '\r\n')
  const added = upsertZraKeymap(crlf, keys(['claude-zra', 'ctrl-alt-shift-f1']))
  assert.ok(!/[^\r]\n/.test(added.text), 'aucun LF seul')
  assert.equal(removeZraKeymap(added.text).text, crlf)
})

test('relancer install : inchangé ; un agent de plus : remplacé, les touches déjà posées gardées', () => {
  const once = upsertZraKeymap(USER, keys(['claude-zra', 'ctrl-alt-shift-f1'])).text
  const again = upsertZraKeymap(once, keys(['claude-zra', 'ctrl-alt-shift-f1']))
  assert.equal(again.action, 'unchanged')
  assert.equal(again.text, once)

  const assigned = assignKeys(['mistral-vibe-zra', 'claude-zra'], readZraKeys(once))
  assert.equal(assigned.get('claude-zra'), 'ctrl-alt-shift-f1', 'touche stable')
  assert.equal(assigned.get('mistral-vibe-zra'), 'ctrl-alt-shift-f2')
  const more = upsertZraKeymap(once, assigned)
  assert.equal(more.action, 'replaced')
  assert.equal(parseJsonc(more.text).length, 2, 'toujours un seul bloc ZRA')
  assert.deepEqual([...readZraKeys(more.text)].sort(), [['claude-zra', 'ctrl-alt-shift-f1'], ['mistral-vibe-zra', 'ctrl-alt-shift-f2']])
})

test('fichier absent, tableau vide, tableau sur une ligne : toujours du JSONC valide', () => {
  const k = keys(['claude-zra', 'ctrl-alt-shift-f1'])
  for (const text of [null, '', '// rien encore\n', '[]', '[\n]\n', '[{"bindings":{"ctrl-k":"editor::Cut"}}]']) {
    const { text: out } = upsertZraKeymap(text, k)
    const parsed = parseJsonc(out)
    assert.ok(Array.isArray(parsed), `tableau pour ${JSON.stringify(text)}`)
    assert.equal(readZraKeys(out).get('claude-zra'), 'ctrl-alt-shift-f1')
    if (text?.includes('editor::Cut')) assert.equal(parsed[1].bindings['ctrl-k'], 'editor::Cut')
    if (text?.startsWith('//')) assert.ok(out.startsWith('// rien encore\n'), 'commentaires gardés')
    assert.ok(Array.isArray(parseJsonc(removeZraKeymap(out).text)), 'retrait valide aussi')
  }
})

test('les deux formes de l’argument agent sont lues', () => {
  const text = `[\n  ${BEGIN}\n  { "bindings": { "ctrl-alt-shift-f3": ["${ACTION}", { "agent": "pi-zra" }] } },\n  // <<< zra\n]\n`
  assert.equal(readZraKeys(text).get('pi-zra'), 'ctrl-alt-shift-f3')
})

test('plus de touches que d’agents : erreur claire', () => {
  const ids = Array.from({ length: KEY_POOL.length + 1 }, (_, i) => `a${i}`)
  assert.throws(() => assignKeys(ids), /pas assez de touches/)
})

test('setup : une touche par entrée ZRA, rien pour les autres ; plus d’entrée, plus de bloc', () => {
  const settings = JSON.stringify({
    agent_servers: {
      'claude-acp': { type: 'registry' },
      'claude-zra': { type: 'custom', command: 'node', args: ['C:/zra/zra-shim/index.js'], env: { ZRA_AGENT_ID: 'claude-acp' } },
    },
  })
  const km = keymapFor(settings, USER)
  assert.equal(km.action, 'added')
  assert.deepEqual([...km.keys], [['claude-zra', 'ctrl-alt-shift-f1']])

  const none = keymapFor(JSON.stringify({ agent_servers: { 'claude-acp': { type: 'registry' } } }), km.text)
  assert.equal(none.action, 'removed')
  assert.equal(none.text, USER)
})

test('touches : seule {agentKey} se substitue dans keys, jamais un titre', () => {
  const steps = expandRecipe([{ keys: '{agentKey}' }, { keys: '{title}' }, { text: '{title}' }], { agentKey: 'ctrl+f1', title: 'x' })
  assert.deepEqual(steps, [{ keys: 'ctrl+f1' }, { keys: '{title}' }, { text: 'x' }])
  assert.equal(toChord('ctrl-alt-shift-f1'), 'ctrl+alt+shift+f1')
})

function fakeKeyboard() {
  const calls = []
  return { calls, async run(req) { calls.push(req); return { ok: true, log: [] } } }
}

test('pilote : la touche de l’agent si elle est posée, la palette sinon', async () => {
  const file = join(WORK, 'keymap.json')
  rmSync(file, { force: true })
  const keyboard = fakeKeyboard()
  const driver = new ZedDriver({ runner: keyboard, enabled: true, keymapFile: file })

  // Pas de keymap.json : repli sur la palette (dernier agent utilisé).
  await driver.newThread({ id: 'claude-zra' })
  assert.equal(keyboard.calls.at(-1).steps[0].keys, 'ctrl+shift+p')

  writeFileSync(file, upsertZraKeymap(USER, keys(['claude-zra', 'ctrl-alt-shift-f1'], ['mistral-vibe-zra', 'ctrl-alt-shift-f2'])).text)
  assert.equal(await readAgentKey(file, 'mistral-vibe-zra'), 'ctrl-alt-shift-f2')

  await driver.newThread({ id: 'mistral-vibe-zra' })
  assert.deepEqual(keyboard.calls.at(-1).steps[0], { keys: 'ctrl+alt+shift+f2' })

  // Agent sans touche (setup pas relancé depuis son ajout) : palette.
  await driver.newThread({ id: 'pi-zra' })
  assert.equal(keyboard.calls.at(-1).steps[0].keys, 'ctrl+shift+p')
})
