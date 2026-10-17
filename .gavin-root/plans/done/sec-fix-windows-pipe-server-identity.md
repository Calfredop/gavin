---
order: 56320
kind: task
title: "[sec] On Windows another local account can take the daemon's pipe name first, and the app accepts it as its daemon: no FILE_FLAG_FIRST_PIPE_INSTANCE, no check of the server's owner, and a server_proof keyed by the token the app just sent"
status: Done
priority: low
complexity: intricate
labels: security, ready-for-agent, windows
---
Fix a needs-validation lead from the 2026-10-15 security audit (run-1). It is not confirmed: the audit traced it in source but could not observe, on a Windows host with two local accounts, a second account creating the victim's pipe name and the victim's app completing bootstrap against it. The failing regression test below is the proof — write it first and watch it fail. If it already passes before any change, the lead is wrong: record why under a dated "## Comments" heading and move the card to Done with no code change. Fingerprints: `app/src-tauri/src/session.rs:verify_app_ack:server_proof-key-disclosed-in-hello` and `crates/protocol/src/transport.rs:create_instance:no-first-pipe-instance-cross-user-squat`.

Full record: `NEEDS-VALIDATION.md` in `~/security-audit-skill/gavin/run-1/`, outside this repo. The audit card is `review-security-audit-2026-10-15.md`. This card merges two of its leads, one per fingerprint above; they share a root cause and one fix.

## What is wrong

On Windows the daemon listens on `\\.\pipe\gavin-<tag>-<fnv64(lower-cased socket path)>`. The path is `%LOCALAPPDATA%\gavin\daemon[-dev].sock`, so any local user who knows the victim's profile path can compute the name, and the named-pipe namespace is machine-global (the transport's own comment says that is why the DACL exists). A DACL only governs a pipe this process created first, and no CreateNamedPipeW in the tree passes FILE_FLAG_FIRST_PIPE_INSTANCE: not Listener::bind_at/create_instance, not Stream::pair. Clients open with CreateFileW and never compare the serving process's owner with themselves.

So suppose another account creates that pipe, with a DACL that admits the victim, while no daemon of that build is running (after boot, before first launch, in the Restart-daemon gap, after an update or a crash). The app's connect_or_spawn connects to it and spawns nothing. A daemon started anyway mints a new token, then bind_server's is_listening probe (a plain connect) succeeds and it exits with "another gavin-daemon is already listening". The singleton lock does not help: it is a file in the victim's own data directory and says nothing about who holds the pipe name.

The control meant to catch this, DP-06's server_proof, cannot. The app sends `Hello{auth: DaemonToken{token}, nonce}` and accepts `server_proof == HMAC-SHA256(token, nonce)`. Both inputs are fields of the Hello the app just sent, so whoever receives the Hello can compute an accepted proof without having held the token. Two sandbox runs against the v75 debug daemon showed an observer's HMAC over the Hello's own token and nonce equal to the daemon's server_proof every time. And the app never sends Hello, so never checks a proof, in two cases: when the peer reports any version from 5 to 34 (HELLO_MIN_VERSION is 35, MIN_COMPATIBLE_VERSION is 5, so classify() calls it Usable and the app shows only the older-daemon banner), and when the token file is absent (nothing is shown at all). Both continue as local.

From then on the squatter is the victim's daemon. It receives terminal keystrokes (WriteInput, pasted secrets included), CreateSession commands and cwds, card and file content, and the token; it can serve fabricated boards, sessions and output. The token it captures unlocks nothing, because no real daemon of the victim's runs. The victim's daemon never serves, which is also a denial of service.

Stream::pair has the same omission. It names its pipe `gavin-pair-<pid>-<counter from 0>`, with nMaxInstances 1 and no FILE_FLAG_FIRST_PIPE_INSTANCE, and production uses it: SessionManager::adopt_device serves each Companion Device connection over it with ClientIdentity::remote fixed by transport, and the app's ssh-link pump uses it too. Pids are visible to other users, so the name can be created ahead of time, not only raced, which undercuts the comment's "two-line window". Either the victim's end lands on a foreign instance (and the squatter could be served as that Device), or pair() fails and that Device connection or ssh link is refused; which one depends on Windows pipe-instance rules.

