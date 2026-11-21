// Barre du bas, commune aux deux écrans — copie de la status bar de Zed
// (reference/zed-bottom-bar/) : fond status_bar.background ; chez ZRA barre
// de 36 px, boutons 28 × 28 (icône 16). Dock droit seulement : en
// partant de la droite, liste des threads puis agent, chacun précédé d'un
// filet vertical 1 × 16.
//
// Actif (icône text_accent, sans fond) = l'écran courant. Le bouton agent
// ramène à la dernière discussion ouverte ; sans aucune discussion ouverte
// jamais, il est désactivé.

import { h, button } from '../dom.js'
import { icon } from '../icons.js'
import { settings, onSettings } from '../settings.js'
import * as store from '../store.js'
import { tr } from '../i18n.js'

/**
 * @param {{ navigate:(hash:string)=>void, active:'threads'|'thread' }} opts
 */
export function BottomBar({ navigate, active }) {
  const agentBtn = button('icon-btn icon-btn--sm', {
    title: tr`Discussion`, 'aria-label': tr`discussion`,
    onclick: () => {
      const last = settings.lastThread
      if (!last) return
      const { machineId, threadId } = store.splitKey(last)
      navigate(`#/t/${machineId}/${threadId}`)
    },
  }, icon('zed_assistant', 'icon--sm'))

  const threadsBtn = button('icon-btn icon-btn--sm', {
    title: tr`Liste des threads`, 'aria-label': tr`liste des threads`,
    onclick: () => navigate('#/'),
  })

  const sync = () => {
    agentBtn.disabled = !settings.lastThread
    agentBtn.classList.toggle('is-active', active === 'thread')
    threadsBtn.classList.toggle('is-active', active === 'threads')
    // Icône Zed de la sidebar, ouverte sur l'écran liste, fermée sinon.
    threadsBtn.replaceChildren(icon(active === 'threads' ? 'threads_sidebar_right_open' : 'threads_sidebar_right_closed', 'icon--sm'))
  }
  const off = onSettings(sync)
  sync()

  const el = h('div.bottombar', {}, h('span.spacer'), h('span.divider-v'), agentBtn, h('span.divider-v'), threadsBtn)
  return { el, destroy: off }
}
