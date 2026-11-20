# v1.0 design — omp-console

**Status:** approved 2026-11-21 · owner @mrsase
**Target:** public `v1.0.0`, MIT, one binary
**Cycle:** `docs/CYCLE.md` · **Protocol:** `docs/adr/0001` · **Architecture:** `docs/adr/0002` ·
**UI:** `docs/adr/0003` + `docs/DESIGN.md` · **Evidence:** `docs/poc-findings.md`

## 1. The promise

> A local console for `omp` sessions that you install on a new machine and use all day:
> spawn real sessions in any folder, watch text, thinking, tools and dialogs stream in,
> steer a running turn, answer approvals, and resume yesterday's session — one binary, one
> loopback port, no accounts, no cloud, no telemetry.

It is an **unofficial console for the omp harness**. It does not reimplement the agent, does
not edit omp's session files, and does not send anything anywhere.

## 2. Why a rewrite, not a polish

The PoC proves the protocol and the flows but cannot be shipped: no git history, no CI, no
frontend tests, a checked-in build artifact with no source install path, one 1,288-line
process module, one 3,397-line stylesheet, a README with unmeasured and inaccurate claims, and
a count-only frame ring that can retain hundreds of megabytes per session.

The rewrite keeps the hard-won protocol knowledge (documented in `poc-findings.md` and
recorded as fixtures) and replaces the structure: a protocol library with contract tests, a
supervisor split by responsibility, a normalised frontend store with per-row subscriptions,
and a real design system.

## 3. Scope — the seven surfaces

### F1 · Sessions

Spawn with a working folder; optional model and thinking; concurrent sessions up to a
configurable cap (default 8); stop, close, fork, new-session-in-place; resume from omp's own
session files; title, cwd, session id/file, and status are always visible. A closed or crashed
session leaves its transcript on disk and appears under Saved history.

### F2 · Streaming transcript

Assistant markdown, thinking, tool calls with live partial output, tool results, terminal
executions, system events, compactions and branch summaries. Collapsed tool rows with expand;
timestamps and turn numbers; prompt outline and jump-to-latest; auto-follow that pauses when
the reader scrolls away and restores an anchored position through hydration and resize.

### F3 · Control

Steer mid-turn, queue a follow-up, remove a queued item, promote a follow-up, stop a turn,
and restore withdrawn queued input into the composer. The queue is rendered from the child's
`queuedMessages`/`queue_update`, not tracked optimistically.

### F4 · Dialogs

The `ask` tool (field-by-field in RPC mode) and the rich `ask` method; approvals; `select`,
`confirm`, `input`, `editor`; extension `notify`, `setStatus`, `setWidget`, `setTitle`,
`set_editor_text`, `open_url`; pre-attach replay for a late client; timeouts that defer to the
child.

### F5 · Session settings

Model picker (provider-grouped, searchable), thinking level from the child's advertised list,
auto-compaction, context usage ring, cost, total tokens, live token rate, and a 30-second
sparkline. Changes apply to the next turn and are confirmed by `get_state`.

### F6 · Composer

Slash-command palette with aliases, image attachments (max 4, JPEG-compressed to ≤150 KiB,
≤900 KiB command), drag-and-drop and paste, keyboard shortcuts, IME-safe submission, drafts
persisted per session, and a queue strip.

### F7 · Plan and themes

Plan/todos panel grouped by phase with progress and blockers; read mode; light and dark themes
from the design system; reduced motion; visible focus; 200% zoom.

## 4. Acceptance criteria

Each criterion is observable and has a command or a screenshot behind it. The proof column is
the gate; a claim without one is not done.

