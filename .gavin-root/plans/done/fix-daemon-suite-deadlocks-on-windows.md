---
order: 7168
title: [fix] 22 server::tests fail on Windows, behind a hang that has its own card
labels: windows
status: Done
priority: medium
complexity: medium
---
`cargo test -p gavin-daemon` on Windows 11 produces **22 failures, every
one in `server::tests`**, and then hangs before finishing. Measured
2026-09-11 while working
[feat-windows-port-on-a-windows-machine](./feat-windows-port-on-a-windows-machine.md)
§1.

**The hang is not this card's.** It is
[fix-windows-sessions-never-report-exit](./fix-windows-sessions-never-report-exit.md):
a ConPTY reader gets no EOF when its child exits, the daemon's pump
breaks on `Ok(0)` and nothing else, so a session that ends by itself is
never reported as exited. Narrowed to that on the evidence below. Fix
that first, re-measure, and expect some of the 22 to go with it.

This card is what is left over: the failures themselves.

## How the hang was pinned on the EOF bug and not on this

Three runs, and the narrowing came from the third:

| run | threads | result |
|---|---|---|
| current tree | default | 22 failures, then stalls — 0 CPU over 40s, 200+ threads, ~35 unreaped `sh.exe`/`conhost` |
| **2026-09-10 binary**, another checkout, none of the port's changes | default | 22 failures, stalls **the same way at the same point** |
| current tree | **4** | 22 failures, **still stalls** |

- The second run rules out the windows-port work: the failure sets are 22
  and 22, all `server::tests`, differing by **one name**
  (`kill_session_answers_without_waiting_for_the_process_to_go` against
  `killing_a_session_frees_its_screen`) — a different test each run,
  which is the flakiness signature, and the first of those is the one
  [fix-daemon-server-test-flakiness](./archive/fix-daemon-server-test-flakiness.md)
  says it "deliberately left alone" as the likely next flake.
- The third rules out memory pressure, which
  `cargo-suite-killed-for-memory` would otherwise explain: at four
  threads the machine is not loaded and it stalls anyway. It is also not
  the slow tests — `--skip gavin:: --skip git_status --skip repo`
  throughout, which is exactly the filter that exists because those take
  4–7 minutes each.
- **What the third run named:** the last test still running was
  `server::tests::attach_never_sends_a_baseline_status_changed_for_an_exited_session`.
  A test that waits on a session EXIT, hanging on a platform where an
  exit is never reported. That is the EOF bug, not a scheduling excuse.

## What is left for this card

