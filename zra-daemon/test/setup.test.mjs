// Installation dans Zed. Le settings.json appartient à l'utilisateur :
// chaque test vérifie qu'on n'y change que la tranche voulue.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { locate, removeAgentServer, removeAgentServerEnv, removeRootMember, upsertAgentServer, upsertAgentServerEnv, upsertRootMember, SettingsEditError } from '../zed-settings.js'
import { parseJsonc } from '../jsonc.js'
import { discoverAgents, isPreloadEntry, isShimEntry, preloadFlag, resolveAgentCommand, wrappedAgentId } from '../agent-commands.js'
import { readAgents } from '../agents.js'
import { buildEntry, buildPreloadEnv, lineDiff, parseArgs, zraName } from '../../scripts/setup.mjs'
import { installTarget, zedPaths } from '../../zra-daemon/platform.js'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

test('parseJsonc : BOM UTF-8 toléré (Notepad, PowerShell 5.1)', () => {
  assert.deepEqual(parseJsonc('\uFEFF{"a":1}'), { a: 1 })
})

test('buildEntry/buildPreloadEnv : layout installé → journaux et records dans le dossier config utilisateur', () => {
  const root = join(installTarget(), 'app')
  const state = join(zedPaths().zraConfigDir, '.zra')
  const entry = buildEntry({ agent: 'x', record: true, root })
  assert.equal(entry.env.ZRA_LOG_FILE, join(state, 'logs', 'shim.log'))
  assert.equal(entry.env.ZRA_RECORD_DIR, join(state, 'records'))
  const preload = buildPreloadEnv({ agent: 'x', record: true, root })
  assert.equal(preload.ZRA_LOG_FILE, join(state, 'logs', 'shim.log'))
  assert.equal(preload.ZRA_RECORD_DIR, join(state, 'records'))
})

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
    wrapped: {
      type: 'registry', env: { X: '1' }, default_mode: 'plan',
      default_config_options: { mode: 'auto' }, favorite_config_option_values: { model: ['opus'] },
    },
  })
  assert.equal(entry.type, 'custom')
  assert.equal(entry.command, 'C:/node.exe')
  assert.ok(isShimEntry(entry))
  assert.equal(wrappedAgentId(entry), 'claude-acp')
  assert.equal(entry.env.ZRA_RECORD, '1')
  for (const k of ['ZRA_LOG_FILE', 'ZRA_RECORD_DIR']) assert.match(entry.env[k].replace(/\\/g, '/'), /^C:\/zra\/\.zra\//)
  assert.deepEqual(entry.default_config_options, { mode: 'auto' })
  assert.equal(entry.default_mode, 'plan')
  assert.deepEqual(entry.favorite_config_option_values, { model: ['opus'] })
  assert.equal(entry.env.X, undefined, 'l’env de l’agent est appliqué par le shim, pas recopié')

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
  assert.deepEqual(agents.find((a) => a.id === 'claude-zra'), { id: 'claude-zra', name: 'claude-zra', kind: 'custom', wraps: 'claude-acp' })
  assert.deepEqual(agents.find((a) => a.id === 'claude-acp'), { id: 'claude-acp', name: 'Claude', kind: 'registry' })
})

// ---- ligne de commande -------------------------------------------------------

test('setup : « apply » et les agents passent en mots nus — npm avale les --options', () => {
  // `npm run setup install --apply` : npm garde --apply pour lui, le script ne reçoit que `install`.
  assert.deepEqual(parseArgs(['install', 'apply']).apply, true)
  assert.deepEqual(parseArgs(['install', '--apply']).apply, true)
  assert.deepEqual(parseArgs(['install']).apply, false)
  const opts = parseArgs(['install', 'qwen-code', 'pi-acp', 'apply', 'record'])
  assert.deepEqual(opts.agents, ['qwen-code', 'pi-acp'])
  assert.equal(opts.record, true)
  assert.equal(parseArgs(['install']).record, false, 'pas d’enregistrement par défaut')
  assert.equal(parseArgs(['install', 'apply', 'yes']).yes, true, '« yes » en mot nu')
  assert.equal(parseArgs(['install']).yes, false)
  assert.deepEqual(parseArgs(['install', '--agent', 'x']).agents, ['x'])
  assert.throws(() => parseArgs(['install', 'a', 'b', '--name', 'n']), /un seul agent/)
  assert.equal(parseArgs(['discover']).command, 'discover', 'commande JSON pour la page du tray')
})

test('setup : nom d’entrée = nom d’affichage de l’agent + (zra)', () => {
  assert.equal(zraName('claude-acp', 'Claude Agent'), 'Claude Agent (zra)')
  assert.equal(zraName('qwen-code', 'Qwen Code'), 'Qwen Code (zra)')
  assert.equal(zraName('pi-acp'), 'Pi (zra)', 'repli : l’id mis en forme')
})

