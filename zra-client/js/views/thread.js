// Écran 2 — un thread : flux d'événements ACP + composer, calqués sur le
// panel agent de Zed (reference/zed-ui/agent-panel.html).

import { h, button, clear, rafBatch, patchHtml, scrollbarOnGestures } from '../dom.js'
import { icon, agentIcon } from '../icons.js'
import { baseName, agentLabel, projectOf, formatTokens, formatCost, formatDuration, terminalElapsed } from '../format.js'
import * as store from '../store.js'
import { renderEntry, blocksPieces, revealBlocks, textLength, messageBody, planPanel, permissionButtons, inlineTitle } from './entry.js'
import { openMenu, toast, switchEl } from '../ui.js'
import { newSessionButton } from './new-session.js'
import { BottomBar } from './bottombar.js'
import { settings, onSettings } from '../settings.js'
import { openSettings } from './settings.js'
import { tr, locale } from '../i18n.js'
import { composerCompletion, validateSlash } from '../completion.js'
import { renderCallout } from '../callout.js'
import { editable } from '../editor.js'

/**
 * Au-delà de ce nombre de réglages hors mode/modèle, ils passent tous dans le
 * menu « ⋯ », quel que soit leur type : la barre du composer ne défile pas.
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

/** Spinner de Zed (`spinner_label.rs`) : braille, Dots 1 s, Sand 2 s. */
const BRAILLE = {
  dots: { f: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'], ms: 1000 },
  sand: { f: ['⠁', '⠂', '⠄', '⡀', '⡈', '⡐', '⡠', '⣀', '⣁', '⣂', '⣄', '⣌', '⣔', '⣤', '⣥', '⣦', '⣮', '⣶', '⣷', '⣿', '⡿', '⠿', '⢟', '⠟', '⡛', '⠛', '⠫', '⢋', '⠋', '⠍', '⡉', '⠉', '⠑', '⠡', '⢁'], ms: 2000 },
}

export function ThreadView({ key, navigate }) {
  const st = store.ensureState(key)
  const machine = store.machineOf(key)
  if (!machine) {
    return {
      el: h('div.empty', {}, h('div', { text: tr`Poste inconnu.` }),
        button('btn', { onclick: () => navigate('#/') }, tr`Retour`)),
      destroy() {},
    }
  }

  store.openThread(key)

  const feed = h('div.scroll.thread__scroll')
  // Scrollbar sur geste uniquement : le tail-following (scrollToEnd) ne doit
  // pas la révéler à chaque chunk. revealSb pour les sauts initiés par l'utilisateur.
  const revealSb = scrollbarOnGestures(feed)
  const nodes = new Map()
  let stick = true
  /** Le thread a déjà été vu dans l'index : sa disparition = suppression, on quitte. */
  let hadThread = false
  const activity = h('div.activity.hidden')
  const activityWrap = h('div.activity-wrap', {}, activity)
  // Plan replié par défaut, comme dans Zed (`plan_expanded`).
  let planOpen = false

  // « Revenir en bas » : icône seule dans un carré, apparence bouton Zed.
  const jump = button('jump.hidden', {
    title: tr`Dernier message`, 'aria-label': tr`Dernier message`,
    onclick: () => { stick = true; scrollToEnd(); revealSb(); jump.classList.add('hidden') },
  }, icon('arrow-down', 'icon--sm'))

  // Indicateur de tour — render_generating : spinner braille, durée du tour ;
  // « Sand » + libellé quand une confirmation est attendue.
  const spinEl = h('span.spinner', { text: '⠋' })
  const turnLabel = h('span')
  const turnTime = h('span.turn__time')
  const turnLine = h('div.generating', {}, h('span.slot', {}, spinEl), turnLabel, turnTime)
  const turnWrap = h('div.entry-wrap.turn-wrap', {}, turnLine)
  let turnTimer = null
  let spinMode = 'dots'
  const spinT0 = performance.now()

  // Callout unique au-dessus du composer (callout.rs) : états machine/thread,
  // réouverture, erreur de commande — arbitré par `paintCallout`, pas d'empilage.
  const calloutSlot = h('div.callout-slot')
  let cmdError = null
  // Le titre est lui-même un input subtil (`render_title_view` de Zed) :
  // Entrée ou blur valide le renommage (ACP), Échap annule.
  const displayedTitle = () => {
    const summary = st.summary || {}
    const info = store.ensureTimeline(key).info
    return (!summary.titleOverridden && info.title) || summary.title || tr`Nouveau Thread d'Agent`
  }
  const title = h('input.header__title-input.truncate', {
    'aria-label': tr`Titre du thread`,
    // Comme Zed : cliquer le titre sélectionne tout, il n'y a qu'à taper.
    onfocus: () => title.select(),
    oninput: () => { title.size = Math.max(4, title.value.length + 1) },
    onkeydown: (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); title.blur() }
      else if (ev.key === 'Escape') { ev.preventDefault(); title.value = displayedTitle(); title.blur() }
    },
    onblur: () => {
      const v = title.value.trim()
      const current = displayedTitle()
      if (v && v !== current) store.renameThread(key, v)
      else title.value = current
    },
  })
  const dot = h('span.dot')
  const lock = h('span.lock-dot.hidden', { title: tr`Lecture seule : créé hors ZRA, répondre dans Zed.` }, icon('lock', 'icon--sm'))
  const agentSlot = h('span.header__agent')
  const pathLabel = h('span.path.truncate')

  const modeBtn = button('pill', { onclick: (ev) => optionMenu(ev, 'mode') })
  const modelBtn = button('pill', { onclick: (ev) => optionMenu(ev, 'model') })
  const optionsSlot = h('span.composer__options', { style: { display: 'contents' } })

  const composer = Composer({
    key,
    agentName: () => agentLabel(st.summary?.agentId),
    selectors: [modeBtn, modelBtn, optionsSlot],
    // Commandes de l'agent : `thread_state` (shim live), ou le rejeu
    // `available_commands_update` de l'historique (thread fermé, claude-acp).
    getCommands: () => {
      const cmds = st.commands
      return cmds?.length ? cmds : store.ensureTimeline(key).availableCommands
    },
    onSend: (text, mode) => {
      // Répondre à un thread fermé : Zed le rouvre au clavier, ce qui prend
      // quelques secondes. Le callout le dit jusqu'au retour du thread (ou l'échec).
      if (st.state === 'closed') startReopen()
      // Envoyer, c'est vouloir lire la réponse : le fil se recolle en bas et
      // suit le stream, même si on était remonté dans l'historique. Toujours —
      // c'est le comportement de Zed (l'ancien réglage « scrollOnSend » n'était
      // jamais décoché, il a été supprimé et rendu permanent).
      stick = true; jump.classList.add('hidden'); scrollToEnd()
      store.sendMessage(key, text, mode)
    },
    onStop: stopTurn,
    calloutSlot,
    onCommandError: (err) => { cmdError = err; paintCallout() },
  })

  /** Zed est en train de rouvrir ce thread : `null`, ou l'instant de la demande. */
  let reopening = null
  let reopenTimer = null
  function startReopen() {
    reopening = Date.now()
    clearTimeout(reopenTimer)
    // Filet : le daemon abandonne à 30 s, l'erreur arrive d'elle-même.
    reopenTimer = setTimeout(endReopen, 45_000)
    syncHeader()
  }
  function endReopen() {
    if (reopening === null) return
    reopening = null
    clearTimeout(reopenTimer)
    syncHeader()
  }

  const bottombar = BottomBar({ navigate, active: 'thread' })

  const el = h('div.view',
    // Barre du haut : icône agent, nom, chemin (un niveau) ; à droite
    // pastille live, filet, « + » (nouvelle session), rechargement, réglages.
    h('div.header', {},
      agentSlot,
      h('div.header__title', {}, title),
      h('div.header__meta', {}, pathLabel),
      h('div.header__right', {},
        dot, lock,
        h('span.divider-v'),
        newSessionButton({
          machineId: store.splitKey(key).machineId,
          project: () => (st.summary ? projectOf(st.summary.folderPaths) : null),
        }),
        button('icon-btn icon-btn--sm', { title: tr`Recharger l’historique`, onclick: () => { st.historyComplete = false; store.loadHistory(key) } }, icon('refresh', 'icon--sm')),
        button('icon-btn icon-btn--sm', { title: tr`Réglages`, onclick: () => openSettings() }, icon('settings', 'icon--sm')),
      ),
    ),
    h('div.thread__wrap', {}, feed, jump),
    activityWrap,
    composer.el,
    bottombar.el,
  )

  /**
   * Bouton Stop : coupe le tour, comme dans Zed (`cancel_generation`) — la file
   * reste en pause jusqu'au prochain envoi. Le texte en cours de saisie n'est
   * jamais envoyé tout seul.
   */
  function stopTurn() {
    store.interrupt(key)
  }

  /** « Envoyer maintenant » d'un message en file (`send_now`) : coupe le tour s'il y en a un. */
  function sendNow(q) {
    store.cancelQueued(key, q.queueId)
    stick = true; jump.classList.add('hidden'); scrollToEnd()
    store.sendMessage(key, q.text, 'interrupt')
  }

  // ---- barre d'activité ----
  //
  // Comme Zed (`render_activity_bar`), au-dessus du composer : la permission en
  // attente quand sa carte est hors de vue (`render_main_agent_awaiting_permission`),
  // le plan de l'agent, et la file d'attente des messages.

  function syncActivity() {
    const tl = store.ensureTimeline(key)
    clear(activity)
    const pending = tl.pendingPermissions().filter((p) => !p.pendingOptionId)
    const first = pending[0]
    const node = first && nodes.get(tl.byToolCall.get(first.toolCallId)?.id)
    if (first && !(node && inView(node))) {
      activity.append(
        button('awaiting-head', {
          onclick: () => { stick = false; node?.scrollIntoView?.({ block: 'center' }); revealSb() },
        },
          icon('alert-triangle', 'icon--sm'),
          h('span', { text: pending.length > 1 ? tr`En attente de confirmation (${pending.length}).` : tr`En attente de confirmation` }),
          h('span.spacer'),
          node ? icon(node.getBoundingClientRect().top < feed.getBoundingClientRect().top ? 'arrow-up' : 'arrow-down', 'icon--sm') : null),
        h('div.md.awaiting-title', { html: inlineTitle(first.toolCall?.title || 'action') }),
        permissionButtons(first, ctx()))
    }
    if (tl.planEntry?.items?.length) {
      activity.append(planPanel(tl.planEntry, { open: planOpen, onToggle: () => { planOpen = !planOpen; syncActivity() } }))
    }
    for (const q of st.queue || []) {
      activity.append(h('div.queue-row', {},
        h('span.q-text.truncate', { text: q.text }),
        h('span.q-btns', {},
          button('icon-btn icon-btn--sm', { title: tr`Envoyer maintenant`, onclick: () => sendNow(q) },
            icon('forward_arrow_up', 'icon--sm')),
          button('icon-btn icon-btn--sm', { title: tr`Annuler`, onclick: () => store.cancelQueued(key, q.queueId) },
            icon('x', 'icon--sm')))))
    }
    activity.classList.toggle('hidden', !activity.childElementCount)
  }

  /** Carte visible dans le fil (au moins en partie). */
  function inView(node) {
    const r = node.getBoundingClientRect()
    const f = feed.getBoundingClientRect()
    return r.bottom > f.top && r.top < f.bottom
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
      onElicitation: (entry, action, content) => store.respondElicitation(key, entry.requestId, action, content),
      agentName: agentLabel(st.summary?.agentId),
      // Répertoire du projet : cwd de repli des cartes terminal (claude-agent-acp
      // ne donne pas le sien ; pi-acp si, `terminal_info.cwd`).
      folderPaths: st.summary?.folderPaths || [],
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
      // Avis warn/error : rendus en callout (paintCallout), pas montés dans le fil.
      if (entry.type === 'notice' && entry.level !== 'info') return
      const node = renderEntry(entry, { ...c, isLast: i === tl.entries.length - 1 })
      node._zraLen = textLength(entry.blocks)
      nodes.set(entry.id, node)
      feed.append(node)
    })
    paintStatusLines()
    syncTurn()
    scrollToEnd(true)
    syncActivity()
  }

  /** L'indicateur de tour : toujours en dernier dans le fil, et seulement pendant un tour. */
  function syncTurn() {
    const busy = st.turn === 'busy' && Boolean(st.turnSince)
    if (!busy) {
      turnWrap.remove()
      clearInterval(turnTimer)
      turnTimer = null
      return
    }
    const waiting = store.ensureTimeline(key).pendingPermissions().length > 0
    spinMode = waiting ? 'sand' : 'dots'
    turnLabel.textContent = waiting ? tr`En attente de confirmation…` : ''
    turnTime.textContent = formatDuration(Date.now() - st.turnSince)
    if (turnWrap.parentNode !== feed || turnWrap.nextSibling) { feed.append(turnWrap); scrollToEnd() }
    if (!turnTimer) {
      turnTimer = setInterval(() => {
        const { f, ms } = BRAILLE[spinMode]
        spinEl.textContent = f[Math.floor(((performance.now() - spinT0) % ms) / ms * f.length)]
        turnTime.textContent = formatDuration(Date.now() - st.turnSince)
        // Durée des terminaux en cours : mise à jour sans repeindre la carte.
        for (const el of feed.querySelectorAll('.term__elapsed[data-started]')) {
          el.textContent = terminalElapsed(Date.now() - Number(el.dataset.started))
        }
      }, 50)
    }
  }

  function paintStatusLines() {
    const tl = store.ensureTimeline(key)
    feed.querySelector('.thread__status')?.remove()
    // Les avis warn/error et les états d'historique vivent en callout, pas dans le fil.
    const visible = tl.entries.filter((e) => !(e.type === 'notice' && e.level !== 'info'))
    let text = null
    if (!visible.length) text = st.state === 'live'
      ? tr`Thread live, aucun événement pour l’instant.`
      : tr`Aucun historique.`
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
        patchHtml(messageBody(node), blocksPieces(revealBlocks(r.entry.blocks, r.shown)))
        node._zraLen = r.shown
      }
      if (r.shown < full) more = true
      else r.at = undefined
      if (r.shown >= full && !live) {
        // Tout est affiché et l'agent est passé à autre chose : rendu définitif,
        // sur place — le message garde ses nœuds.
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
    // Avis warn/error : callout, pas de nœud dans le fil.
    if (change.entry.type === 'notice' && change.entry.level !== 'info') return
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
    // Une demande se peint dans la carte de son tool call.
    if (change.entry.type === 'permission') {
      const tool = tl.byToolCall.get(change.entry.toolCallId)
      if (tool && nodes.has(tool.id)) patch({ op: 'update', entry: tool })
    }
  }

  // Les événements sont peints par lot, une fois par frame, sans en perdre un seul.
  const onTimeline = rafBatch((batch) => {
    if (batch.some((p) => !p || p.reset)) { paintAll(); syncMeta(); paintCallout(); return }
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
    if (nodes.size) feed.querySelector('.thread__status')?.remove()
    if (meta) syncMeta()
    syncTurn()
    scrollToEnd()
    syncActivity()
    paintCallout()
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
    syncTurn()
    syncActivity()
  }

  /** Les encarts de permission dépendent de l'état du thread, pas d'un événement. */
  function repaintPermissions() {
    const tl = store.ensureTimeline(key)
    for (const entry of tl.pendingPermissions()) {
      if (nodes.has(entry.id)) patch({ op: 'update', entry })
      const tool = tl.byToolCall.get(entry.toolCallId)
      if (tool && nodes.has(tool.id)) patch({ op: 'update', entry: tool })
    }
    // Questions de l'agent : répondables ou non selon le même état.
    for (const entry of tl.pendingElicitations()) {
      if (nodes.has(entry.id)) patch({ op: 'update', entry })
    }
    syncActivity()
  }

  function syncHeader() {
    const summary = st.summary || {}
    // Le titre que l'agent annonce en direct devance l'index de Zed (poll 2 s),
    // sauf si l'utilisateur a renommé le thread : son choix prime.
    if (document.activeElement !== title) title.value = displayedTitle()
    // Repli sans `field-sizing: content` : la taille suit le texte (approximatif).
    title.size = Math.max(4, title.value.length + 1)
    // Agent sans `session/set_title` : le titre reste consultable, pas éditable.
    title.readOnly = summary.canRename === false
    title.tabIndex = title.readOnly ? -1 : 0
    title.classList.toggle('header__title-input--readonly', title.readOnly)
    hadThread = hadThread || Boolean(st.summary)
    // Comme dans la liste : cadenas à la place de la pastille si lecture seule.
    const readOnly = Boolean(store.foreignAgent(key))
    dot.className = `dot dot--${st.turn === 'busy' ? 'busy' : st.state || 'closed'}${readOnly ? ' hidden' : ''}`
    lock.classList.toggle('hidden', !readOnly)
    // Chemin projet : un seul niveau (« ../pp-runtimes »).
    const folder = summary.folderPaths?.[0]
    pathLabel.textContent = folder ? `../${baseName(folder)}` : ''
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
    if (st.state === 'live') endReopen()
    paintCallout()
  }

  /**
   * Un seul callout à la fois, par priorité : état du poste (appairage, hors
   * ligne) > réouverture > erreur d'agent > erreur de commande > état du thread.
   * Les erreurs priment sur les infos de thread : retour direct de l'envoi.
   */
  function paintCallout() {
    const m = store.machineOf(key)
    let spec = null
    let notice = null
    if (m.status === 'locked') spec = { severity: 'error', title: tr`Appairage requis`, desc: tr`${m.label} doit être appairé depuis la liste des threads.` }
    else if (m.status !== 'online') spec = { severity: 'error', title: tr`${m.label} hors ligne`, desc: m.error || tr`Reconnexion automatique.` }
    else if (reopening !== null) spec = { severity: 'info', title: tr`Zed rouvre le thread…`, spinner: true }
    else if (st.agentError) spec = agentErrorSpec(st.agentError)
    else if (cmdError) spec = commandErrorSpec(cmdError)
    else if (st.historyError) spec = historyErrorSpec()
    else if ((notice = lastNotice())) spec = noticeSpec(notice)
    else if (st.historyPending) spec = { severity: 'info', title: tr`Chargement de l'historique (session/load)…`, spinner: true }
    else if (store.foreignAgent(key)) spec = { severity: 'info', title: tr`Lecture seule`, desc: tr`Thread créé hors ZRA — répondre dans Zed.` }
    else if (st.state === 'closed') spec = { severity: 'info', title: tr`Thread fermé`, desc: tr`Ta réponse le rouvrira dans Zed.` }
    else if (st.state === 'unknown') spec = { severity: 'warning', title: tr`Thread sans session`, desc: tr`Lecture et écriture indisponibles.` }
    clear(calloutSlot)
    if (spec) calloutSlot.append(renderCallout(spec))
  }

  /** Dernier avis warn/error non fermé : callout (SessionNotice de Zed), pas une ligne du fil. */
  function lastNotice() {
    const tl = store.ensureTimeline(key)
    for (let i = tl.entries.length - 1; i >= 0; i--) {
      const e = tl.entries[i]
      if (e.type === 'notice' && e.level !== 'info' && !e.dismissed) return e
    }
    return null
  }

  function noticeSpec(entry) {
    return {
      severity: entry.level === 'error' ? 'error' : 'warning',
      title: entry.level === 'error' ? tr`Une erreur est survenue` : tr`Avertissement`,
      desc: entry.text,
      close: () => store.dismissNotice(key, entry.id),
    }
  }

  /** Échec de chargement/relance — render_load_error : retry (recharger), copier, fermer. */
  function historyErrorSpec() {
    const launch = st.historyErrorCode === 'new_thread_failed' || st.historyErrorCode === 'inject_failed'
    return {
      severity: 'error',
      title: launch ? tr`Échec du lancement` : tr`Échec du chargement`,
      desc: st.historyError,
      actions: [{ label: tr`Réessayer`, onclick: () => store.loadHistory(key) }],
      copy: () => copy(st.historyError),
      close: () => store.clearHistoryError(key),
    }
  }

  /** Erreur d'agent — render_any_thread_error : titre, description markdown,
   * retry si le prompt est connu, copier, fermer. Comme Zed, que du texte :
   * `-32603` avec `data = { details }` → le texte `details` devient le message
   * (`agent_servers/src/acp/v1.rs`, prompt) ; sinon le message, plus `data`
   * en texte si c'est une string. Pas de bloc JSON (Zed n'en rend pas). */
  function agentErrorSpec(err) {
    let desc = err.message || tr`Erreur inconnue.`
    const data = err.data
    if (err.code === -32603 && data && typeof data.details === 'string' && Object.keys(data).length === 1) {
      desc = data.details
    } else if (typeof data === 'string') {
      desc += `\n\n${data}`
    }
    const canRetry = Boolean(err.prompt)
    return {
      severity: 'error', title: tr`Une erreur est survenue`, desc, markdown: true,
      actions: canRetry ? [{ label: tr`Réessayer`, onclick: () => store.retryAgentError(key) }] : [],
      copy: () => copy(desc),
      close: () => store.dismissAgentError(key),
    }
  }

  /** Erreur de validation des commandes — render_any_thread_error : titre, description, copier + fermer. */
  function commandErrorSpec(err) {
    const agent = agentLabel(st.summary?.agentId)
    const list = err.available.length ? err.available.join(', ') : tr`Aucune`
    const msg = [
      tr`/${err.command} n'est pas une commande reconnue de ${agent}. Les messages commençant par / sont interprétés comme des commandes.`,
      tr`Pour envoyer un message et non lancer une commande, précédez le / d'un espace.`,
      tr`Commandes disponibles pour ${agent} : ${list}`,
    ].join('\n\n')
    return {
      severity: 'error', title: tr`Une erreur est survenue`, desc: msg,
      copy: () => copy(msg),
      close: () => { cmdError = null; paintCallout() },
    }
  }

  /**
   * Comme dans Zed, le sélecteur porte la valeur, sans icône ; sur un écran
   * étroit, l'icône remplace la valeur (CSS `.pill__icon` / `.pill__label`).
   */
  function setPill(btn, iconName, label, enabled) {
    clear(btn)
    btn.title = label
    btn.append(icon(iconName, 'icon--sm pill__icon'), h('span.truncate.pill__label', { text: label }), icon('chevron-down', 'icon--xs'))
    // On ne présume ni d'un mode ni d'un modèle : sans sélecteur annoncé par
    // l'agent (pi n'a pas de mode ; thread fermé, rien d'annoncé), pas de pastille.
    btn.classList.toggle('hidden', !enabled)
  }

  function optionMenu(ev, kind) {
    const list = kind === 'mode' ? st.modes : st.models
    const currentId = kind === 'mode' ? st.currentModeId : st.currentModelId
    if (!list?.length) return
    openMenu(ev.currentTarget, {
      label: kind === 'mode' ? tr`Mode` : tr`Modèle`,
      items: list.map((o) => ({
        label: o.name || o.id,
        on: o.id === currentId,
        onSelect: () => choose(kind, o.id),
      })),
    })
  }

  function choose(optKey, value) {
    if (st.turn === 'busy') toast(tr`Changement appliqué après le tour en cours.`, { level: 'warn' })
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
        title: tr`Autres réglages`, 'aria-label': tr`Autres réglages`, onclick: moreMenu,
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
      icon('chevron-down', 'icon--xs'))
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

  // ---- défilement ----

  function scrollToEnd(force = false) {
    if (!stick && !force) return
    feed.scrollTop = feed.scrollHeight
  }

  const syncActivitySoon = rafBatch(() => syncActivity())
  let lastTop = 0
  // Le geste utilisateur coupe le suivi dès l'entrée, avant la frame qui
  // suivrait le bas : l'événement `scroll` arrive trop tard (les rAF du stream
  // passent avant lui dans la frame) et le pouce se ferait ramener en bas.
  // Molette vers le haut, ou doigt qui descend (= on remonte le fil).
  const cutStick = () => { stick = false; jump.classList.remove('hidden') }
  feed.addEventListener('wheel', (ev) => { if (ev.deltaY < 0) cutStick() }, { passive: true })
  let touchY = null
  feed.addEventListener('touchstart', (ev) => { touchY = ev.touches[0]?.clientY ?? null }, { passive: true })
  feed.addEventListener('touchmove', (ev) => {
    const y = ev.touches[0]?.clientY
    if (touchY !== null && y > touchY + 2) cutStick()
    touchY = y
  }, { passive: true })
  feed.addEventListener('scroll', () => {
    const top = feed.scrollTop
    const max = feed.scrollHeight - feed.clientHeight
    // L'utilisateur remonte, même d'un pixel : le suivi s'arrête aussitôt,
    // sans attendre de sortir de la fenêtre du bas — sinon un chunk qui arrive
    // pendant le geste ramène en bas et « coince » le pouce (tail-following
    // de Zed : ListState s'arrête au premier scroll vers le haut).
    // Un clamp de mise en page (le composer grandit, le fil rétrécit) atterrit
    // exactement en bas : ce n'est pas un geste utilisateur, on ne coupe pas.
    if (top < lastTop - 1 && top < max) stick = false
    // Il redescend tout en bas : le suivi reprend. Notre propre autoscroll
    // ne va que vers le bas : il ne coupe jamais le suivi par erreur.
    if (max - top < 60 && top > lastTop) stick = true
    lastTop = top
    jump.classList.toggle('hidden', stick)
    // La permission en attente rejoint la barre quand sa carte sort de la vue.
    if (store.ensureTimeline(key).pendingPermissions().length) syncActivitySoon()
  })

  const offs = [
    // Jeu d'icônes changé : les puces de mention du fil se repeignent.
    (() => { let last = settings.iconSet; return onSettings((s) => { if (s.iconSet !== last) { last = s.iconSet; paintAll() } }) })(),
    // Réflexions/outils changés dans les réglages globaux : le nouveau défaut
    // des réflexions efface les choix un à un, puis le fil se repeint.
    (() => {
      let lastThoughts = settings.alwaysShowThoughts, lastTools = settings.expandTools
      return onSettings((s) => {
        if (s.alwaysShowThoughts === lastThoughts && s.expandTools === lastTools) return
        if (s.alwaysShowThoughts !== lastThoughts) {
          lastThoughts = s.alwaysShowThoughts
          for (const entry of store.ensureTimeline(key).entries) if (entry.type === 'thought') delete entry.open
        }
        lastTools = s.expandTools
        paintAll()
      })
    })(),
    store.on(`timeline:${key}`, onTimeline),
    store.on(`state:${key}`, onState),
    // Écriture abandonnée après une coupure : le texte revient dans le champ.
    store.on(`draft:${key}`, () => composer.refreshDraft()),
    store.on('machines', () => { syncHeader(); repaintPermissions() }),
    store.on('threads', () => {
      syncHeader(); composer.sync(st)
      // Thread supprimé (ici ou depuis un autre appareil) : retour à la liste.
      const m = store.machineOf(key)
      if (hadThread && m && !m.threads.some((t) => t.threadId === store.splitKey(key).threadId)) navigate('#/')
    }),
    // Zed n'a pas rouvert le thread : le bandeau d'attente s'efface, le toast d'erreur dit pourquoi.
    store.on('error', (e) => { if (e.threadId === store.splitKey(key).threadId && e.machineId === store.splitKey(key).machineId) endReopen() }),
  ]

  paintAll()
  syncMeta()
  composer.sync(st)
  // Focus d'office sur desktop seulement : sur mobile, il ferait surgir le
  // clavier alors qu'on ouvre souvent un thread juste pour le lire.
  if (window.matchMedia?.('(hover: hover) and (pointer: fine)').matches) setTimeout(() => composer.focus(), 60)

  return {
    el,
    // Timeline déjà en mémoire (retour sur le thread) : le premier rendu a eu
    // lieu hors du document, son défilement n'a rien fait.
    mounted() { scrollToEnd(true) },
    destroy() {
      offs.forEach((off) => off())
      clearInterval(turnTimer)
      clearTimeout(reopenTimer)
      bottombar.destroy()
      composer.destroy()
      store.closeThread(key)
    },
  }
}

