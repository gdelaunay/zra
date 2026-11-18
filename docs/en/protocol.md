# ZRA — PWA ↔ daemon technical contract

This document is **enough to write `zra-daemon` without reading the PWA code**.
It describes the only point of contact between the two: a JSON WebSocket on `:7777`.

- `docs/en/architecture.md` says *why* and *how* on the machine side (shim, SQLite index, injection).
- This document says *exactly what* goes over the wire, and what the front end does with
  each message.
- Executable reference implementation: `zra-client/tools/mock-server.mjs` +
  `zra-client/js/mock/mock-link.js`. What they do is, by construction, what
  the PWA expects — the tests in `zra-client/test/mock-daemon.test.mjs` lock
  this behavior.
- Real implementation: `zra-daemon/`, with `zra-daemon/test/protocol.test.mjs`
  as the compliance suite (§8).

Status: **v1**. Any change here must be carried over to the stub.

---

## 1. Transport

| | |
|---|---|
| API | a single WebSocket: `ws://<host>:7777/ws`, or `wss://` if the daemon has a certificate |
| Static files | the daemon serves `zra-client/` as is on `GET http://<host>:7777/` (`serveStatic: false` to serve it elsewhere) |
| Listening | `127.0.0.1` + local network + optional tunnel, **never** `0.0.0.0` |
| Origin | strict allowlist on the handshake; a request without `Origin` is accepted |
| Auth | pairing outside loopback: `hello.token`, otherwise `auth_required` then `pair` (§3) |
| Encoding | UTF-8 JSON, one text WebSocket frame = one message |

**Client and daemon are decoupled.** The browser downloads the static files from
any host, then opens the WebSocket **directly** to each machine
through the tunnel: nothing goes through the host. Consequences for the
daemon:

- it cannot assume that the page's origin is its own;
- it must declare the legitimate origins (`allowedOrigins`), otherwise the
  browser — which does not apply the same-origin policy to WebSockets — lets
  any page in the tunnel drive the machine;
- if the client is served over HTTPS, the daemon **must** offer `wss://`: an
  `https://` page is forbidden from opening a `ws://` (mixed content).

**MIME types** to serve correctly when static files are enabled, otherwise the
modules do not load: `.js → text/javascript`, `.css → text/css`,
`.webmanifest → application/manifest+json`, `.svg → image/svg+xml`.

### Connection lifecycle

1. The PWA opens the WS and sends `hello` immediately.
2. The daemon answers `machine`, then `threads`, then one `thread_state` per known
   thread. This trio is the **bootstrap**; the PWA shows nothing until it has
   arrived.
3. On any drop, the PWA reconnects with backoff (1 s → 30 s, then a 60 s
   plateau, jitter), and a WS handshake that drags on is abandoned after 15 s. On
   reconnection it sends `hello` again, then `list_threads`, then a `subscribe`
   and a `load_history` for each thread it had open: what
   happened during the drop is not replayed any other way.
4. Every 15 s, and on return to the foreground, the PWA sends `ping`. Without
   any frame in return (6 s, 3 s in the foreground), it holds the connection
   as dead and reconnects: on mobile, a socket can stay open without
   anything getting through anymore. Sends wait for the answer to this `ping`.
5. The daemon **drops a client that does not read**: if the socket's write buffer
   exceeds its high-water mark (4 MB) and the client does not drain it, the
   connection is destroyed rather than inflating the daemon's memory. On the PWA side,
   it is an ordinary drop: reconnection + `subscribe`, point 3.
6. The daemon **probes the liveness of each connection**: an RFC 6455 PING every
   20 s, and a connection is closed after 75 s without any sign from the peer. Every
   WebSocket client answers PING by itself, at protocol level — the PWA has
   nothing to do, and the application `ping` of point 4 remains its own safeguard.
   Without this probe, a peer gone without closing (phone asleep, tunnel cut,
   shim killed by Zed) leaves a dead connection in the registry: that was the
   ghost shims bug.

> **The daemon keeps no per-client state.** A returning client must
> be able to rebuild everything with `hello` + `list_threads` + `subscribe`.

Messages sent while the socket is down are **queued on the PWA side**
and replayed on reconnection (except `hello`). The daemon must therefore tolerate a
`subscribe` or a `send` arriving a second time: see §6 (idempotence).

---

## 2. Message shape

