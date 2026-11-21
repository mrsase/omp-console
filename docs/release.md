# Release runbook — v1.0.0

This is the ship-phase procedure for `omp-console`. It is executed only after
`make verify`, `make validate` and the evaluation go/no-go are recorded.

## Artifacts

| Target | Runner | Tarball |
| --- | --- | --- |
| macOS arm64 | `macos-14` | `omp-console-darwin-arm64-1.0.0.tar.gz` |
| macOS x64 | `macos-13` | `omp-console-darwin-x64-1.0.0.tar.gz` |
| Linux x64 | `ubuntu-22.04` | `omp-console-linux-x64-1.0.0.tar.gz` |

Each tarball contains the stripped `omp-console` binary, `README.md`, and `LICENSE`.
A sibling `.sha256` file is published. The binary embeds `web/dist`; the release
workflow builds the bundle before cargo, and the release build fails if the bundle
is the debug placeholder.

## Preconditions

1. `main` is clean and contains the evaluated commit.
2. `make verify` is green and recorded in `docs/verification.md`.
3. `make validate` is green for the stub journey, and the manual live run is in
   `docs/validation.md` with screenshots and timings.
4. `docs/evaluation.md` says `Decision: GO` against A1–A12.
5. CI is green on the commit being tagged.
6. `CHANGELOG.md` has the `1.0.0` section with the real date.

## Procedure

```bash
git checkout main
git pull --ff-only
make verify
make validate
git tag -a v1.0.0 -m "omp-console v1.0.0"
git push origin main
git push origin v1.0.0
```

The `release` workflow builds the three targets, publishes checksums, and creates
the GitHub release with generated notes.

## Post-release checks

```bash
gh release view v1.0.0
gh run list --workflow release --limit 1
gh release download v1.0.0 --pattern '*.sha256' --dir /tmp/omp-release
```

Then, on a clean machine/container for each target that can be executed locally:

1. Download the tarball and its checksum; verify `shasum -a 256 -c`.
2. Extract and run `./omp-console --version` (must print `omp-console 1.0.0`).
3. Start it with `OMP_BIN` pointing at `omp` 18.x.
4. Open `http://127.0.0.1:8787`, create a session, send one prompt, confirm a
   streamed reply, stop it, and close the session.
5. Confirm `curl -s -o /dev/null -w '%{http_code}' -H 'Host: evil.example:8787' http://127.0.0.1:8787/api/info` returns `421`.

## Rollback

The tag and release are immutable once published. If the binary is broken:

1. Do not move `v1.0.0`; publish `v1.0.1` with the fix.
2. Mark the `v1.0.0` release as "pre-release" only if it is unusable, and state
   the reason in the release notes.
3. Keep the artifacts attached so checksums remain verifiable.

There is no data migration and no server-side state: the console reads omp's
session files and never writes them. Rolling back a binary is therefore safe.

## Supported versions

`omp` 18.x, contract recorded from 18.18.8. The console refuses other major
versions before spawning unless `OMP_CONSOLE_SKIP_VERSION_CHECK=1` is set.

## What must be in the release notes

- The supported `omp` range and the tested patch.
- The three targets and checksums.
- Security posture: loopback, no auth, never expose directly.
- Any known limitation recorded in `docs/evaluation.md`.
- A link to `docs/validation.md` screenshots and the measured numbers.
