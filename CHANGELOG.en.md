# Changelog

[Français](https://forgejo.gdelaunay.fr/gdelaunay/zra/src/branch/main/CHANGELOG.md)

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
- Docs: visual references of Zed's UI (`reference/zed-agent-panel`, `reference/zed-threads-sidebar`, `reference/zed-bottom-bar`), ACP v1 specification read-only (`_upstream/acp`), design sheets (`reference/`)

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
