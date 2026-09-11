# Per-build daemon isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a debug build and a release build of gavin their own daemon — own endpoint, own token, own log, own session registry — while both keep reading and writing one shared board, one set of rails, one workspace list and one settings file.

**Architecture:** A compile-time `BuildProfile` in `crates/protocol` (`cfg!(debug_assertions)`) suffixes the four file names that belong to one running daemon. `app_support_dir()` and the app's `app_config_dir()` call sites are untouched, so the shared stores and `config.json` stay shared and the release build's paths stay byte-identical. Because the isolation key is a compile-time fact rather than an environment variable, nothing is inherited by a PTY and nothing has to be stripped. The one thing isolation forces is that the daemon must tell each PTY which endpoint it is, since the workspace's MCP config names a single `gavin-mcp` binary that either build may end up launching.

**Tech Stack:** Rust (`protocol`, `daemon`, `gavin-mcp`, Tauri host in `app/src-tauri`), PowerShell launcher scripts.

**Spec:** `docs/superpowers/specs/2026-09-11-per-build-daemon-isolation-design.md`

## Global Constraints

- **`Release` must produce today's names byte-for-byte.** `daemon.sock`, `daemon.token`, `daemon.log`, `registry.sqlite`. This design ships no migration; a changed release literal is a daemon that loses its registry and an app that cannot authenticate to it.
- **`resolve_app_support_dir` does not change.** Not its signature, not its body, not its tests. The state directory is shared and that is the design.
- **`kanban.sqlite` and `orchestration.sqlite` do not split.** They hold the work — column and label vocabularies, `card_sessions`, `card_runs`, rails, stages, steps, conflict notes, tools, group templates, run state.
- **`config.json` at `%APPDATA%\com.gavin.app` does not split.** Neither do the 16 `app_config_dir()` call sites in `app/src-tauri/src/session.rs` and `app/src-tauri/src/updater.rs`. Do not touch them.
- **The dev suffix is `-dev`**, applied before the extension: `daemon-dev.sock`, `daemon-dev.token`, `daemon-dev.log`, `registry-dev.sqlite`.
- **No environment variable decides the state directory.** `GAVIN_SESSION_SOCKET` (Task 4) is read only by `gavin-mcp` and never by `resolve_app_support_dir`.
- **Commits happen when the human asks** (`CLAUDE.md`). Each task below ends with a verify-and-report step and the exact `git add` list; do not commit unless the human says to. Never `git add -A` — the working tree is shared with other sessions.
- **Suite baselines are already red.** Roughly 22 failures in the daemon's `server::tests`, ~8-9 in the app suite, 3 in protocol, before any change. Compare failure *sets* against a baseline run; a pre-existing failure is not a regression. The daemon's `gavin::tests` are flaky under full-suite cargo parallelism (fs-watcher timing) — re-run that module alone before calling it a regression.

**Checks** (from `CLAUDE.md`):

```
cargo test --workspace
cd app && npm test && npm run check && npm run build
```

---

## File Structure

| File | Responsibility in this change |
|---|---|
| `crates/protocol/src/lib.rs` | Owns the rule: `BuildProfile`, `profile_file_name`, and `socket_path` / `daemon_token_path` naming through it. |
| `crates/daemon/src/main.rs` | `db_path` splits; `kanban_db_path` and `orchestration_db_path` deliberately do not. |
| `crates/daemon/tests/shutdown.rs` | Spawns a real daemon under a fake `$HOME`; must derive the endpoint name, not hardcode it. |
| `crates/daemon/src/pty.rs` | Injects this daemon's endpoint into every PTY, surviving both scrub loops. |
| `crates/gavin-mcp/src/main.rs` | Prefers the injected endpoint over its own build's default. |
| `app/src-tauri/src/daemon.rs` | The daemon log file name. |
| `scripts/start-dev-win.ps1`, `scripts/start-stable-win.ps1` | Each names and probes the endpoint it drives. |
| `CLAUDE.md` | The shared-daemon paragraph, amended. |

---

### Task 1: The rule, in `protocol`

Adds `BuildProfile` and `profile_file_name`, routes `socket_path` and `daemon_token_path` through them, and fixes the two places that hardcode `daemon.sock` so the tree stays green. After this task a debug daemon and a release daemon bind different endpoints.

**Files:**
- Modify: `crates/protocol/src/lib.rs` (add near `HostOs`, around line 2416; `socket_path` at line 2598; `daemon_token_path` at line 1243; tests in `mod tests`)
- Modify: `crates/daemon/src/main.rs:74` (test assertion only — `db_path` itself is Task 2)
- Modify: `crates/daemon/tests/shutdown.rs:29,53`