| # | Criterion | Proof |
| --- | --- | --- |
| **A1** | One binary runs and serves the UI on `127.0.0.1` with web assets embedded | Proof: `cargo build --release --workspace` then `./target/release/omp-console`; `crates/omp-console/tests/embed.rs::serves_embedded_index` (renames `web/dist` in a temp copy and still gets HTML); `docs/validation.md` §1 curl + screenshot |
| **A2** | Spawn/stop/kill leaves no orphan processes, including tool grandchildren | Proof: `cargo test -p omp-console --test lifecycle -- orphans_and_grandchildren` (stub spawns a grandchild, records pids, asserts both gone); `docs/validation.md` §2 `ps`/`pgrep` after stop and after SIGKILL |
| **A3** | Multiple sessions respect the cap and tear down cleanly | Proof: `cargo test -p omp-console --test lifecycle -- cap_and_teardown`; Playwright `sessions.spec.ts` opens 2, switches, closes both; validation §3 shows 8/8 → 9th rejected 429 |
| **A4** | Streaming text, thinking and tools show correct intermediate states | Proof: `cargo test -p omp-protocol --test contract -- stream_fixture`; `cd web && bun run test -- src/protocol/stream.test.ts`; Playwright `stream.spec.ts` sees partial text, a running tool, then done |
| **A5** | Steer, queue, remove queued, stop, restore queued input | Proof: reducer tests `src/protocol/queue.test.ts`; Playwright `control.spec.ts` drives all five against the stub; validation §4 screenshots |
| **A6** | `ask` dialog and approvals round-trip | Proof: Playwright `dialogs.spec.ts`: approval `select`, field-by-field ask, rich `ask`, confirm, cancel, timeout; validation §5 screenshot of each |
| **A7** | Resume a real session from disk | Proof: `cargo test -p omp-console --test resume -- real_header_and_containment`; `docs/validation.md` §6 resumes a live session captured in §1 and shows the hydrated transcript; live run (not CI) |
| **A8** | Model/thinking change applies to the next turn | Proof: Playwright `settings.spec.ts` asserts `set_model`/`set_thinking_level` frames and the next `get_state`; live run shows the new model on the next prompt |
| **A9** | Attachments compress and send within limits | Proof: `bun run test -- src/composer/attachments.test.ts` (canvas path, 4-image cap, size budget); Playwright `attachments.spec.ts` attaches a 3000×2000 PNG and asserts a JPEG under 150 KiB reached the child |
| **A10** | A 10k-event transcript stays responsive and bounded | Proof: `node tools/perf-10k.mjs` (Playwright): builds 10k fixture events, scrolls top-to-bottom, asserts no long task > 100 ms and memory growth < 50 MB; numbers recorded in `docs/evaluation.md` |
| **A11** | Origin/Host/traversal/oversized-payload attempts are rejected, with tests | Proof: `cargo test -p omp-console --test security` covers 421 Host, 403 Origin, cross-site, resume `../`, non-`.jsonl`, symlink escape, 1 MiB+ command, 1 MiB+ WS message; Playwright `security.spec.ts` repeats the two HTTP cases |
| **A12** | Unknown protocol frames are surfaced, never crash, and the supported omp range is documented | Proof: `cargo test -p omp-protocol --test contract -- unknown_fixture`; `bun run test -- src/protocol/unknown.test.ts` asserts a `protocol` row and count; `/api/info` reports version support; README has the version table; validation §8 shows the drawer |

Additional release invariants (not numbered criteria): no telemetry, no remote bind by
default, no write access to omp session files, MIT license, reproducible `make verify`.

## 5. Milestones

| Milestone | Delivers | Gate |
| --- | --- | --- |
| **M0 design** | ADRs, DESIGN, this file, findings, fixtures, gates | `make design-gate` + owner approval |
| **M1 protocol** | `omp-protocol`: frame, chunk, command, dialog, version, fixtures | `cargo test -p omp-protocol` |
| **M2 server shell** | workspace, config, guard, static embed, `/api/info`, `/healthz` | `cargo build`; `curl` on loopback |
| **M3 supervisor** | child spawn/teardown, ring, registry, WS, API, stub omp | `cargo test -p omp-console`; stub session streams |
| **M4 web core** | store, reducer, shell, rail, transcript, composer | `bun run test`; app streams and steers |
| **M5 web complete** | dialogs, plan, settings, attachments, themes, read mode | `bun run test`; all seven surfaces reachable |
| **M6 proof** | stub journey, perf harness, axe, screenshots | `make e2e`; `tools/perf-10k.mjs` |
| **M7 gates** | verification, validation, evaluation, ship | `make verify`; `make validate`; `make evaluate-gate`; `make ship-gate` |

Each milestone is a branch, squash-merged after its gate. No milestone starts before the
previous gate is green, except documentation work that does not touch product code.

## 6. Out of scope for v1.0

Multi-user/auth, remote hosting, a mobile-native UI, editing omp session files,
reimplementing the agent, telemetry/analytics, a plugin API, Windows builds, cloud sync,
accounts, and any network service other than loopback.

### Roadmap (with reasons)

| Idea | Why not v1.0 | What it needs |
| --- | --- | --- |
| Live subagent view | the protocol supports `set_subagent_subscription` and `subagent_*` frames, but it multiplies event volume and needs its own lane, filter and perf budget | subscription levels, a subagent rail, lag/resync design, 10k+ subagent events measured |
| Session tree / branch editor | `get_tree`, `branch`, `navigate_tree`, `set_label` exist, but branching is destructive-feeling and needs undo, diff and target-selection UX | tree model, branch preview, confirmation semantics, tests for aborted summaries |
| Goal mode, live voice, dictation, host tools/URIs | each is a separate product surface with its own permissions and failure modes | dedicated ADRs |
| Remote bind / auth | deliberately out of scope; binding to 0.0.0.0 without a proxy is a documented downgrade | threat model, auth, TLS, CSRF redesign |
| Plugin API | no consumer yet; would freeze internal types | a real extension use case |

## 7. Performance budget (targets, measured in evaluate)

