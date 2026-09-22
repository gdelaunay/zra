// Écran 2 — un thread : flux d'événements ACP + composer.

import { h, button, clear, rafBatch } from '../dom.js'
import { icon, agentIcon } from '../icons.js'
import { relTime, absTime, shortPath, agentLabel } from '../format.js'
import * as store from '../store.js'
import { renderEntry } from './entry.js'
import { openMenu, toast } from '../ui.js'
import { newSessionButton } from './new-session.js'
import { settings, update as updateSettings } from '../settings.js'

export function ThreadView({ key, navigate }) {
  const st = store.ensureState(key)
  const machine = store.machineOf(key)
  if (!machine) {
    return {
      el: h('div.empty', {}, h('div', { text: 'poste inconnu' }),
        button('btn', { onclick: () => navigate('#/') }, 'Retour')),
      destroy() {},
    }
  }

  store.openThread(key)

  const feed = h('div.scroll.thread__scroll')
  const nodes = new Map()
  let stick = true

  const jump = button('jump.hidden', {
    onclick: () => { stick = true; scrollToEnd(); jump.classList.add('hidden') },
  }, icon('arrow-down', 'icon--sm'), 'Dernier message')

  const banner = h('div.banner.hidden')
  const title = h('span.truncate')
  const subtitle = h('span', { title: '' })
  const dot = h('span.dot')
  const agentSlot = h('span.header__agent')
  const pathLabel = h('span.path.truncate')

  const modeBtn = button('pill', { onclick: (ev) => optionMenu(ev, 'mode') })
  const modelBtn = button('pill', { onclick: (ev) => optionMenu(ev, 'model') })

  const composer = Composer({
    key,
    onSend: (text, mode) => store.sendMessage(key, text, mode),
    onStop: stopTurn,
  })

  const el = h('div.view',
    h('div.header', {},
      agentSlot,
      h('div.header__title', {}, dot, title),
      h('div.header__meta', {}, pathLabel, h('span', { text: '·' }), subtitle),
      newSessionButton({ machineId: store.splitKey(key).machineId }),
      button('icon-btn', { onclick: overflowMenu, 'aria-label': 'actions' }, icon('settings', 'icon--sm')),
    ),
    banner,
    h('div.thread__wrap', {}, feed, jump),
    composer.el,
    h('div.bottombar', {}, modeBtn, modelBtn, h('span.spacer'),
      // Même boîte que le bouton Envoyer : c'est une action, pas un réglage.
      button('send-btn.send-btn--icon', {
        title: 'Liste des threads', 'aria-label': 'liste des threads',
        onclick: () => navigate('#/'),
      }, icon('list', 'icon--sm'))),
  )

  /**
   * Bouton Stop : coupe le tour en cours.
   *
   * S'il y a un message **en file d'attente**, il part dans la foulée — c'est le
   * « stop et envoie ». Le texte en cours de saisie, lui, n'est jamais envoyé
   * tout seul : seul le bouton Envoyer envoie.
   */
  function stopTurn() {
    const queued = st.queue?.[0]
    if (queued) {
      store.cancelQueued(key, queued.queueId)
      store.sendMessage(key, queued.text, 'interrupt')
      return
    }
    store.interrupt(key)
  }

  // ---- rendu du flux ----

  function ctx() {
    const tl = store.ensureTimeline(key)
    return {
      timeline: tl,
      busy: st.turn === 'busy',
      // Une permission ne se répond que si l'agent est encore au bout du fil.
      canRespond: st.state === 'live' && store.machineOf(key)?.status === 'online',
      onPermission: (entry, option) => store.respondPermission(key, entry.requestId, option),
    }
  }

  function paintAll() {
    clear(feed)
    nodes.clear()
    const tl = store.ensureTimeline(key)
    const c = ctx()
    tl.entries.forEach((entry, i) => {
      const node = renderEntry(entry, { ...c, isLast: i === tl.entries.length - 1 })
      nodes.set(entry.id, node)
      feed.append(node)
    })
    paintStatusLines()
    scrollToEnd(true)
  }

  function paintStatusLines() {
    const tl = store.ensureTimeline(key)
    feed.querySelector('.thread__status')?.remove()
    let text = null
    if (st.historyPending) text = 'chargement de l’historique (session/load)…'
    else if (st.historyError) text = st.historyError
    else if (!tl.entries.length) text = st.state === 'live'
      ? 'thread live, aucun événement pour l’instant'
      : 'aucun historique'
    if (text) feed.append(h('div.empty.thread__status', {}, h('span', { text })))
  }

  const repaintLast = () => {
    // Le curseur de frappe ne concerne que la dernière entrée.
    const tl = store.ensureTimeline(key)
    const last = tl.entries[tl.entries.length - 1]
    if (last) patch({ op: 'update', entry: last })
  }

  function patch(change) {
    const tl = store.ensureTimeline(key)
    const c = ctx()
    const isLast = tl.entries[tl.entries.length - 1]?.id === change.entry.id
    const node = renderEntry(change.entry, { ...c, isLast })
    const prev = nodes.get(change.entry.id)
    if (prev) {
      // Conserve l'état d'ouverture des blocs déjà dépliés par l'utilisateur.
      preserveOpen(prev, node)
      prev.replaceWith(node)
    } else {
      feed.append(node)
    }
    nodes.set(change.entry.id, node)
  }

  // Les événements sont peints par lot, une fois par frame, sans en perdre un seul.
  const onTimeline = rafBatch((batch) => {
    if (batch.some((p) => !p || p.reset)) { paintAll(); return }
    const tl = store.ensureTimeline(key)
    for (const payload of batch) {
      for (const e of payload.removed || []) { nodes.get(e.id)?.remove(); nodes.delete(e.id) }
      for (const change of payload.changes || []) {
        if (change.op === 'add') {
          // l'entrée précédente perd son curseur de frappe
          const prevEntry = tl.entries[tl.entries.indexOf(change.entry) - 1]
          if (prevEntry && nodes.has(prevEntry.id)) patch({ op: 'update', entry: prevEntry })
        }
        patch(change)
      }
    }
    if (tl.entries.length) feed.querySelector('.thread__status')?.remove()
    scrollToEnd()
  })

  const onState = () => {
    syncHeader()
    composer.sync(st)
    paintStatusLines()
    repaintLast()
    repaintPermissions()
  }

  /** Les encarts de permission dépendent de l'état du thread, pas d'un événement. */
  function repaintPermissions() {
    for (const entry of store.ensureTimeline(key).pendingPermissions()) {
      if (nodes.has(entry.id)) patch({ op: 'update', entry })
    }
  }

  function syncHeader() {
    const summary = st.summary || {}
    title.textContent = summary.title || 'thread'
    dot.className = `dot dot--${st.turn === 'busy' ? 'busy' : st.state || 'closed'}`
    subtitle.textContent = relTime(summary.updatedAt)
    subtitle.title = absTime(summary.updatedAt)
    pathLabel.textContent = shortPath(summary.folderPaths?.[0], 2)
    pathLabel.title = summary.folderPaths?.join('\n') || ''
    clear(agentSlot)
    agentSlot.append(agentIcon(summary.agentId, 'icon--sm'))
    agentSlot.title = agentLabel(summary.agentId)
    const mode = st.modes?.find((m) => m.id === st.currentModeId)
    const model = st.models?.find((m) => m.id === st.currentModelId)
    setPill(modeBtn, 'shuffle', mode?.name || st.currentModeId || 'mode', Boolean(st.modes?.length))
    setPill(modelBtn, 'sparkles', model?.name || st.currentModelId || agentLabel(summary.agentId), Boolean(st.models?.length))

    const m = store.machineOf(key)
    let msg = null, level = ''
    if (m.status !== 'online') { msg = `${m.label} hors ligne — reconnexion automatique`; level = 'banner--error' }
    else if (st.state === 'closed') msg = 'thread fermé — la réponse rouvrira le thread dans Zed (§6.3)'
    else if (st.state === 'unknown') msg = 'thread sans session : lecture et écriture indisponibles'
    banner.className = `banner ${level} ${msg ? '' : 'hidden'}`.trim()
    clear(banner)
    if (msg) banner.append(icon('alert-triangle', 'icon--sm'), h('span', { text: msg }))
  }

  function setPill(btn, iconName, label, enabled) {
    clear(btn)
    btn.append(icon(iconName, 'icon--sm'), h('span.truncate', { text: label }), icon('chevron-down', 'icon--sm'))
    btn.disabled = !enabled
    btn.style.opacity = enabled ? '' : '.5'
  }

  function optionMenu(ev, kind) {
    const list = kind === 'mode' ? st.modes : st.models
    const currentId = kind === 'mode' ? st.currentModeId : st.currentModelId
    if (!list?.length) return
    openMenu(ev.currentTarget, {
      label: kind === 'mode' ? 'Mode' : 'Modèle',
      items: list.map((o) => ({
        label: o.name || o.id,
        on: o.id === currentId,
        onSelect: () => {
          if (st.turn === 'busy') toast('changement appliqué après le tour en cours', { level: 'warn' })
          store.setOption(key, kind, o.id)
        },
      })),
    })
  }

  function overflowMenu(ev) {
    openMenu(ev.currentTarget, {
      items: [
        { label: 'Recharger l’historique', icon: 'refresh', onSelect: () => { st.historyComplete = false; store.loadHistory(key) } },
        { label: settings.showThoughts ? 'Masquer les réflexions' : 'Afficher les réflexions', icon: 'lightbulb',
          onSelect: () => { updateSettings({ showThoughts: !settings.showThoughts }); paintAll() } },
        { label: settings.expandTools ? 'Replier les outils' : 'Déplier les outils', icon: 'wrench',
          onSelect: () => { updateSettings({ expandTools: !settings.expandTools }); paintAll() } },
        { separator: true },
        { label: 'Copier l’identifiant du thread', icon: 'copy',
          onSelect: () => copy(store.splitKey(key).threadId) },
      ],
    })
  }

  // ---- défilement ----

  function scrollToEnd(force = false) {
    if (!stick && !force) return
    feed.scrollTop = feed.scrollHeight
  }

  feed.addEventListener('scroll', () => {
    const atEnd = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 60
    stick = atEnd
    jump.classList.toggle('hidden', atEnd)
  })

  const offs = [
    store.on(`timeline:${key}`, onTimeline),
    store.on(`state:${key}`, onState),
    store.on('machines', () => { syncHeader(); repaintPermissions() }),
    store.on('threads', () => { syncHeader() }),
  ]

  paintAll()
  syncHeader()
  composer.sync(st)
  setTimeout(() => composer.focus(), 60)

  return {
    el,
    destroy() {
      offs.forEach((off) => off())
      store.closeThread(key)
    },
  }
}

