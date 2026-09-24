---
status: Done
kind: task
title: gavin::tests is 10 red on Windows, and this card's filter is why nobody had seen it
priority: high
complexity: moderate
---
`crates/daemon/src/gavin.rs`'s own test module is **10 red on Windows**,
deterministically, in two seconds. Nobody had seen it because every
measurement on
[fix-daemon-suite-deadlocks-on-windows](./archive/fix-daemon-suite-deadlocks-on-windows.md)
ran `--skip gavin::` — a filter that exists for the module's fs-watcher
flakiness under full-suite parallelism, not because the module passes.

**Frontmatter fixed 2026-09-22 (board audit).** This card carried
`parent: fix-daemon-suite-deadlocks-on-windows.md`, but that file lives in
`plans/archive/`, not `plans/` — an archived card is off the board, so the
link resolved to nothing and left this card loose with a broken mark. The
`parent:` line is dropped and the reference is now an ordinary link in the
prose above, which is all it was ever doing. The card stands on its own.

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

## Worked 2026-09-23 on `win/suite-reds`

All ten are closed. `gavin::tests` is **120 passed / 0 failed** at
`--test-threads=2`, and the whole binary with **no `--skip` at all** is
**584 passed / 0 failed** in 60–68s.

**Eight were path spelling, and `wire_spelling` is now shared.** It moved
out of `server::tests` into a new `crates/daemon/src/testing.rs`
(`#[cfg(test)] mod testing;`), still spelled out rather than delegated to
`protocol::wire_path` so a reported path is compared against an
independent derivation. It gained a companion, `wire_separators`, for the
paths that cannot canonicalise: `card_paths` names cards that
deliberately do NOT exist, so the ROOT is resolved and the card's own
segments joined on.

One of the eight was hiding a second bug. `scan_skips_extra_contexts_…`
wrote its `extra_contexts` entry into config.toml as a TOML **basic**
string, and a Windows path is `C:\Users\…` — `\U` is an escape TOML
rejects, so the whole config failed to parse, the extras list came back
empty, and the skip the test is named for was never exercised on Windows
at all. It writes a literal (single-quoted) string now.

**The two rename refusals went to the human, who chose option 2.**
`ONE_RECURSIVE_WATCH` is now `cfg!(any(target_os = "macos", windows))`.
What that bought, measured rather than assumed:

- Both tests green, and `renaming_the_root_away_pushes_root_missing_and_renaming_back_heals`
  runs on Windows for the first time (its `#[cfg(unix)]` is gone).
- The user-visible half: a Windows human can now rename or move a
  workspace folder, and a context folder inside it, while gavin watches.
  A handle on the directory being renamed is fine; it is a handle
  *inside* it that Windows refuses.

What it cost, both measured:

- **Churn.** New `#[ignore]`d `measure_recursive_watch_churn`, beside
  `measure_watch_set_on_a_large_repo`: 2000 build-shaped writes under
  `target/`/`node_modules/` produce ~6000 event paths, `tree_relevant`
  rejects **all** of them, and draining plus filtering costs tens of
  milliseconds. No rescan follows a rejection, so the walk is never
  paid. The survivor count is the assertion.
- **The root's return is no longer reported.**
  `ReadDirectoryChangesW` reports what happens INSIDE the directory its
  handle is open on, so a directory's own rename only ever reaches a
  watch on its PARENT — which `watch_targets` deliberately never takes.
  Renaming the root away still pushes `root_missing` (the handle follows
  the directory), renaming it BACK pushes nothing: **1/10 runs**, and
  that one a coincidence. The first change under the restored root heals
  it, **5/5**. So the "Root not found" banner clears on the human's next
  edit rather than on the rename. The test asserts that weaker property
  on Windows and the stronger one elsewhere; the constant's comment
  carries the reasoning.

**The un-gated test hung the whole suite before that was found**, and
that is worth recording as method. Four full-binary runs reported every
one of the 585 test lines and then never printed a summary — the
signature is `585 reported, 0 result line`, with ~85 unreaped
`sh.exe`/`conhost` and ~298 threads. Diffing the reported names against
`--list` named the culprit in one step: `renaming_the_root_away_…` did
bare `read_message(...).unwrap().unwrap()` reads with no deadline, so a
push that never comes sits for ever. It uses the `bound_reads` helper the
parent card added, and every read is now a named failure instead. A/B
against `git checkout -- crates/daemon/src` proved the hang was mine
before it was fixed: HEAD exited 3/3, the change stalled 4/4.

**Flakes seen, and why they are not this card's.** Across 7 full runs of
the fixed tree, 6 were clean and 1 had a single red
(`a_resize_never_answers_a_question_the_agent_asked`). Across 3 runs of
HEAD, all 3 had exactly the ten above and 1 had an extra red
(`killing_a_session_frees_its_screen`). A different test each time is the
flakiness signature the parent card used, and both are in the ConPTY
repaint-ordering family it already names.

Not committed — commits are the human's call.
