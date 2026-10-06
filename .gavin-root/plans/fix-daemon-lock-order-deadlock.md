---
title: [fix] daemon deadlocks: a guard held across the session screen lock
status: In Progress
priority: urgent
---
Every terminal tab came up blank and a fresh shell never printed its prompt. Cause, measured on the live dev daemon (v57, up 5.5 days) with `sample` and an lldb register probe: an ABBA deadlock between the PTY pump and two other paths, in `crates/daemon/src/server.rs`.

- `failure_verdict` writes `if let Some(gap) = manager.slept_mid_turn.lock().unwrap().get(id).copied() { .. } else { failure_on_screen(..) }`. Edition 2021 keeps the `slept_mid_turn` guard alive through the `else`, so the idle timer holds it while it waits for the session's screen lock. The pump holds that screen lock across feed-then-forward and then locks `slept_mid_turn`: opposite order.
- `resize_session` writes `if let Some(screen) = self.screens.lock().unwrap().get(id) { screen.lock().unwrap().set_size(..) }`, holding the `screens` map lock while it waits on a screen lock. `attach -> write_snapshot` needs that map lock, so the app's streaming connection stalled behind it, and `Attach`, `Snapshot`, input and resize all queued behind it.
- `attach` and `failure_on_screen` already do it right: the lookup is bound to an owned value in its own `let`.

Evidence (all six threads in `psynch_mutexwait`, each owner another stuck thread): idle timer holds `slept_mid_turn` and wants screen; pump holds screen and wants `slept_mid_turn`; `resize_session` holds the `screens` map and wants the screen; the app's `attach` wants the map.

## Plan
- [x] Failing test: `failure_verdict` must not hold `slept_mid_turn` while it waits for a screen lock (`a_failure_verdict_does_not_hold_the_sleep_marks_while_it_waits_for_the_screen`, red before the fix)
- [x] Failing test: `resize_session` must not hold the `screens` map while it waits for a screen lock (`a_resize_does_not_hold_the_screens_map_while_it_waits_for_a_screen`, red before the fix)
- [x] Fix both by binding the lookup to an owned value in its own `let` (the convention `attach` already follows)
- [x] Audit the family: every `if let` / `match` / `while let` / `for` scrutinee that locks, in the daemon crate, whose body takes another lock
- [x] Daemon tests green (`cargo test -p gavin-daemon`, 1013 in the bin plus every other target); nothing committed until asked
- [ ] Human test: after a daemon rebuild and restart, terminals paint on app launch with agents running

## Found by the audit, not changed
Same defect class, not on the deadlock's evidence path, and neither closes a cycle with the pump (the pump takes neither lock under the screen lock). Left out so this fix stays the two proven sites; each wants its own card.
- `attach` (`match self.registry.lock().unwrap().queued_inputs_for(id) { Ok(..) => write_message(&mut *writer.lock()..) }`): holds the daemon-wide registry lock across a socket write, which the comment at the top of `attach` says never to do. A client that stops draining stalls every request that needs the registry.
- the input path that acknowledges a failure on screen (`acknowledged_failures` is held, and the `failure_patterns` guard temp lives through the `and_then` closure, while the closure waits on the screen lock): holds two daemon-wide maps while it queues for one session's screen. A busy screen delays every idle timer's `failure_on_screen`.
