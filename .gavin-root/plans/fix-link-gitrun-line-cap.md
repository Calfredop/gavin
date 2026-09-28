---
kind: task
title: [bug] A large git output on an ssh workspace drops the link's command connection
status: To Do
priority: medium
complexity: moderate
---
Found 2026-09-26 while doing perf-ssh-routes-off-main-thread.md; not fixed there.

`Response::GitRun { stdout: Vec<u8>, .. }` (crates/protocol/src/lib.rs, the
`GitRun` variant) serialises its stdout as a JSON array of numbers — 2 to 4
bytes on the wire per byte of output. The host daemon's `gavin::run_git`
sends the WHOLE stdout (no cap), and `protocol::write_message` writes any
length. The desktop reads with a 1 MiB line cap (`MAX_LINE_BYTES`), so any
host git whose stdout is past roughly 300 KB — a `git diff` of a big file,
a long `git log`, a `git show` of a large commit — fails the read with
"protocol line exceeded". On a link's command lane that error drops the
connection (`command_lane::Worker::round_trip`, the non-timeout arm), and a
link has nothing to redial: every later request on that host answers
"the connection to <host> is closed — reconnect to it" until the human
reconnects. The local runner caps diffs at `MAX_DIFF_BYTES` (2 MiB) only
AFTER the host has sent everything (`git/run.rs` `run_git_capped`).

Latent: no ssh workspace is configured on this machine.

## Fix (sketch)

- Cap on the host: `RunGit` carries the caller's stdout cap (a new request
  TYPE or a new variant, since `min_version_for` gates types — widening
  `RunGit` would be dropped silently by an older host, per CLAUDE.md), and
  the host keeps at most cap+1 bytes, as `run_git_capped` does locally.
- And/or carry stdout as base64 or a string, not a number array.
- Either way, a reply the app refuses for size must not cost the link its
  connection: the rest of the line is still in the socket, so read and
  discard to the newline instead of dropping the connection.

## Verify

A daemon test that a `RunGit` whose stdout is 2 MB answers within the line
cap; a lane test that an over-cap line is skipped and the next request on
the same connection is answered.
