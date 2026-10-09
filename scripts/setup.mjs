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
// Et **un** bloc en tête du `keymap.json` : une touche par entrée ZRA
// (Ctrl+Alt+Shift+F1…) liée à `agent::NewExternalAgentThread`, que le daemon
// joue pour ouvrir un thread avec l'agent choisi sur le mobile. Encadré de
// deux commentaires repères, retiré tel quel par `uninstall`.
//
// Tout ce que le shim produit reste dans le dépôt, sous `.zra/` (ignoré par
// git) : journal, enregistrements de trames, sauvegardes du settings.json.
//
// Édition chirurgicale (`zra-daemon/zed-settings.js`) : le fichier n'est jamais
// re-sérialisé, commentaires et mise en forme restent tels quels.

import { existsSync, statSync } from 'node:fs'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadConfig } from '../zra-daemon/config.js'
import { parseJsonc } from '../zra-daemon/jsonc.js'
import { discoverAgents, isShimEntry, resolveAgentCommand, wrappedAgentId } from '../zra-daemon/agent-commands.js'
import { assertParsable, removeAgentServer, upsertAgentServer } from '../zra-daemon/zed-settings.js'
import { assignKeys, readZraKeys, removeZraKeymap, upsertZraKeymap } from '../zra-daemon/zed-keymap.js'
import { npmSafeArgs } from './lib/args.mjs'
import { daemonStatus } from './lib/daemon-status.mjs'
import { isWayland, findZedDesktop, patchDesktopForXWayland, unpatchDesktop } from './lib/wayland.mjs'

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

/**
 * Écrit après sauvegarde, en vérifiant que Zed n'a pas réécrit le fichier
 * entre-temps. Un fichier qui n'existait pas (`mtimeMs: null`) est créé, sans
 * sauvegarde puisqu'il n'y a rien à sauver.
 * @returns {Promise<string|null>} chemin de la sauvegarde
 */
