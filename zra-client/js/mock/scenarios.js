// Scénarios du mode mock : données de postes, historiques rejouables et
// scripts de tour d'agent. Tout est du payload ACP tel qu'un vrai agent l'émet.

const now = Date.now()
const ago = (ms) => new Date(now - ms).toISOString()
const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000

export const MACHINES = {
  'mock-desk': {
    name: 'DESK-ZED',
    os: 'Windows 11',
    zedRunning: true,
    version: '0.1.0-mock',
    threads: [
      {
        threadId: 'a1f39c0b', sessionId: 'sess-live-1', agentId: 'claude-acp',
        title: "Refactor du lecteur d'index SQLite",
        folderPaths: ['C:/Users/gd/Documents/Développement/zra'],
        projectOpen: true,
        updatedAt: ago(30_000), archived: false, state: 'live',
      },
      {
        threadId: 'b7c2e441', sessionId: 'sess-live-2', agentId: 'claude-acp',
        title: "Ajouter les tests de la file d'attente",
        folderPaths: ['C:/Users/gd/Documents/Développement/zra'],
        projectOpen: true,
        updatedAt: ago(14 * MIN), archived: false, state: 'live',
      },
      {
        threadId: 'c0d81e77', sessionId: 'sess-closed-1', agentId: 'claude-acp',
        title: 'Bug : encodage UTF-8 des folder_paths',
        folderPaths: ['C:/Users/gd/Documents/Développement/zra'],
        projectOpen: true,
        updatedAt: ago(3 * HOUR), archived: false, state: 'closed',
      },
      {
        threadId: 'd39a5b12', sessionId: 'sess-closed-2', agentId: 'gemini-acp',
        title: 'Spike : UI Automation sur la fenêtre Zed',
        folderPaths: ['C:/Users/gd/Documents/Développement/spikes/uia'],
        projectOpen: false,
        updatedAt: ago(2 * DAY), archived: false, state: 'closed',
      },
      {
        // Archivé dans Zed : masqué par défaut, visible sous le filtre « Archivés ».
        threadId: 'f7a2e0d4', sessionId: 'sess-archived', agentId: 'claude-acp',
        title: 'Ancien essai : injection au clavier',
        folderPaths: ['C:/Users/gd/Documents/Développement/zra'],
        projectOpen: true,
        updatedAt: ago(4 * DAY), archived: true, state: 'closed',
      },
      {
        threadId: 'e5510cc9', sessionId: null, agentId: null,
        title: 'Nouveau thread',
        folderPaths: ['C:/Users/gd/Documents/Développement/zra'],
        projectOpen: true,
        updatedAt: ago(5 * DAY), archived: false, state: 'unknown',
      },
    ],
  },
  'mock-laptop': {
    name: 'LAPTOP-ZED',
    os: 'Windows 11',
    zedRunning: true,
    version: '0.1.0-mock',
    threads: [
      {
        threadId: 'f1029384', sessionId: 'sess-live-3', agentId: 'claude-acp',
        title: 'Portage du daemon sur Node 22',
        folderPaths: ['D:/src/zra'],
        projectOpen: true,
        updatedAt: ago(2 * MIN), archived: false, state: 'live',
      },
      {
        threadId: 'aa77bb00', sessionId: 'sess-closed-3', agentId: 'codex-acp',
        title: 'Notes de release v0.1',
        folderPaths: ['D:/src/zra', 'D:/src/notes'],
        projectOpen: false,
        updatedAt: ago(6 * DAY), archived: false, state: 'closed',
      },
    ],
  },
}

export const MODES = [
  { id: 'ask', name: 'Ask' },
  { id: 'write', name: 'Write' },
  { id: 'plan', name: 'Plan' },
]

