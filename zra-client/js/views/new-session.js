// Bouton « + » : ouvrir une nouvelle session d'agent, comme dans Zed.
// Un clic déplie la liste des agents du registry du poste (claude, gemini, …).

import { button } from '../dom.js'
import { icon } from '../icons.js'
import { agentLabel } from '../format.js'
import * as store from '../store.js'
import { openMenu, toast } from '../ui.js'

const FALLBACK_AGENTS = [{ id: 'claude-acp', name: 'Claude' }]

/**
 * @param {{navigate:Function, machineId?:string}} opts machineId : poste
 *        privilégié (celui du thread courant) — sinon tous les postes en ligne.
 */
export function newSessionButton({ machineId } = {}) {
  const btn = button('icon-btn', {
    title: 'Nouvelle session',
    'aria-label': 'nouvelle session',
    onclick: (ev) => openAgentMenu(ev.currentTarget, machineId),
  }, icon('plus', 'icon--sm'))

  const sync = () => {
    btn.disabled = ![...store.state.machines.values()].some((m) => m.status === 'online')
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

export function openAgentMenu(anchor, preferredMachineId) {
  const machines = [...store.state.machines.values()].filter((m) => m.status === 'online')
  if (!machines.length) return toast('aucun poste en ligne', { level: 'warn' })

  // Le poste du thread courant passe en premier.
  machines.sort((a, b) => (a.id === preferredMachineId ? -1 : b.id === preferredMachineId ? 1 : 0))
  const several = machines.length > 1

  const items = []
  for (const m of machines) {
    if (several) items.push({ separator: items.length > 0 }, { label: m.info?.name || m.label, header: true })
    for (const agent of agentsOf(m)) {
      items.push({
        label: agent.name,
        agentId: agent.id,
        onSelect: () => {
          store.newThread(m.id, agent.id)
          toast(`nouvelle session ${agent.name}…`)
        },
      })
    }
  }
  return openMenu(anchor, { label: several ? null : 'Nouvelle session', items: items.filter(Boolean) })
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
