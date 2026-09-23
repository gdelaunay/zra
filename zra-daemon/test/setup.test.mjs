// Installation dans Zed — lot C. Le settings.json appartient à l'utilisateur :
// chaque test vérifie qu'on n'y change que la tranche voulue.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { locate, removeAgentServer, upsertAgentServer, SettingsEditError } from '../zed-settings.js'
import { parseJsonc } from '../jsonc.js'
import { isShimEntry, resolveAgentCommand, wrappedAgentId } from '../agent-commands.js'
import { readAgents } from '../agents.js'
import { buildEntry, lineDiff, parseArgs, zraName } from '../../scripts/setup.mjs'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

/** Au plus près du settings.json de la machine cible : commentaires, virgules traînantes. */
const ZED_SETTINGS = `// Zed settings
//
// For information on how to configure Zed, see the Zed
// documentation: https://zed.dev/docs/configuring-zed
{
  "diagnostics": { "inline": { "enabled": true } },
  "agent_servers": {
    "claude-acp": {
      "default_config_options": {
        "mode": "auto",
        "model": "opus[1m]",
      },
      "type": "registry",
    },
    "mistral-vibe": {
      "type": "registry"
    }
  },
  /* thème */
  "theme": { "dark": "Gruvbox Dark" },
}
`

const ENTRY = {
  type: 'custom',
  command: 'C:\\Program Files\\nodejs\\node.exe',
  args: ['C:/zra/zra-shim/index.js'],
  env: { ZRA_AGENT_ID: 'claude-acp' },
}

// ---- analyse positionnelle -------------------------------------------------

test('locate : situe les membres, commentaires et virgules traînantes compris', () => {
  const root = locate(ZED_SETTINGS)
  assert.deepEqual(root.members.map((m) => m.key), ['diagnostics', 'agent_servers', 'theme'])
  const servers = root.members[1].value
  assert.deepEqual(servers.members.map((m) => m.key), ['claude-acp', 'mistral-vibe'])
  assert.equal(ZED_SETTINGS.slice(servers.members[1].start, servers.members[1].start + 14), '"mistral-vibe"')
})

test('locate : refuse un fichier cassé plutôt que de deviner', () => {
  assert.throws(() => locate('{ "a": '), SettingsEditError)
  assert.throws(() => locate('{ "a": "x }'), SettingsEditError)
  assert.throws(() => locate('[1, 2]'), /pas un objet/)
})

// ---- ajout -----------------------------------------------------------------

test('upsert : ajoute une entrée sans toucher au reste du fichier', () => {
  const { text, action } = upsertAgentServer(ZED_SETTINGS, 'claude-zra', ENTRY)
  assert.equal(action, 'added')

  const parsed = parseJsonc(text)
  assert.deepEqual(parsed.agent_servers['claude-zra'], ENTRY)
  assert.deepEqual(Object.keys(parsed.agent_servers), ['claude-acp', 'mistral-vibe', 'claude-zra'])

  // Tout ce qui précède l'insertion est identique à l'octet près, commentaires compris.
  const at = ZED_SETTINGS.indexOf('"mistral-vibe"')
  assert.equal(text.slice(0, at), ZED_SETTINGS.slice(0, at))
  assert.ok(text.includes('/* thème */'))
  assert.ok(text.includes('"model": "opus[1m]",'), 'la virgule traînante d’origine est conservée')
  // Indentation alignée sur les entrées voisines.
  assert.match(text, /\n {4}"claude-zra": \{\n {6}"type": "custom",/)
})

test('upsert : respecte une virgule traînante après la dernière entrée', () => {
  const src = '{\n  "agent_servers": {\n    "a": { "type": "registry" },\n  },\n}\n'
  const { text } = upsertAgentServer(src, 'b', { type: 'custom' })
  assert.deepEqual(Object.keys(parseJsonc(text).agent_servers), ['a', 'b'])
  assert.match(text, /"a": \{ "type": "registry" \},\n {4}"b": \{\n {6}"type": "custom"\n {4}\},\n {2}\}/)
})

