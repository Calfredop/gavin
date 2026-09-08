---
order: 2048
title: [fix] server::tests is flaky, and CI will show it
status: Done
---
`crates/daemon/src/server.rs`'s `mod tests` fails intermittently under
full-suite cargo parallelism. Measured 2026-09-07 while adding CI, on
both `feat/multi-os-support` and a detached worktree at `e8111ba`, so it
is not a regression from that branch:

| where | runs | failures |
|---|---|---|
| HEAD (`e8111ba`) | 4 | 1 |
| feat/multi-os-support | 6 | 3 |

A **different test each time**, which is what says it is infrastructure
rather than a bug in any one of them. Seen so far:

- `attach_sends_no_baseline_status_for_a_row_recovery_could_not_bring_back`
  — `client.set_read_timeout(...).unwrap()` on a fresh `UnixStream::pair()`
  panicking with `EINVAL`.
- `resize_session_returns_ok_for_existing_session` and
  `relays_status_changed_when_pty_output_contains_an_osc777_notification`
  — `ConnectionRefused` connecting to a `start_test_server` socket, i.e.
  the connect racing the bind.
- `waiting_for_input_survives_a_full_quiet_period_in_heuristic_mode`,
  `typing_after_a_failure_means_the_next_turn_is_judged_on_its_own`,
  `a_session_that_left_a_process_behind_keeps_its_row_when_its_shell_ends`
  — quiet-period timing under load.

Why it matters now: `.github/workflows/ci.yml` runs `cargo test
--workspace` on every push. At roughly one failure in four runs, a red
build stops meaning anything within a fortnight, and the usual escape —
retrying the whole suite — is exactly the habit that lets a real
regression through. CLAUDE.md already carves out `gavin::tests` for
fs-watcher timing; this is a second, separate family and deserves a fix
rather than a second carve-out.

Two shapes to look at first, both about a test not owning what it waits
on: `start_test_server` should hand back a socket it has already bound
(poll for the file, or bind on the caller's thread), and the
quiet-period tests should not be racing a wall clock against however
many other tests the machine is running.

Worth measuring the failure rate on `ubuntu-latest` too — the 2026-09-07
figures are from an M-series mac, and the Linux container runs were
green (2 full-workspace runs, 0 failures), which may just mean it was
not loaded enough.

## Measured, 2026-09-07

Reproduced in a detached worktree at `114d10a` by running the daemon test
binary directly at `--test-threads=24` on a 10-core machine: **5 of 6 runs
red**, a different set each time. That turned an intermittent report into a
bench, and the bench turned up four distinct causes, none of them a
scheduling excuse. Each one was then confirmed against a standalone probe
rather than inferred from the failure text.

1. **A throwaway `BufReader` per read.** `request()` and `drive_until()`
   each build a fresh 8 KB `BufReader` over the connection, read one line,
   and drop it — taking everything else the same `read(2)` pulled in with
   them. Under load the daemon coalesces a response and a push into one
   write, so the next reader on that connection starts mid-stream. Probe:
   two messages written in one `write_all`, reader #1 reads the first,
   reader #2 sees the *third* — #2 is gone. This is the biggest one: it hits
   every test that reads twice, and a mid-line boundary is exactly the
   `EOF while parsing a value at line 1 column 0` in the report.
2. **`start_test_server` returns before the listener listens.** It polls for
   the socket file, which `bind(2)` creates, while `connect(2)` needs
   `listen(2)` — two syscalls later inside `UnixListener::bind`. Both
   observed `ConnectionRefused`es are the *first* connect after the helper
   returned.
3. **`set_read_timeout` on a socketpair half whose peer is already gone.**
   macOS `setsockopt` answers `EINVAL` once the socket is disconnected, and
   the test sets the timeout *after* handing the peer to `attach()`. Probe:
   `set_read_timeout` after `drop(peer)` → `Os { code: 22 }`, exactly the
   report's panic.
4. **Wall-clock budgets for real process work**, 3s and 5s, spent competing
   with 150 parallel tests spawning their own shells. `shell_echoes` is
   worse than tight: its deadline is only read *between* blocking reads, so
   it bounds a chatty session and not the silent one it exists to catch.

`proc::tests::cpu_time_is_in_the_unit_it_says_it_is` failed in 2 of the 6
runs on the same bench — its floor assumes this thread gets half a core.
Out of the card's title but not out of its point, which is a CI signal
worth reading, so it is fixed here too.

## Checklist

- [x] Bench the flakiness so a fix can be shown to work, not just asserted
- [x] One read position per connection: unbuffered readers in the test module
- [x] Hand `start_test_server` a listener that is already listening
- [x] Set the read timeout before the peer socket is given away
- [x] Budget real-process waits generously, and bound the wait that isn't
- [x] Widen the CPU-share floor in `proc::tests`
- [x] Re-bench: the same 6x24-thread run, green
- [x] Full `cargo test --workspace` in the detached worktree

## Result

Same worktree, same bench, after the fix:

| bench | before | after |
|---|---|---|
| 6 runs @ 24 threads | 5 red | **0 red** |
| 8 runs @ 32 threads | 7 red | — |
| 14 runs @ 32 threads | — | 1 red (see below) |
| 20 runs @ 40 threads | — | **0 red** |
| 10 x `cargo test --workspace` (CI's own command) | ~1 in 4 red | **0 red** |

The byte-at-a-time readers cost nothing measurable: a full run of all 472
daemon tests still takes ~9s.

One failure in all of that was **not** one of the four, and is not claimed
as fixed: a single `CreateSession` answered `Bad file descriptor (os error
9)` out of `PtySession::spawn`. Running out of ptys is `ENXIO`, not
`EBADF` (checked against a standalone `openpty` loop, which stopped at 459
with errno 6), and the peak this process holds is 127 against a
system-wide ceiling of 511 — so it is not the obvious ceiling. It did not
recur in 20 further runs at 40 threads with the three fallible steps of
`PtySession::spawn` individually labelled, so there is nothing yet to name.
1 in 34 runs at 3.2x oversubscription, on a machine shared with a live
daemon and other agents' suites. Worth a card of its own if CI ever shows
it; not worth guessing at now.

Deliberately left alone: `kill_session_answers_without_waiting_for_the_process_to_go`
asserts the reply comes back in under 200ms, against a grace loop measured
at 250-430ms. That margin is thin enough to be the next flake, but widening
it is how the assertion stops meaning anything -- it exists to catch the
grace loop moving back onto the caller's thread. It never fired across ~50
runs here, so it stays as written.
