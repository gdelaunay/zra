# ZRA — mapping to Zed

What ZRA depends on in Zed, and where to check it in its sources. Used for the conformance audit against the agent panel and to follow Zed's changes.

## Reference

- **Reference version: Zed 1.28.1** (stable, commit `e8bc16a`). The paths on this page are relative to the Zed repository and hold for this version.
- Read-only sources in `_upstream/zed` (ignored by git, never shipped). Setup:

  ```sh
  git clone --depth 1 --branch v1.28.1 https://github.com/zed-industries/zed.git _upstream/zed
  ```

- **ACP specification**: ZRA speaks **ACP v1**. Zed 1.28.1 depends on the crate `agent-client-protocol-schema` 1.15.1, cut at tag `v1.15.1` of the specification repository — the same commit as JSON Schema `schema-v1.29.1` and as the draft `schema-v2.0.0-alpha.13`. Read-only documentation and schemas in `_upstream/acp` (ignored by git, 8 MB). Setup (Git Bash; under PowerShell, `curl.exe`):

  ```sh
  mkdir -p _upstream/acp && curl -sL https://github.com/agentclientprotocol/agent-client-protocol/archive/refs/tags/v1.15.1.tar.gz | tar -xz --strip-components=1 -C _upstream/acp --exclude='*/assets/*'
  ```

  ZRA uses no ACP SDK: the JSON-RPC is hand-rolled (`zra-shim/framing.js`), so these pages are the reference, not a dependency.
- Pages that matter for ZRA, under `_upstream/acp`: `schema/v1/meta.json` (the method table), `schema/v1/schema.json` (the exact shapes), `docs/protocol/v1/` — `session-setup`, `prompt-turn`, `tool-calls`, `elicitation`, `terminals`, `cancellation`, `slash-commands`, `session-modes`, `session-config-options` — and `docs/protocol/v2/` + `schema/v2/` for the v2 draft.
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

**Status** of the rows: **verified** (read in the sources of the reference version), **observed** (seen on a machine, not yet reread in the sources), **to check** (source located, not yet reread), **gap** (checked, differs from Zed: noted on the row), **to audit** (the PWA imitates Zed, the gap remains to be measured), **limitation** (accepted gap, documented: see `docs/en/limitations.md`).

### Zed data and files

| ZRA | ZRA side | Zed side | Status |
|---|---|---|---|
| Thread index: required columns `thread_id`, `session_id`, `agent_id`, `title`, `updated_at`; optional `created_at`, `folder_paths`, `folder_paths_order`, `archived`, `interacted_at`, `title_override`, `remote_connection`, `main_worktree_paths(_order)` | `zra-daemon/threads-index.js` | `crates/agent_ui/src/thread_metadata_store.rs`: `ThreadMetadataDb::MIGRATIONS` (schema), `LIST_QUERY`, `impl Column for ThreadMetadata` (null values, empty titles, NULL `agent_id` = native agent); `crates/util/src/path_list.rs`: `PathList` (sorted paths, separated by `\n`, display order in `*_order`) | verified |
| Sidebar projects and their order: `kv_store` key `session_id`, then `workspaces` (`paths`, `paths_order`, `session_id`, `window_id`, `remote_connection_id`) and `scoped_kv_store` (`multi_workspace_state`, key `window_id`: `project_groups`). Stale entry (reused `window_id`) ignored; no `session_window_stack` on Windows | `zra-daemon/threads-index.js` (`readZedProjects`) | `crates/session/src/session.rs` (`SESSION_ID_KEY`), `crates/workspace/src/persistence.rs` (`workspaces`, `read_multi_workspace_state`, `last_session_workspace_locations`), `crates/workspace/src/multi_workspace.rs` (`serialize_now`, `detach_workspace` clears `session_id`) | verified |
| Zed channel: database `db/0-<channel>/db.sqlite`, channel detected from the database written last, or set by `zedChannel` | `zra-daemon/platform.js` (`detectZedChannel`), `zra-daemon/config.js` | `crates/db/src/db.rs`: `db_path`; `crates/release_channel/src/lib.rs`: `dev_name`; `crates/paths/src/paths.rs`: `database_dir` | verified |
| Zed CLI per channel: `Programs\Zed Preview\bin\zed.exe`, `~/.local/zed-preview.app/bin/zed`… | `zra-daemon/platform.js` (`zedCliCandidates`) | `script/bundle-windows.ps1`, `crates/zed/resources/windows/zed.iss`, `script/install.sh` | verified |
| Opening a project: always `zed --classic <folders>` — the window that has these folders is brought to the front, otherwise a dedicated window opens. Without the option, the default follows `cli_default_open_behavior`: `new_window` excludes open worktree roots from the match (`MatchSubpaths`) → a new window on every call for an already-open project; `--classic` does `MatchExact` (roots included). Option rejected by another version: retried without it | `zra-daemon/zed/driver.js` (`ZedCli`) | `crates/cli/src/main.rs`: hidden `classic` option, `OpenBehavior`; `crates/zed/src/zed/open_listener.rs`: `handle_cli_connection`, `open_options_for_behavior`; `crates/workspace/src/workspace.rs`: `find_existing_workspace`, `WorkspaceMatching` | verified |
| Installed registry agents: `external_agents/registry`, command (`bin` named after the package) and `env` (registry, then settings) | `zra-daemon/agent-commands.js` | `crates/paths/src/paths.rs`: `external_agents_dir`; `crates/project/src/agent_server_store.rs`: `LocalRegistryNpxAgent::get_command`, `LocalRegistryArchiveAgent::get_command`; `crates/node_runtime/src/node_runtime.rs`: `read_package_executable` | verified |
| `agent_servers` entries in `settings.json`: ZRA writes `type: "custom"` (`command`, `args`, `env`, and from the original agent `default_mode`, `default_config_options`, `favorite_config_option_values`), also reads `type: "registry"` | `scripts/setup.mjs` (`buildEntry`), `zra-daemon/zed-settings.js` | `crates/settings_content/src/agent.rs`: `CustomAgentServerSettings` | verified |
| `settings.json`, `keymap.json` paths | `zra-daemon/platform.js` | `crates/paths/src/paths.rs`: `config_dir`, `settings_file`, `keymap_file` (Flatpak and `--user-data-dir` not handled by ZRA) | verified |

