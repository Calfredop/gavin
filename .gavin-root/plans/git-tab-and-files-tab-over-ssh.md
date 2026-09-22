---
kind: task
title: Git tab and Files tab over ssh
parent: feat-ssh-support.md
complexity: intricate
---
Read `docs/superpowers/specs/2026-09-22-ssh-workspaces-design.md` (§1, §7) first. An ssh workspace's daemon runs on the host and the app reaches it through `app/src-tauri/src/remote.rs`. The Git tab (`app/src-tauri/src/git/*`, about sixty Tauri commands shelling out to the system `git` against a local root) and the Files tab and file viewer (`fileviewer.rs`, local `std::fs` confined to the workspace root) have no remote path; the frontend task gates them off for ssh workspaces with a notice.

Design first, then build. Write a short spec under `docs/superpowers/specs/` choosing between (a) moving the git and file operations behind daemon requests the host daemon answers (the daemon already runs `git status` in `git_status.rs`; the protocol grows by a request family in one bump, with `FEATURE_MIN_VERSION` entries that have real consumers), and (b) a generic "exec on the host" request over the link (simpler, but a remote shell in the protocol is exactly what `docs/security/05-remote-access.md` refuses to put on the wire; argue it against the `authorize` table in `crates/daemon/src/server.rs` before choosing it). Prefer (a). Keep the Git tab's own logic (`git/parse.rs`, `run.rs`, `ops.rs`) where it is and change only where the process runs and where files are read; the frontend should not know which.

Scope for this card: the Git tab's local changes, status, diff, stage and unstage, commit and log; the Files tab's list, read and write. Leave sync, branches, worktrees and conflicts for a follow-up card you file. Remove the corresponding frontend gating as each surface works.

Tests: daemon tests for every new request against a temp git repository, app tests for the routing, then `cargo test -p protocol`, `cargo test -p gavin-daemon`, `cargo test -p app`, `cd app && npm test && npm run check`. Commit only the files you touched.
