// Composer contenteditable (conception 0.5.2, D2) — façade « façon textarea »
// sur un div contenteditable : `value`, `selectionStart/End` en offsets texte,
// `disabled`, `placeholder`, `insertText`, `caretRect`, `setHint`.
//
// Modèle DOM : nœuds texte + <br> pour les sauts de ligne (white-space:
// pre-wrap côté CSS). Un <br> final unique est un placeholder de rendu (la
// ligne vide qu'il permet d'afficher), pas du contenu : la sérialisation
// l'ignore. Le hint d'argument est un span fantôme `composer__hint`
// (contenteditable=false), exclu du texte. Les mentions sont des puces
// `mention` (contenteditable=false, data-name/data-uri), atomiques, sérialisées
// [@nom](uri) (D3) — le round-trip brouillon texte ↔ puces est gratuit.
//
// Les blocs que le navigateur peut créer (div/p selon l'IME) sont aplatis en
// texte + <br> à la normalisation ; le collage est sanitise en texte brut.

import { parseMentionLinks, mentionLink } from './mentions.js'
import { icon } from './icons.js'

const HINT = 'composer__hint'
const BLOCKS = /^(DIV|P|LI|UL|OL|H[1-6]|BLOCKQUOTE|PRE|SECTION|ARTICLE|TABLE|TR)$/

const isHint = (n) => n.nodeType === 1 && n.classList.contains(HINT)
const isChip = (n) => n.nodeType === 1 && n.classList.contains('mention')
const indexOf = (n) => Array.prototype.indexOf.call(n.parentNode.childNodes, n)

/**
 * Parcours du DOM en unités de texte (1 caractère = 1 unité), avec les
 * frontières de blocs et le <br> placeholder exclus. Sert à la fois de
 * sérialiseur et de carte offsets texte ↔ positions DOM.
 */
function scan(el) {
  const units = []
  let len = 0
  const nodeStart = new Map()  // nœud → offset texte à son entrée
  const childStart = new Map() // enfant direct de el → offset texte
  const hints = []             // spans fantômes, avec leur offset
  const push = (ch, node, i, extra) => { units.push({ ch, node, i, ...extra }); len += ch.length }
  const walk = (n) => {
    if (n.nodeType === 3) {
      nodeStart.set(n, len)
      for (let i = 0; i < n.data.length; i++) push(n.data[i], n, i)
      return
    }
    if (n.nodeType !== 1) return
    if (isHint(n)) { hints.push({ node: n, offset: len }); return }
    nodeStart.set(n, len)
    if (isChip(n)) {
      // Puce atomique : une unité de la longueur de sa sérialisation D3.
      push(mentionLink(n.dataset.name ?? '', n.dataset.uri ?? ''), n, 0, { atomic: true })
      return
    }
    if (n.nodeName === 'BR') { push('\n', n, 0, { br: true }); return }
    if (BLOCKS.test(n.nodeName) && len && units[units.length - 1].ch !== '\n') {
      push('\n', n, 0, { virtual: true })
    }
    for (const c of n.childNodes) walk(c)
  }
  for (const c of el.childNodes) { childStart.set(c, len); walk(c) }
  // <br> final unique (sans hint derrière) = placeholder de rendu.
  let last = el.lastChild
  while (last && isHint(last)) last = last.previousSibling
  if (last?.nodeName === 'BR' && el.lastChild === last) {
    if (units.length && units[units.length - 1].br) len -= units.pop().ch.length
  } else if (last && last.nodeType === 1 && BLOCKS.test(last.nodeName) && last.textContent === '') {
    // <div><br></div> final : le div placeholder de Chrome.
    if (units.length && units[units.length - 1].ch === '\n') len -= units.pop().ch.length
  }
  return { units, nodeStart, childStart, hints, text: units.map((u) => u.ch).join('') }
}

/** Position DOM pour un offset texte — devant le hint s'il est à cet offset,
 * devant la puce si l'offset tombe dedans (elle est atomique). */
