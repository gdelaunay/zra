# ZRA — mapping to Zed

What ZRA depends on in Zed, and where to check it in its sources. Used for the conformance audit against the agent panel and to follow Zed's changes.

## Reference

- **Reference version: Zed 1.28.1** (stable, commit `e8bc16a`). The paths on this page are relative to the Zed repository and hold for this version.
- Read-only sources in `_upstream/zed` (ignored by git, never shipped). Setup:

  ```sh
  git clone --depth 1 --branch v1.28.1 https://github.com/zed-industries/zed.git _upstream/zed
  ```

- Version installed on the machine: `(Get-Item "$env:LOCALAPPDATA\Programs\Zed\Zed.exe").VersionInfo.ProductVersion` on Windows, `zed --version` on Linux.

## Basic facts

- **Thread index**: `sidebar_threads` table in `db/0-<channel>/db.sqlite` (`0-stable` for stable Zed), opened read-only (WAL file, Zed writes in parallel). For an ACP agent, Zed only keeps metadata there: the content belongs to the agent, hence `session/load` as the only way to the history. `threads/threads.db` is the old native agent, ignored.
- **Agents**: Zed launches the agent as a subprocess and talks JSON-RPC to it over stdio. Registry agents (`"type": "registry"`) have no command in `settings.json`: Zed installs them under `external_agents/registry`, where `agent-commands.js` finds them without downloading anything.
- **Window**: Zed draws its own interface (GPUI), its UI Automation tree is empty. Hence keyboard control.

