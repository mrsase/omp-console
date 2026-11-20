# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The repository URL used below is the planned name; the project has not been released.

## [Unreleased]

Everything here is design-phase material. No product feature, binary or release exists yet;
see `docs/v1-design.md` for what v1.0.0 is intended to ship.

### Added

- Architecture Decision Records: protocol contract (`docs/adr/0001`), workspace and process
  architecture (`docs/adr/0002`), and UI identity (`docs/adr/0003`).
- `docs/DESIGN.md`: the design system, typography, color and interaction rules.
- `docs/v1-design.md`: v1.0 scope, the seven surfaces, acceptance criteria A1–A12 with a proof
  for each, milestones, performance targets, risks and roadmap.
- `docs/poc-findings.md`: what the `omp-web` proof of concept established, with measurements.
- `docs/CYCLE.md`: the finish cycle's phases, artifacts and gate commands.
- Golden protocol fixtures in `docs/fixtures/`, constructed (not copied) from a live
  `omp/18.18.8` capture, replayed by both the Rust and TypeScript parsers.
- Cycle gates in `tools/check-cycle.mjs` and the line-budget check, wired into the `Makefile`.
- `SECURITY.md`: threat model, non-goals and vulnerability reporting.

### Changed

- Rewrite of the `omp-web` proof of concept. The PoC is preserved on the `poc` branch at tag
  `poc-archive`; it is evidence, not a shipping base.
- Protocol contract pinned to `omp` 18.x, tested against 18.18.8, with an explicit refusal and
  override outside that range.

[Unreleased]: https://github.com/mrsase/omp-console/compare/v1.0.0...HEAD
