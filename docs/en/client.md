# zra-client — the PWA

ZRA's front end. **Zero build**: native HTML + CSS + ESM, served as is by
`zra-daemon`, by `zra-relay` or by any static server
(`docs/en/deploy.md` §4). No runtime dependency, no bundler, no framework.

```
zra-client/
  index.html  manifest.webmanifest  sw.js
  icons/  logo + favicon/apple-touch/maskable/badge/tray (generated)
  css/   themes.css (generated)  app.css
  icon-themes/  colored-zed/ (vendored: theme.json, dark/light SVGs, LICENSES)
  js/    main.js store.js link.js settings.js acp.js markdown.js diff.js
         dom.js icons.js file-icons.js format.js ui.js settings-window.js i18n.js en.js elicitation.js
         themes.js + agent-icons.js + file-icons-data.js (generated from Zed)
         views/  threads.js thread.js entry.js settings.js machine-settings.js new-session.js new-thread.js new-project.js pair.js devbar.js
         mock/   mock-link.js scenarios.js
  tools/ mock-server.mjs
  test/  *.test.mjs
```

## Running without Zed, daemon or agent

```bash
npm test            # the whole suite, including the PWA: markdown, diff, ACP reduction, stub daemon, headless PWA
npm run mock        # http://127.0.0.1:7777 (DESK-ZED) + :7778 (LAPTOP-ZED)
```

> **Always go through HTTP.** Opening `index.html` with a double click does not work:
> the browser refuses ESM modules over `file://` (each local file is a
> "null" origin). `npm run mock` serves the PWA, it is the only way to test.

Two mock modes, deliberately redundant:

| Mode | How | What it exercises |
|---|---|---|
| **Stub daemon** | `npm run mock`, then `http://127.0.0.1:7777/` | the whole real path: WebSocket, reconnection, protocol §7 |
| **Full mock** | `http://127.0.0.1:7777/?mock=1` | the PWA alone, without WebSocket — handy for working on rendering |

The two ports are **two simulated machines**, not two versions: one daemon runs
per machine (§3.2), the stub starts two to exercise multi-machine.

In both cases, a **mock bar** shows up at the bottom of the screen: it triggers
by hand the cases to check — full turn (thinking,
plan, read, diff, terminal, streamed markdown), cancellable long turn, permission
request, unknown ACP event, daemon error, machine offline, shim
loss, new thread opened in Zed.

To see both machines in stub daemon mode: Settings → Machines →
add `127.0.0.1:7778`.

## Interface skeleton

Both screens share the same frame, with fixed heights, so that nothing
moves from one screen to the other:

```
top bar      identity / thread title (+ agent, path) · actions
search       thread filter (list screen, under the top bar; choice persisted)
content      thread list  |  event stream
composer     input + `/` completion + selectors (mode, model…) + gauge (thread screen)
bottom bar   Zed status bar: agent button, thread list button
```

The "normal" screen is the thread: navigation between the two screens goes
through the two bottom bar buttons (active button = current screen); the
agent button returns to the last opened discussion.

A project's “+” opens a transient creation screen (`#/new/<machine>`,
`views/new-thread.js`): Zed's pulsing label while the session opens, then the
thread once created (`thread_created`). A failure (`new_thread_failed`) shows
there as a “Failed to Launch” callout — Retry, copy, close — like Zed's panel
(`docs/en/zed.md`).

Thread actions: on hover on desktop (like Zed), on long press on mobile —
rename (single-line editor in place of the title), stop generation, delete
(confirmation). The agent page title is itself an editable input. Rename and
delete go through ACP, gated by the agent's capabilities (`docs/en/acp.md`).

Settings and modals: global settings (`views/settings.js`) and machine settings
live in a Zed-style window (`settings-window.js`, reference
`reference/zed-ui/settings-window.html`) — titlebar with close only, tree nav +
search on the left, all content scrollable on the right (the nav scrolls to the
section and follows scrolling); below 626 px the nav becomes horizontal chips.
Closing backdrop. Confirmations (thread deletion, machine removal, language/mock
reload) are Zed-style centered modals with severity — red button for deletions —
stacked over the window; new project and pairing are form modals (same surface,
settings fields).

Machine settings: on hover on desktop, on long press on mobile, a settings
icon opens the machine's settings window (`views/machine-settings.js`) — keep
awake (mode dropdown, coffee status + countdown). When the inhibition is active,
the row shows a coffee icon (green for the explicit toggle, orange during an
agent turn) with the remaining TTL on its left (meta style, separated by a “·”),
updated every second; on hover/long press the coffee gives way to the settings
button in the same box, the TTL stays put.

