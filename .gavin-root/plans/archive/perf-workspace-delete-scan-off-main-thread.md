---
order: 28672
kind: task
title: "[perf] The delete wizard walks the whole workspace on the main thread"
labels: bug
parent: perf-main-thread-command-audit.md
status: Done
---
`scan_gavin_footprint` (app/src-tauri/src/workspace_delete.rs:370) and
`remove_gavin_footprint` (:383) walk the workspace root to depth 12 with a
stat per entry, on the main thread.

## Evidence (2026-09-26)

Measured walk (`walk_contexts`, :158): gavin 3 ms, mushma 0.27 s,
mandragora 2.1 s (152k entries), baslab 6.9 s (190k). `remove` re-scans
before trashing, so the finish button pays it twice plus the trash.

## Fix

- `scan`: owned args — plain `async` + `spawn_blocking`.
- `remove`: spend the confirm token synchronously first (it needs
  `State<ConfirmGate>`), then move `root_path` and the plan into
  `spawn_blocking`; it already returns `Result`.
- Consider pruning the walk at `node_modules/`, `target/`, `.git/` — gavin
  contexts never live there.
- The wizard makes one call at a time; no ordering risk.

## Verify

Add both to `OFF_MAIN_THREAD` in
`app/src/lib/guards/mainThreadCommands.test.ts` (red first). Open the
delete wizard on a large root and confirm the window stays live.

## Outcome (2026-09-26)

- Both commands are `async` + `spawn_blocking`; `remove` spends the token
  before leaving for the pool. Both joined `OFF_MAIN_THREAD` (red, then green).
- Pruning was already there: `EXCLUDED_DIRS` skips `.git`, `node_modules`,
  `target` and more, plus every dot-dir, and it is pinned to the daemon's
  walk on purpose, so no new exclusions. Instead the walk reads the entry
  type from readdir and stats only symlinks (to follow them like
  `Path::is_dir`): warm, mandragora 0.76 s -> 0.25 s, baslab 1.23 s ->
  0.83 s, same contexts found. `a_symlinked_gavin_folder_is_still_found`
  pins the symlink case (red without the fallback).
- The wizard's scan `$effect` re-ran whenever `ws` was replaced, and a
  seconds-long scan left room for a second one to land and reset the
  answers. A plain `scanning` flag now stops a second scan from starting.

- [ ] Human test: In an app rebuilt from perf/main-thread-commands (src-tauri too), open Delete workspace on a large root (baslab or mandragora) and, while it shows "Reading <root>…", type into a terminal of another workspace: the keystrokes should echo as you type, not replay afterwards, and the wizard's first screen should follow. Close the wizard there without deleting anything.
