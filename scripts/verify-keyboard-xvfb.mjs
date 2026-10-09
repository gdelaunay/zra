// Vérification RÉELLE du backend xdotool sous Xvfb (portage Linux, étape 5).
//
// Ce que ça prouve (Xvfb :99, sans WM — sortie recopiée dans la note d'avancement) :
//   - l'énumération des fenêtres d'un pid (xdotool search --pid --name)
//   - la lecture des titres (getwindowname) et la règle de projet
//   - windowactivate/windowfocus contre une vraie fenêtre X
//   - les accords (key) et le texte (type) : les KeyPress sont relevés par xev
//   - le garde-fou « autre fenêtre au premier plan » et sa tolérance sans WM
// Ce que ça ne prouve PAS : le titre réel des fenêtres de Zed sous X11, ni
// keyboard.ps1, ni le comportement contre Zed (à faire sur la cible Debian/KDE/X11).
//
// `pgrep` seul est bouchonné (la fenêtre de test n'est pas un processus Zed —
// et rien ne doit ressembler à `zed-editor` sur ce poste). TOUT le reste passe
// par le vrai `execFile` → le vrai xdotool → le vrai serveur X.
//
// Usage : DISPLAY=:99 node scripts/verify-keyboard-xvfb.mjs <pid-fenêtre> <id-fenêtre>

import { XdotoolKeyboard } from '../zra-daemon/zed/keyboard.js'

const [pid, wid, title = 'zra — verify-keyboard-xvfb.mjs'] = [process.argv[2], process.argv[3], process.argv[4]]
if (!pid || !wid) {
  console.error('usage : DISPLAY=:99 node scripts/verify-keyboard-xvfb.mjs <pid> <window-id> [titre]')
  process.exit(2)
}

class TestKeyboard extends XdotoolKeyboard {
  // Seule entorse : l'énumération des PROCESSUS (pas une fenêtre de Zed ici).
  // `windows()` enchaîne pgrep → search → getwindowname ; on remplace pgrep.
  async exec(cmd, args) {
    if (cmd === 'pgrep') return `${pid}\n`
    return super.exec(cmd, args)
  }
}

const k = new TestKeyboard({ timeoutMs: 10_000 })
const log = console.log

// 1. probe : énumération réelle
const probe = await k.run({ op: 'probe' })
log('probe →', JSON.stringify(probe.windows))

// 2. règle de projet sur le titre réel
const res = await k.run({
  op: 'run',
  project: 'zra',
  steps: [{ keys: 'ctrl+shift+p' }, { wait: 50 }, { text: 'bonjour ZRA' }, { keys: 'enter' }],
  stepDelayMs: 40,
})
log('run →', JSON.stringify(res, null, 2))

// 3. le projet est reconnu sur le titre
log('matchesProject(« zra — … », « zra ») →', XdotoolKeyboard.matchesProject(title, 'zra'))
