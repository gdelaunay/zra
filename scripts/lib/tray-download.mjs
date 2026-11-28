// Téléchargement optionnel du binaire zra-tray prébuild (`npm run setup`).
//
// Le tray est une façade optionnelle : supervision, icône, deux modes — le
// flux manuel (npm run daemon / npm run service) n'en a jamais besoin. La
// question est posée à l'installation appliquée, en terminal interactif ;
// « jamais » est mémorisé dans `.zra/setup.json` et la question disparaît.
//
// Deux forges, même repo : Forgejo (source) d'abord, GitHub (miroir) en
// repli si l'une ne répond pas. Les binaires sont attachés aux releases par
// le workflow `release.yml` (tag v*), nommés `zra-tray-<target>[.exe]`.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { tr } from '../../zra-daemon/i18n.js'
import { configRoot } from '../../zra-daemon/platform.js'
import { trayBinary } from './tray-binary.mjs'

const REPO = 'gdelaunay/zra'
/** Ordre d'essai : la forge source, puis le miroir. */
export const FORGES = [
  { name: 'Forgejo', server: 'https://forgejo.gdelaunay.fr', api: 'https://forgejo.gdelaunay.fr/api/v1' },
  { name: 'GitHub', server: 'https://github.com', api: 'https://api.github.com' },
]

/** Asset de release pour la plateforme — null si non couverte (CI : win/linux x64). */
export function assetFor(platform = process.platform, arch = process.arch) {
  if (platform === 'win32' && arch === 'x64') return 'zra-tray-x86_64-pc-windows-msvc.exe'
  if (platform === 'linux' && arch === 'x64') return 'zra-tray-x86_64-unknown-linux-gnu'
  if (platform === 'linux' && arch === 'arm64') return 'zra-tray-aarch64-unknown-linux-gnu'
  return null
}

const choiceFile = (root) => join(configRoot({ root }), '.zra', 'setup.json')

/** « jamais » mémorisé ? (fichier absent ou illisible = non) */
export function neverAsked(root) {
  try {
    return JSON.parse(readFileSync(choiceFile(root), 'utf8')).trayDownload === 'never'
  } catch {
    return false
  }
}

export function rememberNever(root) {
  mkdirSync(join(configRoot({ root }), '.zra'), { recursive: true })
  writeFileSync(choiceFile(root), JSON.stringify({ trayDownload: 'never' }, null, 2) + '\n')
}

/**
 * Dernière release + asset, forge par forge. Renvoie le premier succès :
 * { forge, tag, path } ; sinon { error } (aucune forge n'a fourni le binaire).
 */
export async function downloadTray(root, { platform = process.platform, arch = process.arch, log = console.log } = {}) {
  const asset = assetFor(platform, arch)
  if (!asset) return { error: tr`Pas de binaire prébuild pour ${platform}/${arch} — build local : cargo build dans zra-tray/.` }
  const dest = join(configRoot({ root }), '.zra', 'bin', platform === 'win32' ? 'zra-tray.exe' : 'zra-tray')
  const errors = []
  for (const forge of FORGES) {
    try {
      const res = await fetch(`${forge.api}/repos/${REPO}/releases/latest`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(20000),
      })
      if (!res.ok) throw new Error(`releases/latest : HTTP ${res.status}`)
      const tag = (await res.json()).tag_name
      if (!tag) throw new Error('release sans tag')
      const url = `${forge.server}/${REPO}/releases/download/${tag}/${asset}`
      const bin = await fetch(url, { signal: AbortSignal.timeout(60000) })
      if (!bin.ok) throw new Error(`${asset} : HTTP ${bin.status}`)
      const bytes = Buffer.from(await bin.arrayBuffer())
      if (!bytes.length) throw new Error('fichier vide')
      mkdirSync(join(configRoot({ root }), '.zra', 'bin'), { recursive: true })
      writeFileSync(dest, bytes)
      if (platform !== 'win32') chmodSync(dest, 0o755)
      log(tr`✓ tray ${tag} téléchargé depuis ${forge.name} : ${dest}`)
      return { forge: forge.name, tag, path: dest }
    } catch (err) {
      errors.push(`${forge.name} : ${err.message}`)
    }
  }
  return { error: errors.join(' ; ') }
}

/**
 * La question, après une installation appliquée. Muette si : binaire déjà
 * présent, « jamais » mémorisé, pas de terminal interactif, plateforme non
 * couverte. L'échec du téléchargement n'est pas fatal — le setup a réussi.
 */
export async function offerTrayDownload(root, { log = console.log, question } = {}) {
  const existing = trayBinary(root)
  if (existing) return log(tr`Tray : ✓ déjà présent (${existing}).`)
  if (neverAsked(root)) return
  if (!process.stdin.isTTY) return
  const asset = assetFor()
  if (!asset) return log(tr`Tray : pas de binaire prébuild pour ${process.platform}/${process.arch} — build local : cargo build dans zra-tray/.`)

  const ask = question ?? (async (text) => {
    const { createInterface } = await import('node:readline/promises')
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const answer = await rl.question(text)
    rl.close()
    return answer
  })
  const answer = (await ask(tr`
Le binaire zra-tray prébuild (Rust, ~5 Mo) ajoute : supervision du daemon/relais
(restart si crash, journaux capturés), icône tray + menu natif, deux modes
poste/relais basculables, autostart. Facultatif — le flux manuel (npm run
daemon, npm run service) est inchangé, et le tray se build aussi localement
(cargo build dans zra-tray/).
Télécharger le binaire tray ? [oui/non/jamais] `)).trim().toLowerCase()

  if (/^(j|jamais|never)$/.test(answer)) {
    rememberNever(root)
    return log(tr`Noté : la question ne sera plus posée (.zra/setup.json).`)
  }
  if (!/^(o|oui|y|yes)$/.test(answer)) return log(tr`Tray : non téléchargé. Rebuild local possible : cargo build dans zra-tray/.`)
  const result = await downloadTray(root, { log })
  if (result.error) log(tr`✗ Téléchargement impossible (${result.error}). Le setup est terminé sans le tray ; réessayer plus tard ou cargo build dans zra-tray/.`)
}