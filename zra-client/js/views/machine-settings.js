// Feuille de réglages d'un poste : garde éveillé (reference/conception-zra-veille.md).
// Ouverte par l'icône settings de la ligne poste (survol / appui long).
// L'état vit côté daemon : la feuille demande (`set_keep_awake`) et se
// repeint au `keep_awake` rediffusé — TTL et raison compris.

import { h, button, clear } from '../dom.js'
import { icon } from '../icons.js'
import { formatDuration } from '../format.js'
import { openSheet } from '../ui.js'
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

export function openMachineSheet(m) {
  let off = () => {}
  const sheet = openSheet(m.info?.name || m.label || m.url, (body, { close }) => {
    off()
    // Le `keep_awake` du daemon (choix, expiration du TTL, fin de tour)
    // repeint la feuille tant qu'elle est ouverte ; fermée, le lien se coupe.
    off = store.on('machines', () => {
      if (!sheet.isConnected) { off(); off = () => {}; return }
      clear(body)
      build(body, m, close)
    })
    build(body, m, close)
  }, { titleIcon: 'server' })
  return sheet
}

function build(body, m, close) {
  const ka = m.keepAwake
  body.append(h('section.field', {},
    h('span.label', { text: tr`Garde éveillé` }),
    h('span.composer__hint', { text: tr`Le poste ne s'endort jamais pendant qu'un agent travaille. Ce réglage le garde éveillé au-delà, pour reprendre plus tard.` }),
  ))
  // Poste ancien (pas de `keep_awake` au bootstrap) ou mécanisme absent :
  // on le dit, on ne propose pas un réglage qui ne ferait rien.
  if (!ka) {
    body.append(h('p.muted', { text: tr`Garde éveillé indisponible sur ce poste.` }))
    return
  }
  if (!ka.supported) {
    body.append(h('p.muted', { text: tr`Ce poste ne sait pas empêcher la veille automatique : mécanisme indisponible sur son système.` }))
    return
  }
  const status = awakeLabel(ka)
  if (status) body.append(h('p.machine-awake-status', {}, icon('coffee', 'icon--sm'), h('span', { text: status })))
  const list = h('div', { role: 'menu', 'aria-label': tr`Garde éveillé` })
  for (const mode of MODES) {
    const on = ka.mode === mode.id
    list.append(button('menu__item', {
      class: on ? 'menu__item--on' : '',
      role: 'menuitemradio',
      'aria-checked': String(on),
      onclick: () => { close(); store.setKeepAwake(m.id, mode.id) },
    },
      h('span', { style: { width: '14px' } }),
      h('span.truncate', { text: mode.label }),
      on ? icon('check', 'icon--sm') : null,
    ))
  }
  body.append(list)
}