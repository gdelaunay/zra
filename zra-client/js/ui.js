// Surcouches : menus contextuels, feuilles du bas, toasts.
// Style Zed : menu flottant ancré au bouton, pas d'animation superflue.

import { h, button, clear } from './dom.js'
import { icon } from './icons.js'

const layer = () => document.getElementById('overlays')

let current = null

export function closeOverlay() {
  if (!current) return
  current.remove()
  current = null
  document.removeEventListener('keydown', onEsc, true)
}

function onEsc(ev) {
  if (ev.key === 'Escape') { ev.stopPropagation(); closeOverlay() }
}

function mount(node) {
  closeOverlay()
  current = node
  layer().append(node)
  document.addEventListener('keydown', onEsc, true)
  return node
}

/**
 * Menu ancré à un élément.
 * @param {HTMLElement} anchor
 * @param {{label?:string, items:Array<{label:string, icon?:string, on?:boolean, danger?:boolean, onSelect?:Function, separator?:boolean}>}} opts
 */
export function openMenu(anchor, opts) {
  const wrap = h('div')
  const scrim = h('div.scrim', { onclick: closeOverlay })
  const menu = h('div.menu', { role: 'menu' })
  if (opts.label) menu.append(h('div.menu__label.label', { text: opts.label }))
  for (const item of opts.items) {
    if (item.separator) { menu.append(h('div.menu__sep')); continue }
    menu.append(button('menu__item', {
      class: item.on ? 'menu__item--on' : '',
      role: 'menuitem',
      style: item.danger ? { color: 'var(--error)' } : undefined,
      onclick: () => { closeOverlay(); item.onSelect?.() },
    },
      item.icon ? icon(item.icon, 'icon--sm') : h('span', { style: { width: '14px' } }),
      h('span.truncate', { text: item.label }),
      item.on ? icon('check', 'icon--sm') : null,
    ))
  }
  wrap.append(scrim, menu)
  mount(wrap)

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
  const scrim = h('div.scrim', { onclick: closeOverlay })
  const sheet = h('div.sheet', { role: 'dialog', 'aria-modal': 'true' })
  sheet.append(h('div.sheet__title', {},
    titleIcon ? icon(titleIcon, 'icon--sm') : null,
    h('span', { text: title }),
    h('span.spacer'),
    button('icon-btn', { onclick: closeOverlay, 'aria-label': 'fermer' }, icon('x', 'icon--sm')),
  ))
  const body = h('div')
  sheet.append(body)
  build(body, { close: closeOverlay, rebuild: () => { clear(body); build(body, { close: closeOverlay }) } })
  wrap.append(scrim, sheet)
  mount(wrap)
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
