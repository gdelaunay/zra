# ZRA — ACP sheets

Sheets per ACP protocol method: what the spec says, how Zed uses it, what ZRA does with it, and which agents implement it. Complements `docs/en/zed.md` (mapping to Zed) and `docs/en/protocol.md` (PWA ↔ daemon contract).

Spec reference: `_upstream/acp` (tag v1.15.1, setup in `docs/en/zed.md`); unstable methods are in `schema/v1/schema.unstable.json`. ZRA speaks ACP v1.

## Renaming and deleting a thread

On the Zed side, everything goes through `ThreadMetadataStore` (`crates/agent_ui/src/thread_metadata_store.rs`), backed by `sidebar_threads`: in-memory cache, queued writes, database reread **only at startup and on migrations** — no file watcher, no external invalidation.

- **Rename**: `title_override` (takes precedence over the generated `title`, `set_title_override`); if the agent supports it, Zed also calls `session/set_title` (`conversation_view/thread_view.rs`: `apply_renamed_title`). The agent title comes back through the normal flow (`session_info_update` if the thread is live, `session/load` otherwise).
- **Delete** (archive view, `threads_archive_view.rs`: `delete_thread`): deletes the metadata row, then `session/delete` **only if the agent advertises it** (`session_list.supports_delete()`).
- **Archive**: local `archived` flag, no ACP equivalent. ZRA does not use it.

Both ACP methods are **unstable** (`_upstream/acp/schema/v1/schema.unstable.json`), gated by the agent's `initialize` response — `agentCapabilities.sessionCapabilities.title` and `.delete` — which the shim already captures (`zra-shim/acp.js`: `noteResponse`).

- `session/set_title`: the session does not need to be active on the connection. The response returns the stored title, possibly normalized (the client displays that one); the agent should no longer replace it with a generated title. Invalid title: `-32602`; unknown session: `-32002`.
- `session/delete`: removes the session from `session/list`, on the agent side.

What ZRA does with it — never write to Zed's database (read-only discipline of `threads-index.js`):

