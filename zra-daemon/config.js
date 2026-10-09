// Configuration du daemon : `zra.config.json` à la racine, surchargeable par
// variables d'environnement (pratique pour les tests et le mode dev).

import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseJsonc } from './jsonc.js'
import { KEYBOARD_BACKENDS, PATHS } from './platform.js'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Chemins par défaut de Zed sur ce poste.
 *
 * Calculés par `platform.js`, qui est le seul module à connaître l'OS : Windows
 * donne `%LOCALAPPDATA%\Zed\…`, Linux `$XDG_DATA_HOME/zed/…`. Les exports
 * publics ne changent pas, aucun appelant n'est à modifier.
 */
export const ZED = {
  db: PATHS.db,
  settings: PATHS.settings,
}

/** `keymap.json` de Zed : à côté de son `settings.json`. */
export const keymapBeside = (settingsFile) => join(dirname(settingsFile), 'keymap.json')

export const DEFAULTS = {
  /** Port unique : statiques (si activées) + WebSocket `/ws`. */
  port: 7777,

  // --- écoute (spec §9) -----------------------------------------------------
  /** Nom de l'adaptateur WireGuard, ex. "ZRA". `null` => détection par motif. */
  bindInterface: null,
  /** Repli de détection par plage, ex. "10.0.0.0/24". */
  bindCidr: null,
  /** Toujours vrai en pratique : les shims de Zed passent par la loopback. */
  bindLoopback: true,
  /**
   * Écouter le réseau local (IPv4 privées). Le téléphone sur le même Wi-Fi s'y
   * connecte en direct ; à distance, un tunnel « tout le trafic » (wg-easy,
   * AllowedIPs 0.0.0.0/0) y mène aussi. Appairage obligatoire (`auth`).
   */
  bindLan: true,
  /** Restreindre le réseau local à ces plages, ex. ["192.168.1.0/24"]. `null` : toutes les IPv4 privées. */
  lanCidrs: null,
  /** Écouter l'interface d'un tunnel monté sur le poste, s'il y en a une. */
  bindTunnel: true,
  /** Refus de démarrer si aucune interface de tunnel n'est trouvée. */
  requireTunnel: false,
  /**
   * Plutôt que refuser : démarrer en loopback et écouter le tunnel dès qu'il
   * apparaît. Le mode de la tâche planifiée (`npm run service`), lancée à
   * l'ouverture de session, parfois avant que WireGuard ait monté l'adaptateur.
   */
  waitTunnel: false,
  /** Sondage des interfaces : tunnel apparu ou disparu, Wi-Fi changé, IP renouvelée. */
  tunnelPollMs: 10_000,

  // --- client web -----------------------------------------------------------
  /**
   * Le client est servi ailleurs en production ; le daemon garde la capacité de
   * le servir en dev/repli (sur `localhost`, contexte sécurisé => service worker
   * et installation fonctionnent sans certificat).
   */
  serveStatic: true,
  staticDir: 'zra-client',
  /**
   * Origines autorisées à ouvrir le WebSocket. Le navigateur n'applique pas la
   * same-origin policy aux WebSockets : sans cette liste, n'importe quelle page
   * visitée depuis le tunnel pourrait piloter les postes. L'origine propre du
   * daemon est ajoutée automatiquement quand il sert les statiques.
   */
  allowedOrigins: [],

  /** `{ cert, key }` => HTTPS + wss. Absent => HTTP + ws. */
  tls: null,

  /**
   * Appairage (spec §9) : hors loopback, un client présente un jeton obtenu une
   * fois contre le code affiché par le daemon. `file` : les clients appairés
   * (jetons hachés). `required: false` ouvre tout — dev isolé seulement.
   */
  auth: {
    required: true,
    exemptLoopback: true,
    file: '.zra/auth.json',
  },

  // --- sources --------------------------------------------------------------
  zedDb: null,
  zedSettings: null,
  /** `null` => à côté de `zedSettings`. Porte les raccourcis « nouveau thread » de ZRA. */
  zedKeymap: null,
  /** Poll de l'index des threads (spec §3.2). */
  pollMs: 2000,
  /** Poll de présence de Zed. */
  zedProbeMs: 5000,
  /** Ring buffer par thread live (spec §5.1). */
  ringSize: 2000,

  /**
   * Backend d'injection (spec §6) : `acp` (défaut), `uia` (clavier), `auto`
   * (`acp`, repli clavier sur refus de l'agent), `mock` (bouchon).
   */
  injection: 'acp',
  /** Délai d'attente du verdict de l'agent, ou de Zed, après un envoi (spec §6.2). */
  injectConfirmMs: 5000,

  /**
   * Pilotage de la fenêtre Zed au clavier — ouvrir une session (spec §6.7),
   * rouvrir un thread fermé (§6.3), backend `uia`. **Désactivé par défaut** :
   * envoyer des touches au poste s'active en connaissance de cause.
   */
  zedControl: {
    enabled: false,
    /** Filtre sur le titre de la fenêtre Zed visée. `null` => la plus récente. */
    window: null,
    stepDelayMs: 120,
    /** Surcharge des recettes de `zed/driver.js` (`newThread`, `openThread`, `submit`). */
    recipes: {},
    /** Tout résoudre sans envoyer une seule touche. */
    dryRun: false,
    /** Attente de la preuve venue du shim (session ouverte ou rechargée). */
    timeoutMs: 30_000,
    /**
     * CLI de Zed, pour ouvrir le projet d'une nouvelle session. `null` => celle
     * de l'installation par défaut, sinon `zed` dans le PATH.
     */
    cli: null,
    /** Délai laissé à la fenêtre d'un projet pour apparaître après la CLI. */
    windowWaitMs: 8000,
    /**
     * Backend clavier (portage Linux) : `auto` (défaut) choisit selon l'OS et
     * les outils réellement installés — `keyboard.ps1` sous Windows, `xdotool`
     * sous Linux. Depuis `d911219` il n'y a plus de `ydotool`/`wtype` : sous
     * Wayland, Zed est forcé sous XWayland (`WAYLAND_DISPLAY=` dans son
     * `.desktop`, voir `scripts/lib/wayland.mjs`) et `xdotool` voit ses fenêtres.
     * Un nom imposé est respecté même si l'outil est absent : il échoue en
     * disant pourquoi, plutôt que de basculer en silence. Les noms acceptés sont
     * `auto`, `powershell`, `xdotool`, `none` (`KEYBOARD_BACKENDS`) — tout autre
     * est refusé au chargement de la configuration.
     * `none` : pas de clavier, l'injection `uia` échoue avec un message qui
     * renvoie vers `acp`.
     */
    keyboard: 'auto',
    /**
     * **Bouton mort depuis `d911219`.** Il servait aux backends sans fenêtre
     * (`ydotool`, `wtype`), qui ne pouvaient ni viser une fenêtre ni vérifier le
     * premier plan sous Wayland : `true` assumait que les frappes partent dans
     * le focus courant. Ces deux backends ont été supprimés, et plus aucun code
     * ne lit cette valeur — `xdotool` vérifie le premier plan à chaque étape
     * (`assertTarget`). La clé reste acceptée pour ne pas casser une
     * configuration existante, mais elle ne fait rien.
     */
    unsafeFocus: false,
  },

  /**
   * Comment lancer un agent, quand le registry de Zed ne suffit pas à le dire
   * (spec §2.2) : `{ "<agent_id>": { "command": …, "args": [], "env": {} } }`.
   * Sert au shim comme au relecteur de threads fermés.
   */
  agentCommands: {},
  /** Cache du replay `session/load` (spec §5.2). */
  historyTtlMs: 10 * 60_000,
  /** Garde-fou : un agent qui ne rend jamais la main ne bloque pas le daemon. */
  historyTimeoutMs: 60_000,

  /** Journal d'injections (spec §9). Dossier de ZRA : `%LOCALAPPDATA%\zra` en Windows, `$XDG_STATE_HOME/zra` ailleurs. */
  logFile: PATHS.injectionLog,
  /** Journal du daemon sur disque, en plus de la console (`--log`). `null` : console seule. */
  daemonLogFile: null,
  /** Nom du poste affiché dans la PWA. `null` => hostname. */
  machineName: null,
}

