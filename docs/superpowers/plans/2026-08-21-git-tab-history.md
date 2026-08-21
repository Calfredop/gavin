# Git Tab — History Graph (SP4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fork's "All Commits" in the Git tab: a lane graph over all branches with paging, a commit detail pane with read-only per-file diffs, and commit actions (checkout, branch here, copy, cherry-pick, revert, reset).

**Architecture:** one `git log --topo-order` call per page parsed into `CommitInfo`; a pure lane algorithm (`graphLanes.ts`) turns the list into per-row SVG instructions; `git_diff` gains a revision mode so SP1's diff viewer renders commit diffs read-only; commit actions go through the SP1 runner and the in-progress banner learns cherry-pick/revert.

**Tech Stack:** as SP1–SP3. `ContextMenu.svelte` (already on main) for the row menu.

**Spec:** `docs/superpowers/specs/2026-08-21-git-tab-history-design.md`.

## Global Constraints

- SP1–SP3 constraints hold. Page size 300; `--topo-order` always; `--all` unless the current-branch toggle is on.
- Reset `--hard` only after the typed short SHA matches. Revert/reset disabled on detached HEAD.
- No timers; the graph reloads page 0 on `refresh()` only while it is open.

## File structure

**Rust**: `types.rs` (+ `RefLabel`, `CommitInfo`, `LogPage`, `CommitDetail`), `parse.rs` (+ `parse_decorations`, `parse_log`, `parse_name_status` extracted), `commands.rs` (+ `log`, `commit_detail`, rev-mode `diff`, `checkout_commit`, `cherry_pick`, `revert`, `reset`, `continue_in_progress`; `repo_info` kinds), `lib.rs`.
**TS**: `git.ts` (types, `matchesFilter`, `shortSha`), `graphLanes.ts` (+ test), `backend.ts`, `gitState.ts` (+ test), `workspace.ts`/`config.rs` (`graphAll`), new `GitGraph.svelte`, `GitGraphRow.svelte`, `GitCommitDetail.svelte`, `GitResetDialog.svelte`; modified `GitNav.svelte`, `GitChanges.svelte`, `GitDiff.svelte`, `GitHubView.svelte`, `smokeChecklist.ts`.

---

### Task 1: Backend — log, decorations, detail, revision diffs, actions

- [ ] Tests (parse + temp-repo integration): decorations (`HEAD -> main, origin/main, tag: v1, refs/stash`, detached `HEAD`, empty); `parse_log` on a two-record sample with a merge commit; `log()` on a repo with a side branch merged + a tag: `--all` shows both tips, `has_more` paging with limit 2; `commit_detail` on the root commit lists `f.txt` as `A`; `diff(rev=root sha)` yields hunks against the empty tree; cherry-pick conflict → `in_progress == "cherry-pick"` → abort; `revert` creates a commit; `reset` soft keeps the index, mixed keeps the worktree, hard discards.
- [ ] Implement per spec §1. `git_continue_in_progress(cwd, kind)`; `git_continue_rebase` delegates. Register commands.
- [ ] `cargo test -p app` green; commit `feat(git): log, commit detail, revision diffs, cherry-pick/revert/reset`.

### Task 2: TS types, lane model, store

- [ ] Tests: `graphLanes` — linear (lane 0 throughout, no links), fork+merge (`M(a,b)` above `a` and `b`: row M has a link to lane 1; `b` sits on lane 1; after both join lane count drops), octopus (2 links), two roots (lane 1 opens for the second root then closes); `matchesFilter`; store — `selectCommits` sets nav and loads page 0 with `all=true`; `loadMore` appends with `skip=300`; `refresh` while in commits mode reloads page 0 and keeps a still-present selection; `selectCommit` loads detail then the first file's diff with `rev`; `resetTo` refuses hard without confirmation token? (no — the dialog gates it; store just runs).
- [ ] Implement `git.ts` types, `graphLanes.ts`, `backend.ts` wrappers (`gitLog`, `gitCommitDetail`, `gitDiff` rev param, `gitCheckoutCommit`, `gitCherryPick`, `gitRevert`, `gitReset`, `gitContinueInProgress`), prefs `graphAll`, store fields/actions.
- [ ] `npm test && npm run check` green; commit `feat(git): lane model and history store`.

### Task 3: Components

- [ ] `GitGraphRow.svelte` (SVG cell + chips + text), `GitGraph.svelte` (header toggle/filter/count, rows, keyboard, context menu, Load more), `GitCommitDetail.svelte` (header, message, files, read-only diff via existing layouts with `canAct={false}`), `GitResetDialog.svelte`.
- [ ] `GitNav`: **All Commits** entry; `GitChanges`/`GitDiff` render the graph/detail when `navSelection === "commits"` (GitHubView swaps the middle/diff components instead — cleaner: `{#if nav === "commits"}<GitGraph/>…<GitCommitDetail/>{:else}` in GitHubView's panes); banner: cherry-pick/revert kinds with Abort/Continue.
- [ ] `npm run check` clean; commit `feat(git): commit graph, detail pane, commit actions`.

### Task 4: Smoke, cards, verification

- [ ] Smoke section "Git tab — history"; new card `git-tab-history.md` → ticks; execution notes; merge `main`; full verification; commit.
