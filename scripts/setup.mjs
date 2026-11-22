#!/usr/bin/env node
// Brancher ZRA dans Zed : installation.
//
//   npm run setup                       état : entrée Zed, agent, daemon
//   npm run setup -- install            montre ce qui serait écrit, n'écrit rien
//   npm run setup -- install --apply    écrit (sauvegarde préalable)
//   npm run setup -- uninstall --apply  retire l'env ZRA et les entrées « … (zra) »
//
// Ce que fait l'installation :
//  · agent npx (registry, lancé par node) : l'entrée d'origine reste `registry`
//    — Zed garde l'installation et les mises à jour — et son `env` porte un
//    preload node (`NODE_OPTIONS`) qui lance le shim avant le code de l'agent.
//    Tous les threads de cet agent, anciens compris, passent par le shim.
//    L'entrée custom « … (zra) » d'une installation précédente est retirée.
//  · agent binaire (non-node) : une entrée custom « … (zra) » à côté —
//    `NODE_OPTIONS` n'a pas d'effet sur un binaire.
//  · un bloc en tête du `keymap.json` : une touche par entrée shimée
//    (Ctrl+Alt+Shift+F1…) liée à `agent::NewExternalAgentThread`, que le daemon
//    joue pour ouvrir un thread avec l'agent choisi sur le mobile. Encadré de
//    deux commentaires repères, retiré tel quel par `uninstall`.
//
// Le retrait propre est `uninstall` : il rend l'env et les entrées à leur état
// d'origine. Supprimer le dossier ZRA sans uninstall ne casse rien : le
// preload est fail-open (l'agent démarre sans ZRA).
//
// Tout ce que le shim produit reste dans le dépôt, sous `.zra/` (ignoré par
// git) : journal, sauvegardes du settings.json, enregistrements de trames
// (`--record`, débogage).
//
// Édition chirurgicale (`zra-daemon/zed-settings.js`) : le fichier n'est jamais
// re-sérialisé, commentaires et mise en forme restent tels quels.

import { existsSync, statSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadConfig } from '../zra-daemon/config.js'
import { agentLabel, isZedRunning } from '../zra-daemon/agents.js'
import { defaultZedCli, detectZedChannel } from '../zra-daemon/platform.js'
import { parseJsonc } from '../zra-daemon/jsonc.js'
import { discoverAgents, hasPreload, isPreloadEntry, isShimEntry, preloadFlag, registryAgentName, resolveAgentCommand, stripPreload, wrappedAgentId } from '../zra-daemon/agent-commands.js'
import { assertParsable, removeAgentServer, removeAgentServerEnv, removeRootMember, upsertAgentServer, upsertAgentServerEnv, upsertRootMember } from '../zra-daemon/zed-settings.js'
import { assignKeys, readZraKeys, removeZraKeymap, upsertZraKeymap } from '../zra-daemon/zed-keymap.js'
import { npmSafeArgs } from './lib/args.mjs'
import { daemonStatus } from './lib/daemon-status.mjs'
import { offerTrayDownload } from './lib/tray-download.mjs'
import { serviceState } from './service.mjs'
import { isWayland, findZedDesktop, patchDesktopForXWayland, unpatchDesktop } from './lib/wayland.mjs'
import { tr } from '../zra-daemon/i18n.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const STATE = join(ROOT, '.zra')
const SHIM = join(ROOT, 'zra-shim', 'index.js')

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const out = { command: 'status', apply: false, name: null, agents: [], record: false, yes: false, port: null, cert: null, key: null }
  const rest = npmSafeArgs(argv, ['apply', 'record', 'yes'])
  if (rest[0] && !rest[0].startsWith('-')) out.command = rest.shift()
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (a === '--apply') out.apply = true
    else if (a === '--name') out.name = rest[++i]
    else if (a === '--agent') out.agents.push(rest[++i])
    else if (a === '--record') out.record = true
    else if (a === '--yes' || a === '-y') out.yes = true
    else if (a === '--port') out.port = Number(rest[++i])
    else if (a === '--cert') out.cert = rest[++i]
    else if (a === '--key') out.key = rest[++i]
    else if (a === '--help' || a === '-h') out.command = 'help'
    // Mot nu : un agent. npm transmet toujours les mots nus, jamais `--agent x`.
    else if (!a.startsWith('-')) out.agents.push(a)
    else throw new Error(tr`Option inconnue : ${a}`)
  }
  if (!['status', 'install', 'uninstall', 'xwayland', 'discover', 'tls', 'help'].includes(out.command)) {
    throw new Error(tr`Commande inconnue : ${out.command}`)
  }
  if (out.name && out.agents.length > 1) throw new Error(tr`--name ne vaut que pour un seul agent.`)
  return out
}

