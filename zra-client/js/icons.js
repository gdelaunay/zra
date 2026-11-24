// Jeu d'icônes, trait 1.6px sur grille 24 — même famille que celles de Zed (Lucide).
// Tracés en partie repris de Lucide : licence ISC, voir THIRD_PARTY_NOTICES.md.
// Les icônes d'agents viennent de Zed : SVG du registre ACP transmis par le
// daemon (noteRegistryIcons) et glyphes embarqués (agent-icons.js).

import { AGENT_GLYPHS } from './agent-icons.js'

const P = {
  'chevron-right': 'm9 18 6-6-6-6',
  'chevron-down': 'm6 9 6 6 6-6',
  'chevron-up': 'm18 15-6-6-6 6',
  'chevron-left': 'm15 18-6-6 6-6',
  'chevron-up-down': 'm8 9 4-4 4 4M8 15l4 4 4-4',
  'arrow-left': 'M19 12H5M12 19l-7-7 7-7',
  'arrow-up': 'M12 19V5M5 12l7-7 7 7',
  'arrow-down': 'M12 5v14M19 12l-7 7-7-7',
  'search': 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm10 2-4.35-4.35',
  'settings': 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M2 14h4M10 8h4M18 16h4',
  'stop': 'M7 7h10v10H7z',
  'x': 'M18 6 6 18M6 6l12 12',
  'x-circle': 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM15 9l-6 6M9 9l6 6',
  'check': 'M20 6 9 17l-5-5',
  'plus': 'M12 5v14M5 12h14',
  'lock': 'M7 11V7a5 5 0 0 1 10 0v4M5 11h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2Z',
  'trash': 'M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6',
  'file-text': 'M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Zm-1 0v5h5M9 13h6M9 17h4',
  'pencil': 'M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z',
  'move': 'M8 3 4 7l4 4M4 7h12M16 21l4-4-4-4M20 17H8',
  'terminal': 'm4 17 6-6-6-6M12 19h8',
  'lightbulb': 'M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2Z',
  'globe': 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20ZM2 12h20M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20',
  'shuffle': 'M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5',
  'wrench': 'M14.7 6.3a4 4 0 0 0 5.2 5.2l-8.6 8.6a2.8 2.8 0 1 1-4-4l8.6-8.6a4 4 0 0 1-1.2-1.2Z',
  'folder': 'M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9L9.6 3.9A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z',
  'alert-triangle': 'M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z',
  'shield': 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z',
  'list': 'M4 6h16M4 12h16M4 18h10',
  'more': 'M5 12h.01M12 12h.01M19 12h.01',
  'mic': 'M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3ZM19 10v2a7 7 0 0 1-14 0v-2M12 19v3',
  'server': 'M4 4h16v6H4zM4 14h16v6H4zM7 7h.01M7 17h.01',
  'refresh': 'M20.5 12a8.5 8.5 0 1 1-2.5-6M21 3v5h-5',
  'copy': 'M9 9h11v11H9zM15 9V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h4',
  'link': 'M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1',
  'palette': 'M12 21a9 9 0 1 1 0-18c5 0 9 3.6 9 8 0 2.2-1.8 4-4 4h-2a2 2 0 0 0-1.4 3.4A2 2 0 0 1 12 21ZM7.5 10.5h.01M10.5 7h.01M15 7.5h.01',
  'clock': 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20ZM12 6v6l4 2',
  'hash': 'M4 9h16M4 15h16M10 3 8 21M16 3l-2 18',
  'message': 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z',
  'sparkles': 'm12 3 1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9ZM19 15l.8 2.2 2.2.8-2.2.8L19 21l-.8-2.2-2.2-.8 2.2-.8Z',
  'loader': 'M12 2v4M12 18v4M4.9 4.9l2.8 2.8M16.3 16.3l2.8 2.8M2 12h4M18 12h4M4.9 19.1l2.8-2.8M16.3 7.7l2.8-2.8',
  'circle': 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z',
  'circle-dot': 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  'zap': 'M13 2 4 14h7l-1 8 9-12h-7Z',
  'plug': 'M12 22v-5M9 2v6M15 2v6M7 8h10v3a5 5 0 0 1-10 0Z',
  'eye': 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7ZM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  'book': 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z',
  'archive': 'M3 4h18v4H3zM5 8v12h14V8M10 12h4',
  'coffee': 'M10 2v2M14 2v2M6 2v2M16 8a1 1 0 0 1 1 1v8a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1h14a4 4 0 1 1 0 8h-1',
}

