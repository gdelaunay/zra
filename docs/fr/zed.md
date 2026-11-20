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

**État** des lignes : **vérifié** (lu dans les sources de la version de référence), **relevé** (constaté sur un poste, pas encore relu dans les sources), **à vérifier** (source repérée, pas encore relue), **écart** (vérifié, différent de Zed : voir `ISSUES.md`), **à auditer** (la PWA imite Zed, l'écart reste à mesurer), **limitation** (écart accepté, documenté : voir `docs/fr/limitations.md`).

### Données et fichiers de Zed

| ZRA | Côté ZRA | Côté Zed | État |
|---|---|---|---|
| Index des threads : colonnes requises `thread_id`, `session_id`, `agent_id`, `title`, `updated_at` ; facultatives `created_at`, `folder_paths`, `folder_paths_order`, `archived`, `interacted_at`, `title_override`, `remote_connection`, `main_worktree_paths(_order)` | `zra-daemon/threads-index.js` | `crates/agent_ui/src/thread_metadata_store.rs` : `ThreadMetadataDb::MIGRATIONS` (schéma), `LIST_QUERY`, `impl Column for ThreadMetadata` (valeurs nulles, titres vides, `agent_id` NULL = agent natif) ; `crates/util/src/path_list.rs` : `PathList` (chemins triés, séparés par `\n`, ordre d'affichage dans `*_order`) | vérifié |
| Projets du sidebar et leur ordre : `kv_store` clé `session_id`, puis `workspaces` (`paths`, `paths_order`, `session_id`, `window_id`, `remote_connection_id`) et `scoped_kv_store` (`multi_workspace_state`, clé `window_id` : `project_groups`). Entrée périmée (`window_id` réutilisé) ignorée ; pas de `session_window_stack` sous Windows | `zra-daemon/threads-index.js` (`readZedProjects`) | `crates/session/src/session.rs` (`SESSION_ID_KEY`), `crates/workspace/src/persistence.rs` (`workspaces`, `read_multi_workspace_state`, `last_session_workspace_locations`), `crates/workspace/src/multi_workspace.rs` (`serialize_now`, `detach_workspace` efface `session_id`) | vérifié |
| Canal de Zed : base `db/0-<canal>/db.sqlite`, canal détecté par la base écrite en dernier, ou fixé par `zedChannel` | `zra-daemon/platform.js` (`detectZedChannel`), `zra-daemon/config.js` | `crates/db/src/db.rs` : `db_path` ; `crates/release_channel/src/lib.rs` : `dev_name` ; `crates/paths/src/paths.rs` : `database_dir` | vérifié |
| CLI de Zed par canal : `Programs\Zed Preview\bin\zed.exe`, `~/.local/zed-preview.app/bin/zed`… | `zra-daemon/platform.js` (`zedCliCandidates`) | `script/bundle-windows.ps1`, `crates/zed/resources/windows/zed.iss`, `script/install.sh` | vérifié |
| Ouverture d'un projet : `zed <dossiers>`, `--classic` pour une fenêtre neuve | `zra-daemon/zed/driver.js` (`ZedCli`) | `crates/cli/src/main.rs` : option cachée `classic`, `OpenBehavior` ; défaut réglé par `cli_default_open_behavior` | vérifié |
| Agents installés du registry : `external_agents/registry`, commande (`bin` au nom du paquet) et `env` (registry, puis réglages) | `zra-daemon/agent-commands.js` | `crates/paths/src/paths.rs` : `external_agents_dir` ; `crates/project/src/agent_server_store.rs` : `LocalRegistryNpxAgent::get_command`, `LocalRegistryArchiveAgent::get_command` ; `crates/node_runtime/src/node_runtime.rs` : `read_package_executable` | vérifié |
| Entrées `agent_servers` de `settings.json` : ZRA écrit `type: "custom"` (`command`, `args`, `env`, et de l'agent d'origine `default_mode`, `default_config_options`, `favorite_config_option_values`), lit aussi `type: "registry"` | `scripts/setup.mjs` (`buildEntry`), `zra-daemon/zed-settings.js` | `crates/settings_content/src/agent.rs` : `CustomAgentServerSettings` | vérifié |
| Chemins `settings.json`, `keymap.json` | `zra-daemon/platform.js` | `crates/paths/src/paths.rs` : `config_dir`, `settings_file`, `keymap_file` (Flatpak et `--user-data-dir` non gérés par ZRA) | vérifié |

### Clavier et fenêtre

| ZRA | Côté ZRA | Côté Zed | État |
|---|---|---|---|
| Touche « nouveau thread » par agent : `agent::NewExternalAgentThread`, argument `{ "custom": { "name": id } }` (forme ancienne, acceptée) ; touches `ctrl-alt-shift-f1`… libres par défaut | `zra-daemon/zed-keymap.js` | `crates/agent_ui/src/agent_ui.rs` : `NewExternalAgentThread`, `deserialize_external_agent_id` ; enregistrée sur le workspace (`crates/agent_ui/src/agent_panel.rs`) | vérifié |
| Recette `openThread` : `workspace: focus center pane` puis `multi workspace: focus workspace sidebar` | `zra-daemon/zed/driver.js` | `crates/workspace/src/workspace.rs` : `FocusCenterPane` (focus éditeur, évite la bascule) ; `crates/workspace/src/multi_workspace.rs` : `FocusWorkspaceSidebar`, `focus_sidebar` (bascule) ; libellé : `crates/command_palette/src/command_palette.rs` (`humanize_action_name`) | vérifié |
| Recette `newThread` (repli) : palette `agent: new thread` | `zra-daemon/zed/driver.js` | `crates/agent_ui/src/agent_ui.rs` : `NewThread` | vérifié |
| Touches par défaut citées par le pilote (`ctrl-shift-p`, `ctrl-n`, `ctrl-f`…) | `zra-daemon/zed/driver.js` | `assets/keymaps/default-windows.json`, `default-linux.json` | vérifié |
| Filtre du sidebar : taper puis `enter` ouvre le premier thread | `zra-daemon/zed/driver.js` | `crates/sidebar/src/sidebar.rs` : `rebuild_contents` (filtre flou), `select_first_entry`, `confirm` | limitation |
| Fenêtre reconnue à son titre (« projet — fichier ») | `zra-daemon/zed/keyboard.ps1`, `driver.js` (`projectWindow`) | `crates/workspace/src/workspace.rs` : `apply_window_title`, `project_window_title` ; format par défaut dans `assets/settings/default.json` (`window_title_format`) | vérifié (format personnalisé : `limitations.md`) |

### ACP

| ZRA | Côté ZRA | Côté Zed | État |
|---|---|---|---|
| Relais et observation d'ACP v1, capacités de Zed transmises telles quelles | `zra-shim/acp.js` | `crates/agent_servers/src/acp.rs` : `connect` ; `crates/agent_servers/src/acp/v1.rs` (`client_builder`, `client_capabilities_for_agent`). Crate `agent-client-protocol` 5.0.0 (`Cargo.toml`) | vérifié |
| ACP v2 | non géré | `crates/agent_servers/src/acp/v2.rs`, tenté d'abord quand le drapeau `AcpBetaFeatureFlag` est actif, repli sur v1 | vérifié |
| Sessions suivies : `session/new`, `session/load`, `session/resume` ; retirées à `session/close` | `zra-shim/acp.js` (`noteResponse`) | `crates/agent_ui/src/conversation_view.rs` (`load_session`, sinon `resume_session`) ; `crates/agent_servers/src/acp/v1.rs` (`release_session` : `session/close`) | vérifié |
| Permissions : le shim répond à la place de Zed, puis retire l'invite de Zed (`$/cancel_request`) | `zra-shim/acp.js` | `crates/agent_servers/src/acp/v1.rs` (`handle_request_permission`) ; `crates/acp_thread/src/acp_thread.rs` (`apply_reported_status`, `cancel_permission_request`) | vérifié |
| Questions de l'agent (élicitation en formulaire, `AskUserQuestion` de Claude Agent) : publiées en `zra/elicitation` dans le thread de leur session ou de la requête de Zed qu'elles citent, le shim répond à la place de Zed puis retire son formulaire (`$/cancel_request`) ; un lien à ouvrir (mode `url`) est montré, mais s'ouvre sur le poste | `zra-shim/acp.js` (`noteElicitation`, `respondElicitation`) | `crates/agent_servers/src/acp.rs` (`handle_v2_create_elicitation` : `cancel_elicitation` sur annulation) ; `crates/acp_thread/src/acp_thread.rs` (`request_elicitation_with_id`, `has_pending_turn_action`) | vérifié |
| Message du mobile affiché dans Zed (`user_message_chunk` synthétique) | `zra-shim/acp.js` | `crates/acp_thread/src/acp_thread.rs` : `handle_session_update`, `push_user_content_block_with_protocol_id` | vérifié |
| Tour lancé depuis le mobile, vu de Zed | `zra-shim/acp.js` | `crates/acp_thread/src/acp_thread.rs` : `uses_reported_activity`, `status` | limitation |
| Mode, modèle, options : projection et changement | `zra-shim/acp.js` (`projectOptions`, `applyOption`) | `crates/agent_servers/src/acp/v1.rs` : `config_state`, `ConfigOptions::set_config_option`, `AcpSessionModes` ; `crates/acp_thread/src/config_options.rs` | vérifié |
| Sortie des terminaux : réponses à `terminal/*`, ou `_meta` des tool calls | `zra-shim/acp.js` (`publishTerminal`), `zra-client/js/acp.js` (`terminalMeta`) | `crates/agent_servers/src/acp/v1.rs` : `handle_terminal_output` ; `_meta.terminal_info`, `terminal_output`, `terminal_exit` dans `handle_session_notification` | vérifié |
| Relecture d'un thread fermé : client ACP jetable, `session/load`, capacités de Zed (dont `_meta.terminal_output`), environnement du projet (shell de connexion et direnv sous Linux et macOS ; sous Windows, celui de la session, comme Zed). Sans serveurs MCP, par choix (`docs/fr/limitations.md`) | `zra-daemon/session-loader.js`, `acp-client.js`, `shell-env.js` | `crates/agent_servers/src/acp/v1.rs` : `load_session`, `session_directories_from_work_dirs`, `client_capabilities_for_agent` ; `crates/project/src/environment.rs` : `local_directory_environment`, `load_direnv_environment` ; `crates/util/src/shell_env.rs` : `capture` | vérifié |

### Interface : PWA ↔ panneau agent

Comportement seulement : l'apparence est auditée à part. Côté Zed, sauf mention : `crates/agent_ui/src/conversation_view/thread_view.rs`.

| PWA (`zra-client/js/`) | Côté Zed | État |
|---|---|---|
| Liste des threads, par projet (`views/threads.js` : `threadRow`, `projectHead` ; `format.js` : `relTime`, `projectOf`) | `crates/sidebar/src/sidebar.rs` : `rebuild_contents`, `thread_display_time`, `render_thread`, `render_project_header` ; `crates/project/src/project.rs` : `ProjectGroupKey::display_name` ; `crates/agent_ui/src/threads_archive_view.rs` : `format_history_entry_timestamp` | écart |
| Fil : réduction des `session/update` (`acp.js` : `Timeline.apply`) | `crates/acp_thread/src/acp_thread.rs` : `handle_session_update`, `upsert_tool_call`, `update_tool_call`, `can_merge_message_chunks` | vérifié |
| Message de l'utilisateur, de l'agent (`views/entry.js` : `userMsg`, `agentMsg`) | `render_entry`, `render_message_content` | à auditer |
| Réflexions (`thoughtMsg`) | `render_thinking_block` ; `crates/agent_ui/src/entry_view_state.rs` : `auto_expand_streaming_thought` | vérifié |
| Tool calls : deux dispositions (ligne simple / carte), en-tête, échec en croix, dépliement (`toolCall`) | `render_tool_call`, `render_tool_call_label`, `render_tool_call_content` ; réglages `expand_edit_card`, `expand_terminal_card` | vérifié (0.5) |
| Terminal (`terminalCard`) : cwd (agent `terminal_info.cwd`, sinon projet du thread), durée `(1m 11s)` au-delà de 10 s (live puis figée), échec en croix rouge, code en infobulle | `render_terminal_tool_call` ; `crates/agent_ui/src/ui/terminal_tool_header.rs` ; `util/time.rs` (`duration_alt_display`) | vérifié (0.5) |
| Diff (`diffBlock`, `diff.js`) : sans gouttière, lignes remplies à 12 % | `render_diff_editor` | vérifié (0.5) |
| Plan, au-dessus du composer (`views/entry.js` : `planPanel` ; `views/thread.js` : `syncActivity`) | `render_activity_bar`, `render_plan_entries`, `render_plan_summary` | vérifié |
| Permission dans la carte de son tool call (`permissionButtons`), rappelée au-dessus du composer quand la carte est hors de vue ; tool call créé par la demande (`acp.js` : `permission`) | `render_permission_buttons` et variantes, `render_main_agent_awaiting_permission` ; `crates/acp_thread/src/acp_thread.rs` : `request_tool_call_authorization` (`upsert_tool_call`) | vérifié |
| Question de l'agent : carte du fil, champs selon le schéma, Envoyer / Refuser / Annuler, retirée une fois répondue (`views/entry.js` : `elicitationCard`) ; défauts et validation — requis, longueurs, motif, formats `email`/`uri`/`date`/`date-time`, bornes, nombre de choix (`elicitation.js`) | `conversation_view/elicitation.rs` : `ElicitationCard`, `render_field`, `render_actions`, `should_render_elicitation`, `validate`, `validate_*_value`, `multi_select_default_value` | vérifié |
| Tour en cours : spinner braille Dots / Sand, durée (`views/thread.js` : `syncTurn`) | `render_generating` ; `ui/components/label/spinner_label.rs` | vérifié (0.5) |
| Composer (`views/thread.js` : `Composer`, `editor.js`) : contenteditable à façade textarea (conception D2 — brouillon texte, Entrée/Maj+Entrée/Ctrl+Entrée, collage texte brut, autogrow CSS ; puces de mention : 5b-2), saisie buffer 12, barre gauche « + » / droite jauge + sélecteurs + stop + envoi | `crates/agent_ui/src/message_editor.rs`, `render_send_button` | vérifié (0.5.2) ; IME Android réel : `ISSUES.md` |
| Complétion slash (`completion.js`, `Composer`) : menu `/` ancré au caret, au-dessus (le composer est en bas), filtre fuzzy approché (gras), en-tête « Commands » masqué quand un argument est saisi, description de l'item sélectionné en aparté (droite si ≥ 260 px, sinon au-dessus), confirmer envoie sauf argument attendu non saisi ; menu fermé dès qu'un blanc suit la commande ; validation `/commande` inconnue → callout « An Error Happened » au-dessus du composer ; placeholder « / for commands » si l'agent publie des commandes | `completion_provider.rs` (`SlashCommandCompletion::try_parse`, `search_slash_commands`), `message_editor.rs` (`validate_slash_commands`, `confirm_command`, `placeholder_text`), `crates/editor/src/code_context_menus.rs` (`render`, `render_aside`), `crates/editor/src/element.rs` (`layout_context_menu_aside`) ; galerie section 14 | vérifié (0.5.2) ; écart `try_parse` espace final : `ISSUES.md` |
| Hint d'argument de commande (`input.hint`) : inlay muted après `/name ` tant qu'il n'y a pas d'argument (position = fin du dernier non-blanc + 1, clampée au texte ; espace préfixée si absente) | `message_editor.rs` (`command_hint`, `InlayHintKind::Parameter`, couleur `syntax.hint`, sans fond) | vérifié (0.5.2) ; PWA : span fantôme `.composer__hint` (contenteditable=false), exclu du texte, caret conservé devant |
| Mode, modèle, options (`views/thread.js`) : sélecteurs dans la barre du composer ; réduction icon-only mobile = implémentation ZRA | `crates/agent_ui/src/mode_selector.rs`, `model_selector.rs`, `config_options.rs` | vérifié (0.5) |
| File d'attente, Stop (`views/thread.js` : `stopTurn`) | `conversation_view/message_queue.rs` (`MessageQueue`), `cancel_generation`, `render_message_queue_entries` | vérifié |
| Thèmes (`css/themes.css`, généré par `scripts/gen-themes.mjs`) | `assets/themes/` (MIT) ; jetons : `crates/theme/` | vérifié |
| Icônes (`icons.js`), icônes d'agents (`agent-icons.js`, `scripts/gen-agent-icons.mjs` ; registre ACP via le cache de Zed, `zra-daemon/agent-icons.js`) | `assets/icons/` (Lucide, ISC ; icônes de marques à part) ; `crates/project/src/agent_registry_store.rs` (registre ACP) | à auditer |
| Espacements, tailles de texte, rayons (`css/app.css`) | `crates/ui/src/styles/` (`spacing.rs`, `typography.rs`, `elevation.rs`) ; composants : `crates/ui/src/components/` | à auditer |

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
