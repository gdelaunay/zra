// Écran 1 — liste des threads, calquée sur le sidebar de Zed :
// groupée par poste, triée par récence, pastille d'état, chemin abrégé.

import { h, button, clear, debounce } from '../dom.js'
import { icon } from '../icons.js'
import { relTime, absTime, shortPath, agentLabel, toMs } from '../format.js'
import * as store from '../store.js'
import { openMenu } from '../ui.js'
import { openSettings } from './settings.js'

const FILTERS = [
  { id: 'all', label: 'Tous' },
  { id: 'live', label: 'Live' },
  { id: 'archived', label: 'Archivés' },
]

export function ThreadsView({ navigate }) {
  let query = ''
  let filter = 'all'

  const list = h('div.scroll')
  const search = h('input.input', {
    type: 'search', placeholder: 'Filtrer les threads…', value: query,
    'aria-label': 'filtrer les threads',
    oninput: debounce((ev) => { query = ev.target.value.toLowerCase(); paint() }, 120),
  })

  const filterBtn = button('btn.btn--ghost.btn--sm', {
    onclick: (ev) => openMenu(ev.currentTarget, {
      label: 'Afficher',
      items: FILTERS.map((f) => ({
        label: f.label, on: filter === f.id,
        onSelect: () => { filter = f.id; syncFilterLabel(); paint() },
      })),
    }),
  }, icon('list-todo', 'icon--sm'), h('span', { text: 'Tous' }), icon('chevron-down', 'icon--sm'))

  const syncFilterLabel = () => {
    filterBtn.querySelector('span').textContent = FILTERS.find((f) => f.id === filter).label
  }

  const el = h('div.app__view', { style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 } },
    header({ navigate }),
    h('div.toolbar', h('div.spacer', { style: { flex: 1, display: 'block' } }, search), filterBtn),
    list,
  )

  function paint() {
    clear(list)
    const machines = [...store.state.machines.values()]
    if (!machines.length) {
      list.append(h('div.empty', {},
        icon('server', 'icon--lg'),
        h('div', { text: 'Aucun poste enregistré.' }),
        button('btn.btn--accent', { onclick: () => openSettings() }, icon('plus', 'icon--sm'), 'Ajouter un poste')))
      return
    }

    let total = 0
    for (const m of machines) {
      const rows = m.threads
        .filter((t) => matches(t, query, filter))
        .sort((a, b) => (toMs(b.updatedAt) ?? 0) - (toMs(a.updatedAt) ?? 0))
      total += rows.length

      list.append(machineHead(m))
      if (m.status !== 'online') {
        list.append(h('div.empty', { style: { padding: '12px' } },
          h('span', { text: m.status === 'connecting' ? 'connexion…' : (m.error || 'poste injoignable') }),
          m.status === 'offline'
            ? button('btn.btn--sm', { onclick: () => m.link.wake?.() }, icon('refresh', 'icon--sm'), 'Réessayer')
            : null))
        continue
      }
      if (!rows.length) {
        list.append(h('div.empty', { style: { padding: '12px' }, text: 'aucun thread' }))
        continue
      }
      for (const t of rows) list.append(threadRow(m, t, navigate))
    }

    if (!total && query) {
      list.append(h('div.empty', {}, icon('search', 'icon--lg'), h('div', { text: `aucun thread pour « ${query} »` })))
    }
  }

  const offs = [
    store.on('machines', paint),
    store.on('threads', paint),
  ]
  paint()

  return { el, destroy() { offs.forEach((off) => off()) } }
}

function header({ navigate }) {
  const el = h('div.header')
  const sub = h('span.header__sub')
  el.append(
    h('div.header__title', {}, icon('zap', 'icon--sm'), h('span', { text: 'ZRA' }), sub),
    h('span.spacer'),
    button('icon-btn', { title: 'Rafraîchir', onclick: () => store.refreshAll() }, icon('refresh', 'icon--sm')),
    button('icon-btn', { title: 'Réglages', onclick: () => openSettings() }, icon('settings', 'icon--sm')),
  )
  const sync = () => {
    const machines = [...store.state.machines.values()]
    const online = machines.filter((m) => m.status === 'online').length
    const live = machines.flatMap((m) => m.threads).filter((t) => t.state === 'live').length
    sub.textContent = `${online}/${machines.length} poste${machines.length > 1 ? 's' : ''} · ${live} live`
  }
  store.on('machines', sync)
  store.on('threads', sync)
  sync()
  return el
}

function machineHead(m) {
  const status = m.status === 'online' ? 'en ligne' : m.status === 'connecting' ? 'connexion…' : 'hors ligne'
  return h('div.group__head', {},
    h(`span.dot.dot--${m.status === 'online' ? 'live' : 'unknown'}`),
    h('span.group__name', { text: m.info?.name || m.label || m.url }),
    h('span.group__meta', { text: `· ${status}` }),
    m.info?.zedRunning === false ? h('span.group__meta', { text: '· Zed fermé' }) : null,
    h('span.spacer'),
    h('span.group__meta', { text: m.threads.length ? `${m.threads.length}` : '' }),
  )
}

function threadRow(m, t, navigate) {
  const unknown = t.state === 'unknown'
  const row = button('thread-row', {
    class: unknown ? 'thread-row--unknown' : '',
    disabled: unknown,
    title: unknown ? "thread sans session : non consultable" : t.title,
    onclick: () => navigate(`#/t/${m.id}/${t.threadId}`),
  },
    h(`span.dot.dot--${t.state}.thread-row__dot`),
    h('span.thread-row__body', {},
      h('span.thread-row__title.truncate', { text: t.title || 'sans titre' }),
      h('span.thread-row__meta', {},
        h('span.thread-row__path.truncate', { text: shortPath(t.folderPaths?.[0], 2) }),
        t.folderPaths?.length > 1 ? h('span', { text: `+${t.folderPaths.length - 1}` }) : null,
        h('span', { text: '·' }),
        h('span', { text: relTime(t.updatedAt), title: absTime(t.updatedAt) }),
      ),
    ),
    t.archived ? h('span.thread-row__badge', { text: 'archivé' }) : null,
    t.agentId ? h('span.thread-row__badge', { text: agentLabel(t.agentId) }) : null,
  )
  return row
}

function matches(t, query, filter) {
  if (filter === 'live' && t.state !== 'live') return false
  if (filter === 'archived' && !t.archived) return false
  if (!query) return true
  const hay = `${t.title} ${(t.folderPaths || []).join(' ')} ${t.agentId || ''}`.toLowerCase()
  return hay.includes(query)
}
