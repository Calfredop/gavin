---
kind: task
title: "[bug] an interrupted agent run silently restarts from scratch"
status: To Do
priority: high
---
Every agent gavin launches — a rail step, a card Run from the board, a hidden
commit run — is a PTY whose command has the whole prompt baked into it. When the
daemon dies and comes back it re-runs that command, so the "recovered" agent is a
second, from-scratch attempt at the same work, in a checkout that already carries
the first attempt's edits. No surface in the app can tell that apart from a run
that never stopped.

Fix the recovery flow itself, then make each surface that watches a run say what
happened.

Scope: the deliberate Pause/Resume path is fine and is not what this card is
about, and a laptop sleeping is fine too — both processes suspend and the PTYs
survive. The broken cases are the ones where sessions are killed underneath the
app: a power cut, a hardware or OS restart, and the "Restart daemon" button the
app itself tells people to press after a protocol bump.

Read `docs/superpowers/specs/2026-08-21-orchestration-tab-design.md` §4.3
(Start/Pause/Resume) and §4.5 (Restart reconciliation) before starting. §4.5 is
the rule this work extends: it was written for the app dying while the daemon
lived, and it does not cover the daemon dying too.

## Root 1 — `recover` re-runs the command

`SessionManager::recover` (`crates/daemon/src/server.rs`) re-spawns every
non-`Exited` session with the command stored in the registry
(`crates/daemon/src/registry.rs`; `create_session` persists it). For every agent
gavin starts that command is the entire task: `buildRunCommand`
(`app/src/lib/cardRun.ts`) builds `<agent> '<the whole prompt>'`, and
`buildHeadlessCommand` is the same shape for a hidden run. The session keeps its
id and is flagged `restored`.

`adoptAgentCommit` (`app/src/lib/gitState.ts`) is the only place in the codebase
that acknowledges this today: it notes that an adopted run "may literally be a
second `claude -p 'Commit …'`" and tolerates it, because repeating that one
prompt is harmless. Repeating a card's task prompt is not.

The PRD already states the accepted behaviour after a device restart — restoring
workspace, layout and cwd "with a fresh shell" (its Out of scope section). Re-
running the command is not a fresh shell. So: recover an agent session to a bare
shell in the same cwd, or mark the record so `recover` skips its command. Either
way a plain terminal session must still come back exactly as it does today, and
true process reattachment stays out of scope — nothing here should try to resume
an agent's conversation.

## Root 2 — a killed session leaves a lying registry row

Every registry row is a snapshot from a previous daemon lifetime, and `recover`
trusts it. Nothing marks a row as "its process died with the last daemon": the
`status` column still reads `Idle` / `Running` / `Asking`, and the `restored`
flag is set only *after* a successful respawn, so it cannot speak for a row that
was killed and not brought back. The daemon cannot tell a session it is still
hosting from one that was killed, and neither can the app.

The ways sessions get killed all land here:

- **Power cut, hardware restart, OS update reboot** — everything dies at once and
  every row is stale.
- **A protocol bump**, where the app tells the human to press "Restart daemon" in
  Settings. `kill_running_daemons` (`app/src-tauri/src/daemon.rs`) runs
  `pkill -x gavin-daemon`. The daemon installs no signal handler
  (`crates/daemon/src/main.rs`), so SIGTERM terminates it without unwinding and
  `Drop for PtySession` — the one thing that explicitly kills a child — never
  runs.
- **An app hard restart or force quit** leaves the daemon alone, so sessions
  genuinely do survive. That is the case §4.5 already handles; keep it working,
  and keep it distinguishable from the two above.

Three things to settle:

- **Do the PTY children actually die when the daemon is killed?**
  `restart_daemon`'s own doc comment (`app/src-tauri/src/session.rs`) asserts
  they "die with the daemon", but nothing in the daemon enforces it — it rests on
  the PTY master closing and the kernel's SIGHUP reaching a child that may or may
  not be a session leader and may or may not ignore it. Verify it under a temp
  `$HOME`. If an orphan can survive, `recover` must not spawn a second agent
  against the same checkout: two agents editing one worktree is the worst outcome
  in this whole family, and it is behind the button the app tells people to
  press.
- **Give recovery an explicit epoch.** A generation counter per daemon lifetime
  (or a clean-shutdown marker) lets `recover` state "this row is from a previous
  lifetime, its process is gone" rather than leaving every consumer to infer it,
  and gives the surfaces below a signal they can trust. Whatever shape it takes,
  it must distinguish *killed* from *still hosted* — that is the distinction the
  whole card rests on.
- **Correct the doc comment.** `restart_daemon` says recovery "spawns a FRESH
  shell per surviving registry record". It does not; it re-runs `record.command`.
  Whichever way Root 1 is resolved, make the comment and the code agree — the
  app's user-facing warning about restarting is built on the comment's version.

