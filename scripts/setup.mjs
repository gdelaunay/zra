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
import { isShimEntry, resolveAgentCommand } from '../zra-daemon/agent-commands.js'
import { assertParsable, removeAgentServer, upsertAgentServer } from '../zra-daemon/zed-settings.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const STATE = join(ROOT, '.zra')
const SHIM = join(ROOT, 'zra-shim', 'index.js')

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { command: 'status', apply: false, name: 'claude-zra', agent: 'claude-acp', record: true, port: null }
  const rest = [...argv]
  if (rest[0] && !rest[0].startsWith('-')) out.command = rest.shift()
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (a === '--apply') out.apply = true
    else if (a === '--name') out.name = rest[++i]
    else if (a === '--agent') out.agent = rest[++i]
    else if (a === '--no-record') out.record = false
    else if (a === '--port') out.port = Number(rest[++i])
    else if (a === '--help' || a === '-h') out.command = 'help'
    else throw new Error(`option inconnue : ${a}`)
  }
  if (!['status', 'install', 'uninstall', 'help'].includes(out.command)) {
    throw new Error(`commande inconnue : ${out.command}`)
  }
  return out
}

const USAGE = `zra setup — brancher ZRA dans Zed

  npm run setup [-- <commande>] [options]

  status               état de l'installation (défaut)
  install              ajoute l'entrée ZRA à agent_servers
  uninstall            la retire

  --apply              écrire pour de vrai (sans : simulation, rien n'est écrit)
  --name <id>          nom de l'entrée dans Zed (défaut claude-zra)
  --agent <id>         agent à envelopper (défaut claude-acp)
  --no-record          ne pas enregistrer les trames (ZRA_RECORD)
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

async function daemonStatus(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(1500) })
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` }
    return { ok: true, ...(await res.json()) }
  } catch (err) {
    return { ok: false, reason: err.cause?.code || err.name || err.message }
  }
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
    const expected = buildEntry({ agent: entry.env?.ZRA_AGENT_ID ?? opts.agent, record: entry.env?.ZRA_RECORD === '1', wrapped: servers[entry.env?.ZRA_AGENT_ID] })
    const upToDate = entry.command === expected.command && entry.args?.[0] === expected.args[0]
    console.log(`  ✓ entrée « ${id} » → enveloppe « ${entry.env?.ZRA_AGENT_ID ?? '?'} »` +
      `${entry.env?.ZRA_RECORD === '1' ? ', enregistrement des trames' : ''}` +
      `${upToDate ? '' : '  ⚠ chemins différents de ce dépôt : relancer install'}`)
  }

  const agentId = zra[0]?.[1].env?.ZRA_AGENT_ID ?? opts.agent
  try {
    const cmd = await resolveAgentCommand(agentId, { settingsFile: file, overrides: config.agentCommands })
    console.log(`agent « ${agentId} » : ${cmd.source} — ${cmd.command} ${cmd.args.join(' ')}`)
  } catch (err) {
    console.log(`agent « ${agentId} » : ✗ ${err.message}`)
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
  if (servers[opts.name] && !isShimEntry(servers[opts.name])) {
    throw new Error(`« ${opts.name} » existe déjà dans agent_servers et n'est pas une entrée ZRA : choisir un autre --name`)
  }
  if (!servers[opts.agent]) {
    console.log(`⚠ « ${opts.agent} » n'est pas déclaré dans agent_servers : le shim le cherchera dans le registry de Zed`)
  }
  // L'agent enveloppé doit être lançable, sinon Zed afficherait une erreur au
  // premier thread : autant le dire maintenant.
  const cmd = await resolveAgentCommand(opts.agent, { settingsFile: file, overrides: config.agentCommands })
  console.log(`agent enveloppé : ${opts.agent} (${cmd.source})`)

  const entry = buildEntry({ agent: opts.agent, record: opts.record, wrapped: servers[opts.agent] })
  const { text, action } = upsertAgentServer(before.text, opts.name, entry)
  if (action === 'unchanged') {
    console.log(`✓ entrée « ${opts.name} » déjà à jour : rien à faire`)
    return
  }

  console.log(`\n${action === 'added' ? 'ajout' : 'mise à jour'} de agent_servers.${opts.name} dans ${file} :\n`)
  console.log(lineDiff(before.text, text))
  if (!opts.apply) {
    console.log('\nsimulation : rien n’a été écrit. Relancer avec --apply pour appliquer.')
    return
  }
  const backup = await writeSettings(file, before, text)
  console.log(`\n✓ écrit. Sauvegarde : ${backup}`)
  console.log(`  Zed recharge settings.json à chaud : l'agent « ${opts.name} » apparaît dans le menu des nouveaux threads.`)
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
    console.log('\nsimulation : rien n’a été écrit. Relancer avec --apply pour appliquer.')
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
