# ZRA — Zed Remote Agent

[Français](https://forgejo.gdelaunay.fr/gdelaunay/zra/src/branch/main/README.md)

Follow and drive [Zed](https://zed.dev)'s [ACP](https://agentclientprotocol.com) agent
threads from your phone: list, live streaming, sending, permissions, new session.
ZRA relays what passes between Zed and the agent as is, and adds what comes from the phone.
To open or reopen a thread, it types on the keyboard in Zed (see [Security](#security)).

**Status**: version 0.3. Checked on Windows 11 and on three Linux machines
(Ubuntu/GNOME/Wayland, Debian/KDE/X11, MX Linux/Xfce/X11), with an Android phone.

**Language**: French or English. The PWA follows the browser language; the daemon,
the shim and the scripts follow `ZRA_LANG=fr` or `ZRA_LANG=en`, otherwise the system
language. English if it is not French.

## Quick start

**Prerequisites**: Zed (native install — Flatpak/Snap not supported, see
`docs/en/limitations.md`), Node ≥ 24.

**Linux prerequisites**: `xdotool` — `sudo apt install xdotool`. Under Wayland,
keyboard control requires Zed under XWayland: `npm run setup -- xwayland --apply`
(separate step, edits the Zed `.desktop`, backed up).

0. `git clone https://forgejo.gdelaunay.fr/gdelaunay/zra.git && cd zra` — no
   `npm install` needed to use it.
1. `npm run setup install apply`. Each Zed agent gets a ZRA entry
   (`Claude Agent (zra)`…): the original agent is left untouched. Threads opened
   with a ZRA entry will no longer reopen in Zed if ZRA is uninstalled.
2. `npm run daemon`. The daemon shows its address (`http://192.168.x.x:7777`)
   and a pairing code.
3. On the phone, same Wi-Fi: open this address, then enter the code.
   If the page does not load: firewall and network profile (`docs/en/deploy.md` §1).
4. In Zed, open a thread with the **… (zra)** agent (`Claude Agent (zra)`): it is
   `live` on the phone. Threads of other agents can be read there, but not
   written to once closed.

Next: automatic startup (`npm run service -- install --apply`),
remote access, HTTPS and troubleshooting (`docs/en/deploy.md`).

## Uninstall

1. `npm run service -- stop`, then `npm run service -- uninstall --apply`:
   stops the daemon and removes automatic startup.
2. `npm run setup -- uninstall --apply`: removes the ZRA entries and their
   shortcuts in Zed (and the XWayland override on Linux), with a backup.
3. Delete `.zra/` and the `zra` folder in `%LOCALAPPDATA%` (Linux
   `~/.local/state/zra/`): logs, paired devices, prompts.

Threads created with a ZRA entry (`Claude Agent (zra)`…) stay in the Zed list,
but with no agent to reopen them.

## Security

- **A paired device means access to the machine**: its prompts make the agent
  run commands, within the agent's permissions. Remove a
  device: `npm run pair -- revoke <id>`.
- **Trusted local network** (home): this is ZRA's assumption. The daemon
  never listens on a network marked "Public" by Windows; on Linux,
  restrict it with `lanCidrs` in `zra.config.json`.
- **Plain-text traffic** over HTTP: token and conversations can be read by anyone
  listening on the network. Away from home: tunnel or HTTPS (`docs/en/deploy.md` §3-4).
- **Pairing**: 6-digit code, single use, locked after 10 failed
  attempts; `npm run pair` reopens it with a new code.
- **Loopback** exempt from pairing, except for a request relayed by a local proxy
  (detected); `"auth": { "exemptLoopback": false }` to remove the exemption.
- **Keyboard control** (enabled by default, warned at startup): opening or
  reopening a thread sends real keystrokes to Zed (PowerShell on Windows,
  `xdotool` on Linux). The window is checked, not the focused field, and the
  keyboard is taken over for a few seconds. After a Zed update, check the
  recipes (`npm run zed -- try <recipe>`). `"zedControl": { "enabled": false }`
  forbids it: the "+" and reopening closed threads become
  unavailable.

## What ZRA writes to disk

| Where | What |
|---|---|
| `.zra/auth.json` | paired devices (hashed tokens) |
| `.zra/logs/` | daemon and shim logs |
| `.zra/backups/` | backups of Zed's `settings.json` and `keymap.json` before each write |
| `injections.log` (`%LOCALAPPDATA%\zra\`, Linux `~/.local/state/zra/`) | **every prompt sent from the phone**, in plain text (rotated at 5 MB) |
| `.zra/records/` | only with `npm run setup -- install --record` (debugging): **every ACP frame**, full conversations, in plain text, purged after 14 days |

`.zra/` is ignored by Git; do not share it with the project folder.

## Commands and docs

| Folder | Role |
|---|---|
| `zra-shim/` | wraps the agent in Zed (`Claude Agent (zra)` entry), observes and injects over ACP |
| `zra-daemon/` | the machine's WebSocket server: thread index, routing, pairing, Zed keyboard control |
| `zra-client/` | build-free PWA, served by the daemon or by any static server |
| `scripts/` | installation, service, pairing, certificate, keyboard tuning |
| `i18n/` | English translation of the daemon, shim and script messages (`en.json`, keys: the French text in the code); the PWA's: `zra-client/js/en.js` |

```sh
npm run setup                        # status: Zed entries, agents, daemon
npm run setup install apply          # one ZRA entry per Zed agent (Claude Agent (zra), Qwen Code (zra)…) + its "new thread" key
npm run setup -- uninstall --apply   # removes the ZRA entries from Zed
npm run daemon                       # shows the address and the pairing code
npm run daemon:dev                   # loopback only
npm run service -- install --apply   # start at session login (start, stop, logs, uninstall)
npm run pair                         # pairing code, paired devices (revoke <id>)
npm run zed -- probe | recipes | try <recipe> [--apply]   # keyboard control
npm run probe:agent <agent>          # handshake with an agent, through the shim
npm run mock                         # stub daemon, for the PWA without Zed
npm test                             # npm install first (jsdom, for the PWA tests); also checks the translations
```

Configuration: copy `zra.config.example.en.json` (commented) to `zra.config.json`
at the root — read by the daemon and the shim, never committed (specific to each machine).

| Doc | Content |
|---|---|
| `docs/en/architecture.md` | the map: components, exchanges, flows, weak spots, decisions |
| `docs/en/deploy.md` | setting up the phone: local network, tunnel, HTTPS, service |
| `docs/en/protocol.md` | PWA ↔ daemon protocol |
| `docs/en/daemon.md`, `docs/en/shim.md`, `docs/en/client.md` | one component each: role, files, tests |
| `docs/en/limitations.md` | what is not supported, and why |
| `docs/en/zed.md` | mapping to Zed: dependencies, sources to check, interface audit |

Working files, at the root, in French: `ROADMAP.md` (upcoming versions, ideas) and
`ISSUES.md` (open issues). Third-party content and its licenses:
`THIRD_PARTY_NOTICES.md`.

---

Developed with Opus 5.5 in Claude Code, and Qwen3.8-Max / Qwen3.8-Flash in Pi,
with minimal review.
