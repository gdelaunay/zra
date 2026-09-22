// Comment lancer un agent ACP — spec §2.2 et §5.2.
//
// Deux besoins, une seule résolution :
//  · le **shim** doit savoir quel binaire il enveloppe ;
//  · le **daemon** doit relancer le même agent pour relire un thread fermé.
//
// La spec supposait des entrées `agent_servers` de type `custom`, avec la
// commande écrite à la main. La machine cible n'en a aucune : ses deux agents
// sont de type `registry`, installés par Zed lui-même sous
// `%LOCALAPPDATA%\Zed\external_agents\registry`. On résout donc les trois cas,
// dans cet ordre de priorité :
//
//   1. `agentCommands` de `zra.config.json` — le dernier mot revient à la config ;
//   2. `agent_servers.<id>` de type `custom` — la commande est écrite dedans ;
//   3. le registry de Zed — `registry.json` + le dossier d'installation.
//
// Rien n'est jamais téléchargé ni installé : on ne fait que *retrouver* ce que
// Zed a déjà posé sur le disque.

import { existsSync, readdirSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { parseJsonc } from './jsonc.js'

const LOCALAPPDATA = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')

/** Emplacement des agents installés par Zed depuis son registry. */
export const REGISTRY_DIR = join(LOCALAPPDATA, 'Zed', 'external_agents', 'registry')

export class AgentCommandError extends Error {}

/**
 * Une entrée `agent_servers` qui lance `zra-shim` plutôt que l'agent lui-même
 * (c'est ce que pose `scripts/setup.mjs`). Reconnue à son script, pas à son nom :
 * l'utilisateur peut l'appeler comme il veut.
 */
export function isShimEntry(entry) {
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

/** Le binaire d'un paquet npm : `bin` en chaîne, ou première entrée de l'objet. */
function binPath(dir, pkg) {
  const bin = pkg?.bin
  const rel = typeof bin === 'string' ? bin : bin && typeof bin === 'object' ? Object.values(bin)[0] : pkg?.main
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
  if (!agentId) throw new AgentCommandError('aucun agent demandé')

  const override = overrides?.[agentId]
  if (override?.command) {
    return { command: override.command, args: override.args ?? [], env: override.env ?? {}, source: 'config' }
  }

  const settings = settingsFile ? await readJsonc(settingsFile) : null
  const entry = settings?.agent_servers?.[agentId]
  // Entrée ZRA : c'est l'agent enveloppé qu'on veut lancer, pas un shim de plus.
  // Un shim lancé par le daemon se connecterait à lui et ferait passer `live`
  // une session qu'il ne fait que relire.
  if (isShimEntry(entry)) {
    const inner = wrappedAgentId(entry)
    if (!inner || inner === agentId || depth > 2) {
      throw new AgentCommandError(`agent « ${agentId} » : entrée ZRA sans agent enveloppé valide (env.ZRA_AGENT_ID)`)
    }
    const resolved = await resolveAgentCommand(inner, { settingsFile, overrides, registryDir, depth: depth + 1 })
    return { ...resolved, source: `zra→${resolved.source}`, wraps: inner }
  }
  if (entry?.command) {
    return { command: entry.command, args: entry.args ?? [], env: entry.env ?? {}, source: 'settings' }
  }

  const registry = await readJsonc(join(registryDir, 'registry.json'))
  const agent = Array.isArray(registry?.agents) ? registry.agents.find((a) => a?.id === agentId) : null
  if (!agent) {
    throw new AgentCommandError(
      `agent « ${agentId} » introuvable : ni dans zra.config.json (agentCommands), ` +
      'ni en `custom` dans le settings.json de Zed, ni dans son registry',
    )
  }

  const npx = agent.distribution?.npx
  if (npx?.package) {
    const name = packageName(npx.package)
    const dir = join(registryDir, 'npx', agentId, 'node_modules', ...name.split('/'))
    const pkg = await readJsonc(join(dir, 'package.json'))
    const bin = pkg ? binPath(dir, pkg) : null
    if (!bin || !existsSync(bin)) {
      throw new AgentCommandError(`agent « ${agentId} » (${name}) pas encore installé par Zed : ${dir}`)
    }
    // Node lance Node : on réutilise l'exécutable courant plutôt que de dépendre
    // d'un `npx` dans le PATH, qui rejouerait une résolution et un téléchargement.
    return { command: process.execPath, args: [bin], env: {}, source: 'registry/npx' }
  }

  const binary = agent.distribution?.binary?.[platformKey()]
  if (binary?.cmd) {
    const file = bare(binary.cmd)
    const dir = newestVersionDir(join(registryDir, agentId), file)
    if (!dir) throw new AgentCommandError(`agent « ${agentId} » pas encore installé par Zed : ${join(registryDir, agentId)}`)
    return { command: join(dir, file), args: [], env: {}, source: 'registry/binary' }
  }

  throw new AgentCommandError(
    `agent « ${agentId} » : mode de distribution non pris en charge ` +
    `(${Object.keys(agent.distribution ?? {}).join(', ') || 'aucun'}) — ` +
    'déclarer sa commande dans `agentCommands` de zra.config.json',
  )
}
