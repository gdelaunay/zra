// Surcouches : menus contextuels, feuilles du bas, toasts.
// Style Zed : menu flottant ancré au bouton, pas d'animation superflue.

import { h, button, clear } from './dom.js'
import { icon, agentIcon } from './icons.js'

const layer = () => document.getElementById('overlays')

/**
 * Surcouches ouvertes, de la plus ancienne à celle du dessus. Un menu s'empile
 * sur ce qui est ouvert (le sélecteur de thème sur la feuille des réglages) ;
 * une feuille remplace tout.
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
function mount(node, { replace = true } = {}) {
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
/** Interrupteur visuel ; l'état accessible est porté par l'élément parent. */
export function switchEl(on, cls = '') {
  const el = h('span.switch', { 'aria-hidden': 'true' }, h('span.switch__knob'))
  if (on) el.classList.add('switch--on')
  if (cls) el.classList.add(cls)
  return el
}

export function openMenu(anchor, opts) {
  const wrap = h('div')
  let close = () => {}
  const scrim = h('div.scrim', { onclick: () => close() })
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
  wrap.append(scrim, menu)
  close = mount(wrap, { replace: false })

  const r = anchor.getBoundingClientRect()
  const mw = menu.offsetWidth, mh = menu.offsetHeight
  let left = Math.min(Math.max(8, r.left), window.innerWidth - mw - 8)
  let top = r.bottom + 4
  if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 4)
  menu.style.left = `${left}px`
  menu.style.top = `${top}px`
  return menu
}

/** Feuille ancrée en bas de l'écran (réglages, formulaires). */
export function openSheet(title, build, { titleIcon } = {}) {
  const wrap = h('div')
  // `build` s'exécute avant le montage : on lie la fermeture après coup.
  let unmount = () => {}
  const close = () => unmount()
  const scrim = h('div.scrim', { onclick: close })
  const sheet = h('div.sheet', { role: 'dialog', 'aria-modal': 'true' })
  sheet.append(h('div.sheet__title', {},
    titleIcon ? icon(titleIcon, 'icon--sm') : null,
    h('span', { text: title }),
    h('span.spacer'),
    button('icon-btn', { onclick: close, 'aria-label': 'fermer' }, icon('x', 'icon--sm')),
  ))
  const body = h('div')
  sheet.append(body)
  build(body, { close, rebuild: () => { clear(body); build(body, { close }) } })
  wrap.append(scrim, sheet)
  unmount = mount(wrap)
  return sheet
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

/** Confirmation simple, sans dépendre de `confirm()` (bloqué en PWA standalone). */
export function confirmSheet(title, message, onYes, { danger = false, yes = 'Confirmer' } = {}) {
  openSheet(title, (body, { close }) => {
    body.append(
      h('p.muted', { text: message }),
      h('div.row', { style: { justifyContent: 'flex-end' } },
        button('btn.btn--ghost', { onclick: close }, 'Annuler'),
        button('btn', { class: danger ? 'btn--danger' : 'btn--accent', onclick: () => { close(); onYes() } }, yes)),
    )
  })
}
