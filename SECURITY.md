# Security policy — omp-console

omp-console is a local console for the `omp` agent harness. It is designed to be run by one
person on their own machine, on loopback, with no authentication. This document states what
that design protects, what it does not, and how to report a problem.

This policy describes the v1.0 security model defined in `docs/v1-design.md` and
`docs/adr/0002-architecture.md`. v1.0.0 supports omp 18.x (tested 18.18.8).

## Assets

- **The local filesystem, as reachable by `omp`.** The console spawns `omp` in a folder you
  choose, and `omp`'s tools (shell, file edits, other tools) run as your user. A console that
  can start a session is a console that can run commands with your privileges.
- **Model credentials in the environment.** The child inherits the environment it needs to
  reach its model provider. The console does not store, log or transmit those values, but it
  does pass `OMP_*` variables through to the child.
- **Session transcripts on disk.** `omp` writes session files under the sessions root
  (default `~/.omp/agent/sessions`). Transcripts contain prompts, tool output, paths and
  possibly secrets that appeared in a session.

## Trust boundaries

| Boundary | What crosses it |
| --- | --- |
| Browser page → console | HTTP and WebSocket requests on `127.0.0.1:8787`. The browser is not trusted to be the only client. |
| Console → `omp` child | Newline-delimited JSON over stdin/stdout, plus stderr for diagnostics. The child is a separate process, in its own process group. |
| Console → local OS | Process spawn and signals, read-only directory listing, read-only session header parsing, resume file reads. |
| Local OS → console | Any local process can open a connection, exactly like any other loopback service. |

The console is the only component that parses untrusted bytes from the child and from the
browser. `crates/omp-protocol` validates frames, chunks and commands; `omp-console` validates
requests and enforces process and filesystem limits.

## What is protected

- **Host and Origin checks.** `Host` must be in the configured allowlist (loopback forms by
  default) or the request is rejected with `421`. Requests with `Sec-Fetch-Site: cross-site`
  are rejected, and WebSocket upgrades and unsafe methods require an allowlisted, non-`null`
  `Origin`. This blocks DNS-rebinding and cross-site request forgery against the loopback
  port; it does not authenticate a local client.
- **Content Security Policy and headers.** `default-src 'self'`, `script-src 'self'`,
  `object-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'`, plus `nosniff`,
  `X-Frame-Options: DENY` and `no-referrer`. No untrusted HTML is inserted into the page.
- **Command allowlist.** The web client can send only the commands in the protocol catalog
  (`prompt`, `steer`, `abort`, settings and `get_*` hydration commands, dialog responses).
  Fields and sizes are validated; anything else is rejected.
- **Resume containment.** A resume path is canonicalized, must resolve under the sessions
  root, must be a regular file, and must end in `.jsonl`. Traversal, symlink escapes and
  non-session files are refused.
- **Payload caps.** Request bodies, WebSocket messages, protocol lines, chunk sequences,
  stderr rings and the per-session frame ring are bounded. A hostile or broken child cannot
  grow console memory without limit.
- **Process-group teardown.** Each child is in its own process group; stop and shutdown
  signal the group with a staged `SIGTERM`/`SIGKILL`, so tool grandchildren do not survive as
  orphans.
- **No writes to omp's session files.** The console scans headers read-only and passes
  `--resume` to `omp`; it never edits, renames or deletes a session file. `omp` owns them.

## Non-goals

These are deliberate design choices, not gaps to be fixed in a patch:

- **No authentication or user accounts.** Loopback is the boundary. Anything that can connect
  to `127.0.0.1:8787` is treated as the operator.
- **No multi-user isolation.** Two OS users on one machine are not separated by the console;
  filesystem permissions are the only separation.
- **No isolation from other local processes.** Any local process can connect, read responses
  and issue commands, just as it could run `omp` itself.
- **No sandbox for the child.** `omp` runs with your privileges and its own sandboxing rules;
  the console does not add a container, seccomp filter or capability drop.
- **No remote hosting.** Remote bind is out of scope for v1.0.

## Binding beyond loopback

The default bind is `127.0.0.1:8787`. Binding to a non-loopback address requires
`OMP_CONSOLE_ALLOW_REMOTE=1` and is logged as a security downgrade. Doing so removes the only
access control the console has: the API can start sessions, and a session can run tools.

If you must expose it, put it behind a reverse proxy that terminates TLS and enforces
authentication, and restrict the proxy to the intended clients. The console's Host and Origin
allowlists must then be configured for the proxy's hostname (`OMP_CONSOLE_ALLOWED_HOSTS`,
`OMP_CONSOLE_ALLOWED_ORIGINS`). A proxy that forwards without auth is equivalent to publishing
a shell.

## Reporting a vulnerability

Report privately through GitHub's private security advisory flow on the planned repository,
`mrsase/omp-console` (Security → Advisories → "Report a vulnerability"). Do not open a public
issue for a suspected vulnerability, and do not include live credentials, session transcripts
or unsanitized protocol captures.

Please include the version (or commit), platform, the smallest reproduction you can, and what
you expected instead. This project has no bug bounty and no dedicated security email.

## Supported versions

v1.0.0 is the current release. Security fixes target the latest release on the supported
`omp` 18.x line. Running with
`OMP_CONSOLE_SKIP_VERSION_CHECK=1` against an unverified `omp` is unsupported for security
reports unless the issue is in the console itself.

## What is not a vulnerability

- **Any local process can connect to the port.** That is the design: loopback is the trust
  boundary. Requests still have to pass Host/Origin checks, but a local client is expected to
  be able to talk to the console.
- **The console can run tools with your privileges.** Starting a session starts `omp`; `omp`
  intentionally has tool access. Code execution through a session is the product, not an
  escalation, provided the operator started that session.
- **`/api/fs` lists directories you can already read.** Choosing a working folder requires
  browsing; it is read-only and adds no permission you did not have.
- **A malicious page cannot make state-changing or WebSocket requests** without an allowed
  Origin, and the browser's same-origin policy prevents it from reading cross-site GET
  responses. It can still cause a cross-site GET to be sent; that is why every GET is
  read-only. If you disable the guard or bind remotely without a proxy, that protection is
  yours to configure.