test('parseArgs : xwayland est une commande à part, simulation par défaut', () => {
  assert.equal(parseArgs(['xwayland']).command, 'xwayland')
  assert.equal(parseArgs(['xwayland']).apply, false)
  assert.equal(parseArgs(['xwayland', '--apply']).apply, true)
})

// ---- preload : l'entrée registry shimée par l'env ---------------------------

const PRELOAD_ENV = buildPreloadEnv({ agent: 'claude-acp', record: false, root: 'C:/zra' })

test('buildPreloadEnv : NODE_OPTIONS percent-encodé, id et journal ; NODE_OPTIONS utilisateur conservé', () => {
  assert.equal(PRELOAD_ENV.ZRA_AGENT_ID, 'claude-acp')
  assert.match(PRELOAD_ENV.ZRA_LOG_FILE.replace(/\\/g, '/'), /^C:\/zra\/\.zra\/logs\//)
  assert.ok(PRELOAD_ENV.NODE_OPTIONS.startsWith('--import data:text/javascript,'))
  const payload = PRELOAD_ENV.NODE_OPTIONS.slice('--import '.length)
  assert.ok(!/[ "]/.test(payload), 'payload sans espace ni guillemet brut : le tokenizer de NODE_OPTIONS casse dessus')
  assert.ok(isPreloadEntry({ type: 'registry', env: PRELOAD_ENV }))
  assert.ok(isShimEntry({ type: 'registry', env: PRELOAD_ENV }))
  assert.equal(wrappedAgentId({ type: 'registry', env: PRELOAD_ENV }), 'claude-acp')
  assert.ok(!isPreloadEntry({ type: 'custom', env: PRELOAD_ENV }), 'le preload ne vaut que sur une entrée registry')

  // NODE_OPTIONS de l'utilisateur : conservé à la suite ; le nôtre remplacé s'il y est déjà (dépôt déplacé).
  const avec = buildPreloadEnv({ agent: 'claude-acp', root: 'C:/zra', existing: '--max-old-space-size=4096' })
  assert.equal(avec.NODE_OPTIONS, `${preloadFlag('C:/zra')} --max-old-space-size=4096`)
  const deplace = buildPreloadEnv({ agent: 'claude-acp', root: 'D:/zra', existing: avec.NODE_OPTIONS })
  assert.equal(deplace.NODE_OPTIONS, `${preloadFlag('D:/zra')} --max-old-space-size=4096`)

  const record = buildPreloadEnv({ agent: 'x', record: true, root: 'C:/zra' })
  assert.equal(record.ZRA_RECORD, '1')
  assert.match(record.ZRA_RECORD_DIR.replace(/\\/g, '/'), /^C:\/zra\/\.zra\/records/)
})

test('upsertAgentServerEnv : ne touche qu’à l’env, le reste reste octet pour octet', () => {
  const { text, action } = upsertAgentServerEnv(ZED_SETTINGS, 'claude-acp', PRELOAD_ENV)
  assert.equal(action, 'added')
  assert.deepEqual(parseJsonc(text).agent_servers['claude-acp'].env, PRELOAD_ENV)
  // Tout ce qui précède l'insertion est identique, commentaires et virgules compris.
  const at = ZED_SETTINGS.indexOf('"type": "registry",') + '"type": "registry",'.length
  assert.equal(text.slice(0, at), ZED_SETTINGS.slice(0, at))
  assert.ok(text.includes('"model": "opus[1m]",'))
  assert.ok(text.includes('/* thème */'))
  assert.equal(upsertAgentServerEnv(text, 'claude-acp', PRELOAD_ENV).action, 'unchanged', 'idempotent')

  const moved = buildPreloadEnv({ agent: 'claude-acp', root: 'D:/zra' })
  const r2 = upsertAgentServerEnv(text, 'claude-acp', moved)
  assert.equal(r2.action, 'replaced')
  assert.deepEqual(parseJsonc(r2.text).agent_servers['claude-acp'].env, moved)

  // Entrée sans env : il est créé ; entrée absente : rien n'est écrit.
  const m = upsertAgentServerEnv(ZED_SETTINGS, 'mistral-vibe', { ZRA_AGENT_ID: 'mistral-vibe' })
  assert.deepEqual(parseJsonc(m.text).agent_servers['mistral-vibe'], { type: 'registry', env: { ZRA_AGENT_ID: 'mistral-vibe' } })
  assert.equal(upsertAgentServerEnv(ZED_SETTINGS, 'inconnu', { X: '1' }).action, 'absent')

  const crlf = upsertAgentServerEnv(ZED_SETTINGS.replace(/\n/g, '\r\n'), 'claude-acp', PRELOAD_ENV)
  assert.ok(!/[^\r]\n/.test(crlf.text), 'aucun LF isolé introduit')
})

test('removeAgentServerEnv : install puis uninstall rend le fichier à l’identique', () => {
  for (const src of [ZED_SETTINGS, ZED_SETTINGS.replace(/\n/g, '\r\n')]) {
    const installed = upsertAgentServerEnv(src, 'claude-acp', PRELOAD_ENV).text
    const { text, action } = removeAgentServerEnv(installed, 'claude-acp', Object.keys(PRELOAD_ENV))
    assert.equal(action, 'removed')
    assert.equal(text, src)
  }
  // Un env vidé par le retrait est retiré à son tour ; l'entrée, elle, reste.
  const src = '{\n  "agent_servers": {\n    "a": { "type": "registry", "env": { "X": "1" } }\n  }\n}\n'
  assert.equal(removeAgentServerEnv(src, 'a', ['X']).text, '{\n  "agent_servers": {\n    "a": { "type": "registry" }\n  }\n}\n')
  assert.equal(removeAgentServerEnv(src, 'a', ['Y']).action, 'absent')
})

test('resolveAgentCommand : une entrée registry shimée se résout sans le preload ni l’env ZRA', async () => {
  const registryDir = join(FIXTURES, 'registry-preload')
  const pkgDir = join(registryDir, 'npx', 'faux-acp', 'node_modules', '@editeur', 'faux-agent')
  mkdirSync(pkgDir, { recursive: true })
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ bin: 'agent.js' }))
  writeFileSync(join(pkgDir, 'agent.js'), '// agent\n')
  writeFileSync(join(registryDir, 'registry.json'), JSON.stringify({
    agents: [{ id: 'faux-acp', distribution: { npx: { package: '@editeur/faux-agent@1.0.0', env: { R: '1' } } } }],
  }))
  const settingsFile = join(FIXTURES, 'settings-preload.json')
  const env = {
    ...buildPreloadEnv({ agent: 'faux-acp', root: 'C:/zra' }),
    NODE_OPTIONS: `${preloadFlag('C:/zra')} --max-old-space-size=4096`,
    ANTHROPIC_API_KEY: '',
  }
  writeFileSync(settingsFile, JSON.stringify({ agent_servers: { 'faux-acp': { type: 'registry', env } } }))

  const r = await resolveAgentCommand('faux-acp', { settingsFile, registryDir })
  assert.equal(r.source, 'registry/npx')
  assert.equal(r.viaNode, true)
  assert.equal(r.command, process.execPath)
  // Le preload et les ZRA_* ne partent pas dans l'agent relancé (daemon, shim) ;
  // le NODE_OPTIONS de l'utilisateur et l'env registry, si.
  assert.deepEqual(r.env, { R: '1', ANTHROPIC_API_KEY: '', NODE_OPTIONS: '--max-old-space-size=4096' })

  const found = await discoverAgents({ settingsFile, registryDir })
  assert.ok(found.find((a) => a.id === 'faux-acp' && a.ok && a.viaNode), 'découverte comme l’agent d’origine')

  // readAgents : nom usuel, wraps pour la PWA — les threads ne sont plus cadenassés.
  const agents = await readAgents(settingsFile)
  assert.deepEqual(agents.find((a) => a.id === 'faux-acp'), { id: 'faux-acp', name: 'Faux', kind: 'registry', wraps: 'faux-acp' })
})

