# zra-client — the PWA

ZRA's front end. **Zero build**: native HTML + CSS + ESM, served as is by
`zra-daemon` or by any static server (`docs/en/deploy.md` §4.1). No
runtime dependency, no bundler, no framework.

```
zra-client/
  index.html  manifest.webmanifest  sw.js  icon.svg
  css/   themes.css (generated)  app.css
  js/    main.js store.js link.js settings.js acp.js markdown.js diff.js
         dom.js icons.js format.js ui.js i18n.js en.js elicitation.js
         themes.js + agent-icons.js (generated from Zed)
         views/  threads.js thread.js entry.js settings.js new-session.js pair.js devbar.js
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
top bar      identity / thread title (+ agent, path, date) · actions
search       thread filter (list screen, under the top bar; choice persisted)
content      thread list  |  event stream
composer     input + `/` completion + selectors (mode, model…) + gauge (thread screen)
bottom bar   Zed status bar: agent button, thread list button
```

The "normal" screen is the thread: navigation between the two screens goes
through the two bottom bar buttons (active button = current screen); the
agent button returns to the last opened discussion.

Thread actions: on hover on desktop (like Zed), on long press on mobile —
rename (single-line editor in place of the title), stop generation, delete
(confirmation). The agent page title is itself an editable input. Rename and
delete go through ACP, gated by the agent's capabilities (`docs/en/acp.md`).

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

## Contract with the daemon

→ **`docs/en/protocol.md`** at the root: full contract, message by message, with the
sequences and invariants. Summary:

- it sends `hello` `list_threads` `subscribe` `unsubscribe` `load_history`
  `send` `interrupt` `set_option` `cancel_queued` `respond_permission`
  `new_thread` `rename_thread` `delete_thread` `push_subscribe` `push_unsubscribe`;
- it receives `machine` `threads` `thread_state` `acp_event` `history`
  `thread_created` `permission_resolved` `push_subscribed` `push_unsubscribed` `error`.

`acp_event.update` is passed **verbatim** to `js/acp.js`, which reduces it to a
timeline. An unknown `sessionUpdate` is never an error: it is shown as a
collapsible raw block. This is the rule of §1 applied to the front end.

Two ZRA extensions, explicitly prefixed so as never to be confused with
ACP:

- `zra/terminal_output` — `{ terminalId, output, append?, exitStatus? }`;
- `zra/notice` — `{ text, level }`, for daemon messages (turn interrupted,
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

## Wired to the daemon

The whole protocol is wired against the real daemon: machine identity, modes,
models and other agent settings, permissions (including the race with the
machine), pairing. Address of a machine without a port: 7777 over `http://`, 443 over
`https://` (behind a reverse proxy).

**Web Push**: the "Notifications (turn end)" setting asks for the browser's
permission then subscribes to the machine (`js/push.js`, VAPID key from
`machine.pushKey`); `sw.js` shows the notification and opens the thread on
click. The daemon notifies the end of a turn that no connected client is
watching live. A browser has only one push subscription: it goes to the first
online machine advertising a key.
