# Unattended auto-resume

The unattended half of failure detection. v21 taught gavin what a broken
agent is and gave the human one press to reopen its conversation; this is
what gavin may do *without* being asked, so that a rail started before the
lid closed is still making progress when it opens again.

Strictly downstream of `2026-09-02-agent-failure-detection-design.md`:
without the failure REASON there is nothing to trigger on, and without
conversation resume an automatic retry is a from-scratch second attempt —
the exact bug `bug-interrupted-agent-runs` exists to prevent, only now
firing on its own.

## The trigger is the REASON, not the failure

"Retry when something broke" is the wrong feature. The decision is per
cause, and the causes want opposite answers:

| Cause | What gavin does | Why |
| --- | --- | --- |
| suspend | resume | the wake-gap detector IS the event; it has already fired |
| network | resume when reachable | the connection died and coming back is observable |
| outage (529) | resume after a bounded backoff | nothing to observe; trying is the only probe |
| usage limit | **hold** | the wait is until a reset, not until a network returns |
| auth expiry | **never** | resuming loops against a login prompt |
| crash | **never** | a second run would not behave differently |
| unknown | **never** | a cause gavin cannot name is not one it acts on |

`hold` and `never` are two values rather than one because they are two
different things to tell a human: a usage limit will pass on its own, an
expired token will not pass until somebody does something.

**The reset time is not parsed.** The card allows "wait it out or parse
it"; the measured 429 line carries no time, and inventing a format is the
guess this codebase's posture forbids. Holding satisfies "do not hammer
the boundary" when you do not know where the boundary is. A measured
sample would turn `hold` into a timed resume without changing anything
else.

## Where the cause vocabulary lives

On the **agent profile**, beside `failure_patterns`, as
`failure_causes: &[FailureCausePattern]` — ordered, first match wins.

That placement is the same judgement the patterns took: this is the
agent's own vocabulary, opencode's will differ, and a hard-coded table in
the app becomes a silent regression the day a CLI rewords its errors. A
profile with no rows classifies every failure as `unknown`, which never
resumes — today's behaviour, and the honest default.

**The order is load-bearing.** Claude Code's expired-token line is

```
Please run /login · API Error: 401 OAuth token has expired. Please run /login
```

which carries the generic `API Error:` marker as well as `/login`. The
auth rows come first, and `failure_causes_travel_with_patterns_and_put_auth_first`
pins that against the real line rather than trusting the comment.

The one reason gavin writes itself — a suspend — has no profile behind
it, so `autoResume.ts` matches `SLEPT_REASON_PREFIX` before consulting the
table. Both sides carry the literal, and
`the_slept_reason_keeps_the_prefix_the_app_classifies_on` (daemon-side) is
what stops a copy-edit there from silently making every wake-up failure
unclassifiable — the failure mode where the feature goes quiet with every
test still green.

## Consent, budget, trail

- **Consent is given in advance.** Per rail (`Rail.auto_resume`, default
  off, optional on the wire like `branch`) for a rail's steps; per
  workspace (`autoResumeRuns` in config.json, default off) for standalone
  card runs. The split follows what the thing IS: a rail is a durable
  object the human designed and shares with every agent reading the plan;
  a card run is an ad-hoc launch from this machine, alongside the
  notification toggles and the close confirm. It is the only setting on
  that screen that defaults off, because it is consent rather than a
  habit.
- **One attempt per run**, persisted on the run row
  (`StepRun.resume_attempts`, `CardSession.resume_attempts`,
  `AgentCommitRecord.retries`). In memory it would reset on an app reload
  and a daemon restart — precisely the conditions this feature runs under
  — which is an unbounded loop wearing the costume of a limit. A fresh
  launch writes 0 (a new conversation is a new run); a MANUAL resume
  leaves it untouched, because bounding the human's own button was never
  the point.
- **The trail** is `resumeAttempts` on the row (durable: a green rail can
  still say it was not green all along) plus an in-memory `resumeTrail`
  carrying the times and the agent's own sentence while the window that
  watched it is open. Surfaced on the step chip, the step card, the card
  detail modal, and an OS notification — and the *skip* is announced too,
  but only to a workspace that opted in: a rail that stalled for a reason
  nobody stated looks identical to one gavin forgot about.

## Parallel stages: a unit of one, or nothing

One interruption fails every member of a stage at once, and they all
become resumable in the same instant. Putting more than one back is
strictly worse than the same-worktree conflict `detectConflicts` already
warns about: each returning agent holds a transcript describing the
checkout as of the moment *it* was cut off, while its siblings kept
editing right up to that same moment, and the staleness is per-agent and
invisible to each of them.