| Metric | Target | How measured |
| --- | --- | --- |
| Console idle RSS | ≤ 20 MB (child excluded) | `/usr/bin/time -l` or `ps -o rss` on the release binary, 60 s idle |
| Per-session console memory | ≤ 12 MB retained (ring 8 MiB + overhead) | 1 session, 5 min stream, RSS delta |
| UI first paint (local) | ≤ 1.2 s | Playwright `performance.timing`/`PerformanceObserver`, 3 runs |
| Prompt → first visible token (console overhead) | ≤ 300 ms after the child's first `text_delta` | instrumented timestamp in e2e, stub with 0 ms model |
| 10k events scroll | no long task > 100 ms; p95 frame < 32 ms | `tools/perf-10k.mjs` Long Tasks API |
| 10k events memory | growth < 50 MB over the run; no unbounded pattern | CDP `Performance.getMetrics` before/after |
| Initial JS | ≤ 220 KB gzip | `vite build` report |
| CSS | ≤ 30 KB gzip | `vite build` report |
| Fonts | ≤ 160 KB total (woff2, latin) | file sizes |
| Binary | ≤ 12 MB stripped | release binary |

If a target misses, `evaluation.md` records the number and the trade-off; it is not rounded
into a claim.

## 8. Test plan (summary)

- **Protocol (Rust):** every fixture replayed; chunk acceptance and every invalid vector;
  command allowlist/fields/caps; version parsing; unknown vs malformed.
- **Server (Rust):** guard (Host/Origin/Sec-Fetch-Site), resume containment (traversal,
  symlink, extension, non-file), cap enforcement, ring bounds and lagged resync, lifecycle
  teardown with a grandchild, stderr bounds, static fallback, API errors.
- **Contract:** the same JSONL fixtures through the Rust parser and the TS reducer; a fixture
  change that breaks either side fails both suites.
- **Web unit:** reducer (stream, hydration, queue, dialogs, unknown), tagged-content parser,
  markdown renderer safety, draft persistence, attachment compression, formatters.
- **Components:** transcript lanes, tool expand, approval sheet, ask form, composer keyboard
  and IME, plan panel, theme switch, focus trap/restore.
- **Journey (Playwright, stub omp):** create → stream → tool → approval → ask → steer → stop →
  resume, plus axe on the main screen.
- **Live (manual):** one cheap-model run against real `omp`, screenshots and timings in
  validation; not required in CI.
- **Performance:** the 10k harness and the bundle report above.

The stub `omp` is scriptable: delays, a grandchild, SIGTERM-ignore, chunked frames, ask and
approval dialogs, error responses, and a 10k-event mode. No model, no network, no credits.

## 9. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| `omp` changes frames between 18.x patches | version gate, fixtures, unknown-frame evidence, contract tests; patch changes are additive by policy |
| Rewrite loses a proven behaviour | `poc-findings.md` is the checklist; validation walks the PoC's verified flows |
| 10k transcript misses the budget | per-row subscriptions + chunked text + containment first; full windowing is the designed fallback |
| Orphaned processes on kill | process group, staged SIGTERM/SIGKILL, grandchild test, `stop_all` deadline |
| Resume accepts an unsafe path | canonicalize, root check, regular file, `.jsonl`, symlink tests |
| Command allowlist breaks a needed flow | the allowlist is explicit and tested; adding one is a documented change with a test |
| Live run spends credits | one cheap model, one short prompt, `--max-cost` on the manual run where supported |
| CI too slow / machine low on resources | single verify job with caches, no matrix, no watch mode; local loop uses narrow tests |
| UI identity becomes decoration | DESIGN.md rules and a hex-color test; validation screenshots at 320/768/1440, both themes |
| Fonts inflate the bundle | subset woff2, measured; system-stack fallback documented |

## 10. Definition of shipped

A stranger installs one binary from the release or `cargo install`, points it at `omp`, and
gets a working console: sessions, streaming, steering, dialogs, resume, settings, both themes.

- `make verify` green and recorded in `docs/verification.md` with versions.
- `make validate` green (stub journey) and one live run recorded with screenshots and timings
  in `docs/validation.md`.
- `docs/evaluation.md` signed **GO** against A1–A12 with measured numbers.
- Public repo `mrsase/omp-console` ( `mrsase/omp-web` was checked and is unavailable ),
  MIT, SECURITY with the threat model, CHANGELOG, README with real screenshots and supported
  versions.
- CI green on the tagged commit; `v1.0.0` release with darwin-arm64, darwin-x64 and linux-x64
  binaries, checksums, and notes.
- The PoC preserved on `poc` at tag `poc-archive`; no file outside `omp-console` modified.

## 11. Approval

Approved by mrsase on 2026-11-21 — ADR 0001 protocol contract, ADR 0002 architecture,
ADR 0003 UI identity (+ `docs/DESIGN.md`), scope and non-goals, and A1–A12 with their proofs.
The three ADRs are marked `Status: Accepted`; product code starts at M1.