// Icônes Zed exactes (grille 16, trait 1.2), extraites de assets/icons via reference/.
// Utilisées là où la fiche 0.5 les nomme : barre du bas, worktree, spinner, coche double.
const ZED = {
  "compact": "<path d=\"M10 10L14 14M13.2 10H10V13.2\" stroke=\"currentColor\" stroke-width=\"1.2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/> <path d=\"M2.8 10H6V13.2M6 10L2 14\" stroke=\"currentColor\" stroke-width=\"1.2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/> <path d=\"M13.2 6H10V2.8M10 6L14 2\" stroke=\"currentColor\" stroke-width=\"1.2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/> <path d=\"M2.8 6H6V2.8M6 6L2 2\" stroke=\"currentColor\" stroke-width=\"1.2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>",
  "threads_sidebar_right_open": "<rect opacity=\"0.8\" width=\"5\" height=\"12\" rx=\"2\" transform=\"matrix(-1 0 0 1 14 2)\" fill=\"currentColor\"/> <path d=\"M9 2V14\" stroke=\"currentColor\" stroke-width=\"1.2\"/> <rect x=\"2\" y=\"2\" width=\"12\" height=\"12\" rx=\"1.5\" stroke=\"currentColor\" stroke-width=\"1.2\"/>",
  "threads_sidebar_right_closed": "<rect opacity=\"0.1\" width=\"5\" height=\"12\" rx=\"2\" transform=\"matrix(-1 0 0 1 14 2)\" fill=\"currentColor\"/> <path d=\"M9 2V14\" stroke=\"currentColor\" stroke-width=\"1.2\"/> <rect x=\"2\" y=\"2\" width=\"12\" height=\"12\" rx=\"1.5\" stroke=\"currentColor\" stroke-width=\"1.2\"/>",
"zed_assistant": "<path d=\"M8 2.93652L6.9243 6.20697C6.86924 6.37435 6.77565 6.52646 6.65105 6.65105C6.52646 6.77565 6.37435 6.86924 6.20697 6.9243L2.93652 8L6.20697 9.0757C6.37435 9.13076 6.52646 9.22435 6.65105 9.34895C6.77565 9.47354 6.86924 9.62565 6.9243 9.79306L8 13.0635L9.0757 9.79306C9.13076 9.62565 9.22435 9.47354 9.34895 9.34895C9.47354 9.22435 9.62565 9.13076 9.79306 9.0757L13.0635 8L9.79306 6.9243C9.62565 6.86924 9.47354 6.77565 9.34895 6.65105C9.22435 6.52646 9.13076 6.37435 9.0757 6.20697L8 2.93652Z\" fill=\"currentColor\" fill-opacity=\"0.15\" stroke=\"currentColor\" stroke-width=\"1.2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/> <path opacity=\"0.6\" d=\"M3.33334 2V4.66666M2 3.33334H4.66666\" stroke=\"currentColor\" stroke-width=\"1.2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/> <path opacity=\"0.6\" d=\"M12.6665 11.3333V14M11.3333 12.6666H13.9999\" stroke=\"currentColor\" stroke-width=\"1.2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>",
"threads_sidebar_left_closed": "<rect opacity=\"0.1\" width=\"5\" height=\"12\" rx=\"2\" transform=\"matrix(-1 0 0 1 7 2)\" fill=\"currentColor\"/> <path d=\"M7 2V14\" stroke=\"currentColor\" stroke-width=\"1.2\"/> <rect x=\"2\" y=\"2\" width=\"12\" height=\"12\" rx=\"1.5\" stroke=\"currentColor\" stroke-width=\"1.2\"/>",
"git_branch": "<path d=\"M4.5 13C5.32843 13 6 12.3284 6 11.5C6 10.6716 5.32843 10 4.5 10C3.67157 10 3 10.6716 3 11.5C3 12.3284 3.67157 13 4.5 13Z\" stroke=\"currentColor\" stroke-width=\"1.2\"/> <path d=\"M11.5 6C12.3284 6 13 5.3284 13 4.5C13 3.6716 12.3284 3 11.5 3C10.6716 3 10 3.6716 10 4.5C10 5.3284 10.6716 6 11.5 6Z\" stroke=\"currentColor\" stroke-width=\"1.2\"/> <path d=\"M4.5 10L4.5 3\" stroke=\"currentColor\" stroke-width=\"1.2\" stroke-linecap=\"round\"/> <path d=\"M10 4.44133C8.54131 4.44133 7.14236 5.02697 6.11091 6.06943C5.07946 7.11188 4.5 8.52575 4.5 10\" stroke=\"currentColor\" stroke-width=\"1.2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>",
"threads_sidebar_left_open": "<rect opacity=\"0.8\" width=\"5\" height=\"12\" rx=\"2\" transform=\"matrix(-1 0 0 1 7 2)\" fill=\"currentColor\"/> <path d=\"M7 2V14\" stroke=\"currentColor\" stroke-width=\"1.2\"/> <rect x=\"2\" y=\"2\" width=\"12\" height=\"12\" rx=\"1.5\" stroke=\"currentColor\" stroke-width=\"1.2\"/>",
"git_worktree": "<path d=\"M7.78314 8.0003L12.3252 3.45825\" stroke=\"currentColor\" stroke-width=\"1.2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/> <path d=\"M9.49899 9.71719L12.3237 12.5419\" stroke=\"currentColor\" stroke-width=\"1.2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/> <path d=\"M3.25763 8.00031H7.77134\" stroke=\"currentColor\" stroke-width=\"1.2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/> <path d=\"M12.7424 6.47908V3.04047H9.3038\" stroke=\"currentColor\" stroke-width=\"1.2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/> <path d=\"M9.30225 12.9595H12.7409V9.52094\" stroke=\"currentColor\" stroke-width=\"1.2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>",
"info": "<path d=\"M8 14C11.3137 14 14 11.3137 14 8C14 4.68629 11.3137 2 8 2C4.68629 2 2 4.68629 2 8C2 11.3137 4.68629 14 8 14Z\" stroke=\"currentColor\" stroke-width=\"1.2\"/> <path d=\"M7 11H8M8 11H9M8 11V8.1C8 8.04477 7.95523 8 7.9 8H7\" stroke=\"currentColor\" stroke-width=\"1.2\" stroke-linecap=\"round\"/> <path d=\"M8 6.5C8.55228 6.5 9 6.05228 9 5.5C9 4.94772 8.55228 4.5 8 4.5C7.44772 4.5 7 4.94772 7 5.5C7 6.05228 7.44772 6.5 8 6.5Z\" fill=\"currentColor\"/>",
"load_circle": "<path stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"1.2\" d=\"M13 8a5 5 0 1 1-3.455-4.755\"/>",
"arrow_circle": "<path d=\"M12.8989 5.77778L11.6434 4.52222C10.6384 3.55068 9.29673 3.00526 7.89893 3C6.57285 3 5.30103 3.52678 4.36343 4.46447C3.78887 5.03901 3.36856 5.73897 3.12921 6.5\" stroke=\"currentColor\" stroke-width=\"1.2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/> <path d=\"M12.8989 3V5.77778H10.1211\" stroke=\"currentColor\" stroke-width=\"1.2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/> <path d=\"M3.1012 10.2222L4.3568 11.4778C5.3618 12.4493 6.70342 12.9947 8.10122 13C9.42731 13 10.6991 12.4732 11.6368 11.5355C12.2163 10.956 12.6389 10.2487 12.8772 9.47994\" stroke=\"currentColor\" stroke-width=\"1.2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/> <path d=\"M5.87891 10.2222H3.10111V13\" stroke=\"currentColor\" stroke-width=\"1.2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>",
"check_double": "<path d=\"M11.5999 4.38336L4.99996 10.9833L2 7.98332\" stroke=\"currentColor\" stroke-width=\"1.2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/> <path d=\"M14 6.78339L9.50009 11.2833L8.6001 10.3833\" stroke=\"currentColor\" stroke-width=\"1.2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>",
"send": "<path stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"1.2\" d=\"M3.377 3.028a.25.25 0 0 0-.292.045.291.291 0 0 0-.067.303l1.496 4.236c.088.25.088.526 0 .776l-1.496 4.236a.291.291 0 0 0 .067.303.25.25 0 0 0 .292.045l9.472-4.72a.267.267 0 0 0 .11-.103.288.288 0 0 0-.11-.4L3.377 3.028ZM5 8h8\"/>",
"forward_arrow_up": "<path d=\"M10.0001 6.66669L13.3334 10L10.0001 13.3334\" stroke=\"currentColor\" stroke-width=\"1.2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/> <path d=\"M2.66675 5V7.33335C2.66675 8.0406 2.94765 8.71888 3.44775 9.21897C3.94785 9.71907 4.62615 10 5.33345 10H13.3334\" stroke=\"currentColor\" stroke-width=\"1.2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/>",
"circle": "<path d=\"M8 12C10.2091 12 12 10.2091 12 8C12 5.79087 10.2091 4 8 4C5.79087 4 4 5.79087 4 8C4 10.2091 5.79087 12 8 12Z\" fill=\"currentColor\"/>",
"filter": "<path d=\"M2 5H4\" stroke=\"currentColor\" stroke-width=\"1.2\" stroke-linecap=\"round\"/> <path d=\"M8 5H14\" stroke=\"currentColor\" stroke-width=\"1.2\" stroke-linecap=\"round\"/> <path d=\"M12 11H14\" stroke=\"currentColor\" stroke-width=\"1.2\" stroke-linecap=\"round\"/> <path d=\"M2 11H8\" stroke=\"currentColor\" stroke-width=\"1.2\" stroke-linecap=\"round\"/> <path opacity=\"0.1\" d=\"M6 7C7.10457 7 8 6.10457 8 5C8 3.89543 7.10457 3 6 3C4.89543 3 4 3.89543 4 5C4 6.10457 4.89543 7 6 7Z\" fill=\"currentColor\" stroke=\"currentColor\" stroke-width=\"1.2\" stroke-linecap=\"round\"/> <path opacity=\"0.1\" d=\"M10 13C11.1046 13 12 12.1046 12 11C12 9.89543 11.1046 9 10 9C8.89543 9 8 9.89543 8 11C8 12.1046 8.89543 13 10 13Z\" fill=\"currentColor\" stroke=\"currentColor\" stroke-width=\"1.2\" stroke-linecap=\"round\"/> <path d=\"M6 7C7.10457 7 8 6.10457 8 5C8 3.89543 7.10457 3 6 3C4.89543 3 4 3.89543 4 5C4 6.10457 4.89543 7 6 7Z\" stroke=\"currentColor\" stroke-width=\"1.2\" stroke-linecap=\"round\"/> <path d=\"M10 13C11.1046 13 12 12.1046 12 11C12 9.89543 11.1046 9 10 9C8.89543 9 8 9.89543 8 11C8 12.1046 8.89543 13 10 13Z\" stroke=\"currentColor\" stroke-width=\"1.2\" stroke-linecap=\"round\"/>",
}