Latent trap worth closing while you are in there: `create_session` spawns in
`cwd` while `recover` spawns in `workspace_path`. The app passes the same value
for both today (`app/src-tauri/src/session.rs`), so recovery lands in the right
directory by coincidence rather than by design, and `Attach` reports `record.cwd`
regardless. Make recovery use `cwd`.

## The shared signal

`restoredSessionIds` already reaches the frontend on Attach
(`Response::SessionRestored` → `layoutState.restoredSessionIds`), and today
exactly one thing reads it: the ↻ badge in `Pane.svelte`. Make it — or whatever
Root 2 replaces it with — the signal every surface below consults. A restored
session is not the run it used to be.

Both liveness checks in the app read the persisted **layout tree**, not the
daemon's session list: `liveSessionIds` in `runTick`
(`app/src/lib/orchestrationState.ts`) and `findSessionLocation` behind the
board's checks. So reconcile the layout against the daemon at startup too, and
clear a tab whose session the daemon does not have. That also closes the "a tab
id in a layout tree with no session behind it renders as a terminal" hole.

## Surface 1 — rail steps

A rail comes back `running` on the same stage with its step still `running` on
the same session id; the restored session is back in the layout, so the scheduler
sees a live session and waits. Orchestration never reads `restoredSessionIds` —
zero references in `orchestration.ts` and `orchestrationState.ts`.

A `running` step whose session was restored should take a `stall` with a reason
of its own ("interrupted, the daemon restarted"), which rule 5 turns into a
paused rail. That puts the decision in front of the human instead of silently
re-running work, and Resume already retries a stalled step (rule 2) for whoever
wants exactly that. The rule belongs in `nextActions`; the executor stays dumb.

Second, narrower hole in the same place: a session `recover` could **not**
respawn (workspace path gone, or the spawn failed) is marked `Exited`. Attach
then sends no `StatusChanged` and no exit event for it, so its tab stays, the
step sits `running`, and no rule can ever correct it — the wedge §2.2's guard
describes, leaving the rail uneditable and undeletable. The startup
reconciliation above is what fixes this one.

## Surface 2 — standalone card runs

`launchCard` (`app/src/lib/cardRunActions.ts`) binds the card to its session with
`linkCardSessionAction` and leaves the card In Progress. Nothing unlinks a
binding automatically: `unlinkCardSessionAction` has exactly one caller, the
Unlink button in `CardDetailModal.svelte`.

Every "is this card busy?" check goes through `findSessionLocation` over the
layout tree, so a restored session reads as the original still running: Run and
Resume both jump to it, and Develop refuses with "This card has a live agent".
Meanwhile `resumeCard` — the same launch with `composeResumeTaskPrompt`, backed
by the gavin-resume skill — is precisely the right response to an interruption,
and nothing routes to it, because the binding never looks broken.

So: a card whose bound session was interrupted must stop reading as a live run.
Say so where the run is visible (the board card and the card detail modal) and
offer Resume rather than a jump. The card's status is the human's record — do not
move it on the board.

## Surface 3 — hidden commit runs

`adoptAgentCommits` (`app/src/lib/gitState.ts`) already handles a restart
deliberately and its tolerance is correct; leave that judgement alone. But once
recovery stops re-running commands, a restored commit session is a bare shell
that will never exit, and `watchAgentCommit` would wait on it forever. Adopt
against the interrupted signal instead and drop the record without a verdict,
exactly as it already does for a run whose session is gone. Its existing tests in
`gitState.test.ts` cover the shape — extend them rather than rewriting them.

## Constraints

- Never `pkill gavin-daemon` — it is shared and long-lived. Verify daemon
  behaviour under a temp `$HOME`, which gets its own socket and databases; that
  is also where the orphan question above gets answered.
- A protocol change needs its `min_version_for` entry. If it widens an existing
  request rather than adding one the compat gate cannot see it: that needs a
  `FEATURE_MIN_VERSION` entry in `app/src/lib/daemonCompat.ts` **and** a
  `featureBlockedReason` consumer on every UI surface that can produce the
  payload.
- Logic goes in the pure `.ts` modules with unit tests; the `.svelte` files stay
  thin templates over them.

## Checks

`cargo test --workspace`, then `cd app && npm test && npm run check && npm run
build`. The daemon's `gavin::tests` are flaky under full-suite cargo parallelism
— re-run that module alone before calling a failure a regression.

Beyond the suites, the recovery paths need a real kill under a temp `$HOME`: run
an isolated daemon, start a session with a command, kill the daemon the way
`kill_running_daemons` does, restart it, and check what came back — the process,
its cwd, its registry row, and whether anything was orphaned.
