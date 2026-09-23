// Écran 2 — un thread : flux d'événements ACP + composer.

import { h, button, clear, rafBatch, patchHtml } from '../dom.js'
import { icon, agentIcon } from '../icons.js'
import { relTime, absTime, shortPath, agentLabel, projectOf, toMs, formatTokens, formatCost } from '../format.js'
import * as store from '../store.js'
import { renderEntry, blocksPieces, revealBlocks, textLength, messageBody } from './entry.js'
import { openMenu, toast, switchEl } from '../ui.js'
import { newSessionButton } from './new-session.js'
import { settings, update as updateSettings } from '../settings.js'

/**
 * Au-delà de ce nombre de réglages hors mode/modèle, ils passent tous dans le
 * menu « ⋯ », quel que soit leur type : la barre du bas ne défile pas.
 */
const INLINE_OPTIONS = 2

/** Entrées écrites en streaming, révélées peu à peu. */
const STREAMED = new Set(['agent', 'thought'])
/**
 * Le retard se résorbe en exponentielle de constante 100 ms : vite sur une
 * rafale, en douceur à la fin… Calculé sur le temps écoulé, pas par frame : un
 * téléphone lent (ou un onglet qui a dormi) rattrape au même rythme.
 */
const REVEAL_TAU_MS = 100
/** … et jamais moins de 250 caractères par seconde, pour que la fin ne traîne pas. */
const REVEAL_MIN_CPS = 250

