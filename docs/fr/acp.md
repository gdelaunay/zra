# ZRA — fiches ACP

Fiches par méthode du protocole ACP : ce que dit la spec, comment Zed s'en sert, ce que ZRA en fait, et quels agents l'implémentent. Complète `docs/fr/zed.md` (correspondance avec Zed) et `docs/fr/protocol.md` (contrat PWA ↔ daemon).

Référence spec : `_upstream/acp` (tag v1.15.1, mise en place dans `docs/fr/zed.md`) ; les méthodes unstable sont dans `schema/v1/schema.unstable.json`. ZRA parle ACP v1.

## Renommer et supprimer un thread

Côté Zed, tout passe par `ThreadMetadataStore` (`crates/agent_ui/src/thread_metadata_store.rs`), adossé à `sidebar_threads` : cache mémoire, écritures en file, relecture de la base **uniquement au démarrage et aux migrations** — aucun watcher de fichier, aucune invalidation externe.

- **Renommer** : `title_override` (prioritaire sur le `title` généré, `set_title_override`) ; si l'agent le supporte, Zed appelle aussi `session/set_title` (`conversation_view/thread_view.rs` : `apply_renamed_title`). Le titre agent revient par le flux normal (`session_info_update` si le thread est live, `session/load` sinon).
- **Supprimer** (vue archive, `threads_archive_view.rs` : `delete_thread`) : suppression de la ligne de métadonnées, puis `session/delete` **seulement si l'agent l'annonce** (`session_list.supports_delete()`).
- **Archiver** : flag local `archived`, aucun équivalent ACP. ZRA ne l'utilise pas.

Les deux méthodes ACP sont **unstable** (`_upstream/acp/schema/v1/schema.unstable.json`), gatées par la réponse `initialize` de l'agent — `agentCapabilities.sessionCapabilities.title` et `.delete` — que le shim capture déjà (`zra-shim/acp.js` : `noteResponse`).

- `session/set_title` : la session n'a pas besoin d'être active sur la connexion. La réponse rend le titre stocké, éventuellement normalisé (le client affiche celui-là) ; l'agent ne doit plus le remplacer par un titre généré. Titre invalide : `-32602` ; session inconnue : `-32002`.
- `session/delete` : supprime la session de `session/list`, côté agent.

Conséquences pour ZRA : jamais d'écriture dans la base de Zed (discipline lecture seule de `threads-index.js`) — renommage et suppression passent par ACP via le shim. Zed ouvert, un thread supprimé reste dans sa sidebar (cache) jusqu'au prochain démarrage, mais ne peut plus être ouvert : pas de résurrection.

Compatibilité relevée dans les sources des agents (2026-11) :

| Agent | `session/set_title` | `session/delete` |
|---|---|---|
| claude-acp | oui (v1 et v2) | oui |
| codex-acp | oui (v1 et v2) | oui |
| opencode | non | oui |
| goose | non | oui |
| kimi | non | non |
| gemini | non | non |

La matrice du registry ACP (`agentclientprotocol/registry`, `.protocol-matrix/latest.md`, 42 agents sondés) couvre `session/list`, `fork`, `resume`, `stop`, `set_model` — pas ces deux méthodes. La source fiable reste la réponse `initialize` de chaque agent.