// `kind` d'un tool call ACP -> icône, exactement comme le panel de Zed les affiche.
export const TOOL_KIND_ICON = {
  read: 'search',
  edit: 'pencil',
  delete: 'trash',
  move: 'move',
  search: 'search',
  execute: 'terminal',
  think: 'lightbulb',
  fetch: 'globe',
  switch_mode: 'shuffle',
  other: 'wrench',
}

const SVG_NS = 'http://www.w3.org/2000/svg'

export function icon(name, cls = '') {
  const svg = document.createElementNS(SVG_NS, 'svg')
  if (ZED[name]) {
    svg.setAttribute('viewBox', '0 0 16 16')
    svg.setAttribute('fill', 'none')
    svg.setAttribute('aria-hidden', 'true')
    svg.setAttribute('class', `icon ${cls}`.trim())
    svg.innerHTML = ZED[name]
    return svg
  }
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.7')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('class', `icon ${cls}`.trim())
  const path = document.createElementNS(SVG_NS, 'path')
  path.setAttribute('d', P[name] || P.circle)
  svg.append(path)
  return svg
}

export function toolIcon(kind, cls = '') {
  return icon(TOOL_KIND_ICON[kind] || TOOL_KIND_ICON.other, cls)
}

// Logo ZRA (Z fendu bicolore) pour le header. Le neutre suit currentColor
// (donc le thème clair/sombre de l'app) ; l'accent suit color-scheme via
// light-dark() (gruvbox green sombre / light). Inline plutôt qu'<img> : un
// fichier externe ne peut pas hériter de currentColor ni de light-dark().
export function brandLogo(cls = '') {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 512 512')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('class', `icon ${cls}`.trim())
  const acc = 'style="fill:light-dark(#98971a,#b8bb26)"'
  // Glyphe centré, plein cadre dans la boîte 16 (même taille/marges que
  // l'icône d'agent) : scale = 512 / côté bbox (246.4), translate = centre bbox.
  svg.innerHTML = `
    <g transform="translate(256 256) scale(2.0779) translate(-235 -280)">
      <g transform="translate(235 280) scale(0.88) translate(-256 -256)">
        <path fill="currentColor" d="M148 116 L384 116 L116 384 L116 324 L252 188 L116 188 L116 148 Z"/>
        <path ${acc} d="M396 138 L396 188 L260 324 L396 324 L396 364 L364 396 L138 396 Z"/>
      </g>
    </g>`
  return svg
}