function locate(el, s, offset) {
  for (const hint of s.hints) {
    if (hint.offset === offset) return { node: el, offset: indexOf(hint.node) }
  }
  let cum = 0
  for (const u of s.units) {
    if (offset < cum + u.ch.length) {
      if (u.atomic || u.br || u.virtual) return { node: u.node.parentNode, offset: indexOf(u.node) }
      return { node: u.node, offset: u.i + (offset - cum) }
    }
    cum += u.ch.length
  }
  const last = s.units[s.units.length - 1]
  if (!last) return { node: el, offset: 0 }
  if (last.atomic || last.br || last.virtual) return { node: last.node.parentNode, offset: indexOf(last.node) + 1 }
  return { node: last.node, offset: last.i + 1 }
}

/** Offset texte d'une position DOM (nœud, offset), ou null si hors carte. */
function offsetOf(el, s, node, off) {
  if (node === el) {
    const child = el.childNodes[off]
    return child ? s.childStart.get(child) ?? s.text.length : s.text.length
  }
  if (node.nodeType === 3) {
    const st = s.nodeStart.get(node)
    return st == null ? null : st + off
  }
  if (node.nodeType !== 1) return null
  const hint = node.closest(`.${HINT}`)
  if (hint && el.contains(hint)) return s.childStart.get(hint) ?? null
  const chip = node.closest('.mention')
  if (chip && el.contains(chip)) return s.nodeStart.get(chip) ?? null
  const st = s.nodeStart.get(node)
  if (st == null) return null
  if (node.nodeName === 'BR' || off === 0) return st
  // Élément (bloc transitoire) : offset à l'intérieur = caractères descendants.
  let n = 0
  for (const u of s.units) if (node.contains(u.node)) n += u.ch.length
  return st + Math.min(off, n)
}

/**
 * Rend un div contenteditable « façon textarea ». Les propriétés `value`,
 * `selectionStart`, `selectionEnd`, `disabled`, `placeholder` sont définies
 * sur l'élément ; le code existant (brouillon, complétion, tests) continue
 * de le manipuler comme un textarea. `insertText` émet `input`.
 * @param {HTMLElement} el
 */
