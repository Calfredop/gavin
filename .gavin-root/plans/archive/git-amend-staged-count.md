---
title: Amend shows its staged count and warns on pushed HEAD
status: Done
---
The commit box prints `Commit (N)` but bare `Amend` — the fold-in count is
hidden in the one mode that also rewrites an existing commit's tree. In this
shared checkout the index routinely holds other sessions' files, so an amend
meant for a message swept three unrelated cards into a pushed commit and
blocked the next push (a87c472 vs origin's 2044b3b).

Nothing auto-stages: `commit()` in git/commands.rs is a clean `git commit -F -
--amend`. The defect is the missing signal, plus no guard on rewriting a
commit that is already on the remote.

- [x] Failing tests for the label and the pushed-HEAD predicate
- [x] `commitButtonLabel` + `amendRewritesPushed` in gitState.ts
- [x] GitCommitBox renders the count and an inline warning
- [x] Suites green (npm test, check, build)
- [x] Smoke items for the count and the warning