### Keyboard and window

| ZRA | ZRA side | Zed side | Status |
|---|---|---|---|
| "New thread" key per agent: `agent::NewExternalAgentThread`, argument `{ "custom": { "name": id } }` (legacy form, accepted); keys `ctrl-alt-shift-f1`… unbound by default | `zra-daemon/zed-keymap.js` | `crates/agent_ui/src/agent_ui.rs`: `NewExternalAgentThread`, `deserialize_external_agent_id`; registered on the workspace (`crates/agent_ui/src/agent_panel.rs`) | verified |
| `openThread` recipe: `workspace: focus center pane` then `multi workspace: focus workspace sidebar` | `zra-daemon/zed/driver.js` | `crates/workspace/src/workspace.rs`: `FocusCenterPane` (editor focus, avoids the toggle); `crates/workspace/src/multi_workspace.rs`: `FocusWorkspaceSidebar`, `focus_sidebar` (toggles); label: `crates/command_palette/src/command_palette.rs` (`humanize_action_name`) | verified |
| `newThread` recipe (fallback): palette `agent: new thread` | `zra-daemon/zed/driver.js` | `crates/agent_ui/src/agent_ui.rs`: `NewThread` | verified |
| Default keys cited by the driver (`ctrl-shift-p`, `ctrl-n`, `ctrl-f`…) | `zra-daemon/zed/driver.js` | `assets/keymaps/default-windows.json`, `default-linux.json` | verified |
| Sidebar filter: typing then `enter` opens the first thread | `zra-daemon/zed/driver.js` | `crates/sidebar/src/sidebar.rs`: `rebuild_contents` (fuzzy filter), `select_first_entry`, `confirm` | limitation |
| Window recognized by its title ("project — file") | `zra-daemon/zed/keyboard.ps1`, `driver.js` (`projectWindow`) | `crates/workspace/src/workspace.rs`: `apply_window_title`, `project_window_title`; default format in `assets/settings/default.json` (`window_title_format`) | verified (custom format: `limitations.md`) |

### ACP