// ---- icônes d'agents ----

// `agent_id` du registry Zed -> glyphe. Les identifiants sont libres
// (`claude-acp`, `claude-zra`, `my-claude`…), on reconnaît par motif.
const AGENT_PATTERNS = [
  [/claude|anthropic/i, 'claude'],
  [/gemini|google/i, 'gemini'],
  [/codex|openai|open-ai|gpt/i, 'openai'],
  [/grok|x-?ai/i, 'xai'],
  [/mistral|codestral/i, 'mistral'],
  [/opencode|open-code/i, 'opencode'],
  [/^zed|zeta/i, 'zed'],
]

export function agentGlyphId(agentId) {
  if (!agentId) return null
  for (const [re, id] of AGENT_PATTERNS) if (re.test(agentId)) return id
  return null
}

// SVG du registre ACP, reçus des postes (message `machine`, champ `agentIcons`) :
// le cache de Zed, les mêmes icônes que lui. Map globale : un logo de marque est
// le même sur tous les postes.
const REGISTRY_ICONS = new Map()

/** Mémorise les SVG reçus d'un poste ; sans eux, repli sur les glyphes embarqués. */
export function noteRegistryIcons(icons) {
  if (!icons || typeof icons !== 'object') return
  for (const [id, svg] of Object.entries(icons)) {
    if (typeof svg === 'string' && svg) REGISTRY_ICONS.set(id, svg)
  }
}

