// Comment lancer un agent ACP.
//
// Deux besoins, une seule résolution :
//  · le **shim** doit savoir quel binaire il enveloppe ;
//  · le **daemon** doit relancer le même agent pour relire un thread fermé.
//
// La spec supposait des entrées `agent_servers` de type `custom`, avec la
// commande écrite à la main. La machine cible n'en a aucune : ses deux agents
// sont de type `registry`, installés par Zed lui-même sous son dossier
// `external_agents/registry` (`%LOCALAPPDATA%\Zed\…` en Windows,
// `$XDG_DATA_HOME/zed/…` sous Linux — voir `platform.js`). On résout donc les
// trois cas, dans cet ordre de priorité :
//
//   1. `agentCommands` de `zra.config.json` — le dernier mot revient à la config ;
//   2. `agent_servers.<id>` de type `custom` — la commande est écrite dedans ;
//   3. le registry de Zed — `registry.json` + le dossier d'installation.
//
// Rien n'est jamais téléchargé ni installé : on ne fait que *retrouver* ce que
// Zed a déjà posé sur le disque.

import { existsSync, readdirSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { parseJsonc } from './jsonc.js'
import { PATHS } from './platform.js'
import { tr } from './i18n.js'

/**
 * Emplacement des agents installés par Zed depuis son registry.
 *
 * Fait établi sous Linux (Ubuntu 24.04.3, Zed 1.23.2) : même arborescence
 * qu'en Windows, et le paquet installé par Zed pour `pi-acp` se lit exactement
 * comme le prévoit `resolveAgentCommand` :
 *   $ find ~/.local/share/zed/external_agents/registry/npx -maxdepth 4
 *     …/npx/pi-acp/package.json, …/npx/pi-acp/node_modules/pi-acp/package.json
 *   $ … package.json de pi-acp → {"bin":{"pi-acp":"dist/index.js"},"type":"module"}
 */
export const REGISTRY_DIR = PATHS.registryDir

export class AgentCommandError extends Error {}

/** Zed n'installe un agent du registry qu'à sa première utilisation. */
const NOT_INSTALLED_HINT = tr`ouvrir une fois un thread avec cet agent dans Zed, qui l’installe à ce moment-là`

/**
 * Le drapeau `NODE_OPTIONS` qui précharge le launcher du shim avant le code de
 * l'agent. Le payload est percent-encodé dans la variable elle-même : aucun
 * espace ni guillemet brut (le tokenizer de `NODE_OPTIONS` casse dessus), et
 * aucune dépendance fichier au parse — ZRA supprimé, l'import dynamique échoue,
 * le `catch` avale, l'agent démarre sans ZRA (fail-open).
 */
export function preloadFlag(root) {
  const launcher = pathToFileURL(join(root, 'zra-shim', 'launcher.mjs')).href
  const payload = `try{await import(${JSON.stringify(launcher)})}catch{}`
  return `--import data:text/javascript,${encodeURIComponent(payload)}`
}

/** Notre drapeau dans une valeur de `NODE_OPTIONS` (chemin percent-encodé ou brut). */
const PRELOAD_TOKEN = /zra-shim(?:%2[fF]|[/\\])launcher\.mjs/

/**
 * Entrée `registry` shimée par l'env (`setup install` d'un agent npx) : Zed
 * installe et met à jour l'agent normalement, le preload node lance le shim.
 */
export function isPreloadEntry(entry) {
  return entry?.type === 'registry' && PRELOAD_TOKEN.test(String(entry?.env?.NODE_OPTIONS ?? ''))
}

/** Notre drapeau est bien dans cette valeur de `NODE_OPTIONS`, avec le chemin de ce dépôt. */
export function hasPreload(nodeOptions, root) {
  const url = preloadFlag(root).slice('--import '.length)
  return String(nodeOptions ?? '').split(/\s+/).includes(url)
}

/** Valeur de `NODE_OPTIONS` débarrassée de notre drapeau ; le reste (l'utilisateur) reste. */
export function stripPreload(nodeOptions) {
  const out = []
  for (const t of String(nodeOptions ?? '').split(/\s+/).filter(Boolean)) {
    if (PRELOAD_TOKEN.test(t)) {
      // Notre drapeau : `--import data:…` (deux jetons) ou `--import=data:…` (un).
      if (out.at(-1) === '--import') out.pop()
      continue
    }
    out.push(t)
  }
  return out.join(' ')
}

/**
 * L'env d'une entrée sans ce que ZRA y a posé : le daemon (relecture d'un
 * thread) et le shim lancent l'agent **sans** re-preload — sinon la relecture
 * se connecterait au daemon comme un shim live, et le preload cascaderait.
 */
export function withoutZraEnv(env) {
  if (!env || typeof env !== 'object') return {}
  const out = {}
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith('ZRA_')) continue
    if (k === 'NODE_OPTIONS') {
      const rest = stripPreload(v)
      if (rest) out.NODE_OPTIONS = rest
      continue
    }
    out[k] = v
  }
  return out
}

