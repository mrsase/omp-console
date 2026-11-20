# DESIGN.md — omp-console

Normative visual system for v1.0. Decisions and rationale live in
`docs/adr/0003-ui-identity.md`; this file is what the CSS implements. If code and this file
disagree, the file wins until it is amended.

**Mode:** Operate · **World:** bench instrument / flight recorder · **Reader:** a developer in
a long session, keyboard-first, dark room or daylight.

## 1. Tokens

Defined only in `web/src/styles/tokens.css`. No other file may contain a hex color. Theme is
`<html data-theme="light|dark">`; the default follows `prefers-color-scheme`.

### Ground, ink, lines

| Token | Dark — night bench | Light — drafting paper |
| --- | --- | --- |
| `--bg` | `#12171b` | `#edf0f1` |
| `--panel` | `#171e24` | `#f7f8f8` |
| `--raised` | `#1e272e` | `#ffffff` |
| `--sunken` | `#0e1215` | `#e3e7e8` |
| `--line` | `#2b363f` | `#d3dadc` |
| `--line-strong` | `#3d4b56` | `#b6c1c5` |
| `--ink` | `#e8eef2` | `#11171a` |
| `--ink-2` | `#b9c6cf` | `#33434b` |
| `--muted` | `#8b9aa5` | `#4d5d65` |
| `--faint` | `#66757f` | `#7b8b93` |
| `--selection` | `#2e4650` | `#cfe0e5` |

### Signal

| Token | Dark | Light | Use |
| --- | --- | --- | --- |
| `--accent` | `#e28a4a` | `#a8491f` | primary action, focus, live caret |
| `--accent-ink` | `#14181b` | `#fff7f1` | text on accent |
| `--accent-soft` | `#e28a4a24` | `#a8491f14` | tinted prompt block, hover |
| `--ok` | `#74c58c` | `#1e6b3d` | completed tool, connected |
| `--warn` | `#d9a45b` | `#8a5a12` | retry, compaction, approval |
| `--err` | `#e88374` | `#a33422` | failure, dangerous action |
| `--focus` | `--accent` | `--accent` | 2 px ring |

### Lanes (identity, never decoration)

| Lane | Dark | Light | Spine | Tag |
| --- | --- | --- | --- | --- |
| assistant | `#74c9c0` | `#1c6f68` | solid 2 px | `omp` (mono, lowercase) |
| thinking | `#d3ad6a` | `#8a5a12` | dotted 2 px | `think` |
| tool | `#8fb2e0` | `#2b5d94` | solid 2 px | `tool` |
| system | `#b49bdb` | `#6b4a96` | hairline | `system` |
| you | `--accent` | `--accent` | solid 3 px | `you` |

Lane color is a spine and a tag, never a background wash except the person's prompt block
(`--accent-soft`) and the approval stripe (`--warn` at 12% + a 3 px stripe).

### Space, shape, depth

```
--s1 4px  --s2 8px  --s3 12px  --s4 16px  --s5 24px  --s6 32px
--r-control 3px  --r-sheet 6px  --r-round 999px   (only status dots and chips)
--row-tool 32px  --row-system 28px  --row-rail 48px  --header 52px
--measure 78ch
```

Depth is borders and ground steps, not shadows. The only shadow is the dialog/sheet
(`0 18px 60px rgb(0 0 0 / 0.38)` dark, `0 18px 60px rgb(20 30 35 / 0.18)` light) plus a
solid scrim.

## 2. Type

Self-hosted IBM Plex Sans (400/500/600) and IBM Plex Mono (400/500), latin subset, `woff2`,
`font-display: swap`, no network request.

