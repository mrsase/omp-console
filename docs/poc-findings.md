# PoC findings — `omp-web`

Source: `/Users/aligoley/workPlace/omp-web` (read-only), archived here on `poc` / tag
`poc-archive`. Protocol source of truth: the installed `omp` 18.18.8 package, whose
TypeScript sources ship at
`~/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src/modes/rpc/`
(`rpc-types.ts`, `wire/*.ts`, `rpc-frame.ts`, `rpc-mode.ts`). Live captures were recorded on
2026-11-21 against `omp/18.18.8`; sanitized shapes are in `docs/fixtures/`.

This document is what the rewrite keeps. It is not a plan; see `docs/adr/` and
`docs/v1-design.md` for decisions.

## 1. What the PoC is

A loopback web console that spawns one real `omp --mode rpc-ui` child per session, relays
its JSONL stdout to a browser over one WebSocket, and forwards browser commands back to the
child's stdin. Rust 2,475 lines across 10 files (`thread.rs` is 1,288 of them); TypeScript
9,564 lines across 14 files (`styles.css` is 3,397, `store.ts` 2,070). Fourteen Rust unit
tests, zero frontend tests, no git history, no CI. `web/dist` was a checked-in build artifact
and `node_modules` was missing.

The PoC's real asset is behavioural knowledge: the handshake order, the exact frames the UI
consumes, the child lifecycle, and the security guards. The code itself is a proof, not a
foundation.

## 2. Protocol flow

### 2.1 Spawn

```
omp --mode rpc-ui --cwd <canonical cwd> [--allow-home if cwd == $HOME]
    [--resume <absolute .jsonl under session root>]
    [--model=<provider/model>] [--thinking=<level>]
```

Environment: `PI_NO_TITLE=1`. `stdin`/`stdout`/`stderr` piped; child killed on drop in the
PoC. Working directory is also set to `cwd`.

`omp --version` prints `omp/18.18.8` (stdout). The server does not check it in the PoC.

### 2.2 Startup frames (child → console, unsolicited)

1. `ready` — first frame. `protocolVersion: 1`, `supportedProtocolVersions: [1, 2]`,
   `maxFrameBytes: 1048576`, `maxReassembledFrameBytes: 67108864`,
   `supportsBashExcludeFromContext: true`.
2. Other unsolicited frames follow immediately: `extension_ui_request` (`setWidget` for a
   configured widget, often with no `widgetLines`), `advisor_cost_changed`,
   `available_commands_update` (a 16 KB slash-command catalog in the capture).

The PoC treats `status` as `starting` until it parses `ready`, then `ready`.

### 2.3 Negotiation and subscriptions (console → child)

After `ready`, the PoC sends, without waiting for each response:

| Order | Frame | Purpose |
| --- | --- | --- |
| 1 | `{"type":"negotiate_protocol","protocolVersion":2}` | enables chunked frames up to 64 MiB |
| 2 | `{"type":"set_event_filter","events":null,"messageUpdates":"delta"}` | all events, delta projections |
| 3 | `{"type":"set_ask_dialog","enabled":true}` | opt in to rich `ask` UI requests from extensions |
| 4 | `{"type":"get_state"}` | model, thinking, queue, todos, context usage |
| 5 | `{"type":"get_session_stats"}` | session file/id, message/tool counts, tokens, cost |

Each gets a `response` correlated by `id`. The PoC's internal ids start with `_ompweb_`
so it can recognise its own responses and not treat them as UI-requested commands.

`set_ask_dialog` is best-effort: on failure the PoC emits an info notice and relies on the
`select`/`input`/`editor` fallback. `negotiate_protocol` failure only emits a warning.

### 2.4 The event stream

Once `set_event_filter` applies, the child writes one JSON object per line to stdout:

```
agent_start → turn_start → message_start (user) → message_end (user)
            → message_start (assistant) → message_update* → message_end (assistant)
            → tool_execution_start → tool_execution_update* → tool_execution_end
            → message_start/end (toolResult) … → turn_end
            → turn_start → … → turn_end → agent_end → prompt_result
```

