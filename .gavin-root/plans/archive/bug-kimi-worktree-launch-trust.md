---
order: 1168
kind: task
title: [bug] kimi runs in gavin worktrees still stop at the trust screen (or drop the gavin MCP server)
status: Done
priority: high
---
Follow-up of bug-kimi-launch-integrations.md (read its sections 2 and "Resumed 2026-10-12" first), and of feat-kimi-integration.md's answered decision (2026-10-06, option A): **gavin trusts each gavin-created worktree at the launch of a kimi session in it, with the same consent rules as the root grant.** That answer is settled; do not re-open it. No code implements it yet.

## The gap

- kimi keys folder trust on the exact physical cwd. A trusted parent does not cover a child, and a worktree is its own kimi workspace (proved against kimi 2.1.1; key derivation is `kimi_trust_key` in app/src-tauri/src/agent_setup.rs).
- Visible launches go through the app's `create_session` (app/src-tauri/src/session.rs, around line 6300), which calls `prepare_kimi_launch` → `grant_kimi_launch_trust` (agent_setup.rs, around line 2793). That function refuses whenever a `.mcp.json` or `.kimi-code/mcp.json` lies between the cwd and the workspace root. A `.gavin-worktrees/<wt>` checkout of a repo that commits `.mcp.json` (this repo does) always has one at the worktree root, so a visible kimi run in a rail or Best-of-N worktree still stops at "Trust this folder?". The queued prompt then lands on the wrong screen and is lost.
- kimi reads project MCP servers from `<git work tree root>/.mcp.json` and `<cwd>/.kimi-code/mcp.json`. For a worktree, the git work tree root IS the worktree. So the right rule for a gavin-created worktree is to vet the worktree's own MCP files the way the root's are vetted (only gavin's server, unreadable means withhold), not to refuse outright. Keep the refusal for an MCP file declared at a level between a plain subfolder and the root.
- Headless launches (`kimi --prompt=`, used by rail card steps since bug-rail-card-steps-kimi-headless.md in plans/done/) do not stop in an untrusted folder. Instead they silently skip project MCP servers (`Warning: this folder is not trusted; skipped 1 project-level MCP server`), so the run has no gavin_* tools.

## Work

1. Map every path that starts a kimi session: board Run, develop/review, rail card steps (headless), rail agent-tool steps, Best-of-N, daemon auto-resume/recover. For each, record its cwd and whether it passes through the app's `create_session`. If any path is daemon-only, the trust-key derivation and grant have to move somewhere the daemon can call (a shared crate). The original card already flagged that; decide it from what you find.
2. Implement the worktree grant per decision A on every kimi launch path, with the same consent rules as `grant_folder_trust` and `try_grant_folder_trust`:
   - never over an existing record
   - never on an ssh workspace
   - follow `KIMI_CODE_HOME`
   - owner-only permissions
   - withhold when a foreign server is declared
3. Unit tests with the fake `WorkspaceFiles`: a worktree with a committed gavin-only `.mcp.json` is granted; one that declares a foreign server is withheld; a plain subfolder with an intermediate `.mcp.json` is still withheld; a headless launch path gets the grant too.
4. `cargo test -p app --lib` and `cargo test -p gavin-daemon` (daemon tests under a temp HOME: `require_local_token` on this Mac fails server::tests as Forbidden local). If you touch the TS side: `cd app && npm test && npm run check`.
5. File a `Human test:` for the live check: a kimi rail card step and a Best-of-N run in a worktree start without the trust screen, and their gavin_* tools work.

## Constraints

- The working tree is shared. app/src-tauri/src/session.rs already carries another session's uncommitted edits: leave them intact. Commit nothing; the human commits.
- Any save under app/src-tauri relaunches the owner's dev app. Batch your edits there.
- Update docs/security/03-agent-surface.md (AG-07 note) to say worktrees are now granted.

## Done (2026-10-12)

### 1. Every path that starts a kimi session

| Path | cwd | Through the app's `create_session`? |
|---|---|---|
| Board Run (`cardRunActions.ts` launch) | card's context folder | yes, with the kimi profile id |
| Resume / rerun | the run's cwd (worktree or folder) | yes |
| Best-of-N / run in a worktree | `<root>/.gavin-worktrees/<b>` | yes |
| Rail card step | rail checkout | yes. `createSessionOnRailPage` → `createSessionOnPage` → `backend.createSession`. It is K3 injection, not headless (see bug-rail-card-steps-kimi-headless.md, "Resolution"). The card's premise that rail steps run `kimi --prompt=` does not hold. |
| Rail agent-tool step, workspace tool, clean stale, code review | root or rail checkout | yes |
| Commit via agent (the one headless `--prompt=` app launch) | the git view's checkout | yes |
| Auto-resume relaunch | the session's cwd | yes (`withoutHeadroom` variant) |
| Phone (Companion) start | as the desk's | yes: the forwarded invoke runs the desk's command |
| Daemon recover | none | it no longer re-runs agent commands, so it starts no kimi |
| **MCP `gavin_spawn_session`** | any | **no**. gavin-mcp → `SpawnAgentSession` → `create_session_as`, daemon-only |

One path is daemon-only, so I moved the rule into a shared crate as the card asked: `crates/protocol/src/kimi_trust.rs`. It is pure like `protocol::playwright`: the disk is a `TrustFiles` trait, and the clock is handed in. It still builds for wasm.

### 2. The grant

- `protocol::kimi_trust`: key derivation, record shape, `home_from`, `write_record` (never over an existing record), and `launch_grant`. These moved out of agent_setup.rs. Their byte-exact tests moved with them.
- New rule in `launch_grant`. When the cwd is inside `<root>/.gavin-worktrees/<name>` and that folder is a linked checkout (`.git` is a file), the worktree's own root is not refused as an intermediate declaration. Its `.mcp.json` and `.kimi-code/mcp.json` are vetted by the root's rule instead: only `gavin`, plus the Playwright entry exactly as gavin writes it; unreadable means withhold. Any other level between the cwd and the root still refuses, inside a worktree or not. The root must still vet clean.
- App: `grant_kimi_launch_trust` is now a thin wrapper. It needs `agent_home`, so it never writes for ssh, and it follows `KIMI_CODE_HOME` through `fs.env_var`. `try_grant_folder_trust` writes through `kimi_trust::write_record`. `TrustDisk` adapts `WorkspaceFiles`. No change to session.rs, so the other session's edits there are untouched.
- Daemon: new `crates/daemon/src/kimi_trust.rs`. `spawn_agent_session` calls `prepare_spawn` before it spawns when the command line's first token is kimi (`Agent::from_command`). The write is owner-only (0700/0600). On an ssh host the daemon writes its own disk, which is where kimi runs, so "never for an ssh workspace" (a desk out of reach of the host's home) still holds. The daemon does not know gavin's own command, so on this path only the `gavin` key counts as gavin's. A `.mcp.json` that also has the Playwright entry withholds there, and kimi asks as before.
- docs/security/03-agent-surface.md: AG-07 has an "Update 2026-10-12" note.

