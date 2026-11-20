// Mentions @ du composer (conception 0.5.2) — sérialisation D3 unique
// [@nom](file:///…), parsing des liens (port de parse_mention_links,
// message_editor.rs), déclencheur (MentionCompletion::try_parse,
// completion_provider.rs). Le daemon convertit les liens en blocs ACP au
// départ (D1) ; la PWA ne fait que saisir, sérialiser et rendre.
// Les URI follow le format de Zed (MentionUri::to_uri, acp_thread/mention.rs) :
// file:/// percent-encodé, `/` final pour les dossiers.

const WS = /\s/
// Frontière de Zed : début de ligne, blanc, ou parenthèse/crochet/accolade ouvrante.
const BOUNDARY = /[\s([{]/

/** Parenthèse/crochet fermant correspondant, en comptant l'imbrication. */
function matchingBracket(text, start, open, close) {
  let depth = 0
  for (let i = start; i < text.length; i++) {
    if (text[i] === open) depth++
    else if (text[i] === close && --depth === 0) return i
  }
  return -1
}

/**
 * Port de `parse_mention_links` : liens [@nom](uri) du texte, crochets et
 * parenthèses imbriqués compris. Seuls les URI file:// sont des mentions.
 * @returns {Array<{start:number, end:number, name:string, uri:string}>}
 */
export function parseMentionLinks(text) {
  const out = []
  let from = 0
  for (;;) {
    const s = text.indexOf('[@', from)
    if (s < 0) break
    const nameEnd = matchingBracket(text, s, '[', ']')
    if (nameEnd < 0) { from = s + 2; continue }
    if (text[nameEnd + 1] !== '(') { from = nameEnd + 1; continue }
    const uriEnd = matchingBracket(text, nameEnd + 1, '(', ')')
    if (uriEnd < 0) { from = nameEnd + 1; continue }
    const uri = text.slice(nameEnd + 2, uriEnd)
    if (/^file:\/\//i.test(uri)) out.push({ start: s, end: uriEnd + 1, name: text.slice(s + 2, nameEnd), uri })
    from = uriEnd + 1
  }
  return out
}

/** Sérialisation D3 d'une mention. */
export const mentionLink = (name, uri) => `[@${name}](${uri})`

/** Chemin absolu → URI file:// (percent-encodé, `/` final pour un dossier). */
export function fileUri(absPath, dir = false) {
  let p = String(absPath).replace(/\\/g, '/')
  if (dir && !p.endsWith('/')) p += '/'
  const encoded = p.split('/').map(encodeURIComponent).join('/').replace(/%3A/gi, ':')
  return 'file://' + (encoded.startsWith('/') ? encoded : `/${encoded}`)
}

/** URI file:// → chemin absolu (décodé, slashes avant, lecteur Windows sans /). */
export function uriToPath(uri) {
  let p = String(uri).replace(/^file:\/\//i, '')
  try { p = decodeURIComponent(p) } catch { return null }
  p = p.replace(/\\/g, '/')
  if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1)
  return p || null
}

/** Nom affichable d'un URI de mention : dernier segment du chemin décodé. */
export function uriName(uri) {
  const p = uriToPath(uri ?? '')
  if (!p) return ''
  const clean = p.replace(/\/$/, '')
  return clean.slice(clean.lastIndexOf('/') + 1)
}

/**
 * Port de `MentionCompletion::try_parse` (fichiers/dossiers seulement) :
 * le `@` le plus à droite en frontière, pas de blanc juste après. La requête
 * court jusqu'au caret ; un blanc dedans = mention terminée (menu fermé,
 * comme la commande slash après son espace).
 * @returns {{start:number, end:number, query:string}|null}
 */
export function parseMention(line) {
  let start = -1
  for (let i = line.length - 1; i >= 0; i--) {
    if (line[i] !== '@') continue
    const next = line[i + 1]
    if (next !== undefined && WS.test(next)) continue
    if (i > 0 && !BOUNDARY.test(line[i - 1])) continue
    start = i
    break
  }
  if (start < 0) return null
  const query = line.slice(start + 1)
  if (WS.test(query)) return null
  return { start, end: line.length, query }
}
