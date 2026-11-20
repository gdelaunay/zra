# Changelog

[Français](https://forgejo.gdelaunay.fr/gdelaunay/zra/src/branch/main/CHANGELOG.md)

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
