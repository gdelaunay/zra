# Changelog

[Français](https://forgejo.gdelaunay.fr/gdelaunay/zra/src/branch/main/CHANGELOG.md)

## v0.4 — in progress — Audit, security, Zed conformance

- Security: markdown XSS fixed, loopback channels, unpaired connections capped, lockable pairing, public networks excluded
- Hardening: log rotation, offline queue, shim safety net, explicit Wayland, CI
- Aligned with Zed 1.28.1: thread index, agent launch, stable/preview/nightly/dev channels
- Shim: resumed and closed sessions tracked, mode and options synced with Zed, permission settled on mobile withdrawn from Zed
- Thread view as in Zed: `session/update`, terminal output, default expansion; permission in its tool call's card, plan above the composer; Stop pauses the queue, "send now"
- Thread list as in Zed's sidebar: turn in progress, pending permission, unread end, sorting, dates and names; sidebar projects and order, the others under "Recent projects"
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
