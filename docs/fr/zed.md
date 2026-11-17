# ZRA — correspondance avec Zed

Ce dont ZRA dépend dans Zed, et où le vérifier dans ses sources. Sert à l'audit de conformité au panneau agent et à suivre les évolutions de Zed.

## Référence

- **Version de référence : Zed 1.28.1** (stable, commit `e8bc16a`). Les chemins de cette page sont relatifs au dépôt de Zed et valent pour cette version.
- Sources en lecture seule dans `_upstream/zed` (ignoré par git, jamais embarqué). Mise en place :

  ```sh
  git clone --depth 1 --branch v1.28.1 https://github.com/zed-industries/zed.git _upstream/zed
  ```

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

**État** des lignes : **vérifié** (lu dans les sources de la version de référence), **relevé** (constaté sur un poste, pas encore relu dans les sources), **à vérifier** (source repérée, pas encore relue), **écart** (vérifié, différent de Zed : voir `ISSUES.md`), **à auditer** (la PWA imite Zed, l'écart reste à mesurer).

### Données et fichiers de Zed

| ZRA | Côté ZRA | Côté Zed | État |
|---|---|---|---|
| Index des threads : colonnes requises `thread_id`, `session_id`, `agent_id`, `title`, `updated_at` ; facultatives `created_at`, `folder_paths`, `folder_paths_order`, `archived`, `interacted_at`, `title_override` | `zra-daemon/threads-index.js` | `crates/agent_ui/src/thread_metadata_store.rs` : `ThreadMetadataDb::MIGRATIONS` (schéma), `LIST_QUERY` | vérifié |
| Projets ouverts : `kv_store` clé `session_id`, puis `workspaces` (`paths`, `paths_order`, `session_id`, `remote_connection_id`) | `zra-daemon/threads-index.js` | `crates/session/src/session.rs` (`SESSION_ID_KEY`), `crates/workspace/src/persistence.rs` (migrations de `workspaces`) | vérifié |
| Canal de Zed : base `db/0-<canal>/db.sqlite`, canal détecté par la base écrite en dernier, ou fixé par `zedChannel` | `zra-daemon/platform.js` (`detectZedChannel`), `zra-daemon/config.js` | `crates/db/src/db.rs` : `db_path` ; `crates/release_channel/src/lib.rs` : `dev_name` ; `crates/paths/src/paths.rs` : `database_dir` | vérifié |
| CLI de Zed par canal : `Programs\Zed Preview\bin\zed.exe`, `~/.local/zed-preview.app/bin/zed`… | `zra-daemon/platform.js` (`zedCliCandidates`) | `script/bundle-windows.ps1`, `script/install.sh` | vérifié |
| Agents installés du registry : `external_agents/registry` | `zra-daemon/agent-commands.js` | `crates/paths/src/paths.rs` : `external_agents_dir` ; `crates/project/src/agent_server_store.rs` (`.join("registry")`) | vérifié |
| Entrées `agent_servers` de `settings.json` : ZRA écrit `type: "custom"` (`command`, `args`, `env`, `default_config_options`), lit aussi `type: "registry"` | `scripts/setup.mjs` (`buildEntry`), `zra-daemon/zed-settings.js` | `crates/settings_content/src/agent.rs` : `CustomAgentServerSettings` | vérifié |
| Chemins `settings.json`, `keymap.json` | `zra-daemon/platform.js` | `crates/paths/src/paths.rs` : `settings_file`, `keymap_file` | vérifié |

### Clavier et fenêtre

| ZRA | Côté ZRA | Côté Zed | État |
|---|---|---|---|
| Touche « nouveau thread » par agent : `agent::NewExternalAgentThread`, argument `{ "custom": { "name": id } }` (forme ancienne, acceptée) | `zra-daemon/zed-keymap.js` | `crates/agent_ui/src/agent_ui.rs` : `NewExternalAgentThread`, `deserialize_external_agent_id` | vérifié |
| Recette `openThread` : palette `multi workspace: focus workspace sidebar` | `zra-daemon/zed/driver.js` | `crates/workspace/src/multi_workspace.rs` : action `FocusWorkspaceSidebar` ; libellé : `crates/command_palette/src/command_palette.rs` (`humanize_action_name`) | vérifié |
| Recette `newThread` (repli) : palette `agent: new thread` | `zra-daemon/zed/driver.js` | `crates/agent_ui/src/agent_ui.rs` : `NewThread` | vérifié |
| Touches par défaut citées par le pilote (`ctrl-shift-p`, `ctrl-n`, `ctrl-f`…) | `zra-daemon/zed/driver.js` | `assets/keymaps/default-windows.json`, `default-linux.json` | vérifié |
| Filtre du sidebar : taper puis `enter` ouvre le premier résultat | `zra-daemon/zed/driver.js` | `crates/sidebar/src/sidebar.rs` : `select_first_entry`, `confirm` ; filtre flou | écart |
| Fenêtre reconnue à son titre (« projet — fichier ») | `zra-daemon/zed/keyboard.ps1` | `crates/workspace/src/workspace.rs` : `apply_window_title` ; format par défaut dans `assets/settings/default.json` (`window_title_format`) | écart si personnalisé |

### ACP

| ZRA | Côté ZRA | Côté Zed | État |
|---|---|---|---|
| Relais et observation d'ACP v1 | `zra-shim/acp.js` | `crates/agent_servers/src/acp.rs` : `connect` ; `crates/agent_servers/src/acp/v1.rs`. Crate `agent-client-protocol` 5.0.0 (`Cargo.toml`) | vérifié |
| ACP v2 | non géré | `crates/agent_servers/src/acp/v2.rs`, tenté d'abord quand le drapeau `AcpBetaFeatureFlag` est actif, repli sur v1 | vérifié |
| Permissions : le shim répond à la place de Zed | `zra-shim/acp.js` | `crates/agent_servers/src/acp/v1.rs` (`handle_request_permission`) ; `crates/acp_thread/src/acp_thread.rs` (`apply_reported_status`) | écart |
| Message du mobile affiché dans Zed (`user_message_chunk` synthétique) | `zra-shim/acp.js` | `crates/acp_thread/src/acp_thread.rs` : `handle_session_update`, `push_user_content_block_from_agent` | vérifié |
| Tour lancé depuis le mobile, vu de Zed | `zra-shim/acp.js` | `crates/acp_thread/src/acp_thread.rs` : `uses_reported_activity`, `status` | écart |

### Interface : PWA ↔ panneau agent

Côté Zed, sauf mention : `crates/agent_ui/src/conversation_view/thread_view.rs`.

| PWA (`zra-client/js/`) | Côté Zed | État |
|---|---|---|
| Liste des threads, par projet (`views/threads.js` : `threadRow`, `projectHead`) | `crates/sidebar/src/sidebar.rs` : `render_thread`, `render_project_header` | à auditer |
| Message de l'utilisateur, de l'agent (`views/entry.js` : `userMsg`, `agentMsg`) | `render_entry`, `render_message_content` | à auditer |
| Réflexions (`thoughtMsg`) | `render_thinking_block` | à auditer |
| Tool calls : en-tête, statut, dépliement (`toolCall`, `statusIcon`) | `render_tool_call`, `render_tool_call_label`, `render_tool_call_content` | à auditer |
| Terminal (`terminalBlock`) | `render_terminal_tool_call` ; `crates/agent_ui/src/ui/terminal_tool_header.rs` | à auditer |
| Diff (`diffBlock`, `diff.js`) | `render_diff_editor` | à auditer |
| Plan (`planCard`) | `render_plan_entries`, `render_plan_summary` | à auditer |
| Permission (`permissionCard`) | `render_permission_buttons` et variantes | à auditer |
| Tour en cours | `render_generating` | à auditer |
| Composer (`views/thread.js` : `Composer`) | `crates/agent_ui/src/message_editor.rs`, `render_send_button` | à auditer |
| Mode, modèle, options (`views/thread.js`) | `crates/agent_ui/src/mode_selector.rs`, `model_selector.rs`, `config_options.rs` | à auditer |
| File d'attente | `conversation_view/message_queue.rs`, `render_message_queue_entries` | à auditer |
| Thèmes (`css/themes.css`, généré par `scripts/gen-themes.mjs`) | `assets/themes/` (MIT) ; jetons : `crates/theme/` | vérifié |
| Icônes (`icons.js`), icônes d'agents (`agent-icons.js`, `scripts/gen-agent-icons.mjs`) | `assets/icons/` (Lucide, ISC ; icônes de marques à part) | à auditer |
| Espacements, tailles de texte, rayons (`css/app.css`) | `crates/ui/src/styles/` (`spacing.rs`, `typography.rs`, `elevation.rs`) ; composants : `crates/ui/src/components/` | à auditer |

Les styles GPUI s'écrivent comme des classes utilitaires (`.px_2()`, `.gap_1()`, `.rounded_md()`, `.text_color(colors.text_muted)`) : chacun se traduit en une déclaration CSS. Les valeurs de base de `crates/ui/src/styles/` deviennent des variables CSS dans `app.css`, comme les couleurs dans `themes.css`.

## Points de vigilance

- **Plusieurs canaux installés** : ZRA suit celui dont la base a été écrite en dernier, déterminé au démarrage du daemon. Pour en suivre un autre : `zedChannel` dans `zra.config.json`.
- **ACP v2** : derrière un drapeau bêta dans Zed 1.28.1. S'il devient le défaut, le shim voit passer des trames v2 qu'il n'observe pas.
- **Palette** : ses libellés dérivent des noms d'actions (`humanize_action_name`). Une action renommée casse la recette correspondante.

## Mettre à jour la référence

1. Récupérer la nouvelle version et lister ce qui a changé sur les chemins de cette page :

   ```sh
   git -C _upstream/zed fetch --depth 1 origin tag vX.Y.Z
   git -C _upstream/zed diff v1.28.1 vX.Y.Z --stat -- crates/agent_ui crates/sidebar crates/workspace/src/persistence.rs crates/workspace/src/multi_workspace.rs crates/session crates/db crates/paths crates/agent_servers crates/acp_thread crates/project/src/agent_server_store.rs crates/command_palette crates/settings_content/src/agent.rs crates/ui crates/theme assets/keymaps assets/themes assets/icons
   git -C _upstream/zed checkout vX.Y.Z
   ```

   Le diff demande l'ancien tag localement : sinon, `git fetch --depth 1 origin tag v1.28.1` d'abord.

2. Relire les fichiers touchés, mettre à jour les tableaux et la version de référence.
3. Thèmes ou icônes modifiés : relancer `scripts/gen-themes.mjs` ou `scripts/gen-agent-icons.mjs`.
4. Vérifier un poste (`docs/fr/architecture.md`, « Vérifier une machine »).