So: **a parallel stage auto-resumes only when exactly one of its members
broke.** Two or more stay stalled with a sentence saying why, which is
today's behaviour and therefore not a regression — and the human who wants
it anyway still has the button, twice. A `sequence` stage runs one member
at a time and needs no case of its own; the same rule covers it.

Deliberately NOT resolved by serialising a parallel stage on resume: the
human chose parallel, and quietly converting it to a sequence during
recovery changes what their rail means.

The burst arrives one push at a time, so the first failure can look
lonely. The decision is therefore re-taken at FIRE time, after the
stagger delay — which is the same mechanism that catches a human pressing
Resume in the meantime, or the card reaching the done column.

## The herd

`staggerDelays` spreads a wave over 20 s with jitter inside each slot, in
position order (arbitrary but stable — there is no order inside a parallel
stage to sequence by, and inventing one would imply a dependency the human
did not write). The herd is not confined to one rail: a laptop opening at
home fails every rail and every card run in the workspace at once.

Reachability (`navigator.onLine`) is a **gate, not a guarantee** — it says
a route exists, never that the API is up. It is checked as late as
possible, and a resume that finds the interface still down re-arms rather
than spending its one attempt. An agent that breaks again within 30 s of
being resumed is read as evidence about the WAVE, not as a second
independent failure: everything still waiting is cancelled.

## Two resumes of one session

`resumeClaim.ts`, after cmux's `AgentResumeLaunchGuard` (their issue
#8446). A TTL'd claim per `(agent kind, session id)` that a caller must
win before launching. Both of cmux's non-obvious judgements are kept:

- it **expires** rather than persisting — a permanent claim would block a
  legitimate resume of the same session later, when the agent really has
  exited;
- it is **releasable early**, for the caller that takes a claim and then
  fails to launch, or the human's own press does nothing for the next
  minute.

Never persisted: a claim describes a launch that is HAPPENING, and nothing
is in flight across an app restart.

The likeliest double-fire is the new one — the automatic resume landing at
the same moment the human presses the button, because the notification
that prompts them arrives exactly when the trigger fires.

## Scope

**Gavin auto-resumes exactly the runs it launched and holds a conversation
id for.** Everything else gets the notification and the manual button.

- **Card runs** — the whole feature at one-step scale. Built first.
- **Rail steps** — `resumeStep` is new: it reopens the step's own
  conversation in its recorded launch cwd, relinks the card binding, and
  un-pauses the rail (rule 5 paused it when the step stalled, and a
  resumed step on a paused rail would finish and advance nothing). It is
  also the human's manual button for a broken step, so automatic and
  manual take exactly the same path.
- **Hidden commit runs** — a plain RETRY, not a resume: a headless run
  exits and holds no conversation, and "commit pending changes" is
  harmless to repeat. The trigger table still applies, read off the
  captured output tail rather than a session status, so an ordinary
  refusal ("no user.email") classifies as unknown and is left alone.
- **Terminal sessions the human started** — gavin minted no conversation
  id and has no business resuming them.

A failure re-baselined on Attach (a reload finding a session that broke
while the window was gone) deliberately does NOT trigger: the previous
status is unknown there, so "never auto-resume a session that was
`waiting_for_input`" could not be honoured — and the human is looking at
the window anyway.

## Wire (v22)

Three widened EXISTING requests: `SetOrchestration` (a rail's
`autoResume`), `SetStepRun` and `LinkCardSession` (the run's
`resumeAttempts`). `min_version_for` gates request TYPES and is
structurally blind to all three, so `FEATURE_MIN_VERSION.autoResume = 22`
is the only gate there is — and it must be a hard one, not a warning: a
v21 daemon drops `resumeAttempts` on the floor, so every resume would read
the budget back as absent, decide the run had never been resumed, and
resume again. Both consent surfaces are disabled with the reason, and the
driver refuses to arm.

`set_step_run` COALESCEs the count (null = leave it alone, so the dozen
transitions that say nothing about the budget do not have to carry it);
`link_card_session` overwrites it, because a card binding is upserted
whole by every call site.

## Left open

- **The reset time for a usage limit** (see above): a measured line would
  turn `hold` into a timed resume.
- **A transcript that ends in a broken turn.** Inherited from the failure
  card: resume was verified against completed turns only.
- **The times in the trail do not survive a reload** — only the count
  does. Persisting them needs another field on the run row, which did not
  seem worth a fourth widened request.
- **The whole downstream half is unverified by any suite**: the trigger
  table and the budget are unit-tested, but a genuine interruption is
  not reachable from vitest. The `Auto-resume an interrupted run` section
  of `smokeChecklist.ts` is what that costs, and its last item — a
  two-step parallel stage, lid closed mid-run, reopened on a different
  network — is the one that matters.
