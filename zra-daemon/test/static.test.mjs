// Le service des statiques (`static.js`) — mode dev/repli.
//
// Trois choses à verrouiller : le bon MIME, `no-cache` partout (le service
// worker gère le cache, le daemon ne doit jamais servir une version périmée),
// et surtout l'absence de traversée de chemin.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createStaticHandler } from '../static.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, 'fixtures', 'static')
const SECRET = join(HERE, 'fixtures', 'static-secret', 'secret.txt')

const serve = createStaticHandler(ROOT)

/** req/res minimum : ce que le handler touche réellement. */
function call(method, url, handler = serve) {
  const res = {
    status: null,
    headers: null,
    body: undefined,
    ended: false,
    writeHead(status, headers) { this.status = status; this.headers = headers },
    end(body) { this.body = body; this.ended = true },
  }
  return handler({ method, url }, res).then(() => res)
}

const text = (res) => (res.body === undefined ? '' : res.body.toString('utf8'))

test('GET / sert index.html', async () => {
  const res = await call('GET', '/')
  assert.equal(res.status, 200)
  assert.equal(res.headers['content-type'], 'text/html; charset=utf-8')
  assert.equal(text(res), readFileSync(join(ROOT, 'index.html'), 'utf8'))
})

test('le chemin est résolu sous la racine, query string comprise', async () => {
  const a = await call('GET', '/app.js')
  const b = await call('GET', '/app.js?v=3&x=1')
  assert.equal(a.status, 200)
  assert.equal(text(a), text(b))
})

test('MIME par extension, et octet-stream pour une extension inconnue', async () => {
  const expected = {
    '/app.js': 'text/javascript; charset=utf-8',
    '/data.json': 'application/json; charset=utf-8',
    '/sub/deep.css': 'text/css; charset=utf-8',
    '/blob.dat': 'application/octet-stream',
  }
  for (const [url, type] of Object.entries(expected)) {
    const res = await call('GET', url)
    assert.equal(res.status, 200, url)
    assert.equal(res.headers['content-type'], type, url)
  }
})

test('un nom de fichier pourcent-encodé est décodé', async () => {
  const name = readdirSync(ROOT).find((f) => f.startsWith('note-'))
  assert.ok(name, 'la fixture porte un nom accentué')
  const res = await call('GET', `/${encodeURIComponent(name)}`)
  assert.equal(res.status, 200)
  assert.equal(text(res), readFileSync(join(ROOT, name), 'utf8'))
})

test('cache-control: no-cache et content-length exact sur chaque fichier servi', async () => {
  for (const url of ['/', '/app.js', '/blob.dat']) {
    const res = await call('GET', url)
    assert.equal(res.headers['cache-control'], 'no-cache', url)
    assert.equal(res.headers['content-length'], res.body.length, url)
  }
})

test('un fichier binaire passe intact', async () => {
  const res = await call('GET', '/blob.dat')
  assert.deepEqual(res.body, readFileSync(join(ROOT, 'blob.dat')))
})

test('HEAD renvoie les mêmes en-têtes, sans corps', async () => {
  const get = await call('GET', '/app.js')
  const head = await call('HEAD', '/app.js')
  assert.equal(head.status, 200)
  assert.deepEqual(head.headers, get.headers)
  assert.equal(head.body, undefined)
  assert.equal(head.ended, true)
})

test('une autre méthode vaut 405', async () => {
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
    const res = await call(method, '/app.js')
    assert.equal(res.status, 405, method)
    assert.equal(res.headers['content-type'], 'text/plain; charset=utf-8')
    assert.equal(text(res), 'méthode non autorisée')
    assert.equal(res.headers['content-length'], Buffer.byteLength('méthode non autorisée'))
  }
})

test('un fichier absent vaut 404', async () => {
  const res = await call('GET', '/introuvable.js')
  assert.equal(res.status, 404)
  assert.equal(text(res), 'introuvable')
})

test('un dossier n’est pas servi : 403', async () => {
  const res = await call('GET', '/sub')
  assert.equal(res.status, 403)
  assert.equal(text(res), 'interdit')
})

test('traversée de chemin : jamais de 200, quoi que l’URL encode', async () => {
  const attacks = [
    '/../static-secret/secret.txt',
    '/sub/../../static-secret/secret.txt',
    '/%2e%2e/static-secret/secret.txt',
    '/%2e%2e%2fstatic-secret/secret.txt',
    '/..%2f..%2fstatic-secret%2fsecret.txt',
    '/sub/../../../zra-daemon/config.js',
  ]
  for (const url of attacks) {
    const res = await call('GET', url)
    assert.notEqual(res.status, 200, url)
    assert.ok(res.body === undefined || !text(res).includes('secret voisin'), `${url} ne fuit pas`)
  }
  // Le fichier visé existe bien : c’est le refus qui est testé, pas la fixture.
  assert.ok(readFileSync(SECRET, 'utf8').includes('secret voisin'))
})

test('un dossier voisin dont le nom commence comme la racine n’est pas servi', async () => {
  // `static-secret` partage le préfixe `static` : sans le séparateur dans le
  // test de préfixe, il passerait. Il faut un `%2f` pour y arriver — l’URL
  // replie les `..` littéraux, et `%2e` comme un point, avant le handler.
  for (const url of ['/..%2f..%2fstatic-secret%2fsecret.txt', '/%2e%2e%2fstatic-secret%2fsecret.txt']) {
    const res = await call('GET', url)
    assert.equal(res.status, 403, url)
    assert.equal(text(res), 'interdit')
  }
})

test('des `..` littéraux ou `%2e%2e` sont repliés par l’URL : ils retombent sous la racine', async () => {
  // Pas de fuite non plus, mais par un autre chemin : `/../x` est déjà `/x`
  // quand le handler le reçoit, donc introuvable sous la racine.
  for (const url of ['/../static-secret/secret.txt', '/%2e%2e/static-secret/secret.txt']) {
    const res = await call('GET', url)
    assert.equal(res.status, 404, url)
  }
})

test('un chemin absolu dans l’URL reste sous la racine', async () => {
  const res = await call('GET', '/C:/Windows/win.ini')
  assert.equal(res.status, 404)
  // `//hôte` est une URL relative de protocole : l’hôte part, la racine reste.
  const res2 = await call('GET', '//index.html')
  assert.equal(res2.status, 200)
  assert.equal(text(res2), readFileSync(join(ROOT, 'index.html'), 'utf8'))
})

test('la racine est figée à la création du handler', async () => {
  const elsewhere = createStaticHandler(resolve(HERE, 'fixtures', 'static-secret'))
  const res = await call('GET', '/secret.txt', elsewhere)
  assert.equal(res.status, 200)
  assert.ok(text(res).includes('secret voisin'))
  const denied = await call('GET', '/secret.txt')
  assert.equal(denied.status, 404, 'le handler par défaut ne voit pas ce dossier')
})
