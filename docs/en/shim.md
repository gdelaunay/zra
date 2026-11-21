# zra-shim

Transparent stdio proxy between Zed and an ACP agent. Zed launches it
instead of the agent; it relays the bytes both ways, observes a
copy, and talks to the local daemon.

```
Zed  ──stdio──►  zra-shim  ──stdio──►  ACP agent
                    │
                    └── ws://127.0.0.1:7777/shim ──► zra-daemon
```

## The three rules

1. **Byte relay.** What goes out is the slice of bytes that came in, never a
   re-serialization: nothing lost on an unknown field or a protocol
   change. `framing.js` splits, `proxy.js` carries, `acp.js` observes.
2. **Absolute fail-open.** Daemon unreachable, crashed or slow ⇒ the shim stays a
   perfectly transparent pipe. No I/O to the daemon is blocking,
   no ZRA error interrupts the relay. ZRA never breaks Zed.
3. **stdout is sacred.** It is the ACP channel: the log goes to stderr, which
   Zed collects anyway (`log.js`).

## The two exceptions to the full relay

They are local, deliberate, and both in `acp.js`:

| Frame swallowed | Why |
|---|---|
| Zed's **late** answer to a permission already settled, or a question already answered, from the phone | two answers for the same JSON-RPC `id` would confuse the agent |
| the agent's answers to the requests **injected by ZRA** (`id` as `zra-N`) | Zed never sent them; they do not concern it |

The `zra-N` id space is textual: no possible collision with Zed's
numbering, even if it uses the same integers.

## Files

| File | Role |
|---|---|
| `index.js` | entry: agent resolution, spawn, wiring, lifecycle |
| `launcher.mjs` | preload shell (registry entry shimmed via env): spawns the shim around the command Zed was about to launch, fail-open |
| `framing.js` | JSON Lines splitting that preserves the bytes |
| `proxy.js` | relay from one stream to the other, fail-open |
| `acp.js` | everything the shim *understands*: sessions, turn, permissions, terminals, injection (`sendPrompt` in ACP blocks — mentions included) |
| `queue.js` | turn / queue / options state machine per session; the queue keeps the text (display) and the blocks parsed at departure (sending) |
| `daemon-link.js` | local link to the daemon, best-effort, backoff, bounded buffer |
| `record.js` | `ZRA_RECORD=1` — every frame as JSONL |
| `log.js` | log, **stderr only** |

## Plugging it into Zed

```bash
npm run setup install              # shows what would be written, writes nothing (named agents: install qwen-code pi-acp)
npm run setup install apply        # applies it (backup in .zra/backups/); confirmation before renaming or removing an existing entry ("yes" to skip)
npm run setup -- uninstall --apply # removes ZRA's env from the original entries and the "… (zra)" entries
```

Two cases, depending on the agent's distribution in Zed's registry:

**npx agent (run by node)** — the original entry itself goes through the shim.
It stays `type: registry`: Zed keeps installing and updating the agent, and its
`env` carries a node preload that launches the shim before the agent's code.
Every thread of that agent, old ones included, is drivable; a single family of
agents. The custom "… (zra)" entry from a previous install is removed
(confirmation: its threads no longer reopen).

```jsonc
"agent_servers": {
  "claude-acp": {
    "type": "registry",
    "env": {
      "NODE_OPTIONS": "--import data:text/javascript,try%7Bawait%20import('file%3A%2F%2F%2FC%3A%2F…%2Fzra-shim%2Flauncher.mjs')%7Dcatch%7B%7D",
      "ZRA_AGENT_ID": "claude-acp"
    }
  }
}
```

