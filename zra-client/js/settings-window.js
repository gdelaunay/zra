// Fenêtre de settings style Zed — port de settings_ui (reference/zed-ui/
// settings-window.html, zed-ui.md). Titlebar + nav (recherche, arbre pages /
// sections) + contenu : toutes les pages sont rendues d'un coup, la nav ne
// fait que scroller jusqu'à la catégorie et suit le défilement.
// Écarts ZRA : backdrop fermant, pas de commandes de fenêtre ni de pied de
// nav, nav en puces horizontales sous 626 px, pas de fichiers User/Projet,
// pas de copy-link ni settings.json.

import { h, button, clear } from './dom.js'
import { icon } from './icons.js'
import { tr } from './i18n.js'
import { mountOverlay, openMenu, switchEl } from './ui.js'

/**
 * Ouvre la fenêtre. `build(api)` rend les pages :
 *   [{ title, sections: [{ title, items }] }]  ou  [{ title, items }]
 * Un item est une ligne `{ title, desc?, control }` ou un HTMLElement (bloc
 * libre). La nav est masquée pour une page unique sans sections.
 * @returns {HTMLElement} la fenêtre, avec `rebuild()` et `close()` attachés.
 */
export function openSettingsWindow({ title, titleIcon, build }) {
  const wrap = h('div')
  let unmount = () => {}
  const close = () => unmount()
  const api = { close, rebuild: () => render(true) }

  const scrim = h('div.scrim', { onclick: close })
  const win = h('div.swindow', { role: 'dialog', 'aria-modal': 'true', 'aria-label': title })
  win.append(h('div.sw-titlebar', {},
    titleIcon ? icon(titleIcon, 'icon--sm icon--muted') : null,
    h('span.sw-title', { text: title }),
    button('icon-btn', { onclick: close, 'aria-label': tr`Fermer` }, icon('x', 'icon--sm')),
  ))

  // Nav : recherche + arbre (racines = pages, enfants = sections).
  const nav = h('div.sw-nav')
  const searchInput = h('input.sw-query', {
    type: 'search', placeholder: tr`Rechercher dans les réglages`,
    'aria-label': tr`Rechercher dans les réglages`,
    oninput: () => filter(searchInput.value),
  })
  const clearBtn = button('icon-btn.sw-search-clear', {
    'aria-label': tr`Effacer la recherche`,
    onclick: () => { searchInput.value = ''; filter('') },
  }, icon('x', 'icon--xs'))
  nav.append(h('div.sw-search', {}, icon('search', 'icon--sm icon--muted'), searchInput, clearBtn))
  const tree = h('div.sw-tree', { role: 'tree', 'aria-label': title })
  nav.append(tree)

  const content = h('div.sw-content')
  const noResults = h('div.no-results.hidden', {},
    h('span', { text: tr`Aucun résultat` }),
    h('span.nr-sub'),
  )
  const page = h('div.sw-page', {}, content)
  const body = h('div.sw-body', {}, nav, page)
  win.append(body)
  wrap.append(scrim, win)

  let blocks = []    // { el, root, sections: [{ el, tvi }] } — pages rendues
  let anchors = []   // { el, tvi } — titres de page et en-têtes de section
  let roots = []     // { tvi, kids, open }
  let query = ''

  function render(keepScroll) {
    const scrollTop = keepScroll ? content.scrollTop : 0
    const pages = build(api)
    clear(content); clear(tree)
    blocks = []; anchors = []; roots = []
    const withNav = pages.length > 1 || pages.some((p) => p.sections?.length)
    nav.classList.toggle('hidden', !withNav)

    for (const p of pages) {
      const block = h('div.sw-pageblock')
      const titleEl = h('div.sw-pagetitle', { text: p.title })
      block.append(titleEl)
      const root = withNav ? navRoot(p.title) : null
      if (root) anchors.push({ el: titleEl, tvi: root.tvi })
      const record = { el: block, root, sections: [] }
      for (const g of p.sections ?? [{ title: null, items: p.items ?? [] }]) {
        const sec = h('div.sw-section')
        let head = null
        if (g.title) {
          head = h('div.ssh', {}, h('span.ssh-label', { text: g.title }), h('span.divider-h'))
          sec.append(head)
          if (root) {
            const tvi = navChild(g.title, root)
            anchors.push({ el: head, tvi })
            record.sections.push({ el: sec, tvi })
          }
        }
        const items = g.items ?? []
        items.forEach((item, i) => {
          const isNode = item?.nodeType === 1
          const el = isNode ? item : rowEl(item)
          if (i === items.length - 1) el.classList.add('last')
          el.dataset.search = (isNode ? item.textContent : `${item.title} ${item.desc ?? ''}`).toLowerCase()
          sec.append(el)
        })
        if (!g.title) record.sections.push({ el: sec, tvi: null })
        block.append(sec)
      }
      blocks.push(record)
      content.append(block)
    }
    content.append(noResults)
    filter(query)
    content.scrollTop = scrollTop
    select(anchors[0]?.tvi)
  }

  /** Racine de nav : chevron repliable + libellé ; clic = scroll vers la page. */
  function navRoot(label) {
    const disclosure = button('tvi-disclosure', {
      'aria-label': label, 'aria-expanded': 'true',
      onclick: (ev) => { ev.stopPropagation(); setOpen(root, !root.open) },
    }, icon('chevron-down', 'icon--sm'))
    const tvi = h('div.tvi.tvi--root.open', { role: 'treeitem', tabindex: '0' },
      h('div.tvi-inner', {}, disclosure, h('span.tvi-label.truncate', { text: label })))
    const kids = h('div.tvi-kids', { role: 'group' })
    const root = { tvi, kids, open: true }
    const go = () => { setOpen(root, true); scrollTo(anchors.find((a) => a.tvi === tvi)?.el); select(tvi) }
    tvi.addEventListener('click', go)
    tvi.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); go() } })
    tree.append(tvi, kids)
    roots.push(root)
    return root
  }

  /** Enfant de nav : ligne d'indentation + libellé ; clic = scroll vers la section. */
  function navChild(label, root) {
    const tvi = h('div.tvi.tvi--child', { role: 'treeitem', tabindex: '0' },
      h('div.tvi-inner', {}, h('span.tvi-indent'), h('span.tvi-label.truncate', { text: label })))
    const go = () => { scrollTo(anchors.find((a) => a.tvi === tvi)?.el); select(tvi) }
    tvi.addEventListener('click', go)
    tvi.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); go() } })
    root.kids.append(tvi)
    return tvi
  }

  function setOpen(root, open) {
    root.open = open
    root.tvi.classList.toggle('open', open)
    root.tvi.querySelector('.tvi-disclosure')?.setAttribute('aria-expanded', String(open))
    root.kids.classList.toggle('hidden', !open)
  }

  function select(tvi) {
    for (const el of tree.querySelectorAll('.tvi.selected')) el.classList.remove('selected')
    tvi?.classList.add('selected')
  }

  function scrollTo(el) {
    el?.scrollIntoView?.({ block: 'start', behavior: 'smooth' })
  }

  // La sélection suit le défilement (update_navbar_entry_from_scroll_position).
  content.addEventListener('scroll', () => {
    if (query) return
    const top = content.scrollTop + 32
    let current = anchors[0]?.tvi
    for (const a of anchors) {
      const at = a.el.getBoundingClientRect().top - content.getBoundingClientRect().top + content.scrollTop
      if (at <= top) current = a.tvi
    }
    select(current)
  }, { passive: true })

  /** Recherche : filtre les lignes (sous-chaîne), masque sections et pages vides. */
  function filter(value) {
    query = value.trim().toLowerCase()
    clearBtn.classList.toggle('hidden', !query)
    let any = false
    for (const b of blocks) {
      let pageVisible = false
      for (const s of b.sections) {
        let visible = 0
        for (const el of s.el.children) {
          if (el.classList.contains('ssh')) continue
          const show = !query || (el.dataset.search || '').includes(query)
          el.classList.toggle('hidden', !show)
          if (show) visible += 1
        }
        s.el.classList.toggle('hidden', Boolean(query) && !visible)
        s.tvi?.classList.toggle('hidden', Boolean(query) && !visible)
        if (visible) pageVisible = true
      }
      b.el.classList.toggle('hidden', Boolean(query) && !pageVisible)
      b.root?.tvi.classList.toggle('hidden', Boolean(query) && !pageVisible)
      if (pageVisible) any = true
    }
    // Recherche active : toute la nav est dépliée (Zed) ; sinon l'état revient.
    for (const r of roots) r.kids.classList.toggle('hidden', !query && !r.open)
    noResults.classList.toggle('hidden', !query || any)
    noResults.querySelector('.nr-sub').textContent = tr`Aucun réglage ne correspond à « ${value.trim()} »`
  }

  render(false)
  unmount = mountOverlay(wrap)
  win.rebuild = api.rebuild
  win.close = close
  return win
}

