// Mentions @ du composer (conception 0.5.2, D1/D3/D5) — portage de Zed 1.28.1 :
// `message_editor.rs` (parse_mention_links, mention_to_content_block),
// `acp_thread/src/mention.rs` (MentionUri::to_uri : file:/// percent-encodé,
// `/` final pour les dossiers), `completion_provider.rs` (scan worktree).
//
// Le texte envoyé par la PWA contient des liens [@nom](file:///…) (D3) ; le
// daemon les convertit en blocs ACP au départ (D1) : fichier texte ≤ 1 Mo et
// agent `embeddedContext` → `resource` embarqué ; sinon `resource_link`
// (dossier, binaire, > 1 Mo, capacité absente).
//
// Garde de sécurité (§9) : un lien n'est lu/embarqué que si son chemin réel
// (realpath) est contenu dans les folderPaths réels du thread. Hors périmètre
// → le lien reste en texte littéral, jamais de lecture arbitraire.

import { execFile } from 'node:child_process'
import { readdir, stat, readFile, realpath } from 'node:fs/promises'
import { join, basename, dirname, relative, resolve, isAbsolute } from 'node:path'

const SCAN_LIMIT = 20_000
const CACHE_TTL = 30_000
const MAX_EMBED = 1_048_576
// file_scan_exclusions de Zed + node_modules (déviation documentée : Zed le
// scannerait, il est exclu ici hors gitignore — docs/fr/limitations.md).
const EXCLUDE_DIRS = new Set(['.git', '.svn', '.hg', '.jj', '.sl', '.repo', 'CVS', 'node_modules'])
const EXCLUDE_FILES = new Set(['.DS_Store', 'Thumbs.db'])

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
 * parenthèses imbriqués compris. Seuls les URI file:// sont des mentions
 * (fichiers/dossiers — ZRA ne fait pas les autres types de Zed).
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

/** URI file:// → chemin absolu (décodé, slashes avant, lecteur Windows sans /). */
export function uriToPath(uri) {
  let p = String(uri).replace(/^file:\/\//i, '')
  try { p = decodeURIComponent(p) } catch { return null }
  p = p.replace(/\\/g, '/')
  if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1)
  return p || null
}

/** Chemin absolu → URI file:// (D3 : percent-encodé, `/` final pour un dossier). */
export function fileUri(absPath, dir = false) {
  let p = String(absPath).replace(/\\/g, '/')
  if (dir && !p.endsWith('/')) p += '/'
  const encoded = p.split('/').map(encodeURIComponent).join('/').replace(/%3A/gi, ':')
  return 'file://' + (encoded.startsWith('/') ? encoded : `/${encoded}`)
}

/** Le chemin réel est-il dans un des dossiers réels du thread ? Un fichier
 * absent est vérifié lexicalement (realpath du parent : pas de symlink qui
 * sorte du projet). */
async function contained(absPath, roots) {
  let real
  try {
    real = await realpath(absPath)
  } catch {
    const lex = resolve(absPath)
    try { real = join(await realpath(dirname(lex)), basename(lex)) } catch { return false }
  }
  for (const root of roots) {
    let rr
    try { rr = await realpath(root) } catch { continue }
    const rel = relative(rr, real)
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return true
  }
  return false
}

/** Un lien → bloc ACP (D1), ou null si hors périmètre (→ texte littéral). */
async function mentionBlock(link, { folderPaths, embeddedContext }) {
  const path = uriToPath(link.uri)
  if (!path || !folderPaths?.length) return null
  if (!(await contained(path, folderPaths))) return null
  let st = null
  try { st = await stat(path) } catch { /* absent : lien seul */ }
  const dir = path.endsWith('/') || st?.isDirectory()
  const name = link.name || basename(path)
  const uri = fileUri(path, dir)
  if (dir || !st?.isFile() || st.size > MAX_EMBED || !embeddedContext) {
    return { type: 'resource_link', uri, name }
  }
  let buf
  try { buf = await readFile(path) } catch { return { type: 'resource_link', uri, name } }
  // Binaire ou non-UTF-8 → lien seul (l'agent se débrouille, pas d'image en 5.2).
  if (buf.includes(0)) return { type: 'resource_link', uri, name }
  let text
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf) } catch { return { type: 'resource_link', uri, name } }
  return { type: 'resource', resource: { uri, text } }
}

