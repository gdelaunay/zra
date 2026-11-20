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

Ce que ZRA en fait — jamais d'écriture dans la base de Zed (discipline lecture seule de `threads-index.js`) :

- **Thread vivant** : le shim émet la requête sur la connexion que Zed tient (`zra-shim/acp.js` : `setTitle`, `deleteSession`). Un tour en cours est coupé avant la suppression.
- **Thread fermé** : client jetable (`zra-daemon/session-loader.js` : `operate`), sans rouvrir Zed — la méthode porte sur la session stockée côté agent.
- **`zra-daemon/thread-ops.js`** porte l'état persisté (`.zra/thread-ops.json`) : tombstones (la ligne de Zed reste, l'index la masque — pas de résurrection), titres rendus par l'agent superposés en attendant que Zed rattrape (un renommage fait dans Zed prime et retire la superposition), capacités par agent pour le gating (`canRename`/`canDelete` du message `threads`, absents = inconnu).
- Zed ouvert, un thread supprimé reste dans sa sidebar (cache) jusqu'au prochain démarrage, mais ne peut plus être ouvert.
- Côté PWA : `rename_thread` / `delete_thread` (`docs/fr/protocol.md` §3) ; erreurs `capability_missing` quand l'agent ne supporte pas la méthode.

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

## Commandes slash

Spec : `_upstream/acp/docs/protocol/v1/slash-commands.mdx` (v1.15.1).

- **Annonce** : notification `session/update` `available_commands_update`,
  liste complète à chaque fois (l'agent peut ajouter/retirer en cours de
  session). `AvailableCommand` : `name` et `description` requis, `input.hint`
  optionnel (hint d'argument, texte non structuré).
- **Exécution** : aucune méthode dédiée — la commande part en texte
  (`/name args`) dans un `session/prompt` ordinaire ; l'agent reconnaît le
  préfixe. Une commande peut accompagner d'autres blocs du même prompt.

Côté Zed (1.28.1, sources lues) :

- Déclencheur : `/` le plus à droite en frontière de mot, pas de blanc juste
  après (`completion_provider.rs` `SlashCommandCompletion::try_parse`) ;
  filtre fuzzy sur le nom ; confirmation insère `/name ` en gardant l'argument
  tapé, et **envoie** (`message_editor.rs` `confirm_command → send`), sauf si
  la commande a un `input` et qu'aucun argument n'est saisi.
- `input.hint` → inlay après la commande tant qu'il n'y a pas d'argument
  (`command_hint`) ; en-tête « Commands » masqué quand un argument est saisi.
- Validation à l'envoi (`validate_slash_commands`) : `/commande` inconnue en
  début de message → erreur bloquante (liste vide comprise, « none ») ;
  callout « An Error Happened » au-dessus du composer. Un espace devant le `/`
  échappe à la règle.

Ce que ZRA en fait (0.5.2, 5a) :

- Le shim garde `name`, `description` et `input.hint`
  (`zra-shim/acp.js`, `available_commands_update`) → `thread_state.commands`
  (`docs/fr/protocol.md` §4) → menu `/` du composer
  (`zra-client/js/completion.js`) : parsing et validation portés de Zed, fuzzy
  approché (`docs/fr/limitations.md`), description de l'item sélectionné en
  aparté, callout d'erreur identique. Le hint d'argument s'affiche en span
  fantôme après `/name ` (composer contenteditable, 5b-1).
- Thread fermé : pas de shim, mais claude-acp rejoue
  `available_commands_update` au `session/load` → la PWA le mémorise via
  `history` (`zra-client/js/acp.js`), le menu est disponible.
- Agents (sources lues) : claude-acp publie ses commandes built-in, MCP
  (`mcp:serveur:commande`) et skills ; pi-acp publie ses skills en commandes
  `skill:nom` ; gemini-cli ne publie que `name`/`description` (pas d'`input`).
  Les autres agents : la liste vient de leur `available_commands_update`,
  ZRA ne présume rien.

## Mentions : `resource_link` / `resource`

Spec : `_upstream/acp/docs/protocol/v1/content.mdx` (v1.15.1).

- **`resource_link`** `{uri, name, …}` : lien vers une ressource que l'agent
  lit lui-même ; tout agent **MUST** le supporter dans un prompt.
- **`resource`** (embedded) `{resource: {uri, text, mimeType?}}` : le contenu
  texte est dans le message ; voie **recommandée** pour les mentions `@`,
  gatée par la capacité `promptCapabilities.embeddedContext` de l'`initialize`.
- Le format `[@nom](file:///…)` n'est **pas** le format fil : c'est la
  convention de sérialisation de Zed (`MentionUri::as_link`) et la conversion
  interne de claude-acp. Sur le fil, ce sont des blocs JSON.

Côté Zed (1.28.1, sources lues) : `mention_to_content_block`
(`message_editor.rs`) — fichier texte → `resource` si l'agent annonce
`embeddedContext`, sinon `resource_link` ; dossier → toujours `resource_link`
(URI `file:///` avec `/` final, `MentionUri::to_uri`,
`acp_thread/src/mention.rs`). Liens du texte reparsés par
`parse_mention_links` ; le rejeu claude-acp de `session/load` rend les messages
utilisateur en **texte** contenant ces liens markdown, pas en blocs.

Ce que ZRA en fait (0.5.2, 5b-2, conception D1/D3/D5) :

- La PWA saisit les mentions en puces, sérialisées `[@nom](file:///…)` dans le
  texte envoyé (`zra-client/js/mentions.js`, `editor.js`). Le **daemon** parse
  les liens au départ et construit les blocs (`zra-daemon/mentions.js`) :
  fichier texte ≤ 1 Mo et agent `embeddedContext` → `resource` (contenu lu par
  le daemon) ; sinon `resource_link` ; dossier, binaire, non-UTF-8, > 1 Mo →
  `resource_link`. **Garde** : le `realpath` doit être contenu dans les
  `folderPaths` réels du thread ; hors périmètre → texte littéral (§9).
- Listing des fichiers par le daemon (requête `files`, `docs/fr/protocol.md`
  §3) : `git ls-files --cached --others --exclude-standard`, repli walk hors
  git (+ `node_modules` exclu), borne 20 000, cache 30 s ; fuzzy côté PWA,
  borne 100.
- Le shim envoie les blocs tels quels (`sendPrompt`, `zra-shim/acp.js`) ; la
  file d'attente garde le texte pour l'affichage et les blocs pour l'envoi.
- Rendu PWA : puces `.mention` dans les bulles utilisateur — blocs
  `resource_link`/`resource` **et** liens markdown du texte rejeu.

Matrice agents (sources installées lues : `registry/npx/…`, vérifié ; sources
web relues partiellement : relevé) :

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

Conséquences : `resource_link` est le dénominateur commun (MUST spec) ;
l'embarqué garantit l'arrivée du contenu (qwen/gemini jettent les fichiers
ignorés/hors workspace en lien ; goose jette les non-UTF-8). Dossiers : best
effort selon l'agent (`docs/fr/limitations.md`).