/**
 * Une entrée `agent_servers` qui lance `zra-shim` plutôt que l'agent lui-même
 * (c'est ce que pose `scripts/setup.mjs`). Reconnue à son script ou à son
 * preload, pas à son nom : l'utilisateur peut l'appeler comme il veut.
 */
export function isShimEntry(entry) {
  if (isPreloadEntry(entry)) return true
  const args = Array.isArray(entry?.args) ? entry.args : []
  return args.some((a) => /(^|[\\/])zra-shim[\\/]index\.js$/i.test(String(a)))
}

/** L'agent qu'enveloppe une entrée shim, tel que Zed le nomme (`ZRA_AGENT_ID`). */
export function wrappedAgentId(entry) {
  return isShimEntry(entry) ? (entry?.env?.ZRA_AGENT_ID ?? null) : null
}

async function readJsonc(file) {
  try {
    return parseJsonc(await readFile(file, 'utf8'))
  } catch {
    return null
  }
}

/** `@agentclientprotocol/claude-agent-acp@0.80.0` -> nom sans version. */
export function packageName(spec) {
  const s = String(spec)
  const at = s.lastIndexOf('@')
  return at > 0 ? s.slice(0, at) : s
}

/**
 * Le binaire d'un paquet npm, choisi comme Zed (`read_package_executable`) :
 * `bin` en chaîne, l'unique entrée de l'objet, sinon celle qui porte le nom du
 * paquet (sans portée).
 */
export function binPath(dir, pkg, name) {
  const bin = pkg?.bin
  let rel = null
  if (typeof bin === 'string') rel = bin
  else if (bin && typeof bin === 'object') {
    const entries = Object.values(bin)
    rel = entries.length === 1 ? entries[0] : bin[String(name).split('/').pop()]
  }
  return rel ? join(dir, String(rel)) : null
}

/** Dossier de version le plus récent contenant `file` (agents distribués en binaire). */
function newestVersionDir(root, file) {
  if (!existsSync(root)) return null
  const candidates = readdirSync(root)
    .map((name) => ({ name, path: join(root, name) }))
    .filter((d) => { try { return statSync(d.path).isDirectory() && existsSync(join(d.path, file)) } catch { return false } })
    .sort((a, b) => statSync(b.path).mtimeMs - statSync(a.path).mtimeMs)
  return candidates[0]?.path ?? null
}

/** `./vibe-acp.exe` -> `vibe-acp.exe` ; la commande du registry est relative. */
function bare(cmd) {
  return String(cmd).replace(/^\.[\\/]/, '')
}