**Interfaces:**
- Consumes: `protocol::app_support_dir()`, `protocol::transport::pipe_name_for_path` (already `pub`, and already compiled on every platform so its rule can be tested where the suite runs).
- Produces:
  - `pub enum BuildProfile { Dev, Release }`
  - `pub const fn BuildProfile::current() -> BuildProfile`
  - `pub const fn BuildProfile::suffix(self) -> &'static str`
  - `pub fn profile_file_name(stem: &str, extension: &str, profile: BuildProfile) -> String`

  Tasks 2, 3, 4 and 6 all call `profile_file_name` with `BuildProfile::current()`.

- [ ] **Step 1: Write the failing tests**

In `crates/protocol/src/lib.rs`, inside the existing `#[cfg(test)] mod tests` (which already has `use super::*;`):

```rust
    /// The release spelling of every per-daemon name is the one an
    /// installed gavin is already using. This design ships no migration:
    /// a changed literal here is a daemon that silently starts a new,
    /// empty registry and an app that cannot authenticate to it.
    #[test]
    fn the_release_names_are_the_ones_already_on_disk() {
        assert_eq!(profile_file_name("daemon", "sock", BuildProfile::Release), "daemon.sock");
        assert_eq!(profile_file_name("daemon", "token", BuildProfile::Release), "daemon.token");
        assert_eq!(profile_file_name("daemon", "log", BuildProfile::Release), "daemon.log");
        assert_eq!(profile_file_name("registry", "sqlite", BuildProfile::Release), "registry.sqlite");
    }

    /// Every per-daemon file splits, and the suffix goes before the
    /// extension -- `daemon-dev.sock`, not `daemon.sock-dev`, so the
    /// pipe tag and anything reading by extension still work.
    #[test]
    fn a_dev_build_names_every_per_daemon_file_apart() {
        for (stem, ext) in
            [("daemon", "sock"), ("daemon", "token"), ("daemon", "log"), ("registry", "sqlite")]
        {
            assert_ne!(
                profile_file_name(stem, ext, BuildProfile::Dev),
                profile_file_name(stem, ext, BuildProfile::Release),
                "{stem}.{ext} did not split"
            );
        }
        assert_eq!(profile_file_name("daemon", "sock", BuildProfile::Dev), "daemon-dev.sock");
        assert_eq!(profile_file_name("registry", "sqlite", BuildProfile::Dev), "registry-dev.sqlite");
    }

    /// The property the whole design rests on: two builds, two
    /// endpoints, so neither app can adopt the other's daemon and
    /// neither Restart can reach it. Asserted against the pipe NAME
    /// because that is the endpoint on the platform this matters on,
    /// and `pipe_name_for_path` is compiled everywhere for exactly this
    /// reason -- the rule has to be provable in the suite that runs on a
    /// mac and on the Windows machine that uses it.
    #[test]
    fn the_two_builds_hash_to_different_pipes() {
        let dir = Path::new("/x/gavin");
        let release = transport::pipe_name_for_path(
            &dir.join(profile_file_name("daemon", "sock", BuildProfile::Release)),
        );
        let dev = transport::pipe_name_for_path(
            &dir.join(profile_file_name("daemon", "sock", BuildProfile::Dev)),
        );
        assert_ne!(release, dev);
        // The tag `pipe_name_for_path` keeps in front of the hash, so
        // the two are told apart in Process Explorer as well as by the
        // kernel.
        assert!(dev.contains("daemon-dev-sock"), "{dev}");
        assert!(!release.contains("daemon-dev-sock"), "{release}");
    }

    /// The shared half of the design, pinned so it cannot be widened by
    /// accident: the state DIRECTORY does not split. Both builds find
    /// one board, one set of rails, one workspace list, because those
    /// are the same files.
    #[test]
    fn the_state_directory_itself_never_splits() {
        let a = resolve_app_support_dir(None, None, os(r"C:\Users\x\AppData\Local"), None, HostOs::Windows).unwrap();
        assert_eq!(a, PathBuf::from(r"C:\Users\x\AppData\Local").join("gavin"));
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p protocol the_release_names_are_the_ones_already_on_disk a_dev_build_names_every_per_daemon_file_apart the_two_builds_hash_to_different_pipes the_state_directory_itself_never_splits`

Expected: FAIL to compile — `cannot find value `BuildProfile` in this scope`, `cannot find function `profile_file_name` in this scope`.

- [ ] **Step 3: Add `BuildProfile` and `profile_file_name`**

In `crates/protocol/src/lib.rs`, immediately after the `impl HostOs` block (which ends around line 2436, just before the `app_support_dir` doc comment):