The composer is a contenteditable with a textarea-like facade (`editor.js`):
the draft stays plain text, Enter sends, Shift+Enter and Ctrl+Enter insert a
newline, paste is plain text, and the field grows up to 40% of the screen.
Mention chips will come with `@`.

The composer offers the agent's commands: typing `/` opens the completion
anchored to the caret (fuzzy filter, selected item's description in an aside);
the argument hint shows as a ghost span after `/name `; confirming sends,
unless the command expects an argument that has not been typed. An unknown
command at the start of the message is refused with a callout, like Zed
(`docs/en/acp.md`).

Typing `@` opens the mention menu: project files and folders, listed by the
daemon (`files` request, 30 s cache), fuzzy filter capped at 100. Confirming
inserts an atomic **chip** (backspace = the whole chip); the draft stays plain
text, serialized `[@name](file:///…)` — the daemon converts the links to ACP
blocks on send (`docs/en/acp.md`, path guard §9). User messages display
mentions as chips, both ACP blocks and markdown links from the claude-acp
replay.

## Contract with the daemon

→ **`docs/en/protocol.md`** at the root: full contract, message by message, with the
sequences and invariants. Summary:

- it sends `hello` `list_threads` `subscribe` `unsubscribe` `load_history`
  `send` `interrupt` `set_option` `cancel_queued` `respond_permission`
  `new_thread` `new_project` `rename_thread` `delete_thread` `push_subscribe` `push_unsubscribe`;
- it receives `machine` `threads` `thread_state` `acp_event` `history`
  `thread_created` `project_created` `permission_resolved` `push_subscribed` `push_unsubscribed` `error`.

`acp_event.update` is passed **verbatim** to `js/acp.js`, which reduces it to a
timeline. An unknown `sessionUpdate` is never an error: it is shown as a
collapsible raw block. This is the rule of §1 applied to the front end.

Two ZRA extensions, explicitly prefixed so as never to be confused with
ACP:

- `zra/terminal_output` — `{ terminalId, output, append?, exitStatus? }`;
- `zra/notice` — `{ text, level, untilSend? }`, for daemon messages (turn interrupted,
  queue lost…).

The shim emits them; the PWA only uses them if they arrive.

## Agent icons

Two sources, as in Zed. The **ACP registry** first: Zed downloads the agents'
icons (Pi, Qwen, Goose…) into its cache
(`external_agents/registry/icons/<id>.svg`); the daemon reads them back
(`zra-daemon/agent-icons.js`) and sends them in the `machine` message
(`agentIcons`). The PWA shows them as-is, monochrome (`currentColor`) — Zed's
exact icon for that agent id.

As a fallback, the **bundled glyphs**: `js/agent-icons.js` is **generated** from
the icons shipped with Zed (`assets/icons/ai_*.svg`), rendered monochrome
through `currentColor`:

```bash
curl -sL https://raw.githubusercontent.com/zed-industries/zed/main/assets/icons/ai_claude.svg -o .cache/ai_claude.svg
node scripts/gen-agent-icons.mjs
```

The `agent_id` → icon mapping is done by exact id in the registry, then by
pattern on the bundled glyphs (`claude-acp`, `Claude Agent (zra)`,
`my-claude` → Claude), unknown agent → generic icon.

## Language

Texts in French in the code (reference text, key) and in English in
`js/en.js`, chosen by the **Language** setting (auto by default: browser
language, English if it is not French). An added or changed text goes
through ``tr`…` `` (`js/i18n.js`), then
`node scripts/i18n-test.mjs --write` and its translation in `en.js`. Daemon
messages (errors, `zra/notice`) arrive in the machine's language.

## Themes

`css/themes.css` and `js/themes.js` are **generated** from Zed's official themes
(`zed-industries/zed`, `assets/themes/`):

```bash
curl -sL https://raw.githubusercontent.com/zed-industries/zed/main/assets/themes/gruvbox/gruvbox.json -o .cache/gruvbox.json
npm run themes
```

CSS variables reuse Zed's token names (`element.hover` →
`--element-hover`), so adding a theme = adding a line in
`scripts/gen-themes.mjs`. Eight themes shipped. **Default: One, dark or light
following the browser** (`prefers-color-scheme`), as long as no manual choice
was made; the first choice is persisted and freezes the theme.

## File icon set