```ts
type Message = { type: string } & Record<string, unknown>
```

Rules:

- `type` is the only discriminant. A message of unknown type is **ignored and
  logged** by the PWA, never fatal. The daemon must do the same: adding a
  message to the protocol must never break the other end.
- Unknown fields: kept, never rejected.
- `threadId` is **the ZRA identifier of a thread**: the hexadecimal of the
  `sidebar_threads.thread_id` BLOB. It is stable over time and serves as a key everywhere.
  The ACP `session_id` stays internal to the daemon — the PWA never sees it.
- Dates are ISO 8601 strings. The PWA also tolerates the SQLite format
  `YYYY-MM-DD HH:MM:SS` (interpreted as UTC).

---

## 3. Phone → daemon

### `hello`
```ts
{ type: 'hello', clientId: string, token?: string }
```
First message. `clientId` is a stable identifier stored in `localStorage`
(useful for logs and, later, Web Push). The daemon answers with the bootstrap —
or, for a client outside loopback without a valid token, `auth_required`.

### `pair`
```ts
{ type: 'pair', code: string, label?: string }
```
Pairing: `code` is the one the daemon shows (6 digits,
spaces tolerated), `label` names the device ("Android · Chrome"). Answer:
`paired` then the bootstrap, or `error` `pair_failed` (wrong code) /
`pair_locked` (too many attempts from this address, the message says when to
try again; or 10 failures in total, across all devices: pairing
locked until `npm run pair` on the machine).

**Before pairing**, the daemon ignores everything except `hello` and `pair`, without
answering (the queue replayed by the PWA on connection does not produce a burst
of errors), and sends no broadcast. Loopback is exempt.

### `ping`

```ts
{ type: 'ping' }
```

Heartbeat (§1). The daemon answers `{ type: 'pong' }`, paired or not, with nothing
else.

### `list_threads`
```ts
{ type: 'list_threads' }
```
Asks for a full refresh. The daemon answers `threads`. Sent at
bootstrap, on reconnection, on return to the foreground and on the
"refresh" button.

### `subscribe` / `unsubscribe`
```ts
{ type: 'subscribe', threadId: string, since?: number }
{ type: 'unsubscribe', threadId: string }
```
Subscription to a thread's stream. After `subscribe`, the daemon sends:

1. the current `thread_state` (mandatory);
2. the content of this thread's **ring buffer** (2000 events max), as
   `acp_event`s, in order;
3. then the real-time events.

`since`: the PWA comes back to a thread whose timeline it already has, up to date
until this `seq`. The daemon then only sends the ring events
after it. If it has lost some since (ring evicted, session reloaded by Zed,
daemon restarted), it sends a `history` instead, as for
`load_history`: the PWA starts again from there.

`unsubscribe` is sent when the user leaves the screen. The daemon may
keep buffering, it must no longer push.

### `load_history`
```ts
{ type: 'load_history', threadId: string }
```
Asks for the full replay (`session/load`, §5.2). Answer: `history`, or
`error`. Costly operation: the PWA only calls it when opening a thread
and on the explicit "reload history" action.

### `send`
```ts
{ type: 'send', threadId: string, text: string, mode: 'queue' | 'interrupt' }
```
- `queue`: if the turn is `busy`, queue it (→ `thread_state.queue`);
  otherwise send right away.
- `interrupt`: `session/cancel`, wait for the acknowledgment, **then** send.

`text` is **always** treated as an agent prompt. Never any shell
interpolation, never any `eval` (§9).

The PWA shows the message immediately (optimistic local echo). If the agent
replays it as `user_message_chunk`, the echo is removed to avoid the duplicate: the
daemon has nothing to do for that, but **must not rewrite the text**.

### `interrupt`
```ts
{ type: 'interrupt', threadId: string }
```
Cut the current turn **without sending anything** (`session/cancel` alone). It is what
the Stop button does when the queue is empty — the text being typed on the
phone is never sent by Stop. If the turn is already `idle`, do nothing.
Then emit `thread_state` with `turn: 'idle'` and, ideally, a
`zra/notice` "turn interrupted".

`turn: 'idle'` is due **even if the agent does not acknowledge** the `session/cancel`: the
turn is then closed by force and the notice says what really happened rather
than "turn interrupted" (§5). Without that, Stop would show an
interruption on a loading that never ends.

