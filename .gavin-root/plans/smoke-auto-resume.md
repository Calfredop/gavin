---
title: [smoke] auto-resume an interrupted run
status: To Do
priority: medium
---
The eleven-item manual pass for `.gavin-root/plans/feat-auto-resume.md`,
split out because it is the owner's to run and the parent card is otherwise
finished. The canonical item texts and hints live in the app, under
`smokeChecklist.ts` → "Auto-resume an interrupted run"; this card is the
running order and the state.

## Before any of it: restart the daemon

Every auto-resume surface reads blocked until this is done, and all eleven
items fail the same way if it is skipped.

`FEATURE_MIN_VERSION.autoResume = 22` is a hard gate: a v21 daemon drops the
budget field, which turns one attempt into an unbounded loop, so the app
refuses rather than risking it. The daemon binary on disk was rebuilt at
15:15 on 2026-09-02 and carries v22; the running process started at 14:42,
before that build. So the "Restart daemon" CTA will actually work this time —
unlike the stale-binary case, where tauri dev had built the daemon once at
startup and the CTA was a silent no-op.

Confirm it took: a rail's Auto-resume button and the Settings checkbox both
become pressable.

## Breaking a connection on purpose

Point the agent at an unreachable `ANTHROPIC_BASE_URL` mid-turn. It is the
reproducible version of pulling the network, and it produces the same
`API Error:` line on the rendered screen that the real thing does.

For the causes that must NOT resume, the evidence is different: an expired
token needs an agent actually asking for `/login`, and the profile's
`failure_causes` table puts the auth rows FIRST precisely because Claude
Code's login line also contains `API Error:`.

## Order

Cheapest first, and each one earns the next.

- [ ] `auto-resume-off-by-default` — pure UI, no agent, no broken network.
      Proves the restart took and that consent defaults off on both surfaces.
- [ ] `auto-resume-card-run` — the whole feature at one-step scale.
- [ ] `auto-resume-keeps-context` — the point of the card. A resume that
      quietly starts over is the from-scratch second attempt wearing a better
      name.
- [ ] `auto-resume-notifies` — same run, no extra setup.
- [ ] `auto-resume-trail-on-card` — same run again, then reload the window.
      The times are in memory and the COUNT is persisted, so the line gets
      shorter but must not vanish.
- [ ] `auto-resume-only-once` — break the SAME run a second time. If it
      resumes again, the budget is not surviving the write.
- [ ] `auto-resume-never-on-login` — the first item that needs a different
      kind of break.
- [ ] `auto-resume-rail-sequence` — first rail item; needs a rail with its
      own Auto-resume on. Watch the rail come back, not just the step: a
      resumed step on a paused rail would finish and advance nothing.
- [ ] `auto-resume-parallel-stalls` — the deliberate refusal.
- [ ] `auto-resume-commit-retry` — a retry, not a resume. Check that an
      ordinary refusal (`no user.email`) does NOT re-run.
- [ ] `auto-resume-lid-closed` — last, because it is the only one that needs
      a real suspend and a different network. Report what actually happened,
      including anything the design did not predict.

## What the pass is actually for

The static pre-flight on the parent card confirmed every one of these has an
implementation behind it, so this is not looking for missing code. It is
looking for the two things no grep reaches: whether a real suspend plus a
network change produces the reasons the trigger table expects, and what
actually happens to the checkout two parallel agents share.
