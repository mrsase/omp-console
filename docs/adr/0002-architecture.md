# ADR 0002 — Architecture

**Status:** Accepted · 2026-11-21 · owner @mrsase
**Supersedes:** the single-crate, single-`thread.rs` layout of `omp-web`
**Depends on:** ADR 0001 (protocol contract)

## Context

The PoC is one 1,288-line module that spawns processes, parses protocol frames, reassembles
chunks, tracks session metadata, stores dialogs, serves an HTTP API, and fans frames out over
a WebSocket. Every one of those responsibilities is entangled with the others: a change to
chunk validation recompiles the HTTP layer, and the only way to test dialog replay is to start
a real `omp`.

The product target is one installable binary that a stranger runs on a new machine. That
means the web assets must be inside the binary, the port and bind must be safe by default, and
the process lifecycle must be testable without a model or network.

## Decision

### 1. Workspace layout

```
omp-console/
├── Cargo.toml                 # [workspace] members = ["crates/*"]
├── crates/
│   ├── omp-protocol/          # no axum, no tokio, no UI
│   │   └── src/
│   │       ├── lib.rs
│   │       ├── frame.rs       # envelope, known views, unknown preservation
│   │       ├── chunk.rs       # v2 reassembly
│   │       ├── command.rs     # outbound catalog + allowlist validation
│   │       ├── dialog.rs      # extension UI request/response
│   │       ├── version.rs     # omp --version parsing and range
│   │       ├── limits.rs      # every cap, one place
│   │       └── fixture.rs     # JSONL fixture loader (test + contract use)
│   └── omp-console/           # axum server binary + library for tests
│       └── src/
│           ├── main.rs        # config, tracing, bind, signals, serve
│           ├── lib.rs         # re-exports for integration tests
│           ├── config.rs      # env → Config, validation, allowlists
│           ├── error.rs       # ApiError → status + JSON
│           ├── http.rs        # router, guard, security headers, static fallback
│           ├── api.rs         # /api handlers (thin)
│           ├── ws.rs          # upgrade, client ops, per-socket writer
│           ├── supervisor.rs  # registry, cap, create/remove/prune/stop_all
│           ├── child.rs       # spawn, stdio loops, process group, teardown
│           ├── ring.rs        # byte-bounded FrameRing + cursors
│           ├── thread.rs      # per-session state, metadata tracking, dialogs
│           ├── sessions.rs    # session file headers + recent scan cache
│           ├── fsbrowse.rs    # folder listing + path expansion
│           ├── assets.rs      # rust-embed + dev directory override
│           └── ompbin.rs      # version probe, binary resolution
├── web/                       # React 19 + TS strict + Vite; bun lockfile
├── tools/                     # stub omp, fixture recorder/builder, gates, perf
├── docs/
└── Makefile
```

No source file over **600 lines**, enforced by `tools/check-line-budget.mjs` in
`make verify`. Tests live beside the module (`#[cfg(test)]`) or in `crates/*/tests/`; the
budget counts them too, which keeps test files from becoming the new monolith.

### 2. Crate boundaries

`omp-protocol`:

- knows bytes, JSON, protocol versions, limits, and the command catalog;
- has no clock, no filesystem, no process, no async runtime;
- is the only crate allowed to name `rpc_chunk`, `extension_ui_response`, or a command type;
- owns the fixture replay helpers so both unit tests and `omp-console` contract tests use the
  same loader.

`omp-console`:

- owns process supervision, the registry, HTTP/WS, static assets, config, sessions, and
  filesystem browsing;
- consumes protocol views and forwards validated bytes;
- never re-implements a frame shape.

`web`:

- owns presentation, the reducer, drafts, attachments, and keyboard behaviour;
- mirrors `omp-protocol` types in `web/src/protocol/types.ts`, checked by fixture replay.

### 3. One binary, one port, embedded assets

`rust-embed` embeds `web/dist` at compile time:

```rust
#[derive(RustEmbed)]
#[folder = "$CARGO_MANIFEST_DIR/../../web/dist"]
struct WebAssets;
```

- `make build` builds `web/dist` **before** cargo, so a clean clone cannot produce a binary
  without a UI.
- `OMP_CONSOLE_STATIC=<dir>` overrides the embed at runtime for development; when set, files
  are read from disk and missing files are an error, not a silent fallback.
- Hashed asset names get `Cache-Control: public, max-age=31536000, immutable`. `index.html`
  gets `no-cache`. Unknown paths return `index.html` only when the request accepts HTML and
  does not start with `/api` or `/ws`; otherwise `404`.
