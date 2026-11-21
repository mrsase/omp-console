# omp-console v1.0.0

[omp-console](https://github.com/mrsase/omp-console) is an unofficial local web console for
[`omp`](https://omp.sh) sessions. One Rust binary supervises real `omp --mode rpc-ui` children
and serves a browser UI on loopback: streaming text, thinking, tools and dialogs; steering and
queued follow-ups; approvals and `ask`; model/thinking settings; attachments; plan; and resume
from omp's own session files. No accounts, no cloud, no telemetry.

## Install

Download the archive for your platform and verify its checksum:

| Platform | Archive |
| --- | --- |
| macOS arm64 | `omp-console-darwin-arm64-1.0.0.tar.gz` |
| macOS x64 | `omp-console-darwin-x64-1.0.0.tar.gz` |
| Linux x64 | `omp-console-linux-x64-1.0.0.tar.gz` |

```bash
shasum -a 256 -c omp-console-<target>-1.0.0.tar.gz.sha256
tar -xzf omp-console-<target>-1.0.0.tar.gz
cd omp-console-<target>-1.0.0
./omp-console
# open http://127.0.0.1:8787
```

`omp` 18.x must be on `PATH`, or set `OMP_BIN`. The contract is recorded from and tested
against **18.18.8**; other major versions are refused before spawning, with an actionable
message and `OMP_CONSOLE_SKIP_VERSION_CHECK=1` as a deliberate override.

Source: `cargo install --path crates/omp-console` after `make build` (the web bundle must be
built first).

## Security posture

Loopback only, no authentication by design. Any local process can connect, and a session can
run omp tools with your privileges. Treat it like a terminal: never expose the port directly,
and never bind `0.0.0.0` without an authenticating reverse proxy. Host, Origin and
Sec-Fetch-Site are checked; commands are allowlisted; resume is confined to the session root;
payloads and frame rings are capped; children are torn down by process group. See
[SECURITY.md](https://github.com/mrsase/omp-console/blob/main/SECURITY.md).

## Measured (this release)

| Metric | Value |
| --- | --- |
| Release binary | 3.2 MB |
| JS bundle | 115 KB gzip |
| CSS | 8 KB gzip |
| Idle console RSS | 2.1 MB |
| Console TTFT (stub) | 15 ms median |
| 10k-event transcript | 0 long tasks >100 ms, +11 MB heap |
| Tests | 54 Rust, 61 web, 12 Playwright journeys (axe light + dark) |

Full evidence: [verification](https://github.com/mrsase/omp-console/blob/main/docs/verification.md),
[validation](https://github.com/mrsase/omp-console/blob/main/docs/validation.md),
[evaluation](https://github.com/mrsase/omp-console/blob/main/docs/evaluation.md).

## Known limitations

- macOS and Linux only; Windows is not a v1.0 target.
- No auth, no remote hosting, no multi-user isolation.
- The `ask` tool is rendered field by field in RPC mode; the rich `ask` method is
  extension-only.
- No live subagent lane or session tree/branch editor yet; reasons and prerequisites are in
  the [v1 design](https://github.com/mrsase/omp-console/blob/main/docs/v1-design.md).

## License

MIT. This is an unofficial project and is not affiliated with the omp maintainers.