test('upsert : agent_servers vide ou absent', () => {
  const vide = upsertAgentServer('{\n  "agent_servers": {},\n  "theme": "x"\n}\n', 'z', { type: 'custom' })
  assert.deepEqual(parseJsonc(vide.text), { agent_servers: { z: { type: 'custom' } }, theme: 'x' })

  const absent = upsertAgentServer('{\n  "theme": "x"\n}\n', 'z', { type: 'custom' })
  assert.deepEqual(parseJsonc(absent.text), { agent_servers: { z: { type: 'custom' } }, theme: 'x' })

  const racineVide = upsertAgentServer('{}', 'z', { type: 'custom' })
  assert.deepEqual(parseJsonc(racineVide.text), { agent_servers: { z: { type: 'custom' } } })
})

test('upsert : idempotent, puis remplacement en place', () => {
  const once = upsertAgentServer(ZED_SETTINGS, 'claude-zra', ENTRY).text
  assert.equal(upsertAgentServer(once, 'claude-zra', ENTRY).action, 'unchanged')

  const moved = { ...ENTRY, args: ['D:/ailleurs/zra-shim/index.js'] }
  const { text, action } = upsertAgentServer(once, 'claude-zra', moved)
  assert.equal(action, 'replaced')
  assert.deepEqual(parseJsonc(text).agent_servers['claude-zra'], moved)
  assert.equal(text.split('claude-zra').length, 2, 'une seule entrée')
})

test('upsert : fins de ligne CRLF conservées', () => {
  const crlf = ZED_SETTINGS.replace(/\n/g, '\r\n')
  const { text } = upsertAgentServer(crlf, 'claude-zra', ENTRY)
  assert.ok(!/[^\r]\n/.test(text), 'aucun LF isolé introduit')
  assert.deepEqual(parseJsonc(text).agent_servers['claude-zra'], ENTRY)
})

// ---- retrait ---------------------------------------------------------------

test('remove : install puis uninstall rend le fichier à l’identique', () => {
  for (const src of [ZED_SETTINGS, ZED_SETTINGS.replace(/\n/g, '\r\n'),
    '{\n  "agent_servers": {\n    "a": { "type": "registry" },\n  },\n}\n',
    '{\n  "agent_servers": {\n    "a": { "type": "registry" }\n  }\n}\n']) {
    const installed = upsertAgentServer(src, 'claude-zra', ENTRY).text
    const { text, action } = removeAgentServer(installed, 'claude-zra')
    assert.equal(action, 'removed')
    assert.equal(text, src)
  }
})

test('remove : une entrée au milieu, ou la première', () => {
  const src = '{\n  "agent_servers": {\n    "a": 1,\n    "b": 2,\n    "c": 3\n  }\n}\n'
  assert.equal(removeAgentServer(src, 'b').text, '{\n  "agent_servers": {\n    "a": 1,\n    "c": 3\n  }\n}\n')
  assert.equal(removeAgentServer(src, 'a').text, '{\n  "agent_servers": {\n    "b": 2,\n    "c": 3\n  }\n}\n')
  assert.equal(removeAgentServer(src, 'c').text, '{\n  "agent_servers": {\n    "a": 1,\n    "b": 2\n  }\n}\n')
  assert.equal(removeAgentServer(src, 'x').action, 'absent')
})

// ---- l'entrée ZRA ----------------------------------------------------------

