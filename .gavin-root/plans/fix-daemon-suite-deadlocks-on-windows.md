---
title: [fix] 22 server::tests fail on Windows, behind a hang that has its own card
status: To Do
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

- [ ] Re-run after the EOF fix lands and get a real count. Until the
      suite can finish, "22" is a floor, not a measurement — the run
      never reaches the end.
- [ ] Then work whatever survives. `fix-daemon-server-test-flakiness` is
      **Done**, but its bench — 6 runs at 24 threads, 20 at 40, 0 red
      after — was run on a 10-core M-series mac, and the card does not
      mention Windows once. Its four fixes were never measured here, so
      "already fixed" is a claim about another platform.
- [ ] Reproduce deliberately before fixing anything, the way that card
      did: run the test binary directly at a fixed `--test-threads` and
      find where it turns red. A bench is what turned that card from a
      report into four named causes.
