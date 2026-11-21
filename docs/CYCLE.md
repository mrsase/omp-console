# The finish cycle — omp-console

Every phase has an artifact and a gate. A phase is done when the gate command passes and the
artifact exists — not when time was spent. A failing gate sends the work back one phase; it
never moves forward.

```
design ──▶ code ──▶ test ──▶ verify ──▶ validate ──▶ evaluate ──▶ ship
  ▲           │        │         │           │            │          │
  └───────────┴────────┴─────────┴───────────┴────────────┴──────────┘
                 a failing gate sends you back, never forward
```

| Phase | Question | Artifact | Gate command |
| --- | --- | --- | --- |
| **design** | What is finished, what is not, and how is each claim proved? | `docs/adr/0001-0003`, `docs/DESIGN.md`, `docs/v1-design.md`, `docs/poc-findings.md`, golden fixtures | `make design-gate` **and** written owner approval in `docs/v1-design.md` |
| **code** | Does the smallest coherent slice exist and is it reachable? | `crates/`, `web/` | `cargo build` + the feature reachable in the running app |
| **test** | Is there fast, deterministic proof? | Rust tests, Vitest tests, Playwright journey, stub `omp` | `cargo test --workspace` and `cd web && bun run test` |
| **verify** | Does the whole repo hold together? | `docs/verification.md` with versions and real output | **`make verify`** |
| **validate** | Does it work the way a person uses it? | `docs/validation.md` + screenshots + timings | **`make validate`** (stub journey) **and** one hand-driven live run against real `omp` |
| **evaluate** | Is this worth shipping as-is? | `docs/evaluation.md` with numbers and a signed go/no-go | `make evaluate-gate` |
| **ship** | Can a stranger install it in five minutes? | README, LICENSE, SECURITY, CHANGELOG, `docs/release.md`, tag, release | `make ship-gate` + green CI on the tagged commit |

## Non-negotiables

1. **A gate is a command, not an opinion.** If a phase has no command, it has no gate.
2. **`make verify` is exactly what CI runs.** No hand-run approximation, no extra flags in CI.
3. **Evidence, not intentions.** `validation.md` contains screenshots, measured numbers and
   the commands that produced them. No screenshot, no claim.
4. **Claims are measured.** "Fast", "small", "tested" get numbers in `evaluation.md`.
5. **The PoC is evidence.** `~/workPlace/omp-web` is read-only and is preserved
   in this repo on the `poc` branch at tag `poc-archive`.
6. **The protocol is owned in one place.** Frame/command types live in `crates/omp-protocol`;
   the TypeScript mirror is checked against the same golden fixtures.
7. **No product code before design approval.** The design gate is the only gate that needs a
   human signature.

## Commands

```bash
make design-gate    # required docs exist, ADRs accepted, A1..A12 each have a proof, approval recorded
make build          # web bundle, then the workspace (debug)
make test           # cargo test --workspace
make web-test       # vitest (store, protocol reducer, components)
make e2e            # Playwright journey against the stub omp
make verify         # fmt + clippy -D warnings + cargo test + web typecheck + lint + vitest + vite build + release build
make validate       # stub journey end to end; then record the manual live run
make evaluate-gate  # evaluation.md has numbers and an explicit GO
make ship-gate      # README/LICENSE/SECURITY/CHANGELOG/release docs, v1.0.0 tag, green CI, release assets
```

### Compile discipline

`make verify` compiles the Rust workspace three times by design: `cargo test` (dev profile),
`cargo clippy --all-targets` (check profile), and the release build. Do not run it in a loop.
During the code phase use the narrow loop:

```bash
cargo test -p omp-protocol            # protocol changes
cargo test -p omp-console             # server changes
cd web && bun run test -- --run       # frontend changes
```

`make verify` is for phase boundaries and CI. The release profile is tuned for build time
(`lto = "thin"`, `codegen-units = 16`) and the trade-off is measured in `evaluation.md`.

## Branches, commits, tags

- `design`, `code`, `test`, `verify`, `validate`, `evaluate`, `ship` — one branch per phase,
  squash-merged into `main` after its gate passes.
- Conventional commits (`feat:`, `fix:`, `docs:`, `test:`, `build:`, `chore:`).
- Tags: `poc-archive` (the PoC snapshot), `v0.x` during the cycle, `v1.0.0` at ship.
- CI runs `make verify` plus `make e2e`. Releases are built from the tag, never from a branch.
