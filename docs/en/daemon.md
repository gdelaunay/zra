# zra-daemon

ZRA gateway for a machine: reads Zed's thread index, speaks the ZRA
protocol to the mobile clients, and holds the injection backends.

One daemon per machine, long-running. No runtime dependency:
Node ≥ 24 provides SQLite (`node:sqlite`), the HTTP server and the test runner, and
the WebSocket (RFC 6455) fits in `ws.js`.

```bash
npm run daemon          # listens on loopback + local network (+ tunnel if there is one)
npm run daemon:dev      # loopback only
npm run pair            # pairing code, paired devices
npm run service         # the daemon as a scheduled task, at session login
npm test                # full suite, without Zed or agent
```

Setup: `docs/en/deploy.md`.

## What it does

- reads Zed's `sidebar_threads` index read-only (2 s poll, diff);
- relays the shims' ACP stream **verbatim** to the clients, with a ring buffer
  of 2000 events per thread, replayed on `subscribe`;
- injects from the phone: sending, queue, interruption, options,
  permissions (`acp` backend by default and the only supported one; `uia` and `auto`
  experimental; `mock` for tests);
- replays a closed thread through `session/load`, 10 min cache;
- drives Zed with the keyboard to open a thread or reopen a closed thread;
- listens on loopback, the local network and the tunnel, followed live, with
  device pairing and optional TLS reloaded live.

## Driving Zed

Zed exposes nothing to UI Automation (empty tree): the daemon drives it with the
keyboard, through **recipes** — sequences of keys, texts and pauses — that
`zed/keyboard.ps1` runs on the Zed window. Text is typed as Unicode
(clipboard untouched), and the recipe stops at once if Zed loses the foreground.

- **new thread**: the agent's key set by `npm run setup` in Zed's
  `keymap.json` (palette as a fallback), in the project's window, opened
  if needed by the Zed CLI;
- **closed thread**: the Zed CLI opens its project, then the
  `openThread` recipe finds it by its title in the sidebar.

```jsonc
"zedControl": { "enabled": true, "recipes": { "openThread": [ … ] } }
```

The proof that Zed obeyed never comes from a delay but from the **shim**: a
new session (`new_thread`), the reload of the right `session_id` (closed
thread), the turn going `busy` (`uia` backend). Tuning the recipes:
`npm run zed -- probe | recipes | try <recipe> [--apply]`.

Control disabled (`zedControl.enabled: false`): `new_thread` answers
`new_thread_failed` and writing to a closed thread answers `inject_failed`, each
with its reason.

## Diagnostics

`GET /status`, on loopback only: backend, threads by state, shims and
their sessions. This is what `npm run setup` shows.

## The shim channel

A second WebSocket path on the same port, **reserved to loopback**:
`ws://127.0.0.1:7777/shim`. It is a conversation between two processes on the same
machine, separate from `docs/en/protocol.md` (which only describes PWA ↔ daemon).

```
shim → daemon   shim_hello · session · session_closed · session_replay · acp_update ·
                state · permission_resolved · permission_expired ·
                elicitation_resolved · elicitation_expired · notice · ack
daemon → shim   cmd { id, cmd: prompt|cancel|set_option|
                              respond_permission|respond_elicitation|cancel_queued }
```

Two translations, and they only happen in `shim-link.js`:

- **`session_id` → `threadId`.** The shim only knows ACP sessions, the PWA
  only `threadId`s. A session whose row is not yet in
  `sidebar_threads` — Zed writes it with a delay — has its events
  set aside then replayed as soon as the index names it.
- **command → acknowledgment.** The hub wants a promise that fails with a
  protocol code; the shim answers with an `ack`.

The **turn and the queue live in the shim**, the only one to see the
real traffic. The daemon only keeps a mirror of them for the PWA
(`thread-state.js` → `mirror()`). If the shim dies, the queue is lost and the
phone is warned by an explicit `zra/notice`.

## Web client, HTTPS, listening

- The daemon serves `zra-client/` on the same port as the WebSocket (`serveStatic`, `--no-static` to do without); the client can also come from elsewhere and open a WebSocket to each machine.
- HTTPS (PWA installation, service worker): reverse proxy in front of the daemon, or `"tls": { "cert", "key" }` (`docs/en/deploy.md` §4).
- `allowedOrigins`: origins allowed on `/ws`, as a second line behind pairing; the daemon's own origins are added automatically, a request without `Origin` is accepted.
- Listening (loopback, local network, tunnel, never `0.0.0.0`) and pairing: `docs/en/architecture.md` and `docs/en/deploy.md`.

## Files

| | |
|---|---|
| `index.js` | CLI entry, signals, options |
| `daemon.js` | wiring, exported for in-process tests |
| `config.js` | `zra.config.json` + environment variables |
| `i18n.js` | messages in French or English (``tr`…` ``, catalog `i18n/en.json`), for the daemon, the shim and the scripts |
| `server.js` | HTTP/HTTPS, WS upgrade, `Origin` allowlist, listeners opened and closed live |
| `net.js` | listening addresses: loopback, local network, tunnel; network tracking |
| `auth.js` | pairing: code, hashed tokens, revocation |
| `ws.js` | WebSocket RFC 6455 (fragmentation, ping/pong, close) |
| `static.js` | web client static files |
| `hub.js` | protocol routing, broadcasting, invariants |
| `threads-index.js` | reading `sidebar_threads`, poll, projection |
| `thread-state.js` | turn, queue, options |
| `ring-buffer.js` | 2000 events per thread |
| `shim-registry.js` | shim → sessions registry (multi-session: Zed launches one agent per window) |
| `shim-link.js` | `/shim` channel: incoming events, outgoing commands |
| `session-loader.js` | replay of a closed thread, 10 min TTL cache |
| `acp-client.js` | minimal, disposable ACP client, for that replay; announces Zed's capabilities |
| `shell-env.js` | project environment captured as Zed does (login shell, direnv), for that replay |
| `agent-commands.js` | how to launch an agent: config, `settings.json`, Zed registry |
| `agents.js` | `agent_servers` registry, Zed presence |
| `jsonc.js` | tolerant parser for Zed's `settings.json` |
| `inject/` | injection interface + `acp`, `uia`, `auto`, `mock` backends |
| `zed/` | Zed keyboard control: `keyboard.ps1`, recipes, `new_thread`, reopening |
| `zed-settings.js` | surgical editing of Zed's `settings.json` (`npm run setup`) |
| `zed-keymap.js` | ZRA block of Zed's `keymap.json`: one "new thread" key per ZRA entry |

## Tests

```bash
npm test                                          # everything, without Zed or agent
node --test zra-daemon/test/protocol.test.mjs     # compliance with docs/en/protocol.md
node --test zra-daemon/test/e2e-shim.test.mjs        # daemon + shim + stub agent
npm run fixture                                   # regenerates the SQLite fixture
```

The fixture `test/fixtures/sidebar_threads.sqlite` reproduces the real schema with
synthetic rows covering the edge cases (`scripts/make-fixture.mjs`).
`scripts/probe-zed-db.mjs` inspects the real database, read-only.