### `cancel_queued`
```ts
{ type: 'cancel_queued', threadId: string, queueId: string }
```
Removes an entry from the queue. Answer: updated `thread_state`. Unknown `queueId`
⇒ silently ignore (the queue may have gone out in the meantime).

### `set_option`
```ts
{ type: 'set_option', threadId: string, key: 'mode' | 'model' | string, value: string | boolean }
```
Changes an ACP session option. Same queue constraints as a message: if the
turn is in progress, apply at the end. Answer: updated `thread_state`, and — if
the agent emits it — the corresponding `acp_event` (`current_mode_update`).

### `respond_permission`
```ts
{ type: 'respond_permission', threadId: string, requestId: string, optionId: string }
```
Answers a permission request (§6.6). `requestId` is the one carried by
the request's `acp_event`; `optionId` comes from the agent's `options`, the PWA does not
make it up. Possible answers:

- `permission_resolved` with `by: 'mobile'` — the answer was passed on;
- `permission_resolved` with `by: 'desktop'` — the machine had already settled it;
- `error` `permission_expired` — unknown or too late request.

### `new_thread`
```ts
{ type: 'new_thread', agentId: string, folderPaths?: string[] }
```
Opens a new agent session on this machine (§6.7). Answer: updated `threads`
then `thread_created`, or `error` `new_thread_failed` (30 s timeout).

`folderPaths`: the project to open it in — the `folderPaths` of an existing thread,
compared ignoring case and separators. The daemon refuses (`new_thread_failed`)
folders that no thread in its index uses: the phone only makes Zed open
what Zed has already opened. Absent ⇒ the active Zed window.

### `zra/trigger` *(stub mode only)*
```ts
{ type: 'zra/trigger', name: string, threadId?: string }
```
Scenario trigger, used by the PWA's mock bar. **A real daemon
must answer `error` `unknown_message`** — that is precisely what tells the
two apart, and the mock bar only shows if `machine.version` ends with
`-mock`.

---

## 4. Daemon → phone

### `auth_required` / `paired`
```ts
{ type: 'auth_required', name: string, reason?: string | null }
{ type: 'paired', token: string, clientId: string }
```
`auth_required`: this client must pair — `name` to display it, `reason`
if a token was presented and refused (revoked); the PWA then forgets this token.
`paired`: the token to keep and present in each `hello`; `clientId` is
the device's identifier on the machine side (`npm run pair -- revoke <id>`).
Once revoked, a device has its connection closed (code 4401).

### `machine`
```ts
{
  type: 'machine',
  name: string,            // machine name, shown at the top of the group
  os?: string,
  zedRunning?: boolean,    // false => "Zed closed" banner
  version?: string,        // `-mock` suffix => the PWA enables its dev bar
  agents?: Array<{ id: string, name?: string }>,  // agent_servers registry
  urls?: string[],         // the machine's addresses outside loopback (local IPs, or certificate names)
}
```
Sent at bootstrap, and on every notable change (Zed started/closed).
`agents` feeds the **+** button menu. Absent ⇒ the PWA infers the agents from
existing threads.

### `threads`
```ts
{ type: 'threads', threads: ThreadSummary[] }

type ThreadSummary = {
  threadId: string          // hex of the sidebar_threads.thread_id BLOB
  sessionId: string | null
  agentId: string | null    // "claude-acp", … — used to pick the icon
  title: string             // title_override ?? title, read like Zed (empty or "New Agent Thread": absent); '' if absent
  titleOverridden?: boolean // renamed in Zed: takes precedence over the title announced by the agent
  folderPaths: string[]     // decoded UTF-8, any separators, in Zed's display order (folder_paths_order)
  updatedAt: string
  createdAt?: string | null // informative, the PWA does not use it in v1
  archived: boolean
  remote?: boolean          // remote project (SSH, WSL: remote_connection)
  state: 'live' | 'closed' | 'unknown'
  projectOpen?: boolean | null // thread's project open in a Zed window; null: unknown
}
```
**Full list every time**, not a delta: the PWA replaces. To send at
bootstrap, on `list_threads`, and spontaneously when the index changes (2 s poll on
`updated_at`) or a shim appears/disappears.

`state`: `live` = a shim is connected for this `session_id`; `closed` = known
to the index without a shim; `unknown` = NULL `session_id` (Zed draft). Like Zed's
sidebar, the PWA lists neither drafts, nor threads without `agentId` (Zed's
native agent, unreadable over ACP), nor `remote` ones.

