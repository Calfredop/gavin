---
order: 15360
title: [fix] on Windows the release app opens a console window for every command it runs
labels: windows
status: Done
priority: urgent
complexity: moderate
---
Seen on the first packaged launch, 2026-09-10
([chore-stable-release-install-on-windows.md](./chore-stable-release-install-on-windows.md)):
every action in the release Gavin flashes one or more terminal windows, and
the UI is sluggish enough to be unusable. `tauri dev` never showed it, which
is why nothing caught it until a release build was actually run.

## Why

A console program started by a parent that has no console gets a NEW
console, and a new console is a window. Two parents in the packaged app have
none:

- `Gavin.exe` itself. `main.rs` sets `windows_subsystem = "windows"` for
  release builds, so there is no console to inherit. Debug builds keep one,
  which is why the dev app was clean.
- `gavin-daemon.exe`. `spawn_detached` (`app/src-tauri/src/daemon.rs`)
  starts it with `DETACHED_PROCESS`, chosen so the daemon would not die with
  the dev terminal's console. That flag means "no console at all", so every
  child the daemon starts allocates one. Under `start-dev-win.ps1` the daemon
  gets a hidden console from `-WindowStyle Hidden` instead, which its
  children inherit silently -- the same bug, masked by the launcher.

Apart from that one daemon spawn, no `Command::new` in the app or the daemon
sets `CREATE_NO_WINDOW`. The spawns that fire during ordinary use:

- daemon, `git`: `run_git_status`, `head_sha`, `dirty_paths`,
  `resolve_repo_root` (`git_status.rs`) on git-tab and card actions and on
  cwd changes; `git --exec-path` in `shell.rs`, once per daemon (`OnceLock`).
- app: `gh` in `pull_request.rs` (the PR sweep, every 15 s while a PR is
  watched), `claude` in `agent_usage.rs` and `agent_models.rs`, the agent
  command in `superpowers.rs`, `curl` in `agent_usage.rs`, the watchman
  binary in `memory.rs`, `taskkill` in `daemon.rs`.

Reproduced in isolation with a P/Invoke `CreateProcessW` script (scratch,
not committed): a console-less parent running `git --version` twice and
`ping` put a visible console window on screen, hosted by `conhost` plus
Windows Terminal's `OpenConsole`; the same parent started with
`CREATE_NO_WINDOW` (0x0800_0000) put up no window at all -- it owns one
hidden console and every child inherits it. Windows Terminal 1.24 is
installed here, so each flash is a terminal host starting, which is where
the sluggishness comes from: the `git` call is not slow, the window that
hosts it is.

## Fix, in two halves, both needed

- [x] **Daemon spawn:** `CREATE_NO_WINDOW` in place of `DETACHED_PROCESS` in
      `spawn_detached`. The daemon still shows no console, keeps its own
      process group, still attempts the job breakaway, and still logs to
      `daemon.log` through the explicit stdio handles -- but it now OWNS a
      hidden console that every child inherits, so every daemon-side spawn
      is fixed at once, including ones added later. Update
      `the_first_spawn_attempt_breaks_out_of_the_job_and_the_retry_does_not`,
      which asserts `DETACHED_PROCESS` today, to assert `CREATE_NO_WINDOW`
      and the ABSENCE of `DETACHED_PROCESS` (the two are not meant to be
      combined), and reword the "DETACHED_PROCESS costs it a console" comment
      that explains the log.
- [x] **App spawns:** one constructor in `program.rs`, `command(bin) ->
      Command`, that applies `CREATE_NO_WINDOW` under `cfg(windows)` and is
      the only way the app builds a `Command`: `agent_models.rs:225`,
      `agent_usage.rs:217` and `:380`, `pull_request.rs:195`,
      `superpowers.rs:247`, `memory.rs:357`, and the `taskkill` in
      `daemon.rs`. (`security` in `agent_usage.rs` is macOS-only;
      `/usr/bin/pgrep` in `memory.rs` is unix-only.) A flag-contract test
      beside the existing one. The GUI process has no console to hand down,
      so this half cannot be replaced by the first.
- [ ] Defense in depth, optional: the same flag on the daemon's own
      `Command::new` sites (`git_status.rs`, `shell.rs`) for a daemon started
      some other way, e.g. by hand from a terminal that later closes.
- [x] Verify in the packaged app: rebuilt the stable worktree (16:00),
      launched it under the same process-creation trace that found the
      bug. Five `git` spawns from `Gavin.exe` at launch, zero
      `OpenConsole -Embedding` (before: one per call), and a 20 s sample of
      visible console windows while the periodic git polls ran stayed at
      its baseline. The `conhost` still created per call is the windowless
      console `CREATE_NO_WINDOW` gives the child. The human's own click
      through the git tab, a card run and a PR sweep is still worth doing.

Out of scope: the `windows_subsystem` attribute is right and stays; PTY
sessions go through ConPTY and never open a window; the dev launcher's
hidden-console daemon keeps working as it does.

## Done 2026-09-10

Tests first, both red for the missing symbols, then green in the stable
worktree (`cargo test -p app --release`: 438 pass, the 8 failures are the
pre-existing path-shape ones recorded on the windows-port card):

- `daemon.rs`: `the_daemon_owns_a_hidden_console_rather_than_none` pins
  `CREATE_NO_WINDOW` present and `DETACHED_PROCESS` absent on both flag
  words; the old contract test keeps the breakaway and process-group
  assertions. `DETACHED_FLAGS` is now `CREATE_NO_WINDOW |
  CREATE_NEW_PROCESS_GROUP`; the `taskkill` fallback goes through the
  helper.
- `program.rs`: `CREATE_NO_WINDOW` and `command()`, and
  `a_command_child_does_not_share_this_console`, which proves it on a
  real child through `GetConsoleProcessList` -- a plain child is listed
  on the test runner's console (the positive control), a `command` child
  is not. A runner with no console says so and skips rather than passing
  for nothing.
- Routed: `agent_models.rs`, `agent_usage.rs` (three sites),
  `pull_request.rs`, `superpowers.rs`, `memory.rs` (two sites). Their
  `use std::process::Command` imports are gone.

The fix lives in the shared tree, uncommitted like the rest of the
Windows work, and was copied into the stable worktree for the rebuild.

## Second pass, same day: the git tab

The rebuilt app still flashed at launch. A process-creation trace
(WMI `__InstanceCreationEvent`, parent named) showed who: `Gavin.exe`
itself running `git --no-optional-locks rev-parse …`, `status
--porcelain=v2`, `for-each-ref`, `remote -v`, `stash list`, `worktree
list`, `config --get …` -- the git tab's runner in `src/git/run.rs`,
three `Command::new("git")` sites in a SUBDIRECTORY that the first
pass's flat listing of `src/*.rs` never showed. Each call got a
`conhost` plus an `OpenConsole -Embedding` (Windows Terminal's host),
one every ~270 ms, which is both the flashing and the sluggishness.

- Routed those three, plus the unix `pkill` and the two test helpers in
  `daemon.rs`, through `program::command`.
- Added `every_spawn_in_this_crate_goes_through_command` in
  `program.rs`: it walks `src/` recursively and fails on any
  `Command::new(` outside `program.rs` and the daemon spawn itself. Red
  listed exactly the six sites above; green after routing. A new spawn
  site added without the helper fails the suite instead of shipping.
