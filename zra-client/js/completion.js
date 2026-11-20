// Complétion des commandes slash du composer — portage de Zed 1.28.1 :
// `completion_provider.rs` (SlashCommandCompletion::try_parse, filtre fuzzy),
// `message_editor.rs` (validate_slash_commands, confirm_command → send).
// Le filtre fuzzy est une approximation sous-séquence, pas l'algorithme de Zed
// (`docs/fr/limitations.md`). Le menu suit `code_context_menus.rs` : items
// inset, en-tête « Commands » masqué quand un argument est saisi, description
// de l'item sélectionné dans un aparté (à droite si la place, sinon au-dessus).

import { h, clear } from './dom.js'
import { icon } from './icons.js'
import { tr } from './i18n.js'

const WS = /\s/

/**
 * Port de `SlashCommandCompletion::try_parse` : la ligne courante, jusqu'au
 * caret. Déclencheur = `/` le plus à droite en frontière de mot (début de
 * ligne ou après un blanc), pas de blanc juste après.
 *
 * Sémantique des **tests** de Zed : un reste uniquement blanc = pas d'argument
 * (`"/help "` → argument nul). Le code v1.28.1 teste `is_empty` avant
 * `trim_end` et produirait `Some("")` — écart documenté (`ISSUES.md`,
 * `docs/fr/zed.md`) ; ZRA suit les tests, seule sémantique qui rende le hint
 * et le garde-fou d'envoi fonctionnels.
 *
 * @param {string} line
 * @returns {{start:number, end:number, command:string|null, argument:string|null}|null}
 */
export function parseSlash(line) {
  let start = -1
  for (let i = line.length - 1; i >= 0; i--) {
    if (line[i] !== '/') continue
    const next = line[i + 1]
    if (next !== undefined && WS.test(next)) continue
    if (i > 0 && !WS.test(line[i - 1])) continue
    start = i
    break
  }
  if (start < 0) return null

  const rest = line.slice(start + 1)
  let command = null
  let argument = null
  const ws = rest.search(WS)
  if (ws >= 0) {
    command = rest.slice(0, ws)
    argument = rest.slice(ws + 1).trimEnd() || null
  } else if (rest) {
    command = rest
  }

  // `source_range` : du `/` à la fin du dernier caractère non blanc.
  let end = line.length
  for (let i = line.length - 1; i >= 0; i--) {
    if (!WS.test(line[i])) { end = i + 1; break }
  }
  return { start, end, command, argument }
}

/**
 * Filtre fuzzy approché : sous-séquence insensible à la casse, bonus de
 * continuité et de début de mot, pénalité d'écart. `null` si pas de match.
 * @returns {{score:number, positions:number[]}|null}
 */
export function fuzzy(query, text) {
  if (!query) return { score: 0, positions: [] }
  const q = query.toLowerCase()
  const t = text.toLowerCase()
  const positions = []
  let ti = 0
  let prev = -2
  let score = 0
  for (const c of q) {
    const at = t.indexOf(c, ti)
    if (at < 0) return null
    positions.push(at)
    score += 1
    if (at === prev + 1) score += 3
    if (at === 0 || /[\s/_.:-]/.test(t[at - 1])) score += 2
    score -= (at - ti) * 0.1
    prev = at
    ti = at + 1
  }
  return { score, positions }
}

/**
 * Candidats slash : filtre fuzzy sur le nom, ordre de pertinence (stable à
 * score égal — l'ordre de l'agent départage, comme Zed).
 * @param {Array<{name:string, description?:string, input?:{hint?:string}}>} commands
 */
export function slashCandidates(commands, query) {
  const out = []
  for (const cmd of commands) {
    const match = fuzzy(query, cmd.name)
    if (match) out.push({ cmd, match })
  }
  out.sort((a, b) => b.match.score - a.match.score)
  return out
}

/**
 * Port de `validate_slash_commands` : un message qui commence par `/` (position
 * 0) avec une commande inconnue est refusé — liste vide comprise (« none »).
 * Un espace devant le `/` échappe à la validation, comme Zed.
 * @returns {{command:string, available:string[]}|null} l'erreur, ou null si valide
 */
