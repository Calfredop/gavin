---
order: 7168
kind: task
title: [sec] one path-confinement helper for every daemon writer
status: To Do
priority: medium
complexity: moderate
---
**Severity:** Medium. Finding **R4** in `docs/security/README.md` (sources DP-03 in `01-daemon-protocol.md`, AG-03 in `03-agent-surface.md`). The report lives on branch `sec/review-2026090801` until merged.

**The problem.** `delete_card_file` (`crates/daemon/src/gavin.rs:1066-1078`) refuses `..`, non-`.md` files, and anything outside a `.gavin*/plans|docs|specs` folder. `SetPlanFrontmatterField`, `SetChecklistItem`, `PromoteChecklistItem`, `InitGavinRoot`, `CreateGavinContext`, and `AddExternalGavinContext` have no such guard and act on whatever path the wire names — reproduced: `gavin_set_plan_field` from one throwaway workspace set a card in another, never-opened root to Done by absolute path.

**The fix.** Lift the `delete_card_file` guard into one helper in `gavin.rs` (canonicalize, reject `..`, require the `.gavin*` ancestor with the right folder, require `.md` where a card is meant) and route every path-taking write through it; for root-taking requests (`InitGavinRoot`, `CreateGavinContext`, `AddExternalGavinContext`), require the path to be an existing directory the caller's connection has watched, or an ancestor/descendant of one, and refuse the rest with a named error. Keep the guard's existing tests and add one per newly guarded request. No protocol change: the requests keep their shapes; only refusals are new. The per-connection workspace scope that makes "inside a workspace" mean "inside *this* workspace" is `sec-fix-client-identity.md`; this card is the confinement that scope will key on.

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