const USAGE = tr`zra setup — brancher ZRA dans Zed

  npm run setup [-- <commande>] [options]

  status               état de l'installation (défaut)
  install [agent…]     shime les agents : l'entrée d'origine par preload (agents
                       npx), une entrée « … (zra) » à côté (binaires). Sans agent
                       nommé : tous ceux que Zed sait lancer sur ce poste
  uninstall [--name]   retire l'env ZRA des entrées d'origine et les entrées
                       « … (zra) » (toutes, ou celles nommées)
  xwayland             (Linux/Wayland) force Zed sous XWayland pour le clavier :
                       modifie le .desktop de Zed, étape séparée de l'installation

  --apply              écrire pour de vrai (sans : simulation, rien n'est écrit) ;
                       « apply » tout court marche aussi, si npm avale le --apply
  --agent <id>         agent à envelopper (répétable ; un mot nu suffit)
  --name <id>          nom de l'entrée dans Zed, pour un seul agent
                       (défaut : « Claude Agent (zra) », « Qwen Code (zra) »…)
  --yes                ne pas demander confirmation avant de renommer ou retirer
                       des entrées ZRA existantes (« yes » tout court marche aussi)
  --record             débogage : enregistre toutes les trames ACP dans
                       .zra/records/ (ZRA_RECORD), conversations comprises

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
 * `default_mode`, `default_config_options` et `favorite_config_option_values`
 * sont recopiés de l'agent enveloppé : sans ça, un thread ouvert avec l'entrée
 * ZRA partirait avec d'autres mode, modèle et favoris que ceux que
 * l'utilisateur a choisis dans Zed.
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
  // Son `env`, lui, est appliqué par le shim (`resolveAgentCommand`).
  carryStartSettings(entry, wrapped)
  return entry
}

/** Réglages de démarrage d'une entrée (`CustomAgentServerSettings`). */
const START_SETTINGS = ['default_mode', 'default_config_options', 'favorite_config_option_values']

/**
 * L'env qui shime une entrée `registry` : preload node (`NODE_OPTIONS`), id de
 * l'agent pour le shim, journal. Un `NODE_OPTIONS` déjà là (l'utilisateur) est
 * conservé à la suite du nôtre ; le nôtre, s'il y est déjà (réinstallation,
 * dépôt déplacé), est remplacé.
 */
export function buildPreloadEnv({ agent, record, root = ROOT, existing = null }) {
  const env = {
    NODE_OPTIONS: [preloadFlag(root), stripPreload(existing)].filter(Boolean).join(' '),
    ZRA_AGENT_ID: agent,
    ZRA_LOG_FILE: join(root, '.zra', 'logs', 'shim.log'),
  }
  if (record) {
    env.ZRA_RECORD = '1'
    env.ZRA_RECORD_DIR = join(root, '.zra', 'records')
  }
  return env
}

/** Recopie dans `entry` les réglages de démarrage présents dans `from`. */
function carryStartSettings(entry, from) {
  for (const key of START_SETTINGS) {
    const v = from?.[key]
    if (key === 'default_mode' ? typeof v === 'string' && v : v && typeof v === 'object') entry[key] = v
  }
}

/**
 * Nom de l'entrée ZRA d'un agent : Zed affiche la clé telle quelle.
 * `claude-acp` (« Claude Agent » dans le registry) → `Claude Agent (zra)`.
 */
export function zraName(agentId, displayName = null) {
  return `${displayName || agentLabel(agentId)} (zra)`
}

/** Entrée ZRA au nom d'avant (`claude-zra`), à renommer. */
const isLegacyName = (name) => /-zra$/.test(name)

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
  if (!existsSync(file)) throw new Error(tr`settings.json de Zed introuvable : ${file} — ZRA supporte l'installation native de Zed (pas Flatpak/Snap) ; chemins personnalisables via zedDb/zedSettings dans zra.config.json.`)
  const text = await readFile(file, 'utf8')
  let parsed
  try {
    parsed = parseJsonc(text)
  } catch (err) {
    throw new Error(tr`settings.json de Zed illisible, on n'y touche pas : ${err.message}`)
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
    throw new Error(tr`${name} modifié pendant l’opération (par Zed ?) : rien écrit, relancer la commande.`)
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
    throw new Error(backup ? tr`Relecture différente de l’écriture : fichier restauré depuis la sauvegarde.` : tr`Relecture différente de l’écriture.`)
  }
  return backup
}

