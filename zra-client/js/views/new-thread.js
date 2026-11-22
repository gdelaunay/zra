// Écran de création d'un thread — le panneau de Zed pendant qu'il ouvre une
// session (`conversation_view.rs`, `Render for ConversationView`) :
//   ServerState::Loading  → label centré, muted, pulsé (alpha 0,3 ↔ 0,7, 2 s) ;
//   ServerState::LoadError → callout en bas du panneau (render_load_error) :
//                            « Échec du lancement », Réessayer, copier, fermer.
// La PWA y navigue dès le choix de l'agent (`#/new/<poste>`), sans toast
// d'attente : le store suit `new_thread` jusqu'à `thread_created` (la vue est
// alors remplacée par le thread) ou `new_thread_failed` (callout ici).

import { h, clear } from '../dom.js'
import { agentIcon } from '../icons.js'
import { agentLabel, baseName } from '../format.js'
import * as store from '../store.js'
import { renderCallout } from '../callout.js'
import { toast } from '../ui.js'
import { BottomBar } from './bottombar.js'
import { tr } from '../i18n.js'

export function NewThreadView({ machineId, navigate }) {
  const machine = store.state.machines.get(machineId)
  // Plus de création suivie (résolue, callout fermé, ou URL directe) : retour
  // à la liste — le back après l'ouverture du thread ne retombe pas sur un
  // écran vide.
  if (!machine || !store.pendingCreation(machineId)) {
    queueMicrotask(() => navigate('#/'))
    return { el: h('div.view'), destroy() {} }
  }

  const agentSlot = h('span.header__agent')
  const pathLabel = h('span.path.truncate')
  const label = h('div.creating__label')
  const calloutSlot = h('div.creating__callout')
  const bottombar = BottomBar({ navigate, active: 'thread' })

  const el = h('div.view',
    h('div.header', {},
      agentSlot,
      h('div.header__title', {}, h('span.truncate', { text: tr`Nouveau Thread d'Agent` })),
      h('div.header__meta', {}, pathLabel),
    ),
    h('div.creating', {}, label, calloutSlot),
    bottombar.el,
  )

  function paint() {
    const c = store.pendingCreation(machineId)
    if (!c) return
    const m = store.state.machines.get(machineId)
    // Header : agent et projet visés, connus dès la demande.
    clear(agentSlot)
    agentSlot.append(agentIcon(c.agentId, 'icon--sm'))
    agentSlot.title = agentLabel(c.agentId)
    const folder = c.folderPaths?.[0]
    pathLabel.textContent = folder ? `../${baseName(folder)}` : ''
    pathLabel.title = c.folderPaths?.join('\n') || ''

    const name = agentLabel(c.agentId)
    label.textContent = c.projectName
      ? tr`Zed ouvre une session ${name} dans ${c.projectName}…`
      : tr`Zed ouvre une session ${name}…`

    // Un seul état à la fois : échec (callout bas) > poste indisponible >
    // création en cours (label pulsé). Comme Zed, l'erreur remplace le label.
    let spec = null
    if (c.error) spec = errorSpec(c.error)
    else if (m.status === 'locked') spec = { severity: 'error', title: tr`Appairage requis`, desc: tr`${m.label} doit être appairé depuis la liste des threads.` }
    else if (m.status !== 'online') spec = { severity: 'error', title: tr`${m.label} hors ligne`, desc: m.error || tr`Reconnexion automatique.` }
    label.classList.toggle('hidden', Boolean(spec))
    clear(calloutSlot)
    if (spec) calloutSlot.append(renderCallout(spec))
  }

  /** render_load_error : « Échec du lancement », Réessayer (relance new_thread),
   * copier, fermer (retour à la liste). */
  function errorSpec(message) {
    return {
      severity: 'error', title: tr`Échec du lancement`, desc: message,
      actions: [{ label: tr`Réessayer`, onclick: () => store.retryCreation(machineId) }],
      copy: () => copy(message),
      close: () => { store.dismissCreation(machineId); navigate('#/') },
    }
  }

  const offs = [
    store.on(`creating:${machineId}`, paint),
    store.on('machines', paint),
  ]

  paint()

  return {
    el,
    destroy() {
      offs.forEach((off) => off())
      bottombar.destroy()
    },
  }
}

function copy(text) {
  navigator.clipboard?.writeText(text).then(
    () => toast(tr`Copié`),
    () => toast(tr`Copie impossible.`, { level: 'error' }),
  )
}