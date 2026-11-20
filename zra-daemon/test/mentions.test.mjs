// Mentions @ (conception 0.5.2, D1/D3/D5) : parsing des liens [@nom](file:///…),
// conversion en blocs ACP (embedded/resource_link, gardes de chemin et de
// taille), listing git/repli. Ports de parse_mention_links /
// mention_to_content_block (message_editor.rs) et du scan worktree (D5).
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { parseMentionLinks, uriToPath, fileUri, buildPromptBlocks, listFiles } from '../mentions.js'

const dirs = []
async function tmp() {
  const d = await mkdtemp(join(tmpdir(), 'zra-mentions-'))
  dirs.push(d)
  return d
}
after(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }) })

const link = (name, uri) => `[@${name}](${uri})`

test('parseMentionLinks : liens simples, multiples, imbriqués, non-file ignorés', () => {
  const text = `regarde ${link('a.js', 'file:///p/a.js')} et ${link('d', 'file:///p/d/')}`
  const ls = parseMentionLinks(text)
  assert.equal(ls.length, 2)
  assert.equal(ls[0].name, 'a.js')
  assert.equal(ls[0].uri, 'file:///p/a.js')
  assert.equal(text.slice(ls[0].start, ls[0].end), link('a.js', 'file:///p/a.js'))
  assert.equal(ls[1].name, 'd')
  // Crochets imbriqués dans le nom (find_matching_bracket de Zed).
  const nested = parseMentionLinks(link('a[1].js', 'file:///p/a%5B1%5D.js'))
  assert.equal(nested.length, 1)
  assert.equal(nested[0].name, 'a[1].js')
  // URI non-file : pas une mention ZRA (texte littéral).
  assert.deepEqual(parseMentionLinks(link('x', 'https://exemple.fr/x')), [])
  // Formes invalides : ignorées sans avaler le reste.
  assert.deepEqual(parseMentionLinks('[@unclosed(file:///x)'), [])
  assert.deepEqual(parseMentionLinks('[@nom] file:///x'), [])
  assert.deepEqual(parseMentionLinks('texte sans lien'), [])
})

test('fileUri / uriToPath : round-trip POSIX, Windows, espaces, accents, dossier', () => {
  for (const p of ['/home/user/projet/fichier.js', 'C:/Users/dev/projet/src/a.ts', '/tmp/accents été.js', '/tmp/espace blanc.js']) {
    assert.equal(uriToPath(fileUri(p)), p)
  }
  assert.equal(fileUri('/tmp/d', true), 'file:///tmp/d/')
  assert.equal(uriToPath('file:///tmp/d/'), '/tmp/d/')
  assert.equal(uriToPath('file:///C%3A/Users/dev/a.ts'), 'C:/Users/dev/a.ts')
  assert.equal(fileUri('C:\\Users\\dev\\a.ts'), 'file:///C:/Users/dev/a.ts')
  assert.equal(uriToPath('file:///tmp/%E2%80%A6'), '/tmp/…')
})

test('buildPromptBlocks : sans lien, le texte part tel quel', async () => {
  assert.deepEqual(await buildPromptBlocks('bonjour', { folderPaths: ['/x'], embeddedContext: true }),
    [{ type: 'text', text: 'bonjour' }])
})

test('buildPromptBlocks : D1 selon capacité, taille, binaire, dossier', async () => {
  const root = await tmp()
  await writeFile(join(root, 'texte.js'), 'console.log(1)\n')
  await writeFile(join(root, 'binaire.bin'), Buffer.from([0x41, 0x00, 0x42]))
  await writeFile(join(root, 'latin.txt'), Buffer.from([0xff, 0xfe, 0x41]))
  await writeFile(join(root, 'gros.txt'), 'x'.repeat(1_048_577))
  await mkdir(join(root, 'dossier'))
  const opts = { folderPaths: [root], embeddedContext: true }
  const uri = (f) => fileUri(join(root, f))

  // Fichier texte + embeddedContext → resource embarqué (contenu lu).
  let blocks = await buildPromptBlocks(`voici ${link('texte.js', uri('texte.js'))} ok`, opts)
  assert.deepEqual(blocks.map((b) => b.type), ['text', 'resource', 'text'])
  assert.equal(blocks[1].resource.text, 'console.log(1)\n')
  assert.equal(blocks[1].resource.uri, uri('texte.js'))
  assert.equal(blocks[0].text, 'voici ')
  assert.equal(blocks[2].text, ' ok')

  // Sans embeddedContext → resource_link.
  blocks = await buildPromptBlocks(link('texte.js', uri('texte.js')), { ...opts, embeddedContext: false })
  assert.deepEqual(blocks, [{ type: 'resource_link', uri: uri('texte.js'), name: 'texte.js' }])

  // Binaire, non-UTF-8, > 1 Mo → resource_link même avec embeddedContext.
  for (const f of ['binaire.bin', 'latin.txt', 'gros.txt']) {
    blocks = await buildPromptBlocks(link(f, uri(f)), opts)
    assert.equal(blocks[0].type, 'resource_link', f)
  }

  // Dossier → toujours resource_link, URI avec / final.
  blocks = await buildPromptBlocks(link('dossier', uri('dossier')), opts)
  assert.deepEqual(blocks, [{ type: 'resource_link', uri: uri('dossier') + '/', name: 'dossier' }])

  // Fichier absent du périmètre mais dans les dossiers → lien seul.
  blocks = await buildPromptBlocks(link('fantome.js', uri('fantome.js')), opts)
  assert.equal(blocks[0].type, 'resource_link')
})