```rust
/// Which build of gavin a process belongs to.
///
/// A compile-time fact, and deliberately not an environment variable.
/// An override would be inherited by every PTY the daemon opens, so
/// every `gavin-mcp` in those tabs and any app launched from one would
/// land back on the wrong daemon unless the launcher stripped it --
/// the catch
/// `.gavin-root/plans/issue-stable-and-dev-apps-share-one-state-dir.md`
/// raised against that route. Nothing here can be inherited, so nothing
/// has to be stripped.
///
/// It is also self-consistent for free: the dev tree is built debug by
/// `tauri dev`, a release install and the stable worktree's
/// `target/release` are built release, and the app, the daemon and
/// gavin-mcp are each resolved as siblings of one another
/// (`resolve_daemon_binary_path`, `resolve_mcp_binary_path`) -- so a
/// build's three binaries agree on this answer by construction.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BuildProfile {
    Dev,
    Release,
}

impl BuildProfile {
    /// What this build is.
    pub const fn current() -> BuildProfile {
        if cfg!(debug_assertions) {
            BuildProfile::Dev
        } else {
            BuildProfile::Release
        }
    }

    /// What a per-daemon file name carries. EMPTY for `Release`, and
    /// that is load-bearing: it is what keeps an installed gavin's
    /// paths byte-identical to the ones it has been using, so this
    /// change needs no migration and the installed app does not notice
    /// it landed.
    pub const fn suffix(self) -> &'static str {
        match self {
            BuildProfile::Dev => "-dev",
            BuildProfile::Release => "",
        }
    }
}

/// The name of a file that belongs to ONE RUNNING DAEMON.
///
/// The state DIRECTORY is shared and stays shared -- one board, one set
/// of rails, one workspace list, one `config.json`, because those are
/// the work and both builds have to find all of it. What cannot be
/// shared is anything naming a live daemon: the endpoint, the token
/// that authenticates to it, its log, and the registry of the PTYs it
/// owns. See
/// `docs/superpowers/specs/2026-09-11-per-build-daemon-isolation-design.md`.
///
/// The suffix goes before the extension so the last path segment still
/// ends in `.sock` / `.sqlite`, which is what `pipe_name_for_path`
/// turns into a readable tag and what anyone reading the directory
/// expects.
pub fn profile_file_name(stem: &str, extension: &str, profile: BuildProfile) -> String {
    format!("{stem}{}.{extension}", profile.suffix())
}
```

- [ ] **Step 4: Route `socket_path` and `daemon_token_path` through it**

`crates/protocol/src/lib.rs`, replace the body of `socket_path` (line 2598-2599):

```rust
pub fn socket_path() -> anyhow::Result<PathBuf> {
    let path = app_support_dir()?
        .join(profile_file_name("daemon", "sock", BuildProfile::current()));
```

Leave the rest of that function — the comment about the name outliving the mechanism, the `#[cfg(unix)] check_sun_path(&path)?;`, the `Ok(path)` — exactly as it is.

`crates/protocol/src/lib.rs`, replace `daemon_token_path` (line 1243-1245):

```rust
pub fn daemon_token_path() -> anyhow::Result<PathBuf> {
    Ok(app_support_dir()?
        .join(profile_file_name("daemon", "token", BuildProfile::current())))
}
```

Leave `require_local_token_path` alone: it is a user-facing toggle both daemons should honour, so it stays shared.

- [ ] **Step 5: Run the protocol tests to verify they pass**

Run: `cargo test -p protocol`

Expected: the four new tests PASS. Three pre-existing failures in this crate are the baseline — compare the failure set, do not treat them as caused by this change.

- [ ] **Step 6: Fix the two places that hardcode `daemon.sock`**

`crates/daemon/src/main.rs:74` — the assertion must ask the same function the daemon asks, or it pins the release name into a debug test run:

```rust
        assert_eq!(
            protocol::socket_path().unwrap().file_name().unwrap(),
            protocol::profile_file_name("daemon", "sock", protocol::BuildProfile::current()).as_str()
        );
```

`crates/daemon/tests/shutdown.rs:53` — this test spawns the real `gavin-daemon` binary and then connects to the endpoint it computes here. Both are built with the same profile under `cargo test`, so they agree — but only if this derives the name instead of spelling it:

```rust
    .join(protocol::profile_file_name("daemon", "sock", protocol::BuildProfile::current()));
```

`crates/daemon/tests/shutdown.rs:29` — the comment does arithmetic against `sun_path`'s ~103-byte budget. A dev build spends four more bytes, so the worked example must say so:

```rust
    // "/Library/Application Support/gavin/daemon.sock" (46 chars, and 50
    // for a debug build's daemon-dev.sock), that
```

- [ ] **Step 7: Run the daemon tests to verify the tree is green**

Run: `cargo test -p gavin-daemon --test shutdown` and `cargo test -p gavin-daemon --bin gavin-daemon paths_are_scoped_under_app_support`

Expected: PASS. If `shutdown` fails to connect, the daemon binary and the test binary disagree on profile — check both were built by the same `cargo test` invocation.