| ZRA | ZRA side | Zed side | Status |
|---|---|---|---|
| Relaying and observing ACP v1, Zed's capabilities passed through unchanged | `zra-shim/acp.js` | `crates/agent_servers/src/acp.rs`: `connect`; `crates/agent_servers/src/acp/v1.rs` (`client_builder`, `client_capabilities_for_agent`). Crate `agent-client-protocol` 5.0.0 (`Cargo.toml`) | verified |
| ACP v2 | not handled | `crates/agent_servers/src/acp/v2.rs`, tried first when the `AcpBetaFeatureFlag` flag is on, falls back to v1 | verified |
| Tracked sessions: `session/new`, `session/load`, `session/resume`; removed on `session/close` | `zra-shim/acp.js` (`noteResponse`) | `crates/agent_ui/src/conversation_view.rs` (`load_session`, else `resume_session`); `crates/agent_servers/src/acp/v1.rs` (`release_session`: `session/close`) | verified |
| Permissions: the shim answers instead of Zed, then removes Zed's prompt (`$/cancel_request`) | `zra-shim/acp.js` | `crates/agent_servers/src/acp/v1.rs` (`handle_request_permission`); `crates/acp_thread/src/acp_thread.rs` (`apply_reported_status`, `cancel_permission_request`) | verified |
| Agent questions (form elicitation, Claude Agent's `AskUserQuestion`): published as `zra/elicitation` in the thread of their session or of the Zed request they cite, the shim answers instead of Zed then removes its form (`$/cancel_request`); a link to open (`url` mode) is shown, but opens on the machine | `zra-shim/acp.js` (`noteElicitation`, `respondElicitation`) | `crates/agent_servers/src/acp.rs` (`handle_v2_create_elicitation`: `cancel_elicitation` on cancellation); `crates/acp_thread/src/acp_thread.rs` (`request_elicitation_with_id`, `has_pending_turn_action`) | verified |
| Mobile message shown in Zed (synthetic `user_message_chunk`) | `zra-shim/acp.js` | `crates/acp_thread/src/acp_thread.rs`: `handle_session_update`, `push_user_content_block_with_protocol_id` | verified |
| Turn started from the mobile, as seen by Zed | `zra-shim/acp.js` | `crates/acp_thread/src/acp_thread.rs`: `uses_reported_activity`, `status` | limitation |
| Mode, model, options: projection and changes | `zra-shim/acp.js` (`projectOptions`, `applyOption`) | `crates/agent_servers/src/acp/v1.rs`: `config_state`, `ConfigOptions::set_config_option`, `AcpSessionModes`; `crates/acp_thread/src/config_options.rs` | verified |
| Terminal output: replies to `terminal/*`, or tool calls' `_meta` | `zra-shim/acp.js` (`publishTerminal`), `zra-client/js/acp.js` (`terminalMeta`) | `crates/agent_servers/src/acp/v1.rs`: `handle_terminal_output`; `_meta.terminal_info`, `terminal_output`, `terminal_exit` in `handle_session_notification` | verified |
| Replaying a closed thread: throwaway ACP client, `session/load`, Zed's capabilities (including `_meta.terminal_output`), project environment (login shell and direnv on Linux and macOS; on Windows, the session's, as Zed does). No MCP servers, by choice (`docs/en/limitations.md`) | `zra-daemon/session-loader.js`, `acp-client.js`, `shell-env.js` | `crates/agent_servers/src/acp/v1.rs`: `load_session`, `session_directories_from_work_dirs`, `client_capabilities_for_agent`; `crates/project/src/environment.rs`: `local_directory_environment`, `load_direnv_environment`; `crates/util/src/shell_env.rs`: `capture` | verified |

### Interface: PWA ↔ agent panel

Behavior only: the appearance is audited separately. Zed side, unless stated: `crates/agent_ui/src/conversation_view/thread_view.rs`.

