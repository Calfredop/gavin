---
kind: task
title: A compressed session ended by closing its tab never gets its Headroom savings snapshot
status: Done
priority: high
complexity: moderate
---
Branch `feat/headroom` (headroom-05, d946dd95; still true at c1de88b8). Work in `.gavin-worktrees/feat-headroom`.

## The defect

The savings snapshot is taken in the pump's teardown, guarded by `if manager.was_compressed(&id)` (`crates/daemon/src/server.rs:4376`). `was_compressed` (`server.rs:3107`) reads the session's REGISTRY row and answers false when there is none.

A kill removes that row before the teardown ever runs. `kill_session` (`server.rs:3604`) is `forget_session` (`server.rs:3646`), whose first line is `self.registry.lock().unwrap().remove(id)?`. Only after that does it `retire` the PTY. The pump then sees EOF and runs its teardown, `was_compressed(id)` finds no row and returns false, and `/stats` is never asked. The comment beside the check ("read here, before the reap below forgets the row") holds only for a natural exit.

An interactive agent session almost never exits on its own. It ends with `KillSession`: closing the tab, the page or the workspace, the sessions manager, the Git tab's commit agent, or quitting the app (`layoutState.ts`, `appClose.ts`, `sessionsManagerActions.ts`, `gitState.ts`). So most compressed card runs keep `headroom_tokens_saved` NULL, and run history, the hub's window sum and the lifetime figure all miss them. headroom-05's open human test ("savings on a real run") would fail for the same reason.

There is a second leak on the same path. `headroom.forget(&id)` sits inside the same `if`, so every killed compressed session leaves its `Tracked` entry in `Headroom`'s `compressed` map (`crates/daemon/src/headroom/mod.rs:284`, `forget` at `:339`) for the life of the daemon.

## The case that breaks it

This was run in a detached worktree and fails. Copy `a_compressed_card_run_keeps_what_headroom_saved_it_and_a_plain_one_keeps_nothing` (`crates/daemon/tests/headroom_sessions.rs:830`) and end the session with `Request::KillSession` instead of letting it exit. The card run comes back `outcome: "exited"`, `exit_code: -1`, `headroom_tokens_saved: None`, where the fake Headroom's `per_project` said 41200. The natural-exit original still passes.

## What to do

1. Decide "was compressed" from something the kill does not erase. Either read `Headroom`'s own `compressed` map (every compressed spawn is inserted at `headroom/mod.rs:284`; add a read like `is_tracked(id)`), or capture the bit in `forget_session` before `registry.remove`, and hand it to the teardown.
2. Call `headroom.forget(&id)` for a killed session too, so the map does not grow.
3. Handle the related race. A `CardRuns` read that lands between the kill and the teardown sweeps the row to `abandoned` with `ended_at` NULL (`server.rs:3100`, `kanban.rs:586`). `finish_runs_for_session` then never closes it. A snapshot written onto that row is invisible to `savings_since`, which filters `ended_at >= ?1` (`kanban.rs:552`). Either give `abandon_runs_for_sessions` an `ended_at`, or let the snapshot write set one where it is NULL. Say which you chose, and why, in the commit body.
4. Add the KillSession variant of the e2e test above to `headroom_sessions.rs`, and keep the natural-exit one. Attach first: pumps exist only after an Attach.

Run `cargo test -p gavin-daemon --test headroom_sessions` and the daemon's lib tests. `gavin::tests` is flaky under full parallelism, so re-run that module alone before calling a failure a regression.

## Fixed (2026-09-29, commit `561f5975` on `feat/headroom`)

- The teardown now asks `Headroom::tracks(id)`, which reads the daemon's in-memory list of compressed sessions, instead of the registry row a kill has already removed. The teardown's `forget` now runs for killed sessions too, so that list stops growing.
- The race is handled on the write. `record_savings_for_session` sets `ended_at = COALESCE(ended_at, now)`, so a run abandoned mid-kill keeps its outcome but gets an end, and `savings_since` counts it. Any run that already has an end keeps it. `abandon_runs_for_sessions` is unchanged: the sessions it sweeps were never seen to end.
- Tests:
  - `kanban::tests::a_snapshot_on_a_run_abandoned_mid_kill_gives_it_an_end_and_keeps_every_other_end`.
  - `headroom_sessions::a_compressed_card_run_whose_tab_was_closed_keeps_what_headroom_saved_it`. It waits for the pump's first Output before the kill: a session killed before its pump has a reader never reaches the teardown. It fails against the old registry check (tried) and passes with the fix.
- `cargo test -p gavin-daemon` is green: 876 unit tests, and 27 in `headroom_sessions`.