export function editable(el) {
  const doc = el.ownerDocument
  const getSel = () => doc.getSelection?.()
  let saved = { a: 0, b: 0 }
  let composing = false

  const isFocused = () => {
    const sel = getSel()
    return doc.activeElement === el || Boolean(sel?.rangeCount && el.contains(sel.anchorNode))
  }

  /** Puce de mention (D3) : icône + nom, non éditable, data-name/data-uri. */
  function chipEl(name, uri) {
    const span = doc.createElement('span')
    span.className = 'mention'
    span.contentEditable = 'false'
    span.dataset.name = name
    span.dataset.uri = uri
    const label = doc.createElement('span')
    label.className = 'mention__name'
    label.textContent = name
    span.append(icon(/\/$/.test(uri) ? 'folder' : 'file-text', 'icon--sm'), label)
    return span
  }

  /** Texte brut → nœuds texte + <br> ; liens de mention → puces (D3). */
  function appendRich(parent, text) {
    const links = parseMentionLinks(text)
    const pushPlain = (t) => {
      t.split('\n').forEach((p, i) => {
        if (i) parent.append(doc.createElement('br'))
        if (p) parent.append(doc.createTextNode(p))
      })
    }
    let last = 0
    for (const l of links) {
      pushPlain(text.slice(last, l.start))
      parent.append(chipEl(l.name, l.uri))
      last = l.end
    }
    pushPlain(text.slice(last))
  }

  function rebuild(text) {
    while (el.firstChild) el.firstChild.remove()
    appendRich(el, text)
    // La ligne vide finale a besoin d'un <br> de rendu (ignoré au scan).
    if (text.endsWith('\n')) el.append(doc.createElement('br'))
  }

  function applySelection() {
    if (!isFocused()) return
    const s = scan(el)
    const clamp = (v) => Math.max(0, Math.min(v, s.text.length))
    const a = locate(el, s, clamp(saved.a))
    const b = locate(el, s, clamp(saved.b))
    const r = doc.createRange()
    r.setStart(a.node, a.offset)
    r.setEnd(b.node, b.offset)
    const sel = getSel()
    sel.removeAllRanges()
    sel.addRange(r)
  }

  /** Aplatit les blocs du navigateur ; vide le DOM quand le texte est vide
   * (le placeholder CSS :empty doit pouvoir s'afficher) ; retire les nœuds
   * texte vides (restes de splitText / insertNode). */
  function normalize() {
    const s = scan(el)
    const foreign = [...el.childNodes].some((n) => n.nodeType === 1 && n.nodeName !== 'BR' && !isHint(n) && !isChip(n))
    if (!foreign) {
      if (s.text === '' && el.childNodes.length) {
        while (el.firstChild) el.firstChild.remove()
        saved = { a: 0, b: 0 }
        return
      }
      const empties = [...el.childNodes].filter((n) => n.nodeType === 3 && n.data === '')
      if (empties.length) {
        const focused = isFocused()
        const a = el.selectionStart
        const b = el.selectionEnd
        for (const n of empties) n.remove()
        if (focused) { saved = { a, b }; applySelection() }
      }
      return
    }
    const a = offsetOf(el, s, getSel()?.anchorNode ?? el, getSel()?.anchorOffset ?? 0) ?? s.text.length
    const b = offsetOf(el, s, getSel()?.focusNode ?? el, getSel()?.focusOffset ?? 0) ?? a
    rebuild(s.text)
    saved = { a: Math.min(a, s.text.length), b: Math.min(b, s.text.length) }
    applySelection()
  }

  function insertText(text) {
    if (!text) return
    normalize()
    const v = scan(el).text
    const a = el.selectionStart
    const b = el.selectionEnd
    const s = scan(el)
    const pa = locate(el, s, a)
    const pb = locate(el, s, b)
    // Un <br> placeholder suit-il déjà le point d'insertion ? (sinon il faut
    // en ajouter un pour rendre la ligne vide finale — pas deux).
    const hadPlaceholder = pb.node === el && el.childNodes[pb.offset]?.nodeName === 'BR'
    const r = doc.createRange()
    r.setStart(pa.node, pa.offset)
    r.setEnd(pb.node, pb.offset)
    r.deleteContents()
    const frag = doc.createDocumentFragment()
    appendRich(frag, text)
    r.insertNode(frag)
    if (b >= v.length && text.endsWith('\n') && !hadPlaceholder) el.append(doc.createElement('br'))
    saved = { a: a + text.length, b: a + text.length }
    applySelection()
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }

  /** Rect du caret (ancrage du menu de complétion) ; repli : l'éditeur. */
  function caretRect() {
    const sel = getSel()
    if (sel?.rangeCount && el.contains(sel.anchorNode)) {
      const r = sel.getRangeAt(0).cloneRange()
      r.collapse(true)
      const rects = r.getClientRects()
      if (rects.length && (rects[0].height || rects[0].top)) return rects[0]
      // Range collapsed sans rect (frontière d'élément) : marqueur temporaire.
      const a = el.selectionStart
      const b = el.selectionEnd
      const marker = doc.createElement('span')
      marker.textContent = '\u200b'
      r.insertNode(marker)
      const rect = marker.getBoundingClientRect()
      marker.remove()
      saved = { a, b }
      applySelection()
      if (rect.height || rect.top) return rect
    }
    return el.getBoundingClientRect()
  }

  /** Hint fantôme (span non éditable, exclu du texte), à l'offset donné.
   * Le caret est conservé ; s'il est à l'offset du hint, il reste devant. */
  function setHint(label, offset) {
    normalize()
    const existing = el.querySelector(`.${HINT}`)
    if (!existing && label == null) return
    if (existing) {
      const s = scan(el)
      if (label != null && existing.textContent === label && s.childStart.get(existing) === offset) return
      const a = el.selectionStart
      const b = el.selectionEnd
      existing.remove()
      saved = { a, b }
    }
    if (label != null) {
      const s = scan(el)
      const pos = locate(el, s, Math.min(offset, s.text.length))
      const span = doc.createElement('span')
      span.className = HINT
      span.contentEditable = 'false'
      span.textContent = label
      if (pos.node === el) el.insertBefore(span, el.childNodes[pos.offset] ?? null)
      else if (pos.node.nodeType === 3) {
        const rest = pos.node.splitText(pos.offset)
        rest.parentNode.insertBefore(span, rest)
      } else pos.node.parentNode.insertBefore(span, pos.node)
    }
    applySelection()
  }

  // Collage : texte brut uniquement (pas de HTML, pas d'images).
  el.addEventListener('paste', (ev) => {
    ev.preventDefault()
    const text = ev.clipboardData?.getData('text/plain') ?? ''
    if (text) insertText(text)
  })

  el.addEventListener('compositionstart', () => { composing = true })
  el.addEventListener('compositionend', () => { composing = false; normalize() })
  el.addEventListener('input', () => normalize())

  // Suppression vers l'avant à l'offset du hint : le navigateur mangerait le
  // span fantôme (atomique) au lieu du caractère — on supprime le caractère.
  el.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Delete') return
    const hint = el.querySelector(`.${HINT}`)
    const sel = getSel()
    if (!hint || !sel?.isCollapsed || !el.contains(sel.anchorNode)) return
    const s = scan(el)
    const off = offsetOf(el, s, sel.anchorNode, sel.anchorOffset)
    const hoff = s.childStart.get(hint)
    if (off !== hoff || hoff >= s.text.length) return
    ev.preventDefault()
    rebuild(s.text.slice(0, hoff) + s.text.slice(hoff + 1))
    saved = { a: hoff, b: hoff }
    applySelection()
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })

  // Le caret ne reste jamais derrière le hint à son offset : il n'est pas
  // dans le texte (comme l'inlay de Zed), on le ramène devant.
  function onSelChange() {
    if (composing || !el.isConnected) return
    const sel = getSel()
    if (!sel?.rangeCount || !el.contains(sel.anchorNode)) return
    const s = scan(el)
    const a = offsetOf(el, s, sel.anchorNode, sel.anchorOffset)
    const b = offsetOf(el, s, sel.focusNode, sel.focusOffset)
    if (a != null) saved.a = a
    if (b != null) saved.b = b
    const hint = el.querySelector(`.${HINT}`)
    if (!hint || !sel.isCollapsed || a !== s.childStart.get(hint)) return
    const idx = indexOf(hint)
    const after = sel.anchorNode === hint
      || (sel.anchorNode === el && sel.anchorOffset === idx + 1)
      || (sel.anchorNode === hint.nextSibling && sel.anchorOffset === 0)
    if (after) applySelection()
  }
  doc.addEventListener('selectionchange', onSelChange)

  Object.defineProperties(el, {
    value: {
      get: () => scan(el).text,
      set(v) {
        const text = String(v ?? '')
        rebuild(text)
        saved = { a: text.length, b: text.length }
        applySelection()
      },
    },
    selectionStart: {
      get() {
        const sel = getSel()
        if (sel?.rangeCount && el.contains(sel.anchorNode)) {
          const off = offsetOf(el, scan(el), sel.anchorNode, sel.anchorOffset)
          if (off != null) saved.a = off
        }
        return saved.a
      },
      set(v) {
        saved.a = Math.max(0, Number(v) || 0)
        if (saved.b < saved.a) saved.b = saved.a
        applySelection()
      },
    },
    selectionEnd: {
      get() {
        const sel = getSel()
        if (sel?.rangeCount && el.contains(sel.anchorNode)) {
          const off = offsetOf(el, scan(el), sel.focusNode, sel.focusOffset)
          if (off != null) saved.b = off
        }
        return saved.b
      },
      set(v) {
        saved.b = Math.max(0, Number(v) || 0)
        if (saved.a > saved.b) saved.a = saved.b
        applySelection()
      },
    },
    disabled: {
      get: () => el.getAttribute('contenteditable') === 'false',
      set(v) {
        el.setAttribute('contenteditable', v ? 'false' : 'true')
        el.setAttribute('aria-disabled', v ? 'true' : 'false')
      },
    },
    placeholder: {
      get: () => el.dataset.placeholder ?? '',
      set(v) {
        el.dataset.placeholder = v ?? ''
        if (v) el.setAttribute('aria-label', v)
        else el.removeAttribute('aria-label')
      },
    },
  })

  el.insertText = insertText
  el.caretRect = caretRect
  el.setHint = setHint
  el.destroy = () => doc.removeEventListener('selectionchange', onSelChange)
  return el
}
