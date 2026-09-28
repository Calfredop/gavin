---
order: 31744
kind: task
title: "[perf] The Git watcher refreshes on gitignored paths"
labels: bug
parent: perf-main-thread-command-audit.md
status: Done
---
`git/watch.rs::is_relevant` (app/src-tauri/src/git/watch.rs:21) counts EVERY
path outside `.git/` as a change, including gitignored ones (`node_modules/`,
`target/`, `.svelte-kit/`, caches). Each debounced `git-changed` runs a full
Git-view `refresh()` — 14 git processes on the main thread (see the sibling
card on the refresh).

## Evidence (2026-09-26)

In a 240 s FSEvents sample, a 4-second `npm install` in
`mushma-merge-regions/web/node_modules` (ignored — `git check-ignore`
confirmed) produced 30,220 events → ~13 debounced `git-changed` → ~180 git
processes → 8–16 s of queued main-thread work, for a change `git status`
never shows. Background rate elsewhere: 1.7–2.7 emits/min per workspace.
The watcher also fires on `.git/index`, so every Git-tab action gets a
second refresh ~300 ms after its own.

## Fix

Drop ignored paths in the watcher: build a gitignore matcher at watch start
(the `ignore` crate's `gitignore::GitignoreBuilder` over the repo's
`.gitignore` files + `info/exclude` + core.excludesFile), rebuild it when a
`.gitignore` changes, and skip events whose path it matches. Keep the
existing `.git/` allow-list and the `*.lock` rule. Do not shell out to
`git check-ignore` per event.

Worth considering at the same time: the `.git/index` echo of the app's own
actions (`run()` already refreshes).

## Verify

Rust unit tests in watch.rs: an ignored path is not relevant, a tracked
path and an untracked-not-ignored path are, a `.gitignore` edit re-arms the
matcher. Then run `npm install` in a gavin worktree with its Git view open
and watch the `git-changed` rate (or `sample` the main thread).

## Outcome (2026-09-26)

Shipped on `perf/main-thread-commands` (uncommitted; the rail's commit step
follows), in both copies of the filter: `app/src-tauri/src/git/watch.rs`
and its ssh transcription `crates/daemon/src/git_watch.rs`.

- `IgnoreFilter` sits on top of `relevant_event`: the `ignore` crate's
  `Gitignore`, one matcher per `.gitignore`, consulted the way git does
  (nearest file with an opinion wins, then `info/exclude`, then
  `core.excludesFile`; a path under an ignored folder is ignored). The
  `.git/` allow-list and the `*.lock` rule are unchanged underneath.
- Rules are re-read per debounced batch, and only the `.gitignore` files on
  the paths the batch touches, so an edit needs no invalidation step.
- **Tracked files matched by an ignore rule stay relevant.** `git status`
  shows them whatever the rules say, and 24 of the 66 repos under
  `~/CloudStation/Coding` have some (mandragora has 47, including
  `apps/admin-ui/.../logs/audit/page.tsx`). A plain matcher would have
  hidden edits to them. The set comes from `git ls-files -ci
  --exclude-standard`, run on the watcher thread, and is re-read after an
  index write, a `.gitignore` or `info/exclude` change, or a change in
  `core.excludesFile`'s bytes. If git can't answer, the path counts.
- The desktop watcher now resolves its root (and a linked gitdir) the way
  the daemon's already did. FSEvents reports real paths, so a root reached
  through a symlink counted every event, `index.lock` included.

Measured: `npm ci` in this worktree's `app/` (ignored via `app/.gitignore`)
under a probe that fed each batch through both filters produced
18,032 paths in 29 batches. The old filter emitted 29, the new one 0 (its
only 2 were a real untracked file I created and deleted in the same run).
Filtering cost 326 ms over the whole run, off the main thread, in a debug
build.

Tests (both crates, same table): ignored path, anchored and nested rules,
tracked and untracked-unignored paths, a force-added file under an ignored
folder, `.gitignore` edit re-arms (including a rule that newly covers a
tracked file), index change re-arms, nearest `.gitignore` decides, info/exclude
and core.excludesFile, a `.gitignore` inside an ignored folder, and a real
watch that stays quiet for an ignored write. Each re-arm test and the
resolved-root test were confirmed to go red with their mechanism removed.
`cargo test --workspace` is green.

**`.git/index` echo: not suppressed, on purpose.** Since 48bed45f the
refresh's reads run off the main thread, and `refresh()` coalesces, so the
echo costs one extra background pass per Git-tab action. Suppressing it
needs change times, and debouncer-mini exposes none. The only bound
available, receipt minus 300 ms, trails the action's own pass by up to a
75 ms tick, so a time-based skip would rarely fire. A self-write window in
the backend would instead drop an external `git commit` that lands within
it, which leaves the view stale, the failure the watcher exists to
prevent. It would also have to exempt gavin's own git writes outside the
Git tab (auto-commit, worktree add), because nothing else refreshes after
those.