`projectOpen`: read from Zed's database — `kv_store.session_id` is the current
session, and each open window is a `workspaces` row carrying it.
Zed closed: `false` everywhere. `null` if the database does not have these tables. The PWA derives
a dot per project from it; a closed project stays usable, the daemon opens it in
Zed on demand.

### `thread_state`
```ts
{
  type: 'thread_state',
  threadId: string,
  state: 'live' | 'closed' | 'unknown',
  turn: 'idle' | 'busy',
  queue: Array<{ queueId: string, text: string, at?: string }>,
  modes?: Array<{ id: string, name?: string }>,
  models?: Array<{ id: string, name?: string }>,
  options?: Array<
    | { id: string, name: string, description?: string, category: string | null,
        type: 'select', values: Array<{ id: string, name?: string }>, currentValue: string | null }
    | { id: string, name: string, description?: string, category: string | null,
        type: 'boolean', currentValue: boolean }
  >,
  commands?: Array<{ name: string, description?: string }>,
  currentModeId?: string | null,
  currentModelId?: string | null,
}
```
The live state of a thread. To send: at bootstrap, on `subscribe`, and on
**every** `idle ⇄ busy` transition, queue, option or state change.

This is the message that drives the UI: Stop button, cancellable queued entries,
mode/model selectors. `modes`/`models` absent or empty ⇒ no selector, it is not
an error: as long as no shim has read the agent's `initialize`, the daemon
does not know the session options. `commands` is stored by the PWA without
being displayed in v1.

`options` carries **all the other** agent selectors (ACP `configOptions`:
effort, fast mode…). Mode and model — the basic settings — never appear
there, they have their own fields. Full list every time: the agent may
remove some (effort disappears with a model that does not support it). Only the
`select` and `boolean` types get through; an unknown type is dropped by the shim. `category`
is indicative (`thought_level`, `model_config`, …), never required. They are changed
through `set_option` with `key` = the option's `id` (boolean for a `boolean`).

### `acp_event`
```ts
{ type: 'acp_event', threadId: string, update: object, at?: string, seq?: number }
```
**The core.** `update` is the agent's `session/update` payload, **verbatim**:
the daemon does not reread it, normalize it or complete it.

`seq`: sequence number assigned by the daemon, increasing across all its threads,
and from one daemon instance to the next. It is used to recognize an event
received twice — through the `subscribe` replay and through the `history` (see
`until`) —, and to only receive what follows when coming back to a thread (`since`).

**The user's message.** The agent does not send it back live
(`claude-agent-acp` only replays it on `session/load`).
So the shim itself publishes a `user_message_chunk` for each prompt it
sees going through, whether it comes from Zed or from the phone, reusing the prompt's blocks
as is. It is the only frame made by ZRA, and it says so:
`update._meta.zra = { synthetic: true, origin: 'zed' | 'mobile' }`. It is
never sent to Zed.

The PWA can render:

| `update.sessionUpdate` | rendering |
|---|---|
| `user_message_chunk` | user bubble, streamed markdown |
| `agent_message_chunk` | agent answer, streamed markdown |
| `agent_thought_chunk` | "thinking" block, collapsible with a click (expanded or not by default depending on settings) |
| `tool_call` / `tool_call_update` | collapsible card, icon per `kind`, color per `status` |
| `plan` | plan card, updated in place |
| `current_mode_update` | current mode, read in the command bar — not in the thread |
| `config_option_update` | ignored: the options (mode included) already arrive through `thread_state` — not in the thread |
| `available_commands_update` | stored, not displayed in v1 |
| `usage_update` | context usage under the composer ("27k / 1M"), cost in a tooltip — not in the thread |
| `session_info_update` | top bar title (except a thread renamed in Zed, `titleOverridden`) and date — not in the thread |
| *(other)* | **collapsible raw block** — never an error |

`ToolCallContent` handled: `{type:'content'}`, `{type:'diff', path, oldText, newText}`
(the line-by-line diff is computed by the PWA), `{type:'terminal', terminalId}`.

**Permission request.** It is not an ACP notification but a request.
The daemon relays it in an `acp_event` whose `update` carries at least:
```ts
{ requestId: string, toolCall: { toolCallId?, title, kind? }, options: Array<{ optionId, name, kind? }> }
```
The PWA recognizes it by the simultaneous presence of `toolCall` and `options`.