/**
 * Clé de plateforme du registry de Zed.
 *
 * Fait établi : les clés réelles de `registry.json` sur cette machine sont
 * `linux-x86_64`, `linux-aarch64`, `windows-x86_64`, `darwin-aarch64`…
 *   $ … registry.json → distribution.binary.{linux-x86_64: {cmd: "./amp-acp"}}
 * `linux` + `x86_64` : cette fonction produisait déjà la bonne clé, elle n'a
 * pas été modifiée. À noter : `cmd` n'a pas de `.exe` sous Linux, et il est
 * relatif (`./amp-acp`) — `bare()` enlève déjà les deux séparateurs.
 */
function platformKey() {
  const os = process.platform === 'win32' ? 'windows' : process.platform
  const arch = process.arch === 'x64' ? 'x86_64' : process.arch === 'arm64' ? 'aarch64' : process.arch
  return `${os}-${arch}`
}

/**
 * Résout la commande d'un agent.
 *
 * @param {string} agentId
 * @param {{ settingsFile?:string|null, overrides?:object, registryDir?:string }} opts
 * @returns {Promise<{ command:string, args:string[], env:object, source:string }>}
 */
export async function resolveAgentCommand(agentId, { settingsFile = null, overrides = {}, registryDir = REGISTRY_DIR, depth = 0 } = {}) {
  if (!agentId) throw new AgentCommandError(tr`aucun agent demandé`)

  const override = overrides?.[agentId]
  if (override?.command) {
    return { command: override.command, args: override.args ?? [], env: override.env ?? {}, source: 'config' }
  }

  const settings = settingsFile ? await readJsonc(settingsFile) : null
  const entry = settings?.agent_servers?.[agentId]
  // Entrée ZRA custom : c'est l'agent enveloppé qu'on veut lancer, pas un shim
  // de plus. Un shim lancé par le daemon se connecterait à lui et ferait passer
  // `live` une session qu'il ne fait que relire. Une entrée registry shimée par
  // preload, elle, se résout normalement ci-dessous — son env ZRA est filtré.
  if (isShimEntry(entry) && !isPreloadEntry(entry)) {
    const inner = wrappedAgentId(entry)
    if (!inner || inner === agentId || depth > 2) {
      throw new AgentCommandError(tr`agent « ${agentId} » : entrée ZRA sans agent enveloppé valide (env.ZRA_AGENT_ID)`)
    }
    const resolved = await resolveAgentCommand(inner, { settingsFile, overrides, registryDir, depth: depth + 1 })
    return { ...resolved, source: `zra→${resolved.source}`, wraps: inner }
  }
  if (entry?.command) {
    return { command: entry.command, args: entry.args ?? [], env: entry.env ?? {}, source: 'settings' }
  }
  // Entrée `registry` : son `env` s'ajoute à celui du registry, et l'emporte
  // (`LocalRegistryNpxAgent::get_command`) — sans le preload ZRA ni ses
  // variables : on lance l'agent, pas un shim de plus.
  const settingsEnv = withoutZraEnv(entry?.env)

  const registry = await readJsonc(join(registryDir, 'registry.json'))
  const agent = Array.isArray(registry?.agents) ? registry.agents.find((a) => a?.id === agentId) : null
  if (!agent) {
    throw new AgentCommandError(tr`agent « ${agentId} » introuvable : ni dans zra.config.json (agentCommands), ni en \`custom\` dans le settings.json de Zed, ni dans son registry`)
  }

  const npx = agent.distribution?.npx
  if (npx?.package) {
    const name = packageName(npx.package)
    const dir = join(registryDir, 'npx', agentId, 'node_modules', ...name.split('/'))
    const pkg = await readJsonc(join(dir, 'package.json'))
    const bin = pkg ? binPath(dir, pkg, name) : null
    if (!bin || !existsSync(bin)) {
      throw new AgentCommandError(tr`agent « ${agentId} » (${name}) pas encore installé par Zed (${dir}) — ${NOT_INSTALLED_HINT}`)
    }
    // Les `args`/`env` du registry font partie de la commande : sans le
    // `--acp` de qwen-code, l'agent démarre en mode interactif.
    const args = Array.isArray(npx.args) ? npx.args.map(String) : []
    const env = { ...(npx.env && typeof npx.env === 'object' ? npx.env : {}), ...settingsEnv }
    // Un paquet peut livrer un exécutable natif : on le lance tel quel.
    if (/\.(exe|cmd|bat)$/i.test(bin)) return { command: bin, args, env, source: 'registry/npx' }
    // Node lance Node : on réutilise l'exécutable courant plutôt que de dépendre
    // d'un `npx` dans le PATH, qui rejouerait une résolution et un téléchargement.
    // `viaNode` : l'agent tourne sous node, donc éligible au preload du shim.
    return { command: process.execPath, args: [bin, ...args], env, source: 'registry/npx', viaNode: true }
  }

  const binary = agent.distribution?.binary?.[platformKey()]
  if (binary?.cmd) {
    const file = bare(binary.cmd)
    const dir = newestVersionDir(join(registryDir, agentId), file)
    if (!dir) throw new AgentCommandError(tr`agent « ${agentId} » pas encore installé par Zed (${join(registryDir, agentId)}) — ${NOT_INSTALLED_HINT}`)
    const args = Array.isArray(binary.args) ? binary.args.map(String) : []
    const env = { ...(binary.env && typeof binary.env === 'object' ? binary.env : {}), ...settingsEnv }
    return { command: join(dir, file), args, env, source: 'registry/binary' }
  }

  const modes = Object.keys(agent.distribution ?? {}).join(', ') || tr`aucun`
  throw new AgentCommandError(tr`agent « ${agentId} » : mode de distribution non pris en charge (${modes}) — déclarer sa commande dans \`agentCommands\` de zra.config.json`)
}

