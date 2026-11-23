# ZRA — ACP sheets

The ACP methods ZRA uses: what the spec says, where ZRA handles them, where Zed implements them — and, at the end of the page, **per-agent compatibility** (who implements what, and how). Complements `docs/en/zed.md` (mapping to Zed) and `docs/en/protocol.md` (PWA ↔ daemon contract).

## Reference

- **ZRA speaks ACP v1. Reference spec: tag `v1.15.1`** of the specification repository — the version Zed 1.28.1 develops against (crate `agent-client-protocol-schema` 1.15.1). Paths on this page are relative to `_upstream/acp` and valid for this tag; setup in `docs/en/zed.md`.
- Method table: `schema/v1/meta.json`; exact shapes: `schema/v1/schema.json`. **Unstable** methods (`session/set_title`, `session/delete`): `meta.unstable.json`, `schema.unstable.json`. Spec files cited in the tables live under `docs/protocol/v1/`.
- No ACP SDK: hand-rolled JSON-RPC (`zra-shim/framing.js`). The shim relays everything between Zed and the agent and only interprets the methods below; the rest (`fs/read_text_file`, `fs/write_text_file`, `terminal/create|kill|release`, `authenticate`…) passes through transparently.

## Agent methods (ZRA → agent, or observed by the shim)

| Method | Spec | ZRA side | Zed side |
|---|---|---|---|
| `initialize` | `initialization.mdx` | The shim captures version, `agentInfo` and capabilities (`zra-shim/acp.js`: `noteResponse`): `loadSession`, `sessionCapabilities.title/.delete`, `promptCapabilities.embeddedContext`…; the disposable client checks `loadSession` (`zra-daemon/session-loader.js`) | `crates/agent_servers/src/acp/v1.rs`: `connect`, `client_builder`, `client_capabilities_for_agent` |
| `session/new` | `session-setup.mdx` | Session tracked on the response (`noteResponse`, `openSession`) | `acp/v1.rs`: `new_session` |
| `session/load` | `session-setup.mdx` | Live thread: observed from Zed (`observeFromZed`). Closed thread: disposable client, replay collected → `history`, 10-min cache (`session-loader.js`: `load`, `replay`) | `acp/v1.rs`: `load_session`; `crates/agent_ui/src/conversation_view.rs`: `load_session` |
| `session/resume` | `session-setup.mdx` | Session tracked (`noteResponse`); Zed resumes without replay for agents lacking `loadSession` | `acp/v1.rs`: `resume_session`; `conversation_view.rs`: `resume_session`, `supports_resume_session` |
| `session/close` | `session-setup.mdx` | The shim drops the tracked session (`closeSession`) | `acp/v1.rs`: `release_session` |
| `session/prompt` | `prompt-turn.mdx`, `error.mdx` | Queue, content blocks (mentions built by `zra-daemon/mentions.js`, path guard — `protocol.md` §9); rejected prompt: `code`/`data` kept end to end (`sendPrompt`, `settlePrompt`, `confirm`, `ShimError.details`); `-32603` + `data = { details }` → the `details` text as a normal message (`agentErrorSpec`, PWA); turn start dated at actual send (`queue.js`: `promptSent` → `turnSince`, mirrored to the PWA for the generation duration — ACP does not date turns) | `acp/v1.rs`: `prompt` (same `-32603`/`details` exception, gemini-cli workaround); "An Error Happened" callout (`thread_view.rs`: `render_any_thread_error`) |
| `session/cancel` | `cancellation.mdx` | Cuts the current turn (`cancel`, `cancelAndWait` — also before a delete) | `acp/v1.rs`: `cancel` |
| `session/set_mode` | `session-modes.mdx` | Projection and change (`projectOptions`, `setOption`, `applyOption`); Zed reapplies its `default_config_options` on every open: the shim notes it (`noteOptions`) | `acp/v1.rs`: `SetSessionModeRequest`, `AcpSessionModes` |
| `session/set_config_option` | `session-config-options.mdx` | Same as `set_mode` | `acp/v1.rs`: `set_config_option`, `config_state`; `crates/acp_thread/src/config_options.rs` |
| `session/set_title` *(unstable)* | `schema.unstable.json` | Live thread: the shim sends it (`setTitle`); closed thread: disposable client (`session-loader.js`: `operate`), without reopening Zed — the session need not be active. Returned title (possibly normalized) overlaid until Zed catches up (`zra-daemon/thread-ops.js`). Gated: `sessionCapabilities.title` | `conversation_view/thread_view.rs`: `apply_renamed_title` (+ local `title_override`, takes precedence) |
| `session/delete` *(unstable)* | `session-delete.mdx`, `schema.unstable.json` | Same paths as `set_title`; current turn cut first; persisted tombstone — Zed's row stays, the index masks it (`thread-ops.js`). Gated: `sessionCapabilities.delete` | `threads_archive_view.rs`: `delete_thread`; `session_list.supports_delete()` |

## Client methods (agent → ZRA, received by the shim)