function preserveOpen(oldNode, newNode) {
  const oldOpen = [...oldNode.querySelectorAll('.is-open')].map((n) => n.className)
  if (!oldOpen.length) return
  const targets = newNode.querySelectorAll('.diff, .raw, .tool')
  const olds = oldNode.querySelectorAll('.diff, .raw, .tool')
  targets.forEach((t, i) => { if (olds[i]?.classList.contains('is-open')) t.classList.add('is-open') })
}

function copy(text) {
  navigator.clipboard?.writeText(text).then(
    () => toast('copié'),
    () => toast('copie impossible', { level: 'error' }),
  )
}

// ---- composer ----

function Composer({ key, onSend, onStop }) {
  const input = h('textarea.composer__input', {
    rows: 1,
    placeholder: 'Répondre à l’agent…',
    enterkeyhint: 'send',
    autocapitalize: 'sentences',
    oninput: autoGrow,
    // Entrée envoie ; Maj+Entrée et Ctrl+Entrée sautent une ligne (SPEC §14.2).
    // Pendant une composition (IME, accents morts), Entrée appartient à la saisie.
    onkeydown: (ev) => {
      if (ev.key !== 'Enter' || ev.isComposing) return
      if (ev.shiftKey) return
      ev.preventDefault()
      if (ev.ctrlKey || ev.metaKey) newline()
      else send('queue')
    },
  })

  const queueBox = h('div.composer__queue')
  // Envoyer ne change jamais : pendant un tour, le message part en file d'attente.
  const sendBtn = button('send-btn', { onclick: () => send('queue'), title: 'Envoyer (Entrée — Maj+Entrée pour aller à la ligne)' },
    icon('send', 'icon--sm'), h('span', { text: 'Envoyer' }))
  // Stop n'apparaît que pendant un tour : icône seule, à gauche d'Envoyer.
  const stopBtn = button('send-btn.send-btn--icon.send-btn--stop.hidden', {
    onclick: stop, title: "Interrompre le tour (et envoyer le message en file, s'il y en a un)",
    'aria-label': 'interrompre',
  }, icon('stop', 'icon--sm'))

  const micBtn = button('icon-btn', { title: 'Dictée', onclick: dictate }, icon('mic', 'icon--sm'))
  const hint = h('span.composer__hint')

  const el = h('div.composer', {},
    queueBox,
    h('div.composer__box', {},
      input,
      h('div.composer__row', {}, micBtn, hint, h('span.spacer'), stopBtn, sendBtn),
    ),
  )

  /** Ctrl+Entrée n'insère rien de lui-même dans un textarea : on le fait. */
  function newline() {
    const { selectionStart: a, selectionEnd: b, value } = input
    input.value = value.slice(0, a) + '\n' + value.slice(b)
    input.selectionStart = input.selectionEnd = a + 1
    autoGrow()
  }

  function autoGrow() {
    input.style.height = 'auto'
    input.style.height = `${Math.min(input.scrollHeight, window.innerHeight * 0.4)}px`
  }

  function send(mode) {
    const text = input.value.trim()
    if (!text) return
    onSend(text, mode)
    input.value = ''
    autoGrow()
  }

  // Stop ne touche pas au champ de saisie : ce qui y est écrit y reste.
  function stop() { onStop?.() }

  function dictate() {
    const Rec = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!Rec) {
      input.focus()
      toast('utilise le micro du clavier de ton téléphone', { level: 'warn' })
      return
    }
    const rec = new Rec()
    rec.lang = 'fr-FR'
    rec.interimResults = true
    rec.continuous = false
    const base = input.value
    micBtn.classList.add('is-active')
    rec.onresult = (ev) => {
      let text = ''
      for (const r of ev.results) text += r[0].transcript
      input.value = base ? `${base} ${text}` : text
      autoGrow()
    }
    rec.onend = () => micBtn.classList.remove('is-active')
    rec.onerror = () => { micBtn.classList.remove('is-active'); toast('dictée indisponible', { level: 'error' }) }
    rec.start()
  }

  function sync(st) {
    const busy = st.turn === 'busy'
    stopBtn.classList.toggle('hidden', !busy)
    el.classList.toggle('is-disabled', st.state === 'unknown')
    hint.textContent = busy ? 'tour en cours — le message part en file' : ''

    clear(queueBox)
    for (const q of st.queue || []) {
      queueBox.append(h('div.queued', {},
        icon('clock', 'icon--sm'),
        h('span.truncate', { text: q.text }),
        h('span.spacer'),
        button('icon-btn', { title: 'Annuler', onclick: () => store.cancelQueued(key, q.queueId) },
          icon('x', 'icon--sm'))))
    }
  }

  return { el, sync, focus: () => input.focus() }
}