test('buildPromptBlocks : garde de chemin — hors périmètre et traversée → texte littéral', async () => {
  const root = await tmp()
  const outside = await tmp()
  await writeFile(join(outside, 'secret.txt'), 'secret')
  await writeFile(join(root, 'ok.txt'), 'ok')
  const opts = { folderPaths: [root], embeddedContext: true }

  // Hors folderPaths : le lien reste en texte, rien n'est lu.
  const l = link('secret.txt', fileUri(join(outside, 'secret.txt')))
  assert.deepEqual(await buildPromptBlocks(`avant ${l} après`, opts),
    [{ type: 'text', text: `avant ${l} après` }])

  // Traversée .. : résolue hors périmètre → texte littéral.
  const traversal = link('secret.txt', fileUri(join(root, '..', outside.split(/[\\/]/).pop(), 'secret.txt')))
  const blocks = await buildPromptBlocks(traversal, opts)
  assert.equal(blocks[0].type, 'text')

  // Symlink sortant : le realpath trahit la sortie → texte littéral.
  try {
    await symlink(join(outside, 'secret.txt'), join(root, 'lien.txt'))
    const sl = link('lien.txt', fileUri(join(root, 'lien.txt')))
    assert.deepEqual(await buildPromptBlocks(sl, opts), [{ type: 'text', text: sl }])
  } catch (err) {
    // Windows sans privilège symlink : la garde lexicale est déjà couverte.
    if (err.code !== 'EPERM') throw err
  }

  // Dans le périmètre : embarqué.
  const inScope = await buildPromptBlocks(link('ok.txt', fileUri(join(root, 'ok.txt'))), opts)
  assert.equal(inScope[0].type, 'resource')
})

test('listFiles : git — trackés + non trackés non ignorés, dossiers déduits', async () => {
  const root = await tmp()
  execFileSync('git', ['init', '-q'], { cwd: root })
  await writeFile(join(root, 'tracké.js'), 'x')
  await writeFile(join(root, 'libre.js'), 'x')
  await writeFile(join(root, '.gitignore'), 'ignoré.js\nnode_modules/\n')
  await writeFile(join(root, 'ignoré.js'), 'x')
  await mkdir(join(root, 'src'))
  await writeFile(join(root, 'src', 'a.ts'), 'x')
  execFileSync('git', ['add', 'tracké.js', '.gitignore'], { cwd: root })

  const { entries, truncated } = await listFiles([root])
  assert.equal(truncated, false)
  const labels = entries.map((e) => e.label)
  assert.ok(labels.includes('tracké.js'))
  assert.ok(labels.includes('libre.js'))
  assert.ok(labels.includes('src/a.ts'))
  assert.ok(labels.includes('src'), 'dossier déduit des chemins')
  assert.ok(!labels.includes('ignoré.js'))
  const src = entries.find((e) => e.label === 'src')
  assert.equal(src.dir, true)
  assert.equal(src.path, join(root, 'src'))
  const a = entries.find((e) => e.label === 'src/a.ts')
  assert.equal(a.name, 'a.ts')
  assert.equal(a.dir, false)
})

test('listFiles : hors git — repli walk, exclusions Zed + node_modules', async () => {
  const root = await tmp()
  await writeFile(join(root, 'a.js'), 'x')
  await mkdir(join(root, 'node_modules'))
  await writeFile(join(root, 'node_modules', 'dep.js'), 'x')
  await mkdir(join(root, '.git'))
  await writeFile(join(root, '.git', 'HEAD'), 'x')
  await writeFile(join(root, '.DS_Store'), 'x')
  await mkdir(join(root, 'sub'))
  await writeFile(join(root, 'sub', 'b.js'), 'x')
  const { entries } = await listFiles([root])
  const labels = entries.map((e) => e.label)
  assert.deepEqual(labels.filter((l) => !entries.find((e) => e.label === l).dir).sort(), ['a.js', 'sub/b.js'])
  assert.ok(labels.includes('sub'))
})

test('listFiles : cache 30 s, multi-racines préfixées', async () => {
  const root = await tmp()
  await writeFile(join(root, 'a.js'), 'x')
  const first = await listFiles([root], { now: 1000 })
  await writeFile(join(root, 'nouveau.js'), 'x')
  const cached = await listFiles([root], { now: 2000 })
  assert.equal(cached, first, 'cache : même résultat avant expiration')
  const fresh = await listFiles([root], { now: 32_000 })
  assert.ok(fresh.entries.some((e) => e.label === 'nouveau.js'), 'périmé : re-scan')

  const root2 = await tmp()
  await writeFile(join(root2, 'b.js'), 'x')
  const multi = await listFiles([root, root2], { now: 40_000 })
  const labels = multi.entries.map((e) => e.label)
  assert.ok(labels.some((l) => l.endsWith('/a.js') && l.includes('/')), 'racine en préfixe si multi-projets')
  assert.ok(labels.some((l) => l.endsWith('/b.js') && l.includes('/')))
})
