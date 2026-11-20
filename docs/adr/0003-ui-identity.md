# ADR 0003 — UI identity

**Status:** Accepted · 2026-11-21 · owner @mrsase
**Supersedes:** `web/src/styles.css` (3,397 lines, no system)
**Normative detail:** `docs/DESIGN.md`
**Skills consulted:** `impeccable` (Operate mode) and `frontend-design`

## Context

The PoC's UI is competent but generic: chat bubbles, an "o" avatar, rounded cards for tools,
a sidebar of identical rows, and one 3,397-line stylesheet that grew by accretion. It reads
as a chat app that happens to run an agent. The product is not a chat app; it is a control
surface for a long-running process that emits text, reasoning, tool calls, dialogs, plans and
cost data. A person uses it for an hour at a time, scanning for what changed, what failed, and
what needs an answer.

The surface mode is **Operate**: the visitor's success is completing a task, so scanability,
consistency, native expectations and the real usage scene outrank expression. Brand lives in
precise details, not decoration. The usage scene: a developer at a desk, one or two windows,
a terminal nearby, long sessions, keyboard-first, often in a dim room, sometimes in daylight.
Two themes are required because both scenes are real.

## Decision

### 1. World: the bench instrument, not the chat window

The console is a **flight recorder for an agent turn**: a timeline with a time gutter, lane
spines, and evidence that can be inspected. The reference object is a bench instrument —
oscilloscope traces, a patch bay, a labelled panel — not a messaging app.

Concretely:

- **No bubbles and no avatars.** The transcript is a ruled timeline. The person's prompt is a
  tinted block with a left rule labelled `you` and a turn number; the assistant's prose is
  plain text in the reading column; thinking is a collapsed dotted-amber strip; tools are log
  rows; system events are hairline rows with a diamond.
- **Turn numbers are real**, so they are shown. They are the only numbered markers.
- **A time gutter** (HH:MM:SS) and a 2px lane spine carry structure; metadata is not a string
  joined with middots.
- **The header is an instrument status bar**: title, cwd, model, thinking, context ring,
  cost, and a 60px token-rate sparkline for the last 30 seconds. No hero, no stat cards.
- **The session rail is a patch bay**: rows with a status tick, title, cwd and age; no cards,
  no icons per row except on hover/focus.
- **The composer is a command line**, not a chat box: a leading prompt glyph, a prose field,
  and a state strip (`Enter sends` / `Steering` / `Queueing`), with the queue chips above it.

This is deliberately not a "dashboard". There are no KPI tiles, no gradients, no identical
rounded cards, no soft shadow under every block, no all-caps eyebrow labels, and no
arrow-suffixed CTAs.

### 2. Color: two real scenes, one signal system

Full tokens are in `DESIGN.md`. The decisions:

- **Dark — "night bench":** blue-graphite ground `#12171b`, panels one step up, a single oxide
  orange accent `#e28a4a` for primary action and focus. Lane colors are instrument traces:
  assistant aqua `#74c9c0`, thinking amber `#d3ad6a`, tool steel `#8fb2e0`, system violet
  `#b49bdb`. Not near-black, not acid green.
- **Light — "drafting paper":** cool paper `#edf0f1`, ink `#11171a`, the same accent deepened
  to `#a8491f`. Lane colors are darkened to pass 4.5:1 on paper.
- Color never decorates: lane color is a 2px spine + a lowercase lane tag; status color is a
  glyph + text. Nothing is identified by color alone.
- Semantic colors are reserved: success, warning, error, and the accent. Everything else is
  ink/line/ground.

### 3. Type: one family, two cuts

**IBM Plex Sans** (UI, prose) and **IBM Plex Mono** (evidence: tool output, arguments,
timestamps, ids, slash commands), self-hosted from `@fontsource` packages (SIL OFL). One
family with a mono companion is coherent without becoming the default Inter/SF stack, and it
is an engineering face without cosplay. No display face.

- Body 15 px / 1.6, measure ≤ 78 ch.
- UI/meta 12.5 px; functional floor 11.5 px (timestamps, counts, lane tags).
- Mono 12.5 px / 1.5 for evidence; never for prose.
- Lowercase lane tags (`you`, `think`, `tool`, `system`) in mono 11 px with 0.04em tracking.
  Lowercase is a deliberate console voice; uppercase is reserved for nothing.

### 4. Density and layout

- Three regions: rail (248 px), transcript, optional plan (320 px at ≥1280 px, overlay
  below). Transcript reading column max 900 px, centered in its region.
- Header 52 px; rail rows 48 px; tool rows 32 px; system rows 28 px. Spacing scale 4/8/12/16/24.
- 1 px rules, 3 px radius on controls, 6 px on sheets. Shadows only for overlays.
- The timeline is the primary surface: its left gutter is 64 px at ≥900 px (time + turn) and a
  single 44 px column below that.

### 5. Streaming without re-rendering the world

This is a UI identity decision because a console that stutters is not an instrument.

- The store is normalized per message. The transcript subscribes to the ordered key list; each
  row subscribes to its own message version. A token wakes one row.
