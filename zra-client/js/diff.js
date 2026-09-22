// Diff ligne à ligne pour l'affichage.
//
// Le protocole ACP fournit `oldText` / `newText` bruts : le découpage en
// lignes ajoutées/supprimées est du rendu, pas de l'interprétation de contenu.

const MAX_CELLS = 4_000_000 // garde-fou : au-delà on n'aligne plus, on remplace en bloc

/** @returns {{lines: Array<{type:'ctx'|'add'|'del', oldNo:number|null, newNo:number|null, text:string}>, added:number, removed:number, truncated:boolean}} */
export function lineDiff(oldText, newText) {
  const a = splitLines(oldText)
  const b = splitLines(newText)

  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let end = 0
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++

  const midA = a.slice(start, a.length - end)
  const midB = b.slice(start, b.length - end)

  const lines = []
  let oldNo = 1, newNo = 1
  for (let i = 0; i < start; i++) lines.push(ctx(a[i], oldNo++, newNo++))

  let truncated = false
  if (midA.length * midB.length > MAX_CELLS) {
    truncated = true
    for (const t of midA) lines.push({ type: 'del', oldNo: oldNo++, newNo: null, text: t })
    for (const t of midB) lines.push({ type: 'add', oldNo: null, newNo: newNo++, text: t })
  } else {
    for (const op of lcsDiff(midA, midB)) {
      if (op.type === 'ctx') lines.push(ctx(op.text, oldNo++, newNo++))
      else if (op.type === 'del') lines.push({ type: 'del', oldNo: oldNo++, newNo: null, text: op.text })
      else lines.push({ type: 'add', oldNo: null, newNo: newNo++, text: op.text })
    }
  }

  for (let i = a.length - end; i < a.length; i++) lines.push(ctx(a[i], oldNo++, newNo++))

  return {
    lines,
    added: lines.filter((l) => l.type === 'add').length,
    removed: lines.filter((l) => l.type === 'del').length,
    truncated,
  }
}

const ctx = (text, oldNo, newNo) => ({ type: 'ctx', oldNo, newNo, text })

function splitLines(t) {
  const s = String(t ?? '')
  if (s === '') return []
  return s.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n')
}

/** LCS classique (programmation dynamique), suffisant sur des fichiers de taille normale. */
function lcsDiff(a, b) {
  const n = a.length, m = b.length
  if (!n) return b.map((text) => ({ type: 'add', text }))
  if (!m) return a.map((text) => ({ type: 'del', text }))

  const dp = new Uint32Array((n + 1) * (m + 1))
  const at = (i, j) => i * (m + 1) + j
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[at(i, j)] = a[i] === b[j]
        ? dp[at(i + 1, j + 1)] + 1
        : Math.max(dp[at(i + 1, j)], dp[at(i, j + 1)])
    }
  }
  const ops = []
  let i = 0, j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ type: 'ctx', text: a[i] }); i++; j++ }
    else if (dp[at(i + 1, j)] >= dp[at(i, j + 1)]) { ops.push({ type: 'del', text: a[i] }); i++ }
    else { ops.push({ type: 'add', text: b[j] }); j++ }
  }
  while (i < n) ops.push({ type: 'del', text: a[i++] })
  while (j < m) ops.push({ type: 'add', text: b[j++] })
  return ops
}

/**
 * Replie les grandes plages inchangées : garde `context` lignes autour de chaque
 * modification et insère un marqueur `skip` à la place du reste.
 */
export function collapse(lines, context = 3) {
  const keep = new Array(lines.length).fill(false)
  lines.forEach((l, idx) => {
    if (l.type === 'ctx') return
    for (let k = Math.max(0, idx - context); k <= Math.min(lines.length - 1, idx + context); k++) keep[k] = true
  })
  const out = []
  let skipped = 0
  lines.forEach((l, idx) => {
    if (keep[idx]) {
      if (skipped) { out.push({ type: 'skip', count: skipped }); skipped = 0 }
      out.push(l)
    } else skipped++
  })
  if (skipped) out.push({ type: 'skip', count: skipped })
  return out
}
