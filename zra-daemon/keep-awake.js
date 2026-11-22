// Garde éveillé — inhibition de la veille automatique du poste.
// `reference/conception-zra-veille.md` :
//
// - deux déclencheurs : un tour d'agent en cours (`setBusy`, piloté par le hub),
//   ou la bascule explicite de l'utilisateur (`setMode`, TTL tenu ici) ;
// - un helper résident par poste (child process, `platform.js`) : sa mort
//   relâche l'inhibition côté OS — crash du daemon compris, aucun état orphelin ;
// - l'état de la bascule est persisté : il survit aux déconnexions de la PWA
//   (la socket mobile ne survit pas à l'arrière-plan) et au restart du daemon.
//
// On ne gère aucun timer de veille : à la relâche, le délai normal de l'OS
// reprend la main. ZRA ne fait que poser et lever un veto.

import { spawn as nodeSpawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { EventEmitter } from 'node:events'

import { keepAwakeHelper } from './platform.js'
import { logger } from './log.js'
import { tr } from './i18n.js'

const log = logger('keep-awake')

/** Bascule explicite : durées fixes, ou « jusqu'à désactivation » (`on`). */
export const MODES = ['off', '1h', '4h', '12h', 'on']
const DURATIONS = { '1h': 3_600_000, '4h': 14_400_000, '12h': 43_200_000 }

/** Un helper qui quitte moins de 5 s après son spawn avec une erreur n'est pas
 * une coupure : le mécanisme n'existe pas sur ce poste (logind absent…). */
const EARLY_FAIL_MS = 5000

/** Faux child process des tests : vit jusqu'à `kill()`, comme le vrai. */
function fakeChild() {
  const child = new EventEmitter()
  child.kill = () => { child.killed = true; child.emit('exit', null, 'SIGTERM') }
  return child
}

export class KeepAwake extends EventEmitter {
  /**
   * @param {{ file?:string|null, spawn?:Function, platform?:string, now?:()=>number }} opts
   *   `file` : bascule persistée ; `null` = en mémoire (tests). `spawn` et `now`
   *   injectables pour les tests. Sous `node --test`, le spawn réel est remplacé
   *   par un faux : aucun test ne lance PowerShell ni systemd-inhibit pour de vrai.
   */
  constructor({ file = null, spawn = nodeSpawn, platform = process.platform, now = Date.now } = {}) {
    super()
    this.file = file
    this.platform = platform
    this.now = now
    this.spawn = spawn === nodeSpawn && process.env.NODE_TEST_CONTEXT ? fakeChild : spawn
    /** Mode de la bascule explicite ; `until` : échéance ms, `null` si `on`/`off`. */
    this.mode = 'off'
    this.until = null
    /** Au moins un thread en tour (miroir du hub). */
    this.busy = false
    /** macOS : pas de helper. Linux : confirmé au premier spawn (logind). */
    this.supported = platform !== 'darwin'
    this.helper = null
    this.helperSince = 0
    this.killedByUs = false
    this.timer = null
    this.load()
    this.sync()
  }

  // ---- état ----------------------------------------------------------------

  /** Ce que la PWA affiche : bascule, échéance, inhibition réelle, raison. */
  state() {
    const manual = this.mode !== 'off' && (this.until === null || this.until > this.now())
    const active = this.supported && (this.busy || manual)
    return {
      mode: this.mode,
      until: this.until,
      active,
      reason: active ? (this.busy ? 'turn' : 'manual') : null,
      supported: this.supported,
    }
  }

  /** Le hub appelle ça à chaque changement d'activité ; sans effet si identique. */
  setBusy(busy) {
    busy = Boolean(busy)
    if (this.busy === busy) return
    this.busy = busy
    this.sync()
    this.emit('change', this.state())
  }

  /**
   * Bascule explicite (`set_keep_awake`). Mode inconnu : refus, l'état ne bouge
   * pas. L'échéance est repartie de maintenant à chaque choix de durée.
   */
  setMode(mode) {
    if (!MODES.includes(mode)) throw new Error(tr`Mode de garde éveillé inconnu : ${mode} (${MODES.join(', ')}).`)
    this.mode = mode
    this.until = DURATIONS[mode] ? this.now() + DURATIONS[mode] : null
    this.save()
    this.armTimer()
    this.sync()
    this.emit('change', this.state())
  }

  /** Échéance du TTL atteinte : la bascule retombe à `off`. Le timer appelle ça. */
  tick() {
    if (this.mode === 'off' || this.until === null || this.until > this.now()) return
    log.info(tr`Garde éveillé : durée écoulée, retour au réglage normal de veille.`)
    this.mode = 'off'
    this.until = null
    this.save()
    this.sync()
    this.emit('change', this.state())
  }

  armTimer() {
    clearTimeout(this.timer)
    this.timer = null
    if (this.until === null) return
    this.timer = setTimeout(() => this.tick(), Math.max(0, this.until - this.now()))
    this.timer.unref?.()
  }

  // ---- helper résident -------------------------------------------------------

  desired() {
    return this.busy || (this.mode !== 'off' && (this.until === null || this.until > this.now()))
  }

  /** Pose ou lève le veto : spawn du helper, ou kill. Idempotent. */
  sync() {
    if (this.desired() && this.supported && !this.helper) return this.spawnHelper()
    if (!this.desired() && this.helper) this.killHelper()
  }

  spawnHelper() {
    const spec = keepAwakeHelper({
      platform: this.platform,
      why: this.busy ? tr`Agent en cours` : tr`Garde éveillé (réglage du poste)`,
    })
    if (!spec) {
      this.supported = false
      return
    }
    this.killedByUs = false
    this.helperSince = this.now()
    let child
    try {
      child = this.spawn(spec.command, spec.args, { stdio: 'ignore', windowsHide: true })
    } catch (err) {
      log.warn(tr`Garde éveillé indisponible :`, err.message)
      this.supported = false
      this.emit('change', this.state())
      return
    }
    this.helper = child
    log.info(tr`Garde éveillé : veille automatique interdite (${this.busy ? tr`agent en cours` : tr`bascule active`}).`)
    child.on('error', (err) => {
      if (this.helper !== child) return
      this.helper = null
      log.warn(tr`Garde éveillé indisponible (${spec.command}) :`, err.message)
      this.supported = false
      this.emit('change', this.state())
    })
    child.on('exit', (code) => {
      if (this.helper !== child) return
      this.helper = null
      if (this.killedByUs) return
      // Quitte trop vite avec une erreur : le mécanisme n'existe pas ici
      // (systemd-inhibit sans logind, PowerShell refusé…). On ne retente pas.
      if (code !== 0 && this.now() - this.helperSince < EARLY_FAIL_MS) {
        log.warn(tr`Garde éveillé non supporté sur ce poste (helper quitté, code ${code}).`)
        this.supported = false
        this.emit('change', this.state())
        return
      }
      // Mort inattendue alors qu'on inhibe encore : une retente, et si le
      // mécanisme est vraiment absent, l'échec précoce ci-dessus l'arrête.
      if (this.desired() && this.supported) {
        log.warn(tr`Garde éveillé : helper quitté (code ${code}), nouvelle tentative.`)
        setTimeout(() => this.sync(), EARLY_FAIL_MS).unref?.()
      }
    })
  }

  killHelper() {
    const child = this.helper
    this.helper = null
    if (!child) return
    this.killedByUs = true
    try { child.kill() } catch { /* déjà mort */ }
    log.info(tr`Garde éveillé relâché : le délai normal de veille reprend la main.`)
  }

  // ---- persistance -----------------------------------------------------------

  load() {
    if (!this.file || !existsSync(this.file)) return
    let state = null
    try { state = JSON.parse(readFileSync(this.file, 'utf8')) } catch (err) {
      log.warn(tr`État garde éveillé illisible (${this.file}) :`, err.message)
      return
    }
    if (MODES.includes(state?.mode)) this.mode = state.mode
    this.until = Number.isFinite(state?.until) ? state.until : null
    // Durée écoulée pendant l'arrêt du daemon : pas de réveil de bascule périmée.
    if (this.until !== null && this.until <= this.now()) {
      this.mode = 'off'
      this.until = null
    }
    this.armTimer()
  }

  save() {
    if (!this.file) return
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, JSON.stringify({ mode: this.mode, until: this.until }, null, 2))
      renameSync(tmp, this.file)
    } catch (err) {
      log.warn(tr`État garde éveillé non persisté :`, err.message)
    }
  }

  close() {
    clearTimeout(this.timer)
    this.killHelper()
  }
}