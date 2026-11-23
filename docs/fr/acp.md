# ZRA — fiches ACP

Les méthodes ACP utilisées par ZRA : ce que dit la spec, où ZRA les traite, où Zed les implémente — et, en fin de page, la **compatibilité par agent** (qui implémente quoi, et comment). Complète `docs/fr/zed.md` (correspondance avec Zed) et `docs/fr/protocol.md` (contrat PWA ↔ daemon).

## Référence

- **ZRA parle ACP v1. Spec de référence : tag `v1.15.1`** du dépôt de spécification — la version sur laquelle Zed 1.28.1 développe (crate `agent-client-protocol-schema` 1.15.1). Les chemins de cette page sont relatifs à `_upstream/acp` et valent pour ce tag ; mise en place dans `docs/fr/zed.md`.
- Table des méthodes : `schema/v1/meta.json` ; formes exactes : `schema/v1/schema.json`. Méthodes **unstable** (`session/set_title`, `session/delete`) : `meta.unstable.json`, `schema.unstable.json`. Les fichiers spec cités dans les tableaux sont sous `docs/protocol/v1/`.
- Pas de SDK ACP : JSON-RPC à la main (`zra-shim/framing.js`). Le shim relaie tout entre Zed et l'agent et n'interprète que les méthodes ci-dessous ; le reste (`fs/read_text_file`, `fs/write_text_file`, `terminal/create|kill|release`, `authenticate`…) passe transparentiellement.

## Méthodes agent (ZRA → agent, ou observées par le shim)

| Méthode | Spec | Côté ZRA | Côté Zed |
|---|---|---|---|
| `initialize` | `initialization.mdx` | Le shim capture version, `agentInfo` et capacités (`zra-shim/acp.js` : `noteResponse`) : `loadSession`, `sessionCapabilities.title/.delete`, `promptCapabilities.embeddedContext`… ; le client jetable vérifie `loadSession` (`zra-daemon/session-loader.js`) | `crates/agent_servers/src/acp/v1.rs` : `connect`, `client_builder`, `client_capabilities_for_agent` |
| `session/new` | `session-setup.mdx` | Session suivie à la réponse (`noteResponse`, `openSession`) | `acp/v1.rs` : `new_session` |
| `session/load` | `session-setup.mdx` | Thread vivant : observé depuis Zed (`observeFromZed`). Thread fermé : client jetable, replay collecté → `history`, cache 10 min (`session-loader.js` : `load`, `replay`) | `acp/v1.rs` : `load_session` ; `crates/agent_ui/src/conversation_view.rs` : `load_session` |
| `session/resume` | `session-setup.mdx` | Session suivie (`noteResponse`) ; Zed reprend sans rejeu un agent sans `loadSession` | `acp/v1.rs` : `resume_session` ; `conversation_view.rs` : `resume_session`, `supports_resume_session` |
| `session/close` | `session-setup.mdx` | Le shim retire la session suivie (`closeSession`) | `acp/v1.rs` : `release_session` |
| `session/prompt` | `prompt-turn.mdx`, `error.mdx` | File d'attente, blocs de contenu (mentions construites par `zra-daemon/mentions.js`, garde de chemin — `protocol.md` §9) ; erreur refusée : `code`/`data` gardés de bout en bout (`sendPrompt`, `settlePrompt`, `confirm`, `ShimError.details`) ; `-32603` + `data = { details }` → le texte `details` en message normal (`agentErrorSpec`, PWA) ; départ du tour daté à l'envoi réel (`queue.js` : `promptSent` → `turnSince`, miroir jusqu'à la PWA pour la durée de génération — l'ACP ne date pas les tours) | `acp/v1.rs` : `prompt` (même exception `-32603`/`details`, workaround gemini-cli) ; callout « An Error Happened » (`thread_view.rs` : `render_any_thread_error`) |
| `session/cancel` | `cancellation.mdx` | Coupe le tour en cours (`cancel`, `cancelAndWait` — aussi avant une suppression) | `acp/v1.rs` : `cancel` |
| `session/set_mode` | `session-modes.mdx` | Projection et changement (`projectOptions`, `setOption`, `applyOption`) ; Zed réapplique ses `default_config_options` à chaque ouverture : le shim le note (`noteOptions`) | `acp/v1.rs` : `SetSessionModeRequest`, `AcpSessionModes` |
| `session/set_config_option` | `session-config-options.mdx` | Idem `set_mode` | `acp/v1.rs` : `set_config_option`, `config_state` ; `crates/acp_thread/src/config_options.rs` |
| `session/set_title` *(unstable)* | `schema.unstable.json` | Thread vivant : le shim émet (`setTitle`) ; thread fermé : client jetable (`session-loader.js` : `operate`), sans rouvrir Zed — la session n'a pas besoin d'être active. Titre rendu (éventuellement normalisé) superposé en attendant que Zed rattrape (`zra-daemon/thread-ops.js`). Gaté : `sessionCapabilities.title` | `conversation_view/thread_view.rs` : `apply_renamed_title` (+ `title_override` local, prioritaire) |
| `session/delete` *(unstable)* | `session-delete.mdx`, `schema.unstable.json` | Mêmes chemins que `set_title` ; tour en cours coupé avant ; tombstone persisté — la ligne de Zed reste, l'index la masque (`thread-ops.js`). Gaté : `sessionCapabilities.delete` | `threads_archive_view.rs` : `delete_thread` ; `session_list.supports_delete()` |

