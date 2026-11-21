# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-11-21

First public release. The prior `omp-web` proof of concept is preserved on the `poc`
branch at tag `poc-archive`; it is evidence, not the shipping base.

### Added

- One Rust binary that serves the React console from embedded assets on loopback and
  supervises one `omp --mode rpc-ui` child per session.
- Sessions: spawn in any folder, optional model/thinking, concurrent-session cap,
  stop, close, fork, new-session-in-place, resume from omp's own session files, and
  recent-history discovery for both direct and per-project session layouts.
- Streaming transcript: assistant markdown, thinking, tool calls and partial output,
  tool results, terminal runs, system events, compactions and turn boundaries, with a
  time gutter, prompt outline, jump-to-latest and follow-pause on scroll.
- Control: steer, queue a follow-up, remove or promote queued input, stop a turn, and
  restore withdrawn queued text and images.
- Dialogs: approvals, `select`, `confirm`, `input`, `editor`, the rich `ask` shape and
  the field-by-field `ask` tool flow; extension notices, statuses, widgets, title and
  editor text; replay for a late client.
- Session settings: provider-grouped model picker, thinking levels, auto-compaction,
  context usage, cost, tokens and live token rate.
- Composer: slash palette with aliases, image attachment compression (max 4, ~150 KiB
  each), drag/drop and paste, IME-safe submission, persisted drafts, and a queue strip.
- Plan/todos panel, read mode, light/dark themes, reduced-motion support, and visible
  focus.
- Protocol crate with exact RPC-v2 chunk rules, a command allowlist, golden fixture
  replay in Rust and TypeScript, and explicit unknown-frame evidence.
- Byte-bounded frame fan-out with lag resynchronization, process-group teardown, and
  loopback Host/Origin/Sec-Fetch-Site guards.
- Contract, lifecycle, WebSocket, security, reducer, component, Playwright and axe
  tests; a scriptable stub `omp`; and a 10k-event performance harness.

## [Unreleased]

Nothing yet.

[Unreleased]: https://github.com/mrsase/omp-console/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/mrsase/omp-console/releases/tag/v1.0.0