/** Icône d'un réglage générique, d'après sa catégorie ACP (indicative, jamais requise). */
const OPTION_ICONS = { thought_level: 'lightbulb', model_config: 'zap' }

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
  const optionsSlot = h('span.bottombar__options')

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
      // Nouveau thread dans le projet de celui-ci.
      newSessionButton({
        machineId: store.splitKey(key).machineId,
        project: () => (st.summary ? projectOf(st.summary.folderPaths) : null),
      }),
      button('icon-btn', { onclick: overflowMenu, 'aria-label': 'actions' }, icon('settings', 'icon--sm')),
    ),
    banner,
    h('div.thread__wrap', {}, feed, jump),
    composer.el,
    h('div.bottombar', {}, modeBtn, modelBtn, optionsSlot, h('span.spacer'),
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
    // Un rendu complet affiche tout : rien à révéler.
    reveals.clear()
    const tl = store.ensureTimeline(key)
    const c = ctx()
    tl.entries.forEach((entry, i) => {
      const node = renderEntry(entry, { ...c, isLast: i === tl.entries.length - 1 })
      node._zraLen = textLength(entry.blocks)
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

  // ---- streaming fluide ----
  //
  // L'agent envoie son texte par paquets irréguliers (relevé chez claude-acp :
  // des rafales de 2 000 caractères, puis rien pendant une demi-seconde). Les
  // afficher tels quels, c'est un texte qui saute. Le message en cours d'écriture
  // est donc révélé à un débit régulier, qui accélère avec le retard accumulé :
  // on ne traîne jamais plus de quelques frames derrière l'agent. Et seul son
  // dernier bloc markdown est repeint (`patchHtml`), pas tout le message.

  /** @type {Map<string, { entry:object, shown:number }>} */
  const reveals = new Map()
  let revealing = false

  const isLive = (entry) => STREAMED.has(entry.type) && st.turn === 'busy' &&
    store.ensureTimeline(key).last()?.id === entry.id

  function reveal(entry, prev) {
    let r = reveals.get(entry.id)
    // Premier paquet d'un message déjà peint : on repart de ce qu'il affiche.
    if (!r) reveals.set(entry.id, (r = { entry, shown: prev?._zraLen ?? 0 }))
    r.entry = entry
    if (!revealing) { revealing = true; requestAnimationFrame(revealFrame) }
  }

  function revealFrame(now = performance.now()) {
    revealing = false
    let more = false
    for (const [id, r] of reveals) {
      const node = nodes.get(id)
      if (!node?.isConnected) { reveals.delete(id); continue }
      const full = textLength(r.entry.blocks)
      const live = isLive(r.entry)
      // Premier pas d'une rafale : une frame nominale ; ensuite le temps réel,
      // borné. L'horloge repart à chaque rafale (`r.at` effacé une fois à jour) :
      // une pause de l'agent ne doit pas faire tout apparaître d'un coup.
      const dt = r.at === undefined ? 16 : Math.min(100, Math.max(1, now - r.at))
      r.at = now
      if (r.shown < full) {
        const backlog = full - r.shown
        const step = Math.max(
          Math.ceil((REVEAL_MIN_CPS * dt) / 1000),
          Math.ceil(backlog * (1 - Math.exp(-dt / REVEAL_TAU_MS))),
        )
        r.shown = Math.min(full, r.shown + step)
        patchHtml(messageBody(node), blocksPieces(revealBlocks(r.entry.blocks, r.shown), {
          cursor: r.entry.type === 'agent' && (live || r.shown < full),
        }))
        node._zraLen = r.shown
      }
      if (r.shown < full) more = true
      else r.at = undefined
      if (r.shown >= full && !live) {
        // Tout est affiché et l'agent est passé à autre chose : rendu définitif,
        // sur place — le message garde ses nœuds, seul le curseur s'en va.
        reveals.delete(id)
        patchHtml(messageBody(node), blocksPieces(r.entry.blocks))
        node.dataset.rev = r.entry.rev
        node._zraLen = full
      }
    }
    if (more) { revealing = true; requestAnimationFrame(revealFrame) }
    scrollToEnd()
  }

  function patch(change) {
    const tl = store.ensureTimeline(key)
    const c = ctx()
    const isLast = tl.entries[tl.entries.length - 1]?.id === change.entry.id
    const prev = nodes.get(change.entry.id)
    const pending = reveals.get(change.entry.id)
    if (isLive(change.entry) || (pending && pending.shown < textLength(change.entry.blocks))) {
      if (!prev) {
        // Nouveau message : monté vide, le texte arrive par `revealFrame`.
        const node = renderEntry({ ...change.entry, blocks: [] }, { ...c, isLast })
        node._zraLen = 0
        feed.append(node)
        nodes.set(change.entry.id, node)
      }
      reveal(change.entry, prev)
      return
    }
    reveals.delete(change.entry.id)
    const node = renderEntry(change.entry, { ...c, isLast })
    node._zraLen = textLength(change.entry.blocks)
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
    if (batch.some((p) => !p || p.reset)) { paintAll(); syncMeta(); return }
    const tl = store.ensureTimeline(key)
    let meta = false
    for (const payload of batch) {
      for (const e of payload.removed || []) { nodes.get(e.id)?.remove(); nodes.delete(e.id) }
      for (const change of payload.changes || []) {
        // État de la session (consommation, titre) : rien à peindre dans le fil.
        if (change.op === 'meta') { meta = true; continue }
        if (change.op === 'add') {
          // l'entrée précédente perd son curseur de frappe
          const prevEntry = tl.entries[tl.entries.indexOf(change.entry) - 1]
          if (prevEntry && nodes.has(prevEntry.id)) patch({ op: 'update', entry: prevEntry })
        }
        patch(change)
      }
    }
    if (tl.entries.length) feed.querySelector('.thread__status')?.remove()
    if (meta) syncMeta()
    scrollToEnd()
  })

  /** Ce qui dépend de l'état annoncé par l'agent : titre, date, consommation. */
  function syncMeta() {
    syncHeader()
    composer.setUsage(store.ensureTimeline(key).usage)
  }

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
    const info = store.ensureTimeline(key).info
    // Le titre que l'agent annonce en direct devance l'index de Zed (poll 2 s),
    // sauf si l'utilisateur a renommé le thread : son choix prime.
    title.textContent = (!summary.titleOverridden && info.title) || summary.title || 'thread'
    dot.className = `dot dot--${st.turn === 'busy' ? 'busy' : st.state || 'closed'}`
    const updatedAt = (toMs(info.updatedAt) ?? 0) > (toMs(summary.updatedAt) ?? 0) ? info.updatedAt : summary.updatedAt
    subtitle.textContent = relTime(updatedAt)
    subtitle.title = absTime(updatedAt)
    pathLabel.textContent = shortPath(summary.folderPaths?.[0], 2)
    pathLabel.title = summary.folderPaths?.join('\n') || ''
    clear(agentSlot)
    agentSlot.append(agentIcon(summary.agentId, 'icon--sm'))
    agentSlot.title = agentLabel(summary.agentId)
    const mode = st.modes?.find((m) => m.id === st.currentModeId)
    const model = st.models?.find((m) => m.id === st.currentModelId)
    setPill(modeBtn, 'shuffle', mode?.name || st.currentModeId || 'mode', Boolean(st.modes?.length))
    setPill(modelBtn, 'sparkles', model?.name || st.currentModelId || agentLabel(summary.agentId), Boolean(st.models?.length))
    syncOptions()

    const m = store.machineOf(key)
    let msg = null, level = ''
    if (m.status === 'locked') { msg = `${m.label} : appairage requis — depuis la liste des threads`; level = 'banner--error' }
    else if (m.status !== 'online') { msg = `${m.label} hors ligne — reconnexion automatique`; level = 'banner--error' }
    else if (st.state === 'closed') msg = 'thread fermé — la réponse rouvrira le thread dans Zed (§6.3)'
    else if (st.state === 'unknown') msg = 'thread sans session : lecture et écriture indisponibles'
    banner.className = `banner ${level} ${msg ? '' : 'hidden'}`.trim()
    clear(banner)
    if (msg) banner.append(icon('alert-triangle', 'icon--sm'), h('span', { text: msg }))
  }

  /**
   * Comme dans Zed, la pastille porte la valeur, sans icône ; sur un écran
   * étroit, l'icône remplace la valeur (CSS `.pill__icon` / `.pill__label`).
   */
  function setPill(btn, iconName, label, enabled) {
    clear(btn)
    btn.title = label
    btn.append(icon(iconName, 'icon--sm pill__icon'), h('span.truncate.pill__label', { text: label }), icon('chevron-down', 'icon--sm'))
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
        onSelect: () => choose(kind, o.id),
      })),
    })
  }

  function choose(optKey, value) {
    if (st.turn === 'busy') toast('changement appliqué après le tour en cours', { level: 'warn' })
    store.setOption(key, optKey, value)
  }

  // ---- réglages génériques (effort, mode rapide…) ----

  /** Les réglages hors mode/modèle : en ligne s'ils sont peu nombreux, sinon dans « ⋯ ». */
  function syncOptions() {
    clear(optionsSlot)
    // Le shim ne relaie que ces deux types ; on reste prudent envers un autre daemon.
    const options = (st.options || []).filter((o) => o.type === 'boolean' || o.type === 'select')
    if (options.length > INLINE_OPTIONS) {
      optionsSlot.append(button('pill', {
        title: 'Autres réglages', 'aria-label': 'autres réglages', onclick: moreMenu,
      }, icon('more', 'icon--sm')))
      return
    }
    for (const o of options) optionsSlot.append(optionPill(o))
  }

  function optionPill(o) {
    const iconName = OPTION_ICONS[o.category] || 'settings'
    const title = o.description ? `${o.name} — ${o.description}` : o.name
    if (o.type === 'boolean') {
      // Un interrupteur, à droite du libellé : c'est lui qui dit l'état.
      return button('pill', {
        title, role: 'switch', 'aria-checked': String(o.currentValue), onclick: () => choose(o.id, !o.currentValue),
      }, icon(iconName, 'icon--sm pill__icon'), h('span.truncate.pill__label', { text: o.name }), switchEl(o.currentValue))
    }
    const value = o.values.find((v) => v.id === o.currentValue)
    return button('pill', { title, onclick: (ev) => selectMenu(ev, o) },
      icon(iconName, 'icon--sm pill__icon'),
      h('span.truncate.pill__label', { text: value?.name || o.currentValue || o.name }),
      icon('chevron-down', 'icon--sm'))
  }

  function selectMenu(ev, o) {
    openMenu(ev.currentTarget, {
      label: o.name,
      items: o.values.map((v) => ({
        label: v.name || v.id,
        on: v.id === o.currentValue,
        onSelect: () => choose(o.id, v.id),
      })),
    })
  }

  /**
   * Tous les réglages génériques dans un seul menu : les interrupteurs d'abord,
   * cochés quand ils sont actifs, puis un intertitre par sélecteur.
   */
  function moreMenu(ev) {
    const options = st.options || []
    const items = options.filter((o) => o.type === 'boolean').map((o) => ({
      label: o.name, toggle: o.currentValue, onSelect: () => choose(o.id, !o.currentValue),
    }))
    for (const o of options) {
      if (o.type !== 'select') continue
      items.push({ header: true, label: o.name })
      for (const v of o.values) {
        items.push({ label: v.name || v.id, on: v.id === o.currentValue, onSelect: () => choose(o.id, v.id) })
      }
    }
    openMenu(ev.currentTarget, { items })
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
  syncMeta()
  composer.sync(st)
  // Focus d'office sur desktop seulement : sur mobile, il ferait surgir le
  // clavier alors qu'on ouvre souvent un thread juste pour le lire.
  if (window.matchMedia?.('(hover: hover) and (pointer: fine)').matches) setTimeout(() => composer.focus(), 60)

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
  // Consommation du contexte, comme sous l'éditeur de Zed : « 27k / 1M ».
  const usage = h('span.usage.hidden')

  const el = h('div.composer', {},
    queueBox,
    h('div.composer__box', {},
      input,
      h('div.composer__row', {}, micBtn, hint, h('span.spacer'), usage, stopBtn, sendBtn),
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

  /** @param {{ used:number, size:number|null, cost:object|null } | null} u */
  function setUsage(u) {
    usage.classList.toggle('hidden', !u)
    if (!u) return
    const ratio = u.size ? u.used / u.size : null
    const cost = formatCost(u.cost)
    usage.textContent = u.size ? `${formatTokens(u.used)} / ${formatTokens(u.size)}` : formatTokens(u.used)
    usage.classList.toggle('usage--warn', ratio !== null && ratio >= 0.8 && ratio < 0.95)
    usage.classList.toggle('usage--full', ratio !== null && ratio >= 0.95)
    const n = (v) => v.toLocaleString('fr-FR')
    usage.title = [
      `contexte : ${n(u.used)}${u.size ? ` / ${n(u.size)}` : ''} tokens${ratio !== null ? ` (${Math.round(ratio * 100)} %)` : ''}`,
      cost ? `coût de la session : ${cost}` : null,
    ].filter(Boolean).join('\n')
  }

  return { el, sync, setUsage, focus: () => input.focus() }
}