test('upsertRootMember : clé racine ajoutée/remplacée, commentaires préservés (tls)', () => {
  const src = '// tête\n{\n  "port": 7777, // port\n  /* bloc */\n  "name": "x",\n}\n'
  const added = upsertRootMember(src, 'tls', { cert: 'a.crt', key: 'a.key' })
  assert.equal(added.action, 'added')
  assert.ok(added.text.includes('// tête'), 'commentaire de tête préservé')
  assert.ok(added.text.includes('// port'), 'commentaire de ligne préservé')
  assert.ok(added.text.includes('/* bloc */'), 'commentaire bloc préservé')
  assert.deepEqual(parseJsonc(added.text).tls, { cert: 'a.crt', key: 'a.key' })
  assert.equal(parseJsonc(added.text).port, 7777)
  const replaced = upsertRootMember(added.text, 'tls', { cert: 'b.crt', key: 'b.key' })
  assert.equal(replaced.action, 'replaced')
  assert.deepEqual(parseJsonc(replaced.text).tls, { cert: 'b.crt', key: 'b.key' })
  assert.equal(upsertRootMember(replaced.text, 'tls', { cert: 'b.crt', key: 'b.key' }).action, 'unchanged')
})

test('removeRootMember : retire la clé racine, retour exact au fichier d’avant', () => {
  const src = '{\n  "port": 7777,\n  "name": "x",\n}\n'
  const added = upsertRootMember(src, 'tls', { cert: 'a.crt', key: 'a.key' })
  const removed = removeRootMember(added.text, 'tls')
  assert.equal(removed.action, 'removed')
  assert.equal(removed.text, src)
  assert.equal(removeRootMember(src, 'tls').action, 'absent')
})

test('setup tls : parseArgs — commande + --cert/--key', () => {
  const opts = parseArgs(['tls', '--cert', 'a.crt', '--key', 'a.key', 'apply'])
  assert.equal(opts.command, 'tls')
  assert.equal(opts.cert, 'a.crt')
  assert.equal(opts.key, 'a.key')
  assert.equal(opts.apply, true)
})
