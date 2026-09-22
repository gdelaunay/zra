// Micro-helpers DOM. Aucune dépendance, aucun framework.

/**
 * h('div.thread-row', { onclick, title }, child, 'texte')
 * Le sélecteur accepte `tag.class1.class2`.
 */
export function h(sel, props, ...kids) {
  const [tag, ...classes] = String(sel).split('.')
  const el = document.createElement(tag || 'div')
  if (classes.length) el.className = classes.join(' ')
  // Le 2e argument est soit des propriétés, soit déjà un enfant.
  if (isProps(props)) apply(el, props)
  else if (props !== undefined) kids.unshift(props)
  append(el, kids)
  return el
}

function isProps(v) {
  return v !== null && typeof v === 'object' && !v.nodeType && !Array.isArray(v)
}

function apply(el, props) {
  if (!props || typeof props !== 'object' || props.nodeType) return
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue
    if (k === 'class') el.className = el.className ? `${el.className} ${v}` : v
    else if (k === 'text') el.textContent = v
    else if (k === 'html') el.innerHTML = v
    else if (k === 'dataset') Object.assign(el.dataset, v)
    else if (k === 'style') Object.assign(el.style, v)
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v)
    else if (v === true) el.setAttribute(k, '')
    else el.setAttribute(k, v)
  }
}

function append(el, kids) {
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false || kid === true) continue
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)))
  }
}

/** Bouton : raccourci le plus utilisé de l'app. */
export function button(sel, props, ...kids) {
  const el = h(sel.startsWith('button') ? sel : `button.${sel.replace(/^\./, '')}`, props, ...kids)
  if (!el.hasAttribute('type')) el.setAttribute('type', 'button')
  return el
}

export function clear(el) { while (el.firstChild) el.firstChild.remove() }

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ))
}

/** Émetteur minimal : `on(topic, fn)` renvoie la fonction de désabonnement. */
export function emitter() {
  const topics = new Map()
  return {
    on(topic, fn) {
      if (!topics.has(topic)) topics.set(topic, new Set())
      topics.get(topic).add(fn)
      return () => topics.get(topic)?.delete(fn)
    },
    emit(topic, payload) {
      for (const fn of topics.get(topic) || []) {
        try { fn(payload) } catch (err) { console.error('[emitter]', topic, err) }
      }
    },
  }
}

/**
 * Regroupe les appels dans la même frame. Les arguments sont accumulés :
 * un flux streamé ne doit jamais perdre un événement en route.
 */
export function rafBatch(fn) {
  let queue = []
  let scheduled = false
  return (payload) => {
    queue.push(payload)
    if (scheduled) return
    scheduled = true
    requestAnimationFrame(() => {
      scheduled = false
      const batch = queue
      queue = []
      fn(batch)
    })
  }
}

export function debounce(fn, ms) {
  let t
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms) }
}