`session_settled` follows when no background work remains (the capture emitted it after a
terminal `prompt_result` that already said `sessionSettled: true`; treat both as settling).

`prompt_result` is emitted exactly once per accepted `prompt`/`abort_and_prompt`, keyed by
the command `id`, after the work settles. `agent_end.isTerminal` false means a continuation
or async delivery remains.

### 2.5 Rehydration

On view select, reconnect, or lag, the PoC sends `get_state`, `get_session_stats`,
`get_messages`, `get_available_thinking_levels`, and (once) `get_available_commands` /
`get_available_models`. A `session_busy` error on `get_messages` is logged; there is no retry.

### 2.6 Commands the UI sends

| Command | Payload the PoC sends | Notes |
| --- | --- | --- |
| `prompt` | `{message, images?: ImageContent[], streamingBehavior?}` | `streamingBehavior` is `steer` or `followUp` while a turn runs |
| `steer` / `follow_up` | `{message, images?}` | available but the PoC uses `prompt` + behaviour |
| `remove_queued_message` | `{message, queue: "steering"\|"followUp"}` | `message` is the queue-chip text |
| `promote_queued_message` | `{message}` | follow-up → steering |
| `abort` | `{}` | stop without restoring queue |
| `abort_and_restore_queue` | `{}` | stop and return withdrawn input |
| `set_model` | `{provider, modelId}` | applies to the next turn |
| `set_thinking_level` | `{level}` | applies to the next turn |
| `set_session_name` | `{name}` | PoC derives a title from the first prompt |
| `new_session` | `{}` | clears the conversation in place |
| `fork` | `{}` | `entryId` omitted; omp may ask |
| `export_html` | `{}` | response `data.path` |
| `compact` / `set_auto_compaction` | `{}` / `{enabled}` | |
| `get_state`, `get_session_stats`, `get_messages`, `get_available_*` | `{}` | hydration |
| `extension_ui_response` | `{value}` \| `{confirmed}` \| `{answers}` \| `{cancelled}` | dialog answers |

Not used by the PoC but present in `omp` 18: `bash`, `switch_session`, `branch`,
`navigate_tree`, `get_tree`, `get_entries`, `get_messages_page`, subagents, goals, live
voice, dictation, host tools/URIs. v1 decides which of these are in scope (ADR 0001).

### Store action → command map

The user-facing functions named in the brief map to the wire like this:

| Store action | Wire command |
| --- | --- |
| `sendPrompt(id, text, images)` | `prompt` with `streamingBehavior: "steer" \| "followUp"` while running |
| `stopThread(id)` | `abort_and_restore_queue` |
| `abortThread(id)` | `abort` |
| `setModel(id, provider, modelId)` | `set_model` |
| `setThinking(id, level)` | `set_thinking_level` |
| `removeQueued(id, message, queue)` | `remove_queued_message` |
| `promoteQueued(id, message)` | `promote_queued_message` |
| `forkThread(id)` | `fork` (no `entryId`; omp may ask) |
| `exportThread(id)` | `export_html` |
| `newSessionInThread(id)` | `new_session` |
| `compactThread(id)` / `toggleAutoCompaction(id)` | `compact` / `set_auto_compaction` |
| `renameThread(id, name)` | `set_session_name` |
| `answerDialog(...)` | `extension_ui_response` (`value`, `confirmed`, `answers`, or `cancelled`) |

## 3. Frame shapes the UI consumes

All shapes below are from `omp`'s own types and were observed live. Sanitized examples:
`docs/fixtures/handshake.jsonl`, `stream.jsonl`, `resume.jsonl`, `dialogs.jsonl`.

### Session state (`get_state`)

