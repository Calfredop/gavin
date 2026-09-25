---
order: 30720
kind: task
title: [fix] The pty late-reader test never sees its command exit on macOS
labels: bug
status: To Do
---
`pty::tests::a_reader_taken_after_the_exit_still_reads_the_output_to_its_end`
fails on macOS every run — full suite, module alone, and single-threaded
with `--exact --test-threads=1` — at `pty.rs:1284`, "command did not exit",
after its 10s budget. Seen 2026-09-25.

It is not a merge regression: the test came in with `c19e6d57` (2026-09-22,
"end a session's output stream when its process exits") and `pty.rs` is
identical on local `main` and on the merge of origin/main.

What the test does: `PtySession::spawn` with the command
`printf 'LATE%s-probe\n' MARK` (run as `posix_shell() -c ...`), then polls
`session.try_wait()` until the child is gone. On this Mac it never is, even
though `watch_for_exit` polls `try_wait` on the same child from its own
thread and is meant to close the master once it sees the exit.

## Do

1. Find out why the child is not reported as exited. Either it has not
   exited (blocked on something — the pty, the shell, the environment the
   spawn builds) or it has and `try_wait` does not say so. Say which,
   with evidence, before changing anything.
2. If it is the product — a natural exit on macOS never reaches
   `watch_for_exit`, so the output stream never ends — fix the product and
   keep the test. If it is the test, fix the test. Either way say which it
   was.
3. `c19e6d57` was written for the Windows port and says unix runs the same
   thread. Do not break the Windows behaviour; a Windows re-run is the
   owner's.
