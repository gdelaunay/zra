# Changelog

[Français](https://forgejo.gdelaunay.fr/gdelaunay/zra/src/branch/main/CHANGELOG.md)

## In progress

- Thread list: projects follow Zed's sidebar (all windows, in its order, even without threads); the others under "Recent projects"

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