`model {id, provider, name, reasoning, contextWindow, cost, input, thinking?}`,
`thinkingLevel`, `isStreaming`, `isCompacting`, queue modes, `sessionFile`, `sessionId`,
`sessionName?`, `autoCompactionEnabled`, fast/slow fields, `tokensPerSecond`,
`messageCount`, `queuedMessageCount`, `hasPendingAsyncWork`, `isSettled`,
`queuedMessages {steering[], followUp[], liveSteered}`,
`todoPhases [{name, tasks [{content, status, blocker?}]}]`, `contextUsage {tokens,
contextWindow, percent}`, `goal`, and — importantly for payload size — `systemPrompt[]` and
`dumpTools[]`, which the UI does not need. Captured at ~37 KB.

### Session stats

`{sessionFile, sessionId, userMessages, assistantMessages, toolCalls, toolResults,
totalMessages, tokens {input, output, reasoning, cacheRead, cacheWrite, total}, cost,
premiumRequests, contextUsage}`.

### Messages (`AgentMessage`)

- `user`: `{role, content: [text|image], timestamp, attribution?}`
- `assistant`: `{role, content: [text|thinking|toolCall|image], api, provider, model,
  usage, stopReason, timestamp, duration?, ttft?, completedAt?, responseId?, errorMessage?}`
- `toolResult`: `{role, toolCallId, toolName, content: [text|image], details, isError,
  timestamp}`
- also `bashExecution`, `pythonExecution`, `custom`, `hookMessage`, `branchSummary`,
  `compactionSummary`, `fileMention`, `developer`.

`usage` is `{input, output, cacheRead, cacheWrite, totalTokens, cost {input, output,
cacheRead, cacheWrite, total}}`. `cost` on the message is an object; session `cost` is a
number.

### Delta `message_update` (protocol v2 projection)

With `messageUpdates: "delta"` the frame is
`{type, messageId, message: {role}, assistantMessageEvent}`. The event is one of:

| Event | Fields | Meaning |
| --- | --- | --- |
| `text_start` | `contentIndex`, `block {type:"text", text:""}` | opens a text block |
| `text_delta` | `contentIndex`, `delta` | append |
| `text_end` | `contentIndex`, `content`, `block {type:"text"}` | authoritative final text |
| `thinking_start/delta/end` | same, `thinking` instead of `text` | |
| `toolcall_start` | `contentIndex`, `block {id, name, arguments:{}, partialArgs:""}` | opens call |
| `toolcall_delta` | `contentIndex`, `delta` (JSON fragment) | append to args text |
| `toolcall_end` | `contentIndex`, `toolCall {id, name, arguments, partialArgs}` | authoritative call |
| `image_end` | `contentIndex`, `content {mimeType, data}` | |
| `start` | `message` (full assistant snapshot) | re-start; blocks may already be ahead |
| `done` / `error` | `message` / `error` | terminal sub-events |

A `*_start` carries a block shell with text emptied; a re-`start` carries the whole message.
`text_end`/`thinking_end`/`toolcall_end` are authoritative over accumulated deltas.

### Tool lifecycle

`tool_execution_start {toolCallId, toolName, args?, intent?}`,
`tool_execution_update {toolCallId, toolName, args?, partialResult?}`,
`tool_execution_end {toolCallId, toolName, result?, isError?}`. `result` is
`{content: [text|image], details}`. `details` is tool-specific and can be large (the bash
trace ran to ~1.8 KB per update); render it only on demand.

The assistant `toolCall` block and the `tool_execution_*` frames share `toolCallId`. The
`toolResult` message duplicates the end result; the UI should render the call + run, not
both.

### Extension UI requests (dialog sub-protocol)

`{type:"extension_ui_request", id, method, …}` where method is:

