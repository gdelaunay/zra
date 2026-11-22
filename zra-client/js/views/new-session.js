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
import { tr } from '../i18n.js'

const FALLBACK_AGENTS = [{ id: 'claude-acp', name: 'Claude' }]

/**
 * @param {{
 *   machineId: string,
 *   project: () => ({ name:string, folderPaths:string[] } | null),
 *   title?: string,
 *   navigate: (hash:string) => void,
 * }} opts `project` est lu au clic : le thread courant peut n'être connu de
 *        l'index qu'après le montage du bouton.
 */
export function newSessionButton({ machineId, project, title = tr`Nouveau thread`, navigate }) {
  const btn = button('icon-btn icon-btn--sm', {
    title,
    'aria-label': tr`Nouvelle session`,
    onclick: (ev) => {
      ev.stopPropagation()
      openAgentMenu(ev.currentTarget, { machineId, project: project(), navigate })
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
 * @param {{ machineId:string, project:{ name:string, folderPaths:string[] } | null, navigate:(hash:string)=>void }} target
 */
export function openAgentMenu(anchor, { machineId, project, navigate }) {
  const m = store.state.machines.get(machineId)
  if (!m || m.status !== 'online') return toast(tr`Poste hors ligne`, { level: 'warn' })
  // Backend clavier `none` (Wayland natif non patché, xdotool absent…) :
  // la lecture et l'injection marchent, mais Zed ne peut pas être piloté —
  // le dire tout de suite plutôt que de laisser l'écran de création pulser 45 s.
  if (m.info?.keyboard === 'none') {
    return toast(tr`Ouverture de thread indisponible sur ce poste : aucun backend clavier (installer xdotool, ou lancer Zed via le .desktop patché XWayland). Lecture et réponses marchent toujours.`, { level: 'warn' })
  }

  const where = project?.folderPaths?.length ? project.name : null
  const items = agentsOf(m).map((agent) => ({
    label: agent.name,
    agentId: agent.id,
    onSelect: () => {
      // Navigation immédiate vers l'écran de création (label pulsé de Zed) :
      // le store envoie `new_thread` et suit la réponse — `thread_created` ouvre
      // le thread, `new_thread_failed` s'affiche en callout sur cet écran.
      store.newThread(m.id, agent.id, where ? project.folderPaths : undefined, where)
      navigate(`#/new/${m.id}`)
    },
  }))
  return openMenu(anchor, { label: where ? tr`Nouveau thread · ${where}` : tr`Nouveau thread`, items })
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
