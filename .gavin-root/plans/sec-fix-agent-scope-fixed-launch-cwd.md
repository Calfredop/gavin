---
kind: task
title: "[sec] OSC 7 cwd from PTY output becomes an agent's authorization scope root"
status: To Do
priority: low
complexity: moderate
---
Fix a low-severity finding from the 2026-10-15 security audit (run-1). Fingerprint: `crates/daemon/src/server.rs:resolve_hello:osc7-cwd-feeds-agent-scope`.

Full record: `findings.json` in `~/security-audit-skill/gavin/run-1/`, outside this repo. The audit card is `review-security-audit-2026-10-15.md`.

## What is wrong

The daemon saves every OSC 7 'current directory' report it finds in a session's PTY output into that session's registry row. resolve_hello then reads the row's cwd as one of the two scope roots of the agent identity it grants to that session's token. Anything that writes an OSC 7 sequence into the session's terminal output can move the agent's daemon-side scope to any directory, including '/'. That includes the session's own processes, or any output the session's shell passes through. The move takes effect on the next session-token Hello. agent_allows checks the ScanGavinRoot and *ByRoot reads and writes, card writes, RecordShellWrites and SpawnAgentSession (with its kimi folder-trust grant) against those roots. So a token that docs/security/05-remote-access.md says is confined to the workspace its session was created for reaches other workspaces on the machine. A connection that was already open keeps its old scope, because identity is resolved once per Hello.

## Root cause

Two values share one column. One is the shell-reported cwd, which PTY output can set to anything and which is shown only for display. The other is the launch cwd, which resolve_hello treats as an authorization scope. ClientIdentity.cwd is read from registry sessions.cwd (server.rs:4013). The session pump overwrites that column with every path OscCwdScanner reports, and nothing checks the path against workspace_path or the launch cwd (server.rs:6126-6127 -> registry.rs:685).

## The invariant to enforce

An agent's scope is fixed when its session is created: its workspace_path plus the cwd it was launched in. That matches the design in docs/security/05-remote-access.md: token -> session -> workspace_path, 'every path-taking request from that connection is confined to that root'. PTY output may change the cwd the UI shows for the session. It must never change which roots agent_root_in_scope or agent_path_in_scope accept.

## Trace (lines as of 2026-10-16; re-read before editing)

- `crates/daemon/src/osc.rs:32` (OscCwdScanner::feed): Scans raw PTY output and returns the decoded path of every ESC ]7;file://host<path> sequence ending in BEL or ST, no matter which process in the session wrote it.
- `crates/daemon/src/server.rs:6127` (session pump thread): Writes each reported path to the session's registry row with update_cwd. Nothing checks it against workspace_path or the launch cwd.
- `crates/daemon/src/registry.rs:685` (Registry::update_cwd): UPDATE sessions SET cwd = ?1 WHERE id = ?2. This is the same column CreateSession filled with the launch cwd.
- `crates/daemon/src/server.rs:4013` (SessionManager::resolve_hello): A SessionToken Hello builds ClientIdentity{role: Agent, cwd: Some(rec.cwd)}, so the path from OSC 7 becomes a scope root.
- `crates/daemon/src/server.rs:7255` (scope_roots): The scope roots are workspace_root and cwd, both canonicalized.
- `crates/daemon/src/server.rs:7318` (agent_allows): Uses agent_root_in_scope (7284) and agent_path_in_scope (7268) to gate ScanGavinRoot, the *ByRoot reads and writes, card writes, RecordShellWrites and SpawnAgentSession (7383). The SpawnAgentSession path then writes a kimi trust grant at server.rs:4210. Any path under the moved cwd root is accepted.

## Fix

Separate the authorization scope from the display cwd. Store the launch cwd in its own column that never changes (for example scope_cwd), set only in create_session_as and copied on recovery. Add it with an ALTER TABLE ... ADD COLUMN migration that backfills from cwd for existing rows, and have resolve_hello build ClientIdentity.cwd from that column. OSC 7 keeps updating only the display cwd used by Attach, CwdChanged and the repo mapping. Add a regression test: an agent token whose session prints OSC 7 for an out-of-scope directory is still refused ScanGavinRoot and SpawnAgentSession there. Add a pre_v* test that proves the migration on a registry built with the old schema.

`crates/daemon/src/server.rs`, as a sketch only:

```
// resolve_hello, SessionToken arm:
cwd: Some(std::path::PathBuf::from(&rec.scope_cwd)), // launch cwd, never the OSC 7-reported one
```

`crates/daemon/src/registry.rs`, as a sketch only:

```
// Registry::open, beside CREATE TABLE IF NOT EXISTS sessions:
let _ = conn.execute("ALTER TABLE sessions ADD COLUMN scope_cwd TEXT", []); // duplicate-column error swallowed
conn.execute("UPDATE sessions SET scope_cwd = cwd WHERE scope_cwd IS NULL", [])?;
// update_cwd keeps writing only `cwd`; insert() writes both cwd and scope_cwd from the launch cwd.
```

## Done when

- The fix enforces the invariant above at the last trusted decision point, not in a caller.
- The regression cases named in the fix are tests in the touched crate or module, and they fail before the change.
- The checks in CLAUDE.md pass for every part you touched.
- The audit reproduction no longer works. It is the record's `execution` field in `findings.json`.
- Follow the CLAUDE.md traps that apply: a new SQLite column needs its own `ALTER TABLE`, a widened request needs a compat-gate entry, and you commit only your own files.
