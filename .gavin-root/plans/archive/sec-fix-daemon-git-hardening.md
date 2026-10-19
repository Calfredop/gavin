---
order: 28672
kind: task
title: "[sec] Daemon's automatic git status runs an embedded repository's committed core.fsmonitor when terminal output (OSC 7) names a directory inside a cloned repo"
status: Done
priority: medium
complexity: moderate
---
Fix a medium-severity finding from the 2026-10-15 security audit (run-1). Fingerprint: `git-config-exec-in-repo-selected-cwd`.

Full record: `findings.json` in `~/security-audit-skill/gavin/run-1/`, outside this repo. The audit card is `review-security-audit-2026-10-15.md`.

## What is wrong

The shared gavin-daemon runs `git rev-parse --show-toplevel` and then `git --no-optional-locks status --porcelain=v2 --branch` on its own, in a working directory taken verbatim from any OSC 7 cwd report its PTY pump scans out of an attached session's output. Nothing checks that the path lies inside a trusted workspace, and the git spawns carry no hardening: no safe.bareRepository, core.fsmonitor or core.hooksPath override, no GIT_CEILING_DIRECTORIES, no GIT_CONFIG_NOSYSTEM. A cloned repository can commit an embedded git directory (HEAD, config, objects/, refs/ as ordinary tracked files) whose config sets core.fsmonitor to any command. When an OSC 7 naming that directory reaches an attached session, git discovers the embedded directory as a repository and the daemon's RepoPoller `git status` runs the committed fsmonitor command as the user. The OSC 7 can come from a prompt that reports its cwd after a `cd`, or only from displayed bytes, such as `cat` of a file that carries the sequence. In the second case the shell never enters the directory. Git's own defaults on this host (Apple Git 2.54.0, safe.bareRepository unset, so it means 'all'; same-user ownership) do not stop it, and no gavin control does either. This was reproduced end to end against the prebuilt debug daemon.

## Root cause

update_session_repo_mapping (server.rs:1105-1106) passes a raw OSC 7 path to git_status::resolve_repo_root. register_session_with_repo -> spawn_repo_poller -> trigger_recheck then runs run_git_status in whatever root git resolves (server.rs:1182-1276, 1402-1423; git_status.rs:78-84, 155-162, 243-248). All of this goes through program::command (program.rs:38-46), which adds no git hardening and no discovery ceiling. git trusts an implicitly discovered bare-style git directory, and its config, for a same-user path by default. A repository's committed files therefore become command execution inside the daemon.

## The invariant to enforce

Git calls the daemon makes on its own, in a directory chosen by terminal bytes, must not let repository content drive command execution. They should run with core.fsmonitor (and hooks/textconv) disabled and with safe.bareRepository=explicit. Before a poller is registered, a resolved repo root outside the session's trusted workspace (or a known worktree of it) should be refused, so an embedded repository is never adopted or honoured.

## Trace (lines as of 2026-10-16; re-read before editing)

- `crates/daemon/src/server.rs:6126` (spawn_pump PTY read loop (runs while a client is attached to the session)): Every chunk of PTY output is fed to osc_scanner.feed. Any `ESC ]7;file://host<path> BEL/ST` yields a cwd string. osc.rs parse_payload (osc.rs:97-104) only strips the scheme and host and percent-decodes the rest. It does not care whether the bytes came from a shell prompt or from file content that was displayed.
- `crates/daemon/src/server.rs:6138` (spawn_pump -> update_session_repo_mapping): A cwd that differs from the last one seen is passed straight to update_session_repo_mapping for that session, with no validation.
- `crates/daemon/src/server.rs:1106` (update_session_repo_mapping): Calls git_status::resolve_repo_root(cwd) on the raw path. On a change of root it calls register_session_with_repo (line 1129), which spawns spawn_repo_poller on a new thread for a root it has not seen before (line 1209).
- `crates/daemon/src/git_status.rs:78` (resolve_repo_root): Runs `git rev-parse --show-toplevel` with current_dir(cwd) through program::command. git discovers the embedded git directory and returns it as the toplevel.
- `crates/daemon/src/server.rs:1276` (spawn_repo_poller -> trigger_recheck): Runs an immediate trigger_recheck for the new root. A backstop timer (line 1272) and a filesystem watch then re-run it. trigger_recheck calls run_git_status(repo_root) at line 1423.
- `crates/daemon/src/git_status.rs:156` (run_git_capture via run_git_status (git_status.rs:243-248)): Spawns `git --no-optional-locks status --porcelain=v2 --branch` with current_dir at the embedded root. git reads the committed core.fsmonitor from that directory's config and executes it as the daemon's user.

## Fix

Harden every git subprocess the daemon (and the host) starts on its own so repository content cannot drive execution, and bound discovery to the trusted workspace. In git_status.rs, build git through one helper that passes `-c core.fsmonitor=false -c core.hooksPath=/dev/null -c safe.bareRepository=explicit` and sets GIT_CONFIG_NOSYSTEM=1. In update_session_repo_mapping, refuse a resolved root that is not the session's workspace_path or a known worktree of it, before register_session_with_repo spawns a poller. Apply the same `-c` set to app/src-tauri/src/git/run.rs git_command for read-only status/diff calls (with `--no-textconv`/`--no-ext-diff` where a diff is rendered).

`crates/daemon/src/git_status.rs`, as a sketch only:

```
/// git as this scanner runs it: repository config may not run anything.
fn git() -> std::process::Command {
    let mut c = crate::program::command("git");
    c.env("GIT_CONFIG_NOSYSTEM", "1").args([
        "-c", "core.fsmonitor=false",
        "-c", "core.hooksPath=/dev/null",
        "-c", "safe.bareRepository=explicit",
    ]);
    c
}
// resolve_repo_root / head_sha / run_git_capture use git() instead of
// crate::program::command("git"), and update_session_repo_mapping drops a
// resolved root that is not within the session's workspace_path.
```

## Done when

- Every git call the daemon and host make on their own (git_status.rs, git_watch.rs, the host's git_command for read-only status and diff) goes through one hardened builder.
- A resolved repo root outside the session's workspace is refused before a poller is registered.
- A regression test commits an embedded git directory whose `core.fsmonitor` touches a marker, feeds an OSC 7 naming it, and asserts the marker is never created. It must fail before the change.
- The checks in CLAUDE.md pass for every part you touched, and you commit only your own files.
