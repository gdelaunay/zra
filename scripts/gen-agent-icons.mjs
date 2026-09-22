// Génère zra-client/js/agent-icons.js à partir des icônes d'agents de Zed.
//   curl -sL https://raw.githubusercontent.com/zed-industries/zed/main/assets/icons/ai_claude.svg -o .cache/ai_claude.svg
//   node scripts/gen-agent-icons.mjs
//
// Les icônes sont rendues en monochrome (`currentColor`), comme dans Zed :
// les `fill` d'origine des marques sont retirés, la couleur vient du thème.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

const CACHE = '.cache'
const OUT = 'zra-client/js/agent-icons.js'

// id interne -> fichier d'icône Zed
const ICONS = {
  claude: 'ai_claude',
  anthropic: 'ai_anthropic',
  gemini: 'ai_gemini',
  openai: 'ai_open_ai',
  zed: 'ai_zed',
  mistral: 'ai_mistral',
  xai: 'ai_x_ai',
  opencode: 'ai_open_code',
}

/** Les icônes de Zed mélangent `<path>` et `<rect>` (Mistral) : on garde les deux. */
function parse(svg) {
  const viewBox = /viewBox="([^"]+)"/.exec(svg)?.[1] || '0 0 16 16'
  const shapes = []
  for (const m of svg.matchAll(/<(path|rect)\b([^>]*?)\/?>/g)) {
    const [, tag, attrs] = m
    const fill = /\sfill="([^"]+)"/.exec(attrs)?.[1]
    if (fill === 'none') continue
    if (tag === 'path') {
      const d = /\sd="([^"]+)"/.exec(attrs)?.[1]
      if (!d) continue
      const rule = /fill-rule="([^"]+)"/.exec(attrs)?.[1]
      shapes.push(rule ? { d, rule } : { d })
    } else {
      const num = (name) => Number(new RegExp(`\\s${name}="([^"]+)"`).exec(attrs)?.[1] ?? 0)
      shapes.push({ rect: [num('x'), num('y'), num('width'), num('height')] })
    }
  }
  return { viewBox, shapes }
}

function main() {
  const out = {}
  for (const [id, file] of Object.entries(ICONS)) {
    const path = `${CACHE}/${file}.svg`
    if (!existsSync(path)) {
      console.error(`manquant: ${path}`)
      process.exit(1)
    }
    const parsed = parse(readFileSync(path, 'utf8'))
    if (!parsed.shapes.length) { console.error(`aucune forme dans ${path}`); process.exit(1) }
    out[id] = parsed
  }

  const header = `// Généré par scripts/gen-agent-icons.mjs — ne pas éditer à la main.
// Source : icônes d'agents de Zed (zed-industries/zed, assets/icons/ai_*.svg),
// rendues en monochrome via \`currentColor\`. Marques citées à fin d'identification
// de l'agent, comme le fait le panel de Zed.

export const AGENT_GLYPHS = ${JSON.stringify(out, null, 2)}
`
  writeFileSync(OUT, header)
  const bytes = Buffer.byteLength(header)
  console.log(`${OUT}: ${Object.keys(out).length} icônes, ${(bytes / 1024).toFixed(1)} Ko`)
}

main()