/** Nom d’affichage d’un agent dans le registry de Zed (`Claude Agent`), ou `null`. */
export async function registryAgentName(agentId, { registryDir = REGISTRY_DIR } = {}) {
  const registry = await readJsonc(join(registryDir, 'registry.json'))
  const agent = (Array.isArray(registry?.agents) ? registry.agents : []).find((a) => a?.id === agentId)
  return typeof agent?.name === 'string' && agent.name ? agent.name : null
}

/**
 * Les agents ACP de ce poste, pour l'installation sans argument : ceux que
 * déclare le `settings.json` de Zed (hors entrées ZRA), ceux de `agentCommands`,
 * et ceux que Zed a déjà téléchargés depuis son registry. Chacun est résolu :
 * `ok: false` porte la raison (typiquement : déclaré mais jamais lancé dans
 * Zed, donc pas encore installé).
 *
 * @returns {Promise<Array<{ id:string, ok:boolean, source?:string, reason?:string }>>}
 */
export async function discoverAgents({ settingsFile = null, overrides = {}, registryDir = REGISTRY_DIR } = {}) {
  const ids = new Set()
  const settings = settingsFile ? await readJsonc(settingsFile) : null
  for (const [id, entry] of Object.entries(settings?.agent_servers ?? {})) {
    // Une entrée registry shimée par preload reste l'agent d'origine : on la
    // découvre. Une entrée custom ZRA, non : c'est l'enveloppe, pas l'agent.
    if (!isShimEntry(entry) || isPreloadEntry(entry)) ids.add(id)
  }
  for (const id of Object.keys(overrides ?? {})) ids.add(id)

  const registry = await readJsonc(join(registryDir, 'registry.json'))
  for (const agent of Array.isArray(registry?.agents) ? registry.agents : []) {
    const id = agent?.id
    if (!id) continue
    if (existsSync(join(registryDir, 'npx', id)) || existsSync(join(registryDir, id))) ids.add(id)
  }

  const out = []
  for (const id of ids) {
    try {
      const cmd = await resolveAgentCommand(id, { settingsFile, overrides, registryDir })
      out.push({ id, ok: true, source: cmd.source, viaNode: cmd.viaNode })
    } catch (err) {
      out.push({ id, ok: false, reason: err.message })
    }
  }
  return out
}