### `history`
```ts
{ type: 'history', threadId: string, updates: object[], complete: boolean, until?: number }
```
Answer to `load_history` (or to a `subscribe` whose `since` can no longer be
caught up), in order, in the same format as `acp_event.update`.
The PWA **resets the timeline** and replays everything, then applies the
live events received in the meantime (it buffers them) — **except** those whose
`seq` is less than or equal to `until`, which the history already contains.
`complete: false` = partial history (the UI says so).

Where the history comes from:

- **closed thread**: the `session/load` replay, by a disposable instance of the
  agent;
- **live thread** whose whole session went through the daemon: the ring
  buffer itself. The agent is not relaunched on a session Zed holds
  open. `complete: false` if the ring has evicted its beginning.

Also sent **unrequested**, empty, when Zed reloads a session the
phone is looking at: the agent is going to replay everything live, the timeline starts from zero
so as not to show the conversation twice.

### `thread_created`
```ts
{ type: 'thread_created', threadId: string, agentId?: string }
```
Answer to `new_thread`. To send **after** the `threads` that contains the new
thread, otherwise the PWA opens an untitled screen. It navigates to it right away.

### `permission_resolved`
```ts
{
  type: 'permission_resolved', threadId: string, requestId: string,
  optionId: string, optionName?: string, by: 'mobile' | 'desktop',
}
```
Locks the card. `optionName` is the displayed label (taken from the agent's
`options`); absent, the PWA falls back to `optionId`.

### `error`
```ts
{ type: 'error', code: string, message: string, threadId?: string }
```
`message` is shown as is in a toast — write it for a human, in
the machine's language (French or English). Codes expected by the PWA (others get through too):

| `code` | meaning | effect on the PWA |
|---|---|---|
| `no_session` | thread without `session_id` | history refused, read-only screen |
| `no_load_session` | agent without the `loadSession` capability (§12.2) | "history unavailable", composer active |
| `history_unavailable` | the machine cannot replay a closed session | same, composer active |
| `unknown_thread` | `threadId` missing from the machine's index | toast |
| `index_degraded` | `sidebar_threads` unreadable or with an unexpected schema | toast; the machine only exposes live threads |
| `inject_failed` | the agent refused the prompt (§12.1) | toast, the message stays displayed |
| `permission_expired` | request already settled | toast, card locked |
| `new_thread_failed` | Zed did not open a session | toast |
| `not_zra_thread` | closed thread of an agent without a ZRA entry: Zed would reopen it without a shim | toast, read-only |
| `prompt_refused` | the agent refused the injected prompt (`auto` mode, before the keyboard fallback) | toast |
| `zed_control_failed` | Zed control (CLI, keyboard) failed or timed out | toast |
| `internal_error` | unexpected daemon error on this message | toast |
| `unknown_message` | unsupported message | toast |
| `pair_failed` | wrong pairing code | toast, input stays open |
| `pair_locked` | too many attempts from this address, or pairing locked | toast (the message says what to do) |

---

## 5. ZRA extensions in `acp_event`

ACP does not cover everything the PWA can display. The gaps go through
`sessionUpdate`s **prefixed with `zra/`** — a reserved prefix, so that they are never
confused with ACP and break nothing if the agent changes.

### `zra/terminal_output`
```ts
{
  sessionUpdate: 'zra/terminal_output',
  terminalId: string,
  output: string,
  append?: boolean,                       // true = concatenate, false/absent = replace
  exitStatus?: { exitCode: number | null, signal?: string },
  truncated?: boolean,
}
```
The `tool_call` carries `{type:'terminal', terminalId}`; this message fills
the block. The PWA repaints all the tool calls referencing this `terminalId`.

### `zra/notice`
```ts
{ sessionUpdate: 'zra/notice', text: string, level?: 'info' | 'warn' }
```
Daemon message inserted in the thread: "turn interrupted", "Zed closed
the agent: queue lost"… Rendered as a discreet system line.

A turn closed **without** the agent says so too, with what to do: "the agent
did not acknowledge the interrupt: turn closed. Reopen the thread in Zed to
restart the agent", "the agent has not responded for 12 min: turn closed —
2 queued message(s) kept. …". Without this notice, the phone would only see
a loading that stops.

