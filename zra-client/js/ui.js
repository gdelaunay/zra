// Surcouches : menus contextuels, fenêtre de settings (settings-window.js),
// modales de confirmation et de formulaire, toasts.
// Style Zed : menu flottant ancré au bouton, pas d'animation superflue.

import { h, button } from './dom.js'
import { icon, agentIcon } from './icons.js'
import { tr } from './i18n.js'

const layer = () => document.getElementById('overlays')

/**
 * Surcouches ouvertes, de la plus ancienne à celle du dessus. Un menu ou une
 * modale de confirmation s'empile sur ce qui est ouvert ; une fenêtre de
 * settings ou un formulaire remplace tout.
 */
const stack = []

/** Ferme la surcouche du dessus. */
export function closeOverlay() {
  const node = stack.pop()
  if (!node) return
  node.remove()
  if (!stack.length) document.removeEventListener('keydown', onEsc, true)
}

/** Ferme tout : changement d'écran. */
export function closeAllOverlays() {
  while (stack.length) closeOverlay()
}

function onEsc(ev) {
  if (ev.key === 'Escape') { ev.stopPropagation(); closeOverlay() }
}

/** @returns {()=>void} ferme **cette** surcouche, et ce qui s'est empilé dessus. */
export function mountOverlay(node, { replace = true } = {}) {
  if (replace) closeAllOverlays()
  if (!stack.length) document.addEventListener('keydown', onEsc, true)
  stack.push(node)
  layer().append(node)
  return () => { while (stack.includes(node)) closeOverlay() }
}

/**
 * Menu ancré à un élément.
 * @param {HTMLElement} anchor
 * @param {{label?:string, items:Array<{label:string, icon?:string, on?:boolean, danger?:boolean, onSelect?:Function, separator?:boolean}>}} opts
 */
/** Interrupteur Zed (toggle.rs) : piste 32×20, pouce 12 ; décoratif, l'état
 * accessible est porté par l'élément parent (checkbox ou menuitemcheckbox). */
export function switchEl(on, cls = '') {
  const el = h('span.switch', { 'aria-hidden': 'true' }, h('span.switch__track', {}, h('span.switch__thumb')))
  if (on) el.classList.add('switch--on')
  if (cls) el.classList.add(cls)
  return el
}

/** Re-clic sur le bouton qui vient de fermer son menu : replie au lieu de rouvrir. */
let toggleGuard = { anchor: null, at: 0 }

export function openMenu(anchor, opts) {
  if (toggleGuard.anchor === anchor && Date.now() - toggleGuard.at < 250) {
    toggleGuard.anchor = null
    return null
  }
  const wrap = h('div')
  let close = () => {}
  const menu = h('div.menu', { role: 'menu' })
  if (opts.label) menu.append(h('div.menu__label.label', { text: opts.label }))
  for (const item of opts.items) {
    if (item.separator) { menu.append(h('div.menu__sep')); continue }
    if (item.header) { menu.append(h('div.menu__label.label', { text: item.label })); continue }
    menu.append(button('menu__item', {
      class: item.on ? 'menu__item--on' : '',
      role: item.toggle !== undefined ? 'menuitemcheckbox' : 'menuitem',
      'aria-checked': item.toggle !== undefined ? String(item.toggle) : undefined,
      style: item.danger ? { color: 'var(--error)' } : undefined,
      onclick: () => { close(); item.onSelect?.() },
    },
      item.agentId ? agentIcon(item.agentId, 'icon--sm')
        : item.icon ? icon(item.icon, 'icon--sm')
          : h('span', { style: { width: '14px' } }),
      h('span.truncate', { text: item.label }),
      // Un interrupteur se lit à droite, comme la coche d'un choix.
      item.toggle !== undefined
        ? switchEl(item.toggle, 'menu__switch')
        : item.on ? icon('check', 'icon--sm') : null,
    ))
  }
  wrap.append(menu)
  const unmount = mountOverlay(wrap, { replace: false })
  // Pas de voile : Zed ne grise pas le fond pour un menu (seulement pour la
  // fenêtre de settings et les modales). Un clic ailleurs ferme et traverse — il active sa
  // cible ; un clic sur le bouton d'origine replie le menu.
  const onDown = (ev) => {
    if (!menu.isConnected) { document.removeEventListener('pointerdown', onDown, true); return }
    if (menu.contains(ev.target)) return
    if (anchor.contains(ev.target)) toggleGuard = { anchor, at: Date.now() }
    close()
  }
  document.addEventListener('pointerdown', onDown, true)
  close = () => { document.removeEventListener('pointerdown', onDown, true); unmount() }

  const r = anchor.getBoundingClientRect()
  const mw = menu.offsetWidth, mh = menu.offsetHeight
  let left = Math.min(Math.max(8, r.left), window.innerWidth - mw - 8)
  let top = r.bottom + 4
  if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 4)
  menu.style.left = `${left}px`
  menu.style.top = `${top}px`
  return menu
}

