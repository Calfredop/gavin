---
order: 24576
kind: task
title: "[perf] File viewer reads whole files and lists folders uncapped"
labels: bug
parent: perf-main-thread-command-audit.md
status: Done
---
`read_file_for_viewer` (app/src-tauri/src/fileviewer.rs:166) reads the whole
file before truncating to the 1 MB viewer cap, and `list_directory` (:793)
lists a folder with no cap — both on the main thread, both re-run without
the user asking.

## Evidence (2026-09-26)

- `read_file_for_viewer_impl` (fileviewer.rs:198-200) does
  `std::fs::read(&resolved)`, then truncates to `MAX_VIEWER_FILE_BYTES`
  (:13). The cap limits rendering, not I/O. Viewable types include `.log`,
  `.csv`, `.json`.
- It re-runs on every `file-changed` (500 ms debounce) for an open editor
  tab (app/src/lib/files/FileEditor.svelte:106, :219, :300-303) or card
  modal (app/src/lib/cards/CardDetailModal.svelte:182-190): a tab open on a
  growing log re-reads the whole log on every append. Also Home visits,
  rail steps (orchestrationState.ts:988, :1026, :1467), card launches.
- `list_directory` (:810-849) `read_dir` + `lstat` per entry, no cap.
  `FilesHubView.restore` (app/src/lib/files/FilesHubView.svelte:213-226)
  re-lists EVERY remembered expanded folder on EVERY Files tab visit.
  `target/debug/deps` here has 50,989 entries — scandir+lstat 583 ms — so
  expanding it once makes every later Files visit freeze.

## Fix

- Read at most `MAX + 1` bytes (`take(MAX + 1).read_to_end`) — worth doing
  regardless of threading.
- Both `async` + `spawn_blocking` (`Result` already).
- Cap `list_directory` (e.g. first N entries + a "N more" marker), or
  restore expanded folders lazily.
- Ordering: FileEditor's load and external-change handler and
  CardDetailModal's `read()` have NO supersession token — add one before
  answers can arrive out of order. FilesHubView's `readDir` is guarded by
  `generation`.

## Verify

A fileviewer.rs test that a 50 MB file reads ≤ MAX+1 bytes. Add both to
`OFF_MAIN_THREAD` in `app/src/lib/guards/mainThreadCommands.test.ts`.

## Progress

- [x] `read_file_for_viewer`: read at most MAX+1 bytes; a cut that splits a character keeps the text before it (the daemon's twin already does)
- [x] `read_file_for_viewer` + `list_directory`: `async` + `spawn_blocking`; both join `OFF_MAIN_THREAD`
- [x] `list_directory`: cap at 2,000 entries in the tree's own order (dirs first), stat only the kept ones, answer `{ entries, omitted }`; the ssh route capped the same way
- [x] Files tree: remember `omitted` per folder, say so under the folder's row and in the no-match message
- [x] Supersession tokens: FileEditor's load + external-change reads, CardDetailModal's `read()` / `reloadContent()` / auto-commit write
- [x] Daemon's `read_workspace_file` (the ssh route's host side): same bounded read
- [x] Tests: 50 MB file reads ≤ MAX+1 bytes; cap + order; tree state; `cargo test` + `npm test`/`check`/`build`

## Result (2026-09-26)

- **Bounded read.** `read_prefix` reads `MAX + 1` bytes and stops; the
  test opens a sparse 50 MB file and checks the file's own cursor sits at
  or before `MAX + 1`. Also fixed while in there: a truncated read whose
  cut split a multi-byte character used to fail as "not valid UTF-8"
  (a big non-ASCII log would not open at all); it now keeps the text
  before the cut, the rule the daemon's `read_workspace_file` already had.
  The daemon's `read_workspace_file` (the ssh route's host side) got the
  same bounded read.
- **Off the main thread.** `read_file_for_viewer` and `list_directory` are
  `async` + `spawn_blocking` and in `OFF_MAIN_THREAD` (2 red against HEAD,
  green now). `read_file_for_viewer` no longer takes a `State`; it reads
  the workspaces off the `AppHandle` on the pool.
- **Capped listing.** `list_directory` answers `{ entries, omitted }`:
  past 2,000 entries it keeps the first ones in the tree's own order
  (folders first, then names ignoring case, so a cap never drops the
  subfolders) and counts the rest. Kinds come from readdir's d_type, so
  only the kept entries are stat'ed. The ssh route is capped the same
  way on the desktop side. The host daemon still lists whole, since its
  answer has no field for what it left out; that stays for the ssh card.
- **Measured** on `target/debug/deps` (60,052 entries). Before: a
  debug-build listing took 1.4-1.6 s on the main thread and sent 6.8 MB
  of JSON, which then became 60k DOM rows. After: the release build
  takes about 0.1 s off the main thread (scan 55-60 ms, sort 15-18 ms,
  stat of the 2,000 kept 20 ms), sends 233 KB and draws 2,000 rows. In a
  debug build the sort alone is about 150 ms, still off the main thread.
- **Files tree.** `fileTree.ts` keeps `omitted` per folder through
  Refresh, delete and rename. An open folder that was cut short shows
  "58,052 more entries not listed: this folder is too big to show whole.
  Reveal in Finder lists them all." above its rows. A filter that
  matches nothing while any folder is cut short now says so. Restore was
  left eager: with the cap and the pool it costs about 0.1 s per huge
  folder and no main thread.
- **Ordering.** FileEditor's load and external-change reads take a
  ticket (`readTicket`), and a rename retarget takes one too, so a read
  of the old path cannot mark the file deleted. CardDetailModal's
  watched read, checklist re-read and auto-commit read take
  `contentTicket`, and its own writes outrank any read in flight. The
  auto-commit toggle now uses one path for both its read and its write,
  so a modal repointed mid-read cannot splice one card into another's
  file. `viewerReadOrderSurfaces.test.ts` pins both (3 red against HEAD).
- **Checks.** `cargo test --workspace` passes (app 583, daemon 672, all
  green), as do `npm test` (6593), `npm run check` (0 errors) and
  `npm run build`.


- [ ] Human test: In an app rebuilt from perf/main-thread-commands (src-tauri too), open the Files tab and expand target/debug/deps: it should show "N more entries not listed: this folder is too big to show whole…" above about 2,000 rows, and leaving and coming back to the Files tab should not freeze the window. Then open a .log file in a tab, append to it from a terminal (`for i in $(seq 50); do echo line $i >> x.log; sleep 0.2; done`), and check the tab ends on the last line with no conflict banner.