- Bind is `127.0.0.1:8787`. A non-loopback bind requires `OMP_CONSOLE_ALLOW_REMOTE=1` and is
  logged as a security downgrade. There is no second port and no separate dev server in
  production.

### 4. Configuration

Read once at startup, validated, printed as a resolved table (never secrets — there are none):

| Variable | Default | Notes |
| --- | --- | --- |
| `OMP_CONSOLE_ADDR` | `127.0.0.1:8787` | `SocketAddr`; non-loopback gated |
| `OMP_BIN` | `omp` | resolved via `PATH`; recorded in `/api/info` |
| `OMP_CONSOLE_SESSIONS` | `~/.omp/agent/sessions` | read-only scan root and resume root |
| `OMP_CONSOLE_MAX_THREADS` | `8` | clamp 1..64, enforced under a create lock |
| `OMP_CONSOLE_WS_SLOTS` | `16` | clamp 1..64 |
| `OMP_CONSOLE_ALLOWED_HOSTS` | loopback host:port forms | comma list, lowercased |
| `OMP_CONSOLE_ALLOWED_ORIGINS` | loopback forms | only Vite origin when dev mode is on |
| `OMP_CONSOLE_DEV` | `0` | allows the Vite `:5173` origin and loose asset caching |
| `OMP_CONSOLE_ALLOW_REMOTE` | `0` | explicit non-loopback bind |
| `OMP_CONSOLE_SKIP_VERSION_CHECK` | `0` | deliberate unverified-omp override |
| `RUST_LOG` | `omp_console=info` | tracing filter |

`OMP_*` variables inherited by the child are passed through (they are how `omp` is
configured), except `PI_NO_TITLE=1` which the console sets. The child's environment is not
otherwise rewritten.

### 5. Process supervision

One `omp` child per session. The console never runs a model call itself.

Spawn:

```text
omp --mode rpc-ui --cwd <canonical cwd>
    [--allow-home]                 only when cwd == $HOME
    [--resume <canonical .jsonl>]
    [--model=<provider/model>] [--thinking=<level>]
    stdin/stdout/stderr piped, process group 0, kill_on_drop true
```

The child is placed in its **own process group** (`Command::process_group(0)` on Unix). Force
teardown signals the whole group, so bash/tool grandchildren cannot survive. This is the fix
for A2.

State machine (server-internal, per session):

```
Spawning ──spawn ok──▶ AwaitingReady ──ready──▶ Negotiating ──neg ok──▶ Ready
    │                       │                       │                   │
    └──spawn err──▶ Failed   └────child exit─────────┴────child exit────┴──▶ Exited
                                                                           │
                                              remove / prune ──────────────▶ Removed
```

The UI sees `starting | ready | exited` plus `protocol: {version, delta, eventFilter}` and
`exitCode`. `Failed` is `exited` with an error string and no pid.

Teardown sequence (`remove`, shutdown, or stop-all):

1. mark `Stopping`; stop accepting commands;
2. send `{"type":"abort"}` without waiting on a full command channel;
3. close stdin (writer loop ends, child sees EOF);
4. wait up to **1.5 s** for exit;
5. send `SIGTERM` to the process group; wait up to **1 s**;
6. send `SIGKILL` to the process group; wait up to **1 s**;
7. publish `Exited` even if the child is still unkillable, and log the pid.

The waiter owns the `Child`; a `watch` channel requests group signals so PID reuse is
irrelevant. `stop_all` runs every session concurrently under a **5 s** overall deadline, then
returns; shutdown does not hang on one bad child.

Reader loops:

- stdout: capped line reader → protocol frame validation → metadata tracking → `FrameRing`;
- stderr: 240-line / 64 KiB ring, each line capped at 2,000 chars, exposed at
  `/api/threads/{id}/stderr` for diagnosis;
- writer: bounded `mpsc` (128). A full queue means the child stopped reading; the command is
  rejected with a notice instead of blocking the WebSocket handler.

### 6. Frame fan-out

`ring.rs` implements `FrameRing`: `VecDeque<Arc<Bytes>>` plus a retained-byte counter, capped
at 256 frames / 8 MiB. It exposes `subscribe() -> FrameCursor` (current end), `next(cursor)`
returning `Frame | Lagged(n) | Wait`, and a `Notify`. A WebSocket holds at most one cursor
(its viewed session). Switching `view` drops the old cursor; a late attach replays the ring
from its start, so `ready` and early frames are not lost.

