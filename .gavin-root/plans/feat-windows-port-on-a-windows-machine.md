---
model: opus[1m]
order: 1024
title: [feat] windows port — the half that needs a Windows machine
labels: windows
status: In Progress
---
Everything in [feat-windows-port.md](./feat-windows-port.md) that could be done
from a mac is done: four commits on `feat/multi-os-support`
(`376cc75..a538312`), the whole macOS suite green, and `cargo check -p protocol
-p gavin-daemon -p gavin-mcp --tests --target x86_64-pc-windows-msvc` passing.
That last one is the honest limit of what was proved. **Nothing below has ever
been executed on Windows** — the port compiles, and compiling is not running.

Read that card's three decision sections first (**Shell**, **Corrections to the
assumptions**, **Window chrome**). They record why each route was chosen and
what was rejected, so none of it needs re-deriving here.

## The pass's headline, 2026-09-11

Two things were found by running this, and one of them is worse than
anything the card anticipated.

1. **The shell decision holds** (§2). ConPTY gives `sh.exe` a tty, a
   full-screen agent TUI draws in a session, the epilogue re-raises its
   code, OSC 7 survives. No re-plan. It cost one fix: a `sh -c` on
   Windows had no `bash`, `ls`, `sed` or `grep`, because a default Git
   for Windows install puts only `<git>\cmd` on PATH and `sh -c` reads no
   profile — so **every `script`-kind tool died before its body ran**.
   Fixed here in `shell::path_with_posix_tools`.

2. **On Windows a session that exits by itself is never reported as
   exited** —
   [fix-windows-sessions-never-report-exit.md](./fix-windows-sessions-never-report-exit.md).
   A ConPTY reader gets no EOF when its child exits, and the daemon's
   pump breaks on `Ok(0)` and nothing else. So a tool's exit code never
   becomes its verdict, **a rail step never completes**, finished runs
   never leave the task manager, and a pump thread plus a screen model
   leak per session. `kill_session` closes the pty and so still works,
   which is why only self-ending sessions are lost and why the
   interactive paths a human tries all look fine.
   Not fixed here: the fix is a change to how every session ends, on
   every platform, and that is a decision rather than a patch.

**Assumption** (overrule in one word): Windows 11 x64, or a Windows 10 new
enough to have WebView2 and ConPTY, with Git for Windows, the MSVC build tools,
Node 22, and the agent CLIs installed the way a user would install them
(`npm i -g`).

## 1. It builds, and it packages