/**
 * Modale de formulaire (écart ZRA : composition ui_prompt + settings, gallery
 * section 10) : dialogue centré 380 px, tête icône + titre + fermer, corps
 * construit par l'appelant. Pas d'« Annuler » : croix, Échap ou backdrop.
 */
export function formDialog(title, build, { titleIcon } = {}) {
  const wrap = h('div')
  // `build` s'exécute avant le montage : on lie la fermeture après coup.
  let unmount = () => {}
  const close = () => unmount()
  const scrim = h('div.scrim', { onclick: close })
  const dlg = h('div.modal.modal--form', { role: 'dialog', 'aria-modal': 'true', 'aria-label': title })
  dlg.append(h('div.modal__head', {},
    titleIcon ? icon(titleIcon, 'icon--sm icon--muted') : null,
    h('span.modal__title', { text: title }),
    button('icon-btn', { onclick: close, 'aria-label': tr`Fermer` }, icon('x', 'icon--sm')),
  ))
  const body = h('div.modal__body')
  dlg.append(body)
  build(body, { close })
  wrap.append(scrim, dlg)
  unmount = mountOverlay(wrap)
  return dlg
}

// ---- toasts (indépendants du reste des overlays) ----

let toastHost = null

export function toast(message, { level = 'info', ms = 3200 } = {}) {
  if (!toastHost) {
    toastHost = h('div.toasts')
    layer().append(toastHost)
  }
  const el = h(`div.toast.toast--${level}`, {},
    icon(level === 'error' ? 'alert-triangle' : level === 'warn' ? 'alert-triangle' : 'check', 'icon--sm'),
    h('span', { text: message }),
  )
  toastHost.append(el)
  setTimeout(() => el.remove(), ms)
  return el
}

/**
 * Toast d'attente : icône qui tourne, sans échéance, jusqu'à `done()`. Pour ce
 * qui prend quelques secondes sans rien montrer d'autre — Zed piloté au clavier.
 * `maxMs` : filet, jamais affiché indéfiniment si la réponse se perd.
 */
export function activity(message, { maxMs = 45_000 } = {}) {
  const el = toast(message, { ms: maxMs })
  el.querySelector('svg')?.replaceWith(icon('loader', 'icon--sm spin'))
  return { done: () => el.remove() }
}

/**
 * Modale de confirmation — ui_prompt (ZedPromptRenderer), écart ZRA de
 * sévérité : icône en tête et bouton d'action teinté (info → accent,
 * warning → warning, critical → error). Dialogue centré 320 px, pile de
 * boutons pleine largeur ; s'empile sur ce qui est ouvert (les réglages
 * restent dessous). Entrée confirme, Échap / backdrop annulent.
 */
export function confirmDialog(message, detail, onYes, { level = 'info', yes = tr`Confirmer` } = {}) {
  const wrap = h('div')
  let unmount = () => {}
  let done = false
  const finish = (confirmed) => {
    if (done) return
    done = true
    unmount()
    if (confirmed) onYes()
  }
  const scrim = h('div.scrim', { onclick: () => finish(false) })
  const tint = level === 'critical' ? 'btn--tinted-error' : level === 'warning' ? 'btn--tinted-warning' : 'btn--tinted-accent'
  const icCls = level === 'critical' ? 'icon--sm icon--error' : level === 'warning' ? 'icon--sm icon--warning' : 'icon--sm icon--accent'
  const cancel = button('btn.btn--md.btn--outlined.btn--full', { onclick: () => finish(false) }, tr`Annuler`)
  const ok = button(`btn.btn--md.btn--full.${tint}`, { onclick: () => finish(true) }, yes)
  const dlg = h('div.modal', { role: 'alertdialog', 'aria-modal': 'true', 'aria-label': message },
    h('div.modal__head', {}, icon(level === 'info' ? 'info' : 'alert-triangle', icCls), h('span.modal__message', { text: message })),
    detail ? h('div.modal__detail', { text: detail }) : null,
    h('div.modal__actions', {}, cancel, ok),
  )
  // Clavier contexte Prompt : Entrée confirme l'actif, Tab cycle entre les deux.
  dlg.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && ev.target !== cancel && ev.target !== ok) { ev.preventDefault(); finish(true) }
    if (ev.key === 'Tab') { ev.preventDefault(); (document.activeElement === ok ? cancel : ok).focus() }
  })
  wrap.append(scrim, dlg)
  unmount = mountOverlay(wrap, { replace: false })
  ok.focus()
  return dlg
}
