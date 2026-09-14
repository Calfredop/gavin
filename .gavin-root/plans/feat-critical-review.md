---
model: fable
agent: claude-code
order: 5632
title: [feat] critical review
status: To Do
complexity: complex
---
Critical review: N other agents critique finished work (a Done card or a whole rail),
file findings as cards, optionally build a findings rail. Extends the existing Review
tab and coexists with single-agent "Review with agent". No direct-edits mode in v1.

## Decisions

- Placement: Review tab + card/rail menus — not a new hub tab.
- Subject: card diff, or whole rail as one worktree/branch diff.
- Fan-out: N parallel sessions, shared checkout, no worktrees.
- Output: findings as cards only; "Build review rail" is explicit, plus a per-run
  auto-build toggle default **off**.
- Keep "Review with agent" (single); add "Critical review…" beside it.
- Rail baseline: worktree fork point, else earliest step baseSha.
- Implementation shape: this umbrella plan plus four free-standing To Do step cards
  (own status, placeable on a rail) — not nested tasks.

## Checklist

- [x] [Critical-review dialog + launch](critical-review-dialog.md)
- [x] [Review tab: rails as subjects](critical-review-tab-rails.md)
- [x] [Orchestration critical-review step](critical-review-rail-step.md)
- [x] [Build review rail from findings](critical-review-findings-rail.md)

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
