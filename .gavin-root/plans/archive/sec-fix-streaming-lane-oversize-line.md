---
order: 55296
kind: task
title: "[sec] A repository's card tree serialized past 1 MiB tears down the desktop's streaming connection, stalls every attached terminal, and Restart daemon brings the same failure back"
status: Done
priority: low
complexity: moderate
labels: security, ready-for-agent
---
Fix a needs-validation lead from the 2026-10-15 security audit (run-1). It is not confirmed: the audit traced it in source but could not observe the Tauri host's relay thread turning the over-long line into the whole-window overlay, because no host build or prebuilt host test could run (the daemon half was observed). The failing regression test below is the proof — write it first and watch it fail. If it already passes before any change, the lead is wrong: record why under a dated "## Comments" heading and move the card to Done with no code change. Fingerprint: `app/src-tauri/src/session.rs:attach_and_relay:oversize-line-tears-down-streaming-lane`.

Full record: `NEEDS-VALIDATION.md` in `~/security-audit-skill/gavin/run-1/`, outside this repo. The audit card is `review-security-audit-2026-10-15.md`.

## What is wrong

The daemon pushes a workspace's whole `.gavin` tree as one `GavinTreeChanged` line on the app's streaming connection, and nothing limits that line's size. A bound repository can push it past `protocol::MAX_LINE_BYTES` (1 MiB) while every card file stays under the scan's 1 MiB per-file cap. Raw frontmatter values such as `labels` are kept at any length, and serde_json writes each control character as a 6-byte `\u00XX` escape. A large enough board of ordinary cards gets there too. Binding the workspace starts the scan with no review gate. In a sandboxed run, one 200,033-byte card produced a 1,200,830-byte line, which the prebuilt debug daemon pushed as soon as `WatchGavinRoot` arrived.

On the host, `read_message` drains the over-long line and returns `Err`, which leaves the stream back in sync. The streaming relay in `attach_and_relay` treats that `Err` as connection loss anyway: it calls `RelayOwner::lost` and breaks, and for the local daemon that emits `daemon-error`, the whole-window overlay. The socket stays open, because the `StreamWriter` thread holds a `try_clone` dup and the unix `Stream` has no shutdown on drop. The daemon sets no write timeout, and each PTY pump writes `Output` synchronously to the attached connection. In the same sandboxed run, a session attached on a connection left open and unread blocked: a 2 MB writer did not finish within 12 s, then finished 4.2 s after reads resumed (2.9 s for a continuously read control). So every terminal attached on the desktop's streaming connection stops draining, and its agent blocks on tty writes.

The overlay's only recovery is a confirmed Restart daemon. That stops the daemon that owns every session's PTY, then `reconnect_swapping` re-sends `WatchGavinRoot` for each rooted local workspace. The fresh watcher's empty change gate pushes the same oversized tree again, and every cold launch does the same. The workspace keeps failing until the card is removed or the binding is changed outside the app. The command lane drains, refuses only that one reply (`LineTooLong`) and keeps its connection; the streaming lane does not. The lower-trust source that matters is a cloned repository bound as a workspace, or a board large enough to trip this by accident.

## Root cause

`attach_and_relay` maps every `read_message` error to `RelayOwner::lost` and stops reading, including the recoverable over-long-line error, which `read_message` raises only after draining the line. `read_message`'s oversize error is a plain `anyhow::bail!`, so a caller cannot tell it from a real loss without matching on text. On the daemon side, nothing bounds the serialized tree before `write_message`, and nothing bounds a single frontmatter value.

## The invariant to enforce

One over-long line costs only that line, never the streaming connection. The relay skips a drained over-long line and keeps reading, as the command lane does. The daemon never writes a `GavinTreeChanged` line it knows no reader can accept: it bounds frontmatter values at parse time and reports an over-cap tree instead of pushing it.

## Trace (lines as of 2026-10-16; re-read before editing)

- `crates/daemon/src/gavin.rs:2296` (build_context): each card under `MAX_SCANNED_FILE_BYTES` (2196) is parsed by `plan_file_info` (96) and `parse_frontmatter` (48), which keep labels, attachments, title, agent and model raw at any length.
- `crates/daemon/src/server.rs:8384` (handle_connection, `WatchGavinRoot` intercept): starts a watcher with the streaming connection's writer and pushes the first tree at once, with no review gate. The host sends it from `watchRootedWorkspaces` (`app/src/lib/core/gavinState.ts:113`) and on reconnect.
- `crates/daemon/src/gavin.rs:2953` (GavinWatcher::rescan_and_push): the tree is built into `GavinTreeChanged` at 2997 and written at 3001 through `protocol::write_message` (`crates/protocol/src/lib.rs:5464`), with no size bound. A fresh watcher's `last_tree` is `None` (2807), so its first scan always pushes.
- `crates/protocol/src/lib.rs:5472` (read_message): a line reaching `MAX_LINE_BYTES` (67) is drained to its newline and the call bails at about 5486, untyped. The stream is in sync again.
- `app/src-tauri/src/session.rs:5411` (attach_and_relay): any `Err` from `read_message` at 5456-5460 becomes `owner.lost(...)` then `break`. No later push is read, including `pty-output`.
- `app/src-tauri/src/session.rs:5376` (report_disconnect): emits `daemon-error` at 5380, the overlay, for `RelayOwner::Local` (5390).
- `app/src-tauri/src/session.rs:5755` (bootstrap): `StreamWriter::spawn(stream_conn.try_clone()?)` keeps a dup of the socket; `crates/protocol/src/transport.rs:157` (unix `Stream`) has no shutdown on drop.
- `crates/daemon/src/server.rs:6325` (spawn_pump): `Output` is written synchronously under the attached connection's writer mutex; no write timeout exists in `crates/daemon` or `crates/protocol`.
- `app/src-tauri/src/session.rs:2956` (reconnect_swapping): Restart daemon (`retryConnect`, `app/src/lib/core/layoutState.ts:1654`) stops the daemon and re-sends `WatchGavinRoot` at 3036, and the same tree comes back.
- `app/src-tauri/src/command_lane.rs:605` (the sibling lane): an over-long reply is matched as `LineTooLong` (756) and the connection is kept.

