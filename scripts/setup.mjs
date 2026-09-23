#!/usr/bin/env node
// Brancher ZRA dans Zed — lot C, installation.
//
//   npm run setup                       état : entrée Zed, agent, daemon
//   npm run setup -- install            montre ce qui serait écrit, n'écrit rien
//   npm run setup -- install --apply    écrit (sauvegarde préalable)
//   npm run setup -- uninstall --apply  retire l'entrée, et elle seule
//
// Ce que fait l'installation, et rien d'autre : **une** entrée ajoutée sous
// `agent_servers` du `settings.json` de Zed. Elle déclare un agent de plus
// (« claude-zra ») qui lance `zra-shim`, lequel enveloppe l'agent existant
// (`claude-acp`). L'agent d'origine n'est pas touché : ses threads continuent
// de marcher sans ZRA, et retirer l'entrée ramène le fichier à l'identique.
//
// Tout ce que le shim produit reste dans le dépôt, sous `.zra/` (ignoré par
// git) : journal, enregistrements de trames, sauvegardes du settings.json.
//
// Édition chirurgicale (`zra-daemon/zed-settings.js`) : le fichier n'est jamais
// re-sérialisé, commentaires et mise en forme restent tels quels.

import { existsSync, statSync } from 'node:fs'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadConfig } from '../zra-daemon/config.js'
import { parseJsonc } from '../zra-daemon/jsonc.js'
import { discoverAgents, isShimEntry, resolveAgentCommand, wrappedAgentId } from '../zra-daemon/agent-commands.js'
import { assertParsable, removeAgentServer, upsertAgentServer } from '../zra-daemon/zed-settings.js'
import { npmSafeArgs } from './lib/args.mjs'
import { daemonStatus } from './lib/daemon-status.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const STATE = join(ROOT, '.zra')
const SHIM = join(ROOT, 'zra-shim', 'index.js')

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const out = { command: 'status', apply: false, name: null, agents: [], record: true, port: null }
  const rest = npmSafeArgs(argv, ['apply', 'no-record'])
  if (rest[0] && !rest[0].startsWith('-')) out.command = rest.shift()
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (a === '--apply') out.apply = true
    else if (a === '--name') out.name = rest[++i]
    else if (a === '--agent') out.agents.push(rest[++i])
    else if (a === '--no-record') out.record = false
    else if (a === '--port') out.port = Number(rest[++i])
    else if (a === '--help' || a === '-h') out.command = 'help'
    // Mot nu : un agent. npm transmet toujours les mots nus, jamais `--agent x`.
    else if (!a.startsWith('-')) out.agents.push(a)
    else throw new Error(`option inconnue : ${a}`)
  }
  if (!['status', 'install', 'uninstall', 'help'].includes(out.command)) {
    throw new Error(`commande inconnue : ${out.command}`)
  }
  if (out.name && out.agents.length > 1) throw new Error('--name ne vaut que pour un seul agent')
  return out
}

const USAGE = `zra setup — brancher ZRA dans Zed

  npm run setup [-- <commande>] [options]

  status               état de l'installation (défaut)
  install [agent…]     une entrée ZRA par agent dans agent_servers. Sans agent
                       nommé : tous ceux que Zed sait lancer sur ce poste
  uninstall [--name]   retire les entrées ZRA (toutes, ou celle nommée)

  --apply              écrire pour de vrai (sans : simulation, rien n'est écrit) ;
                       « apply » tout court marche aussi, si npm avale le --apply
  --agent <id>         agent à envelopper (répétable ; un mot nu suffit)
  --name <id>          nom de l'entrée dans Zed, pour un seul agent
                       (défaut : claude-acp → claude-zra, qwen-code → qwen-code-zra)
  --no-record          ne pas enregistrer les trames (ZRA_RECORD)

  ex. npm run setup install apply
      npm run setup install qwen-code pi-acp apply
`

// ---------------------------------------------------------------------------
// L'entrée
// ---------------------------------------------------------------------------

/**
 * L'entrée `agent_servers` qui fait passer un agent par le shim.
 *
 * `command` est le Node qui exécute ce script, en chemin absolu : Zed lance ses
 * agents avec son propre environnement, on ne parie pas sur le PATH.
 *
 * `default_config_options` est recopié de l'agent enveloppé : sans ça, un
 * thread ouvert avec l'entrée ZRA partirait avec d'autres mode et modèle par
 * défaut que ceux que l'utilisateur a choisis dans Zed.
 */
export function buildEntry({ agent, record, nodePath = process.execPath, root = ROOT, wrapped = null }) {
  const env = {
    ZRA_AGENT_ID: agent,
    ZRA_LOG_FILE: join(root, '.zra', 'logs', 'shim.log'),
  }
  if (record) {
    env.ZRA_RECORD = '1'
    env.ZRA_RECORD_DIR = join(root, '.zra', 'records')
  }
  const entry = {
    type: 'custom',
    command: nodePath,
    args: [join(root, 'zra-shim', 'index.js')],
    env,
  }
  if (wrapped?.default_config_options && typeof wrapped.default_config_options === 'object') {
    entry.default_config_options = wrapped.default_config_options
  }
  return entry
}