Lifecycle events (upsert/remove) use a separate `tokio::sync::broadcast` with a small buffer;
a lagged lifecycle subscriber resynchronizes from `GET /api/threads` (the client already does).

Memory bound per session: ring 8 MiB + stderr 64 KiB + dialogs (≤64 requests) + one chunk
sequence (≤64 MiB) + process baseline. The chunk buffer is transient and exists only while a
sequence is in flight.

### 7. HTTP surface

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/healthz` | `ok`, no config leakage |
| `GET` | `/api/info` | version, resolved omp path/version/support, limits, session root, dev flag |
| `GET` | `/api/threads` | running/known sessions |
| `POST` | `/api/threads` | `{cwd?, resume?, model?, thinking?}` → `ThreadInfo` |
| `DELETE` | `/api/threads/{id}` | graceful stop, remove, return `{ok:true}` |
| `GET` | `/api/threads/{id}/stderr` | bounded stderr lines |
| `GET` | `/api/recent` | `?cwd=&limit=` recent session headers |
| `GET` | `/api/fs` | `?path=` folder listing (read-only) |
| `GET` | `/ws` | multiplexed session stream |

Errors are `{ "error": string, "code"?: string }` with 400/403/404/409/429/500. The API
never returns a path outside what the request asked for. Body limit: 1 MiB on
`POST /api/threads` (there is no other JSON body).

### 8. WebSocket protocol

Server → client:

| `op` | Payload |
| --- | --- |
| `hello` | `{version, protocol, threads}` once on connect |
| `thread` | `{thread}` on lifecycle/meta change |
| `thread_removed` | `{id}` |
| `frame` | `{thread, frame}` — validated raw child frame |
| `lagged` | `{thread, skipped}` |
| `notice` | `{thread, level, message}` |

Client → server:

```json
{"op":"view","thread":"<id>"}
{"op":"command","thread":"<id>","frame":{...}}
{"op":"ping"}
```

`view:null` unsubscribes. A socket that is not viewing a session still receives lifecycle
events and notices. The server sends `pong` for `ping`; the client pings every 25 s and the
server closes a socket that has sent nothing for 90 s (heartbeat is new relative to the PoC).

### 9. Security module

`http::guard` runs before routing and does exactly four things:

1. `Host` must be in the allowlist → else `421`.
2. `Sec-Fetch-Site: cross-site` → `403`.
3. For WebSocket upgrades and unsafe methods, `Origin` must be in the allowlist and not
   `null` → else `403`.
4. Attach `nosniff`, `DENY`, `no-referrer`, and CSP:
   `default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline';
   script-src 'self'; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none';
   frame-ancestors 'none'`.

The theme bootstrap is an external `web/public/theme-boot.js` classic script, so
`script-src` needs no `'unsafe-inline'`. Inline `style` attributes from React still require
`style-src 'unsafe-inline'`; no untrusted HTML is ever inserted.

The Vite origin is allowlisted only when `OMP_CONSOLE_DEV=1`. Production does not trust
localhost:5173.

`fsbrowse` is intentionally unrestricted read-only listing: choosing any working folder is the
product. Writes do not exist. Resume is the opposite: canonicalized, under the session root,
regular file, `.jsonl` only.

The threat model is in `SECURITY.md`: loopback, no auth, any local process can connect, and
binding to `0.0.0.0` without a proxy is a documented downgrade.

### 10. Session discovery

`sessions.rs` parses headers line-by-line with a 32-line / 64 KiB budget (not a single 16 KiB
read). A header is accepted when a `{"type":"session"}` line yields `cwd` and `id`; a title
line may appear before or after it. Malformed lines are skipped. The recent cache is 10 s,
single-flight, and **invalidated** when a session is closed or renamed, so Saved history is
fresh at the moment the user expects it.

The scan is root → project dir → `*.jsonl`, newest first, capped at 240 files. Titles are
control-character stripped and truncated; a missing title becomes `Untitled · <id prefix>`.

### 11. Frontend architecture

- React 19, TypeScript strict, Vite, no UI framework (no component library, no state library).
  The ADR for the UI system is 0003; the store is justified here.
- `web/src/store/` is a hand-rolled normalized store with **per-session** and **per-message**
  subscriptions. The transcript subscribes to the ordered key list; each row subscribes to its
  own message version. A streaming token wakes one row, not the app.
- Frames are reduced synchronously into immutable per-message records; text deltas append to a
  chunk list and materialize on `text_end` (avoids O(n²) string concatenation). Coalescing:
  at most one render per animation frame per row.
- The reducer is pure: `reduce(state, envelope) -> state` (or a small command result), so
  Vitest can replay fixtures without a DOM.
- Drafts persist per session id in `localStorage` (bounded: 64 KiB per session, 20 sessions);
  the draft is cleared on successful send and on session close. This fixes the PoC's "draft
  saved" claim.
- Static assets are content-hashed by Vite; the embedded binary is the only artifact.

### 12. Testing seams

| Layer | How it is tested |
| --- | --- |
| `omp-protocol` | pure unit tests + fixture replay; no async, no process |
| `omp-console` | `tower::ServiceExt::oneshot` against `app(state)` for guards/API; temp dirs for sessions |
| process lifecycle | integration test spawns `tools/stub-omp.mjs` (or a compiled stub in CI), including a grandchild and a pid file |
| web reducer | Vitest + fixture replay |
| components | Testing Library, jsdom, no network |
| journey | Playwright against a real `omp-console` binary with `OMP_BIN` pointing at the stub |
| live | one hand-driven run against real `omp`, recorded in `docs/validation.md` |

The stub `omp` is a scriptable process fixture: it reads commands, emits fixture frames with
small delays, can spawn a grandchild, can ignore SIGTERM for the teardown test, and can hang
stdout for the cap test. It never calls a model.

### 13. Dependencies

Keep the tree boring and small:

| Crate | Why |
| --- | --- |
| `axum` 0.8 (`ws`, `json`) | HTTP/WS, already proven in the PoC |
| `tokio` 1 (`rt-multi-thread`, `macros`, `process`, `io-util`, `sync`, `time`, `fs`, `net`, `signal`) | runtime and child process |
| `serde`, `serde_json` (`raw_value`) | wire types, borrowed views, raw forwarding |
| `bytes` | ref-counted frame buffers |
| `base64` | chunk decode with strict re-encode check |
| `rust-embed` | one-binary install |
| `mime_guess` | embedded asset content types |
| `tracing`, `tracing-subscriber` | logs |
| `uuid` v4 | session ids (opaque, not security-sensitive) |
| `libc` (Unix) | process-group signals |
| `tower-http` | only if it earns its place; static files are handled directly from embed |

No `parking_lot` (std/tokio locks suffice). No `clap` (four flags and env config; a manual
`--help`/`--version` is smaller). No ORM, no database, no telemetry, no analytics.

### 14. Build and release profile

```toml
[profile.release]
lto = "thin"
codegen-units = 16
panic = "abort"
strip = true
```

`codegen-units = 16` is a deliberate build-time choice over the PoC's `1`; binary size is
measured in `evaluation.md`. `make verify` builds release once at the end; CI caches
`target/`.

## Consequences

- A clean clone builds the web bundle first; `cargo build` alone does not produce a usable
  binary without `web/dist`. The Makefile owns the order, and `build.rs` emits a clear
  compile error if the folder is missing.
- The protocol crate cannot use tokio, which keeps its tests instant and its API honest.
- Process-group teardown is Unix-specific. Windows is out of scope for v1.0; the binary
  compiles on Unix targets only in CI (darwin/linux).
- The command allowlist means adding a feature is a deliberate two-sided change (protocol
  catalog + UI + test), not an accidental capability.
- The 600-line budget forces the PoC's `thread.rs` to split into `child`, `thread`, `ring`,
  and `supervisor` — each independently testable.

## Alternatives considered

| Alternative | Rejected because |
| --- | --- |
| Keep one crate and split files only | protocol tests would still need tokio/axum in scope; the boundary would erode |
| Put protocol types in `omp-console` | the web/TS mirror would have no independent reference; the PoC already showed the drift |
| Serve assets from `web/dist` on disk | not installable as one binary; the release story becomes a folder |
| Separate frontend server in production | two ports, two origins, a wider guard surface |
| Use `tokio::sync::broadcast` for frames | counts messages, not bytes; cannot bound memory |
| Kill only the direct child | leaves bash/tool grandchildren; fails A2 |
| `stop_all` without a deadline | one stuck child hangs shutdown forever |
| Virtualize every transcript row from day one | more machinery than needed if row-level subscriptions + containment meet the 10k budget; the decision is measured in evaluate and may promote to full windowing |

## Open questions resolved during code (recorded, not blocking approval)

- Exact `FrameRing` wait/notify API (Notify vs watch) — benchmarked in the test phase.
- Whether `get_messages_page` replaces `get_messages` for histories over 2,000 messages —
  measured against a synthetic 10k session in evaluate.
- Whether the plan panel becomes a third column at ≥1280 px or an overlay at all widths —
  measured in validation screenshots.
