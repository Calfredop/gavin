---
kind: task
title: "[bug] a surviving orphan agent is invisible after a daemon restart"
status: To Do
priority: medium
---
`SessionRecord.generation`'s doc comment (`crates/daemon/src/registry.rs`)
says a row from a previous daemon lifetime means "its daemon is gone, and with
it every PTY master it held, so nothing is hosting that session any more".

The first half is a fact; the last clause is an inference, and the work that
wrote it disproved it. `restart_daemon`'s comment
(`app/src-tauri/src/session.rs:695`) states the truth: killing the daemon
reaches a child only as the SIGHUP a closing PTY master sends, "and a child
that ignores SIGHUP survives, reparented to init (verified under a temp
$HOME)". Nothing gavin hosts is running it — the *process* may be very much
alive.

That work took the defensive half and took it correctly: `recover` no longer
re-runs a command, so gavin never spawns the second agent. Do not re-litigate
that. What is still open is the first agent. It keeps running, reparented to
init, editing the checkout, while gavin shows a bare shell in its place and
reports a clean interruption. The human's likeliest next moves — pressing
Resume, or starting fresh work in that worktree — put a second agent in there
after all, by a different route, from behind a button the app itself tells
people to press after a protocol bump.

## Gavin cannot currently check

`grep -rni '\bpid\b' crates/daemon/src` returns nothing. `SessionRecord` holds
id, workspace_path, cwd, command, status, restored, generation and
interrupted — no handle on the OS process at all. The epoch is the only signal
recovery has, and the epoch cannot answer this question even in principle: it
describes a daemon lifetime, not a process.

So capture the pid. `PtySession` already owns the child
(`crates/daemon/src/pty.rs`, `child: Box<dyn Child + Send + Sync>`) and
portable-pty 0.8's `Child` exposes `process_id(&self) -> Option<u32>`. Persist
it on the record at spawn, and at recovery **probe instead of assuming**:

- **the pid is gone** — the epoch's inference was right. Behave exactly as
  today; this must be the common path and must not get slower or noisier.
- **the pid is alive** — an orphan survived. Say so rather than reporting a
  clean interruption.

Guard pid reuse. A pid is recycled, and a recycled one belonging to something
unrelated must never be reported as a surviving agent, let alone killed. Match
on more than the number — the process start time, or its command against
`record.command` — and treat a mismatch as "gone", the safe direction.

Prior art if the shape is unclear: cmux (`https://github.com/manaflow-ai/cmux`)
judges agent liveness by enumerating live processes rather than trusting stored
rows — `Sources/VaultAgentProcessScanner.swift` matches agent argv and pulls
session ids back out of it. Gavin needs none of that machinery, because gavin
launches every agent it cares about and can simply remember the pid. Read it
for the reuse and identity-matching problems it already solved, not for its
architecture.

## Saying it

An orphan the app cannot show is the whole defect, so detection alone does not
close this card.

- The daemon has to report it, which means a protocol change. It widens what
  is said about an existing session rather than adding a request, so
  `min_version_for` cannot see it — the app must treat "no orphan reported" as
  *unknown* on an older daemon, not as *no orphan*, the same trap
  `setupProgress` hit.
- `.gavin-root/plans/sessions-manager.md` is the natural surface and already
  asks for exactly this: a task manager listing sessions "visible and invisible
  ones, with a stale indicator" and a kill action. A surviving orphan is the
  purest case of an invisible stale session. Whichever card lands second should
  reuse the other's work rather than growing a second list.
- Wherever it appears, the human needs to be able to end it, because their
  alternative is hunting a pid in Activity Monitor. Killing another process is
  destructive and outside what the session normally owns, so it goes behind a
  confirm that names what will die.

Worth measuring while you are in there: whether the agents gavin actually
launches DO survive a daemon kill, per profile. If none of them ignore SIGHUP
today the probe is still correct and still cheap, but the finding belongs in
the card either way — and one agent that does survive changes how loudly this
has to be surfaced.

## Constraints

- Never `pkill gavin-daemon`. Reproduce under a temp `$HOME`, which is where
  the original orphan was verified: start a session, kill that daemon the way
  `kill_running_daemons` does, restart it, and check whether the child is still
  alive and what recovery now says about it.
- Correct `SessionRecord.generation`'s doc comment as part of this. It is the
  same defect the archived interrupted-runs card called out one level up — a
  comment asserting more than the code can know — and leaving it is how the
  next reader re-derives the wrong conclusion.

## Checks

`cargo test --workspace`, then `cd app && npm test && npm run check && npm run
build`. The daemon's `gavin::tests` are flaky under full-suite cargo
parallelism — re-run that module alone before calling a failure a regression.

The probe itself needs the temp-`$HOME` experiment above; a unit test can only
cover the reuse guard and the reporting, not whether a real child outlives a
real daemon.
