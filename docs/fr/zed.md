# ZRA — correspondance avec Zed

Ce dont ZRA dépend dans Zed, et où le vérifier dans ses sources. Sert à l'audit de conformité au panneau agent et à suivre les évolutions de Zed.

## Référence

- **Version de référence : Zed 1.28.1** (stable, commit `e8bc16a`). Les chemins de cette page sont relatifs au dépôt de Zed et valent pour cette version.
- Sources en lecture seule dans `_upstream/zed` (ignoré par git, jamais embarqué). Mise en place :

  ```sh
  git clone --depth 1 --branch v1.28.1 https://github.com/zed-industries/zed.git _upstream/zed
  ```

- **Spécification ACP** : ZRA parle **ACP v1**. Zed 1.28.1 dépend du crate `agent-client-protocol-schema` 1.15.1, coupé au tag `v1.15.1` du dépôt de spécification — même commit que le JSON Schema `schema-v1.29.1` et que le brouillon `schema-v2.0.0-alpha.13`. Documentation et schémas en lecture seule dans `_upstream/acp` (ignorés par git, 8 Mo). Mise en place (Git Bash ; sous PowerShell, `curl.exe`) :

  ```sh
  mkdir -p _upstream/acp && curl -sL https://github.com/agentclientprotocol/agent-client-protocol/archive/refs/tags/v1.15.1.tar.gz | tar -xz --strip-components=1 -C _upstream/acp --exclude='*/assets/*'
  ```

  ZRA n'utilise aucun SDK ACP : le JSON-RPC est fait à la main (`zra-shim/framing.js`), donc ces pages sont la référence, pas une dépendance.
- Pages utiles côté ZRA, sous `_upstream/acp` : `schema/v1/meta.json` (la table des méthodes), `schema/v1/schema.json` (les formes exactes), `docs/protocol/v1/` — `session-setup`, `prompt-turn`, `tool-calls`, `elicitation`, `terminals`, `cancellation`, `slash-commands`, `session-modes`, `session-config-options` — et `docs/protocol/v2/` + `schema/v2/` pour le brouillon v2.
- Version installée sur le poste : `(Get-Item "$env:LOCALAPPDATA\Programs\Zed\Zed.exe").VersionInfo.ProductVersion` sous Windows, `zed --version` sous Linux.

## Faits de base

- **Index des threads** : table `sidebar_threads` de `db/0-<canal>/db.sqlite` (`0-stable` pour Zed stable), ouverte en lecture seule (fichier en WAL, Zed écrit en parallèle). Pour un agent ACP, Zed n'y garde que des métadonnées : le contenu appartient à l'agent, d'où `session/load` comme seule voie vers l'historique. `threads/threads.db` est l'ancien agent natif, ignoré.
- **Agents** : Zed lance l'agent en sous-processus et lui parle JSON-RPC sur stdio. Les agents du registry (`"type": "registry"`) n'ont pas de commande dans `settings.json` : Zed les installe sous `external_agents/registry`, où `agent-commands.js` les retrouve sans rien télécharger.
- **Fenêtre** : Zed dessine son interface (GPUI), son arbre UI Automation est vide. D'où le pilotage au clavier.

