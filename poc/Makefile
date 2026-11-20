.PHONY: build web server run test smoke dev-server dev-web

web:
	cd web && bun install && bun run build

server:
	cargo build --release --manifest-path server/Cargo.toml

build: web server

run:
	./server/target/release/omp-web

dev-server:
	cargo run --manifest-path server/Cargo.toml

dev-web:
	cd web && bun run dev

test:
	cargo test --manifest-path server/Cargo.toml
	cd web && bun run typecheck

smoke:
	node scripts/smoke.mjs