export function validateSlash(text, commands) {
  const p = parseSlash(text)
  if (!p || p.start !== 0 || !p.command) return null
  if (commands.some((c) => c.name === p.command)) return null
  return { command: p.command, available: commands.map((c) => `/${c.name}`) }
}

/** La commande attend un argument (`input.hint` présent) — `requires_argument` de Zed. */
export const requiresArgument = (cmd) => Boolean(cmd?.input?.hint)

/**
 * Port de `command_hint` (message_editor.rs) : le hint s'affiche quand le
 * texte (entier, comme Zed) parse en commande connue sans argument. Position
 * = fin du dernier non-blanc + 1 ; au-delà du texte, on clamp et on préfixe
 * le libellé d'une espace (le hint la « remplace » visuellement).
 * @returns {{pos:number, label:string}|null}
 */
export function commandHint(text, commands) {
  if (!commands.length) return null
  const p = parseSlash(text)
  if (!p || p.argument !== null || !p.command) return null
  const cmd = commands.find((c) => c.name === p.command)
  const hint = cmd?.input?.hint
  if (!hint) return null
  let pos = p.end + 1
  let label = hint
  if (pos > text.length) { pos = text.length; label = ` ${hint}` }
  return { pos, label }
}

/**
 * Menu de complétion slash, ancré au caret (au-dessus, le composer est en
 * bas — `layout_context_menu_aside`). Reste ouvert pendant la frappe ;
 * Entrée/Tab confirment, ↑↓ déplacent la sélection, Échap ferme. Confirmer
 * **envoie** (confirm_command → send), sauf si la commande attend un argument
 * non saisi : insertion « /name » + espace, avec le hint en span fantôme.
 *
 * @param {{input:HTMLElement, getCommands:()=>Array<object>, onSend:()=>void}} opts
 */
