---
order: 31744
kind: task
title: [fix] The remote pump test sets a read timeout on a socket the pump already closed
labels: bug
status: Done
---
`remote::tests::pump_relays_both_ways_and_ends_when_the_child_closes`
(`app/src-tauri/src/remote.rs`) fails intermittently on macOS: 3 of 4 runs
of the test alone on 2026-09-25. It panics at `remote.rs:1442:70`, the
`unwrap` on

```rust
child_stdin_r.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
```

with `Os { code: 22, kind: InvalidInput, message: "Invalid argument" }`.

## Cause

A race in the test, not in the pump. The test drops `child_stdout_w`; the
pump sees EOF and closes `child_stdin_w`. If that lands before the test
reaches line 1442, `child_stdin_r`'s peer is already gone — and macOS
refuses `setsockopt(SO_RCVTIMEO)` on a socket whose peer has closed, with
EINVAL. The one run in four that passes is the one where the test wins
the race.

## Do

Set both read timeouts (`app` and `child_stdin_r`) BEFORE
`drop(child_stdout_w)`, so no `setsockopt` runs after the pump can close
anything. Leave the assertions as they are. Run the test alone 20 times on
the Mac and report the count.

## Outcome (2026-09-25, branch `merge/origin-main-20260925`)

Both read timeouts now go on before `drop(child_stdout_w)`; the
assertions are unchanged. 20/20 runs of the test alone on the Mac,
against 1 in 4 before.
