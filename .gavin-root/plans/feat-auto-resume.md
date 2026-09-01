---
kind: plan
title: "[feat] auto-resume an interrupted run"
status: To Do
priority: medium
---
The unattended half of `.gavin-root/plans/bug-agent-connection-failure.md`.
That card makes a broken agent visible and gives the human one press to resume
its conversation. This one asks what gavin may do *without* being asked, so
that a rail started before you close the laptop is still making progress when
you open it again.

Strictly downstream of it. Without failure detection there is nothing to
trigger on, and without conversation resume (Root 3 there) an automatic retry
is a from-scratch second attempt — the exact bug
`.gavin-root/plans/archive/bug-interrupted-agent-runs.md` exists to prevent,
only now firing on its own. Do not start this card first.

## What it triggers on is the REASON, not the failure

Auto-resume is not "retry when something broke". It is decided per cause, and
two causes must never trigger it:

- **auth expiry** — the agent wants a login. Resuming loops against a wall.
- **the agent crashed** — not a connection failure. Nothing suggests a second
  run behaves differently, and the transcript may be why it died.

One is time-based rather than event-based:

- **usage-limit exhaustion** — the wait is until a reset, not until the network
  returns. The CLI usually prints the reset time; wait it out or parse it, but
  do not hammer the boundary.

The rest are the real targets, because their cause is external, transient, and
observable when it clears: suspend plus a network change, a Wi-Fi or VPN drop,
an API outage or a run of 529s.

This is a hard dependency on the other card's Root 2. If it lands only a
boolean "failed" on the session, this plan is blocked until it is widened —
re-deriving the reason a second time here would mean two detectors that can
disagree. Say it there rather than working around it here.

## The trigger

Per cause, and never a bare timer — a timer that fires while the network is
still down spends the budget below on nothing:

- **suspend** — the wake gap detector (Root 1a there) IS the event.
- **network** — reachability restored.
- **outage** — only observable by trying, so bounded backoff and nothing else.

Reachability is a gate, not a guarantee: reachable does not mean the API is up.
It earns the right to try; it never predicts success.

## Parallel steps are the hard part

A stage holding two or more steps is a group, and `parallel` is the DEFAULT
(`stageMode`, `app/src/lib/orchestration.ts:63`): its steps run at once in the
rail's checkout. `detectConflicts` already reports that as `same-worktree` and
says the quiet part out loud — "A PARALLEL stage IS a same-worktree conflict by
construction ... That is intended, and saying so out loud beats pretending it
is safe" (`orchestration.ts:1820`).

One interruption fails every step in the stage at once, and they all become
resumable in the same instant. Four problems that simply do not exist with a
single step:

1. **Every resumed agent believes the worktree is as it left it.** In a normal
   parallel run the agents interleave from the start and their edits arrive
   gradually. On resume each one returns holding a transcript describing the
   checkout as of the moment *it* was cut off — while its siblings kept editing
   right up to that same moment. The staleness is per-agent and invisible to
   each of them. This is strictly worse than the conflict `detectConflicts`
   already warns about, and it is why auto-resume cannot be "press Resume N
   times".
2. **Thundering herd.** N agents hitting the API the instant a flaky network
   returns is the most reliable way to spend the retry budget at the one moment
   least likely to succeed. Stagger with jitter, and read an immediate second
   failure as evidence the network is not actually back rather than as a second
   independent failure.
3. **Partial success.** Three of five come back and two do not. The rail is now
   half alive, and no rule in `nextActions` describes that state. Decide the
   unit: a stage resumes as a whole or not at all is the simpler contract and
   probably the right one.
4. **There is no order inside a parallel stage** to sequence by. If staggering
   is wanted, position order is arbitrary but stable, which is enough.

A `sequence` group is the easy case: at most one of its steps was running, so
it reduces to the single-step problem.

Do **not** resolve problem 1 by serialising a parallel stage on resume. The
human chose parallel; quietly converting it to a sequence during recovery
changes what their rail means. If a parallel stage cannot be resumed safely,
say so and leave it stalled — that is today's behaviour, so it is not a
regression, and a human who wants it anyway still has the button.

## Standalone sessions

A rail is not the only thing that runs an agent, and the four launch sites do
not want the same answer:

- **Card runs** (`launchCard`, `app/src/lib/cardRunActions.ts`) — a card bound
  to a session with no rail driving it. These want auto-resume as much as rail
  steps do and are far simpler: no stage, no siblings, no shared checkout
  beyond whatever the human already had. **Do these first** — they are the
  whole feature at one-step scale, and everything learned here transfers.
- **Hidden commit runs** (`app/src/lib/gitState.ts`) — headless, they exit, and
  `adoptAgentCommits` already tolerates a repeat because the prompt is "commit
  pending changes" and re-running it is harmless (the archived card says so in
  as many words). These want a plain RETRY. Do not build resume plumbing for
  them.