## Méthodes client (agent → ZRA, reçues par le shim)

| Méthode | Spec | Côté ZRA | Côté Zed |
|---|---|---|---|
| `session/update` | `prompt-turn.mdx`, `slash-commands.mdx`, `session-modes.mdx`, `session-config-options.mdx` | `noteUpdate` → état du thread : chunks, tool calls, plan, modes/options, commandes, titre. Message du mobile miroité vers Zed en `user_message_chunk` synthétique (`publishUserMessage`, `mirrorUserMessage`). Thread fermé : replay mémorisé par la PWA (`zra-client/js/acp.js`) | `acp/v1.rs` : `handle_session_notification` ; `acp_thread.rs` : `handle_session_update`, `push_user_content_block_with_protocol_id` |
| `session/request_permission` | `tool-calls.mdx` | Le shim répond à la place de Zed (`notePermission`, `respondPermission`), puis retire l'invite de Zed (`$/cancel_request`) | `acp/v1.rs` : `handle_request_permission` ; `acp_thread.rs` : `cancel_permission_request` |
| `elicitation/create` | `elicitation.mdx` | Publiée en `zra/elicitation` dans le thread de sa session (ou de la requête Zed citée) ; le shim répond à la place de Zed (`noteElicitation`, `respondElicitation`) puis retire son formulaire. Mode `url` : lien montré, s'ouvre sur le poste | `acp/v1.rs` : `handle_create_elicitation` ; `acp_thread.rs` : `request_elicitation_with_id` |
| `terminal/output` | `terminals.mdx` | Sortie publiée vers le daemon (`publishTerminal`) ; autre voie : `_meta` des tool calls (`terminalMeta`, PWA) | `acp/v1.rs` : `handle_terminal_output` ; `_meta.terminal_info`, `terminal_output`, `terminal_exit` |
| `terminal/wait_for_exit` | `terminals.mdx` | Réponse observée → `publishTerminal` | `acp/v1.rs` : traitement des terminaux (`wait_for_exit`) |
| `$/cancel_request` | `cancellation.mdx` | Émis pour retirer l'invite/formulaire de Zed après réponse du shim ; reçu : annulations de l'agent (`noteElicitationCancelled`) | `acp_thread.rs` : `cancel_permission_request`, `cancel_elicitation` |

## Compatibilité par agent

Constatée dans les sources des agents (installées sous `external_agents/registry`, ou web) — pas dans la spec. La source fiable au runtime reste la réponse `initialize` de chaque agent ; le shim la capture et le daemon la persiste par agent (`thread-ops.js`, `canRename`/`canDelete` du message `threads`).

### Renommer et supprimer

`session/set_title` : la réponse rend le titre stocké, éventuellement normalisé (le client affiche celui-là) ; l'agent ne doit plus le remplacer par un titre généré. Titre invalide : `-32602` ; session inconnue : `-32002`. `session/delete` : supprime la session de `session/list`, côté agent. Zed ouvert, un thread supprimé reste dans sa sidebar (cache) jusqu'au prochain démarrage, mais ne peut plus être ouvert.

Sources lues 2026-11 :

