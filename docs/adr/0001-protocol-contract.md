# ADR 0001 — Protocol contract

**Status:** Accepted · 2026-11-21 · owner @mrsase
**Supersedes:** the implicit contract in `omp-web` (`server/src/thread.rs`, `web/src/lib/store.ts`)
**Evidence:** `docs/poc-findings.md`, `docs/fixtures/*.jsonl`, `omp` 18.18.8 sources under
`~/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/src/modes/rpc/`

## Context

The console does not speak HTTP to `omp`. It supervises a child process and exchanges
newline-delimited JSON on its stdin/stdout. The PoC learned that protocol by observation and
encoded it twice: byte-prefix checks and ad-hoc structs in Rust, then a second set of
hand-written parsers in TypeScript. The two drifted (the README claims a 512-frame ring; the
code uses 256), and neither has a contract test against real frames.

`omp` ships its own protocol definitions and its own frame encoder/decoder. Those are the
authority. The console must implement the same rules at its boundary, not approximate them.

## Decision

### 1. One Rust crate owns the wire

`crates/omp-protocol` is a dependency-free (no axum, no tokio, no UI) library containing:

| Module | Responsibility |
| --- | --- |
| `frame` | JSONL line → validated frame envelope; known-frame views; unknown-frame preservation |
| `chunk` | protocol-v2 `rpc_chunk` reassembly with `omp`'s exact acceptance rules |
| `command` | outbound command catalog, required-field validation, allowlist |
| `dialogs` | extension UI request/response shapes and answer validation |
| `version` | `omp --version` parsing and supported-range decision |
| `limits` | every byte/frame/queue limit in one place |

`crates/omp-console` may not define a second frame shape. It consumes `omp_protocol` types
and forwards opaque bytes it has already validated.

### 2. Parse in two stages; never lose an unknown frame

`omp` writes `{"type": "...", ...}`. The protocol crate parses the envelope first
(`type`, optional `id`, optional `command`, optional `method`), then attempts the typed view.
A frame whose type is known but whose body fails validation is **invalid**, not unknown: it
is reported to the UI as a protocol notice with the parse error and is not acted on.
A frame whose `type` is not in the supported set is **unknown**: it is preserved verbatim
and forwarded.

```rust
pub enum Frame<'a> {
    Known(KnownFrame<'a>),   // typed view over the original bytes
    Unknown(RawFrame<'a>),   // type + original JSON line, retained
}

pub struct RawFrame<'a> {
    pub kind: &'a str,       // borrowed from the line, may be any string
    pub id: Option<&'a str>,
    pub raw: &'a RawValue,   // the whole object, not a re-serialization
}
```

Rules:

- A line must be exactly one JSON object. Trailing bytes, arrays, scalars, and invalid UTF-8
  are rejected at the reader, before framing.
- The original bytes are what the browser receives. The server never re-serializes a child
  frame, so numbers, key order, and unknown fields survive byte-for-byte.
- The UI must surface unknown frames: a count in the session header, a "protocol" drawer with
  the raw JSON (bounded ring, newest 50), and one log entry per new `type`, not per frame.
  Unknown frames never crash the reducer and are never silently discarded. A12 is this rule.
- Known-but-ignored frames (`advisor_cost_changed`, `cache_warming_*`, subagent frames at the
  default subscription, live/dictation frames) are counted as ignored, not unknown. The known
  set is listed in `protocol::KNOWN_TYPES` and is tested against the fixture corpus.

### 3. Implement `omp`'s chunk rules exactly

Protocol v2 is negotiated only when `ready.supportedProtocolVersions` contains `2`. The
reassembler accepts a `rpc_chunk` only when all of the following hold, matching `rpc-frame.ts`:

- `chunkId` is a non-empty string of at most 128 bytes;
- `index`, `count`, `byteLength` are safe integers; `0 <= index < count`;
- `count >= 2` and `count <= ceil(64 MiB / 256 KiB) = 256`;
- `byteLength >= 1 MiB` and `<= 64 MiB` (the encoder only chunks frames above one physical
  line);
- `data` is canonical base64 (decode → re-encode must be byte-identical) and decodes to at
  most 256 KiB;
- the first chunk has index 0; every subsequent chunk matches `chunkId`, `count`, and
  `byteLength`; indices are contiguous; accumulated bytes never exceed `byteLength`;
- the completed sequence has exactly `byteLength` bytes and is fatal-decoded as UTF-8;
- the decoded payload is one JSON object.