function envOverrides() {
  const e = process.env
  const out = {}
  if (e.ZRA_PORT) out.port = Number(e.ZRA_PORT)
  if (e.ZRA_BIND_INTERFACE) out.bindInterface = e.ZRA_BIND_INTERFACE
  if (e.ZRA_BIND_CIDR) out.bindCidr = e.ZRA_BIND_CIDR
  if (e.ZRA_REQUIRE_TUNNEL) out.requireTunnel = e.ZRA_REQUIRE_TUNNEL !== '0'
  if (e.ZRA_WAIT_TUNNEL) out.waitTunnel = e.ZRA_WAIT_TUNNEL !== '0'
  if (e.ZRA_BIND_LAN) out.bindLan = e.ZRA_BIND_LAN !== '0'
  if (e.ZRA_SERVE_STATIC) out.serveStatic = e.ZRA_SERVE_STATIC !== '0'
  if (e.ZRA_STATIC_DIR) out.staticDir = e.ZRA_STATIC_DIR
  if (e.ZRA_ALLOWED_ORIGINS) out.allowedOrigins = e.ZRA_ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
  if (e.ZRA_ZED_DB) out.zedDb = e.ZRA_ZED_DB
  if (e.ZRA_ZED_SETTINGS) out.zedSettings = e.ZRA_ZED_SETTINGS
  if (e.ZRA_ZED_KEYMAP) out.zedKeymap = e.ZRA_ZED_KEYMAP
  if (e.ZRA_POLL_MS) out.pollMs = Number(e.ZRA_POLL_MS)
  if (e.ZRA_INJECTION) out.injection = e.ZRA_INJECTION
  if (e.ZRA_LOG_FILE) out.logFile = e.ZRA_LOG_FILE || null
  if (e.ZRA_DAEMON_LOG) out.daemonLogFile = e.ZRA_DAEMON_LOG
  if (e.ZRA_MACHINE_NAME) out.machineName = e.ZRA_MACHINE_NAME
  return out
}