On macOS and Linux the endpoint sits in a 0700 per-user directory, so a squatter is same-uid and falls under AD-1. Windows is a release target (`.github/workflows/release.yml`, job `windows`).

## Root cause

Exclusive ownership of a named pipe is assumed, not enforced: no FILE_FLAG_FIRST_PIPE_INSTANCE, predictable names, and no client-side check that the server runs as the caller's user. The only server-authentication step is keyed by a secret the client sends to that same server first, and it is skipped for any server claiming a version below 35 and whenever the token file is missing. Both the app (connect_or_spawn) and the daemon (bind_server) read "something answers" as "my daemon is running".

## The invariant to enforce

The app talks to a local daemon only after that daemon has proven, without the app disclosing anything it could reuse, that it holds this user's daemon token. On Windows, a daemon pipe or pair pipe is served only by a process of the current user: the server creates the first instance or fails, and the client refuses a server whose process token user SID is not its own. No version, and no missing token file, turns either check off.

## Trace (lines as of 2026-10-16; re-read before editing)

- `crates/protocol/src/transport.rs:97` (pipe_name_for_path) and `:139` (win32_pipe_name): The name is the last path segment plus FNV-1a of the lower-cased path, "not a security boundary (the security descriptor is)".
- `app/src-tauri/src/daemon.rs:30` (connect_or_spawn): Line 35 returns the first stream that connects; nothing is spawned while a squatter answers.
- `crates/daemon/src/server.rs:7849` (run_server): Mints and writes a new token (7853) before bind_server runs.
- `crates/daemon/src/server.rs:7865` (bind_server): is_listening at 7871 and the bail at 7872 read a foreign pipe as this user's daemon.
- `crates/protocol/src/transport.rs:1126` (is_listening): `Stream::connect(endpoint).is_ok()`.
- `crates/protocol/src/transport.rs:957` (Listener::bind_at): The first instance comes from create_instance at 960; accept (963-986) creates every later instance with the same call (969, 978).
- `crates/protocol/src/transport.rs:1003` (create_instance): Open mode `PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED` (1007), PIPE_UNLIMITED_INSTANCES, the current_user_only descriptor (871, `D:P(A;;GA;;;SY)(A;;GA;;;<sid>)` at 875). An existing name is not a failure.
- `crates/protocol/src/transport.rs:639` (Stream::pair): Name `gavin-pair-<pid>-<counter>` (643), CreateNamedPipeW with nMaxInstances 1 and no FILE_FLAG_FIRST_PIPE_INSTANCE (650). The comment at 631-638 assumes the name cannot be pre-created. Production callers: `crates/daemon/src/server.rs:2570` (adopt_device) and `app/src-tauri/src/remote.rs:154` (ssh-link pump).
- `crates/protocol/src/transport.rs:564` (Windows Stream::connect_at): CreateFileW at 582 with no check of who owns the server. `server_pid` (1090) exists and current_user_sid_string (912) already reads a token's user SID, but nothing compares the two.
- `app/src-tauri/src/session.rs:3270` (verify_daemon_protocol): Classifies the peer's self-reported version against MIN_COMPATIBLE_VERSION = 5 (`crates/protocol/src/lib.rs:1107`; PROTOCOL_VERSION is 75 at line 964).
- `app/src-tauri/src/session.rs:3391` (app_handshake): A missing token file returns Ok with no Hello (3396).
- `app/src-tauri/src/session.rs:3406` (app_handshake_with_token): A version below HELLO_MIN_VERSION (35, line 3378) returns Ok with no Hello (3412). The ssh link presents a token read on the host through this same function.
- `app/src-tauri/src/session.rs:3354` (app_hello): The Hello carries the token in the clear beside the nonce.
- `app/src-tauri/src/session.rs:3316` (verify_app_ack): Accepts when server_proof equals `protocol::server_proof(token, nonce)` (3322), the token being the one the app just sent.
- Other app connections that present the same Hello with the same skips: `session.rs:3169` (open_command_stream, 3172-3173), `command_lane.rs:724` (redial), `browser_view.rs:524`, `forwarding.rs:218` and `:472`.
- `crates/protocol/src/lib.rs:3175` (server_proof): `hmac_sha256_hex(daemon_token, nonce)`. Its doc (3172-3174) and the Hello doc (2003) promise this tells the daemon from a squatter.
- `crates/daemon/src/server.rs:3970` (Hello, DaemonToken arm): Grants `app` on a token match and returns the proof (3985).
- `app/src/lib/core/daemonCompat.ts:15` (compatMessage): All a v5..v74 answer makes the app show is the older-daemon banner.
- `docs/security/01-daemon-protocol.md:24` and `:285` (DP-06): Triaged as AD-1 on the premise of a same-user squatter, which does not hold for the Windows pipe namespace.