The payload is the loader's code, percent-encoded into the variable itself:
`try { await import('file:///C:/…/zra-shim/launcher.mjs') } catch {}`. No raw
space or quote (the `NODE_OPTIONS` tokenizer breaks on them), no file
dependency at parse time: ZRA deleted without uninstall, the dynamic import
fails, the `catch` swallows it, the agent starts without ZRA. A `NODE_OPTIONS`
already there (the user's) is kept after ours. The launcher spawns the shim
(`index.js -- <node> <agent binary> …args`), removes `NODE_OPTIONS` from the
forwarded env — no re-preload cascade to the agent or its node subprocesses —
and exits with the child's code. The daemon relaunching the agent to replay a
closed thread resolves the command **without** the preload or the `ZRA_*`
(`withoutZraEnv`): the replay does not connect as a live shim.

**Binary agent (non-node)** — `NODE_OPTIONS` has no effect: one more `custom`
"… (zra)" entry in `agent_servers`, as before. Zed displays the entry's key:
`setup` names it after the agent's name in its registry, followed by `(zra)`.
What `setup` sets, in essence:

```json
"agent_servers": {
  "Claude Agent (zra)": {
    "type": "custom",
    "command": "node",
    "args": ["C:/path/to/zra/zra-shim/index.js"],
    "env": { "ZRA_AGENT_ID": "claude-acp" }
  }
}
```

In both cases, one "new thread" key per shimmed entry in `keymap.json` (the
original agent's id for the preload, the "… (zra)" key for the binary). The
shim then finds the real agent on its own, from its `id` in Zed's registry.

Clean removal is `uninstall`: it restores the original entries' env and removes
the "… (zra)" entries; a registry entry reduced to `{"type":"registry"}`
(nothing else was in it) is removed too. Zed's "Agent Registry" panel can
regenerate a clean entry (Remove/Install).

The wrapped agent is designated, in order of priority:

1. after `--`: `node zra-shim/index.js -- node my-agent.js`;
2. `ZRA_AGENT_COMMAND` (+ `ZRA_AGENT_ARGS`, JSON array or space-separated
   arguments);
3. `ZRA_AGENT_ID`, resolved as Zed does — `agentCommands` in
   `zra.config.json`, then a `custom` entry in `settings.json`, then the
   Zed registry (`%LOCALAPPDATA%\Zed\external_agents\registry`).

> On the target machine, both agents are of type `registry`: their command
> is written nowhere in `settings.json`, and it is indeed the registry that
> provides it (`zra-daemon/agent-commands.js`).

## Environment variables

| | |
|---|---|
| `ZRA_AGENT_ID` | id of the agent to wrap, as Zed names it |
| `ZRA_SHIMMED` | set by the launcher in the shim's env: guard against double wrapping; `NODE_OPTIONS` is removed from that same env |
| `ZRA_AGENT_COMMAND`, `ZRA_AGENT_ARGS` | explicit command, takes priority over the registry |
| `ZRA_DAEMON_URL` | default `ws://127.0.0.1:<port>/shim` |
| `ZRA_DAEMON_PORT` | daemon port if the URL is not given (default 7777) |
| `ZRA_TURN_TIMEOUT_MS` | agent silence beyond which an in-flight turn is closed by force (`turnTimeoutMs` in `zra.config.json`, default 600000) |
| `ZRA_RECORD=1` | dumps every frame into `%LOCALAPPDATA%\zra\records\*.jsonl` (JSONL older than 14 days purged at startup) |
| `ZRA_RECORD_DIR` | where to write these recordings |
| `ZRA_LOG_LEVEL` | `debug` `info` `warn` `error` |
| `ZRA_LOG_FILE` | also writes the log to this file (`setup`: `.zra/logs/shim.log`) |
| `ZRA_LANG` | language of the messages, `fr` or `en` (default: the system language) |

`npm run setup -- install --record` enables `ZRA_RECORD` to `.zra/records/`.
A debugging tool, disabled by default: it is the only way to see what Zed
and the agent really tell each other, and a recorded session becomes a
regression fixture — but full conversations are written in plain text.

## Tests

```bash
node --test zra-shim/test/shim.test.mjs
node --test zra-shim/test/launcher.test.mjs   # preload: real chain, fail-open, no cascade
npm run probe:agent claude-acp    # against the real agent, without opening a session
```

`probe:agent` launches the real agent through the shim and only does an
`initialize`: command resolution, handshake transparency
and announced capabilities (including `loadSession`) at a glance.
It is the first step of checking a machine (`docs/en/architecture.md`, "Checking a machine").

The shim is mounted between a fake Zed (`test/fake-zed.mjs`) and a
stub ACP agent (`test/fake-agent.mjs`) that speaks the real
protocol over stdio and plays scripted scenarios — streamed text, diff,
terminal, permission, cancellable long turn, silent agent (`muet: …`: it accepts the
prompt then goes quiet, and never acknowledges `session/cancel` — the failure that
gave rise to force-closing).