| PWA (`zra-client/js/`) | Zed side | Status |
|---|---|---|
| Thread list, by project (`views/threads.js`: `threadRow`, `projectHead`; `format.js`: `relTime`, `projectOf`) | `crates/sidebar/src/sidebar.rs`: `rebuild_contents`, `thread_display_time`, `render_thread`, `render_project_header`; `crates/project/src/project.rs`: `ProjectGroupKey::display_name`; `crates/agent_ui/src/threads_archive_view.rs`: `format_history_entry_timestamp` | gap |
| Thread: reducing `session/update` (`acp.js`: `Timeline.apply`) | `crates/acp_thread/src/acp_thread.rs`: `handle_session_update`, `upsert_tool_call`, `update_tool_call`, `can_merge_message_chunks` | verified |
| User and agent messages (`views/entry.js`: `userMsg`, `agentMsg`) | `render_entry`, `render_message_content` | to audit |
| Thoughts (`thoughtMsg`): 20 px horizontal margins like other entries (in Zed, a chunk of the assistant message `px_5`) | `render_thinking_block`; `crates/agent_ui/src/entry_view_state.rs`: `auto_expand_streaming_thought` | verified |
| Tool calls: two layouts (simple line / card), header, failure cross, expanding (`toolCall`); icons per kind (`TOOL_KIND_ICON`: `read`/`search` → magnifier `ToolSearch`) | `render_tool_call`, `render_tool_call_label`, `render_tool_call_content`; settings `expand_edit_card`, `expand_terminal_card` | verified (0.5) |
| Terminal (`terminalCard`): cwd (agent `terminal_info.cwd`, else the thread's project), duration `(1m 11s)` past 10 s (live then frozen), failure as a red cross, code in tooltip | `render_terminal_tool_call`; `crates/agent_ui/src/ui/terminal_tool_header.rs`; `util/time.rs` (`duration_alt_display`) | verified (0.5) |
| Diff (`diffBlock`, `diff.js`): no gutter, lines filled at 12% | `render_diff_editor` | verified (0.5) |
| Plan, above the composer (`views/entry.js`: `planPanel`; `views/thread.js`: `syncActivity`) | `render_activity_bar`, `render_plan_entries`, `render_plan_summary` | verified |
| Permission in its tool call's card (`permissionButtons`), recalled above the composer when the card is out of view; tool call created by the request (`acp.js`: `permission`) | `render_permission_buttons` and variants, `render_main_agent_awaiting_permission`; `crates/acp_thread/src/acp_thread.rs`: `request_tool_call_authorization` (`upsert_tool_call`) | verified |
| Agent question: card in the thread, fields from the schema, Submit / Decline / Cancel, removed once answered (`views/entry.js`: `elicitationCard`); defaults and validation — required, lengths, pattern, `email`/`uri`/`date`/`date-time` formats, bounds, number of choices (`elicitation.js`) | `conversation_view/elicitation.rs`: `ElicitationCard`, `render_field`, `render_actions`, `should_render_elicitation`, `validate`, `validate_*_value`, `multi_select_default_value` | verified |
| Turn in progress: braille Dots / Sand spinner, duration (`views/thread.js`: `syncTurn`) | `render_generating`; `ui/components/label/spinner_label.rs` | verified (0.5) |
| Composer (`views/thread.js`: `Composer`, `editor.js`): contenteditable with a textarea-like facade (design D2 — plain-text draft, Enter/Shift+Enter/Ctrl+Enter, plain-text paste, CSS autogrow), atomic `.mention` mention chips serialized [@name](uri) (D3), buffer 12 input, left "+" / right gauge + selectors + stop + send bar | `crates/agent_ui/src/message_editor.rs`, `render_send_button`, `ui/mention_crease.rs` | verified (0.5.2); real Android IME: `ISSUES.md` |
| Slash completion (`completion.js`, `Composer`): `/` menu anchored to the caret, above it (the composer is at the bottom), approximated fuzzy filter (bold), "Commands" header hidden once an argument is typed, selected item's description in an aside (right if ≥ 260 px, else above), confirming sends unless an expected argument is missing; menu closed as soon as a whitespace follows the command; unknown `/command` validation → "An Error Happened" callout above the composer; "/ for commands" placeholder if the agent advertises commands | `completion_provider.rs` (`SlashCommandCompletion::try_parse`, `search_slash_commands`), `message_editor.rs` (`validate_slash_commands`, `confirm_command`, `placeholder_text`), `crates/editor/src/code_context_menus.rs` (`render`, `render_aside`), `crates/editor/src/element.rs` (`layout_context_menu_aside`); gallery section 14 | verified (0.5.2); `try_parse` trailing-space gap: the code checks `is_empty` before `trim_end` (lone space ⇒ `Some("")`), ZRA follows the tests (no argument) — the only semantics that keep the hint and send guard working |
| Command argument hint (`input.hint`): muted inlay after `/name ` while there is no argument (position = end of the last non-whitespace + 1, clamped to the text; leading space if missing) | `message_editor.rs` (`command_hint`, `InlayHintKind::Parameter`, `syntax.hint` color, no background) | verified (0.5.2); PWA: ghost span `.composer__hint` (contenteditable=false), excluded from the text, caret kept before it |
| Mention completion (`mentions.js`, `completion.js`): rightmost `@` at a boundary (start, whitespace, `(` `[` `{`), no whitespace right after; project files **and folders** (daemon listing, `files` request), approximated fuzzy capped at 100, file/folder icons, no aside; confirming inserts the chip + a space; menu closed as soon as a whitespace follows the query | `completion_provider.rs` (`MentionCompletion::try_parse`, `Candidates::Entries`, `match_path_sets`), `ui/mention_crease.rs`; gallery section 14 | verified (0.5.2); PWA: subsequence fuzzy, generic file-text/folder icons (not per extension) |
| Mention serialization and sending: chips ↔ text [@name](file:///…) (percent-encoded, trailing `/` for folders), links in text reparsed, `resource`/`resource_link` blocks per `embeddedContext`, realpath guard within `folderPaths` | `acp_thread/src/mention.rs` (`MentionUri::as_link`, `to_uri`), `message_editor.rs` (`parse_mention_links`, `mention_to_content_block`) | verified (0.5.2); conversion on the daemon side (`zra-daemon/mentions.js`, D1) |
| Mode, model, options (`views/thread.js`): selectors in the composer bar; icon-only mobile reduction = ZRA implementation | `crates/agent_ui/src/mode_selector.rs`, `model_selector.rs`, `config_options.rs` | verified (0.5) |
| Queue, Stop (`views/thread.js`: `stopTurn`) | `conversation_view/message_queue.rs` (`MessageQueue`), `cancel_generation`, `render_message_queue_entries` | verified |
| Themes (`css/themes.css`, generated by `scripts/gen-themes.mjs`) | `assets/themes/` (MIT); tokens: `crates/theme/` | verified |
| Icons (`icons.js`), agent icons (`agent-icons.js`, `scripts/gen-agent-icons.mjs`; ACP registry via Zed's cache, `zra-daemon/agent-icons.js`) | `assets/icons/` (Lucide, ISC; brand icons separate); `crates/project/src/agent_registry_store.rs` (ACP registry) | to audit |
| Spacing, text sizes, radii (`css/app.css`) | `crates/ui/src/styles/` (`spacing.rs`, `typography.rs`, `elevation.rs`); components: `crates/ui/src/components/` | to audit |

GPUI styles are written like utility classes (`.px_2()`, `.gap_1()`, `.rounded_md()`, `.text_color(colors.text_muted)`): each one translates into a CSS declaration. The base values in `crates/ui/src/styles/` become CSS variables in `app.css`, like the colors in `themes.css`.

## Points to watch

- **Several channels installed**: ZRA follows the one whose database was written last, determined when the daemon starts. To follow another one: `zedChannel` in `zra.config.json`.
- **ACP v2**: behind a beta flag in Zed 1.28.1. If it becomes the default, the shim sees v2 frames it does not observe. Draft under `_upstream/acp/docs/protocol/v2/`; `migration.mdx` lists the breaking changes.
- **Palette**: its labels derive from action names (`humanize_action_name`). A renamed action breaks the matching recipe.

## Updating the reference

1. Fetch the new version and list what changed on the paths of this page:

   ```sh
   git -C _upstream/zed fetch --depth 1 origin tag vX.Y.Z
   git -C _upstream/zed diff v1.28.1 vX.Y.Z --stat -- crates/agent_ui crates/sidebar crates/workspace/src/persistence.rs crates/workspace/src/multi_workspace.rs crates/session crates/db crates/paths crates/agent_servers crates/acp_thread crates/project/src/agent_server_store.rs crates/project/src/project.rs crates/workspace/src/workspace.rs crates/util/src/path_list.rs crates/node_runtime crates/cli crates/command_palette crates/settings_content/src/agent.rs crates/ui crates/theme assets/keymaps assets/themes assets/icons
   git -C _upstream/zed checkout vX.Y.Z
   ```

   The diff needs the old tag locally: otherwise, `git fetch --depth 1 origin tag v1.28.1` first.

2. Reread the changed files, update the tables and the reference version.
3. Themes or icons changed: rerun `scripts/gen-themes.mjs` or `scripts/gen-agent-icons.mjs`.
4. Check a machine (`docs/en/architecture.md`, "Checking a machine").

The ACP reference updates separately: when Zed's `Cargo.lock` changes the `agent-client-protocol-schema` version, re-download the tag of the same name (command above, other tag). Changes between versions are listed in `schema/v1/CHANGELOG.md` and `schema/v2/CHANGELOG.md`.
