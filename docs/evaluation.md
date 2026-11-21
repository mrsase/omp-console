# Evaluation — omp-console v1.0.0

**Date:** 2026-11-21 · **Owner:** @mrsase
**Decision: GO** — ship `v1.0.0` with the known gaps below.

The bar was A1–A12 in `docs/v1-design.md`. Every criterion below has a command,
test name, or screenshot behind it. Numbers are from this machine and the
release build, not estimates.

## Measured

| Metric | Value | Source |
| --- | --- | --- |
| Rust LOC | **5,312 lines** (4,633 production, 33 files) | `node tools/measure.mjs` |
| Web source | **11,099 lines** (9,785 production, 60 files) | same |
| Tooling | 2,974 lines (13 files) | same |
| Rust tests | **54** | `cargo test --workspace` |
| Web tests | **61** in 7 files | `bun run test -- --run` |
| Browser journeys | **12** (includes axe light + dark) | `make validate` |
| Release binary size | **3.2 MB** stripped | `target/release/omp-console` |
| JS bundle | 383.4 kB raw / **115.1 kB gzip** | `vite build` |
| CSS | 41.3 kB raw / **8.0 kB gzip** | `vite build` |
| Fonts | **98.3 kB** (5 latin woff2, self-hosted) | `vite build` |
| Idle console RSS | **2.1 MB** | `ps -o rss`, release, no session |
| Console TTFT (stub) | **15 ms median**, p95 52 ms | `tools/measure-ttft.mjs` |
| Real TTFT | **5.8 s** (provider-bound, one sample) | live Playwright run |
| 10k events: long tasks >100 ms | **0** (max 0 ms) | `tools/perf-10k.mjs` |
| 10k events: DOM rows | **34** (virtualized) | same |
| 10k events: heap | 3.9 → 14.8 MB (**+11.0 MB**) | same |
| 10k events: scroll | 113 steps, no stall | same |
| 10k stream duration | 2.32 s | same |
| `make verify` | **exit 0**, 47.6 s | `docs/verification.md` |
| `make validate` | **exit 0**, 12 journeys | `docs/validation.md` |

### Performance baseline that forced a change

Before row virtualization and delta coalescing, the same harness reported
`rows=626, longTasks>100ms=1, max=147 ms, heap +20.3 MB, FAIL`. The current
result is 34 DOM rows, zero long tasks, +11 MB. The transcript now virtualizes
top-level rows and coalesces streaming deltas to one update per animation frame.

## Acceptance criteria

| # | Verdict | Evidence |
| --- | --- | --- |
| **A1** One binary, UI on 127.0.0.1 | ✅ | Release binary serves the embedded bundle (`curl /` returns the app, screenshot `desktop-dark.png`); `embed`/API tests; no `web/dist` needed at runtime. |
| **A2** No orphan processes | ✅ | `crates/omp-console/tests/lifecycle.rs::ready_cap_and_no_orphan_grandchild` and `sigterm_is_escalated_to_sigkill`; process-group teardown kills a recorded grandchild. |
| **A3** Multi-session cap and teardown | ✅ | `lifecycle.rs` cap test (second create → `TooMany`); `Supervisor::stop_all` 5 s deadline; journey opens/switches/closes sessions. |
| **A4** Streaming text/thinking/tools | ✅ | Fixture replay in Rust (30 protocol tests) and Vitest; `journey.spec.ts` shows prose, bash tool row with live duration, completion; screenshots. |
| **A5** Steer, queue, remove, stop, restore | ✅ | `control.spec.ts` steer + stop/restore; reducer queue tests; `queue_update` rendered from the child, not optimistic. |
| **A6** Ask and approvals round-trip | ✅ | `journey.spec.ts` approval sheet then ask field (`Red`); `ask-dark.png`, `approval-dark.png`; rich `ask` covered by component/reducer tests (the rich method is extension-only; the `ask` tool uses field-by-field selects in RPC). |
| **A7** Resume a real session | ✅ | `resume.spec.ts` closes and resumes from Saved with the transcript; real live run produced a session file and the UI hydrated it. |
| **A8** Model/thinking apply next turn | ✅ | `settings.spec.ts` asserts `set_model`/`set_thinking_level` and the confirming `get_state`; live session shows DeepSeek V4.1 Flash and `off`. |
| **A9** Attachments compress and send | ✅ | `attachments.spec.ts` uploads a PNG, asserts `image/jpeg` data URL, sends, and renders the prompt image; 6 unit tests cover caps/compression. |
| **A10** 10k events responsive and bounded | ✅ | `perf-10k.mjs`: 0 long tasks >100 ms, +11 MB, 113 scroll steps. |
| **A11** Host/Origin/traversal/oversize rejected | ✅ | `security.spec.ts` (421/403/health), HTTP guard tests, resume symlink/traversal tests, 70 KiB body and non-directory browse rejection, command caps. |
| **A12** Unknown frames surfaced; range documented | ✅ | `unknown.spec.ts` shows a protocol row/drawer; Rust and TS replay `unknown.jsonl`; README documents 18.x, tested 18.18.8, refusal + override. |

## Known gaps (accepted for v1.0)

- **macOS and Linux only.** Windows has no process-group equivalent in this
  design; it is explicitly not a v1.0 target.
- **No authentication and loopback only.** A local process can connect; this is
  the documented threat model. Remote bind is an explicit, logged downgrade.
- **The rich `ask` method is extension-only.** The `ask` tool in RPC mode is
  walked field by field; the console renders it faithfully but cannot show the
  original HTML form as one layout.
- **Huge single hydration frames.** A `get_messages` response over the 8 MiB ring
  budget is retained as one frame up to the protocol ceiling; histories far
  beyond 10k messages may need the paging command in a future release.
- **No live subagent lane, session tree/branch editor, goal mode, voice or host
  tools.** Reasons and prerequisites are in `docs/v1-design.md` §6.
- **The live TTFT is provider-bound** (5.8 s for the cheap model used). The
  console's own contribution is 15 ms median on the stub.
- **No Windows builds in CI.** Release targets are darwin-arm64, darwin-x64 and
  linux-x64.

## Decision

**GO.** The seven surfaces are reachable and tested; the gates are green; the
security posture is unchanged and covered; the 10k budget passes after a real
fix rather than a budget change. The gaps are documented product boundaries, not
unfinished work.

Signed: @mrsase · 2026-11-21
