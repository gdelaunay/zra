// Environnement du projet, relevé comme Zed avant de lancer un agent
// (`ProjectEnvironment::local_directory_environment`,
// `crates/project/src/environment.rs` ; `util::shell_env::capture`).
//
// Sous Linux et macOS, Zed lance le shell de l'utilisateur en mode connexion
// interactif, dans le dossier du projet, et en relève les variables : profil
// (`.bashrc`, `.zshrc`, nvm…), puis direnv (`load_direnv: "direct"`, défaut de
// Zed). Le daemon, lancé par systemd ou launchd, n'a rien de tout ça.
//
// Sous Windows, Zed lance PowerShell avec `-NoProfile` : il ne relève que
// l'environnement de la session, que le daemon a déjà. Rien à faire.

import { spawn } from 'node:child_process'
import { basename } from 'node:path'

import { logger } from './log.js'
import { tr } from './i18n.js'

const log = logger('env')

/** Repère qui isole le JSON d'une sortie bavarde (messages d'accueil du shell). */
const MARK = '__ZRA_ENV__'
/** Un relevé vaut pour ce délai : la relecture d'un même projet ne relance pas le shell. */
const TTL_MS = 10 * 60_000

/** `dir` → `{ at, env }`. */
const cache = new Map()

/**
 * Variables du projet `dir`, à poser sous l'`env` des réglages de l'agent.
 * Échec ou délai dépassé : `{}` — l'agent part avec l'environnement du daemon,
 * comme avant.
 * @returns {Promise<Record<string,string>>}
 */
export async function projectEnvironment(dir, { platform = process.platform, shell = process.env.SHELL, timeoutMs = 10_000 } = {}) {
  if (platform === 'win32' || !dir) return {}
  const hit = cache.get(dir)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.env

  let env = {}
  try {
    env = await captureShell(shell || '/bin/sh', dir, timeoutMs)
    Object.assign(env, await direnv(dir, env, timeoutMs))
    for (const [k, v] of Object.entries(env)) if (v === null) delete env[k]
  } catch (err) {
    log.warn(tr`Environnement du projet non relevé (${dir}) :`, err.message)
    env = {}
  }
  cache.set(dir, { at: Date.now(), env })
  return env
}

/** Pour les tests. */
export function clearProjectEnvironmentCache() {
  cache.clear()
}

/**
 * Commande de relevé, comme `capture_unix` : connexion (`-l`) et interactif
 * (`-i`), `cd` dans le dossier, puis impression de l'environnement en JSON.
 * Shells reconnus : POSIX (sh, bash, zsh, dash, ksh) et fish.
 * @returns {{ command:string, args:string[] }|null}
 */
export function captureCommand(shell, dir, node = process.execPath) {
  const kind = basename(shell).replace(/\.exe$/i, '')
  const fish = kind === 'fish'
  if (!fish && !['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh'].includes(kind)) return null
  const quote = fish ? quoteFish : quotePosix
  const target = dir.startsWith('-') ? `./${dir}` : dir
  const script = `process.stdout.write(${JSON.stringify(MARK)} + JSON.stringify(process.env))`
  const prefix = fish ? 'emit fish_prompt; ' : ''
  return {
    command: shell,
    args: ['-l', '-i', '-c', `${prefix}cd ${quote(target)}; ${quote(node)} -e ${quote(script)}`],
  }
}

/** Extrait l'environnement d'une sortie de shell, bavarde ou non. */
export function parseCapture(output) {
  const at = output.lastIndexOf(MARK)
  if (at < 0) throw new Error(tr`Aucun environnement dans la sortie du shell.`)
  const rest = output.slice(at + MARK.length)
  const end = rest.lastIndexOf('}')
  return JSON.parse(rest.slice(0, end + 1))
}

const quotePosix = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`
const quoteFish = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`

function captureShell(shell, dir, timeoutMs) {
  const cmd = captureCommand(shell, dir)
  if (!cmd) {
    log.debug(tr`Shell non pris en charge pour le relevé d'environnement : ${shell}`)
    return Promise.resolve({})
  }
  return run(cmd.command, cmd.args, { cwd: dir, env: process.env, timeoutMs }).then(({ stdout }) => parseCapture(stdout))
}

/** `direnv export json` dans le dossier, avec l'environnement relevé (`load_direnv_environment`). */
async function direnv(dir, env, timeoutMs) {
  let out
  try {
    out = await run('direnv', ['export', 'json'], { cwd: dir, env: { ...process.env, ...env, TERM: 'dumb' }, timeoutMs })
  } catch (err) {
    if (err.code === 'ENOENT') return {}
    throw err
  }
  return out.stdout.trim() ? JSON.parse(out.stdout) : {}
}

/**
 * Lance et attend, borné dans le temps. Nouvelle session (`detached`), comme
 * Zed (`set_pre_exec_to_start_new_session`) : un shell interactif ne doit pas
 * s'emparer d'un terminal.
 */
function run(command, args, { cwd, env, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c) => { stdout += c })
    child.stderr.on('data', (c) => { stderr += c })
    const timer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
      reject(new Error(tr`Délai dépassé (${command})`))
    }, timeoutMs)
    child.on('error', (err) => { clearTimeout(timer); reject(err) })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0 || stdout.includes(MARK)) resolve({ stdout, stderr })
      else reject(new Error(tr`${command} a échoué (code ${code}) : ${stderr.trim().split('\n').at(-1) ?? ''}`))
    })
  })
}
