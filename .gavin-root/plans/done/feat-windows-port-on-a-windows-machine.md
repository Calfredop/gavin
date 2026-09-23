---
model: opus[1m]
order: 1024
title: [feat] windows port — the half that needs a Windows machine
labels: windows
status: Done
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

## Where this card stands, 2026-09-22 — read before starting an agent on it

Both Windows branches are merged (`72aac15`, `b724f91`) and **§1, §2, §4
and §5 are complete**. On Windows: `cargo test -p app` 501/0, the daemon
suite **455 green in 78 seconds** where it had never once reached an end,
and the JS suite **5803 green across 265 files** with svelte-check at 0.
Written up under §5 ("The second pass").

**Nothing is left on this card.** A board audit on 2026-09-22 re-checked
all ten then-open items individually against the committed source and
confirmed every one was owner-only — the assertion below had been made
twice before, but never verified item by item. They were then routed to
where the work actually is:

- **All nine of §3** moved verbatim to
  [windows-desktop-pass.md](./windows-desktop-pass.md), with their static
  pre-flights.
- **§1's wizard line** merged into the last item of
  [fix-windows-installer-collides-with-the-daemon](./fix-windows-installer-collides-with-the-daemon.md),
  because it is the same button press in the same sitting.

**The old "rebuild and reinstall before doing them" warning is
satisfied.** It said the installed app predated the merges. It no longer
does: the install at `%LOCALAPPDATA%\Programs\Gavin` was built 22:59–23:02
on 2026-09-22, after the `win/installer-state-dir` merge (`2bcde943`,
21:59) and after `95871081` (22:48). Registry `InstallLocation`, the files
on disk, and the running `Gavin.exe` / `gavin-daemon.exe` pids all agree.
So the three items that exercise recently landed code — `workspace_delete.rs`
(Recycle Bin), `agent_setup.rs`'s wire spelling (the wizard), the daemon's
exit reporting (the `until` rail step) — now run against the code that
shipped.
**Two warnings on that reinstall**, both already on cards: installing
kills every running agent session, because the tab shells are children
of the installed `gavin-daemon.exe`; and the installer cannot overwrite
a live daemon, which is
[fix-windows-installer-collides-with-the-daemon](./fix-windows-installer-collides-with-the-daemon.md)'s
second defect. Stop the daemon deliberately rather than discovering it.

**If you merge into another checkout, refresh it to LF afterwards** —
the `.gitattributes` pin only reaches files that are re-checked out, and
the recipe is in CLAUDE.md.

So: rebuild, reinstall, open the app. Twice on this card a pass has
written "nothing left for an agent" and been wrong — §2 was parked for
eleven days on an install that turned out not to be needed, and §1 line 2
on a red suite that turned out to be nine mock bugs. The ten that remain
are different in kind: each one is a person looking at a window.

## 1. It builds, and it packages

