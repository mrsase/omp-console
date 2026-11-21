# Verification — v1.0.0

**Date:** 2026-11-21 · **Machine:** macOS 14.6 (x64) · **Rust:** 1.95.0 ·
**Bun:** 1.4.4 · **Node:** 26.7.0 · **omp:** 18.18.8 · **Chrome:** 159 (Playwright, `channel: chrome`)

**Gate:** `make verify` (CI runs exactly this command; `make e2e` is the additional CI job)

## Results

| Step | Command | Result |
| --- | --- | --- |
| Format | `cargo fmt --all -- --check` | ✅ clean |
| Rust tests | `cargo test --workspace` | ✅ **54 tests** (protocol 22 + contract 8; server 15 + API 6 + lifecycle 2 + WS 1) |
| Clippy | `cargo clippy --workspace --all-targets -- -D warnings` | ✅ 0 warnings |
| Web install | `cd web && bun install --frozen-lockfile` | ✅ lockfile honored |
| Types | `bun run typecheck` | ✅ 0 errors |
| Lint | `bun run lint` (oxlint) | ✅ 0 warnings |
| Web tests | `bun run test -- --run` | ✅ **61 tests** in 7 files |
| Web build | `bun run build` | ✅ 72 modules; JS 383.39 kB / **115.13 kB gzip**; CSS 41.34 kB / 8.03 kB gzip; fonts 98.3 kB |
| Release build | `cargo build --release --workspace` | ✅ `target/release/omp-console`, **3.2 MB** stripped |
| File budget | `node tools/check-line-budget.mjs` | ✅ **102 files**, all ≤600 lines |

`make verify` exits **0**. The run took 56.0 s on this machine, of which the release
build was 30.2 s.

```
$ make verify
...
test result: ok. 15 passed; 0 failed
test result: ok. 6 passed; 0 failed
test result: ok. 2 passed; 0 failed
test result: ok. 1 passed; 0 failed
test result: ok. 22 passed; 0 failed
test result: ok. 8 passed; 0 failed
 Test Files  7 passed (7)
      Tests  61 passed (61)
...
✓ built in 1.50s
    Finished `release` profile [optimized] target(s) in 30.23s
line budget: 102 file(s) checked, all within 600 lines.
```

## What the Rust tests prove

- `omp-protocol`: fixture replay (handshake, stream, resume, dialogs, commands,
  unknown), exact v2 chunk acceptance and every invalid vector, command allowlist
  and field validation, dialog shapes, version parsing, raw-byte preservation.
- `omp-console`: Host/Origin/Sec-Fetch-Site guards, security headers, static
  fallback and traversal rejection, session header parsing (direct and nested
  layouts), resume containment including a symlink escape, folder browsing,
  oversized bodies, the byte-bounded ring and lag accounting, dialog queue
  bounds, WebSocket hello/command/allowlist against a real child fixture, and
  process-group teardown of a grandchild (including SIGTERM-ignoring child).

## What the web tests prove

- Every committed fixture through `reduceEnvelope`; lane renders; queue updates;
  dialog parsing for approvals and all `ask` forms; unknown-frame evidence;
  hydration merge; `session_busy` retry; draft persistence; attachment
  compression and caps; composer keyboard/IME; plan; themes; virtualized
  transcript; focus trap and restoration.

## Not covered here

- Playwright journeys and the live run → `docs/validation.md`.
- Windows (not a v1.0 target).
- Multi-user or remote deployments (explicit non-goals).