export function slashCompletion({ input, getCommands, onSend }) {
  let wrap = null
  let menu = null
  let aside = null
  let items = []
  let selected = 0
  let parsed = null
  let lineStart = 0
  let lastQuery = null

  const isOpen = () => Boolean(wrap)

  function close() {
    if (!wrap) return
    wrap.remove()
    wrap = menu = aside = null
    items = []
    document.removeEventListener('pointerdown', onDown, true)
  }

  function onDown(ev) {
    if (wrap && !wrap.contains(ev.target)) close()
  }

  /** Ligne courante jusqu'au caret, et position de son début dans la valeur. */
  function lineAtCaret() {
    const caret = input.selectionStart ?? input.value.length
    const start = input.value.lastIndexOf('\n', caret - 1) + 1
    return { line: input.value.slice(start, caret), start }
  }

  function update() {
    const commands = getCommands()
    // Hint d'argument (command_hint) : indépendant du menu, mis à jour à
    // chaque édition — span fantôme hors du texte, caret conservé.
    const hint = commandHint(input.value, commands)
    input.setHint(hint?.label ?? null, hint?.pos ?? 0)
    const { line, start } = lineAtCaret()
    lineStart = start
    parsed = parseSlash(line)
    if (!parsed || !commands.length) { close(); return }
    // Le menu ferme dès qu'un blanc suit la commande (zone d'argument),
    // comme Zed.
    const after = line[parsed.start + 1 + (parsed.command?.length ?? 0)]
    if (parsed.command && after !== undefined && WS.test(after)) { close(); return }
    const query = parsed.command ?? ''
    items = slashCandidates(commands, query)
    if (!items.length) { close(); return }
    // La sélection ↑↓ survit aux updates (keyup/clic rappellent update) tant
    // que la requête ne change pas ; nouvelle requête → meilleur item.
    selected = isOpen() && query === lastQuery ? Math.min(selected, items.length - 1) : 0
    lastQuery = query
    render()
  }

  function label(cmd, positions) {
    const span = h('span.truncate')
    let last = 0
    for (const at of positions) {
      if (at > last) span.append(cmd.name.slice(last, at))
      span.append(h('b.match', { text: cmd.name[at] }))
      last = at + 1
    }
    if (last < cmd.name.length) span.append(cmd.name.slice(last))
    return span
  }

  function render() {
    if (!wrap) {
      wrap = h('div.completion-wrap')
      menu = h('div.menu.completion', { role: 'listbox', 'aria-label': tr`commandes de l'agent` })
      aside = h('div.completion-aside')
      wrap.append(menu, aside)
      // Le clic sur un item ne doit pas voler le focus du champ.
      wrap.addEventListener('pointerdown', (ev) => ev.preventDefault())
      document.getElementById('overlays').append(wrap)
      document.addEventListener('pointerdown', onDown, true)
    }
    clear(menu)
    // En-tête de groupe : masqué dès qu'un argument est saisi (Zed).
    if (parsed.argument === null) menu.append(h('div.menu__label', { text: tr`Commandes` }))
    items.forEach(({ cmd, match }, i) => {
      const item = h('button.menu__item', {
        role: 'option',
        'aria-selected': i === selected ? 'true' : 'false',
        class: i === selected ? 'menu__item--on' : '',
        onclick: () => confirm(i),
      },
        cmd.name === 'compact' ? icon('compact', 'icon--sm') : null,
        label(cmd, match.positions),
      )
      menu.append(item)
    })
    paintAside()
    place()
  }

  function paintAside() {
    const desc = items[selected]?.cmd.description
    clear(aside)
    aside.classList.toggle('hidden', !desc)
    if (desc) aside.append(h('div.completion-aside__body', { text: desc }))
  }

  /** Au-dessus du caret ; aparté à droite si ≥ 260 px, sinon au-dessus du menu. */
  function place() {
    const r = input.caretRect()
    menu.style.left = '0px'
    menu.style.top = '0px'
    const mw = menu.offsetWidth
    const mh = menu.offsetHeight
    const left = Math.min(Math.max(8, r.left), window.innerWidth - mw - 8)
    let top = r.top - mh - 4
    if (top < 8) top = Math.min(r.bottom + 4, window.innerHeight - mh - 8)
    menu.style.left = `${left}px`
    menu.style.top = `${top}px`

    if (aside.classList.contains('hidden')) return
    const ah = aside.offsetHeight
    const rightRoom = window.innerWidth - (left + mw + 4) - 8
    if (rightRoom >= 260) {
      aside.style.width = `${Math.min(500, rightRoom)}px`
      aside.style.left = `${left + mw + 4}px`
      aside.style.top = `${top}px`
    } else {
      aside.style.width = `${mw}px`
      aside.style.left = `${left}px`
      let at = top - ah - 4
      if (at < 8) at = Math.min(top + mh + 4, window.innerHeight - ah - 8)
      aside.style.top = `${at}px`
    }
  }

  function move(d) {
    selected = (selected + d + items.length) % items.length
    render()
  }

  function confirm(i) {
    const { cmd } = items[i]
    const { line, start } = lineAtCaret()
    const p = parseSlash(line)
    if (!p) { close(); return }
    const a = start + p.start
    const b = start + p.end
    // new_text de Zed : l'argument déjà tapé est conservé (replace_range
    // couvre toute la plage source, new_text le réinsère).
    const insert = p.argument !== null ? `/${cmd.name} ${p.argument}` : `/${cmd.name} `
    input.value = input.value.slice(0, a) + insert + input.value.slice(b)
    input.selectionStart = input.selectionEnd = a + insert.length
    const send = !requiresArgument(cmd) || p.argument !== null
    input.dispatchEvent(new Event('input', { bubbles: true }))
    close()
    if (send) onSend()
  }

  /** @returns {boolean} true si la touche a été consommée par le menu. */
  function keydown(ev) {
    if (!isOpen()) return false
    if (ev.key === 'ArrowDown') { ev.preventDefault(); move(1); return true }
    if (ev.key === 'ArrowUp') { ev.preventDefault(); move(-1); return true }
    if (ev.key === 'Enter' || ev.key === 'Tab') { ev.preventDefault(); confirm(selected); return true }
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); close(); return true }
    return false
  }

  return { update, close, isOpen, keydown }
}