| Method | Spec | ZRA side | Zed side |
|---|---|---|---|
| `session/update` | `prompt-turn.mdx`, `slash-commands.mdx`, `session-modes.mdx`, `session-config-options.mdx` | `noteUpdate` → thread state: chunks, tool calls, plan, modes/options, commands, title. Mobile message mirrored to Zed as a synthetic `user_message_chunk` (`publishUserMessage`, `mirrorUserMessage`). Closed thread: replay remembered by the PWA (`zra-client/js/acp.js`) | `acp/v1.rs`: `handle_session_notification`; `acp_thread.rs`: `handle_session_update`, `push_user_content_block_with_protocol_id` |
| `session/request_permission` | `tool-calls.mdx` | The shim answers on Zed's behalf (`notePermission`, `respondPermission`), then withdraws Zed's prompt (`$/cancel_request`) | `acp/v1.rs`: `handle_request_permission`; `acp_thread.rs`: `cancel_permission_request` |
| `elicitation/create` | `elicitation.mdx` | Published as `zra/elicitation` in the thread of its session (or of the Zed request it cites); the shim answers on Zed's behalf (`noteElicitation`, `respondElicitation`) then withdraws its form. `url` mode: link shown, opens on the desktop | `acp/v1.rs`: `handle_create_elicitation`; `acp_thread.rs`: `request_elicitation_with_id` |
| `terminal/output` | `terminals.mdx` | Output published to the daemon (`publishTerminal`); other path: tool-call `_meta` (`terminalMeta`, PWA) | `acp/v1.rs`: `handle_terminal_output`; `_meta.terminal_info`, `terminal_output`, `terminal_exit` |
| `terminal/wait_for_exit` | `terminals.mdx` | Response observed → `publishTerminal` | `acp/v1.rs`: terminal handling (`wait_for_exit`) |
| `$/cancel_request` | `cancellation.mdx` | Sent to withdraw Zed's prompt/form after the shim answers; received: agent cancellations (`noteElicitationCancelled`) | `acp_thread.rs`: `cancel_permission_request`, `cancel_elicitation` |

## Per-agent compatibility

Observed in the agents' sources (installed under `external_agents/registry`, or web) — not in the spec. The reliable runtime source remains each agent's `initialize` response; the shim captures it and the daemon persists it per agent (`thread-ops.js`, `canRename`/`canDelete` of the `threads` message).

### Renaming and deleting

`session/set_title`: the response returns the stored title, possibly normalized (the client displays that one); the agent must no longer replace it with a generated title. Invalid title: `-32602`; unknown session: `-32002`. `session/delete`: removes the session from `session/list`, on the agent side. With Zed open, a deleted thread stays in its sidebar (cache) until the next restart, but can no longer be opened.

Sources read 2026-11:

| Agent | `session/set_title` | `session/delete` |
|---|---|---|
| claude-acp | yes (v1 and v2) | yes |
| codex-acp | yes (v1 and v2) | yes |
| opencode | no | yes |
| goose | no | yes |
| kimi | no | no |
| gemini | no | no |

The ACP registry matrix (`agentclientprotocol/registry`, `.protocol-matrix/latest.md`, 42 agents probed) covers `session/list`, `fork`, `resume`, `stop`, `set_model` — not these two methods.

### Slash commands

Spec: announced via `session/update` `available_commands_update`, full list each time; `name`/`description` required, `input.hint` optional. No dedicated execution method: the command goes as text (`/name args`) in an ordinary `session/prompt`. Zed side: parsing and validation on send (`completion_provider.rs`: `SlashCommandCompletion`, `message_editor.rs`: `confirm_command`, `validate_slash_commands`) — unknown command at the start of a message rejected; the PWA carries the same behavior (`docs/en/client.md`, approximated fuzzy: `docs/en/limitations.md`).

- **claude-acp**: publishes its built-in, MCP (`mcp:server:command`) and skill commands; replays `available_commands_update` on `session/load` (closed thread: menu available via the replay).
- **pi-acp**: publishes its skills as `skill:name` commands.
- **gemini-cli**: publishes only `name`/`description` (no `input`).
- Other agents: the list comes from their `available_commands_update`, ZRA assumes nothing.

### Mentions: `resource_link` / `resource`

Spec (`content.mdx`): `resource_link` `{uri, name, …}` — a link the agent reads itself, every agent **MUST** support it in a prompt; `resource` (embedded) `{resource: {uri, text, mimeType?}}` — text content in the message, recommended path for `@` mentions, gated by `promptCapabilities.embeddedContext`. The `[@name](file:///…)` format is **not** the wire format: it is the serialization convention of Zed (`MentionUri::as_link`, `acp_thread/src/mention.rs`; conversion: `message_editor.rs`: `mention_to_content_block`) and claude-acp; on the wire, JSON blocks. Block construction and path guard on the ZRA side: `docs/en/protocol.md` §3/§9.

Installed sources read (`registry/npx/…`); web sources partially re-read:

| Agent | `embeddedContext` | `resource_link` file:// | `resource` embedded |
|---|---|---|---|
| claude-acp | yes | text `[@name](file:///…)` → Claude reads it itself (Read) | content injected as `<context ref="…">` |
| pi-acp | **not by default** (env `PI_ACP_ENABLE_EMBEDDED_CONTEXT=true`) | text `\n[Context] uri` → pi reads it itself | `[Embedded Context] uri (mime)` + content |
| qwen-code | yes | `fileData` → reads itself (`readManyFiles`); **filters workspace + ignored files**; folders handled | text context |
| gemini-cli | yes (PR #6756) | same code as qwen (fork); folder handled; outside workspace → ACP permission request | text context |
| opencode | yes | `file` part → reads itself; `zed://` also handled | text `[path:line]` + content |
| codex-acp | yes (advertised since 05/2026, commit #160) | supported (README: "resource links") — handling not re-read line by line | supported (README) |
| goose | to verify | **reads the UTF-8 file and inlines the content**; non-UTF-8/folder/missing: metadata preserved since PR #11941 (09/2026) — before: silently dropped (issue #11810) | header `--- Resource: …` + content |
| kimi | yes (kimi-cli PR #1264; kimi-code 06/2026) | decoded path (+ optional line); non-file → XML wrapper | handled |

Consequences: `resource_link` is the common denominator (spec MUST); embedded guarantees content arrival (qwen/gemini drop ignored/out-of-workspace files as links; goose drops non-UTF-8). Folders: best effort per agent (`docs/en/limitations.md`).