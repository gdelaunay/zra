// « Tester l'écoute » (onboarding/console du tray) : sonde best-effort, ne
// crée AUCUNE règle de pare-feu. Renvoie des données JSON (le message utilisateur
// est construit par la page) :
//
//   node scripts/lib/listen-test.mjs --port 7777 [--host 0.0.0.0] [--no-bind]
//
// - bind : ouvre brièvement le port (sous Windows cela peut déclencher l'invite
//   système « autoriser l'accès »), puis le referme. « Joignable depuis
//   l'extérieur » ne se teste pas fiablement en local : le bind est un indice.
//   Port déjà pris (le service écoute) → inUse, pas une erreur.
// - pare-feu : état lu sans élévation quand possible (ufw/firewalld actifs via
//   systemctl ; règles lisibles seulement avec les droits). Windows : l'invite
//   au bind est le signal principal, les règles sont sondées au mieux.

import { spawnSync } from 'node:child_process'
import net from 'node:net'

const arg = (name, dflt = null) => {
  const i = process.argv.indexOf(name)
  return i > -1 ? process.argv[i + 1] : dflt
}
const port = Number(arg('--port', '7777'))
const host = arg('--host', '0.0.0.0')
const noBind = process.argv.includes('--no-bind')

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 8000, windowsHide: true })
  return { ok: r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}` }
}

/** État du pare-feu, best-effort. portAllowed : true/false/null (illisible). */
function probeFirewall() {
  if (process.platform === 'win32') {
    const state = run('netsh', ['advfirewall', 'show', 'allprofiles', 'state'])
    const active = /\bON\b/i.test(state.out)
    // Règles entrantes :cherche le port + une action autoriser (localisé :
    // Allow/Autoriser). Heuristique — null si on ne peut pas conclure.
    const rules = run('netsh', ['advfirewall', 'firewall', 'show', 'rule', 'name=all', 'dir=in'])
    let portAllowed = null
    if (rules.ok) {
      const blocks = rules.out.split(/\r?\n\r?\n/)
      const hit = blocks.find((b) => new RegExp(`(^|\\D)${port}(\\D|$)`).test(b) && /(Allow|Autoriser)/i.test(b))
      if (hit) portAllowed = true
    }
    return { type: 'windows-firewall', active, portAllowed }
  }
  // Linux : ufw ou firewalld actif ? (systemctl is-active est lisible sans root)
  const ufw = run('systemctl', ['is-active', 'ufw']).out.trim() === 'active'
  const firewalld = run('systemctl', ['is-active', 'firewalld']).out.trim() === 'active'
  if (ufw) {
    const status = run('ufw', ['status'])
    let portAllowed = null
    if (status.ok) portAllowed = new RegExp(`^\\s*${port}/(tcp|udp)\\s+ALLOW`, 'm').test(status.out)
    return { type: 'ufw', active: true, portAllowed }
  }
  if (firewalld) {
    const ports = run('firewall-cmd', ['--list-ports'])
    let portAllowed = null
    if (ports.ok) portAllowed = new RegExp(`(^|\\s)${port}/(tcp|udp)(\\s|$)`).test(ports.out)
    return { type: 'firewalld', active: true, portAllowed }
  }
  return { type: null, active: false, portAllowed: null }
}

/** Bind bref du port. inUse si déjà pris (le service écoute). */
function bindTest() {
  return new Promise((resolve) => {
    if (noBind) return resolve({ bound: false, inUse: false, skipped: true })
    const srv = net.createServer()
    srv.once('error', (err) => resolve({ bound: false, inUse: err.code === 'EADDRINUSE', error: err.code }))
    srv.listen(port, host, () => {
      // Laisse l'invite Windows apparaître, puis referme : le port reste libre
      // pour le service que le tray lancera ensuite.
      setTimeout(() => srv.close(() => resolve({ bound: true, inUse: false })), 1200)
    })
  })
}

const firewall = probeFirewall()
const bind = await bindTest()
console.log(JSON.stringify({ platform: process.platform, port, host, firewall, ...bind }))