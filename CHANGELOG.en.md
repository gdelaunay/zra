# Changelog

[Français](https://forgejo.gdelaunay.fr/gdelaunay/zra/src/branch/main/CHANGELOG.md)

## In progress

- Linux tray fix: "Copy pairing code" no longer loses the clipboard — the arboard handle was dropped right after writing; on X11/Wayland the content is served by the process, and without a clipboard manager (xrdp session without klipper) it vanished. `.set().wait().text()` keeps the server thread alive until the content is replaced (sheet `tests-tray-debian-kde.md`, bug 1)
- PWA fix: implicit machine recognized on any origin served by a daemon — new public marker `GET /zra-daemon` → `{daemon:true}` (any port, any address, the counterpart of the relay's `/zra-relay`), detected at boot after relay mode; `originMachine()` no longer hardcodes 7777 (the PWA served on a non-standard port stayed Offline, and the LAN IP on a custom port had no implicit machine). Heuristics kept: local without marker → 7777 (dev), elsewhere port 7777 → origin (proxy). Docs `daemon.md`, `architecture.md`, `client.md` — bilingual (sheet `tests-tray-debian-kde.md`, bug 2)

- Relay: optional per-machine port — route `/to/<ip>:<port>/ws` (7777 by default, 1-65535 validation, GET probe and `Host` matched); on the PWA side, a typed IP with a port (`10.0.0.2:7778`) keeps it in relay mode (target `IP:port`, 7777 omitted to merge duplicates), subtitle `ws://IP:port`; the target follows direct mode without losing its port. Docs `deploy.md`, `architecture.md`, `client.md` — bilingual

- UI: settings and modals redesigned as Zed-style windows (reference `reference/zed-ui/settings-window.html`, port of `settings_ui` and `ui_prompt`) — bottom sheets are gone. Global and machine settings: fixed centered panel with closing backdrop, titlebar (close only), 226 px nav (filtering search + page/section tree), all content rendered at once and scrollable — the nav scrolls to the category and follows scrolling; below 626 px the nav becomes horizontal chips. Zed controls: 32×20 switch, 28 px checkmark dropdowns, 32 px fields; global settings as a General page (Machines / Appearance / Language & Text / Display / About), machine as a Keep Awake page (mode dropdown, the window stays open on choice)
- Confirmations (thread deletion, machine removal, language/mock reload): centered 320 px `ui_prompt` modal with the ZRA severity deviation — head icon, action tinted accent/warning/error (red button for deletions), Enter confirms / Escape cancels; stacks over the settings (Cancel no longer closes them). New project and pairing: form modals (documented ZRA composition, gallery section 10) — 380 px surface, head icon + title + close, settings fields, error as Banner, single tinted action
- Legacy sheet CSS removed (`.sheet`, `.field`, `.setting`, `.pair__code`), styles ported from the reference with existing tokens; SW shell completed (missing modules: `settings-window`, `machine-settings`, `new-project`, `new-thread`, `callout`, `completion`, `editor`, `mentions`), version `zra-v12`
- Doc: `zed.md` (settings window, controls, modals — values verified in `_upstream/zed`), `client.md`, `protocol.md` — bilingual; reference: section 10 “Form modal” + deviation documented in `zed-ui.md`, `gen.mjs` fix (internal `<rect>` `width`/`height` were being stripped — padlock and other rect-based icons restored)
- Thread creation: the “+” navigates straight to Zed's creation screen (`#/new/<machine>`, `views/new-thread.js`) — centered muted pulsing label (opacity 0.3 ↔ 0.7, 2 s) while the session opens, no more waiting toast; `thread_created` replaces the screen with the thread
- Creation failure (`new_thread_failed`) as a “Failed to Launch” callout on that screen (Retry resends `new_thread`, copy, close = back to list), like Zed's `render_load_error`; 45 s safety net on the PWA side (daemon: 30 s); navigation to the thread only on the creation screen, or if no creation was being tracked (reload during creation) — no stolen focus if the user went elsewhere
- Docs: `zed.md` (creation screen, `conversation_view.rs` `ServerState::Loading`/`LoadError`), `protocol.md` (`new_thread_failed`, `thread_created`), `client.md` — bilingual
- Keep awake: the machine never sleeps while an agent is working (automatic, derived from the existing busy/idle state, zero polling), plus an explicit per-machine toggle (1 h / 4 h / 12 h / until turned off) in a settings sheet on hover/long-press of the machine row; TTL and state on the daemon side, persisted (`.zra/keep-awake.json`), survive PWA disconnections and restarts
- Resident helper per OS (`keep-awake.ps1` → `SetThreadExecutionState` on Windows, `systemd-inhibit` on Linux): its death releases the inhibition, daemon crash included; early failure → machine unsupported, said in the sheet; on release, the OS's normal sleep delay takes over again
- UI: coffee indicator on the machine row when the inhibition is active (replaces the thread count) — green for the toggle, orange during a turn, TTL (meta style, separated by a “·”) left of the coffee, updated every second (live countdown in the sheet too); on hover/long press the coffee is replaced by the settings button in the same box — the TTL stays put, coffee/settings aligned with the projects' “+”, button hover distinct from the row, labels centered (line-height 1); `views/machine-settings.js` sheet repainted on received `keep_awake`; protocol `set_keep_awake` (logged write) / `keep_awake` (bootstrap + broadcast), simulated by the mock
- Docs: `protocol.md`, `daemon.md`, `client.md`, `limitations.md` (Windows lid, Linux manual sleep, unsupported systems), design `reference/conception-zra-veille.md` — bilingual

## v0.5.4 — 2026-11-21 — HTTPS relay (`5d9583e`)

- `zra-relay/`: optional Node package, no build — serves the PWA and relays `wss://<host>/to/<ip>/ws` → `ws://<ip>:7777/ws`, transparent byte-by-byte pipe (pairing, ping/pong, end-to-end closes); private IPv4 only (RFC 1918 + CGNAT), public/hostname/loopback/link-local refused; request to the machine without `Origin` → nothing to configure on the machines
- HTTPS, two forms: homelab proxy in front (NPM/Caddy, relay in local HTTP) or standalone (`ZRA_RELAY_TLS_CERT`/`KEY`, DNS-01 cert, hot reload, expiry logged); a single HTTPS config, one more machine = its IP
- Client: auto-detection at boot (`GET /zra-relay` marker); relay mode = type an IP, route `/to/<ip>` on the origin, title = alias or IP, subtitle `ws://IP:7777`; adapted diagnostics (502 machine off, 403 address refused, relay unreachable); served elsewhere: direct mode unchanged
- UI: awaiting permission → warning icon in the header (instead of the pulsing dot); “Raw input/output” blocks kept for unhandled events only
- Simplification: `scripts/wireguard.mjs`, QR lib and Tailscale track removed; `deploy.md` rewritten (relay recommended, exposure and security left to the user), architecture/client/README/config examples bilingual; hermetic launcher tests (`ZRA_SHIMMED` leak from the dev shell)
- Real-world validation: LAN pairing through NPM (HTTPS → relay → daemon), public IP 403, relay stopped → daemon independent, relay logs silent; `npm test` green, full i18n (550 daemon texts, 251 client)

## v0.5.3 — 2026-11-21 — Every thread through the shim (`3aff3ff`)

- The original entry of npx agents (`claude-acp`, `pi-acp`, `qwen-code`…) goes through the shim: it stays `registry` — Zed keeps installation and updates — and its `env` carries a node preload (`NODE_OPTIONS --import data:`, percent-encoded) that launches the shim before the agent's code. Every thread, old ones included, becomes drivable: no more lock (`not_zra_thread`) or two families of agents; the `… (zra)` entries of npx agents are removed at install (confirmation)
- Fail-open all the way: ZRA deleted without uninstall, the dynamic import fails, the `catch` swallows it, the agent starts as-is; daemon absent or crashed, the relay continues; repository moved, silent preload (`setup status` reports it). The user's `NODE_OPTIONS` is kept, Zed's `npm install` is unaffected
- Launcher (`zra-shim/launcher.mjs`): spawns the shim around Zed's command, stdio inherit, exit code forwarded, `NODE_OPTIONS` removed from the forwarded env (no cascade to the agent or its node subprocesses), `ZRA_SHIMMED` guard, file-only log
- Surgical env editing (`upsertAgentServerEnv`, `removeAgentServerEnv`): only the env slice changes, the rest of the file stays byte for byte; uninstall restores the original entries' env and removes an entry reduced to `{"type":"registry"}`; binary agents unchanged (`… (zra)` entry alongside, `NODE_OPTIONS` has no effect on a binary)
- Command resolution without the preload or `ZRA_*` (`withoutZraEnv`): the daemon replaying a closed thread and the shim launch the agent without re-preload; shimmed registry entry recognized (`isPreloadEntry`), `wraps` set for the PWA
- Tests: launcher in real processes (real chain, fail-open with launcher/shim absent, double preload, no cascade), byte-identical install→uninstall round-trip, resolution and detection; issue noted: agent errors (`error.data` detail lost, legacy rendering vs Zed's "An Error Happened" callout)
- Doc: `zed.md` lines verified in v1.28.1 (`settings_env` applied last, registry panel Install/Remove), `shim.md` (both cases, launcher), `architecture.md`, `deploy.md`, `limitations.md` (threads of binaries created outside ZRA), README — bilingual

## v0.5.2 — 2026-11-21 — Composer: `/` commands, `@` mentions (`0224107`)

- `/` commands: fuzzy completion menu anchored to the caret (stable ↑↓ navigation, closes on space), description aside, argument hint via the shim; validation on send with an error callout; Escape hides the menu until the next input
- Contenteditable composer: textarea facade, atomic mention chips; the `/` menu and `@` mentions live in the same editor
- `@` mentions: project files and folders, fuzzy menu capped at 100, daemon listing (git, 20,000 cap, 30 s cache); ACP resource/resource_link blocks with a realpath guard, shim in blocks, replay rendering (claude); local echo reconciled, no more phantom duplicate
- Selectable file icon set (default, vendored Colored Zed Dark/Light): `FileIcons::get_icon` port, associations generated from Zed (`npm run file-icons`), setting in the Theme section
- Duplicate windows fixed: always `zed --classic` (MatchExact in 1.28.1); `newWindow` plumbing removed
- UI: 6 px auto-hiding scrollbar with animated fade (Blink), status dot faded under actions, top bar opens global settings + dedicated history reload button, magnifier for read tool calls, thinking blocks aligned at 20 px, 28 px icon-button hitboxes, 6 px bar spacing, no relative time in the top bar
- Docs: Zed/ACP composer sheets, design (`reference/conception-composer.md`), gallery section 14 — bilingual

## v0.5.1 — 2026-11-20 — Threads: rename, delete, push (`1f97b67`)

- Rename and delete over ACP (`session/set_title`, `session/delete`, unstable), gated by the agent's capabilities: the shim issues them for a live thread, a disposable client otherwise — without reopening Zed, never writing to its database (persisted tombstones, agent title overlaid until Zed catches up, `thread-ops.js`)
- Thread list: actions on hover on desktop, on long press on mobile — pencil, error-tinted stop, trash, fade like Zed; inline rename (Enter/Escape), delete with confirmation; buttons hidden when the agent cannot do it
- Agent page: the title is an editable input with no appearance change, the whole title selected on click, size fitted to the text; selection in Zed's light accent blue
- Turn-end push notifications (dependency-free Web Push: VAPID ES256, aes128gcm encryption), only when no connected client is watching the thread; "Notifications (turn end)" setting in the PWA, notification click → the thread
- Docs: ACP sheets (`docs/en/acp.md`), protocol (new messages, gating), client, daemon — bilingual

## v0.5 — 2026-11-20 — Matching Zed's agent panel (`3903bd9`)

- Thread transcript copied from Zed 1.28.1's panel: plain text without bubbles, tool calls as a line or a card, diff without gutter, terminal card (directory, duration, failure), permission inside its own tool call card, plan above the composer, callouts, Zed's braille spinner for the running turn
- Composer and bars: context gauge as a ring, mode and model selectors, “+” present but disabled, bottom bar shared by both screens with Zed's exact icons, thread list as indented rows with worktree bullet
- Free heights as in Zed: reflections (default “auto”), terminal output and raw inputs/outputs with no ceiling
- Themes: eight themes, tokens widened (135), default One dark/light following the browser, first manual choice frozen; language (auto/fr/en) and text size settings
- Zed's fonts embedded: IBM Plex Sans and Lilex (OFL 1.1)
- ACP registry agent icons: the daemon reads Zed's cache
- Behaviours: transcript follow cut at the first gesture and resumed at the bottom, no streaming cursor in the transcript, send disabled on an empty field, thread filter persisted, user messages not editable (ACP agents cannot truncate the transcript)
- MIT licence: `LICENSE` file, mention in both READMEs
- Docs: visual references of Zed's UI (`reference/zed-ui/agent-panel`, `reference/zed-ui/threads-sidebar`, `reference/zed-ui/bottom-bar`), ACP v1 specification read-only (`_upstream/acp`), design sheets (`reference/`)

## v0.4 — 2026-11-19 — Audit, security, Zed conformance (`bd6ca86`)

- Security: markdown XSS fixed, loopback channels, unpaired connections capped, lockable pairing, public networks excluded (network profiles reread each turn)
- Hardening: log rotation, offline queue, shim safety net, explicit Wayland, CI
- Mobile connection: readable diagnosis during retries (machine unreachable, proxy without machine, 403 refusal), delayed reconnection on network recovery, backoff preserved across automatic wakes
- Aligned with Zed 1.28.1: thread index, agent launch (focus returned to the editor), stable/preview/nightly/dev channels; closed threads replayed as Zed launches them (capabilities, project environment), terminal output included
- Shim: resumed and closed sessions tracked, mode and options synced with Zed, permission settled on mobile withdrawn from Zed; agent questions (elicitation) answered from the mobile, as in Zed
- Thread view as in Zed: `session/update`, terminal output, default expansion; permission in its tool call's card, plan above the composer; Stop pauses the queue, "send now"
- Thread list as in Zed's sidebar: turn in progress, pending permission, unread end, sorting, dates and names, empty title as in Zed; sidebar projects and order, the others under "Recent projects"
- French and English: daemon, shim, script and PWA messages; bilingual docs grouped in `docs/`
- Setup: entries named after Zed's registry; licence and `THIRD_PARTY_NOTICES.md`

## v0.3 — 2026-10-19 — Linux port & regression tests (`e752972`)

- Full Linux port: Ubuntu 24.04/GNOME/Wayland (porting machine), Debian 13/KDE/X11, MX Linux 23/Xfce/X11 checked for real
- Unified platform detection, Zed/ZRA paths per OS
- Service backends: systemd --user, XDG autostart
- Keyboard control via xdotool (X11 & XWayland)
- Regression test campaign (764 tests passing)
- Fixed ghost shims (FIN listened to, liveness probe)

## v0.2 — 2026-09-28 — HTTPS & remote access (`ab9d00e`)

- Round 3 validated: HTTPS behind a reverse proxy, port 443 by default
- Remote access via VPN (WireGuard)
- Device pairing on the local network
- Automated deployment (scheduled task, hot TLS reload, on-disk log)
- Compatibility: Node 24, Windows PowerShell 5.1, works anywhere install
- Reliable streaming (mobile desync fixed, backoff + handshake timeout)
- Threads grouped by project, read-only lock, auto-scroll on send
- Clean permissions, visual hierarchy machine/project/thread

## v0.1 — 2026-09-22 — Multi-agent client (`b8e577a`)

- Daemon / shim / client architecture in place
- ZRA protocol, thread index, ACP plumbing
- Installation in Zed, keyboard control
- Threads grouped by project
- Smooth streaming (steady reveal, only the last block repainted)
- Stackable overlays, generic agent settings