- [ ] **Step 8: Verify and report**

Run: `cargo test -p protocol -p gavin-daemon`

Report the failure set against the baseline. Files for a later commit, when the human asks:

```
git add crates/protocol/src/lib.rs crates/daemon/src/main.rs crates/daemon/tests/shutdown.rs
```

---

### Task 2: Split the session registry

`registry.sqlite` becomes per-build. This is the one store that MUST split, and not for tidiness — see the reasoning in the doc comment below, which the code should carry.

**Files:**
- Modify: `crates/daemon/src/main.rs:20-22` (`db_path`), and its test at line 67-76

**Interfaces:**
- Consumes: `protocol::profile_file_name`, `protocol::BuildProfile::current` (Task 1).
- Produces: nothing other tasks depend on.

- [ ] **Step 1: Write the failing test**

In `crates/daemon/src/main.rs`, replace the body of `paths_are_scoped_under_app_support` with:

```rust
    #[test]
    fn paths_are_scoped_under_app_support() {
        let dir = protocol::app_support_dir().unwrap();
        assert!(protocol::socket_path().unwrap().starts_with(&dir));
        assert!(db_path().unwrap().starts_with(&dir));
        assert!(kanban_db_path().unwrap().starts_with(&dir));
        assert_eq!(
            protocol::socket_path().unwrap().file_name().unwrap(),
            protocol::profile_file_name("daemon", "sock", protocol::BuildProfile::current()).as_str()
        );
        assert_eq!(
            db_path().unwrap().file_name().unwrap(),
            protocol::profile_file_name("registry", "sqlite", protocol::BuildProfile::current()).as_str()
        );
        // NOT through profile_file_name, and that is the point: these
        // two hold the work -- board vocabularies, card runs, rails,
        // steps, tools -- and both builds must find all of it. Pinned
        // as literals so widening the split to them is a failing test
        // rather than a quiet loss of everything on the board.
        assert_eq!(kanban_db_path().unwrap().file_name().unwrap(), "kanban.sqlite");
        assert_eq!(orchestration_db_path().unwrap().file_name().unwrap(), "orchestration.sqlite");
    }
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cargo test -p gavin-daemon --bin gavin-daemon paths_are_scoped_under_app_support`

Expected: FAIL — left `"registry.sqlite"`, right `"registry-dev.sqlite"`.

- [ ] **Step 3: Split `db_path`**

`crates/daemon/src/main.rs`, replace lines 20-22:

```rust
/// The registry is the ONE store that splits per build.
///
/// Not tidiness: it is the only one holding PROCESS IDENTITY -- `pid`
/// and `orphan_pid` -- and `SessionManager::recover` runs over every
/// inherited row at every startup, probes the recorded pid with
/// `proc::still_running`, records a live one as an orphan for the app
/// to surface and the human to END, and respawns a bare shell in the
/// row's cwd. Shared, a dev daemon starting while the release daemon
/// holds live PTYs would bump the generation out from under those rows,
/// mark them interrupted, list the other app's running agents as
/// orphans offering to kill them, and open a phantom shell for each.
/// That is the damage "never pkill gavin-daemon" exists to prevent,
/// arriving through a different door.
///
/// Splitting it costs nothing durable. A PTY cannot outlive its daemon,
/// so live sessions were never portable between builds, and this file
/// holds only sessions, their queued input and a generation counter.
fn db_path() -> anyhow::Result<PathBuf> {
    Ok(protocol::app_support_dir()?
        .join(protocol::profile_file_name("registry", "sqlite", protocol::BuildProfile::current())))
}
```

Leave `kanban_db_path` and `orchestration_db_path` exactly as they are.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test -p gavin-daemon --bin gavin-daemon paths_are_scoped_under_app_support`

Expected: PASS.

- [ ] **Step 5: Verify and report**

Run: `cargo test -p gavin-daemon`

Report the failure set against the baseline (~22 in `server::tests` before any change; re-run `gavin::tests` alone if it is in the set, it is flaky under parallelism). Files for a later commit:

```
git add crates/daemon/src/main.rs
```

---

### Task 3: Split the daemon log

**Files:**
- Modify: `app/src-tauri/src/daemon.rs:185-197` (`daemon_log_file`), plus a test in that file's `mod tests`

**Interfaces:**
- Consumes: `protocol::profile_file_name`, `protocol::BuildProfile::current` (Task 1).
- Produces: `fn daemon_log_path(dir: &Path) -> PathBuf` — used by `daemon_log_file` and by the test. Compiled on every platform so the rule is testable where the suite runs; `daemon_log_file` itself stays `#[cfg(windows)]`.

- [ ] **Step 1: Write the failing test**

In `app/src-tauri/src/daemon.rs`, inside the existing `#[cfg(test)] mod tests`:

