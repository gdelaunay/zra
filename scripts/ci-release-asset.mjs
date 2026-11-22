// CI (release.yml) : attache le binaire zra-tray buildé à la release du tag,
// sur la forge courante — Forgejo (API Gitea) ou GitHub (API REST + uploads).
// Les deux fournissent le même contexte (GITHUB_SERVER_URL, GITHUB_REPOSITORY,
// GITHUB_REF_NAME, GITHUB_TOKEN) ; c'est server_url qui départage.
//
//   node scripts/ci-release-asset.mjs --target x86_64-unknown-linux-gnu
//
// Idempotent : release créée si absente (course entre jobs matrice gérée),
// asset du même nom remplacé (re-run du tag). Outil de dev : français only.

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const server = process.env.GITHUB_SERVER_URL || 'https://github.com'
const repo = process.env.GITHUB_REPOSITORY
const tag = process.env.GITHUB_REF_NAME
const token = process.env.GITHUB_TOKEN
const target = process.argv[process.argv.indexOf('--target') + 1]
if (!repo || !tag || !token || !target) {
  console.error('Contexte CI manquant (GITHUB_REPOSITORY, GITHUB_REF_NAME, GITHUB_TOKEN, --target).')
  process.exit(1)
}

const github = server.includes('github.com')
const base = github ? 'https://api.github.com' : `${server}/api/v1`
const headers = {
  authorization: github ? `Bearer ${token}` : `token ${token}`,
  accept: 'application/json',
}
const exe = target.includes('windows') ? '.exe' : ''
const asset = `zra-tray-${target}${exe}`
const binary = join(ROOT, 'zra-tray', 'target', target, 'release', `zra-tray${exe}`)

async function api(path, options = {}) {
  const res = await fetch(`${base}${path}`, { ...options, headers: { ...headers, ...options.headers } })
  return res
}

// Release du tag : créée si absente. Deux jobs matrice peuvent la créer en
// même temps → un conflit de création se résout en relisant.
let release
const found = await api(`/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`)
if (found.ok) {
  release = await found.json()
} else {
  const created = await api(`/repos/${repo}/releases`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tag_name: tag, name: tag }),
  })
  if (created.ok) release = await created.json()
  else {
    const retry = await api(`/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`)
    if (!retry.ok) throw new Error(`Release impossible : ${created.status} ${await created.text()}`)
    release = await retry.json()
  }
}
console.log(`Release ${tag} : id ${release.id} (${github ? 'GitHub' : 'Forgejo'}).`)

// Asset du même nom (re-run) : supprimé avant ré-upload.
const assets = await (await api(`/repos/${repo}/releases/${release.id}/assets?per_page=100`)).json()
for (const a of Array.isArray(assets) ? assets : []) {
  if (a.name === asset) {
    const path = github
      ? `/repos/${repo}/releases/assets/${a.id}`
      : `/repos/${repo}/releases/${release.id}/assets/${a.id}`
    await api(path, { method: 'DELETE' })
    console.log(`Asset ${asset} existant supprimé (re-run).`)
  }
}

const bytes = readFileSync(binary)
let upload
if (github) {
  upload = await fetch(`https://uploads.github.com/repos/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(asset)}`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/octet-stream' },
    body: bytes,
  })
} else {
  // API Gitea : multipart, champ « attachment ».
  const form = new FormData()
  form.append('attachment', new Blob([bytes]), asset)
  upload = await api(`/repos/${repo}/releases/${release.id}/assets`, { method: 'POST', body: form })
}
if (!upload.ok) throw new Error(`Upload ${asset} : ${upload.status} ${await upload.text()}`)
console.log(`✓ ${asset} (${bytes.length} octets) attaché à ${tag}.`)