- **Rail steps** — the case above.
- **Terminal sessions the human started themselves** — someone typed `claude`
  into a gavin terminal. Gavin minted no conversation id for it and has no
  business resuming it. It still gets the truthful status the other card gives
  it, and nothing further.

Which yields the scoping line for the whole feature: **gavin auto-resumes
exactly the runs it launched and holds a conversation id for.** Everything else
gets the notification and the manual button.

## Two resumes of one session is its own bug

Separate from the parallel-stage problem above, and worth building first
because it is cheap: nothing may fire a resume for a session that already has
one in flight. cmux hit this hard enough to build
`Sources/AgentResumeLaunchGuard.swift` for it (their issue #8446) — a TTL'd
claim per `(agent kind, session id)` that a caller must win before launching,
so "two panels in the same restore pass" never both fire
`claude --resume <id>`.

Gavin has at least three ways to double-fire, and auto-resume adds the worst
of them:

- the automatic resume landing at the same moment the human presses the manual
  button — the new one, and the likeliest, since the notification that prompts
  the human arrives exactly when the trigger fires;
- a card binding and a rail step pointing at one session;
- a startup reconciliation pass racing a live trigger.

Copy the two judgements cmux wrote down, because both are non-obvious. The
claim must **expire** rather than persist: a permanent claim blocks a
legitimate resume of the same session later, when the agent really has exited.
And it must be **releasable early**, for the caller that takes a claim and then
fails to launch.

## Consent, budget, and the trail

- **Consent is given in advance, per rail.** The standing objection to
  auto-resume is that a rail resuming itself six hours after the human walked
  away has made a decision that was theirs. A per-rail opt-in dissolves it:
  they made that decision, in advance, for that rail. `Rail` already carries
  optional fields added after the fact — `branch?` is documented as "optional
  on the wire and absent on plans written before it"
  (`orchestration.ts:87`) — so follow that shape, defaulting OFF. A
  workspace-level default for new rails is a reasonable second step, not the
  first one.
- **One attempt.** At most one automatic resume per run. If the resume itself
  fails, stall and stop. No exponential ladder, no second wind.
- **The budget must be persisted** — on `StepRun` (`orchestration.ts:126`) or
  its card equivalent, never in memory. An in-memory counter resets on every
  app reload and daemon restart, which are precisely the conditions this
  feature runs under, so an in-memory budget is an unbounded loop wearing the
  costume of a limit.
- **Check the work is not already finished before resuming.** An agent can
  complete its edits and die before reporting them. `deadSessionAction` already
  ranks a card that reached the done column above the exit; apply that test
  first and mark the step done instead of resuming it. Re-running finished work
  is the failure mode this entire family of cards exists to stop.
- **Never auto-resume a session that was `waiting_for_input`.** It was asking a
  human a question. It still is.
- **Every automatic resume is visible afterwards.** A resume that leaves no
  trace is indistinguishable from a step that never failed. The step, the card
  and a notification must all be able to say "this died at 09:14 and was
  resumed at 14:22". Coming back to a green rail, you need to be able to find
  out that it was not green all along.

## Out of scope

- **Keeping the machine awake.** A `caffeinate`-style hold for the duration of
  a running rail is prevention rather than recovery, and its own card.
- **Resuming anything gavin did not launch.**
- **Cross-machine resume.** The transcript is on this disk.

## Checks

`cargo test --workspace`, then `cd app && npm test && npm run check && npm run
build`. The daemon's `gavin::tests` are flaky under full-suite cargo
parallelism — re-run that module alone before calling a failure a regression.

The trigger table and the budget are pure logic and belong in `.ts` modules
with unit tests. What the suites cannot reach is the thing this card is for:
start a two-step PARALLEL stage, close the lid mid-run, open it on a different
network, and watch what actually happens to both steps and to the checkout they
share.

## Steps

- [ ] Land `bug-agent-connection-failure.md` first, including a failure REASON
      on the session rather than a bare failed flag
- [ ] Write the per-cause trigger table (resume / wait for reset / never) as a
      pure function with unit tests
- [ ] Persist an attempt counter on the run row, so the budget survives a
      reload and a daemon restart
- [ ] A TTL'd resume claim per (agent, session id), releasable early, so
      nothing double-fires a resume — build this before any trigger
- [ ] Auto-resume for standalone CARD runs only: one step, no siblings, opt-in
- [ ] Reachability gate plus jittered stagger, reading an immediate second
      failure as "not actually back"
- [ ] Per-rail opt-in field on `Rail`, defaulting off, optional on the wire
- [ ] Rail steps in a SEQUENCE stage — the single-running-step shape
- [ ] Rail steps in a PARALLEL stage: resume the stage as a unit or not at all,
      and leave it stalled when it cannot be done safely
- [ ] Plain RETRY (not resume) for hidden commit runs
- [ ] The audit trail: on the step, on the card, in the notification
- [ ] Manual pass: two-step parallel stage, lid closed mid-run, reopened on a
      different network
