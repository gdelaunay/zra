# ZRA — known limitations

What is not supported, knowingly. Each section says why
and what it would take to lift the limit if the need arises.

## Zed via Flatpak / Snap

**Decision: explicitly not supported at release.** Native install
only (README, docs/en/deploy.md §6); clear message at setup if Zed
cannot be found. Escape hatch for advanced users: `zedDb`/`zedSettings`
in `zra.config.json`.

`zedPaths()` returns the usual XDG paths (`~/.local/share/zed`,
`~/.config/zed`). Under Flatpak (`~/.var/app/dev.zed.Zed/…`) or Snap
(`~/snap/zed-editor/current/…`), index, settings and registry cannot be found,
and `findZedDesktop()` does not find the `.desktop` to patch.
→ Lead if Flatpak/Snap users show up: measure the real
paths, add them as candidates in `zedPaths()`, launch through `flatpak run` /
`snap run`, validate on real installs (Flatpak first, the
most common case).

## Native Wayland, without forced XWayland

`createKeyboard()` only returns `xdotool` or `none` (no `ydotool`/`wtype`). Without the `WAYLAND_DISPLAY=` patch of the `.desktop`, no
keyboard backend → no opening threads nor `submit` from the PWA.
Reading, `acp` injection and permissions still work (through the shim).
→ XWayland forced through the patched `.desktop` **is** the supported way; no
going back to `ydotool`/`wtype` (`uinput` permissions, fragility per compositor).

## WSL2

Never run. systemd is not always init, WSLg provides X11/Wayland but `xdotool`
there targets an X server where the Zed window may be missing, and without a desktop nothing
reads `~/.config/autostart`.
→ Measure everything, if the need arises.

## Untried distros (Fedora, Arch, openSUSE)

Node ≥ 24 to install by hand (distro Node versions are older); `xdotool`
is a standard package everywhere. Pure Node code, no native dependency, XDG
paths: no effect expected.
→ `npm install && npm test`, then "Checking a machine" in `docs/en/architecture.md`.

## Custom window title

The driver recognizes a project's window by the start of its title: the name
of the first folder, followed by a space, a comma or nothing (Zed's default
format, `${projectName}${separator}${fileName}`). With a `window_title_format`
that does not start with `${projectName}`, or a `window_title_separator` that
does not start with a space, the window is no longer found: no thread opening
and no `submit` from the PWA.
→ If the need arises: read these settings from `settings.json` and derive the
title pattern from them.

## Agent questions outside a thread

An agent question (ACP elicitation) tied to a Zed request that belongs to no
thread — while a session is being created (`session/new`) or the agent is
signing in (`authenticate`) — only shows in Zed: on the mobile side, there is
no thread yet to show it in, nor a thread to warn in.
→ Way forward if the case comes up: a machine-level card in the thread list.

## Replay without MCP servers

To show the history of a closed thread, the daemon relaunches the agent as Zed
does (capabilities, project environment), but passes no MCP server to
`session/load`. The history is replayed from the transcript: past MCP calls
are in it (title, input, result) without any server running. Starting them
each time an old thread is opened would cost several seconds, and a requested
OAuth sign-in would go unanswered. Parity would be partial anyway: Zed adds
the servers of its extensions, which the daemon does not see.
→ To revisit only if an agent cannot replay without its MCP servers.

## Turn started from mobile: Zed thinks it is idle

With the `acp` injection backend (default), the mobile prompt is injected
straight into the agent by the shim: Zed did not submit it itself. Yet its
activity indicator (`AcpThread::status`) only tracks its own `session/prompt`
(`running_turn`); in ACP v1 the agent does not report its activity. As far as
Zed is concerned the thread stays idle: no generation indicator nor Stop
button, and nothing prevents sending a prompt in parallel. The response still
shows normally.
→ Workaround: the `uia` backend (or `auto`, `config.injection`) types the mobile
text into Zed, which then submits the prompt and tracks the turn (indicator,
Stop, queue). Experimental and fragile (focus, fuzzy sidebar filter; requires
`zedControl.enabled`).
→ Clean fix: ACP v2, where the agent reports its activity — behind a beta flag
in Zed 1.28.1, not the default.

## Threads unloaded by Zed without `session/close`

Zed only sends `session/close` to agents that declare
`session_capabilities.close` (`agent_servers/src/acp/v1.rs`, `release_session`).
The others (pi-acp, qwen-code) are unloaded silently to free memory: the shim
receives nothing, the daemon keeps the thread `live`, a green dot on the PWA
even though Zed released the session. opencode declares the capability and
does receive its `session/close`.
→ A gap with no notable consequence in use: when returning to the thread, Zed
emits `session/load` and the daemon follows it. Fixing it (inferring the unload
from an unexpected `session/load`) would be hacky for little gain; accepted as
is.

## Reopening a thread with a non-unique title

The `openThread` recipe filters Zed's sidebar by the thread title then opens
the first result. The filter is fuzzy (`fuzzy_match_positions`) and `enter`
opens the first thread in the window's group order
(`crates/sidebar/src/sidebar.rs`, `rebuild_contents`, `select_first_entry`).
When several threads share the same title — the case of agents that do not
name their threads, all at the default title "New Agent Thread" — the right
thread cannot be distinguished: another one may open. ZRA waits for the target
session and fails cleanly after 30 s, but an agent was launched for nothing.
Zed 1.28.1 offers no action or URL to open a thread by identifier
(`zed://agent` only opens the panel, `parse_agent_url`).
→ No reliable workaround in Zed 1.28.1. Will be addressed with thread renaming
(a unique title per thread lifts the filter ambiguity), if that path is
possible. The focus toggle, however, is fixed (`FocusCenterPane`, `openThread`
recipe).

## Mobile background tab freeze (OS)

**Decision: accepted, structural.** On mobile, the OS freezes background tabs:
the browser closes the socket (code 1001 "going away") or throttles timers —
the daemon then sees a TCP drop without a code, or a silent peer cut at 75 s.
The PWA reconnects on return to the foreground. Network transitions
(Wi-Fi ↔ cellular, VPN tunnel coming up) cause a few fast failures before the
path is usable; the backoff absorbs them and the HTTP diagnostic (protocol §1)
says what is blocking.
→ Nothing to fix on the ZRA side: the behavior comes from the OS and the
network. If the discomfort persists: measure on a real device with the `[link]`
logs (browser console, debug level).

## @ mentions: files and folders only

**Decision: accepted, 0.5.2 scope.** Mentions only cover project files and
folders — not Zed's symbols, threads, fetch, skills, diagnostics. Assumed
consequences (design D1, agent matrix in `docs/en/acp.md`):

- **Folders: best effort** depending on the agent — claude/pi list via their
  tools, qwen/gemini read recursively, goose keeps metadata (recent) or
  dropped it (before 09/2026).
- **Binary / non-UTF-8 / > 1 MB**: `resource_link` only, no image sending;
  the agent reads it itself if it can.
- **Fuzzy**: subsequence approximation on the PWA side (cap 100), not Zed's
  algorithm (`match_path_sets`); no "recently opened first".
- **Listing outside git**: `node_modules` excluded (Zed would scan it, it is
  usually gitignored); empty folders absent (git lists files only, folders
  deduced from paths).
- **Icons**: generic file/folder on the PWA side, not per extension like Zed
  (`file_icons`).
- **Keyboard fallback** (`uia` backend, agent having refused ACP injection):
  the text goes as-is into Zed's composer — mention links stay literal there,
  not converted to chips.