| Method | Payload | Response |
| --- | --- | --- |
| `select` | `title`, `options: string[]`, `optionDetails?`, `timeout?` | `{id, value}` |
| `confirm` | `title`, `message`, `timeout?` | `{id, confirmed}` or `{id, cancelled:true}` |
| `input` | `title`, `placeholder?`, `secret?`, `timeout?` | `{id, value}` |
| `editor` | `title`, `prefill?`, `promptStyle?` | `{id, value}` |
| `ask` | `questions: [{id, question, header?, options:[{label, description?, preview?}], multi?, recommended?}]`, `timeout?` | `{id, answers:[{id, selectedOptions, customInput?}]}` |
| `cancel` | `targetId` | none; closes that dialog |
| `notify` | `message`, `notifyType?` | none |
| `setStatus` | `statusKey`, `statusText?` | none |
| `setWidget` | `widgetKey`, `widgetLines?`, `widgetPlacement?` | none |
| `setTitle` | `title` | none |
| `set_editor_text` | `text` | none |
| `open_url` | `url`, `launchUrl?`, `instructions?` | none |

Observed in a live session:

- Tool approval is a `select` whose title is `"Allow tool: bash\nCommand: …"` with options
  `["Approve", "Approve bash for this session", "Deny"]`. It is **not** a dedicated approval
  frame and has no `toolCallId`.
- The `ask` tool takes one HTML `<form>` as its argument. RPC is not a `formDialog` host, so
  `omp` walks the form's named fields one at a time through `select`/`input`/`editor`.
  A choice field's select options include the literal row `"Other (type your own)"`; choosing
  it triggers a follow-up `input`. There is a `Done` row for multi-select fields.
- The rich `ask` method is only emitted by extensions after `set_ask_dialog`, never by the
  `ask` tool in RPC mode.
- `setWidget` with no `widgetLines` clears that widget.

Timeouts: `omp` owns the deadline. When it expires, an `ask` takes its recommended answers;
the host may also cancel with `{cancelled:true, timedOut:true}`.

## 4. Transport framing (protocol v2)

- One JSON object per line, UTF-8, newline-terminated.
- A physical line is at most `1 MiB` including the newline (`MAX_RPC_FRAME_BYTES`).
- A logical frame larger than 1 MiB is emitted as `rpc_chunk` lines only after v2 is
  negotiated: `{type:"rpc_chunk", chunkId, index, count, byteLength, data(base64)}`.
- Encoder rules: chunk payload is 256 KiB of raw bytes; `byteLength` is the whole logical
  frame; `count >= 2`; `byteLength` is between 1 MiB and 64 MiB.
- Decoder rules (enforced by `omp` itself): `chunkId` non-empty ≤128 chars, safe integers,
  `count >= 2`, `count <= ceil(64 MiB / 256 KiB)`, `index < count`, canonical base64,
  decoded chunk ≤256 KiB, strict id/count/byteLength/order match, accumulated bytes never
  exceed `byteLength`, final length exact, fatal UTF-8 decode, result must be a JSON object.
- If a logical frame still exceeds the limit, `omp` emits `rpc_frame_error`
  (`originalType`, `error`) or a transport-limit error `response`.
- `agent_end` may be compacted: a prefix already delivered by `message_end` is dropped and
  `messageCount` carries the original count.

The PoC's reassembler is looser than this (accepts `count == 1`, `byteLength < 1 MiB`,
non-canonical base64, and any chunk size under `byteLength`). The rewrite implements the
encoder's actual rules.

## 5. PoC thread state machine

```
                 spawn ok
   (none) ─────────────────▶ STARTING ──ready parsed──▶ READY ──negotiate ok──▶ READY/v2
                                │                         │
                                │ child exit              │ child exit / stop / kill
                                ▼                         ▼
                              EXITED ◀────────────────── EXITED
                                │
                     remove / prune (1 h idle)
                                ▼
                             REMOVED
```

Per thread the PoC keeps: id (UUID v4), cwd, pid, created_at, resume path, last_activity,
exit_code, `ready` info, metadata (model, model name, session name/file/id, thinking),
a dialog map (max 64), a stderr ring (240 lines / 64 KiB), a command channel (128), a frame
broadcast channel (256 frames), and lifecycle broadcasts.

Transitions that matter:

- `ready` is parsed and stored, status set to ready, lifecycle upsert published, frame
  relayed, then negotiation/filter/ask/state/stats are enqueued.
