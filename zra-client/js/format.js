// Formatage : dates relatives, chemins abrégés, tailles.

const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000

/** Date relative compacte, façon sidebar de Zed : "à l'instant", "12 min", "3 h", "hier", "12 sept." */
export function relTime(value, now = Date.now()) {
  const t = toMs(value)
  if (t === null) return ''
  const d = now - t
  if (d < 0) return 'à venir'
  if (d < 45_000) return "à l'instant"
  if (d < HOUR) return `${Math.round(d / MIN)} min`
  if (d < DAY) return `${Math.floor(d / HOUR)} h`
  if (d < 2 * DAY) return 'hier'
  if (d < 7 * DAY) return `${Math.floor(d / DAY)} j`
  const date = new Date(t)
  const sameYear = new Date(now).getFullYear() === date.getFullYear()
  return date.toLocaleDateString('fr-FR', {
    day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }),
  })
}

export function absTime(value) {
  const t = toMs(value)
  if (t === null) return ''
  return new Date(t).toLocaleString('fr-FR', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

/** Durée écoulée, compacte : "8 s", "1 min 05 s", "1 h 02 min". */
export function formatDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s} s`
  const pad = (n) => String(n).padStart(2, '0')
  if (s < 3600) return `${Math.floor(s / 60)} min ${pad(s % 60)} s`
  return `${Math.floor(s / 3600)} h ${pad(Math.floor((s % 3600) / 60))} min`
}

export function toMs(value) {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'number') return value
  const t = Date.parse(value)
  if (!Number.isNaN(t)) return t
  // SQLite stocke parfois "2025-09-12 08:31:02.123" sans timezone.
  const t2 = Date.parse(String(value).replace(' ', 'T') + 'Z')
  return Number.isNaN(t2) ? null : t2
}

/**
 * Chemin abrégé pour l'affichage : garde le dernier segment (et son parent
 * si la place le permet), normalise les séparateurs Windows.
 */
export function shortPath(p, segments = 2) {
  if (!p) return ''
  const norm = String(p).replace(/\\/g, '/').replace(/\/+$/, '')
  const parts = norm.split('/').filter(Boolean)
  if (parts.length <= segments) return norm
  return '…/' + parts.slice(-segments).join('/')
}

/** Libellé lisible d'un agent : "claude-acp" -> "Claude". */
export function agentLabel(agentId) {
  if (!agentId) return 'agent'
  const known = {
    'claude-acp': 'Claude',
    'claude-zra': 'Claude (ZRA)',
    'gemini-acp': 'Gemini',
    'codex-acp': 'Codex',
  }
  if (known[agentId]) return known[agentId]
  return agentId.replace(/[-_]acp$/, '').replace(/[-_]/g, ' ')
}

/** Dernier segment d'un chemin : "C:\\dev\\zra\\" -> "zra". */
export function baseName(p) {
  const parts = String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').split('/').filter(Boolean)
  return parts.at(-1) || ''
}

/**
 * Projet d'un thread, tel que l'utilisateur le pense : le dossier ouvert dans
 * Zed, nommé d'après son dernier segment. Un thread sur plusieurs dossiers
 * forme son propre projet (« zra + notes ») — c'est un autre espace de travail.
 *
 * `key` compare les chemins sans casse ni séparateur : Windows ne les distingue
 * pas, et l'index de Zed n'écrit pas toujours les mêmes.
 */
export function projectOf(folderPaths) {
  const paths = (Array.isArray(folderPaths) ? folderPaths : []).filter(Boolean)
  if (!paths.length) return { key: '', name: 'sans projet', folderPaths: [] }
  const key = paths.map((p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()).join('|')
  return { key, name: paths.map(baseName).join(' + '), folderPaths: paths }
}

/** Nombre de tokens compact, façon Zed : 950, 9.4k, 27k, 1M, 1.5M. */
export function formatTokens(n) {
  if (!Number.isFinite(n)) return ''
  const compact = (v, unit) => `${v >= 10 ? Math.round(v) : Math.round(v * 10) / 10}${unit}`
  if (n < 1000) return String(Math.round(n))
  // 999 600 s'arrondit à 1000k : autant écrire 1M.
  if (Math.round(n / 1000) < 1000) return compact(n / 1000, 'k')
  return compact(n / 1_000_000, 'M')
}

/** Coût d'une session : "0,07 $". Sous le centime, on le dit plutôt que d'afficher 0. */
export function formatCost(cost) {
  if (!cost || !Number.isFinite(cost.amount)) return ''
  const fmt = (v) => {
    try {
      return new Intl.NumberFormat('fr-FR', { style: 'currency', currency: cost.currency || 'USD', currencyDisplay: 'narrowSymbol', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v)
    } catch {
      return `${v.toFixed(2)} ${cost.currency || ''}`.trim()
    }
  }
  return cost.amount > 0 && cost.amount < 0.01 ? `< ${fmt(0.01)}` : fmt(cost.amount)
}
