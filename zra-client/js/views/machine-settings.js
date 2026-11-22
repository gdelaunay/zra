// Réglages d'un poste : garde éveillé (reference/conception-zra-veille.md),
// dans la fenêtre style Zed (settings-window.js). Ouverte par l'icône settings
// de la ligne poste (survol / appui long). L'état vit côté daemon : la fenêtre
// demande (`set_keep_awake`) et se repeint au `keep_awake` rediffusé — TTL et
// raison compris. Une seule page sans sections : pas de nav.

import { h, tickText } from '../dom.js'
import { icon } from '../icons.js'
import { formatDuration } from '../format.js'
import { openSettingsWindow, dropdownControl } from '../settings-window.js'
import * as store from '../store.js'
import { tr } from '../i18n.js'

const MODES = [
  { id: 'off', label: tr`Off` },
  { id: '1h', label: tr`1 heure` },
  { id: '4h', label: tr`4 heures` },
  { id: '12h', label: tr`12 heures` },
  { id: 'on', label: tr`Jusqu'à désactivation` },
]

/** Ligne d'état du garde éveillé, telle que la raison et l'échéance la disent. */
export function awakeLabel(ka, now = Date.now()) {
  if (!ka?.active) return null
  if (ka.reason === 'turn') return tr`Un agent travaille : le poste reste éveillé.`
  if (ka.until) return tr`Garde éveillé — ${formatDuration(ka.until - now)} restantes.`
  return tr`Garde éveillé jusqu'à désactivation.`
}

export function openMachineSettings(m) {
  let off = () => {}
  const win = openSettingsWindow({
    title: m.info?.name || m.label || m.url,
    titleIcon: 'server',
    build: () => [keepAwakePage(m)],
  })
  // Le `keep_awake` du daemon (choix, expiration du TTL, fin de tour) repeint
  // la fenêtre tant qu'elle est ouverte ; fermée, le lien se coupe.
  off = store.on('machines', () => {
    if (!win.isConnected) { off(); off = () => {}; return }
    win.rebuild()
  })
  return win
}

function keepAwakePage(m) {
  const ka = m.keepAwake
  const items = [h('div.sblock', {},
    h('p.srow-desc', { text: tr`Le poste ne s'endort jamais pendant qu'un agent travaille. Ce réglage le garde éveillé au-delà, pour reprendre plus tard.` }),
  )]
  // Poste ancien (pas de `keep_awake` au bootstrap) ou mécanisme absent :
  // on le dit, on ne propose pas un réglage qui ne ferait rien.
  if (!ka) {
    items.push(h('div.sblock', {}, h('p.muted', { text: tr`Garde éveillé indisponible sur ce poste.` })))
    return { title: tr`Garde éveillé`, items }
  }
  if (!ka.supported) {
    items.push(h('div.sblock', {}, h('p.muted', { text: tr`Ce poste ne sait pas empêcher la veille automatique : mécanisme indisponible sur son système.` })))
    return { title: tr`Garde éveillé`, items }
  }
  const status = awakeLabel(ka)
  if (status) {
    const text = h('span', { text: status })
    items.push(h('div.sblock', {},
      h(`p.machine-awake-status${ka.reason === 'turn' ? '.machine-awake-status--turn' : ''}`, {},
        icon('coffee', 'icon--sm'), text),
    ))
    // Le décompte vit tant que la fenêtre est ouverte (le TTL est figé sinon).
    if (ka.until) tickText(text, () => awakeLabel(ka))
  }
  items.push({
    title: tr`Mode`,
    desc: tr`Durée pendant laquelle le poste reste éveillé sans agent.`,
    control: dropdownControl({
      ariaLabel: tr`Garde éveillé`,
      label: () => (MODES.find((x) => x.id === m.keepAwake?.mode) || MODES[0]).label,
      items: () => MODES.map((mode) => ({
        label: mode.label,
        on: m.keepAwake?.mode === mode.id,
        onSelect: () => store.setKeepAwake(m.id, mode.id),
      })),
    }),
  })
  return { title: tr`Garde éveillé`, items }
}
