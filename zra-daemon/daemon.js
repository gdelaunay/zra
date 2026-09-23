// Assemblage du daemon. Exporté comme fonction pour que les tests le lancent
// en process, sans passer par la ligne de commande.

import { readFile } from 'node:fs/promises'
import { unwatchFile, watchFile } from 'node:fs'
import { join } from 'node:path'

import { ROOT } from './config.js'
import { ShimRegistry } from './shim-registry.js'
import { ThreadsIndex } from './threads-index.js'
import { ThreadStates } from './thread-state.js'
import { RingBuffers } from './ring-buffer.js'
import { createBackend } from './inject/backend.js'
import { Hub } from './hub.js'
import { ShimHost } from './shim-link.js'
import { SessionLoader } from './session-loader.js'
import { ZedDriver, KeyboardRunner, ZedCli } from './zed/driver.js'
import { ZedControl } from './zed/control.js'
import { createServers } from './server.js'
import { TunnelWatch, bindAddresses, resolveBinds } from './net.js'
import { ZedPresence, machineName, osLabel, readAgents } from './agents.js'
import { injectionLog, logger } from './log.js'

const log = logger('daemon')

async function version() {
  try {
    const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
    return pkg.version || '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/**
 * Identité du poste, telle qu'envoyée dans le message `machine`.
 *
 * `version` ne doit **jamais** se terminer par `-mock` : c'est ce suffixe qui
 * fait apparaître la barre de dev de la PWA (protocole §4).
 */
class Machine {
  constructor({ name, os, version, agents }) {
    this.name = name
    this.os = os
    this.version = version
    this.agents = agents
    this.zedRunning = false
  }

  describe() {
    return {
      name: this.name,
      os: this.os,
      version: this.version,
      zedRunning: this.zedRunning,
      agents: this.agents,
    }
  }
}

/** @param {object} config résultat de `loadConfig()` */
export async function startDaemon(config) {
  // `config.interfaces` : interfaces factices, pour les tests du suivi du tunnel.
  const { addresses, tunnel } = resolveBinds(config, config.interfaces?.())

  const shims = new ShimRegistry()
  const threads = new ThreadsIndex({ file: config.zedDb, pollMs: config.pollMs, shims })
  const states = new ThreadStates()
  const rings = new RingBuffers({ size: config.ringSize })
  const record = injectionLog(config.logFile)

  const machine = new Machine({
    name: machineName(config.machineName),
    os: osLabel(),
    version: await version(),
    agents: await readAgents(config.zedSettings),
  })

  // Les shims sont la source de tout ce qui est vivant (lot B) : flux ACP
  // verbatim, tour, file d'attente, permissions.
  const host = new ShimHost({ shims, threads, states })

  // Relecture d'un thread fermé : le daemon relance l'agent en client ACP.
  const loader = new SessionLoader({
    threads,
    settingsFile: config.zedSettings,
    agentCommands: config.agentCommands,
    ttlMs: config.historyTtlMs,
    timeoutMs: config.historyTimeoutMs,
  })

  // Pilotage de la fenêtre Zed (lot C) : ouvrir une session, rouvrir un thread,
  // backend `uia`. Désactivé par défaut ; `zedControl.runner` sert aux tests.
  const zc = config.zedControl ?? {}
  const driver = new ZedDriver({
    runner: zc.runner ?? new KeyboardRunner(),
    enabled: Boolean(zc.enabled),
    window: zc.window ?? null,
    stepDelayMs: zc.stepDelayMs,
    recipes: zc.recipes ?? {},
    dryRun: Boolean(zc.dryRun),
    // `cli` : chemin de la CLI de Zed (config), ou lanceur factice (tests).
    cli: typeof zc.cli === 'object' && zc.cli ? zc.cli : new ZedCli(zc.cli ? { command: zc.cli } : {}),
    windowWaitMs: zc.windowWaitMs,
    log: logger('zed'),
  })
  const control = new ZedControl({
    driver, host, shims, threads,
    agents: () => machine.agents,
    timeoutMs: zc.timeoutMs,
    log: logger('zed'),
  })

  // Le backend publie ses événements par le hub, qui n'existe pas encore :
  // liaison tardive plutôt qu'une dépendance circulaire à l'import.
  /** @type {Hub} */
  let hub
  const backend = createBackend(config.injection, {
    states,
    threads,
    host,
    control,
    confirmMs: config.injectConfirmMs,
    emit: (threadId, update) => hub.publish(threadId, update),
  })

  hub = new Hub({
    config, threads, states, rings, shims, backend, machine, recordInjection: record, loader,
    zed: control, covers: (sessionId) => host.covers(sessionId),
  })

  host.on('update', ({ threadId, update, at }) => hub.publish(threadId, update, at))
  host.on('permission_resolved', (p) => hub.permissionResolved(p.threadId, p))
  host.on('permission_expired', ({ threadId, requestId }) => hub.permissionExpired(threadId, requestId))
  // Un thread qui reprend vie a pu changer depuis sa mise en cache.
  host.on('session', ({ sessionId }) => loader.invalidate(sessionId))
  // Zed recharge la session : le replay va tout redire, le ring repart de zéro.
  host.on('replay', ({ threadId }) => hub.restart(threadId))

  threads.start()

  const presence = new ZedPresence({ intervalMs: config.zedProbeMs })
  presence.onChange((running) => {
    machine.zedRunning = running
    log.info(running ? 'Zed est lancé' : 'Zed est fermé')
    hub.broadcast({ type: 'machine', ...machine.describe() })
  })
  presence.start()

  // Le registry d'agents peut changer sans redémarrage (édition de settings.json).
  const agentsTimer = setInterval(async () => {
    const next = await readAgents(config.zedSettings)
    if (JSON.stringify(next) === JSON.stringify(machine.agents)) return
    machine.agents = next
    hub.broadcast({ type: 'machine', ...machine.describe() })
  }, Math.max(config.zedProbeMs * 4, 10_000))
  agentsTimer.unref?.()

  const startedAt = new Date().toISOString()
  /** État du poste pour `GET /status` (loopback) — ce que `npm run setup` affiche. */
  const describeStatus = () => {
    const counts = { live: 0, closed: 0, unknown: 0 }
    for (const t of threads.threads) counts[t.state] = (counts[t.state] ?? 0) + 1
    return {
      version: machine.version,
      startedAt,
      injection: backend.name,
      zedRunning: machine.zedRunning,
      clients: hub.clients.size,
      threads: counts,
      degraded: threads.degraded ?? null,
      shims: [...shims.shims.values()].map((s) => ({
        shimId: s.shimId,
        agentId: s.agentId,
        since: s.since,
        loadSession: Boolean(s.capabilities?.loadSession),
        sessions: [...s.sessions].map((sessionId) => ({
          sessionId,
          threadId: threads.getBySession(sessionId)?.threadId ?? null,
        })),
      })),
    }
  }

  const servers = await createServers({
    config,
    addresses,
    onConnection: (conn) => hub.attach(conn),
    onShim: (conn) => host.attach(conn),
    status: () => describeStatus(),
  })
  await servers.listen()

  const scheme = servers.secure ? 'https' : 'http'
  const wsScheme = servers.secure ? 'wss' : 'ws'
  const announce = (a) => log.info(`écoute ${scheme}://${a}:${config.port}  (${wsScheme}://${a}:${config.port}/ws)`)
  log.info(`poste « ${machine.name} » — ${threads.threads.length} thread(s) dans l'index`)
  for (const a of addresses) announce(a)
  if (tunnel) log.info(`tunnel : ${tunnel.name} (${tunnel.address}, ${tunnel.how})`)
  else if (config.requireTunnel) log.warn('tunnel absent : écoute en loopback seule en attendant WireGuard (--wait-tunnel)')
  else log.warn('aucun tunnel : écoute en loopback seule — mode dev')

  // Le tunnel vit sa vie : désactivé, réactivé, réécrit. Le daemon suit, sans
  // jamais s'arrêter — les shims du poste ont besoin de sa loopback.
  const watch = new TunnelWatch(config, { intervalMs: config.tunnelPollMs, initial: tunnel, interfaces: config.interfaces })
  let rebinding = Promise.resolve()
  watch.onChange((next, previous) => {
    rebinding = rebinding.then(async () => {
      if (next) log.info(`tunnel ${previous ? 'changé' : 'apparu'} : ${next.name} (${next.address}, ${next.how})`)
      else log.warn(`tunnel ${previous?.name ?? ''} disparu : écoute en loopback seule jusqu'à son retour`)
      try {
        const { opened, closed } = await servers.setAddresses(bindAddresses(config, next))
        for (const a of closed) log.info(`écoute ${a} fermée`)
        for (const a of opened) announce(a)
      } catch (err) {
        log.warn(`écoute du tunnel impossible : ${err.message}`)
      }
      hub.broadcast({ type: 'machine', ...machine.describe() })
    })
  })
  // En dev (`--no-tunnel`), rien à suivre ; et lire les interfaces n'est pas
  // gratuit sous Windows (25 à 60 ms, synchrone).
  if (config.requireTunnel || config.waitTunnel || config.bindInterface || config.bindCidr) watch.start()

  // Certificat : renouvelé tous les 60 à 90 jours (Let's Encrypt). Relu à chaud,
  // et son échéance surveillée : un certificat expiré, c'est une PWA qui ne
  // s'ouvre plus du tout.
  const tlsWatch = config.tls ? watchTls({ config, servers }) : null
  log.info(`injection : backend ${backend.name}${backend.ownsQueue ? ' (file tenue par le shim)' : ''}`)
  if (driver.enabled) {
    log.warn(`pilotage de Zed au clavier ACTIVÉ${driver.dryRun ? ' (simulation, aucune touche envoyée)' : ''} — ` +
      `recettes : ${Object.keys(driver.recipes).filter((k) => driver.has(k)).join(', ') || 'aucune'}`)
  } else {
    log.info('pilotage de Zed désactivé : new_thread et réouverture de threads indisponibles')
    if (backend.name === 'uia' || backend.name === 'auto') {
      log.warn(`backend ${backend.name} sans pilotage de Zed : l'injection clavier échouera (zedControl.enabled)`)
    }
  }
  if (!config.serveStatic) log.info('statiques désactivées : le client est servi ailleurs')
  log.info(`origines autorisées : ${servers.allowedOrigins.join(', ') || '(aucune — seuls les clients non-navigateur pourront se connecter)'}`)
  if (!servers.secure) {
    log.warn('HTTP en clair : pas de service worker, pas d’installation PWA, pas de Web Push (contexte non sécurisé)')
  }

  return {
    config, hub, threads, states, rings, shims, backend, servers, machine, presence,
    host, loader, control, driver,
    addresses, tunnel, watch,
    port: config.port,

    async close() {
      watch.stop()
      tlsWatch?.stop()
      await rebinding
      clearInterval(agentsTimer)
      presence.stop()
      threads.stop()
      host.close()
      loader.close()
      backend.close?.()
      for (const client of hub.clients.values()) client.conn.close(1001)
      await servers.close()
    },
  }
}

/** Jours restants avant expiration en deçà desquels le journal alerte. */
const TLS_WARN_DAYS = 20

function checkExpiry(tls) {
  if (!tls?.validTo) return
  const days = Math.floor((tls.validTo.getTime() - Date.now()) / 86_400_000)
  const names = tls.names.join(', ') || 'certificat'
  if (days < 0) log.error(`${names} : certificat EXPIRÉ depuis ${-days} j — la PWA ne s'ouvrira plus en HTTPS`)
  else if (days < TLS_WARN_DAYS) log.warn(`${names} : certificat valable encore ${days} j — le renouveler (DEPLOY.md)`)
  else log.info(`${names} : certificat valable jusqu'au ${tls.validTo.toISOString().slice(0, 10)}`)
}

/**
 * Relit le certificat quand ses fichiers changent (sondage : `fs.watch` perd
 * les remplacements de fichier sous Windows), et vérifie chaque jour l'échéance.
 */
function watchTls({ config, servers, intervalMs = 30_000 }) {
  checkExpiry(servers.tls)
  let pending = null
  const reload = () => {
    clearTimeout(pending)
    // Clé et certificat sont écrits l'un après l'autre : on laisse finir.
    pending = setTimeout(async () => {
      try {
        const tls = await servers.reloadTls()
        log.info('certificat rechargé')
        checkExpiry(tls)
      } catch (err) {
        log.warn(`certificat illisible, l'ancien reste en place : ${err.message}`)
      }
    }, 2000)
    pending.unref?.()
  }
  const files = [config.tls.cert, config.tls.key]
  for (const f of files) watchFile(f, { interval: intervalMs }, reload)
  const daily = setInterval(() => checkExpiry(servers.tls), 86_400_000)
  daily.unref?.()
  return {
    stop() {
      for (const f of files) unwatchFile(f, reload)
      clearInterval(daily)
      clearTimeout(pending)
    },
  }
}