- Text deltas append to a chunk list; the row joins chunks at render time and materializes on
  `text_end`, so a 10,000-token answer is linear, not quadratic.
- At most one render per row per animation frame; tokens within a frame coalesce.
- Auto-follow uses a 4 px threshold at the bottom; scrolling up pauses following and captures
  a message-key anchor so hydration or a resize does not move what is being read.
- Tool output is collapsed to a one-line summary; expanded output is capped at 6,000 chars
  with "show all". Images load lazily.
- The transcript keeps a stable tail spacer, a prompt outline with jump-to-prompt, and a
  jump-to-latest control. A 10k-event session must meet the budget in A10; full row
  virtualization is the fallback if measurement demands it (recorded in evaluation).

### 6. Dialogs are inspector sheets, not alerts

- `select` / `confirm` / `input` / `editor` / rich `ask` share one sheet: a top rule, a
  mono metadata line (kind, queue position, timeout), body, and a keyboard-hinted action row.
- **Approvals** are their own visual case: an oxide warning stripe, `Allow tool:` parsed into
  a tool name and a mono command block, and options as numbered rows with the safe default
  focused. `Deny` is never the primary.
- **Ask** renders each question with its header, option rows (description/preview), a
  recommended badge, and free text. Multi-select accumulates selections locally and is sent
  as one `answers` payload for the rich `ask` method. The field-by-field fallback (the `ask`
  tool in RPC mode) shows one field at a time, keeps an accumulated state line, and strips the
  literal `"Other (type your own)"` row into a real free-text field instead of duplicating it.
- The sheet traps focus, restores it on close, and shows the countdown; at zero it stops
  accepting input and says the child decides the default, rather than pretending to submit.

### 7. Themes and motion

- Theme is `data-theme="light|dark"` on `<html>`, set before first paint by an external
  `theme-boot.js`; default follows `prefers-color-scheme`; the toggle persists.
- Motion is state-only: 120 ms for hover/press, 180 ms for sheets, 90 ms press. The streaming
  caret and the live dot are the only continuous animations; both stop under
  `prefers-reduced-motion`. No page-load choreography, no per-card entrance.
- Focus is always visible: 2 px accent outline at 2 px offset; never removed for mouse users.

### 8. Accessibility floor

- Text contrast ≥ 4.5:1 in both themes; non-text UI ≥ 3:1.
- Every icon-only control has an accessible name; every status has text, not just color.
- The transcript is a labelled region with `aria-busy` while hydrating; live updates use a
  polite live region for turn completion and errors, not for every token.
- Full keyboard path: rail search, session switch, transcript scroll, prompt jump, dialog
  answers, composer, slash palette, plan toggle, theme toggle.
- `prefers-reduced-motion` and 200% zoom are part of validation, not an afterthought.

### 9. CSS architecture

Plain CSS, no framework, layered by concern with a token layer:

```
web/src/styles/tokens.css      # :root, [data-theme], scales, focus, scrollbars
web/src/styles/base.css        # reset, typography, utilities
web/src/styles/shell.css       # rail, header, layout, responsive
web/src/styles/transcript.css  # lanes, rows, markdown, tools, thinking
web/src/styles/composer.css    # queue, field, palette, attachments
web/src/styles/dialogs.css     # sheets, approvals, ask
web/src/styles/plan.css        # plan panel, empty states
```

Each file has a single owner concept; no selector may style another region's internals
(no `.sidebar .tool-row`). Specificity stays at one class plus a state/data attribute. The
600-line budget applies per file. Tokens are the only hard-coded colors; a test greps for hex
values outside `tokens.css`.

## Consequences

- The transcript is denser and more legible at a glance, but it is not immediately familiar
  to someone expecting a chat app. The empty state and the composer hint teach the model.
- Per-row subscriptions and chunked streams add store complexity; they are covered by reducer
  and performance tests, not just visual review.
- Two font families add ~100–150 KiB to the bundle (subset, woff2, cached immutably). This is
  measured in evaluation; falling back to system stacks is the escape hatch if the budget is
  missed.
- The oxide accent and trace lanes are a real identity, but they must survive both themes;
  tokens, not ad-hoc colors, make that testable.
- Approvals and `ask` are visually distinct from ordinary dialogs; that is the point. The
  cost is more component branches and more tests.

## Alternatives considered

| Alternative | Rejected because |
| --- | --- |
| Keep the PoC look and only split the CSS | the chat-bubble frame misrepresents the product and repeats the generic default |
| Near-black + acid green "terminal" theme | the most common generated-UI tell; also fails daylight use |
| Warm cream + serif + terracotta | the second most common tell; wrong for a dense instrument |
| Tailwind or a component library | adds a system we did not design; the surface is small enough for semantic CSS |
| Virtualize from day one | machinery before measurement; row subscriptions + containment may meet the budget, and the fallback is explicit |
| Render the `ask` tool's HTML form directly | untrusted HTML; a parsed field model is the safe and more legible choice |
| All-caps mono labels everywhere | reads as costume, hurts scanning; lowercase tags with rules carry the same structure |
