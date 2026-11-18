// Barre de déclencheurs du mode mock. N'existe que quand le daemon est simulé :
// elle permet de provoquer à la main les cas à vérifier.

import { h, button } from '../dom.js'
import { icon } from '../icons.js'
import * as store from '../store.js'
import { openMenu, toast } from '../ui.js'
import { tr } from '../i18n.js'

const TRIGGERS = [
  ['turn', tr`Tour complet`, 'sparkles'],
  ['short', tr`Réponse courte`, 'message'],
  ['long', tr`Tour long (annulable)`, 'clock'],
  ['permission', tr`Demande de permission`, 'shield'],
  ['question', tr`Question de l’agent`, 'message'],
  ['unknown', tr`Événement ACP inconnu`, 'hash'],
  ['error', tr`Erreur daemon`, 'alert-triangle'],
  ['offline', tr`Poste hors ligne 4 s`, 'plug'],
  ['shim-lost', tr`Zed ferme l’agent`, 'x'],
  ['shim-back', tr`Zed rouvre le thread`, 'check'],
  ['new-thread', tr`Nouveau thread dans Zed`, 'plus'],
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
    if (!t) return toast(tr`aucun thread live`, { level: 'warn' })
    const machine = store.state.machines.get(t.machineId)
    machine?.link.send({ type: 'zra/trigger', name, threadId: t.threadId })
  }

  el.append(
    h('span.devbar__tag', { text: 'mock' }),
    ...TRIGGERS.slice(0, 4).map(([id, label, ic]) =>
      button('btn.btn--sm.btn--ghost', { onclick: () => fire(id), title: label }, icon(ic, 'icon--sm'), label)),
    button('btn.btn--sm.btn--ghost', {
      onclick: (ev) => openMenu(ev.currentTarget, {
        label: tr`Simuler`,
        items: TRIGGERS.slice(4).map(([id, label, ic]) => ({ label, icon: ic, onSelect: () => fire(id) })),
      }),
    }, icon('chevron-up-down', 'icon--sm'), tr`Autres`),
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