- [ ] `cargo test --workspace -- --skip gavin::` and `cargo test -p gavin-daemon
      gavin:: -- --test-threads=1`. Expect intermittent red from
      [fix-daemon-server-test-flakiness.md](./fix-daemon-server-test-flakiness.md),
      which predates this work; a DIFFERENT test each run is that, the SAME one
      twice is ours.
      **Run 2026-09-11. `protocol` and `app` are at their recorded
      baselines and carry no regression from this card. The daemon crate
      cannot be run to completion on Windows at all** — see below, and
      [fix-daemon-suite-deadlocks-on-windows.md](./fix-daemon-suite-deadlocks-on-windows.md).
      - `cargo test -p protocol` — 105 pass, **3 fail**, the three
        `XDG_DATA_HOME`/`HOME` tests. The documented baseline exactly.
      - `cargo test -p app` — 444 pass, **9 fail**. The documented
        baseline exactly, and now diagnosed rather than described: they
        are seven unrelated causes, not "all path-shape", on
        [fix-app-crate-windows-path-shape-failures.md](./fix-app-crate-windows-path-shape-failures.md).
        The note below is wrong about two of them — the `agent_setup`
        pair is CRLF in `include_str!`'d markdown, not a path separator.
      - `cargo test -p gavin-mcp` — 45 pass, **1 fail**
        (`create_plan_resolves_relative_context_and_maps_arguments`, a
        path-separator assumption). The documented baseline exactly.
      - `cargo test -p gavin-daemon` — **does not finish.** It reaches 22
        failures, all in `server::tests`, and then stops: zero CPU, 200+
        threads, dozens of orphaned `sh.exe`/`conhost` PTY children still
        alive. Observed three times, including with
        `--skip gavin:: --skip git_status --skip repo`, so the slow
        fs-watcher and git-status tests are not the explanation, and
        including at `--test-threads=4`, which rules out the memory
        pressure that kills full-suite runs on this machine. The last
        test still running at four threads names the cause:
        `attach_never_sends_a_baseline_status_changed_for_an_exited_session`
        — a test that waits on a session exit, on a platform where an
        exit is never reported. That is finding 2 above.
      **Not a regression from this card, and proved rather than assumed.**
      A `gavin_daemon` test binary built 2026-09-10 — carrying none of
      these changes — was run from another checkout with the identical
      filter and stalled the same way, at the same point, on the same
      test. Failure sets: **22 and 22, every one in `server::tests`,
      differing by exactly one name** (`kill_session_answers_without_waiting_for_the_process_to_go`
      against `killing_a_session_frees_its_screen`). A different test each
      run is the flakiness this card's note already anticipates — and the
      first of those two is the one `fix-daemon-server-test-flakiness`
      says it "deliberately left alone" as thin enough to be the next
      flake. Every test added by this card passed in both parallel runs.
      First `cargo test -p app --release` on Windows (2026-09-10, stable
      worktree): 438 pass, 8 fail, all path-shape, none flaky --
      `agent_setup` x2 (expected `/`, got `\` in the opencode skill paths),
      `fileviewer::extra_context_roots_…` (a `\\?\` verbatim temp path is
      not matched), `memory::pid_file_sits_under_the_user_state_directory`,
      `session::command_connection_tests::a_command_the_daemon_predates_…`,
      `workspace_delete` x3 (forward-slash vs backslash comparison, and the
      trash count). The same forward-slash normalisation section 3 mentions
      is what most of them want.
- [ ] `cd app && npm ci && npm test && npm run check && npm run build`.
      Run 2026-09-11. `npm ci` ✓. `npm run check` ✓ — **0 errors**, 35 a11y
      and deprecation warnings, none new. `npm run build` ✓ — the static
      adapter wrote `build/` in 1m26s.
      `npm test` is **10 red of 5239**, and they are exactly the ten named
      on [fix-source-grep-tests-on-crlf-checkouts.md](./fix-source-grep-tests-on-crlf-checkouts.md)
      — source-grep tests whose expected strings hardcode `\n` against a
      `core.autocrlf=true` checkout. That card owns the decision
      (`.gitattributes` vs. normalising in the `source()` helpers) and says
      in as many words that this line cannot be ticked before it lands.
      **So this item is blocked on that card, not on anything here.**
- [ ] `npm run tauri dev` launches and reaches its daemon.
- [x] `npm run bundle` produces an **NSIS installer** (`tauri.windows.conf.json`
      narrows `bundle.targets` to that; `app/src-tauri/BUNDLING.md` says why the
      `--config` flag must not be dropped). The staging script is Node now
      precisely so this step does not need `sh.exe` on PATH — confirm it did not.
      Done 2026-09-10 in the stable worktree
      ([chore-stable-release-install-on-windows.md](./chore-stable-release-install-on-windows.md)):
      `Gavin_0.1.0_x64-setup.exe`, staging ran under `cmd /C` with no `sh.exe`
      involved, and the generated `installer.nsi` installs both sidecars with
      the triple stripped. The install-and-check item below is still the
      human's; the installer's per-user default folder is `%LOCALAPPDATA%\Gavin`,
      which is the daemon's state directory under another case.
- [ ] **The spec's open item, now with an extension on it:** install the
      package and check `externalBin` stripped the target triple and left
      `gavin-daemon.exe` and `gavin-mcp.exe` **beside `Gavin.exe`**.
      `resolve_daemon_binary_path` and `resolve_mcp_binary_path` both join
      against `current_exe().parent()` and both now append `EXE_SUFFIX`; if the
      files are not there, the packaging approach needs rethinking, not patching.
      (The Linux card carries the same question — a Linux answer is most of a
      Windows answer.)
      **The packaging approach is sound.** Read out of the generated
      `installer.nsi` (`gavin-stable/target/release/nsis/x64/`), which is
      the installer's own account of what it will do:
      ```
      File /a "/oname=gavin-daemon.exe" "…\binaries\gavin-daemon-x86_64-pc-windows-msvc.exe"
      File /a "/oname=gavin-mcp.exe"    "…\binaries\gavin-mcp-x86_64-pc-windows-msvc.exe"
      ```
      into `$INSTDIR`, beside `Gavin.exe` — the triple is stripped and the
      sibling lookup has something to find. Left unticked because the
      running install is still owed; nothing here is in doubt any more.
      The same reading turned up two defects that ARE structural, now on
      [fix-windows-installer-collides-with-the-daemon.md](./fix-windows-installer-collides-with-the-daemon.md):
      the per-user `$INSTDIR` (`$LOCALAPPDATA\Gavin`) **is** the daemon's
      state directory (`%LOCALAPPDATA%\gavin`, same folder case-insensitively),
      which makes the uninstaller's "Delete app data" checkbox delete a
      directory gavin never wrote to while the real databases sit in
      `$INSTDIR`; and `CheckIfAppIsRunning` only ever checks `Gavin.exe`,
      never `gavin-daemon.exe` — the one process that deliberately outlives
      the app — so an upgrade over a live daemon cannot overwrite it and
      leaves a new app talking to an old daemon binary.
- [ ] Run the INSTALLED app, not a dev build, and confirm it starts its own
      daemon. That is the sibling lookup working end to end.
- [ ] Run the wizard's integration step and confirm the absolute `gavin-mcp`
      path it writes into the agent config resolves.

What broke on the first packaged launch (2026-09-10): the release `Gavin.exe`
is `windows_subsystem = "windows"` and the daemon is spawned with
`DETACHED_PROCESS`, so neither has a console, and every `git`, `gh` and
`claude` either of them runs opens a console window of its own -- a full
Windows Terminal window on this machine. The dev build never shows it because
debug binaries keep a console. Structural, since no `Command::new` in the app
or the daemon sets `CREATE_NO_WINDOW`:
[fix-release-app-console-windows-on-windows.md](./fix-release-app-console-windows-on-windows.md).

## 2. The shell assumption — everything rests on this one

The parent card's Shell decision is the load-bearing guess of the whole port:
emitted command lines keep their POSIX shape and run through Git for Windows'
`sh.exe` under ConPTY. If this section fails, the fallback is emitting
PowerShell, which touches every emission site and every agent launch line —
a re-plan, not a patch. Do this section before anything else.

**The shell decision holds.** Every item below was executed on Windows 11
on 2026-09-11. It cost one structural fix (the PATH finding, below), not a
re-plan. The checks are now tests in `crates/daemon`, not a one-off
session: `shell::tests` and `pty::tests`, 34 green.

- [x] `git --exec-path` answers, and `crates/daemon/src/shell.rs` resolves
      `<git>/usr/bin/sh.exe` from it. A scoop or portable install too, if one is
      to hand.
      `git --exec-path` → `C:/Program Files/Git/mingw64/libexec/git-core`,
      and the walk-up lands on `C:/Program Files/Git/usr/bin/sh.exe`
      (`usr/bin` ahead of `bin`, as designed). Asserted against the real
      machine by `shell::tests::on_windows_the_posix_shell_is_a_git_bash_sh_that_is_really_there`
      rather than a table of invented paths, and `%COMSPEC%` likewise.
      No scoop or portable install on this box — the invented-layout tests
      still cover that shape and nothing here contradicts them.
- [x] **ConPTY gives `sh.exe` a tty.** Run a card and watch a full-screen agent
      TUI draw and accept input. This is the single assumption most likely to
      be wrong, and the reason it is plausible is that Git Bash works in Windows
      Terminal.
      **It does.** `[ -t 0 ]` and `[ -t 1 ]` are both true inside a command
      session (`pty::tests::a_command_session_runs_on_a_tty_at_both_ends`),
      and Claude Code's full-screen TUI draws under it: a probe spawning
      `claude` through `PtySession::spawn` captured the alternate screen,
      24-bit SGR, absolute cursor addressing, bracketed paste, the kitty
      keyboard protocol, OSC 8 hyperlinks and an interactive
      `❯ No, exit / Yes, I trust this folder` prompt sitting waiting for a
      keystroke. Input acceptance is the existing
      `spawns_shell_and_captures_output`, which writes to the PTY and reads
      the result back.
      *Caveat on the test as first written:* `[ -t 1 ]` **inside** `$(…)`
      reports false on every platform, because a command substitution
      replaces stdout with a pipe. A test written that way fails identically
      on a working ConPTY and a broken one; the committed one tests outside
      the substitution.
- [ ] Each profile CLI starts under it: `claude`, `codex`, `gemini`, `cursor`,
      `opencode`. Inside `sh.exe` the extensionless npm shim is the one that
      wins, which is the whole reason this route was chosen over PowerShell.
      **Only `claude` can be answered on this machine, and it answers the
      wrong half of the question.** It starts and draws (above), but it is a
      winget install — a native `claude.exe` — so it says nothing about the
      npm shim. `%APPDATA%\npm` is on PATH and **empty**: none of `codex`,
      `gemini`, `cursor`, `opencode` is installed, so the claim this route
      was chosen for is still unproven. Needs `npm i -g` of the four, which
      is a change to the human's machine and so is the human's call.
- [x] A `script`-kind tool (which wraps its body in `bash -c`) runs, and the
      failure epilogue prints `[gavin] <tool> exited with code N` and **re-raises
      the code** — the step's verdict depends on it.
      Through the real PTY, not just a shell:
      `pty::tests::the_tool_failure_epilogue_prints_and_re_raises_the_code`
      asserts both the printed line and the re-raised code. This is the item
      that turned up the PATH bug — `bash -c` was `command not found`.
- [x] A `[worktree] setup` chain (`&&`-joined) runs in the new worktree.
      `pty::tests::an_and_joined_setup_chain_short_circuits_on_the_first_failure`:
      the chain runs, stops at the first failure, and exits non-zero, so a
      setup whose first step failed cannot report the last step's success.
- [x] OSC 7: a Git Bash prompt configured to emit it reports the cwd, and the
      drive letter arrives as `C:/…` rather than `/C:/…`. If it emits nothing,
      that is fine and expected — idle detection is OSC 133 plus a quiet timer
      and must not regress either way.
      **The sequence survives ConPTY** — a real question, since ConPTY is a
      terminal emulator that re-renders rather than a pipe — and arrives as
      `C:/…` (`pty::tests::an_osc7_cwd_report_survives_the_terminal`).
      Git Bash emits nothing by default: there is no OSC 7 anywhere in
      `<git>/etc/profile.d/git-prompt.sh`, so the expected-and-fine case is
      the normal one. A prompt that does emit must use `pwd -W`, not `$PWD`:
      inside MSYS the shell's own cwd is an MSYS path (`/c/Users/…`, or
      `/tmp`) that no Windows API can open, and only `pwd -W` answers in the
      Windows spelling that `strip_uri_drive_slash` was written for.

### What this section found: an emitted command line had no POSIX tools

`sh -c <line>` is neither a login nor an interactive shell, so it reads no
profile — and a **default Git for Windows install puts only `<git>\cmd` on
the machine PATH**. Measured here: the persisted machine PATH is
`…;C:\Program Files\Git\cmd;…` with no `usr\bin` anywhere. So the shell
every emitted command line runs in had `git` and nothing else:

```
$ sh -c 'printf "bash=[%s] ls=[%s] sed=[%s] git=[%s]\n" ...'   # Start-menu PATH
bash=[] ls=[] sed=[] git=[/cmd/git]
```

`buildToolCommand` emits every `script`-kind tool as `bash -c <body>`, so
each one died with `command not found` **before its body ran** — and the
failure epilogue then reported 127, a verdict about the wrong thing. Any
tool body reaching for `ls`, `sed`, `grep` or `cat` went the same way.

A dev build hides this completely: a daemon started from a terminal
inherits that terminal's PATH, and Git Bash's profile has already fixed it
there. It only appears in the packaged app, which is the one users run.

Fixed in `shell::path_with_posix_tools`, called from `pty::spawn`'s command
branch: the daemon puts `<git>/mingw64/bin`, `<git>/usr/local/bin`,
`<git>/usr/bin` (and `<git>/bin`) on the front of the child's PATH, in
`/etc/profile`'s own order. Prepended rather than appended deliberately —
an emitted POSIX line that reaches `C:\Windows\System32\find.exe` or
`sort.exe` instead of the MSYS ones does something quietly different rather
than failing where it can be seen. `interactive_shell` is untouched: a
`%COMSPEC%` tab is a Windows shell and keeps the PATH Windows gave it.

## 3. The desktop pass

**None of these is ticked, and an agent should not tick them.** Rendered
UI is the one thing the suites cannot cover and confirming it is the
owner's, in the running app (CLAUDE.md). What is below each item is the
static pre-flight for it: the exact code path the item exercises, checked
against the committed source, so that when the human does run it a
failure is a surprise rather than a re-derivation. Two of them turned up
something worth knowing before the app is ever launched.

**The item-2 text below is out of date and the code is better than it
says.** The restart's fallback is no longer `taskkill /F /IM
gavin-daemon.exe` — no `taskkill` shells out anywhere in the app; it
survives only in `daemon.rs`'s comments. `stop_running_daemon` reads the
pid serving THIS endpoint off the connection (`Stream::server_pid`),
sends `Request::Shutdown`, and on failure calls `TerminateProcess` on
that one pid. The comment says why: a name is not an address, and
`taskkill /IM` reached every daemon on the machine — which is how `cargo
test -p app` once killed a human's sessions and how the dev app's Restart
took the stable app's daemon with it. So the second half of that item —
"the fallback by wedging or downgrading a daemon" — is still worth doing,
but it exercises `TerminateProcess` on one pid, and the thing to watch
for is that the OTHER daemon on this machine is untouched.

- [ ] Launch, and spawn a plain shell tab: it should be `%COMSPEC%`, not bash.
      *Pre-flight:* `shell::interactive_shell` reads `%COMSPEC%` and falls
      back to a bare `cmd.exe`; `shell::tests::on_windows_a_plain_tab_gets_a_comspec_that_is_really_there`
      now asserts the resolved value is an existing file, so the fallback
      being reached is a test failure rather than a surprise in a tab. A
      plain tab gets no PATH augmentation — that is deliberate, and §2's
      finding explains why it must not.
- [ ] **Restart the daemon from Settings.** It now asks over the wire
      (`Request::Shutdown`) before falling back to `taskkill /F /IM
      gavin-daemon.exe`. Exercise both — the fallback by wedging or downgrading
      a daemon so the polite route cannot land.
- [ ] Delete a workspace and confirm it is in the **Recycle Bin** and that
      **Restore** puts it back.
      *Pre-flight:* the Linux half of this had an end-to-end test
      (`trash::tests`, gated `target_os = "linux"`) asserting the file
      reaches the desktop Trash WITH the `.trashinfo` that makes "Put
      back" work; Windows had none. Added
      `trash::windows_tests::a_trashed_file_lands_in_the_recycle_bin_with_its_restore_record`,
      the exact counterpart: it trashes a file and finds the
      `$Recycle.Bin\<SID>\$I…` record that holds the original path plus
      the `$R…` data beside it, then removes both so a developer's bin is
      left as it was found. An `$R` with no `$I` is the failure worth
      catching — it looks identical in the shell and cannot be restored.
      What the human still owns: that the WIZARD reaches this, and that
      Restore in the shell puts a whole workspace back.
- [ ] Hover a path in terminal output and open it. This is
      `resolve_path_under_cursor`, and the first place a `\\?\` verbatim path
      would have surfaced before `protocol::canonical_path`.
      *Pre-flight:* `protocol::canonical_path` canonicalises and then
      hands the result to `strip_verbatim_prefix`, which turns
      `\\?\C:\x` into `C:/x` and `\\?\UNC\server\share` into
      `//server/share`, while deliberately leaving `\\?\Volume{…}` alone
      (a volume with no drive letter, where stripping would name
      something else). Both are unit-tested. Worth hovering a path with a
      SPACE in it and one on a UNC share, which is where the two arms
      differ.
- [ ] A workspace at a `C:\` path renders on the board, and its cards open from
      the Plans tab and the file viewer. Card ids are paths, compared and split
      as strings — this is what the forward-slash normalisation is for.
- [ ] A `until` rail step retries and **quotes its check** in the retry prompt.
      The log now lives under the host's own temp directory rather than `/tmp`,
      which on Windows was two different directories: the shell wrote one and
      the app read the other.
      *Pre-flight:* the wiring is whole. `fileviewer::temp_dir` answers
      `protocol::wire_path(std::env::temp_dir())` — forward-slash
      normalised — `layoutState` pushes it into
      `orchestrationLoop::setTempRoot` at bootstrap, and `untilLogPath`
      builds on it, so the `tee 'C:/Users/…/Temp/gavin-until-<id>.log'`
      the shell writes and the path the app reads are one string. The
      `/tmp` default is only what the module holds before the host
      answers. MSYS opens a `C:/…` path natively, so `tee` needs no
      translation.
- [ ] Resize the window from all eight edges and corners
      (`WindowResizeEdges.svelte`), and note whether the OS *also* resizes
      there. The grips are drawn on Windows on the assumption WebView2 swallows
      the frame's hit-testing; if the OS border works after all, the overlay can
      be dropped on this platform.
      *Pre-flight:* the branch is `needsResizeGrips(isMacSync())` — one
      call, evaluated on the first frame from plugin-os's synchronous
      platform read, so the grips are up before any await. `decorations:
      false` and `shadow: true` are both present and adjacent in
      tauri.conf.json, which is the pair that leaves an undecorated
      Windows 11 window its 1px border and rounded corners. The question
      this item exists to answer — whether the OS border responds too —
      cannot be read off the source at all; it needs the window.
- [ ] Drag the window by the corner strip and by the empty run of a tab row;
      double-click the title bar to maximize.
- [ ] The non-mac `WindowControls` — minimize / maximize / close, with the
      corner still top-LEFT (a decision, recorded on the parent card).

## 4. Two accounts, one machine

- [x] A second Windows account gets its **own** daemon: the pipe name is hashed
      from `%LOCALAPPDATA%`, which differs per user.
      Verified against the running machine rather than argued: FNV-1a of
      this account's real endpoint path,
      `c:/users/calfr/appdata/local/gavin/daemon.sock` lowercased and
      slash-normalised the way `pipe_name_for_path` does it, is
      `700ae9dea73ff7a7` — and `\\.\pipe\gavin-daemon-sock-700ae9dea73ff7a7`
      is one of the pipes actually listening. So the name in use IS the
      hash of this user's `%LOCALAPPDATA%`. The same function over
      `c:/users/bob/…` gives `e4baeafac3856f78`, a different pipe, which is
      `transport::tests::two_data_directories_get_two_pipes` holding for the
      real path shape rather than an invented one.
      **Not proven:** that a second account, logged in, actually brings up
      its own daemon. That needs a second account creating one, and creating
      a Windows user is the human's call, not an agent's. Everything the
      naming can settle is settled.
- [x] Neither account can open the other's pipe. The descriptor is
      `D:P(A;;GA;;;SY)(A;;GA;;;<the running user's SID>)`; `Get-Acl` on
      `\\.\pipe\gavin-*`, or simply the second account failing to connect, is
      the evidence. This is a **security** property, not a nicety — the default
      pipe descriptor grants READ to Everyone, which is why it is set explicitly.
      **`Get-Acl` on every live `\\.\pipe\gavin-daemon-sock-*` returns**
      ```
      D:P(A;;FA;;;SY)(A;;FA;;;S-1-5-21-…-1001)
      ```
      and that SID is this account's, per `whoami /user`. `FA` rather than
      the `GA` the SDDL was written with is the generic mapping being
      applied at creation, not a different grant. What matters is what is
      NOT there: **no `WD` (Everyone) and no `AU` (Authenticated Users)
      ACE**, and `P` so nothing inherits in beside them. The default
      descriptor's READ-to-Everyone is gone, which is the property the
      decision was made for. Owner and group are the running user too.

## 5. Then

- [x] Promote the reporting steps in the `windows` CI job to gates, one per
      thing that goes green. Only `cargo check` on the three crates is a gate
      today; the rest run with `continue-on-error: true` on purpose.
      **Three promoted**, each measured green on this machine first:
      `cargo check --workspace --tests` (stronger than checked — the whole
      workspace was BUILT and RUN here, so the tauri-build/WebView2 chain
      is known to link and not merely parse), `npm run check` (0 errors)
      and `npm run build`. Neither npm step reads a source file as bytes,
      so neither is exposed to the CRLF problem below.
      **Left reporting, with the reason written into the job:** `npm test`
      (the ten CRLF source-grep tests) and both `cargo test` steps.
      **And both `cargo test` steps gained `timeout-minutes: 20`**, which
      is not tidiness: `server::tests` DEADLOCKS on Windows, and
      `continue-on-error` does nothing for a hang. Uncapped, that step
      would sit on a runner until the job's six-hour default on every
      push and still report nothing.
      The job's `name:` is deliberately unchanged — renaming a job breaks
      whatever branch protection requires it.
- [x] Record what broke on this card, and carry anything structural back to
      [feat-windows-port.md](./feat-windows-port.md) rather than leaving the
      decision sections claiming something the machine disproved.

      **The parent card's Shell section now carries both halves** (it is in
      `plans/archive/`): that ConPTY, the tty, the epilogue and the TUI are
      confirmed, and that its "this decision spends a dependency the app had
      already taken" bullet was true of `git.exe` and false of the shell's
      toolbox. No decision section is left claiming something the machine
      disproved; the Shell decision itself stands.

      **One product fix, on this branch:** `shell::path_with_posix_tools`,
      called from `pty::spawn`'s command branch. Everything else this pass
      produced is a test or a card.

      **Four cards filed**, each with the evidence rather than a symptom:

      - [fix-windows-installer-collides-with-the-daemon.md](./fix-windows-installer-collides-with-the-daemon.md)
        — `$INSTDIR` is the state directory, and nothing stops the daemon
        before overwriting it. From reading the generated `installer.nsi`.
      - [fix-daemon-suite-deadlocks-on-windows.md](./fix-daemon-suite-deadlocks-on-windows.md)
        — `cargo test -p gavin-daemon` never finishes here. Pre-existing,
        proved against a 2026-09-10 binary.
      - [fix-app-crate-windows-path-shape-failures.md](./fix-app-crate-windows-path-shape-failures.md)
        — the nine `-p app` failures, diagnosed into seven causes.
      - [fix-source-grep-tests-on-crlf-checkouts.md](./fix-source-grep-tests-on-crlf-checkouts.md)
        — extended, not filed: it reaches `cargo test` too, which rules out
        its option 1 and means shipped skills carry the builder's line
        endings.

      **What a Windows machine could not answer**, and neither can another
      agent — both need the human:
      - The npm-shim claim, which is the whole reason the shell route beat
        PowerShell. Only `claude` is installed here, and by winget, as a
        native `.exe`; `%APPDATA%\npm` is empty. Needs `npm i -g` of
        `codex`, `gemini`, `cursor` and `opencode`.
      - A second Windows account. The pipe NAMING is verified against the
        live pipe and the DACL is verified with `Get-Acl`; that a second
        account brings up its own daemon needs a second account.
      - Every item in §3 that is a rendered surface.

**Out of scope:** WSL-based operation (a WSL workspace is the Linux app talking
to a Linux daemon); code signing; the ARM64 Windows target.