- [x] Re-run after the EOF fix lands and get a real count. Until the
      suite can finish, "22" is a floor, not a measurement — the run
      never reaches the end.
      **Measured 2026-09-22 with the fix** (branch
      `win/session-exit-reporting`), `--test-threads=4 --skip gavin::
      --skip git_status --skip repo`: the run FINISHES, 382 passed, 22
      failed, 144s. So 22 is the number, not a floor. Each of the 22 was
      then run alone against the prebuilt pre-fix binary in the main
      checkout: 20 fail there too, deterministically -- the four
      `recover_*` ones only after `PROCESS_BUDGET`'s 30s, because a
      recovered shell never echoes on Windows (a `/tmp` cwd in
      `leftover_row` is the first thing to check) -- and 2 are timing
      flakes (`relays_status_changed_when_pty_output_contains_an_osc777_notification`,
      `typing_after_a_failure_means_the_next_turn_is_judged_on_its_own`)
      that pass alone on both binaries and fail about one run in ten on
      either. The 22, all `server::tests`:
      - `a_card_moved_behind_the_daemons_back_re_keys_its_rail_step_on_the_next_scan`
      - `a_resize_is_not_the_agent_working`
      - `a_resize_never_answers_a_question_the_agent_asked`
      - `a_scan_that_moved_nothing_pushes_only_the_tree`
      - `a_session_that_left_a_process_behind_keeps_its_row_when_its_shell_ends`
      - `add_external_gavin_context_over_socket_is_confined_to_a_watched_root`
      - `attach_announces_an_orphan_alongside_the_interrupted_marker`
      - `claiming_binds_an_in_progress_card_to_the_session_that_wrote_it`
      - `claiming_carries_the_run_record_it_found_instead_of_wiping_it`
      - `claiming_keys_the_binding_on_the_path_the_board_uses`
      - `claiming_never_takes_a_card_off_another_live_session`
      - `end_orphan_reaps_the_sessions_queued_follow_ups_once_the_process_is_gone`
      - `init_and_create_context_over_socket_are_idempotent`
      - `recover_brings_a_plain_terminal_session_back_as_an_idle_bare_shell`
      - `recover_never_re_runs_an_agents_command_and_says_so_on_the_record`
      - `recover_records_the_bare_shell_it_spawned_not_the_process_it_replaced`
      - `recover_spawns_fresh_shells_for_leftover_registry_entries`
      - `recover_spawns_in_the_sessions_own_cwd_not_the_workspace_root`
      - `relays_status_changed_when_pty_output_contains_an_osc777_notification`
      - `renaming_the_root_away_pushes_root_missing_and_renaming_back_heals`
      - `save_tool_accepts_every_kind_the_app_can_author`
      - `typing_after_a_failure_means_the_next_turn_is_judged_on_its_own`