| | Windows | Linux |
|---|---|---|
| Index des threads | `%LOCALAPPDATA%\Zed\db\0-<canal>\db.sqlite` | `~/.local/share/zed/db/0-<canal>/db.sqlite` |
| `settings.json`, `keymap.json` | `%APPDATA%\Zed\` | `~/.config/zed/` |
| Agents installés | `%LOCALAPPDATA%\Zed\external_agents\registry` | `~/.local/share/zed/external_agents/registry` |
| Processus | `zed.exe` | `zed-editor` |

## Correspondance

### Données et fichiers de Zed

| ZRA | Côté ZRA | Côté Zed |
|---|---|---|
| Index des threads : colonnes requises `thread_id`, `session_id`, `agent_id`, `title`, `updated_at` ; facultatives `created_at`, `folder_paths`, `folder_paths_order`, `archived`, `interacted_at`, `title_override`, `remote_connection`, `main_worktree_paths(_order)` | `zra-daemon/threads-index.js` | `crates/agent_ui/src/thread_metadata_store.rs` : `ThreadMetadataDb::MIGRATIONS` (schéma), `LIST_QUERY`, `impl Column for ThreadMetadata` (valeurs nulles, titres vides, `agent_id` NULL = agent natif) ; `crates/util/src/path_list.rs` : `PathList` (chemins triés, séparés par `\n`, ordre d'affichage dans `*_order`) |
| Projets du sidebar et leur ordre : `kv_store` clé `session_id`, puis `workspaces` (`paths`, `paths_order`, `session_id`, `window_id`, `remote_connection_id`) et `scoped_kv_store` (`multi_workspace_state`, clé `window_id` : `project_groups`). Entrée périmée (`window_id` réutilisé) ignorée ; pas de `session_window_stack` sous Windows | `zra-daemon/threads-index.js` (`readZedProjects`) | `crates/session/src/session.rs` (`SESSION_ID_KEY`), `crates/workspace/src/persistence.rs` (`workspaces`, `read_multi_workspace_state`, `last_session_workspace_locations`), `crates/workspace/src/multi_workspace.rs` (`serialize_now`, `detach_workspace` efface `session_id`) |
| Canal de Zed : base `db/0-<canal>/db.sqlite`, canal détecté par la base écrite en dernier, ou fixé par `zedChannel` | `zra-daemon/platform.js` (`detectZedChannel`), `zra-daemon/config.js` | `crates/db/src/db.rs` : `db_path` ; `crates/release_channel/src/lib.rs` : `dev_name` ; `crates/paths/src/paths.rs` : `database_dir` |
| CLI de Zed par canal : `Programs\Zed Preview\bin\zed.exe`, `~/.local/zed-preview.app/bin/zed`… | `zra-daemon/platform.js` (`zedCliCandidates`) | `script/bundle-windows.ps1`, `crates/zed/resources/windows/zed.iss`, `script/install.sh` |
| Ouverture d'un projet : toujours `zed --classic <dossiers>` — la fenêtre qui a ces dossiers est ramenée au premier plan, sinon une fenêtre dédiée s'ouvre. Sans option, le défaut suit `cli_default_open_behavior` : `new_window` exclut la racine des worktrees ouverts de la recherche (`MatchSubpaths`) → une fenêtre neuve à chaque appel pour un projet déjà ouvert ; `--classic` fait `MatchExact` (racine comprise). Option refusée par une autre version : relancé sans | `zra-daemon/zed/driver.js` (`ZedCli`) | `crates/cli/src/main.rs` : option cachée `classic`, `OpenBehavior` ; `crates/zed/src/zed/open_listener.rs` : `handle_cli_connection`, `open_options_for_behavior` ; `crates/workspace/src/workspace.rs` : `find_existing_workspace`, `WorkspaceMatching` |
| Ouvrir un projet ne crée jamais les dossiers manquants : en local, worktree sans racine sur disque (métadonnées absentes → worktree vide, aucune création) ; en dev server, erreur « '{path}' does not exist ». D'où le `mkdir` explicite de ZRA avant la CLI (bouton « nouveau projet ») | `zra-daemon/hub.js` (`newProject`), `zra-daemon/zed/driver.js` (`ZedCli`) | `crates/worktree/src/worktree.rs` : `Worktree::local` (`metadata` absent → aucune entrée racine, pas de création) ; `crates/workspace/src/workspace.rs` : `DevServerProjectPathDoesNotExist`, `show_error` ; `crates/cli/src/main.rs` : `create_empty_stub` (stubs de diff seulement) |
| Agents installés du registry : `external_agents/registry`, commande (`bin` au nom du paquet) et `env` (registry, puis réglages) | `zra-daemon/agent-commands.js` | `crates/paths/src/paths.rs` : `external_agents_dir` ; `crates/project/src/agent_server_store.rs` : `LocalRegistryNpxAgent::get_command`, `LocalRegistryArchiveAgent::get_command` ; `crates/node_runtime/src/node_runtime.rs` : `read_package_executable` |
| Entrées `agent_servers` de `settings.json` : ZRA écrit `type: "custom"` (`command`, `args`, `env`, et de l'agent d'origine `default_mode`, `default_config_options`, `favorite_config_option_values`) pour les agents binaires, lit aussi `type: "registry"` | `scripts/setup.mjs` (`buildEntry`), `zra-daemon/zed-settings.js` | `crates/settings_content/src/agent.rs` : `CustomAgentServerSettings` |
| Entrée `registry` shimée par l'env (agents npx) : ZRA fusionne `NODE_OPTIONS` (preload `--import data:` du launcher) + `ZRA_*` dans l'`env` de l'entrée d'origine, qui reste `registry` (Zed garde install et updates). Une entrée `registry` n'a pas de commande, seulement `env`, `default_mode`, `default_config_options`, `favorite_config_option_values` ; son `env` (`settings_env`) s'applique **en dernier**, par-dessus l'env du registry et de Zed, et ne vaut que pour la commande de l'agent — pas pour l'`npm install` de Zed | `scripts/setup.mjs` (`buildPreloadEnv`), `zra-daemon/zed-settings.js` (`upsertAgentServerEnv`), `zra-daemon/agent-commands.js` (`preloadFlag`, `withoutZraEnv`) | `crates/settings_content/src/agent.rs` : `CustomAgentServerSettings::Registry` ; `crates/project/src/agent_server_store.rs` : `LocalRegistryNpxAgent::get_command` (`env.extend(settings_env)` après `distribution_env`/`extra_env`, `install_npx_package` lancé avant, hors `settings_env`) |
| Preload node fail-open : `--import data:text/javascript,…` (payload percent-encodé, sans dépendance fichier au parse) charge le launcher avant le code de l'agent ; ZRA supprimé ⇒ l'import dynamique échoue, le `catch` avale, l'agent démarre sans ZRA. `--require fichier` serait fatal (fichier manquant). Le launcher spawn le shim, retire `NODE_OPTIONS` de l'env transmis (pas de cascade), garde `ZRA_SHIMMED` contre le double enveloppement | `zra-shim/launcher.mjs`, `zra-daemon/agent-commands.js` (`preloadFlag`) | node ≥ 20.6 (`--import`), Zed embarque v24.22.1 (`crates/node_runtime`) ; comportement node, pas Zed |
| Panneau « Agent Registry » : Install recrée `agent_servers.<id>` en `{"type":"registry"}` à `env` vide (`or_insert_with`, ne remplace pas une entrée déjà là) ; Remove supprime l'entrée registry. Zed ne réécrit jamais `agent_servers` sur erreur — toute écriture est une action explicite | `scripts/setup.mjs` (uninstall retire l'env ZRA, pas l'entrée) | `crates/agent_ui/src/agent_registry_ui.rs` : boutons Install/Remove (`update_settings_file`) |
| Chemins `settings.json`, `keymap.json` | `zra-daemon/platform.js` | `crates/paths/src/paths.rs` : `config_dir`, `settings_file`, `keymap_file` (Flatpak et `--user-data-dir` non gérés par ZRA) |

### Clavier et fenêtre

| ZRA | Côté ZRA | Côté Zed |
|---|---|---|
| Touche « nouveau thread » par agent : `agent::NewExternalAgentThread`, argument `{ "custom": { "name": id } }` (forme ancienne, acceptée) ; touches `ctrl-alt-shift-f1`… libres par défaut | `zra-daemon/zed-keymap.js` | `crates/agent_ui/src/agent_ui.rs` : `NewExternalAgentThread`, `deserialize_external_agent_id` ; enregistrée sur le workspace (`crates/agent_ui/src/agent_panel.rs`) |
| Recette `openThread` : `workspace: focus center pane` puis `multi workspace: focus workspace sidebar` | `zra-daemon/zed/driver.js` | `crates/workspace/src/workspace.rs` : `FocusCenterPane` (focus éditeur, évite la bascule) ; `crates/workspace/src/multi_workspace.rs` : `FocusWorkspaceSidebar`, `focus_sidebar` (bascule) ; libellé : `crates/command_palette/src/command_palette.rs` (`humanize_action_name`) |
| Recette `newThread` (repli) : palette `agent: new thread` | `zra-daemon/zed/driver.js` | `crates/agent_ui/src/agent_ui.rs` : `NewThread` |
| Touches par défaut citées par le pilote (`ctrl-shift-p`, `ctrl-n`, `ctrl-f`…) | `zra-daemon/zed/driver.js` | `assets/keymaps/default-windows.json`, `default-linux.json` |
| Filtre du sidebar : taper puis `enter` ouvre le premier thread (titre non unique : `limitations.md`) | `zra-daemon/zed/driver.js` | `crates/sidebar/src/sidebar.rs` : `rebuild_contents` (filtre flou), `select_first_entry`, `confirm` |
| Fenêtre reconnue à son titre (« projet — fichier » ; format personnalisé : `limitations.md`) | `zra-daemon/zed/keyboard.ps1`, `driver.js` (`projectWindow`) | `crates/workspace/src/workspace.rs` : `apply_window_title`, `project_window_title` ; format par défaut dans `assets/settings/default.json` (`window_title_format`) |

### ACP

| ZRA | Côté ZRA | Côté Zed |
|---|---|---|
| Relais et observation d'ACP v1, capacités de Zed transmises telles quelles | `zra-shim/acp.js` | `crates/agent_servers/src/acp.rs` : `connect` ; `crates/agent_servers/src/acp/v1.rs` (`client_builder`, `client_capabilities_for_agent`). Crate `agent-client-protocol` 5.0.0 (`Cargo.toml`) |
| ACP v2 | non géré | `crates/agent_servers/src/acp/v2.rs`, tenté d'abord quand le drapeau `AcpBetaFeatureFlag` est actif, repli sur v1 |
| Sessions suivies : `session/new`, `session/load`, `session/resume` ; retirées à `session/close` | `zra-shim/acp.js` (`noteResponse`) | `crates/agent_ui/src/conversation_view.rs` (`load_session`, sinon `resume_session`) ; `crates/agent_servers/src/acp/v1.rs` (`release_session` : `session/close`) |
| Permissions : le shim répond à la place de Zed, puis retire l'invite de Zed (`$/cancel_request`) | `zra-shim/acp.js` | `crates/agent_servers/src/acp/v1.rs` (`handle_request_permission`) ; `crates/acp_thread/src/acp_thread.rs` (`apply_reported_status`, `cancel_permission_request`) |
| Questions de l'agent (élicitation en formulaire, `AskUserQuestion` de Claude Agent) : publiées en `zra/elicitation` dans le thread de leur session ou de la requête de Zed qu'elles citent, le shim répond à la place de Zed puis retire son formulaire (`$/cancel_request`) ; un lien à ouvrir (mode `url`) est montré, mais s'ouvre sur le poste | `zra-shim/acp.js` (`noteElicitation`, `respondElicitation`) | `crates/agent_servers/src/acp.rs` (`handle_v2_create_elicitation` : `cancel_elicitation` sur annulation) ; `crates/acp_thread/src/acp_thread.rs` (`request_elicitation_with_id`, `has_pending_turn_action`) |
| Message du mobile affiché dans Zed (`user_message_chunk` synthétique) | `zra-shim/acp.js` | `crates/acp_thread/src/acp_thread.rs` : `handle_session_update`, `push_user_content_block_with_protocol_id` |
| Tour lancé depuis le mobile, vu de Zed (`limitations.md`) | `zra-shim/acp.js` | `crates/acp_thread/src/acp_thread.rs` : `uses_reported_activity`, `status` |
| Mode, modèle, options : projection et changement | `zra-shim/acp.js` (`projectOptions`, `applyOption`) | `crates/agent_servers/src/acp/v1.rs` : `config_state`, `ConfigOptions::set_config_option`, `AcpSessionModes` ; `crates/acp_thread/src/config_options.rs` |
| Sortie des terminaux : réponses à `terminal/*`, ou `_meta` des tool calls | `zra-shim/acp.js` (`publishTerminal`), `zra-client/js/acp.js` (`terminalMeta`) | `crates/agent_servers/src/acp/v1.rs` : `handle_terminal_output` ; `_meta.terminal_info`, `terminal_output`, `terminal_exit` dans `handle_session_notification` |
| Relecture d'un thread fermé : client ACP jetable, `session/load`, capacités de Zed (dont `_meta.terminal_output`), environnement du projet (shell de connexion et direnv sous Linux et macOS ; sous Windows, celui de la session, comme Zed). Sans serveurs MCP, par choix (`docs/fr/limitations.md`) | `zra-daemon/session-loader.js`, `acp-client.js`, `shell-env.js` | `crates/agent_servers/src/acp/v1.rs` : `load_session`, `session_directories_from_work_dirs`, `client_capabilities_for_agent` ; `crates/project/src/environment.rs` : `local_directory_environment`, `load_direnv_environment` ; `crates/util/src/shell_env.rs` : `capture` |

### Interface : PWA ↔ panneau agent

Comportement seulement ; l'apparence : galeries et écarts volontaires dans `reference/zed-ui/zed-ui.md`. Côté Zed, sauf mention : `crates/agent_ui/src/conversation_view/thread_view.rs`.

| PWA (`zra-client/js/`) | Côté Zed |
|---|---|
| Liste des threads, par projet (`views/threads.js` : `threadRow`, `projectHead` ; `format.js` : `relTime`, `projectOf`) | `crates/sidebar/src/sidebar.rs` : `rebuild_contents`, `thread_display_time`, `render_thread`, `render_project_header` ; `crates/project/src/project.rs` : `ProjectGroupKey::display_name` ; `crates/agent_ui/src/threads_archive_view.rs` : `format_history_entry_timestamp` |
| Fil : réduction des `session/update` (`acp.js` : `Timeline.apply`) | `crates/acp_thread/src/acp_thread.rs` : `handle_session_update`, `upsert_tool_call`, `update_tool_call`, `can_merge_message_chunks` |
| Message de l'utilisateur, de l'agent (`views/entry.js` : `userMsg`, `agentMsg`) | `render_entry`, `render_message_content` |
| Réflexions (`thoughtMsg`) : marges horizontales 20 px comme les autres entrées (dans Zed, chunk du message assistant `px_5`) | `render_thinking_block` ; `crates/agent_ui/src/entry_view_state.rs` : `auto_expand_streaming_thought` |
| Tool calls : deux dispositions (ligne simple / carte), en-tête, échec en croix, dépliement (`toolCall`) ; icônes par kind (`TOOL_KIND_ICON` : `read`/`search` → loupe `ToolSearch`) ; pas de blocs « Entrée/Sortie brute » sur les cartes gérées : le brut n'est rendu que pour les événements non reconnus (`rawCard`) — écart ZRA (Zed : « View Raw Input », `conversation_view/thread_view.rs:9731`) | `render_tool_call`, `render_tool_call_label`, `render_tool_call_content` ; réglages `expand_edit_card`, `expand_terminal_card` |
| Terminal (`terminalCard`) : cwd (agent `terminal_info.cwd`, sinon projet du thread), durée `(1m 11s)` au-delà de 10 s (live puis figée), échec en croix rouge, code en infobulle | `render_terminal_tool_call` ; `crates/agent_ui/src/ui/terminal_tool_header.rs` ; `util/time.rs` (`duration_alt_display`) |
| Diff (`diffBlock`, `diff.js`) : sans gouttière, lignes remplies à 12 % | `render_diff_editor` |
| Plan, au-dessus du composer (`views/entry.js` : `planPanel` ; `views/thread.js` : `syncActivity`) | `render_activity_bar`, `render_plan_entries`, `render_plan_summary` |
| Permission dans la carte de son tool call (`permissionButtons`), rappelée au-dessus du composer quand la carte est hors de vue ; tool call créé par la demande (`acp.js` : `permission`) ; en-tête : icône warning `alert-triangle` à la place de la pastille quand une permission est en attente (`views/thread.js` : `syncStatusDot`) — adaptation ZRA | `render_permission_buttons` et variantes, `render_main_agent_awaiting_permission` ; `crates/acp_thread/src/acp_thread.rs` : `request_tool_call_authorization` (`upsert_tool_call`) |
| Question de l'agent : carte du fil, champs selon le schéma, Envoyer / Refuser / Annuler, retirée une fois répondue (`views/entry.js` : `elicitationCard`) ; défauts et validation — requis, longueurs, motif, formats `email`/`uri`/`date`/`date-time`, bornes, nombre de choix (`elicitation.js`) | `conversation_view/elicitation.rs` : `ElicitationCard`, `render_field`, `render_actions`, `should_render_elicitation`, `validate`, `validate_*_value`, `multi_select_default_value` |
| Tour en cours : spinner braille Dots / Sand, durée (`views/thread.js` : `syncTurn`) | `render_generating` ; `ui/components/label/spinner_label.rs` |
| Callout au-dessus du composer (`callout.js`, `views/thread.js` : `paintCallout`) : un seul à la fois (priorité : état du poste > réouverture > erreur d'agent > erreur de commande > échec d'historique > avis warn/error > chargement d'historique > état du thread), sévérités error/warning/info (icône info muted), titre + actions sur une ligne (boutons, spinner d'action en cours `arrow_circle` animé, copier, fermer), description muted scrollable 128 px ; erreur d'agent (`session/prompt` refusé) : description markdown en texte seul (message, `data` string ajouté en texte ; pas de bloc JSON), retry du prompt refusé, copier, fermer, saisie refusée rendue au brouillon ; échec de chargement/relance : titre « Échec du lancement »/« Échec du chargement », retry (recharger), copier, fermer ; avis warn/error de l'agent ou du daemon : callout fermable ; « Tour interrompu » : info éphémère (`untilSend`) en callout info, effacé à l'envoi suivant ; les autres avis info restent en ligne dans le fil (écart ZRA : Zed les rend en callouts) ; chargement d'historique : callout info à spinner ; les états de connexion ZRA (appairage, hors ligne, réouverture, lecture seule, thread fermé/sans session) sont rendus en callouts | `ui/components/callout.rs` (`Callout`, `Severity`, `CalloutBorderPosition`, `render`) ; `thread_view.rs` `render_any_thread_error`, `render_load_error`, `render_session_notices` ; `conversation_view.rs` `render_auth_required_state` (spinner `ArrowCircle`) ; `agent_ui/src/ui/session_notice.rs` (`SessionNotice`) ; galerie section 11 |
| Ligne de compaction (`views/entry.js` : `compactionLine`) : [filet][bouton icône compact + libellé + chevron][filet], px 20, corps (blocs, erreur) déplié sous la ligne ; notices info en ligne [filet][libellé][filet] | `thread_view.rs` `render_context_compaction` ; galerie section 12 |
| Composer (`views/thread.js` : `Composer`, `editor.js`) : contenteditable à façade textarea (conception D2 — brouillon texte, Entrée/Maj+Entrée/Ctrl+Entrée, collage texte brut, autogrow CSS), puces de mention `.mention` atomiques sérialisées [@nom](uri) (D3), saisie buffer 12, barre gauche « + » / droite jauge + sélecteurs + stop + envoi | `crates/agent_ui/src/message_editor.rs`, `render_send_button`, `ui/mention_crease.rs` |
| Complétion slash (`completion.js`, `Composer`) : menu `/` ancré au caret, au-dessus (le composer est en bas), filtre fuzzy approché (gras), en-tête « Commands » masqué quand un argument est saisi, description de l'item sélectionné en aparté (droite si ≥ 260 px, sinon au-dessus), confirmer envoie sauf argument attendu non saisi ; menu fermé dès qu'un blanc suit la commande ; validation `/commande` inconnue → callout « An Error Happened » au-dessus du composer (`try_parse` : espace seul ⇒ argument nul — ZRA suit les tests, pas le `trim_end` du code) ; placeholder « / for commands » si l'agent publie des commandes | `completion_provider.rs` (`SlashCommandCompletion::try_parse`, `search_slash_commands`), `message_editor.rs` (`validate_slash_commands`, `confirm_command`, `placeholder_text`), `crates/editor/src/code_context_menus.rs` (`render`, `render_aside`), `crates/editor/src/element.rs` (`layout_context_menu_aside`) ; galerie section 14 |
| Hint d'argument de commande (`input.hint`) : inlay muted après `/name ` tant qu'il n'y a pas d'argument (position = fin du dernier non-blanc + 1, clampée au texte ; espace préfixée si absente) | `message_editor.rs` (`command_hint`, `InlayHintKind::Parameter`, couleur `syntax.hint`, sans fond) |
| Complétion mentions (`mentions.js`, `completion.js`) : `@` le plus à droite en frontière (début, blanc, `(` `[` `{`), pas de blanc juste après ; fichiers **et dossiers** du projet (listing daemon, requête `files`), fuzzy approché borné 100, icônes fichier/dossier, pas d'aparté ; confirmer insère la puce + un espace ; menu fermé dès qu'un blanc suit la requête | `completion_provider.rs` (`MentionCompletion::try_parse`, `Candidates::Entries`, `match_path_sets`), `ui/mention_crease.rs` ; galerie section 14 |
| Sérialisation et envoi des mentions : puces ↔ texte [@nom](file:///…) (percent-encodé, `/` final dossier), liens du texte reparsés, blocs `resource`/`resource_link` selon `embeddedContext`, garde realpath dans `folderPaths` | `acp_thread/src/mention.rs` (`MentionUri::as_link`, `to_uri`), `message_editor.rs` (`parse_mention_links`, `mention_to_content_block`) |
| Jeu d'icônes de fichiers (`file-icons.js`, réglage Jeu d'icônes) : défaut générique ; « Colored Zed Dark/Light » vendored (extension TheRedXD, `icon-themes/colored-zed/` + LICENSES), résolution nom/extension comme Zed, associations du défaut Zed fusionnées avec les surcharges du jeu ; pas de téléchargement d'extensions | `acp_thread/src/mention.rs` (`MentionUri::icon_path`), `file_icons/src/file_icons.rs` (`get_icon`), `theme/src/registry.rs` (fusion sur le défaut), `theme/src/icon_theme.rs` (associations, lues par `scripts/gen-file-icons.mjs`) |
| Mode, modèle, options (`views/thread.js`) : sélecteurs dans la barre du composer ; réduction icon-only mobile = implémentation ZRA | `crates/agent_ui/src/mode_selector.rs`, `model_selector.rs`, `config_options.rs` |
| File d'attente, Stop (`views/thread.js` : `stopTurn`) | `conversation_view/message_queue.rs` (`MessageQueue`), `cancel_generation`, `render_message_queue_entries` |
| Thèmes (`css/themes.css`, généré par `scripts/gen-themes.mjs`) | `assets/themes/` (MIT) ; jetons : `crates/theme/` |
| Icônes (`icons.js`), icônes d'agents (`agent-icons.js`, `scripts/gen-agent-icons.mjs` ; registre ACP via le cache de Zed, `zra-daemon/agent-icons.js`) | `assets/icons/` (Lucide, ISC ; icônes de marques à part) ; `crates/project/src/agent_registry_store.rs` (registre ACP) |
| Espacements, tailles de texte, rayons (`css/app.css`) | `crates/ui/src/styles/` (`spacing.rs`, `typography.rs`, `elevation.rs`) ; composants : `crates/ui/src/components/` |

Les styles GPUI s'écrivent comme des classes utilitaires (`.px_2()`, `.gap_1()`, `.rounded_md()`, `.text_color(colors.text_muted)`) : chacun se traduit en une déclaration CSS. Les valeurs de base de `crates/ui/src/styles/` deviennent des variables CSS dans `app.css`, comme les couleurs dans `themes.css`.

## Points de vigilance

- **Plusieurs canaux installés** : ZRA suit celui dont la base a été écrite en dernier, déterminé au démarrage du daemon. Pour en suivre un autre : `zedChannel` dans `zra.config.json`.
- **ACP v2** : derrière un drapeau bêta dans Zed 1.28.1. S'il devient le défaut, le shim voit passer des trames v2 qu'il n'observe pas. Brouillon sous `_upstream/acp/docs/protocol/v2/`, `migration.mdx` liste les ruptures.
- **Palette** : ses libellés dérivent des noms d'actions (`humanize_action_name`). Une action renommée casse la recette correspondante.

## Mettre à jour la référence

1. Récupérer la nouvelle version et lister ce qui a changé sur les chemins de cette page :

   ```sh
   git -C _upstream/zed fetch --depth 1 origin tag vX.Y.Z
   git -C _upstream/zed diff v1.28.1 vX.Y.Z --stat -- crates/agent_ui crates/sidebar crates/workspace/src/persistence.rs crates/workspace/src/multi_workspace.rs crates/session crates/db crates/paths crates/agent_servers crates/acp_thread crates/project/src/agent_server_store.rs crates/project/src/project.rs crates/workspace/src/workspace.rs crates/util/src/path_list.rs crates/node_runtime crates/cli crates/command_palette crates/settings_content/src/agent.rs crates/ui crates/theme assets/keymaps assets/themes assets/icons
   git -C _upstream/zed checkout vX.Y.Z
   ```

   Le diff demande l'ancien tag localement : sinon, `git fetch --depth 1 origin tag v1.28.1` d'abord.

2. Relire les fichiers touchés, mettre à jour les tableaux et la version de référence.
3. Thèmes ou icônes modifiés : relancer `scripts/gen-themes.mjs` ou `scripts/gen-agent-icons.mjs`.
4. Vérifier un poste (`docs/fr/architecture.md`, « Vérifier une machine »).

La référence ACP se met à jour à part : quand `Cargo.lock` de Zed change de version `agent-client-protocol-schema`, re-télécharger le tag du même nom (commande ci-dessus, autre tag). Les changements entre versions sont dans `schema/v1/CHANGELOG.md` et `schema/v2/CHANGELOG.md`.
