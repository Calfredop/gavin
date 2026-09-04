---
order: 15360
kind: plan
title: [fix] a rail bound to a branch the repo does not have
status: Done
---
A rail on the main checkout bound to `feat/layout-homologation` — a branch
nobody ever created — armed, opened its page with a bare shell, and then
stalled its whole first stage with git's raw stderr:

```
fatal: invalid reference: feat/layout-homologation
```

`launchBlocker` already refuses every other binding that names something
gone — `card file is missing`, `notes are not runnable`, `tool is no longer
in the library`, `worktree ${path} is gone`. The branch is the one hole in
that family: `branchSwitchFor` compares `rail.branch` only against the
WORKTREE list, and `gavin_set_orchestration` takes any string, so an
agent-authored rail can bind a branch that was never made.

The refusal belongs in `executeSwitchBranch`, beside the dirty-checkout one
— the `switchBranch` action's own doc says orchestrationState owns the git
call and the refusal, and a rail-wide stall has no Action kind to carry it.

Not auto-creating the branch: this rail's checkout is the human's main
checkout, and forking it from whatever HEAD happens to be is exactly the
behind-the-back mutation the dirty-checkout gate refuses to make.

- [x] Refuse in `executeSwitchBranch` before touching git, naming the fix
- [x] Count a REMOTE-only branch as present — `git switch` DWIMs one into a
      local tracking branch, so refusing it would break a working case
- [x] Absent branch list reads as NOT LOADED, never as "no branch exists"
      (the same cold-start rule `launchBlocker` and `branchSwitchFor` follow)
- [x] Unit tests over the three cases: local hit, remote-only hit, neither
- [x] `npm test && npm run check && npm run build`