export const MODELS = [
  { id: 'claude-opus-5', name: 'Claude Opus 5' },
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5' },
  { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5' },
]

/** Réglages hors mode/modèle, comme ceux de `claude-agent-acp` (protocole §4 `options`). */
export const OPTIONS = [
  {
    id: 'effort', name: 'Effort', category: 'thought_level', type: 'select',
    values: [
      { id: 'default', name: 'Default' },
      { id: 'low', name: 'Low' },
      { id: 'medium', name: 'Medium' },
      { id: 'high', name: 'High' },
    ],
    default: 'default',
  },
  {
    id: 'fast', name: 'Fast mode', category: 'model_config', type: 'boolean',
    description: 'Faster responses on supported models', default: false,
  },
]

export const COMMANDS = [
  { name: 'test', description: 'lancer npm test' },
  { name: 'review', description: 'relire le diff courant' },
]

// ---- fabriques d'updates ACP ----

export const text = (t) => ({ type: 'text', text: t })
export const agentChunk = (t) => ({ sessionUpdate: 'agent_message_chunk', content: text(t) })
export const userChunk = (t) => ({ sessionUpdate: 'user_message_chunk', content: text(t) })
export const thought = (t) => ({ sessionUpdate: 'agent_thought_chunk', content: text(t) })

export const toolCall = (o) => ({
  sessionUpdate: 'tool_call',
  toolCallId: o.id, title: o.title, kind: o.kind || 'other',
  status: o.status || 'pending', content: o.content || [], locations: o.locations || [],
  rawInput: o.rawInput,
})
export const toolUpdate = (id, o) => ({ sessionUpdate: 'tool_call_update', toolCallId: id, ...o })
export const diff = (path, oldText, newText) => ({ type: 'diff', path, oldText, newText })
export const terminal = (terminalId) => ({ type: 'terminal', terminalId })
export const content = (t) => ({ type: 'content', content: text(t) })
export const termOut = (terminalId, output, o = {}) =>
  ({ sessionUpdate: 'zra/terminal_output', terminalId, output, append: true, ...o })

export const plan = (items) => ({ sessionUpdate: 'plan', entries: items })
/** Formes relevées chez claude-acp : le coût n'accompagne que la fin d'un tour. */
export const usage = (used, size = 1_000_000, cost) =>
  ({ sessionUpdate: 'usage_update', used, size, ...(cost !== undefined ? { cost: { amount: cost, currency: 'USD' } } : {}) })
export const sessionInfo = (title) =>
  ({ sessionUpdate: 'session_info_update', title, updatedAt: new Date().toISOString() })
export const permission = (o) => ({
  requestId: o.requestId || `perm-${Math.random().toString(36).slice(2, 8)}`,
  toolCall: o.toolCall,
  options: o.options || [
    { optionId: 'allow-once', name: 'Autoriser une fois', kind: 'allow_once' },
    { optionId: 'allow-always', name: "Yes, and don't ask again for `node --no-warnings --test zra-client/test/pwa.test.mjs zra-daemon/test/protocol.test.mjs` commands in C:\\Users\\dev\\Documents\\Développement\\zra", kind: 'allow_always' },
    { optionId: 'reject', name: 'Refuser', kind: 'reject_once' },
  ],
})

/** Découpe un texte en fragments de streaming, comme un vrai flux de tokens. */
export function stream(str, chunk = 18) {
  const out = []
  for (let i = 0; i < str.length; i += chunk) out.push(str.slice(i, i + chunk))
  return out
}

const OLD_FILE = `export function readIndex(dbPath) {
  const db = new DatabaseSync(dbPath)
  const rows = db.prepare('SELECT * FROM sidebar_threads').all()
  return rows.map((r) => ({
    threadId: r.thread_id.toString('hex'),
    title: r.title,
    updatedAt: r.updated_at,
  }))
}
`

const NEW_FILE = `export function readIndex(dbPath) {
  // Toujours en lecture seule : Zed tourne en parallèle, la base est en WAL.
  const db = new DatabaseSync(\`file:\${dbPath}?mode=ro\`, { readOnly: true })
  const rows = db.prepare('SELECT * FROM sidebar_threads ORDER BY updated_at DESC').all()
  return rows.map((r) => ({
    threadId: Buffer.from(r.thread_id).toString('hex'),
    sessionId: r.session_id ?? null,
    title: r.title_override ?? r.title,
    folderPaths: parsePaths(r.folder_paths),
    updatedAt: r.updated_at,
    archived: Boolean(r.archived),
  }))
}
`

// ---- historiques (réponse à `load_history`, issue d'un session/load) ----

const HISTORIES = {
  c0d81e77: [
    userChunk("Les chemins de dossier s'affichent avec des caractères cassés dans la liste. Tu peux regarder ?"),
    thought("Le champ `folder_paths` est de l'UTF-8 stocké en TEXT. Probablement une lecture en latin-1 quelque part."),
    agentChunk("Je regarde comment `folder_paths` est lu.\n\n"),
    toolCall({
      id: 'tc-h1', title: 'Lire `src/daemon/threads-index.ts`', kind: 'read', status: 'completed',
      locations: [{ path: 'src/daemon/threads-index.ts', line: 42 }],
      content: [content('42 lignes lues')],
    }),
    agentChunk("Le problème vient de la conversion : le buffer est décodé en `latin1`.\n\n"),
    toolCall({
      id: 'tc-h2', title: 'Corriger le décodage', kind: 'edit', status: 'completed',
      locations: [{ path: 'src/daemon/threads-index.ts' }],
      content: [diff('src/daemon/threads-index.ts',
        "const paths = buf.toString('latin1')\n",
        "const paths = buf.toString('utf8')\n")],
    }),
    agentChunk("C'est corrigé : le décodage est forcé en `utf8` à la lecture. " +
      "Les accents de `Développement` s'affichent correctement.\n"),
    usage(862_000, 1_000_000, 1.42),
  ],
  d39a5b12: [
    userChunk("Est-ce que l'arbre UIA de Zed expose le composer du panel agent ?"),
    agentChunk("Je sonde la fenêtre.\n\n"),
    toolCall({
      id: 'tc-h3', title: 'Exécuter `pwsh scripts/uia-probe.ps1`', kind: 'execute', status: 'completed',
      content: [content('Zed — Edit — 1 fenêtre\n  Pane\n    AgentPanel\n      Document "MessageEditor" (ControlType.Edit)')],
    }),
    agentChunk("Oui : le composer remonte en `ControlType.Edit`, nommé `MessageEditor`. " +
      "Le repli `SendKeys` ne sera nécessaire que si le nom change.\n"),
  ],
  aa77bb00: [
    userChunk('Rédige les notes de release v0.1.'),
    agentChunk("# ZRA v0.1\n\n- Lecture live des threads via le shim\n- `session/load` pour les threads fermés\n" +
      "- Injection ACP, repli UIA\n- PWA installable, thèmes Zed\n"),
  ],
  f1029384: [
    userChunk('Passe le daemon sur node:sqlite pour supprimer better-sqlite3.'),
    agentChunk('Bonne idée, `node:sqlite` est stable depuis Node 22.\n'),
  ],
  b7c2e441: [
    userChunk("Écris les tests de la machine à états de la file d'attente."),
    agentChunk("J'ai ajouté `test/queue.test.ts` : 6 cas couvrant `queue`, `interrupt` et la perte de file.\n"),
  ],
}

export function historyFor(threadId) { return HISTORIES[threadId] ? [...HISTORIES[threadId]] : [] }

// ---- scripts de tour ----

/** Tour riche : réflexion, plan, lecture, diff, terminal, réponse markdown. */
export function fullTurn(prompt) {
  const tcRead = `tc-${rid()}`, tcEdit = `tc-${rid()}`, tcRun = `tc-${rid()}`
  const term = `term-${rid()}`
  return [
    { at: 60, update: usage(24_310) },
    { at: 120, update: thought("L'utilisateur veut que le lecteur d'index ouvre la base en lecture seule.") },
    { at: 300, update: plan([
      { content: 'Lire le lecteur actuel', priority: 'high', status: 'in_progress' },
      { content: "Forcer l'URI `?mode=ro`", priority: 'high', status: 'pending' },
      { content: 'Lancer les tests', priority: 'medium', status: 'pending' },
    ]) },
    ...streamSteps("Je regarde d'abord le lecteur actuel.\n\n", 400),
    { at: 900, update: toolCall({
      id: tcRead, title: 'Lire `src/daemon/threads-index.ts`', kind: 'read', status: 'in_progress',
      locations: [{ path: 'src/daemon/threads-index.ts' }],
    }) },
    { at: 1400, update: toolUpdate(tcRead, { status: 'completed', content: [content('58 lignes lues')] }) },
    { at: 1600, update: plan([
      { content: 'Lire le lecteur actuel', priority: 'high', status: 'completed' },
      { content: "Forcer l'URI `?mode=ro`", priority: 'high', status: 'in_progress' },
      { content: 'Lancer les tests', priority: 'medium', status: 'pending' },
    ]) },
    ...streamSteps("La connexion est ouverte en lecture/écriture : avec Zed qui tourne en parallèle sur une base WAL, " +
      "c'est exactement ce qu'il ne faut pas faire. Je corrige.\n\n", 1800),
    { at: 2600, update: toolCall({
      id: tcEdit, title: 'Modifier `src/daemon/threads-index.ts`', kind: 'edit', status: 'in_progress',
      locations: [{ path: 'src/daemon/threads-index.ts', line: 12 }],
    }) },
    { at: 3200, update: toolUpdate(tcEdit, {
      status: 'completed',
      content: [diff('src/daemon/threads-index.ts', OLD_FILE, NEW_FILE)],
    }) },
    { at: 3500, update: toolCall({
      id: tcRun, title: 'Exécuter `npm test`', kind: 'execute', status: 'in_progress',
      content: [terminal(term)],
    }) },
    { at: 3700, update: termOut(term, '> zra@0.1.0 test\n> node --test\n\n') },
    { at: 4100, update: termOut(term, '▶ threads-index\n  ✔ ouvre la base en lecture seule (4.1ms)\n') },
    { at: 4500, update: termOut(term, '  ✔ décode folder_paths en UTF-8 (1.2ms)\n▶ queue\n  ✔ file puis dépile (0.8ms)\n') },
    { at: 4900, update: termOut(term, '\nℹ tests 3\nℹ pass 3\nℹ fail 0\n', { exitStatus: { exitCode: 0 } }) },
    { at: 5000, update: toolUpdate(tcRun, { status: 'completed' }) },
    { at: 5200, update: plan([
      { content: 'Lire le lecteur actuel', priority: 'high', status: 'completed' },
      { content: "Forcer l'URI `?mode=ro`", priority: 'high', status: 'completed' },
      { content: 'Lancer les tests', priority: 'medium', status: 'completed' },
    ]) },
    ...streamSteps(
      "C'est fait.\n\n" +
      '**Ce qui change**\n\n' +
      "1. Ouverture via l'URI `file:…?mode=ro` — plus aucun risque de lock sur la base de Zed.\n" +
      '2. Tri sur `updated_at DESC`, comme le sidebar.\n' +
      '3. `title_override` prend le pas sur `title`.\n\n' +
      '```js\nconst db = new DatabaseSync(`file:${dbPath}?mode=ro`, { readOnly: true })\n```\n\n' +
      'Les trois tests passent.\n', 5400),
    { at: 6200, update: usage(31_842, 1_000_000, 0.0873) },
    { at: 6250, update: sessionInfo("Refactor du lecteur d'index en lecture seule") },
  ]
}

/** Tour court, utilisé pour les réponses aux messages envoyés depuis le mobile. */
export function shortTurn(prompt) {
  const head = `Bien reçu : « ${String(prompt).slice(0, 120)} ».\n\n`
  return [
    { at: 150, update: thought('Message reçu depuis le mobile via ZRA.') },
    ...streamSteps(head + "Je m'en occupe. Voici ce que je prévois :\n\n" +
      '- relire le point concerné ;\n- proposer un diff ;\n- lancer les tests.\n\n' +
      'Dis-moi si tu veux que je commence.\n', 400),
    { at: 1400, update: usage(12_480, 1_000_000, 0.0215) },
  ]
}

/** Tour long, pensé pour tester le bouton Stop et la file d'attente. */
export function longTurn() {
  const steps = [{ at: 200, update: thought('Analyse en cours…') }]
  let t = 600
  for (let i = 1; i <= 40; i++) {
    steps.push({ at: t, update: agentChunk(`Étape ${i} : parcours du fichier ${i}/40…\n`) })
    t += 700
  }
  return steps
}

/**
 * Demande de permission. Le tour reste **en attente** : l'agent est bloqué sur
 * sa requête JSON-RPC jusqu'à la réponse (§6.6).
 */
export function permissionScenario() {
  const tc = `tc-${rid()}`
  const requestId = `perm-${rid()}`
  const title = 'Exécuter `git push --force origin main`'
  return {
    requestId,
    toolCallId: tc,
    steps: [
      { at: 200, update: agentChunk("Cette commande touche au dépôt distant, je demande l'autorisation.\n\n") },
      { at: 600, update: toolCall({ id: tc, title, kind: 'execute', status: 'pending' }) },
      { at: 900, update: permission({ requestId, toolCall: { toolCallId: tc, title, kind: 'execute' } }) },
    ],
  }
}

/** Suite du tour une fois la permission tranchée (§6.6). */
export function permissionFollowUp(toolCallId, allowed) {
  if (!allowed) {
    return [
      { at: 150, update: toolUpdate(toolCallId, { status: 'failed', content: [content('refusé par l’utilisateur')] }) },
      ...streamSteps('Compris, je ne pousse pas. Je te laisse relire le diff avant de décider.\n', 400),
    ]
  }
  const term = `term-${rid()}`
  return [
    { at: 150, update: toolUpdate(toolCallId, { status: 'in_progress', content: [terminal(term)] }) },
    { at: 400, update: termOut(term, 'Enumerating objects: 27, done.\nCounting objects: 100% (27/27), done.\n') },
    { at: 900, update: termOut(term, 'To github.com:gd/zra.git\n + 9f2a1c4...c71e0ab main -> main (forced update)\n',
      { exitStatus: { exitCode: 0 } }) },
    { at: 1000, update: toolUpdate(toolCallId, { status: 'completed' }) },
    ...streamSteps("Poussé. L'historique distant de `main` a été réécrit.\n", 1200),
  ]
}

export function unknownScenario() {
  return [
    { at: 100, update: { sessionUpdate: 'quantum_entanglement_update', payload: { qubits: 12, coherence: 0.87 } } },
    { at: 400, update: agentChunk("Le bloc ci-dessus n'existe pas encore dans la spec ACP : ZRA l'affiche brut plutôt que de le perdre.\n") },
  ]
}

function streamSteps(str, start, step = 55) {
  return stream(str).map((frag, i) => ({ at: start + i * step, update: agentChunk(frag) }))
}

function rid() { return Math.random().toString(36).slice(2, 8) }
