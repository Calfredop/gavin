---
order: 10240
title: [fix] On Windows a session that exits is never reported as exited
labels: windows
status: To Do
priority: high
complexity: complex
---
**A PTY reader never reaches end of stream on Windows when the command in
it exits.** The daemon's output pump has no other way to learn a session
ended, so on Windows a session that finishes by itself is never reported
as finished. Found 2026-09-11 from
[feat-windows-port-on-a-windows-machine](./feat-windows-port-on-a-windows-machine.md)
§1, while working out why the daemon suite hangs
([fix-daemon-suite-deadlocks-on-windows](./fix-daemon-suite-deadlocks-on-windows.md)
is the same root cause seen from the suite's end).

## The evidence, two tests in one file on one machine

- `pty::tests::the_tool_failure_epilogue_prints_and_re_raises_the_code`
  **passes**: `try_wait` returns the child's exit code, so the daemon
  CAN see the process is gone.
- `pty::tests::a_readers_stream_ends_when_the_command_does` **fails**:
  `read_to_end` on the master never returns after the same kind of
  command exits — twenty seconds, in isolation, nothing else running.

That test was added by the windows-port card and is written to fail
rather than hang, so this reproduces in one command:

```
cargo test -p gavin-daemon --bin gavin-daemon -- a_readers_stream_ends
```

It passes on unix, where closing the slave gives the master EOF. On
Windows the master is a ConPTY whose output pipe is also held by
`conhost.exe`, and the child exiting does not close it.

## Why that is the whole story rather than a detail

`server.rs`'s pump is:

```rust
loop {
    match reader.read(&mut buf) {
        Ok(0) => break,
        ...
        Err(_) => break,
    }
}
```

`Ok(0)` is the only non-error way out, and `exit_code_for` — the one
`try_wait` call in the file (server.rs:3213) — runs **after** that loop,
so it is never reached. There is no reaper polling session liveness
anywhere else.

Everything downstream of the loop is therefore dead code on Windows for
a natural exit:

- `finish_tool_runs_for_session(&id, Some(exit_code))` — so **a
  `command` or `script` tool's exit code never becomes its verdict**,
  and the comment there ("the code IS the verdict ... nobody has to have
  been watching") is exactly the promise that is broken.
- `Response::SessionExited` to the attached writer — so **a rail step
  never completes**.
- `forget_session` — so every finished run stays in the task manager.
- Dropping the screen model — "by far the largest thing the daemon holds
  per session" — so it leaks for the daemon's lifetime.
- The pump thread itself never returns.

Those last three are visible in the suite's hang: 200+ threads, ~35
unreaped `sh.exe` + `conhost.exe` children, zero CPU.

**The suite names it.** `cargo test -p gavin-daemon` hangs on Windows,
and when it is re-run at `--test-threads=4` — few enough that neither
memory pressure nor scheduling is a candidate — it still hangs, with one
test left running:

```
server::tests::attach_never_sends_a_baseline_status_changed_for_an_exited_session
```

A test that waits on a session EXIT, on a platform where an exit is
never reported. See
[fix-daemon-suite-deadlocks-on-windows](./fix-daemon-suite-deadlocks-on-windows.md)
for how that was narrowed, and for the 22 `server::tests` failures that
are a separate question.

`kill_session` is unaffected — it closes the pty, which does give the
reader its zero — which is why killing a tab works on Windows and only
self-ending sessions are lost. That is also why this was not caught
sooner: the interactive paths a human exercises all end in a kill.

## Fix

- [ ] Decide the mechanism. Two shapes, and the second is probably
      right:
      - Close the pseudoconsole when the child exits, so the existing
        EOF arrives. portable-pty owns the `HPCON`; this may not be
        reachable without changing how `PtySession` holds the master.
      - **Stop making EOF the only signal.** Wait on the child (a thread
        per session, or one reaper) and have that end the pump — the
        pump already has to survive `kill_session` closing the pty
        underneath it, so it already tolerates being ended from outside.
        This is also the portable answer: it behaves identically on unix
        rather than adding a `cfg`.
- [ ] Whichever it is, drain what is already buffered before ending the
      pump. A session's last output — the `[gavin] <tool> exited with
      code N` epilogue, which is the whole point of that epilogue — must
      not be cut off by the exit that produced it.
- [ ] `a_readers_stream_ends_when_the_command_does` is the gate. It
      should pass on Windows without a `cfg` carve-out; if the fix needs
      one, the test should assert the signal the fix uses rather than
      being weakened.
- [ ] Then re-run `cargo test -p gavin-daemon` on Windows and see how
      much of
      [fix-daemon-suite-deadlocks-on-windows](./fix-daemon-suite-deadlocks-on-windows.md)
      goes with it. The 22 `server::tests` failures may be a separate
      problem or may be this one; do not assume either.
