---
order: 5120
kind: task
title: [fix] the fork dialog cannot say why it failed
status: Done
priority: medium
---
`GitForkDialog` reports a failed `git worktree add` only through the Git
tab's error banner. Opened from an orchestration rail's bind dialog — or
from the card detail modal's best-of-N — that banner is not on screen, so
a refusal by git reads as a button that does nothing. Its own comment
says so out loud:

    if (!ok) return; // the error banner shows git's message; keep the dialog

That assumption holds for exactly one of its three callers.

Worse, one failure path says nothing anywhere. `gitState.run()` opens with

    const s = current(workspaceId);
    if (!s || s.busy || s.op) return false;

and returns `false` having recorded no error at all — no banner, no
console, nothing. The dialog then keeps itself open with no explanation.
`!s` is reachable: the fork dialog reads `$gitStore[workspaceId]` without
ever calling `ensureGitView` itself, and HMR re-executing `gitState.ts`
resets that store to `{}` under a dialog that is already open. When it
happens the button stays ENABLED, because `folder` keeps the value the
effect last computed while `root` was known — a live control wired to a
no-op.

This is the second half of the URGENT worktree bug fixed in 6840202. That
one was a real throw with a real cause; this one is the reason nobody
could see it. Fixing it is what keeps the next git refusal from being
filed as "the button is dead".

## What to do

1. Give the dialog its own error line, fed from the git view's `error`,
   shown in the dialog rather than delegated to a banner that may not
   exist. Both `GitForkDialog` and the branch form in `RailBindDialog`
   (`createAndBind` carries the same comment and the same blind spot).
2. Make the silent guard speak. `run()` returning `false` with no `error`
   set is the defect: either record a reason ("another git operation is
   still running") or let callers tell "refused" from "failed".
3. Have `GitForkDialog` guarantee its own git view — `ensureGitView` +
   `refreshGit` on the workspace's gavin root, the way `BestOfNDialog`
   already does, with the same reasoning ("the Git tab may never have
   been opened in this workspace"). That removes the `!s` path instead of
   only reporting it.
4. `submit()` is called as `void submit()`, so a rejection anywhere in it
   disappears. Decide what a rejected `onPicked` should do — at minimum
   it must not silently skip the setup session that follows it.

## Check it

The dialog must be able to state a refusal with the Git tab never opened
in this workspace. Cheapest repro for the disabled-but-dead case: open
the fork dialog from a rail, edit anything in `gitState.ts`'s dependency
cone to make HMR reset the store, then press Create.

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