```rust
    /// Two daemons appending to one file interleave into something
    /// nobody can read, and this log is the record the Windows-port
    /// work has leaned on repeatedly.
    #[test]
    fn the_daemon_log_is_named_per_build() {
        let dir = Path::new("/state");
        assert_eq!(
            daemon_log_path(dir).file_name().unwrap(),
            protocol::profile_file_name("daemon", "log", protocol::BuildProfile::current()).as_str()
        );
        assert!(daemon_log_path(dir).starts_with(dir));
    }
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cargo test -p app the_daemon_log_is_named_per_build`

Expected: FAIL to compile — `cannot find function `daemon_log_path` in this scope`.

- [ ] **Step 3: Extract the path and use it**

`app/src-tauri/src/daemon.rs`, immediately above `daemon_log_file`:

```rust
/// The daemon log file, per build.
///
/// A pure function compiled on every platform, the way
/// `protocol::check_sun_path` and `transport::pipe_name_for_path`
/// already are: the caller below is Windows-only, and a rule that can
/// only be checked on one platform is a rule nobody checks.
#[cfg_attr(not(windows), allow(dead_code))]
fn daemon_log_path(dir: &Path) -> PathBuf {
    dir.join(protocol::profile_file_name("daemon", "log", protocol::BuildProfile::current()))
}
```

Then replace the body of `daemon_log_file`:

```rust
#[cfg(windows)]
fn daemon_log_file() -> Option<std::fs::File> {
    let dir = protocol::app_support_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    std::fs::OpenOptions::new().create(true).append(true).open(daemon_log_path(&dir)).ok()
}
```

Leave the existing doc comment on `daemon_log_file` (the one explaining append-never-truncate) in place. No new imports are needed: line 4 of this file is already `use std::path::{Path, PathBuf};`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test -p app the_daemon_log_is_named_per_build`

Expected: PASS.

- [ ] **Step 5: Verify and report**

Run: `cargo test -p app`

**Before running this:** `cargo test -p app` exercises `stop_running_daemon`, which now addresses the *dev* endpoint from a debug test binary. It kills only the pid owning the endpoint it connected to, so a release daemon is out of reach — but a running dev daemon is not. Do not run it while a dev daemon holds sessions you want.

Report the failure set against the baseline (~8-9 red before any change). Files for a later commit:

```
git add app/src-tauri/src/daemon.rs
```

---

### Task 4: Tell every PTY which daemon opened it

The workspace's MCP config names a single `gavin-mcp` binary (`resolve_mcp_binary_path` resolves it beside the running app and writes the absolute path), so whichever app last ran Integrate decides which build's `gavin-mcp` *both* builds' tabs launch. Today that is invisible because every `gavin-mcp` resolves the same endpoint. After Task 1 it bites.

**Files:**
- Modify: `crates/daemon/src/pty.rs:99-102` (beside the existing `GAVIN_SESSION_ID` / `GAVIN_SESSION_TOKEN` block), the scrub comment at lines 161-170, and `mod tests`

**Interfaces:**
- Consumes: `protocol::socket_path()` (Task 1 gives it the per-build name).
- Produces: the environment variable `GAVIN_SESSION_SOCKET`, whose value is this daemon's socket path in the OS's own spelling. Task 5 reads it. No signature change to `PtySession::spawn` — the two production call sites in `server.rs` (lines 1595 and 2711) are untouched.

- [ ] **Step 1: Write the failing test**

In `crates/daemon/src/pty.rs`, in `mod tests`, immediately after `spawn_exports_the_session_id_into_the_pty`:

```rust
    /// Which daemon opened this tab, so gavin-mcp reaches the one that
    /// owns it rather than the one its own build would resolve. The
    /// workspace's MCP config names ONE gavin-mcp binary, so a debug one
    /// can land in a release tab and a release one in a debug tab.
    ///
    /// It must also SURVIVE both scrub loops below. Under the rule
    /// `issue-launcher-env-leaks-into-sessions.md` drew -- a variable
    /// goes only if it names the LAUNCHER's session rather than this one
    /// -- this names the daemon serving this very PTY, so it stays, like
    /// GAVIN_SESSION_ID and GAVIN_SESSION_TOKEN beside it.
    ///
    /// Asserted on the file name rather than the whole path: the value
    /// crosses into sh, which on Windows is MSYS and may respell a
    /// `C:\...` path, and what this test is about is that the variable
    /// arrives and is this build's endpoint.
    #[test]
    fn spawn_exports_this_daemons_endpoint_into_the_pty() {
        let _guard = lock_env();
        let name = protocol::profile_file_name(
            "daemon",
            "sock",
            protocol::BuildProfile::current(),
        );
        let mut session = PtySession::spawn("/tmp", Some("/bin/sh"), "sid-44", None).unwrap();
        let mut reader = session.reader().unwrap();
        session
            .write_input(b"printf 'SOCK%s=[%s]\\n' MARK \"$GAVIN_SESSION_SOCKET\"\n")
            .unwrap();

        let output = read_until_contains(&mut *reader, "SOCKMARK=[", Duration::from_secs(3));
        session.kill().unwrap();
        assert!(output.contains(&format!("{name}]")), "got: {output}");
    }
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cargo test -p gavin-daemon --bin gavin-daemon spawn_exports_this_daemons_endpoint_into_the_pty`

Expected: FAIL — the marker prints `SOCKMARK=[]`, so the assertion reports `got: ... SOCKMARK=[]`.

- [ ] **Step 3: Inject it**

`crates/daemon/src/pty.rs`, directly after the `session_token` block at lines 100-102 and before `cmd.env("TERM_PROGRAM", "ghostty");`:

```rust
        // Which daemon opened this tab. `resolve_mcp_binary_path` puts
        // the gavin-mcp that sits beside the running APP into the
        // workspace's MCP config -- one entry, one binary, whichever app
        // integrated last -- so the gavin-mcp an agent launches in here
        // is not reliably this build's. Left to resolve its own
        // `socket_path()` it would ask a daemon that is not the one
        // hosting this session, or none at all.
        //
        // Skipped rather than fatal when the path cannot be resolved (a
        // missing HOME): gavin-mcp falls back to its own default, which
        // is exactly as good as what it had before, and refusing to open
        // a terminal over it would be much worse.
        if let Ok(socket) = protocol::socket_path() {
            cmd.env("GAVIN_SESSION_SOCKET", socket.as_os_str());
        }