## What the audit could not observe

- The host relay thread was not executed: no cargo build was allowed and no prebuilt host test covers it. The step from an over-long line to `owner.lost`, `break` and `daemon-error` comes from source only. The daemon side was observed with the prebuilt debug daemon: the 1,200,830-byte line, and the PTY pump stalling on an open, unread connection.
- What the owner sees in the running app: the overlay, frozen terminals, and the overlay returning after Restart daemon and after relaunch.

## Fix

1. **Protocol.** Make `read_message`'s oversize error a typed error (for example `protocol::LineTooLong`, returned through `anyhow` so callers can `e.is::<LineTooLong>()`). Let `command_lane.rs` use it instead of its own copy at 756, if that is a clean swap. The wire is unchanged, so no protocol bump.
2. **Host relay.** In `attach_and_relay`, on `LineTooLong` log the skip with the owner's label and `continue`. Every other error stays a loss. Tell the human once, without the overlay: an `eprintln!` plus a scoped event the board can show as "this board's update was too large to show", if the frontend already has a notice channel to reuse. Do not add a new overlay path.
3. **Daemon bound.** In `parse_frontmatter`/`plan_file_info`, cap each raw string value (title, labels, agent, model, attachments) at a fixed length and count, and set `parse_warning` on a card that was clamped. In `rescan_and_push`, serialize first; if the line would reach `MAX_LINE_BYTES`, do not write it. Log it, report it the way `report_watch_limit` reports a watch limit, and keep `last_tree` unset so a later, smaller tree still pushes. `sec-fix-gavin-walkers-visited-set.md` removes one way to inflate the tree (symlink fan-out); this card covers the rest, so neither waits on the other.
4. A write timeout on daemon writers to an unread app connection is a separate hardening item. It is out of scope here, but note it on the card if the fix makes its absence more visible.

Regression tests, written first:

- `crates/protocol`: beside `an_oversize_line_is_skipped_and_the_next_message_still_reads` (lib.rs:7444), assert the error for the over-long line `is::<LineTooLong>()`. It fails today.
- `app/src-tauri/src/session.rs`: feed `attach_and_relay`, over a fake daemon stream like the existing streaming-connection tests use (for example near `the_streaming_connection_refuses_input_while_the_daemon_is_swapped`, 8166), one line longer than `MAX_LINE_BYTES` then a valid `Output` push. Assert that `pty-output` is emitted and `daemon-error` is not. If no test drives the relay end to end yet, extract the loop's error decision into a function and test that, plus one end-to-end case. It fails today.
- `crates/daemon/src/gavin.rs`: a card whose `labels:` value is 200,000 U+0001 characters yields a `GavinTreeChanged` line under `MAX_LINE_BYTES`, with that card flagged `parse_warning`. And a watcher whose tree cannot fit writes no line and reports why. Both fail today.

## Done when

- The fix enforces the invariant above at the last trusted decision point, not in a caller.
- The regression cases named in the fix are tests in the touched crate or module, and they fail before the change.
- The checks in CLAUDE.md pass for every part you touched. The daemon's `gavin::tests` are flaky under full-suite parallelism; re-run that module alone before calling a failure a regression.
- The regression test fails before the change and passes after it.
- Follow the CLAUDE.md traps that apply: a new SQLite column needs its own `ALTER TABLE`, a widened request needs a compat-gate entry, and you commit only your own files.
- Once the fix is in, file this check with `gavin_request_human(<this card>, "test", …)` using exactly this text: "In a throwaway desktop install, binding a workspace to a scratch repo whose only card has 'labels: ' followed by 200,000 U+0001 characters shows no 'Couldn't connect' overlay, a shell tab printing a counter to a file keeps advancing, and the same holds after Restart daemon and after a quit and relaunch."

- [ ] Human test: In a throwaway desktop install, binding a workspace to a scratch repo whose only card has 'labels: ' followed by 200,000 U+0001 characters shows no 'Couldn't connect' overlay, a shell tab printing a counter to a file keeps advancing, and the same holds after Restart daemon and after a quit and relaunch.

## Comments

### 2026-10-19

Fixed. `read_message` now returns typed `protocol::LineTooLong`; the streaming relay skips it (daemon-request-error banner, not the overlay) and keeps reading; the daemon clamps frontmatter string values/lists and refuses to push a `GavinTreeChanged` that would reach `MAX_LINE_BYTES`, leaving `last_tree` unset so a later smaller tree still pushes.

Out of scope (still true, and more visible now that the lane survives): daemon writers to an unread app connection still have no write timeout, so a stalled reader can still block PTY `Output` pumps. Separate hardening item if pursued.
