---
order: 29696
kind: task
title: [fix] Six daemon tests are red on macOS: temp dirs live behind the /var symlink
labels: bug
status: To Do
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
