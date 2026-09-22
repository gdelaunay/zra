// Configuration du daemon : `zra.config.json` à la racine, surchargeable par
// variables d'environnement (pratique pour les tests et le mode dev).

import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseJsonc } from './jsonc.js'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const LOCALAPPDATA = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
const APPDATA = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')

/** Chemins par défaut de Zed sur la machine cible (Windows). */
export const ZED = {
  db: join(LOCALAPPDATA, 'Zed', 'db', '0-stable', 'db.sqlite'),
  settings: join(APPDATA, 'Zed', 'settings.json'),
}

export const DEFAULTS = {
  /** Port unique : statiques (si activées) + WebSocket `/ws`. */
  port: 7777,

  // --- écoute (spec §9) -----------------------------------------------------
  /** Nom de l'adaptateur WireGuard, ex. "ZRA". `null` => détection par motif. */
  bindInterface: null,
  /** Repli de détection par plage, ex. "10.0.0.0/24". */
  bindCidr: null,
  /** Toujours vrai en pratique : le mode dev passe par la loopback. */
  bindLoopback: true,
  /** Refus de démarrer si aucune interface de tunnel n'est trouvée. */
  requireTunnel: true,

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

  // --- sources --------------------------------------------------------------
  zedDb: null,
  zedSettings: null,
  /** Poll de l'index des threads (spec §3.2). */
  pollMs: 2000,
  /** Poll de présence de Zed. */
  zedProbeMs: 5000,
  /** Ring buffer par thread live (spec §5.1). */
  ringSize: 2000,

  /** Backend d'injection (spec §6). `acp` par défaut ; `uia`/`auto` en lot C. */
  injection: 'acp',

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

  /** Journal d'injections (spec §9). */
  logFile: join(LOCALAPPDATA, 'zra', 'injections.log'),
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
  if (e.ZRA_SERVE_STATIC) out.serveStatic = e.ZRA_SERVE_STATIC !== '0'
  if (e.ZRA_STATIC_DIR) out.staticDir = e.ZRA_STATIC_DIR
  if (e.ZRA_ALLOWED_ORIGINS) out.allowedOrigins = e.ZRA_ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
  if (e.ZRA_ZED_DB) out.zedDb = e.ZRA_ZED_DB
  if (e.ZRA_ZED_SETTINGS) out.zedSettings = e.ZRA_ZED_SETTINGS
  if (e.ZRA_POLL_MS) out.pollMs = Number(e.ZRA_POLL_MS)
  if (e.ZRA_INJECTION) out.injection = e.ZRA_INJECTION
  if (e.ZRA_LOG_FILE) out.logFile = e.ZRA_LOG_FILE || null
  if (e.ZRA_MACHINE_NAME) out.machineName = e.ZRA_MACHINE_NAME
  return out
}

/** Résout un chemin relatif par rapport à la racine du dépôt. */
function abs(p) {
  if (!p) return p
  return isAbsolute(p) ? p : join(ROOT, p)
}

export async function loadConfig({ file = process.env.ZRA_CONFIG || join(ROOT, 'zra.config.json'), overrides = {} } = {}) {
  let fromFile = {}
  if (existsSync(file)) {
    try {
      fromFile = parseJsonc(await readFile(file, 'utf8'))
    } catch (err) {
      throw new Error(`zra.config.json illisible (${file}) : ${err.message}`)
    }
  }

  const cfg = { ...DEFAULTS, ...fromFile, ...envOverrides(), ...overrides }

  cfg.zedDb = abs(cfg.zedDb) || ZED.db
  cfg.zedSettings = abs(cfg.zedSettings) || ZED.settings
  cfg.staticDir = abs(cfg.staticDir)
  cfg.logFile = cfg.logFile === null ? null : abs(cfg.logFile)
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
  if (cfg.injection === 'uia' || cfg.injection === 'auto') {
    // Garde-fou honnête : l'UI Automation arrive en lot C. Mieux vaut le dire au
    // démarrage que d'échouer au premier envoi.
    throw new Error(`backend d'injection "${cfg.injection}" pas encore implémenté (lot C) — utiliser "acp"`)
  }
}