### 3. Tests

- protocol (9): kimi's own keys and slugs, the record shape, the home override. Also: a gavin-only worktree is granted, at its root and below it. A foreign, unreadable or `.kimi-code`-declaring worktree is withheld, and so is a foreign root. An intermediate `.mcp.json` withholds, in a worktree and in a plain subfolder. A non-checkout under `.gavin-worktrees` is a plain folder. Neither the root nor a folder outside it is granted. The Playwright entry counts only when gavin's own command is known.
- app (4 new, through `HomedFiles`/`MemoryFiles`): a worktree with gavin-only `.mcp.json` is granted and a foreign one withheld; intermediate files withhold in and out of a worktree; no home means no grant; `WORKTREES_DIR` equals `git::commands::WORKTREES_DIR`.
- daemon (4): an MCP spawn of kimi in a worktree is granted for a headless line (`kimi --prompt='…'`), a bare `kimi` and a binary named by path, owner-only. Non-kimi lines get nothing, and nor does a spawn with no home. A foreign server withholds, a record is never rewritten, and `KIMI_CODE_HOME` moves the record.

### Not covered, on purpose

- A worktree a human cut outside `.gavin-worktrees`: the cwd is outside the root, so it is withheld as before. Gavin cannot tell it made that folder.
- A repo that does not commit `.mcp.json` has none in its worktrees. kimi is then trusted there but has no gavin server, because gavin copies no `.mcp.json` into a new worktree. That is a separate gap, not a trust one.
- A monorepo workspace opened below the git root: a launch in `<wt>/<package>` meets the package's own committed `.mcp.json` as an intermediate file and is withheld.
- The MCP-spawn grant needs a daemon rebuild and restart. The app-side grant needs only the app rebuilt (the dev app's own rebuild).

### Verification

- `cargo test -p protocol`: 246 passed. `cargo check -p protocol --no-default-features --target wasm32-unknown-unknown`: clean.
- `cargo test -p app --lib`: 803 passed.
- `cargo test -p gavin-daemon` under a temp HOME: 1125 passed, 4 failed in code this card does not touch. All four pass when re-run alone:
  - `browser::screencast` and the two `server::tests` git-status tests are timing races under full-suite load.
  - `paths_are_scoped_under_app_support` fails only under the temp HOME, which has no `Library/Application Support`.
- Re-verified later on 2026-10-12 against the shared tree as it then stood:
  - protocol `kimi_trust`: 9/9. wasm check: clean. `cargo test -p app --lib`: 803 passed.
  - daemon `kimi_trust`: 4/4. Daemon unit tests under a temp HOME: 1127 passed, 2 failed.
    - `paths_are_scoped_under_app_support` and `pty::tests::spawn_exports_this_daemons_endpoint_into_the_pty` both fail because `protocol::socket_path()` cannot resolve under a temp HOME.
    - The pty test passes under the real HOME once `GAVIN_SESSION_SOCKET` is unset. A Claude session started inside gavin leaks that variable into the test.
  - Daemon integration tests: all green. device_wire passed 71/71 on a re-run; `after_revoke_all_an_old_devices_ik_is_refused` failed once, from timing.
- No TS change: every app launch already sends the kimi profile id to `create_session`.
- Nothing committed. Files: crates/protocol/src/{kimi_trust.rs (new), lib.rs (one `pub mod`)}, crates/daemon/src/{kimi_trust.rs (new), main.rs (one `mod`), server.rs (one call in `spawn_agent_session`)}, app/src-tauri/src/agent_setup.rs, docs/security/03-agent-surface.md. protocol/lib.rs and server.rs already carried other sessions' edits, and those are untouched.

- [ ] Human test: Kimi in worktrees (dev app rebuilt on this tree, workspace agent = Kimi Code): (1) run a kimi rail card step on a rail with its own worktree, and (2) a Best-of-N run of a card — each kimi starts with NO "Trust this folder?" screen, the card prompt arrives and is sent by itself, and the agent can call a gavin_* tool (e.g. gavin_get_board). Optional, after a daemon rebuild+restart: ask an agent to gavin_spawn_session("kimi", <a .gavin-worktrees/<branch> path>) and expect no trust screen either.