- [x] Then work whatever survives. `fix-daemon-server-test-flakiness` is
      **Done**, but its bench — 6 runs at 24 threads, 20 at 40, 0 red
      after — was run on a 10-core M-series mac, and the card does not
      mention Windows once. Its four fixes were never measured here, so
      "already fixed" is a claim about another platform.

      **Worked 2026-09-22.** Every red above is closed. What each one
      turned out to be, and what was changed for it:

      **One product bug, and it is not in the tests.**
      `gavin::confine_root_path` canonicalised its argument with raw
      `Path::canonicalize` and `starts_with`-compared the result against
      `SessionManager::watched_roots`, which are built with
      `protocol::canonical_path`. On Windows the first is verbatim
      (`\\?\C:\…`, `Prefix::VerbatimDisk`) and the second is stripped
      (`C:/…`, `Prefix::Disk`), so the comparison was false for every
      path — and **every `CreateGavinContext` and `AddExternalGavinContext`
      inside a watched workspace was refused on Windows**. Now uses
      `protocol::canonical_path`. Its unit test never caught this because
      it built `watched_roots` with `canonicalize()` too, making both
      sides verbatim by construction; it now builds them the way the
      real caller does, and goes red against the old code.

      **A deadlock that was not the EOF bug, and is the one this card is
      named for.** Three attach tests waited with
      `read_message(...).unwrap().unwrap()` in a loop and consulted their
      deadline only AFTER the read, so a daemon that sent nothing blocked
      them for ever. They share one `await_output` helper now, bounded by
      a watchdog that shuts the read half down — a shutdown rather than
      `set_read_timeout` for the reason `failure_test_session` already
      gives, that a timeout can land mid-message and desynchronise the
      stream. `reattaching_after_detach_…` is green 15/15 alone and on
      the bench; under heavy PTY-concurrency it can still miss its output
      once, which is now a named failure with the other responses in the
      message instead of a hang.

      **Six tests spelled paths the way Windows canonicalises them and
      the daemon never does.** A new `wire_spelling` test helper (written
      out rather than delegated to `protocol::wire_path`, so a reported
      path is still compared against an independent derivation) is now
      what `manager_watching_a_card` and the two scan tests hand in and
      assert against.

      **`spawn_survivor` spawned `/bin/sh` as a native process**, so four
      orphan tests died `Os { code: 3 }` before their bodies ran. Split
      `#[cfg(unix)]`/`#[cfg(windows)]` the way `proc::tests::spawn_leaf`
      already is.

      **Enter is CR, and only the POSIX shell forgave `\n`.** A recovered
      session gets `interactive_shell()` — `cmd.exe` on Windows — which
      is a console reading key events, and `\n` is Ctrl-J, not Enter. The
      four `recover_*` reds were typing lines that were never submitted
      and waiting out the whole 30s `PROCESS_BUDGET`. New `type_line`
      helper sends `\r`; the recovery tests now finish in 5s. One of them
      also typed POSIX `case "$PWD" in …` at `cmd.exe` — it prints its
      own directory now and the test does the deciding.

      **No SIGWINCH, no focus report, no rename.** Three OS facts,
      measured rather than assumed:
      - ConPTY raises no SIGWINCH and `sh.exe` synthesises none, so the
        resize fixtures' `trap … WINCH` never fired. Polling `stty size`
        was tried and is worse: each poll spawns a process on the console
        and ConPTY answers that with a full repaint, so the session is
        never quiet. What works is the console's OWN answer — ConPTY
        emits `ESC[8;rows;cols t` on resize — which `is_repaint` now
        accepts alongside the unix marker. All three resize tests are
        green on Windows with their assertions intact.
      - ConPTY takes a focus report out of the input stream and turns it
        into a console FOCUS_EVENT, so no program can ever answer one.
        Proved by writing three PLAIN bytes into the same fixture, where
        `head -c 3` returned and the marker printed — which is what rules
        out `stty raw -echo` failing. `a_focus_report_is_not_the_agent_working`
        is `#[cfg(unix)]`; the half that does bite on Windows
        (`a_focus_report_does_not_dismiss_the_restored_badge`) needs no
        answer from the program and still runs.
      - Windows refuses to rename a directory while any handle is open
        anywhere inside it, and that refusal survives FILE_SHARE_DELETE
        on the inner handle (measured directly, outside gavin).
        `watch_targets` registers a watch per scanned directory, so
        `.gavin-root` alone is enough.
        `renaming_the_root_away_…` is `#[cfg(unix)]`.

      **Two fixtures assumed an ordering ConPTY does not keep.** ConPTY
      answers a session's first output with a repaint of its own, and
      whether that arrives in the same read as the output that provoked
      it is a coin toss — landing behind an agent's bell it reads as
      renewed activity and clears `waiting_for_input`. And ConPTY does
      not finish echoing a submitted line before the line runs: the order
      on the wire is the typed text, `ESC[?2004l`, the command's output,
      and only then the `\r\n`. Both fixtures now let the console settle
      before they ring.

      **The four `git_status` stalls were the same two bugs again** — a
      native path interpolated into an OSC 7 `file://` URI, and a wait
      that checked its deadline only between reads. New `osc7_path` and
      `bound_reads` helpers; all 32 now pass in 6.8s. See **After**.

      **`save_tool_accepts_every_kind_the_app_can_author` was red on
      every platform**, not just Windows: `be2b442` added `"critique"` to
      the loop and left `assert_eq!(tools.len(), 7)`.

      **`--skip repo` was hiding 20 tests** — see the bench below.
