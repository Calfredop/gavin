---
kind: task
title: "[sec-hardening] On Windows, a pipe shutdown can miss a reader that is about to park, and Shutdown::Write leaves the write half open"
parent: sec-hardening-2026-10-15.md
priority: low
complexity: complex
labels: security, ready-for-agent, windows
---
Part of `sec-hardening-2026-10-15.md`. A hardening note from the 2026-10-15 security audit (run-1), not a finding. Full record: entries 206 and 207 of `results/hardening-all.json` in `~/security-audit-skill/gavin/run-1/`, outside this repo.

## What

Two gaps in the Windows arm of `protocol::transport::Stream`, the named-pipe stream that also backs the in-process pair a Device's connection is served through.

1. **Lost wakeup in `read_ref`.** `shutdown` stores `read_closed` and then calls `CancelIoEx(handle, None)`, which cancels only the I/O already outstanding. `read_ref` checks `read_closed` and then issues `ReadFile`. A shutdown that lands between that check and the `ReadFile` cancels nothing, and the reader then parks on an `INFINITE` wait that only the peer's next write or close ends. On Unix, `shutdown(Read)` makes every later read return 0 at once.
2. **No write-closed state.** `shutdown(Write | Both)` touches nothing on the write side; the doc comment says a pipe has no separate close. So after a shutdown, `write_ref` keeps succeeding, where a Unix socket would fail with `EPIPE`.

## Why

Revocation relies on this shutdown. `shutdown_device_connections` calls `shutdown(Shutdown::Both)` on each of a revoked Device's connections and expects the connection loop to stop. With gap 2 the far end can keep writing replies and pushes into the near end, and through `carry` to the revoked Device, until `remote.rs` next looks at the store (`POLL`, one second). With gap 1 a reader can stay parked past the revocation. Neither has been observed; both come from reading the code against the Unix behaviour the callers were written for.

## Where (lines as of 2026-10-16; re-read before editing)

- `crates/protocol/src/transport.rs:532-537` (Inner): `read_closed` is the only closed flag.
- `crates/protocol/src/transport.rs:711-719` (Stream::shutdown, Windows): stores `read_closed` for Read/Both, then `CancelIoEx(handle, None)`; Write does nothing else.
- `crates/protocol/src/transport.rs:756-822` (Stream::read_ref, Windows): the flag load at 757 (and at 770 in the timeout loop), then `ReadFile` at 803 and `complete(…, INFINITE)` at 804. Only `ERROR_OPERATION_ABORTED` with the flag set is turned into `Ok(0)` (816).
- `crates/protocol/src/transport.rs:440-470` (complete): waits on the operation's event after `ERROR_IO_PENDING`.
- `crates/protocol/src/transport.rs:824-836` (Stream::write_ref, Windows): `WriteFile` at 826 with no closed check.
- `crates/daemon/src/server.rs:3875` (shutdown_device_connections): `conn.stream.shutdown(Shutdown::Both)` on revocation.
- `crates/daemon/src/remote.rs:70` (POLL): the one-second look at the store that ends a carry today.

## Change

1. In `read_ref`, after `ReadFile` reports `ERROR_IO_PENDING` and before waiting, load `read_closed` again (SeqCst). If it is set, `CancelIoEx(handle, Some(op))` on this read's own `OVERLAPPED`, then reap it as `complete` already does for a timeout. With shutdown's store-then-cancel order, either the reader sees the flag or shutdown's cancel finds the pending read. Also return `Ok(0)` for a read that completes with data after `read_closed` is set, so a shut-down stream never hands back bytes. Keep the reaping rule in `complete`'s doc comment: the kernel owns the buffer until the operation has ended.
2. Add `write_closed: AtomicBool` to `Inner`. `shutdown(Write | Both)` stores it; `write_ref` checks it first and returns `io::ErrorKind::BrokenPipe`, the error the pipe-closed branch already produces. Update `shutdown`'s doc comment, which today says the write half has no close.

## Test

Windows-only tests (`#[cfg(windows)]`) in `transport.rs`'s tests module, which the `windows` job in `.github/workflows/ci.yml` runs under `cargo test --workspace`:

- Lost wakeup: a test-only hook (a `#[cfg(test)]` barrier or callback between the flag load and `ReadFile`) parks the reader there; the test calls `shutdown(Both)`, releases the reader, has the peer write one byte, and expects `Ok(0)`. Without the fix the read returns the byte or hangs; give the test a timeout so a hang fails rather than stalls CI.
- Write half: after `shutdown(Write)`, `write_ref` returns `BrokenPipe`; after `shutdown(Read)` alone, writes still succeed.

## Done when

- A shutdown at any point before or during a Windows read makes that read return `Ok(0)`, and a shutdown with Write makes later writes fail with `BrokenPipe`, as on Unix.
- The tests above exist, run in the Windows CI job, and the lost-wakeup test fails before the change.
- The Unix arm is unchanged.
- The checks in CLAUDE.md pass for every part you touched, including the `wasm32-unknown-unknown` check of `protocol` with the `os` feature off, and you commit only your own files.