| Role | Family | Size / line | Weight | Notes |
| --- | --- | --- | --- | --- |
| Session title | Sans | 18 / 1.3 | 600 | truncates; full title in tooltip |
| Rail title | Sans | 13.5 / 1.35 | 500 | one line, ellipsis |
| Rail meta | Sans | 11.5 / 1.3 | 400 | muted; cwd + age as separate cells |
| Transcript prose | Sans | 15 / 1.62 | 400 | max 78ch |
| Prompt prose | Sans | 15 / 1.55 | 400 | tinted block |
| Assistant meta | Mono | 11.5 / 1.4 | 400 | model, tokens, duration, stop reason |
| Lane tag | Mono | 10.5 / 1 | 500 | lowercase, 0.04em tracking |
| Time gutter | Mono | 11 / 1.3 | 400 | tabular, `HH:MM:SS` |
| Tool row | Sans name 13 / Mono summary 12 | 1.4 | 500 / 400 | summary truncates |
| Tool evidence | Mono | 12.5 / 1.5 | 400 | arguments, output |
| Header meta | Sans 12 / Mono data 11.5 | 1.3 | 500 / 400 | separate cells, not middots |
| Dialog title | Sans | 16 / 1.35 | 600 | |
| Dialog body | Sans | 14 / 1.5 | 400 | |

No uppercase labels. No display face. No italic prose. Code is mono; prose is never mono.