function preserveOpen(oldNode, newNode) {
  const oldOpen = [...oldNode.querySelectorAll('.is-open')].map((n) => n.className)
  if (!oldOpen.length) return
  const targets = newNode.querySelectorAll('.raw, .tool, .raw-input')
  const olds = oldNode.querySelectorAll('.raw, .tool, .raw-input')
  targets.forEach((t, i) => { if (olds[i]?.classList.contains('is-open')) t.classList.add('is-open') })
}

function copy(text) {
  navigator.clipboard?.writeText(text).then(
    () => toast(tr`Copié`),
    () => toast(tr`Copie impossible.`, { level: 'error' }),
  )
}

// ---- composer ----

/**
 * Dictée par la Web Speech API — **en réserve, branchée nulle part**. Le bouton
 * micro a été retiré : `SpeechRecognition` n'existe qu'en contexte sécurisé, et
 * sur le réseau local en `http://` il ne donnait qu'une erreur. La dictée du
 * clavier du téléphone fait le travail. À rebrancher sur un bouton du composer
 * (en HTTPS) si on la veut de nouveau.
 *
 * @param {HTMLTextAreaElement} input
 * @param {{ onChange?:()=>void, onActive?:(on:boolean)=>void }} [hooks]
 */
export function dictate(input, { onChange, onActive } = {}) {
  const Rec = window.SpeechRecognition || window.webkitSpeechRecognition
  if (!Rec) {
    input.focus()
    toast(tr`Utilise le micro du clavier de ton téléphone.`, { level: 'warn' })
    return
  }
  const rec = new Rec()
  rec.lang = locale
  rec.interimResults = true
  rec.continuous = false
  const base = input.value
  onActive?.(true)
  rec.onresult = (ev) => {
    let text = ''
    for (const r of ev.results) text += r[0].transcript
    input.value = base ? `${base} ${text}` : text
    onChange?.()
  }
  rec.onend = () => onActive?.(false)
  rec.onerror = () => { onActive?.(false); toast(tr`Dictée indisponible.`, { level: 'error' }) }
  rec.start()
}

