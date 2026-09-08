---
kind: task
title: [sec] add -- to ref-taking git commands
status: Done
priority: low
complexity: trivial
---
**Severity:** Low; no reachable input found. Finding **R10** in `docs/security/README.md` (source AS-08 in `02-app-surface.md`). The report lives on branch `sec/review-2026090801` until merged.

**The problem.** `app/src-tauri/src/git/run.rs` builds argv arrays (no shell — good), but the commands that take a ref, branch, remote, or path from data omit the `--` end-of-options marker, so a name beginning with `-` would be parsed as a flag. Today every reachable input is slugged (`branchNameFrom`) or human-typed, and `ext::` remotes are blocked by git's defaults, so nothing was reproduced.

**The fix.** In the git wrapper, add `--` before positional refs and paths on every invocation that accepts them (`checkout`, `branch`, `worktree add`, `log`, `diff`, `show`, `merge`, `rebase`, `push`, `fetch`, `rm`, `add`), and in the one place names enter (`branchNameFrom`/`freeBranchNameFrom` in `git.ts` and the host-side validators) refuse a name that starts with `-`. Add a unit test that a branch named `--upload-pack=x` is refused before git sees it.

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