- `get_state`/`get_session_stats` responses are also used **server-side** to refresh
  `ThreadInfo` (model, title, session file/id, thinking) so resume and lifecycle stay current.
- Client responses are recognised by scanning the first 320 bytes for exact substrings.
- `extension_ui_request` is stored for replay to late clients; `cancel` removes the target.
- `stop` sends `abort`, then a second static-id abort, drops the command sender, waits up to
  2 s, then signals the waiter to `start_kill()`.
- Shutdown stops all children concurrently; registry prune removes exited threads older than
  1 h every 5 min.

## 6. Security invariants (keep and test)

- Bind `127.0.0.1:8787` by default; refuse a non-loopback bind unless explicitly allowed.
- `Host` must be one of the loopback host:port forms (421 otherwise).
- `Origin` must be allowlisted for WebSocket upgrades and unsafe methods (403 otherwise);
  `Origin: null` is rejected; `Sec-Fetch-Site: cross-site` is rejected.
- Response headers: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer`, a CSP with no `object-src`, no framing, no base changes.
- No authentication. Any local process can reach the port; do not expose it. Binding to
  `0.0.0.0` is a deliberate, documented downgrade.
- Resume is confined to canonicalized `.jsonl` files under the session root.
- Frame relay rejects non-object lines and lines over the transport limit; the child cannot
  forge top-level WebSocket envelope keys because its line is nested as a JSON value.
- Browser sockets are capped (16), inbound messages capped (1 MiB + 4096), command frames
  capped (1 MiB), stderr bounded, dialogs bounded, frames bounded.
- The PoC renders untrusted message text through a hand-rolled Markdown renderer that builds
  React nodes and restricts link protocols; it never uses `dangerouslySetInnerHTML`.
- The PoC forwards **any** command object the browser sends, including `bash`. Same-origin
  guard + CSP are the only barrier; an XSS would be local code execution.

## 7. Sharp edges found

Numbers are findings, not a to-do list; the decisions that resolve them are in the ADRs.

### Correctness and honesty

1. README claims a **512-frame** fan-out ring; `thread.rs` uses `FRAME_CHANNEL = 256`.
2. README lists live subagent subscription and a session tree/branch editor; neither is
   surfaced. Fork/clear/export are the actual menu actions.
3. `web/dist` was committed while `node_modules` was absent: the repo could not rebuild its
   own frontend.
4. README's browser-verification list is prose with no screenshots or commands. It cannot be
   reproduced.
5. Two identical `case "prompt_result"` blocks exist in `store.ts` (the second is dead).

### Transport and memory

6. The frame fan-out is bounded by **count**, not bytes: 256 frames × up to 1 MiB = 256 MiB
   per session worst case, before the per-socket 256-message queue copies them again.
7. `read_line_capped` is correct, but the reassembler's limit comes from the negotiated
   `maxReassembledFrameBytes`, and `Vec::with_capacity(min(byteLength, 1 MiB))` can grow to
   64 MiB by design. Fine, but the 64 MiB is not shared across sessions.
8. Reassembly validation is weaker than `omp`'s own decoder (see §4).
9. `max_frame_bytes` clamps the child's advertised value into 4 KiB–16 MiB; a child that
   advertises less is obeyed, more is silently raised.
10. `set_max` runs only after a `ready` line; chunks arriving before it would use the default
    64 MiB. Not observed, but the state machine does not forbid it.
11. Broadcast `Lagged` is counted in frames, not bytes, and the client resyncs by asking for
    state/stats/messages — which can itself be a 64 MiB frame.

### Parsing and protocol robustness

12. Frame classification uses byte-prefix matching on the exact serialization:
    `{"type":"ready"`, `{"type":"extension_ui_request"`, `{"type":"rpc_chunk"`,
    `{"id":"_ompweb_`. A key-order change or whitespace defeats it.
13. `client_response_command` scans 320 bytes for `"type":"response"` and
    `"command":"get_state"`; a nested payload could false-positive, and adding tracking for a
    new command means editing string matchers.
14. Unknown frame types hit `default: break` and disappear silently — directly against A12.
15. `config_update` (emitted by builtin slash commands such as `/model`) is ignored, so the
    model/thinking pickers can go stale after a slash command. Only `model_changed` refreshes.
16. `turn_end` is received but not used; there is no turn boundary in the transcript.
17. `agent_end`'s `messageCount` (compaction) is ignored; after a lag, history may stay
    incomplete.
18. `get_messages` returning `session_busy` is logged with a comment saying "will retry"; no
    retry exists. A reconnect during a turn can leave the transcript empty until the next
    hydrate.
19. Hydration merges by `role + timestamp` fallback. Two messages with the same millisecond
    timestamp can replace each other; live keys (`messageId`) and history keys
    (`h:role:ts:index`) are different namespaces.
20. `applyAssistantDelta` ignores the `start` (re-start) event and `done`'s full message is
    handled only in a narrow branch.
21. `got_state` includes `systemPrompt` and `dumpTools` (tens of KB) and the whole frame is
    relayed to the browser on every hydrate.
22. `get_available_models` was **158 KB** in the live capture (provider account metadata
    included). The PoC fetches it per session and parses it on the main thread.

### Lifecycle and process control

23. No process group: killing the `omp` child can leave bash/tool grandchildren running.
    A2 ("no orphan processes") is not met by the PoC.
24. `waiter` calls `start_kill()` then awaits `child.wait()` with no second deadline. A child
    stuck in uninterruptible sleep can hang shutdown forever; `stop_all` has no overall
    timeout.
25. `stop` awaits a queued `abort` **before** the non-blocking one, so a full command channel
    can delay the abort by the channel length; the grace clock starts after that await.
26. `last_activity` updates on stdout only; a client command does not count as activity.
27. Prune runs every 5 minutes and only removes threads idle for 1 hour. Exited threads keep
    their stderr/dialog memory until then.
28. The child inherits the full environment, including any `OMP_*` or provider variables. No
    sanitisation.
29. `--model=<value>` is correctly one argv entry (good), but the value is only checked for
    `/` and whitespace; `thinking` is checked against a hard-coded list that already lags
    `omp` (`"auto"` is appended, but `"minimal"`/`"xhigh"` handling is manual).

### Sessions, resume, filesystem

30. Resume containment canonicalizes and checks `starts_with(root)` + `.jsonl`, but does not
    require a regular file; a directory named `x.jsonl` passes validation and fails later.
31. If the session root does not exist, the canonicalized root falls back to the raw path;
    a symlinked root can then reject valid files or accept unexpected ones.
32. The session header reader takes one 16 KiB read and assumes complete lines. A long first
    record truncates the `session` line; the session is hidden from Recent.
33. Header detection uses substring checks (`"type":"title"`), so key order or whitespace
    changes break it. It also stops at the first `session` line, missing a later title.
34. Recent cache TTL is 10 s, but `closeThread` refreshes after 400 ms. The just-closed
    session can be missing from Saved history for up to 10 s (the refresh is a cache hit).
35. `fsapi::listing` claims to follow symlinks but uses `entry.file_type()` (no follow), so a
    symlinked workspace shows as a file. The fallback only runs on `file_type` error.
36. Folder browsing is intentionally whole-filesystem and unauthenticated (local tool). It is
    read-only, but a hostile local process can enumerate the disk. Documented, not fixed.
37. Recent scan is exactly two levels deep (`root/<project>/*.jsonl`); a layout change in
    `omp` silently empties the list. Titles fall back to `Untitled · <id prefix>`.

### Server HTTP/WS

38. The Vite origin `:5173` is allowlisted in production builds. A page served on
    localhost:5173 could open a WebSocket to the console. It should be dev-only.
39. CSP allows `script-src 'unsafe-inline'` and `style-src 'unsafe-inline'`. The latter is
    needed for React inline styles; the former should not be, if the theme bootstrap is an
    external file.
40. The static fallback returns `index.html` for unknown asset paths (HTML with 200), and
    hashed assets get no immutable cache headers.
41. The `ping`/`pong` op exists but nothing sends `ping`; stale sockets are only detected by
    TCP.
42. Dialog replay stores up to 64 requests in a `HashMap` and evicts `keys().next()` — an
    arbitrary entry, possibly a live approval — when full.
43. The command path forwards arbitrary objects (including `bash`, `switch_session`, login
    commands), with only a size and `{` check.
44. `send_envelope` re-checks UTF-8 on every frame; frames are already UTF-8 JSON.
45. Lifecycle broadcasts are separate from frame broadcasts, so ordering between a
    `thread_removed` and a final `frame` is not defined; a late frame for a removed thread is
    ignored by the client.

### Frontend state and rendering

46. One global store emits on **every token**; `App`, `Sidebar`, `Transcript` and `Composer`
    all subscribe. Per-message `memo` limits row re-renders, but the 10k-row map still runs
    on every delta.
47. `patch` sets `lastFrameAt: Date.now()` on every frame, creating a new thread object each
    time, so memoised children that take the whole thread still re-render.
48. No virtualization and no CSS containment for 10k-event transcripts; A10 is unproven.
49. `get_messages` hydration replaces the list but tries to preserve "newer" local messages
    by timestamp; streaming messages are preserved, but ordering is not guaranteed.
50. `upsertMessage` matches by exact key then by role+timestamp; duplicate timestamps are
    common in a single millisecond tool burst.
51. Drafts live in a module `Map` only. The composer says "Disconnected · draft saved", but a
    reload loses the draft. The copy overclaims.
52. The slash palette ignores `aliases` from the command catalog, so alias commands do not
    match.
53. IME handling checks `isComposing` but not the legacy `keyCode === 229` path.
54. Image compression is browser-only (max 4 × ~150 KiB, 1280 px); the 900 KiB command guard
    is a second line of defence. The PoC does not measure total JSON size including base64
    overhead for all images at once.
55. `stopThread` merges steering and follow-up texts into one editor draft joined by blank
    lines, losing per-message boundaries and image association.
56. `set_editor_text` overwrites the current draft without confirmation. Correct for the
    protocol, surprising for a person.
57. Dialog timeouts display a countdown but do nothing at zero; `omp` owns the deadline, so
    the UI can show "Auto-selects in 0s" until the child cancels.
58. Approval dialogs render as generic select dialogs; the three options are not visually
    distinguished, and the title's newline is not structured.
59. The `ask` tool's `Other (type your own)` row is shown as an option **and** the PoC adds a
    free-text field, duplicating the affordance. Multi-select fields require repeated
    dialogs, one option per response, with no visible accumulation.
60. The `ask` HTML form in the tool arguments is never shown; the person sees only the
    field-by-field prompts, losing the form's explanatory prose and layout.
61. `open_url` calls `window.open` from an async handler (popup blockers); it also logs and
    toasts the URL, which is the usable fallback.
62. `styles.css` is 3,397 lines with no tokens file, no documented system, and 441 top-level
    selectors; it is the largest source file in the project and the least reviewable.

## 8. What the rewrite keeps

- The spawn arguments, including `--allow-home`, `--model=`, `--resume`, and `PI_NO_TITLE`.
- The handshake order and the delta event filter.
- The server-side `get_state`/`get_session_stats` metadata tracking used for resume.
- Dialog replay for late-attached clients.
- The security guard behaviour and its tests.
- The frame relay format (one WS envelope per child frame) and command correlation.
- The field-by-field `ask` fallback; the `select` approval flow.
- Image compression limits and the 1 MiB command budget.
- The queue, stop-and-restore, model/thinking, plan/todos, resume, and recent-session flows.

What it replaces: the single 1,288-line thread module, the byte-prefix parsers, the
count-only fan-out ring, the global every-token store, the 3,397-line stylesheet, the
unmeasured README, and the absence of git, CI, frontend tests, and a stub `omp`.
