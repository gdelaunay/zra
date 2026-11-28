// Chaque texte tr`…` a sa traduction anglaise dans le catalogue de sa brique, avec les mêmes {0}, {1}… ; pas de
// traduction orpheline. Briques : Node (daemon, shim, scripts) → i18n/en.json ; PWA → zra-client/js/en.js, un
// module ES (importable sans build par tout navigateur) ; tray → zra-tray/i18n/en.json (Rust tr!"…", pages HTML
// tr`…` et texte statique data-i18n). --write : réécrit les catalogues dans l'ordre du code, textes manquants à
// "" (à traduire), orphelins retirés.
import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const bricks = [
  { dirs: 'zra-daemon zra-shim zra-relay scripts zra-client/tools', catalog: 'i18n/en.json', prefix: '' },
  { dirs: 'zra-client/js', catalog: 'zra-client/js/en.js', prefix: 'export default ' },
  { dirs: 'zra-tray/src', catalog: 'zra-tray/i18n/en.json', prefix: '', tray: true },
]
const skip = /\/test\/|i18n(-test)?\.m?js$/

// Fin d'une expression ${…} commencée en i (après « ${ ») : accolades, chaînes et gabarits imbriqués
function skipExpression(src, i) {
  for (let depth = 1; i < src.length; i++) {
    const c = src[i]
    if (c === '{') depth++
    else if (c === '}' && --depth === 0) return i + 1
    else if (c === '\'' || c === '"') {
      for (i++; src[i] !== c; i++) if (src[i] === '\\') i++
    } else if (c === '`') i = readTemplate(src, i + 1).end - 1
  }
  throw new Error('expression non fermée')
}

// Gabarit commencé en i (après le `) : { parts (texte brut entre les ${}), end }
function readTemplate(src, i) {
  const parts = ['']
  for (; src[i] !== '`'; i++) {
    if (src[i] === '\\') parts[parts.length - 1] += src[i] + src[++i]
    else if (src[i] === '$' && src[i + 1] === '{') {
      i = skipExpression(src, i + 2) - 1
      parts.push('')
    } else parts[parts.length - 1] += src[i]
  }
  return { parts, end: i + 1 }
}

const cooked = (raw) => new Function(`return \`${raw}\`;`)()
const keyAt = (src, i) => readTemplate(src, i).parts.map(cooked).reduce((k, s, n) => k + `{${n - 1}}` + s)
const placeholders = (text) => [...text.matchAll(/\{(\d+)\}/g)].map((m) => m[1]).sort().join(',')

function keys({ dirs }) {
  const found = new Map()
  const files = execSync(`git ls-files -co --exclude-standard ${dirs}`, { cwd: root, encoding: 'utf8' })
    .split('\n').filter((f) => /\.m?js$/.test(f) && !skip.test(f))
  for (const f of files) {
    const src = readFileSync(join(root, f), 'utf8')
    for (const m of src.matchAll(/(?<![\w$.])tr`/g)) {
      const key = keyAt(src, m.index + 3)
      if (!found.has(key)) found.set(key, `${f}:${src.slice(0, m.index).split('\n').length}`)
    }
  }
  return found
}

// Brique tray : clés du catalogue zra-tray/i18n/en.json. Rust : tr!("clé {0}…", …) ;
// HTML : tr`…` dans les scripts + texte statique des éléments data-i18n (et attributs
// data-i18n-title / data-i18n-placeholder). Le français est la clé, comme ailleurs.
const rustUnescape = (s) => s.replace(/\\([nrt"'\\0])/g, (_, c) => ({ n: '\n', r: '\r', t: '\t', '"': '"', "'": "'", '\\': '\\', '0': '\0' })[c])
const decodeEntities = (s) => s.replace(/&(amp|lt|gt|quot|apos|#39);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" })[e])

function trayKeys() {
  const found = new Map()
  const files = execSync('git ls-files -co --exclude-standard zra-tray/src', { cwd: root, encoding: 'utf8' })
    .split('\n').filter(Boolean)
  const add = (key, f, index, src) => {
    if (key && !found.has(key)) found.set(key, `${f}:${src.slice(0, index).split('\n').length}`)
  }
  for (const f of files) {
    const src = readFileSync(join(root, f), 'utf8')
    if (f.endsWith('.rs')) {
      for (const m of src.matchAll(/\btr!\(\s*"((?:[^"\\]|\\.)*)"/g)) add(rustUnescape(m[1]), f, m.index, src)
    } else if (f.endsWith('.html')) {
      for (const m of src.matchAll(/(?<![\w$.])tr`/g)) add(keyAt(src, m.index + 3), f, m.index, src)
      for (const m of src.matchAll(/<[^>]*\bdata-i18n(?=[\s>])[^>]*>([^<]*)</g)) add(decodeEntities(m[1]).trim(), f, m.index, src)
      for (const m of src.matchAll(/\bdata-i18n-(?:title|placeholder)="([^"]*)"/g)) add(decodeEntities(m[1]).trim(), f, m.index, src)
    }
  }
  return found
}

const write = process.argv.includes('--write')
const problems = []
for (const brick of bricks) {
  const file = join(root, brick.catalog)
  const found = brick.tray ? trayKeys() : keys(brick)
  const catalog = JSON.parse(readFileSync(file, 'utf8').slice(brick.prefix.length))
  if (write) {
    const next = Object.fromEntries([...found.keys()].map((k) => [k, catalog[k] ?? '']))
    writeFileSync(file, brick.prefix + JSON.stringify(next, null, 2) + '\n')
    console.log(`${brick.catalog} : ${found.size} textes, ${Object.values(next).filter((v) => !v).length} à traduire.`)
    continue
  }
  for (const [key, where] of found) {
    if (!catalog[key]) problems.push(`${where} : sans traduction : ${JSON.stringify(key)}`)
    else if (placeholders(key) !== placeholders(catalog[key])) problems.push(`${where} : {n} différents : ${JSON.stringify(catalog[key])}`)
  }
  for (const key of Object.keys(catalog)) if (!found.has(key)) problems.push(`${brick.catalog} : traduction orpheline : ${JSON.stringify(key)}`)
  if (!problems.length) console.log(`${brick.catalog} : ${found.size} textes traduits`)
}
if (problems.length) {
  console.error(problems.slice(0, 30).join('\n') + (problems.length > 30 ? `\n… et ${problems.length - 30} autre(s)` : ''))
  console.error('`node scripts/i18n-test.mjs --write` met les catalogues à jour (textes à traduire vides).')
  process.exit(1)
}
