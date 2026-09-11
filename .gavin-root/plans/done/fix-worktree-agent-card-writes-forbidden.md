---
title: A worktree agent cannot write its own card: the scope gate reads a workspace_path that is only a copy of cwd
status: Done
priority: urgent
---
Every agent a rail launches in a worktree is refused the one card write the
run prompt tells it to make:

```
unexpected response: Forbidden { request_type: "SetPlanFrontmatterField", role: "agent" }
```

26 occurrences across 138 agent sessions, first 2026-09-09 10:56, still
happening. `gavin_create_plan` fails the same way (3); `gavin_promote_task`
and `gavin_create_context` share the gate and will too.

## Cause

`917bcc2` (client identity and roles, v35) confines an agent's card writes
to `scope_roots` — the session's `workspace_root` and `cwd`
(`crates/daemon/src/server.rs:3821`), documented as *"Both are kept because
a rail agent runs in a worktree (`cwd`) that is not the workspace root
(`workspace_path`)"*.

That assumption is false. `app/src-tauri/src/session.rs:4049` sends
`workspace_path: target.clone(), cwd: target.clone()` — one value twice —
and `sessionsManager.ts:176` says so out loud: *"a session's `workspacePath`
is the directory it was created in"*. The live registry agrees: every rail
session has `workspace_path == cwd == the worktree`.

So a worktree agent's scope is the worktree alone, while `cardHomeNote`
(`app/src/lib/cards/cardRun.ts:63`) tells that same agent the card *"lives
at /…/.gavin-root/plans/… and nowhere else"* and to *"never write the copy
under your working directory"*. The app demands the main-checkout path; the
gate refuses it.

It shipped green because every `authorize` test builds its identity as
`ClientIdentity::agent("sess-1", &root, &root)` — root equals cwd, so the
worktree case the doc comment claims to support is never exercised.

## Fix: make `workspace_path` carry the owning workspace root

The gate is right; the data it reads is wrong. Correcting the field also
repairs two things that silently cannot work today: `recovery_cwd`'s
fallback (`server.rs:2653`, which falls back to the same dead cwd) and
`profileForSession`'s workspace lookup (`memoryState.ts:136`, an exact
`rootPath === workspacePath` match that no worktree session can satisfy).
No protocol change — the field already exists, only its value changes.

- [x] Host: `create_fresh_session` takes the owning workspace root and sends it as `workspace_path`, `cwd` unchanged; no root given keeps today's behaviour
- [x] Host: the `create_session` command gains `workspace_root`
- [x] Host: thread the workspace root through `resolve_sessions` so a restart restores a rail session against its workspace, not its worktree — taken from the saved layout, which is right even for rows written before the field carried a workspace
- [x] Frontend: `backend.createSession` gains `workspaceRoot`; no new lookup helper was needed, `layoutState.workspaceRootPath` already is one
- [x] Frontend: pass it at all 15 `createSession` call sites
- [x] Daemon: regression test pinning the contract — an agent scoped to (workspace root, worktree cwd) may write its workspace's card
- [x] Correct the now-stale comments on `scope_roots` and `recovery_cwd`
- [x] `cargo test --workspace` (1139), `npm test` (5406), `npm run check` (0 errors), `npm run build` — and all of it again in a detached worktree carrying only these 14 files

## What it takes to land

The daemon change is a test and two comments: **no protocol bump, no daemon
rebuild, no daemon restart.** The gate already reads `workspace_path`; it was
only ever being handed the wrong value. What has to be rebuilt is the **app**,
because `create_session` lives in the Tauri host.

Until then, and for any session created before it, `workspace_path` is still a
copy of the cwd — so a rail agent already running stays refused until its
session is relaunched. The unblock in the meantime is the daemon socket
directly: an untokened connection is `local` and keeps full reach, since
`require_local_token` is off.


## Out of scope (same family, separate card)

`gavin-mcp`'s `find_gavin_root` walks up from cwd, so in a worktree it
resolves to the worktree's own tracked `.gavin-root` decoy — 132
`workspace not open in gavin` read failures since 2026-08-21. Fixing that
means carrying the session's workspace root in `HelloAck`.
