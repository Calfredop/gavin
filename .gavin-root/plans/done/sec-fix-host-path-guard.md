---
kind: task
title: [sec] containment guard on the five raw-path host commands
status: Done
priority: medium
complexity: simple
---
**Severity:** Medium (only reachable from a compromised page — see R5). Finding **R4** in `docs/security/README.md` (source AS-04 in `02-app-surface.md`, appendix table). The report lives on branch `sec/review-2026090801` until merged.

**The problem.** Six explorer commands (`list_directory`, `create_file`, `create_directory`, `rename_path`, `trash_entry`, `move_agent_file`) apply `fileviewer.rs`'s canonicalize + component-wise containment guard (`fileviewer.rs:309-342`). Five take a raw absolute path with no containment: `read_file_for_viewer`, `write_file_for_editor`, `resolve_path_under_cursor`, `watch_file_for_viewer`, `unwatch_file_for_viewer`. A script running in the page can read or write any file the developer can.

**The fix.** Put the same guard on the five, keyed on the set of open workspace roots plus their extra contexts (the file viewer legitimately opens files in any open workspace, and the terminal's Cmd+click resolves paths under the session's cwd — allow those, refuse the rest with a named error). Add a unit test per command mirroring the existing guard tests, including a symlink that leaves the root. Do not change the frontend calls; a refused path surfaces through the existing error banner.

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