Mention chips and the completion menu show the file's icon according to the
**Theme → Icon set** setting (`js/file-icons.js`):

- **Default**: generic `file-text`/`folder` icons from the ZRA set.
- **Colored Zed Dark / Light**: the "Colored Zed Icons Theme" extension
  (TheRedXD), vendored in `icon-themes/colored-zed/` with its licenses
  (`LICENSES`, Lucide ISC in particular). No extension downloads.

Resolution is a port of Zed's `FileIcons::get_icon`: full name, then each
suffix after a dot, then the prefix before the first dot
(`Dockerfile.prod`), compound extensions, hidden file (`.gitignore`),
simple extension. Name/extension → type associations come from the Zed
default (`icon_theme.rs`), merged with the chosen set's overrides — like
`registry.rs` on the Zed side. `js/file-icons-data.js` is **generated**:

```bash
npm run file-icons   # reads _upstream/zed + icon-themes/colored-zed/theme.json
```

Assumed divergences: a type missing from the colored set falls back to
generic `file-text` (Zed falls back to the default theme's monochrome SVG);
folders always keep `folder` (no folder icons in the colored sets). Changing
the set repaints the thread without a reload.

## App icons

"Split two-tone Z" logo, derived into `icons/` from a single source by
`scripts/gen-icons.mjs` (sharp, no runtime dependency):

| File | Use |
|---|---|
| `icon.svg` | modern favicon + source; neutral/accent adapt to light/dark (`prefers-color-scheme`) |
| `favicon-32.png` | favicon fallback (Safari), dark background |
| `apple-touch-icon.png` | iOS home screen, full background |
| `icon-192.png` | manifest `any` (launcher fallback), rounded dark background, mark in the safe zone |
| `icon-maskable.png` | manifest `maskable`, mark within the safe zone |
| `badge.png` / `badge.svg` | notification badge (mobile status bar), white silhouette |
| `tray.png` | system tray (embedded in `zra-tray`): dark variant, color on transparent |
| `tray-light.png` | system tray: light variant, color on transparent |

Gruvbox colors: neutral `#ebdbb2`, accent `#b8bb26` (dark) / `#98971a`
(light). The tray picks its variant from the Windows taskbar theme
(`SystemUsesLightTheme` registry value, checked every 5 s); Linux keeps the
dark variant (no reliable panel theme). The header logo (`brandLogo()`, `js/icons.js`) is inline: neutral as
`currentColor`, accent as `light-dark()` — it follows the app theme, not the
OS one.

```bash
node scripts/gen-icons.mjs   # regenerates icons/ from the mark
```

## Wired to the daemon

The whole protocol is wired against the real daemon: machine identity, modes,
models and other agent settings, permissions (including the race with the
machine), pairing.

Two serving modes, automatic detection at boot (`/zra-relay` then
`/zra-daemon` markers):

- **served by the relay**: a typed IP becomes a `/to/<ip>[:<port>]` route on
  the page's origin (`wss://<host>/to/<ip>[:<port>]/ws`, port 7777 by default);
  the machine is named by its IP (port included when given), no implicit
  machine;
- **served by the daemon itself** (`/zra-daemon` marker, any port, any
  address): implicit machine on the page's origin — "This machine" on
  loopback, the host otherwise. Without the marker but local (dev server):
  daemon assumed on 7777, a dev convenience;
- **served elsewhere** (per-machine proxy, static server): direct
  behavior — address of a machine without a port: 7777 over `http://`, 443 over
  `https://` (behind a reverse proxy).

Saved machines persist their **target** (IP or address), never the built URL:
it is rebuilt at boot according to the current mode (`settings.js`:
`parseTarget`, `machineUrl`). The server behind a domain can change
(daemon ↔ relay) without breaking entries — an IP typed under the relay
follows the direct rules when the page is served by a daemon, and pairing
tokens follow the target: same machine, same token across modes.

**Web Push**: the "Notifications (turn end)" setting asks for the browser's
permission then subscribes to the machine (`js/push.js`, VAPID key from
`machine.pushKey`); `sw.js` shows the notification and opens the thread on
click. The daemon notifies the end of a turn that no connected client is
watching live. A browser has only one push subscription: it follows the
machine of the last opened thread (`settings.lastThread`), falling back to
the first online machine advertising a key. While the PWA is open, a turn
ending plays Zed's "tu-dum" (`js/sound.js`, `sounds/agent_done.wav`), on any
machine; the "Turn-end sound" setting toggles it (on by default).