async function writeZedFile(file, before, next) {
  const name = basename(file)
  const exists = existsSync(file)
  if ((exists ? statSync(file).mtimeMs : null) !== before.mtimeMs) {
    throw new Error(`${name} modifié pendant l’opération (par Zed ?) : rien écrit, relancer la commande`)
  }
  assertParsable(next)
  let backup = null
  if (exists) {
    const backups = join(STATE, 'backups')
    await mkdir(backups, { recursive: true })
    backup = join(backups, `${name.replace(/\.json$/, '')}.${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
    await copyFile(file, backup)
  }
  await writeFile(file, next, 'utf8')
  // Relecture : ce qui est sur le disque doit être exactement ce qu'on a voulu.
  const written = await readFile(file, 'utf8')
  if (written !== next) {
    if (backup) await copyFile(backup, file)
    throw new Error(`relecture différente de l’écriture${backup ? ' : fichier restauré depuis la sauvegarde' : ''}`)
  }
  return backup
}

async function readKeymap(file) {
  if (!existsSync(file)) return { text: null, mtimeMs: null }
  const text = await readFile(file, 'utf8')
  try {
    parseJsonc(text)
  } catch (err) {
    throw new Error(`keymap.json de Zed illisible, on n'y touche pas : ${err.message}`)
  }
  return { text, mtimeMs: statSync(file).mtimeMs }
}

/**
 * Le bloc de touches qui va avec ces réglages : une par entrée ZRA, celles
 * déjà posées gardées. Plus d'entrée ZRA, plus de bloc.
 */
export function keymapFor(settingsText, keymapText) {
  const servers = parseJsonc(settingsText)?.agent_servers ?? {}
  const names = Object.keys(servers).filter((k) => isShimEntry(servers[k]))
  if (!names.length) {
    return keymapText ? removeZraKeymap(keymapText) : { text: keymapText, action: 'absent' }
  }
  const keys = assignKeys(names, readZraKeys(keymapText ?? ''))
  return { ...upsertZraKeymap(keymapText, keys), keys }
}

async function status(opts, config) {
  const file = config.zedSettings
  console.log(`settings.json de Zed : ${file}`)
  const { parsed } = await readSettings(file)
  const servers = parsed?.agent_servers ?? {}
  const zra = Object.entries(servers).filter(([, v]) => isShimEntry(v))
  const keys = readZraKeys((await readKeymap(config.zedKeymap)).text ?? '')

  if (!zra.length) {
    console.log('  ✗ aucune entrée ZRA — `npm run setup -- install` pour voir ce qui serait ajouté')
  }
  for (const [id, entry] of zra) {
    const expected = buildEntry({ agent: entry.env?.ZRA_AGENT_ID ?? '?', record: entry.env?.ZRA_RECORD === '1', wrapped: servers[entry.env?.ZRA_AGENT_ID] })
    const upToDate = entry.command === expected.command && entry.args?.[0] === expected.args[0]
    console.log(`  ✓ entrée « ${id} » → enveloppe « ${entry.env?.ZRA_AGENT_ID ?? '?'} »` +
      `${entry.env?.ZRA_RECORD === '1' ? ', enregistrement des trames' : ''}` +
      `${upToDate ? '' : '  ⚠ chemins différents de ce dépôt : relancer install'}`)
    console.log(keys.has(id)
      ? `      nouveau thread : ${keys.get(id)} (keymap.json)`
      : '      ⚠ pas de touche dans keymap.json : le mobile ouvrirait le dernier agent utilisé — relancer install')
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

  // Wayland : statut du .desktop
  if (isWayland()) {
    const desktopFile = findZedDesktop()
    if (desktopFile) {
      const content = await readFile(desktopFile, 'utf8')
      const patched = /^Exec=env WAYLAND_DISPLAY= /m.test(content)
      console.log(`.desktop de Zed : ${patched ? '✓ XWayland forcé' : '✗ XWayland non forcé — `install --apply` pour activer le pilotage clavier'}`)
    }
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
  const kmFile = config.zedKeymap
  const kmBefore = await readKeymap(kmFile)
  const km = keymapFor(text, kmBefore.text)
  const kmChanged = km.action === 'added' || km.action === 'replaced' || km.action === 'removed'
  for (const [name, key] of km.keys ?? []) console.log(`  ${kmChanged ? '+' : '✓'} ${key} → nouveau thread ${name}`)

  if (!changes.length && !kmChanged) {
    console.log('✓ rien à faire')
    return
  }

  if (changes.length) {
    console.log(`\n${changes.map((n) => `agent_servers.${n}`).join(', ')} dans ${file} :\n`)
    console.log(lineDiff(before.text, text))
  }
  if (kmChanged) {
    console.log(`\nraccourcis « nouveau thread » dans ${kmFile}${kmBefore.text === null ? ' (créé)' : ''} :\n`)
    console.log(lineDiff(kmBefore.text ?? '', km.text))
  }
  if (!opts.apply) {
    console.log('\nsimulation : rien n’a été écrit. Relancer avec --apply (ou « apply » tout court) pour appliquer.')
    return
  }
  if (changes.length) {
    const backup = await writeZedFile(file, before, text)
    console.log(`\n✓ settings.json écrit. Sauvegarde : ${backup}`)
    console.log(`  Zed recharge settings.json à chaud : les agents « (ZRA) » apparaissent dans le menu des nouveaux threads.`)
  }
  if (kmChanged) {
    const backup = await writeZedFile(kmFile, kmBefore, km.text)
    console.log(`\n✓ keymap.json écrit.${backup ? ` Sauvegarde : ${backup}` : ''}`)
  }

  // Wayland : forcer Zed sous XWayland pour que xdotool voie ses fenêtres
  const desktop = await patchDesktopForXWayland(opts.apply)
  if (desktop.action === 'patched') {
    console.log(`\n✓ .desktop de Zed modifié pour forcer XWayland. Sauvegarde : ${desktop.backup}`)
    console.log('  Redémarrer Zed pour que le changement prenne effet.')
  } else if (desktop.action === 'dry-run') {
    console.log('\n.desktop de Zed : forcer XWayland sous Wayland (simulation) :\n')
    console.log(lineDiff(desktop.original, desktop.patched))
    console.log('\nsimulation : le .desktop n\'a pas été modifié. Relancer avec --apply pour appliquer.')
  }
}

async function uninstall(opts, config) {
  const file = config.zedSettings
  const before = await readSettings(file)
  const servers = before.parsed?.agent_servers ?? {}
  const names = opts.name && servers[opts.name] ? [opts.name] : Object.keys(servers).filter((k) => isShimEntry(servers[k]))
  let text = before.text
  for (const name of names) {
    if (!isShimEntry(servers[name])) throw new Error(`« ${name} » n'est pas une entrée ZRA : on n'y touche pas`)
    text = removeAgentServer(text, name).text
  }
  // Les touches suivent les entrées qui restent ; plus aucune, plus de bloc.
  const kmFile = config.zedKeymap
  const kmBefore = await readKeymap(kmFile)
  const km = keymapFor(text, kmBefore.text)
  const kmChanged = km.action === 'removed' || km.action === 'replaced'

  if (!names.length && !kmChanged) {
    console.log('✓ aucune entrée ZRA dans settings.json ni dans keymap.json : rien à retirer')
    return
  }
  if (names.length) {
    console.log(`\nretrait de ${names.map((n) => `agent_servers.${n}`).join(', ')} dans ${file} :\n`)
    console.log(lineDiff(before.text, text))
  }
  if (kmChanged) {
    console.log(`\nraccourcis ZRA dans ${kmFile} :\n`)
    console.log(lineDiff(kmBefore.text, km.text))
  }
  if (!opts.apply) {
    console.log('\nsimulation : rien n’a été écrit. Relancer avec --apply (ou « apply » tout court) pour appliquer.')
    return
  }
  if (names.length) {
    const backup = await writeZedFile(file, before, text)
    console.log(`\n✓ retiré. Sauvegarde : ${backup}`)
    console.log('  Les threads ouverts avec cette entrée restent dans le sidebar de Zed, sans agent pour les rouvrir.')
  }
  if (kmChanged) {
    const backup = await writeZedFile(kmFile, kmBefore, km.text)
    console.log(`\n✓ raccourcis retirés du keymap.json. Sauvegarde : ${backup}`)
  }

  // Wayland : retirer le forçage XWayland du .desktop
  const desktop = await unpatchDesktop(opts.apply)
  if (desktop.action === 'restored') {
    console.log(`\n✓ .desktop de Zed restauré (XWayland retiré). Sauvegarde : ${desktop.backup}`)
    console.log('  Redémarrer Zed pour que le changement prenne effet.')
  } else if (desktop.action === 'dry-run') {
    console.log('\n.desktop de Zed : retirer le forçage XWayland (simulation) :\n')
    console.log(lineDiff(desktop.original, desktop.restored))
    console.log('\nsimulation : le .desktop n\'a pas été restauré. Relancer avec --apply pour appliquer.')
  }
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