### `zra/permission_resolved`
```ts
{
  sessionUpdate: 'zra/permission_resolved', requestId: string,
  optionId: string, optionName?: string, by: 'mobile' | 'desktop',
}
```
Duplicate of `permission_resolved`, written to the ring buffer after the
request. The direct message locks the card at the time; this one
locks it too on a `subscribe` replay and in the history of a live
thread, without which a reloaded PWA would show the request as open again.
Both are idempotent.

---

## 6. Invariants expected from the daemon

1. **Verbatim.** `acp_event.update` and `history.updates` are the agent's
   payloads, not rewritten. It is ZRA's principle (`docs/en/architecture.md`), which makes it
   immune to protocol changes.
2. **Order.** A thread's `acp_event`s arrive in emission order. No
   cross-thread guarantee.
3. **Ring buffer.** 2000 events per live thread, replayed on `subscribe`
   (from `since` if given), each with its `seq`.
4. **Idempotence.** `subscribe`, `unsubscribe`, `interrupt`, `cancel_queued`
   must tolerate being received twice (replay on reconnection).
5. **No client state.** No need to remember who is connected beyond the
   socket itself.
6. **Systematic `thread_state`.** Any action that changes the queue, the turn or
   an option is followed by a `thread_state`. The PWA guesses nothing.
7. **Fail-open on the shim side.** Reminder of §3.1: if the daemon is unreachable or
   slow, Zed keeps working normally. No message of this protocol
   may be able to block the IDE.
8. **Logging.** Every write coming from the phone (`send`, `set_option`,
   `respond_permission`, `new_thread`) is logged in
   `%LOCALAPPDATA%\zra\injections.log`.

### What the PWA never does

- It does not retry a `send` on its own (outside reconnection replay): no
  accidental double sending to an agent.
- It does not interpret ACP content: no parsing of agent formats, no
  semantic diff computation, no state reconstruction from the text.
- It does not guess a thread's state: `state` and `turn` come from the daemon.

---

## 7. Reference sequences

**Opening a live thread**
```
phone                           daemon
  | subscribe(threadId)          |
  |                              |-- thread_state (turn, queue, modes…)
  |                              |-- acp_event × N   (ring buffer)
  | load_history(threadId)       |
  |                              |-- history(updates, complete)
  |                              |-- acp_event …     (real time)
```

**Sending during a turn**
```
  | send(text, mode='queue')     |
  |                              |-- thread_state(turn='busy', queue=[{queueId,…}])
  |                              |   … end of the turn …
  |                              |-- thread_state(turn='idle', queue=[])
  |                              |-- acp_event(user_message_chunk)  [if the agent replays it]
  |                              |-- acp_event(agent_message_chunk) …
```

**Stop, empty queue** — cut, nothing else. The text being typed in the
PWA is never sent by Stop.
```
  | interrupt(threadId)          |
  |                              |-- acp_event(zra/notice "turn interrupted")
  |                              |-- thread_state(turn='idle')
```

**Stop with a queued message** — the pending message goes out right after.
```
  | cancel_queued(queueId)       |
  | send(text, mode='interrupt') |
  |                              |-- acp_event(zra/notice "turn interrupted")
  |                              |-- thread_state(turn='idle', queue=[])
  |                              |-- acp_event(user_message_chunk) …
```

**Permission**
```
  |                              |-- acp_event({requestId, toolCall, options})
  |                              |   (turn stays 'busy': the agent waits)
  | respond_permission(optionId) |
  |                              |-- permission_resolved(by='mobile')
  |                              |-- acp_event(tool_call_update …) — the turn resumes
```

**New session**
```
  | new_thread(agentId)          |
  |                              |   … UIA: Zed opens a thread, a shim connects …
  |                              |-- threads(… + the new one)
  |                              |-- thread_created(threadId, agentId)
```

---

## 8. Checking an implementation

- `zra-daemon/test/protocol.test.mjs`: checklist of this document, message by message, against the real daemon.
- `zra-daemon/test/e2e-shim.test.mjs`: the real chain (daemon, shim, stub agent) — verbatim, queue held by the shim, `session/load`, permissions, shim loss.
- `zra-client/test/mock-daemon.test.mjs`: the stub (`npm run mock`), for cases that are hard to trigger with a real agent.