/** Ligne de réglage : titre + description à gauche (max 2/3), contrôle à droite. */
function rowEl({ title, desc, control }) {
  return h('div.srow', {}, h('div.srow-inner', {},
    h('div.srow-text', {},
      h('div.srow-title', {}, h('span', { text: title })),
      desc ? h('div.srow-desc', { text: desc }) : null),
    h('div.srow-control', {}, control),
  ))
}

/**
 * Dropdown Zed (EnumVariantDropdown) : 28 px, bordure border_variant,
 * chevron up/down ; menu à coches (openMenu). `label()` et `items()` sont
 * relus à chaque ouverture ; le libellé se resynchronise après un choix.
 */
export function dropdownControl({ label, items, ariaLabel }) {
  const lbl = h('span.truncate', { text: label() })
  const btn = button('dropdown', {
    'aria-label': ariaLabel, 'aria-haspopup': 'menu',
    onclick: (ev) => openMenu(ev.currentTarget, {
      items: items().map((it) => ({ ...it, onSelect: () => { it.onSelect?.(); lbl.textContent = label() } })),
    }),
  }, lbl, icon('chevron-up-down', 'icon--xs'))
  btn.sync = () => { lbl.textContent = label() }
  return btn
}

/**
 * Interrupteur Zed accessible : checkbox native (cachée, elle porte l'état et
 * le focus) + visuel switch. `sync()` reflète l'état de la checkbox après une
 * modification programmatique.
 */
export function switchControl({ checked, disabled, label, onchange }) {
  const input = h('input.switch-input', { type: 'checkbox', 'aria-label': label, onchange })
  input.checked = Boolean(checked)
  input.disabled = Boolean(disabled)
  const visual = switchEl(Boolean(checked))
  const wrap = h('label.switch-wrap', {}, input, visual)
  const sync = () => visual.classList.toggle('switch--on', input.checked)
  input.addEventListener('change', sync)
  wrap.sync = sync
  return wrap
}