/** Nom de l'entrée ZRA d'un agent : `claude-acp` → `claude-zra`, `qwen-code` → `qwen-code-zra`. */
export function zraName(agentId) {
  return `${String(agentId).replace(/-acp$/, '')}-zra`
}

/** Diff ligne à ligne minimal : on ne montre que la zone qui change. */
export function lineDiff(before, after) {
  const a = before.split(/\r?\n/)
  const b = after.split(/\r?\n/)
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++
  const out = []
  const ctx = 2
  for (let i = Math.max(0, head - ctx); i < head; i++) out.push(`    ${a[i]}`)
  for (let i = head; i < a.length - tail; i++) out.push(`  - ${a[i]}`)
  for (let i = head; i < b.length - tail; i++) out.push(`  + ${b[i]}`)
  for (let i = a.length - tail; i < Math.min(a.length, a.length - tail + ctx); i++) out.push(`    ${a[i]}`)
  return out.join('\n')
}

// ---------------------------------------------------------------------------
// Commandes
// ---------------------------------------------------------------------------

async function readSettings(file) {
  if (!existsSync(file)) throw new Error(`settings.json de Zed introuvable : ${file}`)
  const text = await readFile(file, 'utf8')
  let parsed
  try {
    parsed = parseJsonc(text)
  } catch (err) {
    throw new Error(`settings.json de Zed illisible, on n'y touche pas : ${err.message}`)
  }
  return { text, parsed, mtimeMs: statSync(file).mtimeMs }
}

/** Écrit après sauvegarde, en vérifiant que Zed n'a pas réécrit le fichier entre-temps. */
async function writeSettings(file, before, next) {
  if (statSync(file).mtimeMs !== before.mtimeMs) {
    throw new Error('settings.json modifié pendant l’opération (par Zed ?) : rien écrit, relancer la commande')
  }
  assertParsable(next)
  const backups = join(STATE, 'backups')
  await mkdir(backups, { recursive: true })
  const backup = join(backups, `settings.${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  await copyFile(file, backup)
  await writeFile(file, next, 'utf8')
  // Relecture : ce qui est sur le disque doit être exactement ce qu'on a voulu.
  const written = await readFile(file, 'utf8')
  if (written !== next) {
    await copyFile(backup, file)
    throw new Error('relecture différente de l’écriture : fichier restauré depuis la sauvegarde')
  }
  return backup
}

async function status(opts, config) {
  const file = config.zedSettings
  console.log(`settings.json de Zed : ${file}`)
  const { parsed } = await readSettings(file)
  const servers = parsed?.agent_servers ?? {}
  const zra = Object.entries(servers).filter(([, v]) => isShimEntry(v))

  if (!zra.length) {
    console.log('  ✗ aucune entrée ZRA — `npm run setup -- install` pour voir ce qui serait ajouté')
  }
  for (const [id, entry] of zra) {
    const expected = buildEntry({ agent: entry.env?.ZRA_AGENT_ID ?? '?', record: entry.env?.ZRA_RECORD === '1', wrapped: servers[entry.env?.ZRA_AGENT_ID] })
    const upToDate = entry.command === expected.command && entry.args?.[0] === expected.args[0]
    console.log(`  ✓ entrée « ${id} » → enveloppe « ${entry.env?.ZRA_AGENT_ID ?? '?'} »` +
      `${entry.env?.ZRA_RECORD === '1' ? ', enregistrement des trames' : ''}` +
      `${upToDate ? '' : '  ⚠ chemins différents de ce dépôt : relancer install'}`)
  }

  // Tous les agents du poste : enveloppés ou pas, lançables ou pas.
  const wrapped = new Set(zra.map(([, e]) => e.env?.ZRA_AGENT_ID))
  for (const a of await discoverAgents({ settingsFile: file, overrides: config.agentCommands })) {
    const tag = wrapped.has(a.id) ? 'via ZRA' : a.ok ? 'sans ZRA — `install` l’ajouterait' : 'non lançable'
    console.log(`agent « ${a.id} » : ${a.ok ? a.source : '✗ ' + a.reason} (${tag})`)
  }

  const port = opts.port ?? config.port
  const d = await daemonStatus(port)
  if (!d.ok) {
    console.log(`daemon 127.0.0.1:${port} : ✗ injoignable (${d.reason}) — \`npm run daemon:dev\``)
    return
  }
  console.log(`daemon 127.0.0.1:${port} : ✓ v${d.version}, injection ${d.injection}, Zed ${d.zedRunning ? 'lancé' : 'fermé'}`)
  console.log(`  threads : ${d.threads.live} live · ${d.threads.closed} fermés · ${d.threads.unknown} inconnus`)
  if (!d.shims.length) console.log('  shims   : aucun — ouvrir un thread avec l’agent ZRA dans Zed')
  for (const s of d.shims) {
    console.log(`  shim ${s.shimId} : ${s.agentId ?? '—'}, ${s.sessions.length} session(s)${s.loadSession ? ', loadSession' : ''}`)
  }
}