test('buildEntry : chemins absolus, tout sous .zra/, options de l’agent recopiées', () => {
  const entry = buildEntry({
    agent: 'claude-acp', record: true, nodePath: 'C:/node.exe', root: 'C:/zra',
    wrapped: { type: 'registry', default_config_options: { mode: 'auto' } },
  })
  assert.equal(entry.type, 'custom')
  assert.equal(entry.command, 'C:/node.exe')
  assert.ok(isShimEntry(entry))
  assert.equal(wrappedAgentId(entry), 'claude-acp')
  assert.equal(entry.env.ZRA_RECORD, '1')
  for (const k of ['ZRA_LOG_FILE', 'ZRA_RECORD_DIR']) assert.match(entry.env[k].replace(/\\/g, '/'), /^C:\/zra\/\.zra\//)
  assert.deepEqual(entry.default_config_options, { mode: 'auto' })

  const sans = buildEntry({ agent: 'x', record: false, root: 'C:/zra' })
  assert.equal(sans.env.ZRA_RECORD, undefined)
  assert.equal(sans.default_config_options, undefined)
})

test('isShimEntry : reconnue au script, quel que soit le nom ou le séparateur', () => {
  assert.ok(isShimEntry({ args: ['C:\\x\\zra-shim\\index.js'] }))
  assert.ok(isShimEntry({ args: ['/opt/zra/zra-shim/index.js'] }))
  assert.ok(!isShimEntry({ args: ['C:/x/mon-agent/index.js'] }))
  assert.ok(!isShimEntry({ type: 'registry' }))
  assert.ok(!isShimEntry(null))
})

test('lineDiff : ne montre que la zone qui change', () => {
  const diff = lineDiff('a\nb\nc\nd\ne\nf', 'a\nb\nc\nX\nd\ne\nf')
  assert.equal(diff, '    b\n    c\n  + X\n    d\n    e')
})

// ---- résolution à travers une entrée ZRA -------------------------------------

test('resolveAgentCommand : une entrée ZRA se résout vers l’agent enveloppé, jamais vers le shim', async () => {
  mkdirSync(FIXTURES, { recursive: true })
  const settingsFile = join(FIXTURES, 'settings-zra.json')
  writeFileSync(settingsFile, JSON.stringify({
    agent_servers: {
      'claude-acp': { type: 'registry' },
      'claude-zra': { ...ENTRY },
      'boucle': { type: 'custom', command: 'node', args: ['C:/zra/zra-shim/index.js'], env: { ZRA_AGENT_ID: 'boucle' } },
    },
  }))
  const overrides = { 'claude-acp': { command: 'node', args: ['vrai-agent.js'] } }

  const r = await resolveAgentCommand('claude-zra', { settingsFile, overrides })
  assert.deepEqual(r.args, ['vrai-agent.js'])
  assert.equal(r.wraps, 'claude-acp')
  assert.equal(r.source, 'zra→config')

  await assert.rejects(() => resolveAgentCommand('boucle', { settingsFile, overrides }), /sans agent enveloppé valide/)

  const agents = await readAgents(settingsFile)
  assert.deepEqual(agents.find((a) => a.id === 'claude-zra'), { id: 'claude-zra', name: 'Claude (ZRA)', kind: 'custom', wraps: 'claude-acp' })
  assert.deepEqual(agents.find((a) => a.id === 'claude-acp'), { id: 'claude-acp', name: 'Claude', kind: 'registry' })
})

// ---- ligne de commande -------------------------------------------------------

test('setup : « apply » et les agents passent en mots nus — npm avale les --options', () => {
  // `npm run setup install --apply` : npm garde --apply pour lui, le script ne reçoit que `install`.
  assert.deepEqual(parseArgs(['install', 'apply']).apply, true)
  assert.deepEqual(parseArgs(['install', '--apply']).apply, true)
  assert.deepEqual(parseArgs(['install']).apply, false)
  const opts = parseArgs(['install', 'qwen-code', 'pi-acp', 'apply', 'no-record'])
  assert.deepEqual(opts.agents, ['qwen-code', 'pi-acp'])
  assert.equal(opts.record, false)
  assert.deepEqual(parseArgs(['install', '--agent', 'x']).agents, ['x'])
  assert.throws(() => parseArgs(['install', 'a', 'b', '--name', 'n']), /un seul agent/)
})

test('setup : nom d’entrée dérivé de l’agent', () => {
  assert.equal(zraName('claude-acp'), 'claude-zra', 'nom historique conservé')
  assert.equal(zraName('qwen-code'), 'qwen-code-zra')
  assert.equal(zraName('pi-acp'), 'pi-zra')
})
