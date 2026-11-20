# omp-console — the finish cycle's commands. See docs/CYCLE.md.
#
# `make verify` is the single gate CI runs: fmt, cargo test, clippy -D warnings,
# web install/typecheck/lint/vitest/build, release build, line budget. CI adds
# `make e2e` only.

SHELL := /bin/bash

CARGO ?= cargo
BUN ?= bun
NODE ?= node

WEB := web

.PHONY: verify build test web-test web-install web-guard web-deps web-typecheck \
	web-lint web-build e2e validate design-gate evaluate-gate ship-gate \
	cargo-fmt cargo-test cargo-clippy cargo-release check-lines clean

# verify compiles the Rust workspace three times by design: `cargo test` (dev
# profile), `cargo clippy --all-targets` (check profile), and the release build.
# Do not run it in a loop. During the code phase use the narrow loops in
# docs/CYCLE.md (`cargo test -p <crate>`, `cd web && bun run test -- --run`).
#
# Prerequisites run in order; `.NOTPARALLEL` keeps that order under `make -j`.
verify: cargo-fmt cargo-test cargo-clippy web-install web-typecheck web-lint \
	web-test web-build cargo-release check-lines

# Web bundle, then the workspace (debug).
build: web-build
	$(CARGO) build --workspace

test: cargo-test

web-test: web-deps
	cd $(WEB) && $(BUN) run test -- --run

cargo-fmt:
	$(CARGO) fmt --all -- --check

cargo-test:
	$(CARGO) test --workspace

cargo-clippy:
	$(CARGO) clippy --workspace --all-targets -- -D warnings

cargo-release:
	$(CARGO) build --release --workspace

# A clear failure when the web app is not scaffolded yet.
web-guard:
	@test -f $(WEB)/package.json || { \
		echo "error: $(WEB)/package.json is missing — the web app is not scaffolded yet." >&2; \
		echo "       expected scripts: typecheck, lint, test, build, e2e." >&2; \
		exit 1; \
	}

web-install: web-guard
	cd $(WEB) && $(BUN) install --frozen-lockfile

# Dependencies are installed before any package script can run.
web-deps: web-guard
	@test -d $(WEB)/node_modules || { \
		echo "error: $(WEB)/node_modules is missing — run \`make web-install\` first." >&2; \
		exit 1; \
	}

web-typecheck: web-deps
	cd $(WEB) && $(BUN) run typecheck

web-lint: web-deps
	cd $(WEB) && $(BUN) run lint

web-build: web-deps
	cd $(WEB) && $(BUN) run build

# Playwright journey against the stub omp; needs installed deps and the bundle.
e2e: web-install web-build
	cd $(WEB) && $(BUN) run e2e

# Stub journey end to end; then record the manual live run.
validate: e2e
	@echo "validate: stub journey passed (make e2e)."
	@echo "validate: NOT complete until one hand-driven live run against the real omp is"
	@echo "          recorded with screenshots and timings in docs/validation.md."

design-gate:
	$(NODE) tools/check-cycle.mjs design

evaluate-gate:
	$(NODE) tools/check-cycle.mjs evaluate

ship-gate:
	$(NODE) tools/check-cycle.mjs ship

check-lines:
	$(NODE) tools/check-line-budget.mjs

clean:
	rm -rf target $(WEB)/dist $(WEB)/node_modules test-results

.NOTPARALLEL: verify build e2e validate
