// Icônes d'agents du registre ACP, telles que Zed les a téléchargées.
//
// Zed ne livre pas d'icône Pi, Qwen, Goose… dans ses assets : il les récupère
// du registre ACP (cdn.agentclientprotocol.com, `agentclientprotocol/registry`)
// et les cache dans `external_agents/registry/icons/<id>.svg`
// (`crates/project/src/agent_registry_store.rs`). Le daemon relit ce cache et
// le transmet à la PWA (message `machine`, champ `agentIcons`) : même icône que
// Zed, sans jeu figé côté client. Les SVG sont déjà en `currentColor`.

import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { PATHS } from './platform.js'

/**
 * SVG bruts des agents demandés, lus dans le cache de Zed. Un id sans icône
 * (agent custom, registre pas encore téléchargé par Zed) est simplement absent.
 * Silencieux : pas de cache est un état normal, pas une erreur.
 * @param {string[]} ids identifiants d'agents (`pi-acp`, `qwen-code`…)
 * @param {string} [registryDir] racine du registre de Zed (tests : dossier factice)
 * @returns {Promise<Record<string, string>>} id → SVG brut
 */
export async function readAgentIcons(ids, registryDir = PATHS.registryDir) {
  const out = {}
  for (const id of ids) {
    // L'id vient des réglages de Zed : jamais de traversée de chemin.
    if (typeof id !== 'string' || !id || id !== basename(id) || !/^[A-Za-z0-9._-]+$/.test(id)) continue
    try {
      out[id] = await readFile(join(registryDir, 'icons', `${id}.svg`), 'utf8')
    } catch { /* pas d'icône pour cet agent : le client retombera sur ses glyphes */ }
  }
  return out
}

/**
 * Icônes d'un poste : agents configurés + agents des threads (un thread peut
 * garder un agent retiré des réglages). Une entrée ZRA (« pi ACP (zra) »)
 * hérite de l'icône de l'agent qu'elle enveloppe (`wraps`) : ses threads
 * portent l'id de l'entrée, pas celui du registre.
 * @param {Array<{id:string, wraps?:string}>} agents registry `agent_servers` (`agents.js`)
 * @param {Array<string|null>} [threadAgentIds] ids d'agents des threads de Zed
 * @param {string} [registryDir]
 * @returns {Promise<Record<string, string>>} id → SVG brut
 */
export async function readAgentIconsFor(agents, threadAgentIds = [], registryDir = PATHS.registryDir) {
  const ids = new Set(threadAgentIds.filter(Boolean))
  for (const a of agents) {
    ids.add(a.id)
    if (a.wraps) ids.add(a.wraps)
  }
  const icons = await readAgentIcons([...ids], registryDir)
  for (const a of agents) {
    if (a.wraps && !icons[a.id] && icons[a.wraps]) icons[a.id] = icons[a.wraps]
  }
  return icons
}