- [ ] [gavin::tests is 10 red on Windows, and this card's filter is why nobody had seen it](./gavin-tests-is-10-red-on-windows-and-this-card-s-filter-is-why-nobody-had-seen-it.md)
- [x] Reproduce deliberately before fixing anything, the way that card
      did: run the test binary directly at a fixed `--test-threads` and
      find where it turns red. A bench is what turned that card from a
      report into four named causes.
      **Benched 2026-09-22** on `win/session-exit-reporting` at
      `c19e6d5`, the test binary run directly:
      `gavin_daemon-*.exe --test-threads=4 --skip gavin:: --skip
      git_status --skip repo server::tests::` — 157 tests, 140s.

      **First finding: that filter is wrong, and it hid 20 tests.**
      `--skip repo` is a substring match, so it also skipped every test
      with "report" in its name — `a_focus_report_is_not_the_agent_working`
      among them, which is red on Windows and had never been measured.
      `--skip git_status` already covers the git ones, so the filter to
      measure with from here was `--skip gavin:: --skip git_status`:
      169 server tests, ~44s. By the end even that was unnecessary — see
      **After**, where the whole binary runs unfiltered in 59s.

      **The suite still hangs, and the EOF fix is not what was holding
      it.** One test never returns:
      `reattaching_after_detach_delivers_output_to_the_new_connection_only`.
      Its wait is `read_message(...).unwrap().unwrap()` in a loop with
      the deadline checked only AFTER the read — so a daemon that sends
      nothing blocks the read for ever and the deadline is never
      consulted. Exactly the shape `pty_reads_until`'s own comment warns
      about ("a deadline consulted BETWEEN reads bounds only a session
      that is talking"). The neighbouring
      `attach_from_a_new_connection_streams_output_of_an_existing_session`
      and `attach_after_the_pump_has_started` share it.
      Skipping that one test, the run FINISHES.

      **27 red, not 22**, and the delta is not noise in one direction:
      `relays_status_changed_when_pty_output_contains_an_osc777_notification`
      passed, and six the first measurement did not name went red. The
      causes, each read off the panic rather than guessed:

      1. **`confine_root_path` mixes two canonical spellings** — a real
         product bug, the only one here the app itself hits. It calls
         raw `Path::canonicalize` (verbatim, `\\?\C:\…`) and
         `starts_with`-compares against `watched_roots()`, which are
         built with `protocol::canonical_path` (stripped, `C:/…`). The
         two never compare equal, so on Windows **every**
         `CreateGavinContext` and `AddExternalGavinContext` inside a
         watched workspace is refused. `canonical_path`'s own doc
         comment predicts this exact failure. Red:
         `init_and_create_context_over_socket_are_idempotent`,
         `add_external_gavin_context_over_socket_is_confined_to_a_watched_root`.
      2. **Tests spell paths natively, the daemon speaks wire paths** —
         test-side. The daemon reports `C:/…/ship.md`; the tests build
         expectations from `canonicalize().to_string_lossy()`, which is
         `\\?\C:\…\ship.md`, and hand that spelling in as input too, so
         a binding keyed by path string never matches. Red: the four
         `claiming_*`, `a_card_moved_behind_the_daemons_back_…`,
         `a_scan_that_moved_nothing_pushes_only_the_tree`.
      3. **`spawn_survivor` spawns `/bin/sh` as a native process** —
         test-side. `std::process::Command::new("/bin/sh")` looks for
         `C:\bin\sh` and dies `Os { code: 3, NotFound }` before the test
         starts. Red: `a_session_that_left_a_process_behind_…`,
         `attach_announces_an_orphan_…`, `end_orphan_reaps_…`,
         `recover_records_the_bare_shell_…`.
      4. **A recovered session's shell never echoes** — the four
         `recover_*` reds, each after `PROCESS_BUDGET`'s 30s. Recovery
         spawns `interactive_shell()`, which on Windows is `cmd.exe`,
         and `shell_echoes` sends `\n` where a console expects `\r`.
         Unconfirmed until measured. (`/tmp` is NOT the cause after all:
         `C:\tmp` exists on this box, so `recovery_cwd` resolves — which
         also means these four fail differently on a machine without it.)
      5. **A resize never reaches the program** — `a_resize_is_not_the_agent_working`,
         `a_resize_never_answers_a_question_the_agent_asked`,
         `a_resize_that_changes_nothing_still_lets_the_agent_speak`, all
         on "the session never repainted". The fixtures `trap … WINCH`;
         ConPTY has no SIGWINCH to deliver.
      6. **A watched root cannot be renamed** —
         `renaming_the_root_away_pushes_root_missing_and_renaming_back_heals`
         dies `Os { code: 5, PermissionDenied }` on `fs::rename`: the
         watcher holds an open handle on the directory, which Windows
         honours and unix does not.
      7. **A "quiet" session is never quiet under ConPTY** — the
         `*_line_goes_failed_not_idle` family plus
         `typing_after_a_failure_…` and
         `heuristic_permanently_stops_…`. `await_status` records
         `["idle","working","idle","working","idle","working"]` on a
         session that was sent one `printf`, so something repaints on a
         cycle the heuristic reads as work. `a_request_timed_out_line_…`
         DID reach `failed` and still panicked "never saw status
         failed", because the message only reports `seen` and not that
         it was the reason push that never came.
      8. **`save_tool_accepts_every_kind_the_app_can_author` is red on
         every platform** — `be2b442` added `"critique"` to the loop and
         left `assert_eq!(tools.len(), 7)`. Nothing to do with Windows.

      (7) turned out to be two different things once the machine was not
      carrying a hundred leftover `sh.exe` from earlier runs. The
      `*_line_goes_failed_not_idle` family is load-sensitive and green
      on a quiet box. The rest is a real ConPTY ordering fact, recorded
      under the fixes above.

## After

**The filters are not needed any more.** No `--skip` of any kind:

```
gavin_daemon-*.exe --test-threads=4
```

Three consecutive runs, identical: **553 passed, 10 failed, 1 ignored,
~59s**. Every one of the ten is in `gavin::tests`, pinned identically
against `git show HEAD:crates/daemon/src/gavin.rs` — none of it is this
card's, and it is filed as the nested task above. **`server::tests` is
green in all three**, `killing_a_session_frees_its_screen` included.
Through cargo rather than the binary — `cargo test -p gavin-daemon --
--test-threads=4` — the same: 553/10, 60.8s, no stall.

**The "~35 unreaped `sh.exe`/`conhost`" in the table above went with the
hangs.** After a full run now, every `sh.exe` on this machine is a live
agent session under the daemon or a shell someone opened; not one is a
test fixture. That pile was the suite being killed by hand mid-run, not
a teardown that leaks.

**The last thing found, and the biggest surprise: the `git_status`
tests were never slow.** This card's own preamble says the filter exists
because they take 4–7 minutes each. Run unfiltered, four of them never
returned at all, at ~1% of one core — and the cause was the same pair
already fixed above. They interpolate a native path into an OSC 7 URI,
so on Windows the session reports
`file://hostC:\Users\…`, which `OscCwdScanner` rightly refuses (a file
URI's path begins with `/`, which is why Git Bash says
`file://HOST/C:/Users/…` and `strip_uri_drive_slash` exists to take
that slash back off). No cwd was ever parsed, no repo mapping was ever
made, no git status was ever sent — and the waits, like the attach ones,
checked their deadline only after a read that never returned. New
`osc7_path` test helper for the URI, `bound_reads` for the waits, and
**all 32 `git_status` tests now pass in 6.8 seconds.** Whatever the
4–7 minutes were, they were not these tests working.

The one open item above is a **To Do card of its own**, not a nested
one, precisely so filing this card Done does not file the follow-up
with it.

## Two things found here that are nobody's card yet

- **A Windows user cannot rename or move a workspace folder while gavin
  has it open.** Windows refuses to rename a directory while any handle
  is open anywhere inside it, and `watch_targets` registers a watch per
  scanned directory. Only a single recursive watch would leave the tree
  movable; on Windows that trade is real, and the nested task puts it to
  the human rather than deciding it.
- **ConPTY answers a session's first output with a repaint of its own**,
  and it can arrive in a read of its own behind the output that provoked
  it. The heuristic reads that as the agent working, which clears
  `waiting_for_input`. In practice a real agent's question comes long
  after startup, so this is mostly a fixture hazard — but it is the
  mechanism by which a "needs your permission" badge can be wiped on
  Windows by output no program produced, and nothing in the daemon can
  currently tell console noise from program output.
