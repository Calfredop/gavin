---
order: 37888
kind: task
title: [feat] .gavin-worktrees
status: Done
---
Make Gavin's skills and scripts put the generated worktrees (eg. from rails) in a folder inside the workspace, named .gavin-worktrees. The challenge here is to keep context contained inside the workspace, without creating pollution and conflicts in git management.

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->

## Plan

Worktrees land at `<workspace root>/.gavin-worktrees/<branch, / as ->`.
The folder carries its own `.gitignore` of `*`, so it ignores itself and
everything in it: no tracked file changes, no `.git/info/exclude` edit,
no embedded-repo gitlink from a `git add .`, and it holds on every branch.

- [x] `defaultWorktreePath` → `<root>/.gavin-worktrees/<branch>`; fork dialog and Best-of-N anchor on the workspace root
- [x] Host `worktree_add` writes `.gavin-worktrees/.gitignore` (`*`) before `git worktree add` into that folder
- [x] Both git watchers (`is_relevant`, desktop + daemon) ignore `.gavin-worktrees/**` for the enclosing checkout
- [x] Pin the `.gavin*` tree watcher: a nested worktree's `.gavin-root` is neither scanned nor tree-relevant
- [x] Orchestrate skill (shipped + repo copy): cut worktrees into `.gavin-worktrees/` with the self-ignore
- [x] Fix comments/tests that describe worktrees as sibling folders
- [x] Follow-ups from the root-containment sweep filed as cards
- [x] Sweep fixes: card gates match `.gavin`/`.gavin-root` exactly; RepoPoller skips the folder; `coTenants` stops at it; run changes never lists or discards a nested worktree; host writes the self-ignore through the ssh-routed helpers
- [x] Decision record: `docs/superpowers/specs/2026-09-26-gavin-worktrees-folder-design.md` (supersedes G11)
- [x] Checks green (`cargo test --workspace`, `npm test`, `npm run check`, `npm run build`); commit only these files