/**
 * Zone de saisie de Zed (`render_message_editor`) : fond editor_background,
 * éditeur police buffer 12 (4 lignes min), barre dessous — à gauche « + »
 * (ajout de contexte, désactivé : pas d'envoi de fichier depuis ZRA), à droite
 * jauge de tokens, sélecteurs, stop et envoi. Pas de « follow agent » (Zed ne
 * peut pas nous montrer le fichier que l'agent modifie).
 */
function Composer({ key, agentName, selectors, onSend, onStop, getCommands = () => [], calloutSlot, onCommandError }) {
  // Contenteditable (D2) avec façade textarea (editor.js) : brouillon texte,
  // offsets de sélection, collage texte brut ; le hint et l'ancrage au caret
  // du menu deviennent possibles. Les puces de mention arrivent en 5b-2.
  const input = editable(h('div.composer__input', {
    contenteditable: 'true',
    role: 'textbox',
    'aria-multiline': 'true',
    enterkeyhint: 'send',
    autocapitalize: 'sentences',
    oninput: () => { store.setDraft(key, input.value); syncSend(); onCommandError(null); completion.update() },
    // Entrée envoie ; Maj+Entrée et Ctrl+Entrée sautent une ligne.
    // Pendant une composition (IME, accents morts), Entrée appartient à la saisie.
    // Le menu de complétion, s'il est ouvert, consomme Entrée/Tab/↑↓/Échap.
    onkeydown: (ev) => {
      if (completion.keydown(ev)) return
      if (ev.key !== 'Enter' || ev.isComposing) return
      ev.preventDefault()
      if (ev.shiftKey || ev.ctrlKey || ev.metaKey) input.insertText('\n')
      else send('queue')
    },
    // Filet mobile : si le clavier n'émet pas de keydown Enter exploitable,
    // beforeinput porte le saut de ligne / l'envoi (hors composition IME).
    onbeforeinput: (ev) => {
      if (ev.inputType !== 'insertParagraph' && ev.inputType !== 'insertLineBreak') return
      if (ev.isComposing) return
      ev.preventDefault()
      if (ev.inputType === 'insertLineBreak') input.insertText('\n')
      else if (completion.isOpen()) completion.keydown({ key: 'Enter', preventDefault() {} })
      else send('queue')
    },
    // Déplacement du caret (flèches, clic) : le déclencheur suit la position.
    onkeyup: () => completion.update(),
    onclick: () => completion.update(),
  }))

  const editorBox = h('div.composer__editor', {}, input)
  input.placeholder = tr`Message ${agentName()}…`
  const completion = composerCompletion({ input, getCommands, getFiles: () => store.filesFor(key), onSend: () => send('queue') })
  // Listing des fichiers arrivé (ou rafraîchi) : le menu @ suit.
  const offFiles = store.on(`files:${key}`, () => completion.update())
  let lastCmds = null

  // Ajout de contexte : présent mais désactivé, pas d'envoi de fichier pour l'instant.
  const plusBtn = button('icon-btn icon-btn--sm', {
    disabled: true, title: tr`Ajouter du contexte — pas encore disponible.`, 'aria-label': tr`Ajouter du contexte`,
  }, icon('plus', 'icon--sm'))

  // Envoyer ne change jamais : pendant un tour, le message part en file d'attente.
  // Désactivé quand il n'y a rien à envoyer, comme Zed.
  const sendBtn = button('send-btn', { onclick: () => send('queue'), title: tr`Envoyer (Entrée — Maj+Entrée pour aller à la ligne).`, 'aria-label': tr`Envoyer` },
    icon('send'))
  // Stop n'apparaît que pendant un tour, à gauche d'Envoyer.
  const stopBtn = button('send-btn send-btn--stop hidden', {
    onclick: stop, title: tr`Interrompre le tour (la file attend le prochain envoi).`,
    'aria-label': tr`Interrompre`,
  }, icon('stop', 'icon--sm'))

  // Consommation du contexte : anneau comme Zed, ou « 27k » sans maximum connu.
  const tokens = h('span.tokens.hidden')
  const usageText = h('span.usage.hidden')

  const el = h('div.composer', {},
    h('div.composer__inner', {},
      editorBox,
      h('div.composer__bar', {},
        h('div.composer__left', {}, plusBtn),
        h('div.composer__right', {}, tokens, usageText, ...selectors, stopBtn, sendBtn),
      ),
    ),
  )

  // Le brouillon de ce thread, s'il y en a un.
  input.value = store.getDraft(key)
  syncSend()

  /** Rien à envoyer tant que le champ ne contient que du blanc, ou sur un
   * thread en lecture seule : le bouton est désactivé (`send` refuse déjà). */
  function syncSend() {
    sendBtn.disabled = !input.value.trim() || Boolean(store.foreignAgent(key))
  }

  function send(mode) {
    const text = input.value.trim()
    if (!text) return
    // Validation Zed (validate_slash_commands) : « /commande » inconnue en
    // début de message → refus, callout au-dessus du composer. Le texte brut
    // est validé : un espace devant le / échappe à la règle, comme Zed.
    const err = validateSlash(input.value, getCommands())
    if (err) { onCommandError(err); return }
    onSend(text, mode)
    input.value = ''
    store.setDraft(key, '')
    syncSend()
  }

  // Stop ne touche pas au champ de saisie : ce qui y est écrit y reste.
  function stop() { onStop?.() }

  function sync(st) {
    const busy = st.turn === 'busy'
    stopBtn.classList.toggle('hidden', !busy)
    el.classList.toggle('is-disabled', st.state === 'unknown')

    // Thread d'un agent que ZRA n'enveloppe pas : Zed le rouvrirait sans shim.
    const foreign = store.foreignAgent(key)
    input.disabled = Boolean(foreign)
    syncSend()
    // Le bandeau et le cadenas disent déjà pourquoi : champ grisé, sans texte.
    // Placeholder de Zed (placeholder_text) : « @ to include context » toujours
    // (les mentions sont là), « / for commands » seulement si l'agent publie
    // des commandes.
    const cmds = getCommands()
    input.placeholder = foreign ? ''
      : cmds.length ? tr`Message ${agentName()} — @ pour inclure du contexte, / pour les commandes.`
        : tr`Message ${agentName()} — @ pour inclure du contexte.`
    if (cmds !== lastCmds) { lastCmds = cmds; completion.update() }
  }

  /** @param {{ used:number, size:number|null, cost:object|null } | null} u */
  function setUsage(u) {
    tokens.classList.toggle('hidden', !u?.size)
    usageText.classList.toggle('hidden', !u || Boolean(u?.size))
    if (!u) return
    const ratio = u.size ? u.used / u.size : null
    const cost = formatCost(u.cost)
    const n = (v) => v.toLocaleString(locale)
    const detail = [
      tr`Contexte : ${n(u.used) + (u.size ? ` / ${n(u.size)}` : '')} tokens${ratio !== null ? ` (${Math.round(ratio * 100)} %)` : ''}`,
      cost ? tr`Coût de la session : ${cost}` : null,
    ].filter(Boolean).join('\n')
    if (u.size) {
      // Anneau 16 px, trait 2 : circonférence 2π × 6 ≈ 37.7 ; orange dès 85 %.
      const C = 37.7
      const warn = ratio >= 0.85
      tokens.title = detail
      tokens.innerHTML = `<svg class="ring" viewBox="0 0 16 16" aria-hidden="true"><circle class="bg" cx="8" cy="8" r="6"/><circle class="fg${warn ? ' warn' : ''}" cx="8" cy="8" r="6" stroke-dasharray="${(Math.min(1, ratio) * C).toFixed(1)} ${C}"/></svg>`
    } else {
      usageText.textContent = formatTokens(u.used)
      usageText.title = detail
      usageText.classList.toggle('usage--warn', false)
      usageText.classList.toggle('usage--full', false)
    }
  }

  return { el: h('div.composer-block', {}, calloutSlot, el), sync, setUsage, focus: () => input.focus(), destroy: () => { completion.close(); input.destroy(); offFiles() }, refreshDraft() {
    const d = store.getDraft(key)
    if (input.value !== d) { input.value = d; syncSend(); completion.update() }
  } }
}
