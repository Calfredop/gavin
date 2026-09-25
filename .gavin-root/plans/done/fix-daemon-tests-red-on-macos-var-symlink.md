---
order: 29696
kind: task
title: [fix] Six daemon tests are red on macOS: temp dirs live behind the /var symlink
labels: bug
status: Done
---
`cargo test -p gavin-daemon` is red on macOS with six failures, every run,
including each module run alone. Seen 2026-09-25 on the merge of origin/main
(`2bc84f93`); the daemon crate there is byte-identical to origin/main, so
the reds came with the remote, not the merge.

- `gavin::tests::external_contexts_register_scan_and_unregister`
- `gavin::tests::scan_skips_extra_contexts_that_are_missing_or_inside_the_root`
- `gavin::tests::an_archived_card_is_still_scanned_deleted_and_promoted_like_any_other`
- `gavin::tests::a_step_path_is_recovered_when_its_card_moved_into_done`
- `gavin::tests::two_steps_sharing_one_moved_card_yield_a_single_re_key`
- `git_watch::tests::a_relevant_write_wakes_the_watcher`

## One cause

`tempfile::tempdir()` on macOS is `/var/folders/...`, and `/var` is a
symlink to `/private/var`. A path that went through `canonicalize` reads
`/private/var/...`; one that did not reads `/var/...`. Each test compares
one spelling against the other.

- **The five `gavin::tests`** — `08d4e5b4` ("assert daemon paths in the
  spelling the daemon reports") moved their expectations onto
  `crate::testing::wire_spelling`, which canonicalises. Its premise is that
  a scan stores `protocol::canonical_path(root)`. That holds on the request
  path (`server::tests` use the same helper and pass on the Mac), but these
  tests hand `scan_root` the raw tempdir, so the scan reports `/var/...`
  and the expectation says `/private/var/...`. The commit fixed Windows
  reds, and a Windows tempdir has no symlink in it, so both spellings
  agree there.
- **`git_watch`** (new in `40c401c9`) — FSEvents reports
  `/private/var/...`, the watcher's root is the raw `/var/...`, so
  `relevant_event`'s `strip_prefix(root)` fails and its `Err(_) => true`
  arm counts the event: `.git/index.lock` wakes the watcher. Verified:
  with the test's root canonicalised first, it passes 3 of 3 runs.
  Production is not affected as far as the code shows — `WatchGitWorktree`
  hands the watcher `confined_worktree`'s resolved path.

## Do

1. Fix it in the tests, not in `wire_spelling` or the daemon: resolve each
   test's root the way production does (`protocol::canonical_path`) before
   anything is built from it, so input and expectation share one spelling
   on every OS. Keep `08d4e5b4`'s Windows fixes intact — the TOML literal
   string and the separator handling are still right.
2. Sweep for the rest of the family before closing: every daemon test that
   builds paths from a raw `tempdir()` and compares them against scanner,
   store or watcher output. Fix the ones that would break the same way even
   if they pass today.
3. Run `cargo test -p gavin-daemon` on the Mac and say whether it is green.
   A Windows re-run is the owner's; do not claim it.

## Outcome (2026-09-25, branch `merge/origin-main-20260925`)

Fixed in the tests; `wire_spelling`, the scanner and the watcher are
untouched, and `08d4e5b4`'s Windows fixes stand.

- `gavin::tests` gained `wire_root(&TempDir)`, the resolve-first pattern
  the module's `GavinWatcher::start` test already spelled inline
  (`PathBuf::from(wire_spelling(dir.path()))`), and every test below
  builds its paths from it.
- The sweep found the family wider than the five reds: the recovery tests
  `a_step_path_that_still_has_its_file_is_left_alone`,
  `a_deleted_card_is_not_recovered_onto_some_other_file`,
  `recovery_never_crosses_from_one_context_into_another` and
  `an_ambiguous_file_name_is_left_alone_rather_than_guessed` were green on
  the Mac only because `recover_moved_card_paths` keys on
  `(plans root, file name)` and the two roots never met, so "nothing
  recovered" held whatever the code did. Proven by mutation: with the
  live-path check dropped and ambiguity resolved to the first match, two
  of them now fail, where before the fix they could not. The ambiguous
  test's hand-built path also takes `wire_separators`, like `card_paths`.
- `git_watch`'s test resolves its root with `protocol::canonical_path`,
  as `confined_worktree` does before a real watch.
- `cargo test --workspace` on the Mac: green, daemon 662/662. A Windows
  re-run is the owner's.