- **Live thread**: the shim issues the request on the connection Zed holds (`zra-shim/acp.js`: `setTitle`, `deleteSession`). A turn in progress is cancelled before deletion.
- **Closed thread**: disposable client (`zra-daemon/session-loader.js`: `operate`), without reopening Zed — the method targets the session stored on the agent side.
- **`zra-daemon/thread-ops.js`** holds the persisted state (`.zra/thread-ops.json`): tombstones (Zed's row remains, the index hides it — no resurrection), titles returned by the agent overlaid until Zed catches up (a rename done in Zed takes precedence and removes the overlay), per-agent capabilities for gating (`canRename`/`canDelete` in the `threads` message, absent = unknown).
- With Zed running, a deleted thread stays in its sidebar (cache) until the next restart, but can no longer be opened.
- PWA side: `rename_thread` / `delete_thread` (`docs/en/protocol.md` §3); `capability_missing` errors when the agent does not support the method.

Compatibility checked in the agents' sources (2026-11):

| Agent | `session/set_title` | `session/delete` |
|---|---|---|
| claude-acp | yes (v1 and v2) | yes |
| codex-acp | yes (v1 and v2) | yes |
| opencode | no | yes |
| goose | no | yes |
| kimi | no | no |
| gemini | no | no |

The ACP registry matrix (`agentclientprotocol/registry`, `.protocol-matrix/latest.md`, 42 agents probed) covers `session/list`, `fork`, `resume`, `stop`, `set_model` — not these two methods. The reliable source remains each agent's `initialize` response.

## Slash commands

Spec: `_upstream/acp/docs/protocol/v1/slash-commands.mdx` (v1.15.1).

- **Advertising**: `session/update` notification `available_commands_update`,
  full list each time (the agent may add/remove mid-session).
  `AvailableCommand`: `name` and `description` required, `input.hint` optional
  (argument hint, unstructured text).
- **Running**: no dedicated method — the command goes as text (`/name args`)
  in a regular `session/prompt`; the agent recognizes the prefix. A command
  may accompany other blocks of the same prompt.

On the Zed side (1.28.1, sources read):

- Trigger: rightmost `/` at a word boundary, no whitespace immediately after
  (`completion_provider.rs` `SlashCommandCompletion::try_parse`); fuzzy filter
  on the name; confirming inserts `/name ` keeping the typed argument, and
  **sends** (`message_editor.rs` `confirm_command → send`), unless the command
  has an `input` and no argument has been typed.
- `input.hint` → inlay after the command while there is no argument
  (`command_hint`); "Commands" header hidden once an argument is typed.
- Validation on send (`validate_slash_commands`): unknown `/command` at the
  start of the message → blocking error (empty list included, "none");
  "An Error Happened" callout above the composer. A space before the `/`
  escapes the rule.
- **1.28.1 discrepancy**: `try_parse` checks `args.is_empty()` before
  `trim_end()` (a lone space ⇒ argument `Some("")` in the code), its tests
  expect `None`. ZRA follows the tests — `ISSUES.md` `slash-espace-final`.

What ZRA does with it (0.5.2, 5a):

- The shim keeps `name`, `description` and `input.hint`
  (`zra-shim/acp.js`, `available_commands_update`) → `thread_state.commands`
  (`docs/en/protocol.md` §4) → the composer's `/` menu
  (`zra-client/js/completion.js`): parsing and validation ported from Zed,
  approximated fuzzy (`docs/en/limitations.md`), selected item's description
  in an aside, identical error callout. The argument hint shows as a ghost
  span after `/name ` (contenteditable composer, 5b-1).
- Closed thread: no shim, but claude-acp replays
  `available_commands_update` on `session/load` → the PWA stores it via
  `history` (`zra-client/js/acp.js`), the menu is available.
- Agents (sources read): claude-acp advertises its built-in, MCP
  (`mcp:server:command`) and skill commands; pi-acp advertises its skills as
  `skill:name` commands; gemini-cli only advertises `name`/`description` (no
  `input`). Other agents: the list comes from their
  `available_commands_update`, ZRA assumes nothing.

## Mentions: `resource_link` / `resource`

Spec: `_upstream/acp/docs/protocol/v1/content.mdx` (v1.15.1).

- **`resource_link`** `{uri, name, …}`: link to a resource the agent reads
  itself; every agent **MUST** support it in a prompt.
- **`resource`** (embedded) `{resource: {uri, text, mimeType?}}`: the text
  content is in the message; the **recommended** path for `@` mentions, gated
  by the `promptCapabilities.embeddedContext` capability of `initialize`.
- The `[@name](file:///…)` format is **not** the wire format: it is Zed's
  serialization convention (`MentionUri::as_link`) and claude-acp's internal
  conversion. On the wire, these are JSON blocks.

On the Zed side (1.28.1, sources read): `mention_to_content_block`
(`message_editor.rs`) — text file → `resource` if the agent advertises
`embeddedContext`, else `resource_link`; folder → always `resource_link`
(`file:///` URI with trailing `/`, `MentionUri::to_uri`,
`acp_thread/src/mention.rs`). Links in text are reparsed by
`parse_mention_links`; claude-acp's `session/load` replay renders user
messages as **text** containing these markdown links, not blocks.

What ZRA does with it (0.5.2, 5b-2, design D1/D3/D5):

- The PWA enters mentions as chips, serialized `[@name](file:///…)` in the
  sent text (`zra-client/js/mentions.js`, `editor.js`). The **daemon** parses
  the links at departure toward the ACP shim and builds the blocks (D1,
  `zra-daemon/mentions.js`): text file ≤ 1 MB and agent `embeddedContext` →
  embedded `resource` (content read by the daemon); else `resource_link`;
  folder, binary, non-UTF-8, > 1 MB → `resource_link`. **Guard**: the
  `realpath` must be contained in the thread's real `folderPaths`; out of
  scope → literal text (§9).
- File listing by the daemon (`files` request, `docs/en/protocol.md` §3):
  `git ls-files --cached --others --exclude-standard`, walk fallback outside
  git (+ `node_modules` excluded), cap 20,000, 30 s cache; fuzzy on the PWA
  side, cap 100.
- The shim sends the blocks as-is (`sendPrompt`, `zra-shim/acp.js`); the queue
  keeps the text for display and the blocks for sending.
- PWA rendering: `.mention` chips in user bubbles — `resource_link`/`resource`
  blocks **and** markdown links from the replayed text.

Agent matrix (installed sources read: `registry/npx/…`, verified; web sources
partially re-read: noted):

| Agent | `embeddedContext` | `resource_link` file:// | `resource` embedded |
|---|---|---|---|
| claude-acp | yes | text `[@name](file:///…)` → Claude reads itself (Read) | content injected in `<context ref="…">` |
| pi-acp | **not by default** (env `PI_ACP_ENABLE_EMBEDDED_CONTEXT=true`) | text `\n[Context] uri` → pi reads itself | `[Embedded Context] uri (mime)` + content |
| qwen-code | yes | `fileData` → reads itself (`readManyFiles`); **filters workspace + ignored files**; folders handled | text context |
| gemini-cli | yes (PR #6756) | same code as qwen (fork); folder handled; outside workspace → ACP permission request | text context |
| opencode | yes | `file` part → reads itself; `zed://` also handled | text `[path:line]` + content |
| codex-acp | yes (advertised since 05/2026, commit #160) | supported (README: "resource links") — handling not re-read line by line | supported (README) |
| goose | to verify | **reads the UTF-8 file and inlines the content**; non-UTF-8/folder/missing: metadata preserved since PR #11941 (09/2026) — before: silently dropped (issue #11810) | header `--- Resource: …` + content |
| kimi | yes (kimi-cli PR #1264; kimi-code 06/2026) | decoded path (+ optional line); non-file → XML wrapper | handled |

Consequences: `resource_link` is the common denominator (MUST spec);
embedding guarantees content arrival (qwen/gemini drop ignored/out-of-workspace
files as links; goose drops non-UTF-8). Folders: best effort depending on the
agent (`docs/en/limitations.md`).
