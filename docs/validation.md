# Validation — v1.0.0

**Date:** 2026-11-21 · **Machine:** macOS 14.6 (x64) · **omp:** 18.18.8 ·
**Model:** `opencode-go/deepseek-v4.1-flash` · **Chrome:** 159 (Playwright `channel: chrome`)

Evidence is screenshots and measured output, not intentions. The stub journey is
repeatable and runs in CI. The live run is labelled and is not required in CI.

## 1. Gate: `make validate`

`make validate` rebuilt the web bundle, rebuilt the debug binary, and ran the
Playwright suite against the stub `omp`:

```
✓ a11y light            2.3s
✓ a11y dark             2.4s
✓ steer                6.5s
✓ stop + restore       2.0s
✓ journey              6.7s
✓ resume               7.0s
✓ Host 421             9ms
✓ Origin 403           3ms
✓ health               6ms
✓ settings             1.8s
✓ unknown frame        1.4s
✓ attachments          2.4s

12 passed (35.4s)
```

`make validate` exits **0** and prints the manual live-run reminder. The axe
passes are real; `@axe-core/playwright` is installed and the test fails on
serious/critical violations in both themes.

## 2. Live run against the real `omp`

The release binary was started on loopback with a throwaway session root, then
the hand-run check drove a real child:

```bash
OMP_CONSOLE_SESSIONS=/tmp/omp-ship-sessions ./target/release/omp-console
OMP_CONSOLE_URL=http://127.0.0.1:8804 \
  node tools/live-check.mjs --cwd /tmp/omp-ship-work \
  --model opencode-go/deepseek-v4.1-flash
```

```
guards ok
console 0.1.0; omp 18.18.8 supported=true
session aa298427-e94c-4d53-9243-24f71c6b1eb7 in /private/tmp/omp-ship-work
model opencode-go/deepseek-v4.1-flash; thinking off
prompt completed and a tool ran
PASS
```

The checks include the 421 foreign-Host and 403 cross-site-Origin guards before
creating the session. The prompt asked for one bash execution and a terminal
reply; the run observed `tool_execution_end` and a completed `prompt_result`.

A second real session was driven through the browser to produce the screenshots
below. Its prompt-derived title appears in the header and rail; the session
resumed and streamed a bash tool row and `LIVE-OK`.

## 3. Screenshots

| File | What it shows |
| --- | --- |
| `docs/screenshots/desktop-dark.png` | Real omp session, dark theme: rail, status bar, time gutter, prompt, streamed prose, bash tool row, turn rules, settled row, composer. |
| `docs/screenshots/desktop-light.png` | The same session in the light (drafting paper) theme. |
| `docs/screenshots/mobile-dark.png` | 390×844, dark: drawer closed, single-column transcript, time gutter, composer. |
| `docs/screenshots/mobile-light.png` | 390×844, light theme, hydrated saved session. |
| `docs/screenshots/approval-dark.png` | Stub approval sheet: structured `Allow bash?`, command block, numbered options, safe default focused. |
| `docs/screenshots/ask-dark.png` | Stub `ask` field sheet after approval (`Red`/`Blue`/free text). |
| `docs/screenshots/desktop-plan.png` | Plan panel with phases, task states and progress rule. |

The approval and ask shots use the scripted stub so the dialog state is
deterministic; the desktop/mobile session shots are the real `omp` run. All were
captured from the release bundle with Chrome, not a Vite dev server.

## 4. Responsive and keyboard checks

- 1440×900, 1280×800, 390×844, and the Playwright a11y viewport render without
  page horizontal scroll; the composer stays inside the viewport.
- At 390 px the rail is a drawer, the header collapses workspace/model into
  settings, the plan panel is an overlay and no longer auto-opens, and the time
  gutter fits without overlapping the lane.
- Keyboard paths exercised: Enter send/steer, Shift+Enter newline, slash palette
  arrows/Enter/Escape, dialog focus trap and Escape, plan close, focus
  restoration, and IME-safe Enter (`isComposing`).
- Light and dark themes both pass axe at serious/critical.

## 5. Timings

| Measurement | Command | Result |
| --- | --- | --- |
| Console time-to-first-visible-token (stub, 0 ms model) | `node tools/measure-ttft.mjs` | 12, 14, 15, 16, 52 ms; **median 15 ms**, p95 52 ms |
| Real end-to-end TTFT (provider included) | Playwright against the live session above | **5.8 s** (one sample; provider-bound) |
| 10k-event transcript | `OMP_CONSOLE_BIN=target/debug/omp-console node tools/perf-10k.mjs` | **0 long tasks >100 ms**, max 0 ms, rows in DOM 34, heap 3.9→14.8 MB (+11.0), 113 scroll steps, stream 2.32 s |
| Idle release RSS | `ps -o rss` after start, no session | **2.1 MB** |

The 10k run uses the `events` stub scenario and measures after app boot; it
scrolls the transcript to the bottom in 113 steps. The earlier pre-virtualization
run had a 147 ms task and is recorded in `docs/evaluation.md` as the reason for
the change.

## 6. Manual review notes

- Session title is derived from the first prompt and appears in the header and
  rail; the rail keeps the full title in a tooltip.
- Saved history lists closed sessions and excludes the open one; resume from
  Saved restores the transcript and allows another prompt.
- Stop with queued input restores the draft once; a second stop does not
  duplicate it.
- Unknown frames render as a bounded protocol row with a drawer and count; the
  child's unknown `notify` frame is visible rather than dropped.
- The plan panel opens automatically only at ≥1280 px; below that it is a sheet
  and Escape closes it.
- No file outside `~/workPlace/omp-console` was modified; the PoC
  remains read-only and is archived on `poc` / `poc-archive`.
