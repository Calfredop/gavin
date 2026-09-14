---
kind: task
title: Review tab: rails as subjects
status: Done
parent: feat-critical-review.md
complexity: moderate
---
On the Review hub tab, make rails first-class subjects alongside cards (same list — not a Cards|Rails switcher).

Selecting a rail shows its combined worktree/branch diff (baseline: worktree fork point, else earliest step baseSha). From that selection, offer "Critical review…" into the critical-review dialog.

Pure `reviewBoard` / `reviewState` changes + tests; keep existing card clustering behaviour.
