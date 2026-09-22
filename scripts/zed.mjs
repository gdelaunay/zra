#!/usr/bin/env node
// Mettre au point le pilotage clavier de Zed — lot C, test réel.
//
//   npm run zed -- probe                       fenêtres Zed et arbre UIA (aucune touche)
//   npm run zed -- recipes                     recettes en vigueur (défauts + zra.config.json)
//   npm run zed -- try newThread               simulation : fenêtre et touches résolues, rien envoyé
//   npm run zed -- try openThread --candidate --title "Mon thread" --apply
//   npm run zed -- try --steps '[{"keys":"ctrl+shift+/"}]' --apply
//
// Sans `--apply`, rien n'est envoyé : le script résout la fenêtre et chaque
// touche, et s'arrête là. Avec `--apply`, un compte à rebours laisse le temps
// de lâcher clavier et souris ; si la fenêtre Zed perd le premier plan en
// cours de route, la recette s'interrompt d'elle-même.

import { loadConfig } from '../zra-daemon/config.js'
import {
  CANDIDATE_RECIPES, DEFAULT_RECIPES, KeyboardRunner, checkRecipe, expandRecipe,
} from '../zra-daemon/zed/driver.js'

function parseArgs(argv) {
  const out = { command: argv[0] ?? 'help', recipe: null, apply: false, candidate: false, vars: {}, steps: null, window: undefined }
  const rest = argv.slice(1)
  if (out.command === 'try' && rest[0] && !rest[0].startsWith('-')) out.recipe = rest.shift()
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (a === '--apply') out.apply = true
    else if (a === '--candidate') out.candidate = true
    else if (a === '--title') out.vars.title = rest[++i]
    else if (a === '--agent') { out.vars.agent = rest[++i]; out.vars.agentName = out.vars.agent }
    else if (a === '--text') out.vars.text = rest[++i]
    else if (a === '--window') out.window = rest[++i]
    else if (a === '--steps') out.steps = JSON.parse(rest[++i])
    else throw new Error(`option inconnue : ${a}`)
  }
  return out
}

const USAGE = `npm run zed -- <commande>

  probe                      fenêtres Zed ouvertes, taille de leur arbre UIA
  recipes                    recettes en vigueur et pistes candidates
  try <recette> [options]    essayer une recette (simulation sans --apply)
  try --steps '<json>'       essayer une suite d'étapes ad hoc

  --apply                    envoyer réellement les touches
  --candidate                prendre la piste candidate plutôt que la recette en vigueur
  --title <t> --agent <id> --text <t>   variables de la recette
  --window <texte>           fenêtre Zed dont le titre contient ce texte
`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const config = await loadConfig()
  const zc = config.zedControl
  const recipes = { ...DEFAULT_RECIPES, ...zc.recipes }
  const runner = new KeyboardRunner({ timeoutMs: 120_000 })

  if (opts.command === 'probe') {
    const res = await runner.run({ op: 'probe' })
    if (!res.windows?.length) return console.log('aucune fenêtre Zed ouverte')
    for (const w of res.windows) {
      console.log(`« ${w.title} » (pid ${w.pid}) — arbre UIA : ${w.uiaDescendants} élément(s)` +
        (w.uiaDescendants === 0 ? ' → pilotage au clavier uniquement (risque 🟠3)' : ''))
    }
    return
  }

  if (opts.command === 'recipes') {
    console.log(`pilotage ${zc.enabled ? 'ACTIVÉ' : 'désactivé'} dans le daemon (zedControl.enabled)\n`)
    for (const [name, steps] of Object.entries(recipes)) {
      console.log(`${name}${zc.recipes?.[name] !== undefined ? '  (zra.config.json)' : ''}`)
      console.log(steps ? steps.map((s) => `  ${JSON.stringify(s)}`).join('\n') : '  — non établie')
    }
    console.log('\npistes candidates (--candidate) :')
    for (const [name, steps] of Object.entries(CANDIDATE_RECIPES)) {
      console.log(name)
      console.log(steps.map((s) => `  ${JSON.stringify(s)}`).join('\n'))
    }
    return
  }

  if (opts.command === 'try') {
    let steps = opts.steps
    let name = 'ad hoc'
    if (!steps) {
      if (!opts.recipe) throw new Error('recette à essayer : try <recette>, ou --steps')
      name = opts.recipe
      steps = opts.candidate ? CANDIDATE_RECIPES[name] : recipes[name]
      if (!steps) throw new Error(`recette « ${name} » ${opts.candidate ? 'sans piste candidate' : 'non établie (essayer --candidate)'}`)
    }
    const expanded = expandRecipe(checkRecipe(name, steps), { text: 'message de test ZRA', title: '', agent: '', agentName: '', ...opts.vars })
    console.log(`recette ${name} :`)
    for (const s of expanded) console.log(`  ${JSON.stringify(s)}`)

    const request = { op: 'run', steps: expanded, window: opts.window ?? zc.window, stepDelayMs: zc.stepDelayMs }
    const dry = await runner.run({ ...request, dryRun: true })
    console.log(`\n✓ ${dry.log[0]} — touches résolues`)
    if (!opts.apply) return console.log('simulation : rien envoyé. Relancer avec --apply pour envoyer les touches.')

    for (let n = 3; n > 0; n--) {
      process.stdout.write(`\renvoi dans ${n} s — lâcher clavier et souris…`)
      await sleep(1000)
    }
    process.stdout.write('\n')
    const res = await runner.run(request)
    console.log(`✓ envoyé :\n  ${res.log.slice(1).join('\n  ')}`)
    return
  }

  console.log(USAGE)
}

main().catch((err) => {
  console.error(`✗ ${err.message}`)
  process.exit(1)
})
