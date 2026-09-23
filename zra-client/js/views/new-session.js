// Bouton « + » : ouvrir une nouvelle session d'agent, comme dans Zed.
// Un clic déplie la liste des agents du registry du poste (claude, gemini, …).
//
// Une session s'ouvre **dans un projet** : le « + » vit sur la ligne de chaque
// projet de la liste, et dans la top bar d'un thread, où il vise le projet de
// ce thread. Il n'y a pas de « + » global.

import { button } from '../dom.js'
import { icon } from '../icons.js'
import { agentLabel } from '../format.js'
import * as store from '../store.js'
import { openMenu, toast } from '../ui.js'

const FALLBACK_AGENTS = [{ id: 'claude-acp', name: 'Claude' }]

/**
 * @param {{
 *   machineId: string,
 *   project: () => ({ name:string, folderPaths:string[] } | null),
 *   title?: string,
 * }} opts `project` est lu au clic : le thread courant peut n'être connu de
 *        l'index qu'après le montage du bouton.
 */
export function newSessionButton({ machineId, project, title = 'Nouveau thread' }) {
  const btn = button('icon-btn', {
    title,
    'aria-label': 'nouvelle session',
    onclick: (ev) => {
      ev.stopPropagation()
      openAgentMenu(ev.currentTarget, { machineId, project: project() })
    },
  }, icon('plus', 'icon--sm'))

  const sync = () => {
    btn.disabled = store.state.machines.get(machineId)?.status !== 'online'
  }

  // Le bouton vit et meurt avec sa vue : une fois monté puis détaché du DOM,
  // il se désabonne lui-même — un changement de vue ne laisse rien derrière.
  let mounted = false
  const off = store.on('machines', () => {
    if (btn.isConnected) mounted = true
    else if (mounted) return off()
    sync()
  })

  sync()
  return btn
}

/**
 * Menu des agents d'un poste ; le choix ouvre la session dans le projet.
 * @param {HTMLElement} anchor
 * @param {{ machineId:string, project:{ name:string, folderPaths:string[] } | null }} target
 */
export function openAgentMenu(anchor, { machineId, project }) {
  const m = store.state.machines.get(machineId)
  if (!m || m.status !== 'online') return toast('poste hors ligne', { level: 'warn' })

  const where = project?.folderPaths?.length ? project.name : null
  const items = agentsOf(m).map((agent) => ({
    label: agent.name,
    agentId: agent.id,
    onSelect: () => {
      store.newThread(m.id, agent.id, where ? project.folderPaths : undefined)
      toast(`nouvelle session ${agent.name}${where ? ` dans ${where}` : ''}…`)
    },
  }))
  return openMenu(anchor, { label: where ? `Nouveau thread · ${where}` : 'Nouveau thread', items })
}

/**
 * Agents disponibles sur un poste : le daemon les expose dans `machine.agents`
 * (registry `agent_servers` de Zed). À défaut, on déduit des threads connus.
 */
function agentsOf(machine) {
  const declared = machine.info?.agents
  if (Array.isArray(declared) && declared.length) {
    return declared.map((a) => (typeof a === 'string' ? { id: a, name: agentLabel(a) } : { id: a.id, name: a.name || agentLabel(a.id) }))
  }
  const seen = new Map()
  for (const t of machine.threads) {
    if (t.agentId && !seen.has(t.agentId)) seen.set(t.agentId, { id: t.agentId, name: agentLabel(t.agentId) })
  }
  return seen.size ? [...seen.values()] : FALLBACK_AGENTS
}