- [x] `cargo test --workspace -- --skip gavin::` and `cargo test -p gavin-daemon
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
        **Closed 2026-09-22: `cargo test -p app` is 501 pass, 0 fail**,
        stable over three consecutive full parallel runs. That pass found
        the THIRD structural defect of this port, below.
      - **Structural, found 2026-09-22 — `accept()` fails on Windows
        where unix hands back a connection.** A client that connects and
        hangs up before the server reaches `accept` completes
        `ConnectNamedPipe` with `ERROR_NO_DATA` ("the pipe is being
        closed"), and `transport::connect_instance` handled only
        `ERROR_PIPE_CONNECTED`, so it surfaced as a failed accept. On
        unix the same sequence yields a good fd whose first read is EOF —
        which is the contract every connection loop in gavin is written
        against (accept, then read to `Ok(None)`). So on Windows, and
        nowhere else, `run_server` logs a transport fault whenever a
        client merely decides it has nothing to send. Not a test artefact:
        `a_command_the_daemon_predates_never_reaches_the_wire` was
        reporting a real gap, and every compat-gated request takes exactly
        that path — connect, decline to send, close. Fixed in
        `crates/protocol/src/transport.rs`, guarded by
        `transport::tests::a_client_that_hangs_up_before_accept_is_still_accepted`.
        Note the shape, since it is the same one twice now: the WRITE
        path already grouped `ERROR_NO_DATA` with the other
        peer-has-gone codes and the READ/accept path did not.
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

      **Re-run 2026-09-22 on `main` (662e977). Three of the four crates are
      at their baselines to the test name; the daemon still cannot finish,
      and now we know exactly why the board says otherwise.**
      - `cargo test -p protocol` — 108 pass, **3 fail**, the same three
        `XDG_DATA_HOME` names.
      - `cargo test -p gavin-mcp` — 56 pass, **1 fail**, the same
        `create_plan_resolves_relative_context_and_maps_arguments`.
      - `cargo test -p app` — **on `main`**, 490 pass, **12 fail**, 1
        ignored. Twelve, not the nine of 2026-09-11: the crate grew, the
        causes did not. The names are `agent_setup` x5,
        `fileviewer::extra_context_roots_…`,
        `memory::pid_file_sits_under_the_user_state_directory`,
        `program::a_command_child_does_not_share_this_console`,
        `session::command_connection_tests::a_command_the_daemon_predates_…`
        and `workspace_delete` x3 — every one on
        [fix-app-crate-windows-path-shape-failures.md](./done/fix-app-crate-windows-path-shape-failures.md).
        **This does not contradict the 501/0 recorded above it.** That
        figure was measured on `win/crlf-and-app-crate`, where the fixes
        are; this one on `main`, where they are not. Say which tree, or
        the next reader cannot tell a fix from a flake.
      - `cargo test -p gavin-daemon` — **still does not finish**, and this
        time proved for the price of one test rather than another stalled
        full run: `server::tests::attach_never_sends_a_baseline_status_changed_for_an_exited_session`
        run ALONE against today's binary does not return in 120s. Its
        module-mates are green — `shell::` 27/27, `pty::` 18 of 19, the one
        red being `pty::tests::a_readers_stream_ends_when_the_command_does`,
        which is the same missing EOF and not a second fault.
      **Why the board and the tree disagree.** `main` is 662e977 and
      carries none of the Windows fixes filed Done against it. Checked on
      2026-09-22, and the branches moved twice while this was being
      written, so check again rather than trusting the numbers:
      ```
      win/session-exit-reporting  be16f2d  4 ahead of main, unmerged
      win/crlf-and-app-crate      72b4bd1  7 ahead of main, unmerged
      ```
      Between them they carry `c19e6d5 fix(daemon): end a session's output
      stream when its process exits` (the ConPTY EOF fix, which is why the
      daemon suite stalls here and finishes there), `f7bafbf fix(protocol):
      treat a pre-accept hang-up as a connection`, and the `-p app`
      path-shape fixes. `crates/daemon/src/pty.rs` on `main` was last
      touched 2026-09-15 and has no `watch_for_exit`.
      So the stall is not a reappearance and not a regression — the fix
      has never landed on `main`. Three cards
      ([fix-windows-sessions-never-report-exit](./done/fix-windows-sessions-never-report-exit.md),
      [fix-source-grep-tests-on-crlf-checkouts](./done/fix-source-grep-tests-on-crlf-checkouts.md),
      [fix-app-crate-windows-path-shape-failures](./done/fix-app-crate-windows-path-shape-failures.md))
      are filed Done with their code on those two branches. Merging is the
      human's call. This item stays unticked until it happens.
      **The merge is textually safe, checked 2026-09-22 so the decision
      is not also a gamble.** `git merge-tree --write-tree` returns a tree
      and no conflict for `main`+`win/session-exit-reporting`, for
      `main`+`win/crlf-and-app-crate`, **and for the two branches against
      each other**; `git diff --name-only main...<each>` intersects in
      **zero files**. That last one is the check neither branch's own
      session can run, because each sees only its own side. What it does
      not prove is semantic: with no file in common a cross-branch
      regression is unlikely but not impossible, so the merged tree still
      wants one `cargo test --workspace` before this line is ticked.

      **TICKED 2026-09-22. Both branches merged on the owner's say-so
      (`72aac15`, `b724f91`), and the Rust workspace runs on Windows.**
      There was no cross-branch regression; the merge was as clean as
      `merge-tree` predicted. One step the merge does NOT do for you: the
      `.gitattributes` pin only reaches files that are re-checked out, so
      this checkout was still CRLF on disk afterwards. 1224 clean files
      refreshed with the recipe the merged CLAUDE.md now carries — do that
      before believing any source-grep result.
      ```
      cargo test -p protocol                          109 pass,  3 fail
      cargo test -p gavin-mcp                          56 pass,  1 fail
      cargo test -p app                               501 pass,  0 fail
      cargo test -p gavin-daemon -- --skip gavin::    455 pass,  0 fail   (78s)
      cargo test -p gavin-daemon gavin::               98 pass, 10 fail
      ```
      **The daemon suite is the headline: 455 green in 78 seconds, where
      on `main` that same run had never once reached an end.** The whole
      of `server::tests` is green — the 22 failures recorded above were
      downstream of the missing exit report, not 22 separate faults.
      `-p app` went 12 red → 0.
      The four reds that remain each have an owner and none is this
      card's: the three `protocol` ones are Linux `XDG_DATA_HOME` tests
      that cannot pass on Windows, and the `gavin-mcp` one is a hardcoded
      forward slash.
      **And the filter finally came off.** `gavin::` had been skipped in
      every measurement on this card, for flakiness — and it is **10 red
      deterministically, in 5 seconds**, which is not flakiness. Already
      filed as a nested task under
      [fix-daemon-suite-deadlocks-on-windows](./done/fix-daemon-suite-deadlocks-on-windows.md);
      this run is its confirmation on merged main, same ten names.
- [x] `cd app && npm ci && npm test && npm run check && npm run build`.
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

      **Re-run 2026-09-22 on `main` (662e977). Still blocked, and one of
      the two lines §5 promoted to a CI gate has since gone red.**
      - `npm ci` deliberately NOT re-run: `node_modules` is present, and
        wiping it in the shared checkout would break whichever sibling
        session is mid-suite. Nothing about it was in doubt.
      - `npm run build` ✓ — the static adapter wrote `build/` in 3m6s
        (slower than 1m26s only because two other suites were running).
      - `npm run check` — **6 errors**, not the 0 this card recorded.
        Three in `src/lib/core/contextMenu.test.ts` (an `EventTarget`
        literal missing `addEventListener`/`closest`) and three in
        `src/lib/review/criticalReview.test.ts` (`node:fs`, `node:path`,
        `import.meta.dirname`). Both files postdate this card and neither
        is the port's — but **§5 promoted `npm run check` to a gate on the
        strength of that 0, in the Linux job as well as the Windows one,
        and these six are platform-independent**, so CI is red on `main`
        for everyone. Filed as
        [fix-npm-run-check-gate-is-red-on-main.md](./fix-npm-run-check-gate-is-red-on-main.md).
      - `npm test` — **24 red of 5751, across 14 files.** Twenty-one of
        them in 13 files are the app suite's recorded baseline, nine of
        those being the CRLF source-grep tests this item is blocked on
        (the tenth, `orchestrationClearDone`, no longer exists). The
        fourteenth file is `src/lib/core/layoutState.test.ts` with 3 red —
        two 5s timeouts and one dynamic import racing — and it passes
        **251 of 251 when run alone**, so it is load flakiness on a
        machine running two suites at once, not a regression. Re-measure
        it alone before ever reading it as one.
      The CRLF card is filed Done, and like the exit-reporting one it is
      **not on `main`**: its single commit sits on `win/crlf-and-app-crate`
      (4d22fa9, "pin every text file to LF on disk on every OS"), unmerged.

      **Merged 2026-09-22 (`b724f91`), and it did what it said — but this
      line still does not pass, for reasons that were never the port's.**
      After the merge and an LF refresh of the checkout:
      ```
      npm test        12 red of 5751, in 8 files   (was 24 in 14)
      npm run check    6 errors                     (unchanged)
      npm run build   ✓
      ```
      **Every source-grep test the CRLF card named is green.** The twelve
      that remain are a different and older problem the line-ending noise
      was hiding: three suites that fail to LOAD because they mock
      `$lib/core/layoutState` without `agentDefaultsStore`, plus nine
      assertions in `workspaceToolsActions`, `commandGate`,
      `orchestrationGavinTool`, `toolPlatformGate` and
      `indicatorSurfaces`. **None of them is Windows-specific**, so the
      Linux job fails on the same twelve, where `npm test` is a gate.
      Filed as
      [fix-the-last-twelve-vitest-failures-on-main](./fix-the-last-twelve-vitest-failures-on-main.md).
      **TICKED 2026-09-22 (`9d72df9`). The JS suite is green on Windows,
      for the first time.**
      ```
      npm test       5803 passed, 265 files, 0 red   (was 24 red / 14 files)
      npm run check  0 errors                        (was 6)
      npm run build  ✓
      ```
      `npm ci` was deliberately not re-run — `node_modules` is present and
      wiping it in the shared checkout breaks whichever sibling session is
      mid-suite. It was ✓ on 2026-09-11 and nothing since has touched the
      lockfile.
      **Not one of the failures was the port's, and two had stopped doing
      their job:** `commandGate` asserts the TS classification names
      exactly the commands `lib.rs` registers — it was red on
      `detect_agent_binaries`, which is the drift it exists to catch, and
      being permanently red is how it would have missed the next one.
      `orchestrationGavinTool` and `toolPlatformGate` guarded conventions
      on `WorkspaceToolsHubView.svelte`, which is a thin wrapper now; the
      drawing and the Run gate had moved to `ToolsExplorerView.svelte`,
      which honours both — so they were asserting against a file with no
      surface left in it. The rest were mocks lying about a module's
      shape, all hidden behind `as never`.
      Both suites are **gates in the Linux CI job**, which had been
      failing on these for as long as they existed. Both cards filed for
      them are now Done.
- [x] `npm run tauri dev` launches and reaches its daemon.
      **Done 2026-09-22.** The dev app came up (`target\debug\Gavin.exe`),
      window titled "Gavin" and responding, no error on the console, and
      it **spawned its own daemon**: `target\debug\gavin-daemon.exe` with
      the dev app as its parent — the sibling lookup working in a debug
      build, the same code path §1's installed-app item proves for a
      packaged one. It bound the DEV endpoint and nothing else:
      `\\.\pipe\gavin-daemon-dev-sock-45ec7498eeb8d815` appeared beside
      the release `gavin-daemon-sock-700ae9dea73ff7a7`, and it wrote fresh
      `daemon-dev.token`, `daemon-dev.log` and `registry-dev.sqlite`. The
      release daemon — which this very session's shell is a child of —
      was untouched throughout, which is the separation CLAUDE.md promises
      and had not previously been watched happening. Torn down after:
      window closed, dev daemon stopped by pid, dev pipe gone, release
      pipe still listening.
      **What it cost, and it is a finding rather than an aside:** the
      command as configured **cannot start** while any sibling session is
      running a `gavin-mcp.exe` out of this checkout.
      `build.beforeDevCommand` is `cargo build -p gavin-daemon -p gavin-mcp
      && npm run dev`, and Windows will not let a running executable be
      replaced:
      ```
      error: failed to remove file `…\target\debug\gavin-mcp.exe`
      Caused by: Access is denied. (os error 5)
             Error The "beforeDevCommand" terminated with a non-zero status code.
      ```
      Four other agent sessions held it open. On a unix host the unlink
      succeeds and the running process keeps its old inode, so this is a
      port defect and not a local mess —
      [fix-tauri-dev-cannot-rebuild-a-sidecar-another-session-is-running.md](./fix-tauri-dev-cannot-rebuild-a-sidecar-another-session-is-running.md).
      The run above was obtained by overlaying `beforeDevCommand` with a
      bare `npm run dev` (`--config`) and building `-p gavin-daemon`
      alone, so the stale `gavin-mcp.exe` was left where it was rather
      than killing four sessions' MCP servers to relink it.
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
- [x] **The spec's open item, now with an extension on it:** install the
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
      **Ticked 2026-09-22 against the running install, not the `.nsi`.**
      `%LOCALAPPDATA%\Gavin` holds `Gavin.exe`, `gavin-daemon.exe` and
      `gavin-mcp.exe` side by side, triple stripped, exactly as the
      installer said it would. The sibling lookup has something to find,
      and the item below proves it finds it.
      The same listing is the installer card's first defect caught in the
      act rather than predicted: `daemon.log`, `daemon.token`,
      `kanban.sqlite`, `orchestration.sqlite` and `registry.sqlite` are in
      that directory too — the state directory and `$INSTDIR` are one
      folder, with live databases sitting among the program files an
      uninstall would remove.
- [x] Run the INSTALLED app, not a dev build, and confirm it starts its own
      daemon. That is the sibling lookup working end to end.
      **Done 2026-09-22, and by the strongest evidence available: the
      session that verified it was running inside the thing it verified.**
      The installed `Gavin.exe` (`%LOCALAPPDATA%\gavin\Gavin.exe`) was up,
      and the daemon serving it is `%LOCALAPPDATA%\Gavin\gavin-daemon.exe`
      — the sibling, not a dev build and not something on PATH. Its parent
      pid is gone, which is `DETACHED_PROCESS` behaving as designed rather
      than a fault. The whole ancestry of an agent tab, read off the live
      machine:
      ```
      gavin-daemon.exe  %LOCALAPPDATA%\Gavin\gavin-daemon.exe   (detached)
        └ sh.exe        C:\Program Files\Git\usr\bin\sh.exe
            └ claude.exe
      ```
      That is §2's shell decision in production, not in a test: the
      daemon's chosen `sh.exe` is the Git-for-Windows `usr/bin` one, and
      the agent CLI is its child.
- [x] Run the wizard's integration step and confirm the absolute `gavin-mcp`
      path it writes into the agent config resolves.
      **Moved, not dropped** (2026-09-22): this is the same button press as
      the last item of
      [fix-windows-installer-collides-with-the-daemon](./fix-windows-installer-collides-with-the-daemon.md)
      ("re-run Set up / update for each workspace's agents"), and it is
      tracked there now so one action does not carry two boxes. Ticked here
      to close this section; the work is live on that card.

      **The evidence paragraph that used to sit here was wrong after the
      installer move and is corrected on that card.** It claimed the wizard
      would write `C:\Users\calfr\AppData\Local\Gavin\gavin-mcp.exe` and
      that this was "character-for-character the command in this
      workspace's `.mcp.json`, and it resolves". Post-install both halves
      are false: the binary is at `%LOCALAPPDATA%\Programs\Gavin\gavin-mcp.exe`,
      and `.mcp.json` still names the old path, which no longer exists. The
      item went from "only the button-press is owed" to "the button-press
      is the repair" — every agent session in this repo currently starts
      with a dead `gavin` MCP server because of it.

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
- [x] Each profile CLI starts under it: `claude`, `codex`, `gemini`, `cursor`,
      `opencode`. Inside `sh.exe` the extensionless npm shim is the one that
      wins, which is the whole reason this route was chosen over PowerShell.
      **Only `claude` can be answered on this machine, and it answers the
      wrong half of the question.** It starts and draws (above), but it is a
      winget install — a native `claude.exe` — so it says nothing about the
      npm shim. `%APPDATA%\npm` is on PATH and **empty**: none of `codex`,
      `gemini`, `cursor`, `opencode` is installed, so the claim this route
      was chosen for is still unproven. Needs `npm i -g` of the four, which
      is a change to the human's machine and so is the human's call.

      **2026-09-22: the mechanism is now proved, a second CLI answers, and
      the pass found that the daemon does not actually use the mechanism.**
      Three separate findings, none of which needed anything installed:

      1. **The npm-shim claim is TRUE of `sh.exe`.** Rather than wait for
         an install, npm's real three-file layout was synthesised on PATH —
         `faketool` (an extensionless `#!/bin/sh` script, LF, +x),
         `faketool.cmd`, `faketool.ps1` — and `sh -c "faketool one two"`
         ran the extensionless one. The load-bearing guess of the whole
         port holds.
      2. **The daemon never lets `sh` make that choice, and it costs
         argument fidelity.** `shell::command_with_windows_shim` searches
         PATH × PATHEXT, which has no empty entry, so a bare npm CLI name
         is rewritten to `<name>.cmd` — routed through `cmd.exe`, which
         re-parses the line. An argument holding `&` and no whitespace is
         split and its tail executed (`sh -c "showone.cmd 'a&b'"` →
         `%1` is `a`, then `'b' is not recognized…`), where the POSIX shim
         passes `a&b`, `c^d` and `%PATH%` through untouched. Exit codes
         survive both arms (a `.cmd` exiting 42 reports 42), so the
         epilogue's re-raise is safe either way and this is an argument
         bug only. Filed with the repro and a one-line fix:
         [fix-npm-cli-shims-are-run-through-cmd-exe-on-windows.md](./fix-npm-cli-shims-are-run-through-cmd-exe-on-windows.md).
      3. **`cursor` is now installed, and it starts.** Not by npm — a
         `cursor-agent` install under `%LOCALAPPDATA%\cursor-agent` with
         only `.cmd`/`.ps1` shims and a bundled runtime in
         `versions/2026.09.10-fd3934a/`. Bare, it is exactly the failure
         this item fears: `sh -c "cursor-agent --version"` → `command not
         found`, 127. Through the line `rewrite_for_windows_shim` builds
         for it — `CURSOR_INVOKED_AS=… '<ver>/node.exe' '<ver>/index.js'`
         — it answers `2026.09.10-fd3934a`, 0. So a CLI that is neither a
         native `.exe` nor an npm shim now has a real answer, and the
         `resolve_bundled_node_entry` arm is confirmed against the layout
         it was written for.

      **Ticked later the same day. All five are answered, and none of it
      needed a change to the machine.** The blocker was always "`npm i -g`
      is the human's call" — but the item does not need a GLOBAL install,
      only npm's shim layout on PATH. So the three missing CLIs went into
      a **sandboxed prefix**:
      ```
      npm install -g --prefix <scratch> @openai/codex @google/gemini-cli opencode-ai
      ```
      which writes the ordinary `<name>` / `<name>.cmd` / `<name>.ps1`
      trio, byte-for-byte what `%APPDATA%\npm` would hold, without
      touching it. With that prefix on PATH, under `sh.exe`:
      ```
      codex     0.155.1    bare → 0     .cmd → 0
      gemini    0.60.0     bare → 0     .cmd → 0
      opencode  1.18.32    bare → 0     .cmd → 0
      ```
      `claude` was answered on 2026-09-11 (winget `.exe`, full TUI under
      ConPTY). `cursor` launches the word **`agent`**, not `cursor` —
      `agent_setup.rs`'s profile is `command: "agent --approve-mcps
      --trust"` — and `agent` behaves exactly as `cursor-agent` does: 127
      bare, 0 through the bundled-node line the rewrite builds. So every
      profile CLI starts under the shell route, and the route survives all
      three shapes a Windows CLI comes in: a native `.exe`, an npm trio,
      and a `.cmd`-only shim with a bundled runtime.
      **What this does NOT mean:** the three are not installed globally,
      so gavin still cannot launch those profiles on this machine. That
      install remains the owner's, and finding 2 above is worth fixing
      **before** it happens rather than after — with the sandbox prefix on
      PATH, `sh -c "codex.cmd --version 'x&whoami'"` printed the codex
      version and then ran `whoami`.
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

