// Téléchargement optionnel du tray au setup : asset par plateforme, choix
// « jamais » persisté, question posée dans les seuls cas voulus, repli de
// forge. Réseau stubé — aucun appel réel.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { FORGES, assetFor, downloadTray, neverAsked, offerTrayDownload, rememberNever } from '../../scripts/lib/tray-download.mjs'

function tmpRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'zra-traydl-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

test('assetFor : la matrice CI (win/linux x64), linux arm64 prévu, le reste null', () => {
  assert.equal(assetFor('win32', 'x64'), 'zra-tray-x86_64-pc-windows-msvc.exe')
  assert.equal(assetFor('linux', 'x64'), 'zra-tray-x86_64-unknown-linux-gnu')
  assert.equal(assetFor('linux', 'arm64'), 'zra-tray-aarch64-unknown-linux-gnu')
  assert.equal(assetFor('darwin', 'arm64'), null)
  assert.equal(assetFor('linux', 'ia32'), null)
})

test('forges : la source d’abord, le miroir en repli', () => {
  assert.deepEqual(FORGES.map((f) => f.name), ['Forgejo', 'GitHub'])
})

test('« jamais » : persisté dans .zra/setup.json, relu, et un fichier corrompu ne bloque pas', (t) => {
  const root = tmpRoot(t)
  assert.equal(neverAsked(root), false, 'fichier absent')
  rememberNever(root)
  assert.equal(neverAsked(root), true)
  assert.deepEqual(JSON.parse(readFileSync(join(root, '.zra', 'setup.json'), 'utf8')), { trayDownload: 'never' })
  writeFileSync(join(root, '.zra', 'setup.json'), 'pas du json')
  assert.equal(neverAsked(root), false, 'illisible = pas de choix mémorisé')
})

test('offer : binaire déjà présent ou « jamais » → pas de question', async (t) => {
  const root = tmpRoot(t)
  const boom = () => { throw new Error('la question ne doit pas être posée') }
  mkdirSync(join(root, '.zra', 'bin'), { recursive: true })
  writeFileSync(join(root, '.zra', 'bin', 'zra-tray.exe'), 'x')
  await offerTrayDownload(root, { log: () => {}, question: boom })
  rmSync(join(root, '.zra', 'bin'), { recursive: true })
  rememberNever(root)
  await offerTrayDownload(root, { log: () => {}, question: boom })
})

test('offer : « jamais » mémorise, « non » ne télécharge rien', async (t) => {
  const root = tmpRoot(t)
  const tty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
  t.after(() => tty ? Object.defineProperty(process.stdin, 'isTTY', tty) : delete process.stdin.isTTY)
  const realFetch = globalThis.fetch
  globalThis.fetch = () => { throw new Error('aucun appel réseau attendu') }
  t.after(() => { globalThis.fetch = realFetch })

  await offerTrayDownload(root, { log: () => {}, question: async () => 'jamais' })
  assert.equal(neverAsked(root), true)
  assert.equal(existsSync(join(root, '.zra', 'bin')), false)

  rmSync(join(root, '.zra', 'setup.json'))
  await offerTrayDownload(root, { log: () => {}, question: async () => 'non' })
  assert.equal(existsSync(join(root, '.zra', 'bin')), false)
})

test('download : Forgejo muet → repli GitHub, binaire écrit et exécutable', async (t) => {
  const root = tmpRoot(t)
  const realFetch = globalThis.fetch
  const bytes = Buffer.from('MZ-faux-binaire')
  globalThis.fetch = async (url) => {
    const u = String(url)
    if (u.startsWith('https://forgejo.gdelaunay.fr')) throw new Error('instance éteinte')
    if (u === 'https://api.github.com/repos/gdelaunay/zra/releases/latest') {
      return new Response(JSON.stringify({ tag_name: 'v0.6.0' }), { status: 200 })
    }
    if (u === 'https://github.com/gdelaunay/zra/releases/download/v0.6.0/zra-tray-x86_64-pc-windows-msvc.exe') {
      return new Response(bytes, { status: 200 })
    }
    throw new Error(`URL inattendue : ${u}`)
  }
  t.after(() => { globalThis.fetch = realFetch })

  const result = await downloadTray(root, { platform: 'win32', arch: 'x64', log: () => {} })
  assert.equal(result.forge, 'GitHub')
  assert.equal(result.tag, 'v0.6.0')
  assert.deepEqual(readFileSync(result.path), bytes)
})

test('download : les deux forges muettes → erreur agrégée, rien écrit', async (t) => {
  const root = tmpRoot(t)
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('réseau coupé') }
  t.after(() => { globalThis.fetch = realFetch })
  const result = await downloadTray(root, { platform: 'linux', arch: 'x64', log: () => {} })
  assert.match(result.error, /Forgejo : réseau coupé ; GitHub : réseau coupé/)
  assert.equal(existsSync(join(root, '.zra', 'bin')), false)
})