| | Windows | Linux |
|---|---|---|
| Thread index | `%LOCALAPPDATA%\Zed\db\0-<channel>\db.sqlite` | `~/.local/share/zed/db/0-<channel>/db.sqlite` |
| `settings.json`, `keymap.json` | `%APPDATA%\Zed\` | `~/.config/zed/` |
| Installed agents | `%LOCALAPPDATA%\Zed\external_agents\registry` | `~/.local/share/zed/external_agents/registry` |
| Process | `zed.exe` | `zed-editor` |

## Mapping

**Status** of the rows: **verified** (read in the sources of the reference version), **observed** (seen on a machine, not yet reread in the sources), **to check** (source located, not yet reread), **to audit** (the PWA imitates Zed, the gap remains to be measured).

### Zed data and files

| ZRA | ZRA side | Zed side | Status |
|---|---|---|---|
| Thread index: required columns `thread_id`, `session_id`, `agent_id`, `title`, `updated_at`; optional `created_at`, `folder_paths`, `folder_paths_order`, `archived`, `interacted_at`, `title_override` | `zra-daemon/threads-index.js` | `crates/agent_ui/src/thread_metadata_store.rs`: `ThreadMetadataDb::MIGRATIONS` (schema), `LIST_QUERY` | verified |
| Open projects: `kv_store` key `session_id`, then `workspaces` (`paths`, `paths_order`, `session_id`, `remote_connection_id`) | `zra-daemon/threads-index.js` | `crates/session/src/session.rs` (`SESSION_ID_KEY`), `crates/workspace/src/persistence.rs` (`workspaces` migrations) | verified |
| Zed channel: database `db/0-<channel>/db.sqlite`, channel detected from the database written last, or set by `zedChannel` | `zra-daemon/platform.js` (`detectZedChannel`), `zra-daemon/config.js` | `crates/db/src/db.rs`: `db_path`; `crates/release_channel/src/lib.rs`: `dev_name`; `crates/paths/src/paths.rs`: `database_dir` | verified |
| Zed CLI per channel: `Programs\Zed Preview\bin\zed.exe`, `~/.local/zed-preview.app/bin/zed`… | `zra-daemon/platform.js` (`zedCliCandidates`) | `script/bundle-windows.ps1`, `script/install.sh` | verified |
| Installed registry agents: `external_agents/registry` | `zra-daemon/agent-commands.js` | `crates/paths/src/paths.rs`: `external_agents_dir`; `crates/project/src/agent_server_store.rs` (`.join("registry")`) | verified |
| `agent_servers` entries in `settings.json`: ZRA writes `type: "custom"` (`command`, `args`, `env`, `default_config_options`), also reads `type: "registry"` | `scripts/setup.mjs` (`buildEntry`), `zra-daemon/zed-settings.js` | `crates/settings_content/src/agent.rs`: `CustomAgentServerSettings` | verified |
| `settings.json`, `keymap.json` paths | `zra-daemon/platform.js` | `crates/paths/src/paths.rs` | observed |

### Keyboard and window

| ZRA | ZRA side | Zed side | Status |
|---|---|---|---|
| "New thread" key per agent: `agent::NewExternalAgentThread`, argument `{ "custom": { "name": id } }` (legacy form, accepted) | `zra-daemon/zed-keymap.js` | `crates/agent_ui/src/agent_ui.rs`: `NewExternalAgentThread`, `deserialize_external_agent_id` | verified |
| `openThread` recipe: palette `multi workspace: focus workspace sidebar` | `zra-daemon/zed/driver.js` | `crates/workspace/src/multi_workspace.rs`: action `FocusWorkspaceSidebar`; label: `crates/command_palette/src/command_palette.rs` (`humanize_action_name`) | verified |
| `newThread` recipe (fallback): palette `agent: new thread` | `zra-daemon/zed/driver.js` | `crates/agent_ui/src/agent_ui.rs`: `NewThread` | verified |
| Default keys cited by the driver (`ctrl-shift-p`, `ctrl-n`, `ctrl-f`…) | `zra-daemon/zed/driver.js` | `assets/keymaps/default-windows.json`, `default-linux.json` | verified |
| Sidebar filter: typing then `enter` opens the first result | `zra-daemon/zed/driver.js` | `crates/sidebar/src/sidebar.rs` | observed |
| Window recognized by its title ("project — file") | `zra-daemon/zed/keyboard.ps1` | `crates/workspace/src/workspace.rs` (window title) | observed |

### ACP

| ZRA | ZRA side | Zed side | Status |
|---|---|---|---|
| Relaying and observing ACP v1 | `zra-shim/acp.js` | `crates/agent_servers/src/acp.rs`: `connect`; `crates/agent_servers/src/acp/v1.rs`. Crate `agent-client-protocol` 5.0.0 (`Cargo.toml`) | verified |
| ACP v2 | not handled | `crates/agent_servers/src/acp/v2.rs`, tried first when the `AcpBetaFeatureFlag` flag is on, falls back to v1 | verified |
| Permissions: the shim answers instead of Zed | `zra-shim/acp.js` | `crates/agent_servers/src/acp/v1.rs` (`request_permission`); `crates/acp_thread/` | to check |
| Mobile message shown in Zed (synthetic `user_message_chunk`) | `zra-shim/acp.js` | `crates/acp_thread/src/acp_thread.rs` (handling of `session/update`) | to check |

### Interface: PWA ↔ agent panel

Zed side, unless stated: `crates/agent_ui/src/conversation_view/thread_view.rs`.

| PWA (`zra-client/js/`) | Zed side | Status |
|---|---|---|
| Thread list, by project (`views/threads.js`: `threadRow`, `projectHead`) | `crates/sidebar/src/sidebar.rs`: `render_thread`, `render_project_header` | to audit |
| User and agent messages (`views/entry.js`: `userMsg`, `agentMsg`) | `render_entry`, `render_message_content` | to audit |
| Thoughts (`thoughtMsg`) | `render_thinking_block` | to audit |
| Tool calls: header, status, expanding (`toolCall`, `statusIcon`) | `render_tool_call`, `render_tool_call_label`, `render_tool_call_content` | to audit |
| Terminal (`terminalBlock`) | `render_terminal_tool_call`; `crates/agent_ui/src/ui/terminal_tool_header.rs` | to audit |
| Diff (`diffBlock`, `diff.js`) | `render_diff_editor` | to audit |
| Plan (`planCard`) | `render_plan_entries`, `render_plan_summary` | to audit |
| Permission (`permissionCard`) | `render_permission_buttons` and variants | to audit |
| Turn in progress | `render_generating` | to audit |
| Composer (`views/thread.js`: `Composer`) | `crates/agent_ui/src/message_editor.rs`, `render_send_button` | to audit |
| Mode, model, options (`views/thread.js`) | `crates/agent_ui/src/mode_selector.rs`, `model_selector.rs`, `config_options.rs` | to audit |
| Queue | `conversation_view/message_queue.rs`, `render_message_queue_entries` | to audit |
| Themes (`css/themes.css`, generated by `scripts/gen-themes.mjs`) | `assets/themes/` (MIT); tokens: `crates/theme/` | verified |
| Icons (`icons.js`), agent icons (`agent-icons.js`, `scripts/gen-agent-icons.mjs`) | `assets/icons/` (Lucide, ISC; brand icons separate) | to audit |
| Spacing, text sizes, radii (`css/app.css`) | `crates/ui/src/styles/` (`spacing.rs`, `typography.rs`, `elevation.rs`); components: `crates/ui/src/components/` | to audit |

GPUI styles are written like utility classes (`.px_2()`, `.gap_1()`, `.rounded_md()`, `.text_color(colors.text_muted)`): each one translates into a CSS declaration. The base values in `crates/ui/src/styles/` become CSS variables in `app.css`, like the colors in `themes.css`.

## Points to watch

- **Several channels installed**: ZRA follows the one whose database was written last, determined when the daemon starts. To follow another one: `zedChannel` in `zra.config.json`.
- **ACP v2**: behind a beta flag in Zed 1.28.1. If it becomes the default, the shim sees v2 frames it does not observe.
- **Palette**: its labels derive from action names (`humanize_action_name`). A renamed action breaks the matching recipe.

## Updating the reference

1. Fetch the new version and list what changed on the paths of this page:

   ```sh
   git -C _upstream/zed fetch --depth 1 origin tag vX.Y.Z
   git -C _upstream/zed diff v1.28.1 vX.Y.Z --stat -- crates/agent_ui crates/sidebar crates/workspace/src/persistence.rs crates/workspace/src/multi_workspace.rs crates/session crates/db crates/paths crates/agent_servers crates/acp_thread crates/project/src/agent_server_store.rs crates/command_palette crates/settings_content/src/agent.rs crates/ui crates/theme assets/keymaps assets/themes assets/icons
   git -C _upstream/zed checkout vX.Y.Z
   ```

   The diff needs the old tag locally: otherwise, `git fetch --depth 1 origin tag v1.28.1` first.

2. Reread the changed files, update the tables and the reference version.
3. Themes or icons changed: rerun `scripts/gen-themes.mjs` or `scripts/gen-agent-icons.mjs`.
4. Check a machine (`docs/en/architecture.md`, "Checking a machine").
