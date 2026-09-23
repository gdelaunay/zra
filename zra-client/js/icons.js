// Jeu d'icônes, trait 1.6px sur grille 24 — même famille que celles de Zed (Lucide).
// Les icônes d'agents (Claude, Gemini, …) viennent de Zed : voir agent-icons.js.

import { AGENT_GLYPHS } from './agent-icons.js'

const P = {
  'chevron-right': 'm9 18 6-6-6-6',
  'chevron-down': 'm6 9 6 6 6-6',
  'chevron-left': 'm15 18-6-6 6-6',
  'chevron-up-down': 'm8 9 4-4 4 4M8 15l4 4 4-4',
  'arrow-left': 'M19 12H5M12 19l-7-7 7-7',
  'arrow-up': 'M12 19V5M5 12l7-7 7 7',
  'arrow-down': 'M12 5v14M19 12l-7 7-7-7',
  'search': 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm10 2-4.35-4.35',
  'settings': 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M2 14h4M10 8h4M18 16h4',
  'send': 'M12 19V5M5 12l7-7 7 7',
  'stop': 'M7 7h10v10H7z',
  'x': 'M18 6 6 18M6 6l12 12',
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
  'list-todo': 'M3 5h.01M3 12h.01M3 19h.01M8 5h13M8 12h13M8 19h13',
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
}

// `kind` d'un tool call ACP -> icône, exactement comme le panel de Zed les affiche.
export const TOOL_KIND_ICON = {
  read: 'file-text',
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

/**
 * Icône de l'agent, monochrome (`currentColor`), comme dans le panel de Zed.
 * Agent inconnu : on retombe sur une icône générique plutôt que sur rien.
 */
export function agentIcon(agentId, cls = '') {
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