Any violation resets the reassembler, emits a protocol notice, and **drops the partial
sequence**. It never forwards a partial frame. The memory ceiling is 64 MiB for one sequence
and one sequence per child at a time; the buffer is allocated with
`Vec::with_capacity(min(byteLength, 1 MiB))` and grows, so a lying `byteLength` cannot cause an
immediate 64 MiB allocation.

The physical-line reader enforces `ready.maxFrameBytes` (default 1 MiB) **including** the
newline, drains overlong lines without growing the buffer, and resets reassembly when it drops
one. A child that advertises a smaller limit is obeyed; a larger one is clamped to 16 MiB.

### 4. Version negotiation is explicit

Internal states: `Spawning → AwaitingReady → Negotiating → Ready → Stopping → Exited`.
The UI status stays `starting | ready | exited`; `ThreadInfo` also exposes
`protocol: { version: 1|2, delta: bool, eventFilter: bool }`.

- `ready` is the only frame that moves `AwaitingReady → Ready`; it is parsed as JSON, never by
  byte prefix.
- If v2 is advertised, send `negotiate_protocol` and wait for its success response before
  marking `protocol.version = 2`. Chunk reassembly is enabled from `ready` onward using
  `maxReassembledFrameBytes`, because the encoder may start chunking as soon as it applies
  the negotiation.
- `set_event_filter {events:null, messageUpdates:"delta"}` is requested once. On failure or
  when the response reports `messageUpdates:"full"`, retry with `{events:null}` and set
  `delta:false`; the reducer supports both projections.
- `set_ask_dialog {enabled:true}` is best effort; failure is an informational notice, because
  the field-by-field fallback still works.
- If `negotiate_protocol` fails, stay on v1, set `delta:false`, and continue. The UI shows a
  degraded-protocol chip.

### 5. Supported `omp` range is checked before spawn

At startup the server runs `omp --version` (5 s timeout) and parses `omp/<semver>`:

- major **18** → supported (tested 18.18.8; the exact patch is recorded in `/api/info`).
- anything else → spawns are refused with `409` and an actionable message naming the found
  version, the supported range, `OMP_BIN`, and the override.
- `OMP_CONSOLE_SKIP_VERSION_CHECK=1` overrides for a deliberate experiment; the UI keeps an
  "unverified omp" chip and `/api/info` says so.

If the binary is missing, `/api/info` reports `omp: { found:false, error }`; the console still
serves the UI and recent sessions so the error is readable, but session creation is refused.

### 6. Outbound commands are typed, validated, and allowlisted

The server parses every browser command into a borrowed `CommandView` (type + required
fields), rejects unknown types and missing fields with a notice, then forwards the **original
bytes** to the child. This keeps large image payloads from being parsed and re-serialized,
while still giving one allowlist and one test surface.

Allowlist for v1.0:

```
prompt steer follow_up remove_queued_message promote_queued_message
abort abort_and_restore_queue
set_model set_thinking_level set_session_name
new_session fork export_html compact set_auto_compaction
get_state get_session_stats get_messages get_available_models
get_available_thinking_levels get_available_commands
extension_ui_response
```

Everything else — `bash`, `switch_session`, `branch`, `navigate_tree`, `login`, `logout`,
`set_host_tools`, `live_*`, `dictation_*`, `predict_word`, `goal`, subagent control — is
rejected in v1.0 with "command not enabled in this console". These are real capabilities that
need their own design and tests; the allowlist is the security boundary, not a suggestion.

Validation rules:

- the frame is one JSON object, at most 1 MiB (UTF-8 bytes), with a string `type`;
- required fields are present and of the right JSON kind (`message` string, `images` array of
  `{type:"image", mimeType, data}`, model `provider`/`modelId` strings, thinking `level` one
  of the server's known levels or the child's advertised list, queue one of `steering`/
  `followUp`);
- `extension_ui_response` must carry exactly one of `value`, `confirmed`, `answers`,
  `cancelled:true`; answers match the outstanding dialog's question ids when known;
- an `id` is generated server-side if the browser omitted one; ids are opaque strings ≤128
  bytes.

### 7. Frame fan-out is bounded by bytes, not only count

A session keeps a `FrameRing`: at most **256 frames** and **8 MiB** of retained frame bytes.
When either cap is exceeded, the oldest frame is dropped and the skipped count increases.
Subscribers read from a cursor; if the cursor was overwritten, the server sends
`{"op":"lagged","thread":id,"skipped":n}` and the client resyncs (state + stats + history).
This replaces a count-only broadcast where 256 × 1 MiB could retain 256 MiB per session.

