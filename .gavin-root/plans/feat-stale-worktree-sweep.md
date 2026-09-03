---
order: 12288
kind: task
title: Stale worktree sweep
status: To Do
priority: medium
---
Give the Git tab's worktrees section a "Sweep stale" action that lists worktrees Gavin no longer needs and removes them after one confirmation.

Read first: `app/src/lib/gitState.ts` (worktree list and `switchWorktree`), `app/src-tauri/src/git/commands.rs` (`worktree_add`; add the remove beside it), `app/src/lib/orchestration.ts` (a rail's `worktreePath` binding), the sessions store (a live session's cwd), and `dialog.ts` (`askConfirm` — no native dialogs).

A worktree is stale only when ALL hold: its branch is merged into the workspace's base branch; no rail binds it; no live session has a cwd inside it; and `git status --porcelain` in it is empty. A worktree with uncommitted changes is never stale, whatever else is true.

Behaviour:
- Pure logic in `worktreeSweep.ts`: given worktrees, merged-branch set, rail bindings and session cwds, return the stale list with the reason each one qualifies. Unit tests for each disqualifier.
- The action shows the list, asks once via `askConfirm` (button names the action: "Remove N worktrees", `danger`), then runs `git worktree remove` per entry and offers to delete the merged branch in the same confirm as a checkbox default-on.
- The section also shows a small "stale" StatusBadge on each qualifying row, so the human sees them without running the sweep.

Out of scope: any automatic sweeping on a timer or on archive; a cap on worktree count.

Done when: `worktreeSweep.test.ts` is green with all four disqualifiers covered; `cd app && npm test && npm run check` pass; a smoke item is added to `smokeChecklist.ts`.

Borrowed from Cursor's worktree cleanup (2026-09-03 feature scan).