async function readKeymap(file) {
  if (!existsSync(file)) return { text: null, mtimeMs: null }
  const text = await readFile(file, 'utf8')
  try {
    parseJsonc(text)
  } catch (err) {
    throw new Error(tr`keymap.json de Zed illisible, on n'y touche pas : ${err.message}`)
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
  console.log(tr`settings.json de Zed : ${file}`)
  const { parsed } = await readSettings(file)
  const servers = parsed?.agent_servers ?? {}
  const zra = Object.entries(servers).filter(([, v]) => isShimEntry(v))
  const keys = readZraKeys((await readKeymap(config.zedKeymap)).text ?? '')

  if (!zra.length) {
    console.log(tr`  ✗ aucune entrée ZRA — \`npm run setup -- install\` pour voir ce qui serait ajouté.`)
  }
  for (const [id, entry] of zra) {
    const preload = isPreloadEntry(entry)
    const expected = preload ? null : buildEntry({ agent: entry.env?.ZRA_AGENT_ID ?? '?', record: entry.env?.ZRA_RECORD === '1', wrapped: servers[entry.env?.ZRA_AGENT_ID] })
    const upToDate = preload
      ? hasPreload(entry.env?.NODE_OPTIONS, ROOT)
      : entry.command === expected.command && entry.args?.[0] === expected.args[0]
    const what = preload ? tr`(registry) → shim par preload node.` : tr`→ enveloppe « ${entry.env?.ZRA_AGENT_ID ?? '?'} ».`
    console.log(tr`  ✓ entrée « ${id} » ${what}` +
      (entry.env?.ZRA_RECORD === '1' ? tr`, enregistrement des trames (débogage : relancer install sans --record pour l’arrêter).` : '') +
      (upToDate ? '' : tr`  ⚠ chemins différents de ce dépôt : relancer install.`))
    console.log(keys.has(id)
      ? tr`      Nouveau thread : ${keys.get(id)} (keymap.json).`
      : tr`      ⚠ pas de touche dans keymap.json : le mobile ouvrirait le dernier agent utilisé — relancer install.`)
  }

  // Tous les agents du poste : enveloppés ou pas, lançables ou pas.
  const wrapped = new Set(zra.map(([, e]) => e.env?.ZRA_AGENT_ID))
  for (const a of await discoverAgents({ settingsFile: file, overrides: config.agentCommands })) {
    const tag = wrapped.has(a.id) ? tr`Via ZRA` : a.ok ? tr`Sans ZRA — \`install\` l’ajouterait.` : tr`Non lançable.`
    console.log(tr`Agent « ${a.id} » : ${a.ok ? a.source : '✗ ' + a.reason} (${tag}).`)
  }

  const port = opts.port ?? config.port
  const d = await daemonStatus(port)
  if (!d.ok) {
    console.log(tr`Daemon 127.0.0.1:${port} : ✗ injoignable (${d.reason}) — \`npm run daemon:dev\`.`)
    return
  }
  console.log(tr`Daemon 127.0.0.1:${port} : ✓ v${d.version}, injection ${d.injection}, Zed ${d.zedRunning ? tr`Lancé` : tr`Fermé`}`)
  console.log(tr`  Threads : ${d.threads.live} live · ${d.threads.closed} fermés · ${d.threads.unknown} inconnus.`)
  if (!d.shims.length) console.log(tr`  Shims   : aucun — ouvrir un thread avec l’agent ZRA dans Zed.`)
  for (const s of d.shims) {
    console.log(`  shim ${s.shimId} : ${s.agentId ?? '—'}, ${s.sessions.length} session(s)${s.loadSession ? ', loadSession' : ''}`)
  }

  // Wayland : statut du .desktop
  if (isWayland()) {
    const desktopFile = findZedDesktop()
    if (desktopFile) {
      const content = await readFile(desktopFile, 'utf8')
      const patched = /^Exec=env WAYLAND_DISPLAY= /m.test(content)
      console.log(patched ? tr`.desktop de Zed : ✓ XWayland forcé.` : tr`.desktop de Zed : ✗ XWayland non forcé — \`install --apply\` pour activer le pilotage clavier.`)
    }
  }
}

async function install(opts, config) {
  const file = config.zedSettings
  const before = await readSettings(file)
  const servers = before.parsed?.agent_servers ?? {}

  if (!existsSync(SHIM)) throw new Error(tr`Shim introuvable : ${SHIM}`)
  const resolveOpts = { settingsFile: file, overrides: config.agentCommands }

  // Quels agents envelopper. Nommés : chacun doit être lançable, sinon Zed
  // afficherait une erreur au premier thread. Découverts : on prend ceux qui le
  // sont, on dit pourquoi on saute les autres, sans échouer pour autant.
  let agents
  if (opts.agents.length) {
    agents = []
    for (const id of opts.agents) {
      const cmd = await resolveAgentCommand(id, resolveOpts)
      agents.push({ id, source: cmd.source, viaNode: cmd.viaNode })
    }
  } else {
    const found = await discoverAgents(resolveOpts)
    for (const a of found.filter((x) => !x.ok)) console.log(tr`  – ${a.id} ignoré : ${a.reason}`)
    agents = found.filter((x) => x.ok)
    if (!agents.length) {
      throw new Error(
        tr`Aucun agent lançable sur ce poste. Ouvrir une fois un thread avec l’agent voulu dans Zed (Zed l’installe à ce moment-là), ou le déclarer dans agentCommands de zra.config.json.`,
      )
    }
  }

  // Entrée ZRA custom déjà posée pour un agent : on la met à jour sous son nom
  // actuel, ou on la dégage au profit du preload (agent npx).
  const existing = new Map(Object.entries(servers).filter(([, v]) => isShimEntry(v) && !isPreloadEntry(v)).map(([k, v]) => [wrappedAgentId(v), k]))

  let text = before.text
  const changes = []
  const renamed = []
  const dropped = []
  for (const { id, source, viaNode } of agents) {
    // Agent npx lancé par node : l'entrée d'origine elle-même passe par le
    // shim, son env porte le preload. Elle reste `registry` : Zed continue
    // d'installer et de mettre à jour l'agent, et tous les threads de cet
    // agent — anciens compris — deviennent pilotables.
    if (viaNode) {
      if (opts.name) throw new Error(tr`--name ne s'applique pas à un agent shimé par preload : l'entrée est celle d'origine (${id}).`)
      const old = existing.get(id)
      if (old) {
        text = removeAgentServer(text, old).text
        delete servers[old]
        dropped.push([old, id])
        console.log(tr`  – ${old} retirée : l'entrée d'origine « ${id} » passe par le shim.`)
      }
      if (!servers[id]) {
        text = upsertAgentServer(text, id, { type: 'registry' }).text
        servers[id] = { type: 'registry' }
      }
      const patch = buildPreloadEnv({ agent: id, record: opts.record, existing: servers[id].env?.NODE_OPTIONS })
      const res = upsertAgentServerEnv(text, id, patch)
      text = res.text
      console.log(`  ${res.action === 'unchanged' ? '✓' : '+'} ${id} → shim par preload (${source})${res.action === 'unchanged' ? tr` — déjà à jour.` : ''}`)
      if (res.action !== 'unchanged') changes.push(id)
      continue
    }
    const old = existing.get(id)
    // Une entrée au nom d'avant (`claude-zra`) prend le nom d'affichage ; un
    // nom choisi (`--name` ou à la main) reste.
    const name = opts.name ?? (old && !isLegacyName(old) ? old : zraName(id, await registryAgentName(id)))
    let carried = null
    if (old && old !== name && servers[name] === undefined) {
      renamed.push([old, name])
      carried = servers[old]
      text = removeAgentServer(text, old).text
      delete servers[old]
      console.log(tr`  ↻ ${old} renommé en ${name}`)
    }
    if (servers[name] && !isShimEntry(servers[name])) {
      const msg = tr`« ${name} » existe déjà dans agent_servers et n'est pas une entrée ZRA.`
      if (opts.name) throw new Error(tr`${msg} : choisir un autre --name.`)
      console.log(tr`  – ${id} ignoré : ${msg}`)
      continue
    }
    const entry = buildEntry({ agent: id, record: opts.record, wrapped: servers[id] })
    // Réglés depuis sur l'entrée ZRA elle-même : ils restent.
    carryStartSettings(entry, carried ?? servers[name])
    const res = upsertAgentServer(text, name, entry)
    text = res.text
    console.log(`  ${res.action === 'unchanged' ? '✓' : '+'} ${name} → ${id} (${source})${res.action === 'unchanged' ? tr` — déjà à jour.` : ''}`)
    if (res.action !== 'unchanged') changes.push(name)
  }
  const kmFile = config.zedKeymap
  const kmBefore = await readKeymap(kmFile)
  const km = keymapFor(text, kmBefore.text)
  const kmChanged = km.action === 'added' || km.action === 'replaced' || km.action === 'removed'
  for (const [name, key] of km.keys ?? []) console.log(tr`  ${kmChanged ? '+' : '✓'} ${key} → nouveau thread ${name}`)

  if (!changes.length && !kmChanged) {
    console.log(tr`✓ rien à faire`)
    return
  }

  if (changes.length) {
    console.log(tr`\n${changes.map((n) => `agent_servers.${n}`).join(', ')} dans ${file} :\n`)
    console.log(lineDiff(before.text, text))
  }
  if (kmChanged) {
    console.log(kmBefore.text === null ? tr`\nRaccourcis « nouveau thread » dans ${kmFile} (créé) :\n` : tr`\nRaccourcis « nouveau thread » dans ${kmFile} :\n`)
    console.log(lineDiff(kmBefore.text ?? '', km.text))
  }
  if (!opts.apply) {
    console.log(tr`\nSimulation : rien n’a été écrit. Relancer avec --apply (ou « apply » tout court) pour appliquer.`)
    return
  }
  if ((renamed.length || dropped.length) && !opts.yes) {
    console.log(tr`
⚠ Ces entrées changent d'id ou disparaissent : les threads déjà créés avec leur ancien nom ne se rouvriront plus dans Zed.`)
    for (const [from, to] of renamed) console.log(`  ${from} → ${to}`)
    for (const [from, to] of dropped) console.log(tr`  ${from} → supprimée (l'entrée d'origine « ${to} » passe par le shim).`)
    if (!process.stdin.isTTY) throw new Error(tr`Confirmation impossible hors terminal : relancer avec « yes » (npm run setup install apply yes).`)
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const answer = (await rl.question(tr`Continuer ? [o/N] `)).trim().toLowerCase()
    rl.close()
    if (!/^(o|oui|y|yes)$/.test(answer)) {
      console.log(tr`Annulé : rien n’a été écrit.`)
      return
    }
  }
  if (changes.length) {
    const backup = await writeZedFile(file, before, text)
    console.log(tr`\n✓ settings.json écrit. Sauvegarde : ${backup}`)
    console.log(tr`  Zed recharge settings.json à chaud : les nouveaux threads, et les anciens rouverts, passent par le shim.`)
    console.log(tr`  Retrait propre : npm run setup -- uninstall --apply. Supprimer le dossier ZRA sans uninstall ne casse pas l'agent (preload fail-open).`)
  }
  if (kmChanged) {
    const backup = await writeZedFile(kmFile, kmBefore, km.text)
    console.log(backup ? tr`\n✓ keymap.json écrit. Sauvegarde : ${backup}` : tr`\n✓ keymap.json écrit.`)
  }

  // Wayland : le forçage XWayland est une étape séparée et explicite — il
  // change le rendu de Zed pour tout le poste et peut échouer sur un .desktop
  // système. L'installation ne le fait plus d'office (audit B4).
  if (isWayland()) {
    console.log(tr`\nWayland détecté : le pilotage clavier exige Zed sous XWayland.`)
    console.log(tr`  Étape séparée : npm run setup -- xwayland --apply (modifie le .desktop de Zed, sauvegardé).`)
  }
}

/** Forçage XWayland du .desktop de Zed — étape explicite, simulation par défaut. */
async function xwayland(opts) {
  const desktop = await patchDesktopForXWayland(opts.apply)
  if (desktop.action === 'patched') {
    console.log(tr`✓ .desktop de Zed modifié pour forcer XWayland. Sauvegarde : ${desktop.backup}`)
    console.log(tr`  Redémarrer Zed pour que le changement prenne effet.`)
  } else if (desktop.action === 'dry-run') {
    console.log(tr`.desktop de Zed : forcer XWayland (simulation) :\n`)
    console.log(lineDiff(desktop.original, desktop.patched))
    console.log(tr`\nSimulation : rien n’a été écrit. Relancer avec --apply pour appliquer.`)
  } else if (desktop.action === 'unchanged') {
    console.log(tr`✓ ${desktop.file} déjà patché : rien à faire.`)
  } else {
    console.log(`— ${desktop.reason}`)
  }
}

async function uninstall(opts, config) {
  const file = config.zedSettings
  const before = await readSettings(file)
  const servers = before.parsed?.agent_servers ?? {}
  const names = opts.name && servers[opts.name] ? [opts.name] : Object.keys(servers).filter((k) => isShimEntry(servers[k]))
  let text = before.text
  const removedEntries = []
  for (const name of names) {
    const entry = servers[name]
    if (!isShimEntry(entry)) throw new Error(tr`« ${name} » n'est pas une entrée ZRA : on n'y touche pas.`)
    if (isPreloadEntry(entry)) {
      // L'entrée registry est à Zed/l'utilisateur : on ne retire que l'env ZRA.
      // Un NODE_OPTIONS de l'utilisateur, s'il y en a un, reste.
      const rest = stripPreload(entry.env?.NODE_OPTIONS)
      if (entry.env?.NODE_OPTIONS !== undefined) {
        text = rest
          ? upsertAgentServerEnv(text, name, { NODE_OPTIONS: rest }).text
          : removeAgentServerEnv(text, name, ['NODE_OPTIONS']).text
      }
      const zraKeys = Object.keys(entry.env ?? {}).filter((k) => k.startsWith('ZRA_'))
      text = removeAgentServerEnv(text, name, zraKeys).text
      // Entrée réduite à `type: registry` : rien d'autre n'y était, on la
      // retire — le fichier revient à son état d'avant l'installation.
      const after = parseJsonc(text)?.agent_servers?.[name]
      if (after && Object.keys(after).length === 1 && after.type === 'registry') {
        text = removeAgentServer(text, name).text
        removedEntries.push(name)
      }
      continue
    }
    text = removeAgentServer(text, name).text
    removedEntries.push(name)
  }
  // Les touches suivent les entrées qui restent ; plus aucune, plus de bloc.
  const kmFile = config.zedKeymap
  const kmBefore = await readKeymap(kmFile)
  const km = keymapFor(text, kmBefore.text)
  const kmChanged = km.action === 'removed' || km.action === 'replaced'

  if (!names.length && !kmChanged) {
    console.log(tr`✓ aucune entrée ZRA dans settings.json ni dans keymap.json : rien à retirer.`)
    return
  }
  if (names.length) {
    console.log(tr`\nRetrait de ZRA dans ${file} :\n`)
    console.log(lineDiff(before.text, text))
  }
  if (kmChanged) {
    console.log(tr`\nRaccourcis ZRA dans ${kmFile} :\n`)
    console.log(lineDiff(kmBefore.text, km.text))
  }
  if (!opts.apply) {
    console.log(tr`\nSimulation : rien n’a été écrit. Relancer avec --apply (ou « apply » tout court) pour appliquer.`)
    return
  }
  if (names.length) {
    const backup = await writeZedFile(file, before, text)
    console.log(tr`\n✓ retiré. Sauvegarde : ${backup}`)
    if (removedEntries.length) console.log(tr`  Les threads ouverts avec une entrée retirée restent dans le sidebar de Zed, sans agent pour les rouvrir.`)
  }
  if (kmChanged) {
    const backup = await writeZedFile(kmFile, kmBefore, km.text)
    console.log(tr`\n✓ raccourcis retirés du keymap.json. Sauvegarde : ${backup}`)
  }

  // Wayland : retirer le forçage XWayland du .desktop
  const desktop = await unpatchDesktop(opts.apply)
  if (desktop.action === 'restored') {
    console.log(tr`\n✓ .desktop de Zed restauré (XWayland retiré). Sauvegarde : ${desktop.backup}`)
    console.log(tr`  Redémarrer Zed pour que le changement prenne effet.`)
  } else if (desktop.action === 'unwritable') {
    console.log(`\n⚠ ${desktop.reason}`)
  } else if (desktop.action === 'dry-run') {
    console.log(tr`\n.desktop de Zed : retirer le forçage XWayland (simulation) :\n`)
    console.log(lineDiff(desktop.original, desktop.restored))
    console.log(tr`\nSimulation : le .desktop n'a pas été restauré. Relancer avec --apply pour appliquer.`)
  }
}

/** TLS du daemon (mode poste) : écrit `tls` dans zra.config.json en préservant
 *  les commentaires (JSONC). --cert + --key → HTTPS ; sans → retrait (HTTP).
 *  Le daemon relit sa config au démarrage ; pas d'env TLS côté daemon. */
async function tls(opts) {
  if ((opts.cert || opts.key) && !(opts.cert && opts.key)) {
    throw new Error(tr`--cert et --key sont requis ensemble.`)
  }
  const file = process.env.ZRA_CONFIG || join(ROOT, 'zra.config.json')
  const before = existsSync(file) ? await readFile(file, 'utf8') : '{}'
  const result = opts.cert
    ? upsertRootMember(before, 'tls', { cert: opts.cert, key: opts.key })
    : removeRootMember(before, 'tls')
  if (result.action === 'unchanged' || result.action === 'absent') {
    console.log(tr`✓ TLS : rien à faire.`)
    return
  }
  assertParsable(result.text)
  console.log(tr`TLS dans ${file} :\n`)
  console.log(lineDiff(before, result.text))
  if (!opts.apply) {
    console.log(tr`\nSimulation : rien n’a été écrit. Relancer avec --apply pour appliquer.`)
    return
  }
  if (existsSync(file)) await copyFile(file, `${file}.bak`)
  await writeFile(file, result.text)
  console.log(tr`\n✓ TLS enregistré. Le daemon le relit au démarrage.`)
}

/** État JSON pour la page d'onboarding du tray : Zed, agents, autostart,
 *  Wayland. Aucune écriture, aucun texte humain — que du JSON sur stdout. */
async function discover(opts, config) {
  const file = config.zedSettings
  const { parsed } = await readSettings(file)
  const servers = parsed?.agent_servers ?? {}
  const shimmed = new Set(Object.entries(servers)
    .filter(([, v]) => isShimEntry(v))
    .map(([k, v]) => (isPreloadEntry(v) ? k : wrappedAgentId(v))))
  const agents = (await discoverAgents({ settingsFile: file, overrides: config.agentCommands }))
    .map((a) => ({ ...a, shimmed: shimmed.has(a.id) }))
  const channel = detectZedChannel()
  const out = {
    platform: process.platform,
    zed: {
      settings: file,
      settingsExists: existsSync(file),
      channel,
      cli: defaultZedCli({ channel }),
      running: await isZedRunning(),
    },
    agents,
    wayland: isWayland(),
    autostart: serviceState(),
  }
  console.log(JSON.stringify(out, null, 2))
}

// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.command === 'help') return console.log(USAGE)
  if (opts.command === 'xwayland') return xwayland(opts)
  const config = await loadConfig()
  if (opts.command === 'discover') return discover(opts, config)
  if (opts.command === 'tls') return tls(opts)
  if (opts.command === 'status') return status(opts, config)
  if (opts.command === 'install') {
    await install(opts, config)
    // Binaire tray optionnel : la question n'est posée qu'après une
    // installation appliquée (oui/non/jamais, « jamais » mémorisé).
    if (opts.apply) await offerTrayDownload(ROOT)
    return
  }
  if (opts.command === 'uninstall') return uninstall(opts, config)
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  main().catch((err) => {
    console.error(`✗ ${err.message}`)
    process.exit(1)
  })
}