## What the audit could not observe

- The Windows code cannot be built or run on the audit's macOS host, and no Windows VM was available.
- For the daemon pipe: that a pipe another standard user created with a DACL granting Everyone (or the victim) GENERIC_READ|GENERIC_WRITE opens from the victim's CreateFileW and answers is_listening. Source decides the rest.
- For Stream::pair: whether the victim's CreateNamedPipeW (nMaxInstances 1, own descriptor) on a name another user created with PIPE_UNLIMITED_INSTANCES succeeds as an extra instance, fails (ERROR_ACCESS_DENIED, ERROR_PIPE_BUSY), or is refused for the instance-count mismatch; and whether the victim's own CreateFileW then lands on the foreign instance.
- No app (app/src-tauri) test executable drives verify_app_ack or app_handshake against a fake peer, so the client half is source-traced. Only the daemon half (proof computable from the Hello) was executed.

## Fix

Four parts, one change.

1. **Server creates the first instance or fails** (`crates/protocol/src/transport.rs`). Listener::bind_at passes FILE_FLAG_FIRST_PIPE_INSTANCE on its first instance only; accept's later instances must not, or every second connection fails. Stream::pair passes it too and draws its name from `protocol::random_hex` instead of pid+counter.
2. **Client refuses a server that is not this user** (Windows connect_at). After CreateFileW, GetNamedPipeServerProcessId, then OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION) and OpenProcessToken(TOKEN_QUERY), and compare TokenUser's SID with current_user_sid_string. A mismatch, or any call that fails, closes the handle and returns a distinct error (say io::ErrorKind::PermissionDenied naming "held by another account"). Because is_listening goes through connect, bind_server and connect_or_spawn then see that error and report an impostor by name instead of "another gavin-daemon is already listening" or a silent connect. Keep the squatter-facing paths failing closed: the app must not spawn a second daemon onto a held name in a loop.
3. **A server proof that discloses nothing**, on every OS. Before the app sends its token, it sends a new request, e.g. `ServerChallenge { nonce }`, and the daemon answers `ServerProof { proof }` with proof = HMAC(token, a fixed domain separator + nonce), separated so no Hello-era value can be replayed as one. The app verifies it against its token file and only then sends the existing Hello with the token. Every Hello site listed in the trace goes through one helper so none can skip the step.
4. **No fail-open.** A local peer that cannot answer the challenge (any version below the one that adds it) is refused with a named state, the way verify_daemon_protocol already names a daemon too old to talk to ("restart it"), not the degraded banner. A peer that answers while the token file is missing is refused, not treated as local: the token is written before the socket binds (`read_daemon_token`'s doc comment, session.rs:3299-3304), so a missing file next to an answering peer is a pre-v35 daemon or a squatter. The ssh link gets the same proof; whether it also refuses a host daemon older than the new version is a compat choice to record in Comments, since that host's own endpoint is what the check protects.

Compat, per CLAUDE.md: bump PROTOCOL_VERSION to the next free version, give the new request its `min_version_for` entry, and remember the app now refuses rather than degrades below that version for the local daemon. An updated app meets its still-running older daemon this way until Restart daemon, so the refusal's message must say to restart it; note that in the card. The new request comes only from the Tauri host, not from a UI surface, so no `FEATURE_MIN_VERSION` entry is needed unless a UI surface ends up producing it. Update the docs that promise the old control: the Hello and server_proof doc comments, and DP-06 in `docs/security/01-daemon-protocol.md`, re-triaged for Windows' machine-global namespace.

Regression tests, written first:

- In app/src-tauri's session tests, with a fake peer over `Stream::pair()`: a peer that answers ProtocolVersion 75 and replies to Hello with HMAC(Hello.auth.token, Hello.nonce) must make the app's handshake fail. Today it passes, so the test fails. After the fix the peer never sees the token before it has to answer the challenge.
- A peer that reports version 34 must not be accepted; today app_handshake_with_token returns Ok at 3412.
- An answering peer with no token file must not be accepted; today app_handshake returns Ok at 3396. Run these under a temp HOME, as the daemon's `server::tests` must be (`require_local_token` and the token path live there).
- In crates/daemon's server tests: the daemon answers ServerChallenge with the separated HMAC, and its value differs from what the old Hello proof would give for the same nonce.
- `#[cfg(windows)]` tests in transport.rs: bind_at on a name that already exists fails; Stream::pair on a pre-created name fails; connect_at to a server of the same user still succeeds. CI's Windows job only runs `cargo check`, so these compile there; they run on the VM in the human test.
- From this mac, the cross-check in the Windows-port notes: `LIBSQLITE3_SYS_USE_PKG_CONFIG=1 SQLITE3_LIB_DIR=/usr/lib SQLITE3_INCLUDE_DIR=/usr/include cargo check -p protocol -p gavin-daemon -p gavin-mcp --tests --target x86_64-pc-windows-msvc`. It does not reach `-p app`; that crate's Windows half is the human test's.

## Done when

- The fix enforces the invariant above at the last trusted decision point, not in a caller.
- The regression cases named in the fix are tests in the touched crate or module, and they fail before the change.
- The regression test fails before the change and passes after it.
- The checks in CLAUDE.md pass for every part you touched, and the msvc cross-check compiles.
- Follow the CLAUDE.md traps that apply: a new SQLite column needs its own `ALTER TABLE`, a widened request needs a compat-gate entry, and you commit only your own files.
- Once the fix is in, file this check with `gavin_request_human(<this card>, "test", …)` using exactly this text: "On a disposable Windows VM with two standard accounts, have the second account create the first account's gavin daemon pipe name with a DACL granting Everyone access and answer ProtocolVersion 75 (and, in a second run, 34), then launch Gavin as the first account and check that the app names the pipe as held by another account and sends that server nothing, and that with no squatter Gavin starts and connects as usual."

- [ ] Human test: On a disposable Windows VM with two standard accounts, have the second account create the first account's gavin daemon pipe name with a DACL granting Everyone access and answer ProtocolVersion 75 (and, in a second run, 34), then launch Gavin as the first account and check that the app names the pipe as held by another account and sends that server nothing, and that with no squatter Gavin starts and connects as usual.

## Comments

### 2026-10-16

Lead confirmed: the three session regression tests failed before any fix (`a_peer_that_only_learns_the_token_from_hello_cannot_complete_handshake`, `a_daemon_reporting_version_34_is_refused`, `an_answering_peer_with_no_token_file_is_refused`), then passed after.

**Compat.** `PROTOCOL_VERSION` is 76. An updated app meeting a still-running older local daemon refuses with "too old … restart it (quit gavin, then relaunch)" — not the degraded banner. No `FEATURE_MIN_VERSION` entry: `ServerChallenge` is Tauri-host only.

**ssh.** Same refusal for a host daemon below 76 or a bridge banner with no token: the host's own endpoint is what the check protects, so the link does not fail open to `local`.

**MSVC.** Plain `cargo check --target x86_64-pc-windows-msvc` hits `ring`'s need for an MSVC C toolchain on this Mac; `cargo xwin check -p protocol -p gavin-daemon -p gavin-mcp --tests --target x86_64-pc-windows-msvc` (with the LIBSQLITE3 env from the Windows-port notes) compiles clean, including the `#[cfg(windows)]` transport tests.