/** Résout un chemin relatif par rapport à la racine du dépôt. */
function abs(p) {
  if (!p) return p
  return isAbsolute(p) ? p : join(ROOT, p)
}

// Sous `node --test`, jamais le zra.config.json du poste : un pilotage de Zed
// activé pour de vrai ferait taper les tests dans la fenêtre Zed ouverte.
const UNDER_TEST = Boolean(process.env.NODE_TEST_CONTEXT)

export async function loadConfig({ file = process.env.ZRA_CONFIG || (UNDER_TEST ? null : join(ROOT, 'zra.config.json')), overrides = {} } = {}) {
  let fromFile = {}
  if (file && existsSync(file)) {
    try {
      fromFile = parseJsonc(await readFile(file, 'utf8'))
    } catch (err) {
      throw new Error(`zra.config.json illisible (${file}) : ${err.message}`)
    }
  }

  const cfg = { ...DEFAULTS, ...fromFile, ...envOverrides(), ...overrides }
  // Fusion d'un niveau : `"zedControl": { "enabled": true }` ne doit pas effacer le reste.
  cfg.zedControl = { ...DEFAULTS.zedControl, ...fromFile.zedControl, ...overrides.zedControl }
  if (process.env.ZRA_ZED_CONTROL) cfg.zedControl.enabled = process.env.ZRA_ZED_CONTROL !== '0'
  if (process.env.ZRA_ZED_KEYBOARD) cfg.zedControl.keyboard = process.env.ZRA_ZED_KEYBOARD
  cfg.auth = { ...DEFAULTS.auth, ...fromFile.auth, ...overrides.auth }
  cfg.auth.file = cfg.auth.file ? abs(cfg.auth.file) : null

  cfg.zedDb = abs(cfg.zedDb) || ZED.db
  cfg.zedSettings = abs(cfg.zedSettings) || ZED.settings
  cfg.zedKeymap = abs(cfg.zedKeymap) || keymapBeside(cfg.zedSettings)
  cfg.staticDir = abs(cfg.staticDir)
  cfg.logFile = cfg.logFile === null ? null : abs(cfg.logFile)
  cfg.daemonLogFile = cfg.daemonLogFile ? abs(cfg.daemonLogFile) : null
  // `".zra/tls/zra.crt"` (scripts/cert.ps1) : relatif à la racine du dépôt.
  if (cfg.tls?.cert && cfg.tls?.key) cfg.tls = { ...cfg.tls, cert: abs(cfg.tls.cert), key: abs(cfg.tls.key) }
  cfg.allowedOrigins = (cfg.allowedOrigins || []).map((o) => String(o).replace(/\/+$/, ''))
  cfg.configFile = existsSync(file) ? file : null

  validate(cfg)
  return cfg
}

function validate(cfg) {
  if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) {
    throw new Error(`port invalide : ${cfg.port}`)
  }
  if (cfg.tls && (!cfg.tls.cert || !cfg.tls.key)) {
    throw new Error('tls : "cert" et "key" sont requis ensemble')
  }
  if (!['mock', 'acp', 'uia', 'auto'].includes(cfg.injection)) {
    throw new Error(`injection inconnue : ${cfg.injection}`)
  }
  if (cfg.zedControl?.recipes && typeof cfg.zedControl.recipes !== 'object') {
    throw new Error('zedControl.recipes : objet attendu')
  }
  if (cfg.zedControl && !['auto', ...KEYBOARD_BACKENDS].includes(cfg.zedControl.keyboard)) {
    throw new Error(`zedControl.keyboard inconnu : ${cfg.zedControl.keyboard} (auto, ${KEYBOARD_BACKENDS.join(', ')})`)
  }
  if (cfg.zedControl && typeof cfg.zedControl.unsafeFocus !== 'boolean') {
    throw new Error('zedControl.unsafeFocus : booléen attendu')
  }
}