### 8. TypeScript mirror is hand-written and contract-tested

`web/src/protocol/` owns the TS types and the reducer input types. They are hand-written, not
generated:

- the surface is small (one envelope, ~30 frame types, ~25 commands, 4 dialog kinds);
- the contract that matters is behavioural, and a generated type cannot prove that Rust and
  TypeScript agree on a frame's meaning;
- generation would add a build step and a second source of truth for field names.

The guarantee comes from **the same `docs/fixtures/*.jsonl` replayed by both sides**:

- Rust: `cargo test -p omp-protocol` parses every frame, asserts the known/unknown
  classification, asserts command validation, and round-trips the envelope bytes.
- TypeScript: `bun run test` feeds every envelope through `reduceEnvelope` and asserts the
  resulting transcript/queue/dialog state for `stream.jsonl`, `resume.jsonl`, `dialogs.jsonl`,
  and `unknown.jsonl`.
- A fixture is added only when a real capture or an `omp` source definition justifies it. The
  builder is `tools/build-fixtures.mjs`; provenance is in `docs/fixtures/README.md`.

### 9. Unknown and malformed are different

| Input | Behaviour |
| --- | --- |
| Unknown `type`, valid JSON object | forward; UI counts and stores raw evidence |
| Known `type`, invalid body | notice `protocol: <type>: <error>`; do not forward as a known frame |
| Non-object line | drop at reader; notice `dropped malformed omp frame` |
| Line over the physical limit | drain; notice `dropped oversized omp frame`; reset chunks |
| Chunk rule violation | reset; notice `rpc chunk error: …`; drop partial |
| Envelope spoof attempt | impossible by construction: the child line is a JSON value inside our envelope; a line that is not one object is rejected |

### 10. The browser boundary is not trusted more than necessary

The console is single-user and local, but the browser still gets:

- a Host/Origin/Sec-Fetch-Site guard before any handler;
- a command allowlist and payload caps;
- no `dangerouslySetInnerHTML`; markdown is rendered to React nodes with link-scheme checks;
- dialog text inserted as text, never HTML; `ask` form HTML is parsed for labels/fields, not
  rendered as raw HTML;
- attachment limits enforced in the browser (4 × ~150 KiB) and again on the server (1 MiB
  command).

## Consequences

- One place to change when `omp` moves: add the type to `KNOWN_TYPES`, add the fixture, the
  Rust view, and the TS reducer branch in the same PR. Unknown-frame handling is the default,
  so a missed update degrades to evidence, not a crash.
- The server can no longer accept a new `omp` command from the UI without a code change. That
  is intentional: each command needs a product surface and a test.
- Delta updates are required for long responses; full updates remain supported as a fallback.
- Reassembly is stricter than the PoC. A chunk sequence the PoC would accept and the real
  encoder would not is now rejected — the correct failure direction.
- `ready` can arrive before the UI has a WebSocket; the ring retains it (8 MiB cap), and a
  late subscriber sees the retained frames in order.

## Alternatives considered

| Alternative | Rejected because |
| --- | --- |
| Keep frames as `serde_json::Value` everywhere | no validation, no single known set, unknown/malformed indistinguishable |
| Generate TS from Rust (ts-rs / schemars) | adds a build step; types alone do not prove reducer behaviour; the fixture replay is the stronger test |
| Forward only whitelisted frames to the browser | hides protocol drift; A12 requires surfacing unknown frames |
| Rely on `broadcast` with a larger frame count | count does not bound bytes; a few 1 MiB frames exhaust memory |
| Trust `byteLength` and preallocate | a lying child can force a 64 MiB allocation per session |
| Accept any command object (PoC) | the browser boundary would expose `bash`, session switching, and login commands without design or tests |

## Tests that discharge this ADR

- `frame::tests::classifies_known_unknown_and_malformed`
- `frame::tests::rejects_envelope_spoof_lines`
- `chunk::tests::{in_order, out_of_order, interleaved, bad_base64, chunk_too_large, count_one, short_byte_length, length_mismatch, non_utf8, non_object}`
- `command::tests::{allowlist, required_fields, image_limits, oversized}`
- `version::tests::{supported, unsupported, missing_binary, override}`
- `contract::tests::replay_all_fixtures` (Rust) and `web/src/protocol/contract.test.ts` (TS)
- `security::tests::{host_guard, origin_guard, resume_containment, command_cap}`