```

- [ ] **Step 4: Name it in the scrub comment**

`crates/daemon/src/pty.rs`, in the comment above the identity scrub loop, replace the sentence beginning "Deliberately still passed in above:" (around line 168-170) with:

```rust
        // none of those are this bug. Deliberately still passed in above:
        // GAVIN_SESSION_ID, GAVIN_SESSION_TOKEN and GAVIN_SESSION_SOCKET,
        // which name THIS session and the daemon serving it, and are the
        // entire point of setting them.
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cargo test -p gavin-daemon --bin gavin-daemon spawn_exports_this_daemons_endpoint_into_the_pty`

Expected: PASS.

- [ ] **Step 6: Prove the test is worth having**

Comment out the `cmd.env("GAVIN_SESSION_SOCKET", ...)` line from Step 3, re-run the test, and confirm it FAILS. Then restore the line and confirm it passes again. (`issue-launcher-env-leaks-into-sessions.md` records that every environment test there was checked this way rather than assumed meaningful; the `IDMARK` tests in this same file are the model.)

- [ ] **Step 7: Verify and report**

Run: `cargo test -p gavin-daemon --bin gavin-daemon pty::`

Expected: the whole `pty` module green. Files for a later commit:

```
git add crates/daemon/src/pty.rs
```

---

### Task 5: `gavin-mcp` prefers the endpoint it was handed

**Files:**
- Modify: `crates/gavin-mcp/src/main.rs:51-57` (`SocketTransport::new`), plus tests in that file's `mod tests` at line 1121. `PathBuf` is already imported there (line 5).

**Interfaces:**
- Consumes: `GAVIN_SESSION_SOCKET` (Task 4).
- Produces: `fn resolve_socket_path(injected: Option<std::ffi::OsString>) -> Option<PathBuf>` — the decision, with the environment passed in.

- [ ] **Step 1: Write the failing tests**

In `crates/gavin-mcp/src/main.rs`, in the existing test module:

```rust
    /// The daemon that opened this tab wins over the one this build
    /// would resolve for itself. The workspace's MCP config names one
    /// gavin-mcp binary for both builds, so "my own default" is a guess
    /// and the injected value is a fact.
    #[test]
    fn an_injected_endpoint_is_preferred_over_this_builds_default() {
        assert_eq!(
            resolve_socket_path(Some(std::ffi::OsString::from("/tmp/x/daemon.sock"))),
            Some(PathBuf::from("/tmp/x/daemon.sock"))
        );
    }

    /// An agent run outside a gavin tab -- a plain shell, CI, every
    /// existing test -- has no injection and must keep working exactly
    /// as before. Empty counts as absent, the way every other optional
    /// variable in this codebase is read.
    #[test]
    fn no_injection_falls_back_to_this_builds_own_endpoint() {
        assert_eq!(resolve_socket_path(None), None);
        assert_eq!(resolve_socket_path(Some(std::ffi::OsString::new())), None);
    }
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cargo test -p gavin-mcp resolve_socket_path`

Expected: FAIL to compile — `cannot find function `resolve_socket_path` in this scope`.

- [ ] **Step 3: Implement it**

`crates/gavin-mcp/src/main.rs`, immediately above `impl SocketTransport`:

```rust
/// The endpoint the daemon that opened this tab told us to use.
///
/// The environment passed in rather than read here, the same shape
/// `protocol::resolve_app_support_dir` uses and for the same reason:
/// the suite runs multi-threaded and mutating the process environment
/// under that is how a green suite starts failing on someone else's
/// machine.
///
/// `None` means "nobody told us", which is an agent running outside a
/// gavin tab -- and the answer then is this build's own `socket_path()`,
/// exactly what it was before. Empty counts as absent.
fn resolve_socket_path(injected: Option<std::ffi::OsString>) -> Option<PathBuf> {
    injected.filter(|v| !v.is_empty()).map(PathBuf::from)
}
```

Then replace `SocketTransport::new`:

```rust
    fn new() -> Self {
        // GAVIN_SESSION_SOCKET is set by `PtySession::spawn` and names
        // the daemon hosting THIS tab. It is preferred over
        // `protocol::socket_path()` because the workspace's MCP config
        // names a single gavin-mcp binary for both builds, so this
        // process cannot assume its own build's endpoint is the right
        // one. It is read ONLY here -- never by
        // `protocol::resolve_app_support_dir` -- so an app launched from
        // a tab still picks its own state by its own profile.
        let socket_path = match resolve_socket_path(std::env::var_os("GAVIN_SESSION_SOCKET")) {
            Some(injected) => Ok(injected),
            None => protocol::socket_path().map_err(|e| e.to_string()),
        };
        Self { socket_path, conn: None }
    }
