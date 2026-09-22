// Barre de déclencheurs du mode mock. N'existe que quand le daemon est simulé :
// elle permet de provoquer à la main les cas que la spec demande de tester (§10).

import { h, button } from '../dom.js'
import { icon } from '../icons.js'
import * as store from '../store.js'
import { openMenu, toast } from '../ui.js'

const TRIGGERS = [
  ['turn', 'Tour complet', 'sparkles'],
  ['short', 'Réponse courte', 'message'],
  ['long', 'Tour long (annulable)', 'clock'],
  ['permission', 'Demande de permission', 'shield'],
  ['unknown', 'Événement ACP inconnu', 'hash'],
  ['error', 'Erreur daemon', 'alert-triangle'],
  ['offline', 'Poste hors ligne 4 s', 'plug'],
  ['shim-lost', 'Zed ferme l’agent', 'x'],
  ['shim-back', 'Zed rouvre le thread', 'check'],
  ['new-thread', 'Nouveau thread dans Zed', 'plus'],
]

export function DevBar({ currentKey }) {
  const el = h('div.devbar')

  const target = () => {
    if (currentKey()) return store.splitKey(currentKey())
    const first = store.allThreads().find((t) => t.thread.state === 'live')
    return first ? store.splitKey(first.key) : null
  }

  const fire = (name) => {
    const t = target()
    if (!t) return toast('aucun thread live', { level: 'warn' })
    const machine = store.state.machines.get(t.machineId)
    machine?.link.send({ type: 'zra/trigger', name, threadId: t.threadId })
  }

  el.append(
    h('span.devbar__tag', { text: 'mock' }),
    ...TRIGGERS.slice(0, 4).map(([id, label, ic]) =>
      button('btn.btn--sm.btn--ghost', { onclick: () => fire(id), title: label }, icon(ic, 'icon--sm'), label)),
    button('btn.btn--sm.btn--ghost', {
      onclick: (ev) => openMenu(ev.currentTarget, {
        label: 'Simuler',
        items: TRIGGERS.slice(4).map(([id, label, ic]) => ({ label, icon: ic, onSelect: () => fire(id) })),
      }),
    }, icon('chevron-up-down', 'icon--sm'), 'Autres'),
  )

  // Visible en mock intégral, ou dès qu'un daemon se déclare bouchon
  // (`machine.version` suffixée `-mock`).
  const sync = () => {
    const mock = store.state.mock ||
      [...store.state.machines.values()].some((m) => /-mock$/.test(m.info?.version || ''))
    el.classList.toggle('hidden', !mock)
  }
  const off = store.on('machines', sync)
  sync()

  return { el, destroy: off }
}
