---
kind: task
title: [sec] validate [agent] file before setup writes through it
status: Done
priority: medium
complexity: simple
---
**Severity:** Medium. Finding **R3** in `docs/security/README.md` (source AS-03 in `02-app-surface.md`). The report lives on branch `sec/review-2026090801` until merged.

**The problem.** `setup_agent_integration` writes gavin's marker block (`<!-- gavin:start -->` … `<!-- gavin:end -->`) into the file named by `[agent] file` in the repo's `.gavin-root/config.toml` with no path validation. It validates `mcp_file` but not this key, so an absolute or `..` value writes outside the workspace root — reproduced: `[agent] file = "../victim.txt"` rewrote a file beside the repo.

**The fix.** In `app/src-tauri/src/agent_setup.rs`, run `[agent] file` through the same containment the `mcp_file` path already gets: resolve against the root, canonicalize the parent, refuse `..` and anything whose canonical path is not under the root, and return a visible error naming the value. Add a unit test beside the existing `write_mcp_config_*` tests for the absolute and the `..` case. Do not change what a valid relative `[agent] file` does.

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