```

Leave `SocketTransport::at` alone — it is the seam the existing tests use.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p gavin-mcp resolve_socket_path`

Expected: both PASS.

- [ ] **Step 5: Verify and report**

Run: `cargo test -p gavin-mcp`

Files for a later commit:

```
git add crates/gavin-mcp/src/main.rs
```

---

### Task 6: The launcher scripts and CLAUDE.md

`scripts/start-dev-win.ps1` probes `\\.\pipe\` for `*gavin-daemon-sock*` to decide whether to pre-start a daemon. After Task 1 the dev daemon's pipe is `gavin-daemon-dev-sock-<hash>`, which that pattern does **not** match — while the release daemon's pipe **does**. Left alone, the dev launcher would see the stable daemon, say "a daemon is already listening — leaving it alone", and start the dev app with no dev daemon at all.

**Files:**
- Modify: `scripts/start-dev-win.ps1:140,147`
- Modify: `scripts/start-stable-win.ps1:104-125,139` and the `.SYNOPSIS` text at line 21
- Modify: `CLAUDE.md` (the "**The daemon is shared and long-lived.**" paragraph)

**Interfaces:**
- Consumes: the pipe-name tags established in Task 1 — `gavin-daemon-sock` for release, `gavin-daemon-dev-sock` for debug.
- Produces: nothing other tasks depend on. This task is last because it documents what Tasks 1-5 made true.

- [ ] **Step 1: Static pre-flight — confirm the strings this task relies on**

Rendered behaviour is the one thing the suites cannot cover, so check the exact literals against the committed source before editing (`CLAUDE.md`: "a useful agent contribution is a static pre-flight — grep the exact strings a change relies on against the committed source"):

```bash
grep -n "gavin-daemon-sock" scripts/start-dev-win.ps1
grep -n "daemon.log" scripts/start-dev-win.ps1 scripts/start-stable-win.ps1
grep -n "Get-Process -Name gavin-daemon" scripts/start-stable-win.ps1
```

Expected: one hit each at `start-dev-win.ps1:140`, `start-dev-win.ps1:147` + `start-stable-win.ps1:21,71,139`, and `start-stable-win.ps1:109`.

- [ ] **Step 2: Point the dev launcher at the dev endpoint**

`scripts/start-dev-win.ps1`, replace line 140:

```powershell
# The DEV pipe specifically. A debug build binds daemon-dev.sock, which
# `pipe_name_for_path` tags `gavin-daemon-dev-sock`; a release install binds
# daemon.sock and is tagged `gavin-daemon-sock`. Matching the release tag here
# would see the stable daemon, decide one is already listening, and start the
# dev app with no dev daemon at all -- and the release tag is a PREFIX of the
# dev one, so the pattern has to be the specific one.
$listening = @([System.IO.Directory]::GetFiles('\\.\pipe\') | Where-Object { $_ -like '*gavin-daemon-dev-sock*' })
```

And line 147:

```powershell
    $log = Join-Path $state 'daemon-dev.log'
```

- [ ] **Step 3: Update the stable launcher**

`scripts/start-stable-win.ps1`, replace the "who is listening already" block (lines 106-125) with:

```powershell
# The app adopts whatever daemon is listening on ITS endpoint, and after
# per-build isolation that can only ever be a release daemon: a debug build
# binds daemon-dev.sock and is tagged `gavin-daemon-dev-sock`, a different
# pipe this app never looks at. A dev daemon is therefore no longer a hazard
# here -- it cannot be adopted, and Restart in either app kills only the pid
# owning the endpoint it connected to.
$stable = @([System.IO.Directory]::GetFiles('\\.\pipe\') | Where-Object { $_ -like '*gavin-daemon-sock*' -and $_ -notlike '*gavin-daemon-dev-sock*' })
if ($stable.Count -eq 0) {
    Say 'no release daemon is listening; the app will spawn its own from beside itself'
}
else {
    Say 'a release daemon is already listening; the app will adopt it'
}
$dev = @([System.IO.Directory]::GetFiles('\\.\pipe\') | Where-Object { $_ -like '*gavin-daemon-dev-sock*' })
if ($dev.Count -gt 0) {
    Say 'a dev daemon is listening too, on its own pipe. It will not be adopted and this app cannot stop it.'
}
```

And line 139:

```powershell
Say "daemon log: $(Join-Path $env:LOCALAPPDATA 'gavin\daemon.log')"
```

leave as-is — the release log keeps its name. Update the `.SYNOPSIS` sentence at line 21 to say so explicitly:

```
    breakaway -- appending to %LOCALAPPDATA%\gavin\daemon.log (a debug build
    writes daemon-dev.log beside it, and binds its own pipe). Starting it
```

- [ ] **Step 4: Amend CLAUDE.md**

Replace the **The daemon is shared and long-lived.** paragraph's body with one that says what is now true. Keep the heading and the "never `pkill gavin-daemon`" rule — it is still right, because a name still reaches every daemon on the machine:

```markdown
**The daemon is shared and long-lived.** Never `pkill gavin-daemon`: a name
reaches every daemon on the machine, and a release install and the dev tree
now run one each. They no longer collide — a debug build binds
`daemon-dev.sock` (pipe tag `gavin-daemon-dev-sock`), keeps its own
`daemon-dev.token`, `daemon-dev.log` and `registry-dev.sqlite`, and a release
build keeps the unsuffixed names. Restart daemon in either app kills only the
pid owning the endpoint it connected to. What they still SHARE, deliberately,
is the work: one `kanban.sqlite`, one `orchestration.sqlite`, one
`config.json`, so the board, the rails, the workspace list and the settings
are the same in both. A protocol bump only takes effect after a rebuild and
restart, which is the human's call. To verify daemon or MCP behaviour
meanwhile, run an isolated daemon under a temp `$HOME` — it gets its own
socket and databases.
```

- [ ] **Step 5: Verify the scripts still parse**

Run: `powershell -NoProfile -Command "$null = [System.Management.Automation.Language.Parser]::ParseFile('scripts/start-dev-win.ps1', [ref]$null, [ref]$null); $null = [System.Management.Automation.Language.Parser]::ParseFile('scripts/start-stable-win.ps1', [ref]$null, [ref]$null); 'parsed'"`

Expected: `parsed`. Then `powershell -NoProfile -File scripts/start-stable-win.ps1 -DryRun` — it does every check without starting anything.

- [ ] **Step 6: Full verification and report**

Run, in order:

```
cargo test --workspace
cd app && npm test && npm run check && npm run build
```

Report each failure set against the baseline. Do not claim a green suite — none of them is green today. The daemon's `gavin::tests` are flaky under full-suite parallelism; re-run that module alone before calling anything there a regression.

Files for a later commit:

```
git add scripts/start-dev-win.ps1 scripts/start-stable-win.ps1 CLAUDE.md
```

Then check `git status` for the full set across all six tasks, and verify each `git add` actually landed — other sessions run git concurrently in this checkout and `index.lock` races are routine.

---

## What is NOT in this plan, by design

- **No migration.** `Release` names are unchanged, which the Task 1 test asserts directly.
- **No seeding or syncing of state between builds.** Nothing is duplicated, so there is nothing to keep in step.
- **No change to `resolve_app_support_dir`, to `app_config_dir()`, or to `kanban_db_path` / `orchestration_db_path`.** The Task 1 and Task 2 tests pin all three decisions.
- **Config drift is not fixed.** One `config.json` is what "settings sync both ways" means; a dev build that widens it writes a shape the release build reads and rewrites, dropping keys it does not know. Recorded in the spec under "What this does not fix".
- **The owner's in-app confirmation is not an agent step.** Confirming the visible surface is the owner's, in the running app: quit the release app, run `scripts/start-dev-win.ps1`, and check `Get-Process gavin-daemon` shows two processes on two pipes with the release one's sessions intact.
