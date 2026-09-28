---
order: 21504
kind: task
title: "[perf] The worktree switcher re-reads every worktree on every refresh"
labels: bug
parent: perf-main-thread-command-audit.md
status: Done
---
While the worktree switcher menu is open, every Git-view refresh re-runs
`loadFacts()`: one `git_merged_branches` plus one `git_status` PER WORKTREE
(13 here), on the main thread.

## Evidence (2026-09-26)

- app/src/lib/git/GitWorktreeSwitcher.svelte:247 re-runs `loadFacts()`
  whenever the `worktrees` derived value changes (:47). Every refresh
  builds a new refs object, so the derived changes on every refresh, even
  when the worktree set did not.
- `loadFacts` → `sweepFacts` (app/src/lib/git/gitState.ts:1307-1327):
  `git_merged_branches` + `Promise.all` of `git_status` per worktree path.
  At ~50 ms per status in the app that is ~0.7 s per refresh, on top of the
  refresh itself.

## Fix

Key the effect on a `$derived` signature string of the worktree paths (and
branches), not on the refs object, so it re-runs only when the set actually
changes. Remember Svelte 5 `$state` proxies objects — never gate on
identity (CLAUDE.md). `loadFacts` already has `factsToken` for ordering.

## Verify

A unit test on the signature helper (same paths → same key; a new worktree
→ new key). Then open the switcher and watch a refresh: no `git status`
burst.

- [ ] Human test: In an app built from perf/main-thread-commands: open the Git tab's worktree switcher, save a file so the view refreshes, and check that the "stale" badges stay put with no burst of one `git status` per worktree (e.g. `ps -o command= -g <Gavin pid> | grep 'git status'`). Then add a worktree with the menu open and check its row gets a verdict.

## Done (2026-09-26)

- `worktreeFactsKey` (app/src/lib/git/worktreeSweep.ts): the worktree SET
  as a sorted string of path, branch and missing-ness. HEAD is left out,
  since every commit moves it.
- GitWorktreeSwitcher.svelte: `factsKey = $derived(worktreeFactsKey(worktrees))`,
  and the effect reads only `open` and `factsKey`, calling
  `untrack(() => void loadFacts())`. The untrack is load-bearing:
  `loadFacts` reads `worktrees` before its first await, so a tracked call
  would put the list back among the effect's dependencies.
- Tests: six cases on the key plus a source guard on the effect
  (worktreeSweep.test.ts). Verified at runtime with a throwaway,
  client-compiled rune probe, since the repo's vitest runs Svelte's server
  build, where `$effect` never fires. With `untrack`, two same-set refreshes
  asked git 0 times and a new worktree asked once. The tracked control
  asked on every refresh.
- Checks: `npm test` 293 files / 6488 passed, `npm run check` 0 errors,
  `npm run build` ok.