## 3. Shell

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ rail 248px       │ status bar 52px: title · cwd · model · think · ctx · cost │
│                  ├───────────────────────────────────────────────────────────┤
│ + New session    │ transcript region                                         │
│ search           │  ┌ gutter 64px ┬ spine ┬ reading column ≤ 78ch ─────────┐  │
│ OPEN             │  │ 14:02:11    │  █    │ you · turn 3                   │  │
│  ● title         │  │ turn 3      │       │ prose…                          │  │
│    cwd · work    │  │             │  █    │ omp · DeepSeek…                 │  │
│ SAVED            │  │ 14:02:19    │  │    │ prose…                          │  │
│  ○ title         │  │             │  ┆    │ think · 1.2k chars   [expand]   │  │
│    cwd · 2h      │  │             │  █    │ tool bash  echo …   277ms  [▸]  │  │
│                  │  └─────────────┴───────┴─────────────────────────────────┘  │
│ connected v1.0   ├───────────────────────────────────────────────────────────┤
│                  │ queue chips (only when queued)                            │
│                  │ composer: ❯ [ text … ]  attach / commands / mode / send   │
└──────────────────────────────────────────────────────────────────────────────┘
```

Breakpoints:

| Width | Rail | Plan | Transcript gutter |
| --- | --- | --- | --- |
| ≥ 1280 | fixed 248 | 320 third column | 64 |
| 900–1279 | fixed 248 | overlay sheet | 64 |
| 640–899 | drawer | overlay sheet | 44 (one column: time above turn) |
| < 640 | drawer | full-screen sheet | 40 |

The header never wraps. Below 900 px, model/thinking/context collapse into a settings sheet;
the title and status remain. No horizontal page scroll at 320 px.

## 4. Transcript lanes

Every top-level entry is a row with `data-message-key` and a stable `data-anchor`
(`role:timestamp`). Rows sit on a shared left gutter and spine; the spine is continuous within
a turn and breaks between turns with a 12 px gap and a turn rule.

### you

- 3 px `--accent` spine, `--accent-soft` block, 12 px padding, 3 px radius.
- Header line: `you` tag, turn number (`turn 4`, only when it changes), timestamp on hover.
- Images render at max 220 px high in a row below the prose, with a mono caption
  `1/2 · 1280×720 · 84 KB`.
- Prompts longer than 1,200 chars or 12 lines collapse to a 6-line preview with a
  disclosure that keeps the top edge stable. The outline still lists the full prompt text.

### assistant

- No bubble, no avatar. 2 px aqua spine aligned to the gutter.
- Header is a single meta line shown after the first text block appears: `omp`, model name,
  then after completion tokens / duration / stop reason, each a separate monospace cell.
- Prose uses the reading column. A streaming caret is a 2 px accent bar after the last text
  node; it stops when the message ends.
- Stop reasons other than `stop` appear as a small `--muted` note (`stopped`, `length`,
  `toolUse` is implied by a following tool row and is not shown).
- Errors are an inline row with an error glyph, the message, and a retry hint if the child
  says the error is retryable. No red background blocks.

### thinking

- Collapsed default: dotted amber spine, `think` tag, `Thought` or `Thinking`, char count,
  and a chevron. While streaming, the tag is `thinking` and the count updates once per second,
  not per token.
- Expanded: mono 12.5 px on `--sunken`, max height 320 px with its own scroll, left rule.
- Finished thinking is never auto-expanded; a live thinking block may be expanded and stays
  open when it finishes.

### tool

- One 32 px row: status glyph (spinner / check / x), tool name in 13 px, a single-line summary
  in mono, duration when finished, chevron.
- Summary rules: `bash` shows the command trimmed to 110 chars; `read/write/edit/ast_edit`
  show the path; `grep/ast_grep` show `/pattern/ path`; `glob/find` show pattern + path;
  `task` shows the description; `web_search` shows the query; `ask` shows "question"; anything
  else shows the first string argument, then raw JSON.
- Running: `--warn` dot with a 900 ms pulse, elapsed time in mono. Failed: `--err` glyph and
  an error tag. Completed: `--ok` check.
- Expanded: a 2-column inspector at ≥900 px (arguments | output), stacked below. Arguments
  and output are mono on `--sunken`, each with a small lowercase label. Output over 6,000
  chars is truncated with "show all"; over 40 lines is collapsed to 12 lines with "expand".
  Images from tool results render below with lazy loading. `details` is behind a separate
  "raw" disclosure and is never rendered by default (bash traces are large).
- A tool whose call id appears in an assistant message renders inside that message. A result
  with no matching call renders as an orphan row in the same lane, never duplicated.

### system

- 28 px hairline row with a diamond glyph, a lowercase label (`compaction`, `branch`,
  `retry`, `settled`, `protocol`), and a one-line summary. Expanding shows the body.
- Retry: `retry 2/5 · provider error · in 4s` with an amber pulse; a cancel action if the
  protocol exposes one.
- Compaction: start/end pair collapses into one row with duration and token delta.
- Unknown frame evidence appears here as `protocol` rows with a count and a drawer; it is not
  a toast and it is not silent.

### Turn rule

Between `turn_end` and the next `turn_start`: a 1 px rule across the reading column, a
lowercase `turn N` in the gutter, and elapsed time on the right in mono. Max one per turn.

## 5. Session rail

- 248 px, `--panel`, 1 px right rule. Brand block 52 px: a 20 px instrument mark (three
  horizontal traces, not a letter avatar), `omp console` in 13.5 px 600, and the connection
  LED + version in mono 10.5 px.
- `New session` is a full-width 36 px control with a 3 px radius, accent text on `--raised`,
  1 px `--line-strong`; it is not a filled orange button (send is the only filled accent).
- Search is a 32 px field with a `/` hint; it filters both open and saved sessions.
- Section labels are lowercase mono 10.5 px `--muted` with a hairline rule and a count, not
  an all-caps eyebrow.
- Open row: 48 px, status tick (2 × 16 px bar: idle `--line-strong`, working `--warn` pulsing,
  ready `--ok`, exited `--faint`), title one line, meta line `cwd` + state as separate cells.
  Selected row gets `--raised` and a 3 px accent left rule. Hover reveals resume/close icon
  buttons; keyboard focus reveals them too.
- Saved row: 44 px, `↺` glyph, title, `cwd` + relative age. A resume in flight shows a
  spinner and disables the row.
- The rail scrolls independently; the footer (`connected`, `v1.0.0`) is fixed.
- Below 900 px the rail is a drawer with a solid scrim, focus trap, Escape to close, and
  focus restoration to the menu button.

## 6. Header / status bar

One 52 px row, never sticky over the transcript on short windows (it is part of the grid, not
an overlay):

`title` (18 px, truncates) · status pill (`Starting` / `Working` / `Idle` / `Ended`, dot +
text) · extension status chips · workspace `basename(cwd)` and model in 12 px muted ·
right side: context ring (22 px, accent arc, % in mono), cost, total tokens, token rate while
working, then Plan and Settings buttons and a `more` menu.

Model and thinking are compact selects in the settings sheet, not in the header at <1280 px.
The token-rate sparkline (60 × 18 px, 30 s window) sits before the stats and is the only
chart in the shell; it is drawn from the last N `message_update` deltas and disappears when
idle for 30 s.

## 7. Composer

- Docked at the bottom of the transcript column, 1 px top rule, `--panel`.
- Queue strip above the field: one chip per pending message, 24 px, mono text truncated to
  48ch, with a kind tag (`steer` / `next` / `sent`), a remove button, and promote for
  follow-ups. Chips wrap; the strip scrolls after two rows.
- Field: a 3 px accent left rule, a mono `❯` glyph, and a textarea that grows to 12 lines then
  scrolls. Placeholder reflects state: `Message omp…`, `Steer the turn…`, `Queue a follow-up…`,
  `Starting omp…`.
- Toolbar: attach (paperclip), commands (`/`), then on the right: while running, a segmented
  `Steer now | Queue next` control and `Stop`; always, a filled accent `Send` with a keyboard
  hint. The send button label changes with mode (`Send`, `Steer`, `Queue`).
- State strip below: `Enter to send · Shift+Enter for newline` on the left; on the right, image
  preparation count, `omp is working`, or `Disconnected · draft kept locally`. The copy must
  match reality: drafts are persisted, but only for existing session ids.
- Attachments: 56 px thumbnails with a remove control; max 4; each ≤150 KiB JPEG; a total
  command budget of 900 KiB enforced before send with an actionable message.
- Slash palette: anchored above the field, max 9 rows, 32 px rows; name in mono, description
  in sans, input hint in mono `--muted`; arrow keys move, Enter/Tab accept, Escape dismisses.
  Aliases from the catalog are matched and shown.
- Drag-and-drop overlay: a 1 px accent dashed border inside the composer and the text
  `Drop images to attach`; no full-screen dim.
- IME: never submit while composing (check `isComposing` and `keyCode === 229`). Escape stops
  the turn only when the draft is empty; otherwise it dismisses the palette first.

## 8. Dialogs

One sheet component, `--raised`, 6 px radius, 1 px `--line-strong`, max width 520 px (640 for
`ask`), max height 82vh, internal scroll, solid scrim. Enter/exit 180 ms; reduced motion none.

```
┌─ sheet ─────────────────────────────────────────────┐
│ kind · 1 of 2 · 24s              [x]                │  mono meta row
│ Title                                               │  16/600
│ body / questions                                    │
│                                                     │
│ [Cancel]                              [Primary]     │  hint row
└─────────────────────────────────────────────────────┘
```

- `select`: option rows 44 px, label + description, right chevron; selecting answers
  immediately. Approval variants get the warning stripe and structured title (see below).
- `confirm`: message prose; `No` is focused (safe default), `Yes` primary; danger styling for
  destructive confirmations.
- `input` / `editor`: 36 px input or 8-row textarea; secret inputs use `type=password`;
  `editor` submits on Cmd/Ctrl+Enter, `input` on Enter.
- `ask` (rich): each question with header, text, option rows (recommended badge, preview in
  mono), and a free-text field. Single-select clears free text; free text clears single
  select. Multi-select toggles and accumulates; one `Submit` sends all answers in order.
- Field-by-field `ask` fallback (the `ask` tool): the sheet shows `field 2 of 5` when known,
  the question title, and a state line of previous answers. The literal
  `Other (type your own)` option is removed from the option list and rendered as a focused
  free-text field; choosing any listed option answers immediately. Multi-select fields show
  "choose one at a time, then Done" because that is what the protocol does.
- Approvals: parse `Allow tool: <name>\nCommand: <cmd>` (or `title` only) into a heading
  `Allow <name>?`, a mono command block, and options as rows with numeric hints (`1 Approve`,
  `2 Approve for this session`, `3 Deny`). Number keys answer; Escape cancels. The safe
  option is focused, never Deny.
- Timeout: a mono countdown in the meta row. At 0, disable controls and show `Timed out —
  omp chooses the default`; do not send a response the child already resolved.

## 9. Plan panel

- 320 px third column at ≥1280 px; a right-side sheet below that.
- Header 40 px: `Plan`, `n/m done`, Expand/Restore, close. Sticky inside the panel.
- Progress is a 2 px segmented rule (one segment per task), not a rounded bar.
- Phases: lowercase mono phase name, then tasks. Task rows 32 px: 14 px mark
  (check / spinner / alert / empty), 13.5 px text, `blocked` note underneath.
- Completed tasks keep readable text and a check; no strikethrough.
- Empty: an instrument glyph, `No plan yet`, and one sentence explaining that the agent's
  todos appear here.
- Read mode hides the rail, header and composer, leaving the transcript (optional plan) and a
  24 px `Exit read` control; Escape restores, draft intact.

## 10. Motion

| Element | Duration | Easing |
| --- | --- | --- |
| hover / press | 120 / 90 ms | ease-out |
| sheet enter / exit | 180 / 140 ms | cubic-bezier(.2,.8,.2,1) |
| status dot pulse | 900 ms loop | ease-in-out |
| streaming caret | 1 s loop, opacity only | linear |

No entrance animations for rows, no layout animation on streaming text, no smooth-scroll
during token delivery. `@media (prefers-reduced-motion: reduce)` sets all durations to 0 and
stops loops. Auto-follow uses instant scroll, not smooth, so it cannot fight the reader.

## 11. Accessibility

- Focus ring: `outline: 2px solid var(--focus); outline-offset: 2px` on every focusable
  element; `:focus-visible` only for pointer users, but keyboard focus is never hidden.
- Transcript is `role="region" aria-label="Conversation"` with `tabindex=0`; rows are not
  focusable individually except interactive controls. The prompt outline is a real `<select>`
  or a listbox with keyboard support.
- Dialogs: `role=dialog aria-modal=true`, labelled by the title, focus trap, Escape, focus
  restore. The sheet is the only focus owner while open.
- Status: text + glyph + color. The connection LED has `aria-live=polite` text.
- Live regions: turn completion, errors, and queued-message changes are announced; token
  deltas are not.
- Hit targets ≥ 28 × 28 px; icon buttons 28 px with 4 px gap; the rail row itself is the
  target.
- 200% zoom: no clipping, no horizontal scroll at 640 px effective width; dialogs scroll.
- Color-blind check: lane tags and glyphs distinguish lanes without color.

## 12. Rules (enforced in review)

1. No chat bubbles, avatars, or per-message cards.
2. No hex color outside `tokens.css`; no gradient; no decorative shadow.
3. No uppercase labels; lowercase lane/state tags only.
4. No middot-joined metadata strings; metadata is separate cells with layout.
5. No numbered markers except turns (a real sequence).
6. One filled accent control per screen region (send, or the dialog primary).
7. Tool output is collapsed by default and capped when expanded.
8. Every async state has four visuals: idle, working, done, failed.
9. Every dialog is keyboard-complete and focus-restoring.
10. Streaming may not re-render rows that did not change.
11. `prefers-reduced-motion` and 200% zoom are release blockers, not polish.
12. Copy names what happens (`Send`, `Steer`, `Stop`, `Queue`), never "Submit".
