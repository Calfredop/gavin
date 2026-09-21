---
order: 11264
kind: task
title: [fix] A bound rail resolves its card's attachments against the root checkout, not the checkout it runs in
status: Done
priority: high
complexity: moderate
attachments: app/src/lib/orchestration/orchestrationState.ts,app/src/lib/cards/cardRunActions.ts,app/src/lib/orchestration/orchestrationState.test.ts,app/src/lib/cards/cardReview.ts
---
**A rail bound to a worktree stalls on any card whose `attachments:` line
names a file that exists on the rail's branch but not in the root
checkout, and when the file exists in both, the agent is told to read the
root's copy rather than the one it is editing.** Found 2026-09-21 in the
jarvis workspace: the rail `m1 packaging review` stalled on its first step
the moment it was started, before any session was spawned.

## The evidence

The rail runs in `C:/Users/calfr/coding/jarvis-m1-packaging-review` on the
branch `m1-packaging-review`, cut from `m1-packaging`. Its first three
steps are review cards written against that branch, and each attaches the
files it reviews:

| card | attachment | in root (`main`) | in the rail's worktree |
|---|---|---|---|
| install-success predicate | `app/src-tauri/src/agent_install.rs` | no | yes |
| uninstall PATH rewrite | `app/src-tauri/nsis-hooks.nsh` | no | yes |
| install failure diagnostics | `app/src-tauri/src/agent_install.rs` | no | yes |

`executeLaunch` (`orchestrationState.ts`, the `resolveAttachmentsForRun`
call) resolves them before spawning. `resolveAttachmentsForRun`
(`cardRunActions.ts`) always passes `workspaceRootPath(workspaceId)` to
`backend.attachmentStatus`, so the host stats
`C:/Users/calfr/coding/jarvis/app/src-tauri/src/agent_install.rs`, finds
nothing, and the step is written `stalled` with

```
Attachment not found: app/src-tauri/src/agent_install.rs — fix or remove it on the card before running.
```

Rule 5 then pauses the rail. The daemon registry holds no session in that
worktree and the daemon log is silent, which is what a stall inside the
launcher looks like from outside. Two lines below the gate the same
function computes `cwd = rail.worktreePath ?? entry.contextFolder` for the
agent, so the launcher already knows the checkout it is about to run in.

The second half is visible in the daemon log for the rails that DID
launch: a session started in `C:/Users/calfr/coding/jarvis-hermes-local`
was handed `\?\C:\Users\calfr\coding\jarvis\docs\plans\28-hermes-local-m1\PLAN.md`,
the root checkout's copy of a file that also exists on its own branch.
The agent reads whatever `main` says and edits what `hermes-local` says.

## The recorded decision, and why it does not hold for a bound rail

Commit `1153eeb` (2026-08-27, "attach files to a card, and hand them to
its agents") chose the root deliberately:

> Relative entries resolve against the WORKSPACE ROOT, never the session's
> cwd. A card bound to a rail runs in a worktree, so resolving
> `docs/spec.md` against wherever the agent happens to start would hand
> two sessions two different files from one card.

`orchestrationState.test.ts` pins it ("Resolved against the workspace
root, not the rail's worktree cwd: one card must hand every session the
same bytes"). No spec under `docs/superpowers/specs` records it; the
commit body is the whole record.

The premise is that the root's bytes are the card's bytes. For a bound
rail the opposite is true by construction: the rail was given a worktree
precisely so that its agent works on a checkout that differs from the
root, and a card placed on it is about THAT checkout. Handing it the
root's copy is handing it a file it is not working on, and a file the
branch added cannot be attached at all. The "two sessions, two files"
case the commit guards against is two rails running one card on two
branches, where two different files is exactly what the human asked for.
A board Run, a Resume from the board, Develop, Best-of-N and the main
agent all run in the root checkout, and for them the root stays right.

## What to do

1. Let the caller name the checkout. Give `resolveAttachmentsForRun` an
   optional root override, or split out a variant that takes one, and keep
   every board-side caller (`cardRunActions.ts` run, resume, develop and
   main-agent paths, `bestOfNActions.ts`) on the workspace root as today.
2. In `executeLaunch`, resolve against `rail.worktreePath ?? workspaceRoot`
   and do it from the same value the `cwd` line uses, so the two cannot
   drift. If the rail's resume path in `orchestrationState.ts` resolves
   attachments too (grep `resolveAttachmentsForRun` there), give it the
   same root.
3. Nothing else should need to move, and say so in the commit body if it
   holds when you check: `attachment_status` (`fileviewer.rs`) classifies
   containment against whatever root it is given and reads
   `extra_contexts` from `.gavin-root/config.toml` under that root, which a
   worktree carries; the sensitive-home refusals are root-independent; and
   `cardContentDigest` (`cardReview.ts`) hashes the raw `attachments:`
   text, not the resolution, so no reviewed card is asked again.
4. Tests, in `orchestrationState.test.ts`: flip the assertion that pins
   `"/ws"` so a bound rail asserts the worktree path, keep one that an
   UNBOUND rail still resolves against the root, and add the case this
   card is about: an attachment that `attachmentStatus` reports present
   under the worktree launches instead of stalling. Update the test's
   comment to carry the new reasoning, since the old one carries the old.
5. Update the comment above the gate in `executeLaunch` and the doc
   comment on `resolveAttachmentsForRun`, which both currently state the
   root rule.

## Verification

```
cd app && npm test -- orchestrationState && npm run check
```

Then in the running app, on the jarvis workspace: Retry the first step of
`m1 packaging review` with the card's `attachments:` line unchanged. The
step must launch a session in `jarvis-m1-packaging-review` whose prompt
lists `\?\C:\Users\calfr\coding\jarvis-m1-packaging-review\app\src-tauri\src\agent_install.rs`.

Work in a detached worktree, not the shared tree; app source files are
CRLF; commit only the files you touched.