async function install(opts, config) {
  const file = config.zedSettings
  const before = await readSettings(file)
  const servers = before.parsed?.agent_servers ?? {}

  if (!existsSync(SHIM)) throw new Error(`shim introuvable : ${SHIM}`)
  const resolveOpts = { settingsFile: file, overrides: config.agentCommands }

  // Quels agents envelopper. Nommés : chacun doit être lançable, sinon Zed
  // afficherait une erreur au premier thread. Découverts : on prend ceux qui le
  // sont, on dit pourquoi on saute les autres, sans échouer pour autant.
  let agents
  if (opts.agents.length) {
    agents = []
    for (const id of opts.agents) {
      const cmd = await resolveAgentCommand(id, resolveOpts)
      agents.push({ id, source: cmd.source })
    }
  } else {
    const found = await discoverAgents(resolveOpts)
    for (const a of found.filter((x) => !x.ok)) console.log(`  – ${a.id} ignoré : ${a.reason}`)
    agents = found.filter((x) => x.ok)
    if (!agents.length) {
      throw new Error(
        'aucun agent lançable sur ce poste. Ouvrir une fois un thread avec l’agent voulu dans Zed ' +
        '(Zed l’installe à ce moment-là), ou le déclarer dans agentCommands de zra.config.json',
      )
    }
  }

  // Entrée ZRA déjà posée pour un agent : on la met à jour sous son nom actuel.
  const existing = new Map(Object.entries(servers).filter(([, v]) => isShimEntry(v)).map(([k, v]) => [wrappedAgentId(v), k]))

  let text = before.text
  const changes = []
  for (const { id, source } of agents) {
    const name = opts.name ?? existing.get(id) ?? zraName(id)
    if (servers[name] && !isShimEntry(servers[name])) {
      const msg = `« ${name} » existe déjà dans agent_servers et n'est pas une entrée ZRA`
      if (opts.name) throw new Error(`${msg} : choisir un autre --name`)
      console.log(`  – ${id} ignoré : ${msg}`)
      continue
    }
    const entry = buildEntry({ agent: id, record: opts.record, wrapped: servers[id] })
    // Mode et modèle réglés depuis sur l'entrée ZRA elle-même : ils restent.
    const mine = servers[name]?.default_config_options
    if (mine && typeof mine === 'object') entry.default_config_options = mine
    const res = upsertAgentServer(text, name, entry)
    text = res.text
    console.log(`  ${res.action === 'unchanged' ? '✓' : '+'} ${name} → ${id} (${source})${res.action === 'unchanged' ? ' — déjà à jour' : ''}`)
    if (res.action !== 'unchanged') changes.push(name)
  }
  if (!changes.length) {
    console.log('✓ rien à faire')
    return
  }

  console.log(`\n${changes.map((n) => `agent_servers.${n}`).join(', ')} dans ${file} :\n`)
  console.log(lineDiff(before.text, text))
  if (!opts.apply) {
    console.log('\nsimulation : rien n’a été écrit. Relancer avec --apply (ou « apply » tout court) pour appliquer.')
    return
  }
  const backup = await writeSettings(file, before, text)
  console.log(`\n✓ écrit. Sauvegarde : ${backup}`)
  console.log(`  Zed recharge settings.json à chaud : les agents « (ZRA) » apparaissent dans le menu des nouveaux threads.`)
}

async function uninstall(opts, config) {
  const file = config.zedSettings
  const before = await readSettings(file)
  const servers = before.parsed?.agent_servers ?? {}
  const names = opts.name && servers[opts.name] ? [opts.name] : Object.keys(servers).filter((k) => isShimEntry(servers[k]))
  if (!names.length) {
    console.log('✓ aucune entrée ZRA dans settings.json : rien à retirer')
    return
  }
  let text = before.text
  for (const name of names) {
    if (!isShimEntry(servers[name])) throw new Error(`« ${name} » n'est pas une entrée ZRA : on n'y touche pas`)
    text = removeAgentServer(text, name).text
  }
  console.log(`\nretrait de ${names.map((n) => `agent_servers.${n}`).join(', ')} dans ${file} :\n`)
  console.log(lineDiff(before.text, text))
  if (!opts.apply) {
    console.log('\nsimulation : rien n’a été écrit. Relancer avec --apply (ou « apply » tout court) pour appliquer.')
    return
  }
  const backup = await writeSettings(file, before, text)
  console.log(`\n✓ retiré. Sauvegarde : ${backup}`)
  console.log('  Les threads ouverts avec cette entrée restent dans le sidebar de Zed, sans agent pour les rouvrir.')
}

// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.command === 'help') return console.log(USAGE)
  const config = await loadConfig()
  if (opts.command === 'status') return status(opts, config)
  if (opts.command === 'install') return install(opts, config)
  if (opts.command === 'uninstall') return uninstall(opts, config)
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  main().catch((err) => {
    console.error(`✗ ${err.message}`)
    process.exit(1)
  })
}
