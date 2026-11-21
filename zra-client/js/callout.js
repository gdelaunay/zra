// Callout Zed — ui/components/callout.rs, galerie reference/zed-ui/agent-panel.html
// section 11 : pleine largeur, filet haut, fond teinté par sévérité, icône sur
// la hauteur de ligne, titre + actions sur une ligne, description muted
// (scrollable au-delà de 128 px, comme `max_h_32`).

import { h, button } from './dom.js'
import { icon } from './icons.js'
import { tr } from './i18n.js'
import { renderMarkdown } from './markdown.js'

// Sévérité → icône et couleur, comme le `match severity` de callout.rs
// (l'icône info est muted, pas bleue).
const SEVERITY_ICON = { error: 'x-circle', warning: 'alert-triangle', info: 'info' }

/**
 * Rend un callout neuf (l'appelant remplace le contenu de son slot).
 * `spec` : { severity: 'error'|'warning'|'info', title, desc?, markdown?,
 *   spinner?, actions?: [{ label, onclick }], copy?: () => void, close?: () => void }.
 * `markdown` : la description est du markdown (erreur d'agent, comme Zed).
 * `spinner` : action en cours (pattern « Authenticating to Claude Code… »),
 * rendu à droite : `arrow_circle` muted animé 2 s, comme
 * `render_auth_required_state` (`IconName::ArrowCircle`, rotate 2).
 */
export function renderCallout({ severity = 'info', title, desc, markdown, spinner, actions, copy, close }) {
  const acts = h('span.callout__actions')
  for (const a of actions || []) acts.append(button('btn', { onclick: a.onclick }, a.label))
  if (spinner) acts.append(icon('arrow_circle', 'icon--sm spin muted'))
  if (copy) acts.append(button('icon-btn icon-btn--sm', { title: tr`Copier`, 'aria-label': tr`Copier`, onclick: copy }, icon('copy', 'icon--sm')))
  if (close) acts.append(button('icon-btn icon-btn--sm', { title: tr`Fermer`, 'aria-label': tr`Fermer`, onclick: close }, icon('x', 'icon--sm')))
  const body = h('div.callout__body', {},
    h('div.callout__title-row', {}, h('span.callout__title', { text: title }), acts.childElementCount ? acts : null))
  if (desc) body.append(h('div.callout__desc', markdown ? { class: 'md muted', html: renderMarkdown(desc) } : { text: desc }))
  return h(`div.callout.callout--${severity}`, { role: 'alert' },
    h('span.callout__icon', {}, icon(SEVERITY_ICON[severity], 'icon--sm')),
    body)
}