/**
 * Texte à liens → blocs de prompt : texte entrelardé de resources (D1).
 * Les blocs texte adjacents sont fusionnés ; un lien hors périmètre reste
 * en texte littéral. Sans lien : un seul bloc texte, à l'identique.
 */
export async function buildPromptBlocks(text, opts = {}) {
  const links = parseMentionLinks(text)
  if (!links.length) return [{ type: 'text', text }]
  const blocks = []
  const pushText = (t) => {
    if (!t) return
    const last = blocks[blocks.length - 1]
    if (last?.type === 'text') last.text += t
    else blocks.push({ type: 'text', text: t })
  }
  let last = 0
  for (const l of links) {
    pushText(text.slice(last, l.start))
    const b = await mentionBlock(l, opts).catch(() => null)
    if (b) blocks.push(b)
    else pushText(text.slice(l.start, l.end))
    last = l.end
  }
  pushText(text.slice(last))
  return blocks
}

/** git ls-files (trackés + non trackés non ignorés), ou null hors git. */
function gitFiles(root) {
  return new Promise((resolve) => {
    execFile('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      { cwd: root, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
        if (err) return resolve(null)
        resolve([...new Set(stdout.split('\0').filter(Boolean).map((p) => p.replace(/\\/g, '/')))])
      })
  })
}

/** Repli hors git : parcours récursive, exclusions Zed + node_modules. */
async function walkFiles(root) {
  const out = []
  const stack = ['']
  while (stack.length && out.length < SCAN_LIMIT) {
    const rel = stack.pop()
    let ents
    try { ents = await readdir(join(root, rel), { withFileTypes: true }) } catch { continue }
    for (const e of ents) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) { if (!EXCLUDE_DIRS.has(e.name)) stack.push(r) }
      else if (e.isFile() && !EXCLUDE_FILES.has(e.name)) out.push(r)
    }
  }
  return out
}

const cache = new Map()

/**
 * Listing D5 : fichiers et dossiers des folderPaths, borne 20 000 entrées,
 * cache 30 s. `path` absolu (la PWA en fait l'URI), `label` relatif pour
 * l'affichage et le fuzzy — préfixé du nom de la racine si multi-projets.
 * @returns {Promise<{entries:Array<{path:string,label:string,name:string,dir:boolean}>, truncated:boolean}>}
 */
export async function listFiles(folderPaths, { now = Date.now() } = {}) {
  const roots = (folderPaths || []).filter((p) => typeof p === 'string' && p)
  const key = roots.join('|')
  const hit = cache.get(key)
  if (hit && now - hit.at < CACHE_TTL) return hit.result
  const entries = []
  let truncated = false
  for (const root of roots) {
    const files = (await gitFiles(root)) ?? (await walkFiles(root))
    const dirs = new Set()
    for (const rel of files) {
      for (let i = rel.indexOf('/'); i > 0; i = rel.indexOf('/', i + 1)) dirs.add(rel.slice(0, i))
    }
    const prefix = roots.length > 1 ? `${basename(root)}/` : ''
    for (const rel of files) {
      if (entries.length >= SCAN_LIMIT) { truncated = true; break }
      entries.push({ path: join(root, rel), label: prefix + rel, name: rel.slice(rel.lastIndexOf('/') + 1), dir: false })
    }
    for (const d of dirs) {
      if (entries.length >= SCAN_LIMIT) { truncated = true; break }
      entries.push({ path: join(root, d), label: prefix + d, name: d.slice(d.lastIndexOf('/') + 1), dir: true })
    }
    if (truncated) break
  }
  entries.sort((a, b) => a.label.localeCompare(b.label))
  const result = { entries, truncated }
  cache.set(key, { at: now, result })
  return result
}