| Agent | `session/set_title` | `session/delete` |
|---|---|---|
| claude-acp | oui (v1 et v2) | oui |
| codex-acp | oui (v1 et v2) | oui |
| opencode | non | oui |
| goose | non | oui |
| kimi | non | non |
| gemini | non | non |

La matrice du registry ACP (`agentclientprotocol/registry`, `.protocol-matrix/latest.md`, 42 agents sondés) couvre `session/list`, `fork`, `resume`, `stop`, `set_model` — pas ces deux méthodes.

### Commandes slash

Spec : annonce par `session/update` `available_commands_update`, liste complète à chaque fois ; `name`/`description` requis, `input.hint` optionnel. Aucune méthode d'exécution dédiée : la commande part en texte (`/name args`) dans un `session/prompt` ordinaire. Côté Zed : parsing et validation à l'envoi (`completion_provider.rs` : `SlashCommandCompletion`, `message_editor.rs` : `confirm_command`, `validate_slash_commands`) — commande inconnue en début de message refusée ; la PWA porte le même comportement (`docs/fr/client.md`, fuzzy approché : `docs/fr/limitations.md`).

- **claude-acp** : publie ses commandes built-in, MCP (`mcp:serveur:commande`) et skills ; rejoue `available_commands_update` au `session/load` (thread fermé : menu disponible via le replay).
- **pi-acp** : publie ses skills en commandes `skill:nom`.
- **gemini-cli** : ne publie que `name`/`description` (pas d'`input`).
- Autres agents : la liste vient de leur `available_commands_update`, ZRA ne présume rien.

### Mentions : `resource_link` / `resource`

Spec (`content.mdx`) : `resource_link` `{uri, name, …}` — lien que l'agent lit lui-même, tout agent **MUST** le supporter dans un prompt ; `resource` (embedded) `{resource: {uri, text, mimeType?}}` — contenu texte dans le message, voie recommandée pour les mentions `@`, gatée par `promptCapabilities.embeddedContext`. Le format `[@nom](file:///…)` n'est **pas** le format fil : c'est la convention de sérialisation de Zed (`MentionUri::as_link`, `acp_thread/src/mention.rs` ; conversion : `message_editor.rs` : `mention_to_content_block`) et de claude-acp ; sur le fil, des blocs JSON. Construction des blocs et garde de chemin côté ZRA : `docs/fr/protocol.md` §3/§9.

Sources installées lues (`registry/npx/…`) ; sources web relues partiellement :

| Agent | `embeddedContext` | `resource_link` file:// | `resource` embedded |
|---|---|---|---|
| claude-acp | oui | texte `[@nom](file:///…)` → Claude lit lui-même (Read) | contenu injecté en `<context ref="…">` |
| pi-acp | **non par défaut** (env `PI_ACP_ENABLE_EMBEDDED_CONTEXT=true`) | texte `\n[Context] uri` → pi lit lui-même | `[Embedded Context] uri (mime)` + contenu |
| qwen-code | oui | `fileData` → lit lui-même (`readManyFiles`) ; **filtre workspace + fichiers ignorés** ; dossiers gérés | contexte texte |
| gemini-cli | oui (PR #6756) | même code que qwen (fork) ; dossier géré ; hors workspace → demande de permission ACP | contexte texte |
| opencode | oui | partie `file` → lit lui-même ; `zed://` aussi géré | texte `[chemin:ligne]` + contenu |
| codex-acp | oui (annoncé depuis 05/2026, commit #160) | supporté (README : « resource links ») — traitement non relu ligne à ligne | supporté (README) |
| goose | à vérifier | **lit le fichier UTF-8 et inline le contenu** ; non-UTF-8/dossier/absent : métadonnées préservées depuis PR #11941 (09/2026) — avant : silencieusement jeté (issue #11810) | en-tête `--- Resource: …` + contenu |
| kimi | oui (kimi-cli PR #1264 ; kimi-code 06/2026) | chemin décodé (+ ligne optionnelle) ; non-file → wrapper XML | géré |

Conséquences : `resource_link` est le dénominateur commun (MUST spec) ; l'embarqué garantit l'arrivée du contenu (qwen/gemini jettent les fichiers ignorés/hors workspace en lien ; goose jette les non-UTF-8). Dossiers : best effort selon l'agent (`docs/fr/limitations.md`).