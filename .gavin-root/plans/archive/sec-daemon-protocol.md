---
kind: task
title: [sec] daemon & protocol surface
parent: review-security-audit.md
complexity: complex
---
Audit `crates/daemon` and `crates/protocol` against `docs/security/00-threat-model.md` (read it first; every finding cites one of its three adversaries) and write `docs/security/01-daemon-protocol.md`.

## Cover

- **The socket and who a client is.** `protocol::socket_path()` (`~/Library/Application Support/gavin/daemon.sock`), the bind in `server.rs::bind_server` (dir `0700`, socket `0600`). There is no peer-credential check, no token, no handshake beyond the version number — state exactly what that means for each adversary.
- **Every `Request` variant** in `crates/protocol/src/lib.rs` (61 of them) for what it can reach: files, processes, other sessions, other workspaces. In depth for `CreateSession` and `SpawnAgentSession` (the command string goes to `/bin/sh -c`, `pty.rs:41`), `WriteInput`/`QueueInput`/`SendQueuedInput`, `KillSession`, `Shutdown`, and every variant that takes a path or root from the wire (`InitGavinRoot`, `CreatePlan`, `DeleteCardFile`, `SetPlanFrontmatterField`, `SetRootConfigField`, the `*ByRoot` family). Does anything confine those paths, or does the daemon write wherever it is told?
- **What sits at rest.** The SQLite registry (`registry.rs`): `sessions`, `queued_inputs`, `card_runs`, `tool_runs`, the orchestration tables. What a same-user reader learns; whether queued input or screen snapshots can hold pasted secrets.
- **The `.gavin*` watcher** (`gavin.rs`): what it trusts in file contents and file names, and what a hostile repo can make it do.
- **Resource exhaustion**: unbounded sessions, snapshot and scrollback sizes, the streaming connection, the watcher on a huge tree.

## Rules

- **Never touch the running daemon** — no `pkill`, no restart. Every reproduction runs against a throwaway daemon started under a temp `$HOME` (it gets its own socket and databases).
- **Reproduce the headline**: a second process, running as the user, connects to the socket and obtains a shell. Record the exact steps against the throwaway daemon.
- **A reproduction, or an admission.** Every high-severity finding either carries steps or says in one line that it is argued from reading and not reproduced.
- **Describe, do not weaponise.** Impact and a minimal repro; no polished exploit, no extraction tooling.
- **Mark each finding** `vulnerability` or `boundary` — "any process running as you can do X" is the design until the threat model says otherwise.

## Output

`docs/security/01-daemon-protocol.md`: a findings table (id, severity, adversary, vulnerability/boundary, reproduced yes/no), then one section per finding, then what the daemon would need to gain (client identity on the socket first). Do not fix anything. Do not file cards — the parent plan does that after the dedupe pass.