/**
 * SVG brut du registre → élément inline, tel quel (cercles, transformations…
 * que le parseur des glyphes embarqués ne connaît pas). `innerHTML` n'exécute
 * pas les scripts ; on retire quand même scripts, `foreignObject` et
 * gestionnaires d'événements : le contenu vient d'un registre tiers.
 */
function registryIcon(svgText, cls) {
  const wrap = document.createElement('div')
  wrap.innerHTML = svgText
  const svg = wrap.querySelector('svg')
  if (!svg) return null
  for (const n of svg.querySelectorAll('script, foreignObject')) n.remove()
  for (const n of [svg, ...svg.querySelectorAll('*')]) {
    for (const attr of [...n.attributes]) {
      if (/^on/i.test(attr.name)) n.removeAttribute(attr.name)
    }
  }
  // La taille vient du CSS (`.icon`), pas des attributs du fichier.
  svg.removeAttribute('width')
  svg.removeAttribute('height')
  svg.setAttribute('class', `icon ${cls}`.trim())
  svg.setAttribute('aria-hidden', 'true')
  return svg
}

/**
 * Icône de l'agent, monochrome (`currentColor`), comme dans le panel de Zed.
 * Registre ACP d'abord (l'icône exacte de Zed pour cet id), puis les glyphes
 * embarqués par motif ; agent inconnu : une icône générique plutôt que rien.
 */
export function agentIcon(agentId, cls = '') {
  const raw = agentId ? REGISTRY_ICONS.get(agentId) : null
  if (raw) {
    const el = registryIcon(raw, cls)
    if (el) return el
  }
  const glyph = AGENT_GLYPHS[agentGlyphId(agentId)]
  if (!glyph) return icon('sparkles', cls)
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', glyph.viewBox)
  svg.setAttribute('fill', 'currentColor')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('class', `icon ${cls}`.trim())
  for (const shape of glyph.shapes) {
    if (shape.rect) {
      const [x, y, w, hh] = shape.rect
      const rect = document.createElementNS(SVG_NS, 'rect')
      rect.setAttribute('x', x); rect.setAttribute('y', y)
      rect.setAttribute('width', w); rect.setAttribute('height', hh)
      svg.append(rect)
    } else {
      const path = document.createElementNS(SVG_NS, 'path')
      path.setAttribute('d', shape.d)
      if (shape.rule) path.setAttribute('fill-rule', shape.rule)
      svg.append(path)
    }
  }
  return svg
}