## 3. The desktop pass — moved to its own card

The nine rendered checks that were here are now
[windows-desktop-pass.md](./windows-desktop-pass.md), moved verbatim with
their static pre-flights. They were split out on 2026-09-22 because they are
one coherent sitting in front of the running app, owner-only to the last
item, and keeping them inside an umbrella whose other four sections are
complete made the card read as if it still had agent work in it. It does
not.

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
      **One of the three has since gone red, 2026-09-22**, and it matters
      that the gate is right and the code is wrong rather than the other
      way round: `npm run check` now reports 6 errors on `main`, from two
      test files that postdate this card, in both the Linux and the
      Windows job. The gate stays; the errors go —
      [fix-npm-run-check-gate-is-red-on-main.md](./fix-npm-run-check-gate-is-red-on-main.md).
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

      ## The second pass, 2026-09-22

      No product fix. Four §1 items went from unticked to proved, and
      three more cards are filed. What the second pass is really for is
      the shape of the remaining red, which is not what the first pass
      left behind:

      **Three cards are filed Done whose code is not on `main`** — the
      exit-reporting fix, the CRLF fix and the `-p app` path-shape fixes,
      spread across `win/session-exit-reporting` and
      `win/crlf-and-app-crate`, both unmerged. Both §1 items that depend
      on them therefore still fail on `main` exactly as recorded, and an
      agent reading the board alone would conclude the opposite and then
      read the daemon stall as a fresh regression. Merging is the human's
      call and nothing here asks for it — but the disagreement between the
      board and the tree is the single most misleading thing about this
      card's state, so it is written down.

      It has a second edge worth naming: **this card now carries numbers
      from two different trees**, because sessions working those branches
      write their green results onto the same item an agent measuring
      `main` writes its red ones onto. Neither is wrong. Every figure
      added from here should name the commit it was taken at.

      **Three cards filed, each from running the thing:**

      - [fix-npm-cli-shims-are-run-through-cmd-exe-on-windows.md](./fix-npm-cli-shims-are-run-through-cmd-exe-on-windows.md)
        — the rewrite sends npm CLIs through `cmd.exe`, which splits an
        argument on a whitespace-free `&` and runs the tail. Found by
        synthesising npm's layout rather than waiting for an install.
      - [fix-npm-run-check-gate-is-red-on-main.md](./fix-npm-run-check-gate-is-red-on-main.md)
        — a gate this card promoted on a 0-error measurement now has 6, in
        both CI jobs, from two files that postdate it.
      - [fix-tauri-dev-cannot-rebuild-a-sidecar-another-session-is-running.md](./fix-tauri-dev-cannot-rebuild-a-sidecar-another-session-is-running.md)
        — the dev loop cannot start while a sibling session holds
        `gavin-mcp.exe`. The product's own concurrency defeats its own
        dev loop, on Windows only.

      **What the second pass could answer that the first could not**, and
      only because the app has been in daily use since: the installed
      package, the sibling lookup, the dev app's own daemon and the
      dev/release endpoint separation are all now watched working rather
      than argued from `installer.nsi`.

      **§2 closed on the second pass**, and the way it closed is worth
      keeping: the item had been blocked since 2026-09-11 on "`npm i -g`
      is a change to the human's machine". It never needed a global
      install — only npm's shim layout on PATH, which
      `npm install -g --prefix <scratch>` provides without touching
      anything. Three CLIs, five minutes, a blocker that had stood for
      eleven days. Worth remembering the next time an item is parked as
      "needs the human": check whether it needs the human's MACHINE or
      only the human's permission.

      **Still the human's:** the merge (which unblocks §1's two suite
      lines), `npm i -g` if those profiles are to be usable rather than
      merely proved — fix the shim card first — a second Windows account,
      the wizard button, and every rendered surface in §3.

**Out of scope:** WSL-based operation (a WSL workspace is the Linux app talking
to a Linux daemon); code signing; the ARM64 Windows target.
