---
order: 17408
status: To Do
kind: task
title: gavin::tests is 10 red on Windows, and this card's filter is why nobody had seen it
parent: fix-daemon-suite-deadlocks-on-windows.md
---
`crates/daemon/src/gavin.rs`'s own test module is **10 red on Windows**,
deterministically, in two seconds. Nobody had seen it because every
measurement on the parent card ran `--skip gavin::` — a filter that
exists for the module's fs-watcher flakiness under full-suite
parallelism, not because the module passes.

Measured 2026-09-22 on `win/session-exit-reporting`, and measured again
against `git show HEAD:crates/daemon/src/gavin.rs` to prove none of it
came from the parent card's `confine_root_path` fix: the same 10, both
times.

```
target/debug/deps/gavin_daemon-*.exe --test-threads=2 gavin::tests
```

- `a_folder_that_left_gives_its_watch_back`
- `a_new_folder_picks_up_its_own_watch_on_the_next_rescan`
- `a_step_path_is_recovered_when_its_card_moved_into_done`
- `a_step_path_that_still_has_its_file_is_left_alone`
- `an_archived_card_is_still_scanned_deleted_and_promoted_like_any_other`
- `deleting_a_context_folder_pushes_a_tree_without_it`
- `external_contexts_register_scan_and_unregister`
- `renaming_a_context_folder_pushes_a_tree_with_the_new_name`
- `scan_skips_extra_contexts_that_are_missing_or_inside_the_root`
- `watch_targets_covers_the_scanned_dirs_and_skips_the_churny_ones`

They fall into the two families the parent card already named, so read
its notes before starting — the analysis is done, only these call sites
are left.

**Eight are path spelling.** `scan_root` reports wire paths (forward
slashes, no `\\?\`) and these tests build their expectations from
`canonicalize().to_string_lossy()` or `Path::join`, which on Windows is
backslashes. Verbatim in the failures:
`[("C:\\Users\\…\\plans\\fs-sync.md", "C:/Users/…/plans/done/fs-sync.md")]`,
and `watch_targets_…` reporting `("packages\\api", false)` where the
test wants `packages/api`. `server.rs`'s test module grew a
`wire_spelling` helper for exactly this — spelled out rather than
delegated to `protocol::wire_path`, so a reported path is still compared
against an independent derivation. Lift it somewhere both modules can
use rather than writing a second copy.

**Two are the Windows rename refusal**, `Os { code: 5, PermissionDenied }`
out of `fs::rename`/`remove_dir_all`:
`renaming_a_context_folder_pushes_a_tree_with_the_new_name` and
`deleting_a_context_folder_pushes_a_tree_without_it`. Windows refuses to
rename or delete a directory while any handle is open anywhere inside
it, and that refusal survives opening the inner handle with
FILE_SHARE_DELETE — measured directly, outside gavin. `watch_targets`
registers a watch per scanned directory on every platform but macOS, so
the watcher's own handle on the context folder is enough.

This one needs a judgement the parent card deliberately did not make
alone, so **put it to the human rather than picking**:

1. `#[cfg(unix)]` the two, the way
   `renaming_the_root_away_pushes_root_missing_and_renaming_back_heals`
   now is, and accept that the rename/delete arm of the watcher is
   unmeasured on Windows.
2. Make `ONE_RECURSIVE_WATCH` true on Windows too. `ReadDirectoryChangesW`
   is natively recursive, so the per-directory set is one handle per
   directory where one would do — and with only the root watched, a
   context folder inside it stays renamable. The cost is real and is why
   this is not a free swap: `bWatchSubtree` pulls `target/`,
   `node_modules/` and `.git/` churn into the daemon, which is the whole
   reason the per-directory set exists (see the constant's comment: 3587
   directories under this repo's root, 44 the scanner walks).

Option 2 also fixes a user-visible annoyance nobody has filed: **while
gavin watches a workspace, Windows will not let the human rename or move
that folder.** Worth saying out loud when you ask.

Verify the way the parent card did: the module alone at
`--test-threads=2`, then the whole binary at `--test-threads=4` with
**no `--skip` at all** — 564 tests, about 59s, and these ten are the
only red left in it. Do not re-introduce a filter to get there: `--skip
repo` is a substring match that also hides every test with "report" in
its name, and `--skip git_status` is no longer buying anything now that
those 32 run in under seven seconds.
