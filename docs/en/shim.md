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
| `framing.js` | JSON Lines splitting that preserves the bytes |
| `proxy.js` | relay from one stream to the other, fail-open |
| `acp.js` | everything the shim *understands*: sessions, turn, permissions, terminals, injection (`sendPrompt` in ACP blocks — mentions included) |
| `queue.js` | turn / queue / options state machine per session; the queue keeps the text (display) and the blocks parsed at departure (sending) |
| `daemon-link.js` | local link to the daemon, best-effort, backoff, bounded buffer |
| `record.js` | `ZRA_RECORD=1` — every frame as JSONL |
| `log.js` | log, **stderr only** |

## Plugging it into Zed

```bash
npm run setup install              # shows the entries, writes nothing (named agents: install qwen-code pi-acp)
npm run setup install apply        # adds them (backup in .zra/backups/); asks before renaming an existing entry ("yes" to skip)
npm run setup -- uninstall --apply # removes them, and only them
```

Per agent, **one more** `custom` entry in Zed's `settings.json`, and its
"new thread" key in `keymap.json`. The original
agent is left untouched. The shim then finds the real agent on its own, from
its `id` in Zed's registry. Zed displays the entry's key: `setup` names it after the agent's name in its registry, followed by `(zra)`. What `setup` sets, in essence:

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
