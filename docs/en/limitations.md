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
