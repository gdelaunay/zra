// CI (release.yml) : assemble l'archive « app » grand public par plateforme.
//
//   node scripts/ci-package-app.mjs --target x86_64-pc-windows-msvc
//
// Layout (reference/conception-zra-tray.md, Distribution) :
//
//   zra-<version>-<target>/
//    ├── zra-tray[.exe]   ← point d'entrée (superviseur + onboarding)
//    └── app/             ← daemon + client + shim + relay + package.json,
//                           même version que le tray (gate tag == Cargo.toml)
//
// `app/` est la racine vue du daemon (config.js : ROOT = parent de
// zra-daemon/) : config et `.zra` y vivent, le tray s'aligne (config.rs).
// Zéro dépendance runtime : les quatre dossiers sont 100 % stdlib Node, pas
// de node_modules. Les scripts d'orchestration (setup/service) arriveront
// avec l'onboarding grand public (étape 5.2).
//
// Le zip est produit par l'outil de l'OS (Compress-Archive / zip) — pas de
// dépendance JS. Outil de dev : français only.

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Dossiers runtime embarqués dans app/ (même version, zéro dépendance). */
export const APP_DIRS = ['zra-daemon', 'zra-client', 'zra-shim', 'zra-relay']

/** Dev-only, exclu de l'archive utilisateur (tests, fixtures, outils). */
const PRUNE = new Set(['test', 'tools', 'node_modules', '.zra'])

/** Scripts d'orchestration embarqués dans app/scripts/ (setup/service + libs,
 *  repli PowerShell Windows). Le tray les spawn en non interactif (étape 5.2). */
export const SCRIPT_FILES = ['setup.mjs', 'service.mjs', 'daemon-task.ps1']
export const SCRIPT_DIRS = ['lib']

/** Version du tray — source unique (le gate CI exige tag == cette version). */
export function trayVersion(root = ROOT) {
  const cargo = readFileSync(join(root, 'zra-tray', 'Cargo.toml'), 'utf8')
  const m = /^version = "([^"]+)"/m.exec(cargo)
  if (!m) throw new Error('Version introuvable dans zra-tray/Cargo.toml.')
  return m[1]
}

/** Nom de l'archive (asset de release) pour la plateforme. */
export function archiveName(version, target) {
  return `zra-${version}-${target}.zip`
}

/**
 * Assemble le dossier `zra-<version>-<target>/` (binaire + app/) dans outDir.
 * Renvoie son chemin. Le binaire doit être buildé (cargo build --release
 * --target …) en amont.
 */
export function stageApp({ root = ROOT, target, version = trayVersion(root), outDir = join(root, 'dist') } = {}) {
  if (!target) throw new Error('--target requis (ex. x86_64-pc-windows-msvc).')
  const exe = target.includes('windows') ? '.exe' : ''
  const binary = join(root, 'zra-tray', 'target', target, 'release', `zra-tray${exe}`)
  if (!existsSync(binary)) throw new Error(`Binaire absent : ${binary} (cargo build --release --target ${target}).`)

  const staging = join(outDir, `zra-${version}-${target}`)
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(join(staging, 'app'), { recursive: true })

  // Point d'entrée à la racine, app/ à côté (discover() vise app/zra-daemon).
  cpSync(binary, join(staging, `zra-tray${exe}`))
  for (const dir of APP_DIRS) {
    cpSync(join(root, dir), join(staging, 'app', dir), {
      recursive: true,
      filter: (src) => !PRUNE.has(basename(src)),
    })
  }
  // Le daemon lit ROOT/package.json pour sa version ; les exemples de config
  // servent de référence à l'utilisateur (la config réelle est créée à l'onboarding).
  cpSync(join(root, 'package.json'), join(staging, 'app', 'package.json'))
  for (const f of ['zra.config.example.json', 'zra.config.example.en.json']) {
    if (existsSync(join(root, f))) cpSync(join(root, f), join(staging, 'app', f))
  }
  // Orchestration : setup/service + libs (imports ../zra-daemon/* depuis app/scripts/).
  mkdirSync(join(staging, 'app', 'scripts'), { recursive: true })
  for (const f of SCRIPT_FILES) cpSync(join(root, 'scripts', f), join(staging, 'app', 'scripts', f))
  for (const d of SCRIPT_DIRS) cpSync(join(root, 'scripts', d), join(staging, 'app', 'scripts', d), { recursive: true })
  return staging
}

/** Zip le dossier staging (le zip contient le dossier nommé à sa racine). */
export function zipStaging(staging, zipPath) {
  rmSync(zipPath, { force: true })
  if (process.platform === 'win32') {
    const q = (s) => `'${s.replace(/'/g, "''")}'`
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Compress-Archive -LiteralPath ${q(staging)} -DestinationPath ${q(zipPath)} -Force`], { encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`Compress-Archive : ${r.stderr || r.stdout}`)
  } else {
    const r = spawnSync('zip', ['-r', '-q', zipPath, basename(staging)], { cwd: dirname(staging), encoding: 'utf8' })
    if (r.status !== 0) throw new Error(`zip : ${r.stderr || r.stdout} (zip installé ?)`)
  }
  return zipPath
}

function main() {
  const target = process.argv[process.argv.indexOf('--target') + 1]
  const outIdx = process.argv.indexOf('--out')
  const outDir = outIdx > -1 ? resolve(process.argv[outIdx + 1]) : join(ROOT, 'dist')
  const version = trayVersion()
  const staging = stageApp({ target, version, outDir })
  const zipPath = join(outDir, archiveName(version, target))
  zipStaging(staging, zipPath)
  console.log(`✓ ${archiveName(version, target)} (${basename(staging)}/ + app/)`)
  console.log(zipPath)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}