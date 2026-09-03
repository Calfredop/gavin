---
order: 8192
title: PR-aware rail step
status: Done
priority: high
---
Give a rail a step that waits on the pull request it opened — CI checks and review state — and either advances the rail or re-runs the card with the failing check as its prompt.

Today `builtin:open-pr` is one `gh pr create` line and the rail is blind afterwards (`orchestrationTools.ts`). A gavin-kind step polls `gh pr checks` / `gh pr view` for the rail's branch; the same poll feeds read-only PR chips on a branch-bound rail header. Merging stays the human's action.

Borrowed from Cursor's PR subscriptions, /babysit and the Await tool (2026-09-03 feature scan).

## Shape

One poll, two readers. The chips ask for host-side knowledge of the PR
anyway, so the step's verdict comes off that same snapshot rather than
off a second `gh` running in a shell — two pollers that can disagree
about the same PR is the failure worth designing out.

The card sketched this as a `gavin`-kind step. It cannot be one: tools
spec §8.2 makes a `gavin` action resolve inside its own launch and never
pass through `running`, and waiting on CI is nothing but `running`. So it
is a kind of its own — the same move `until` made, and for the same
reason the tools spec gives: a kind is where a completion rule lives.

Everything downstream of a failing check already exists. `builtin:until`
loops a rail backwards, re-arms the step before it and opens that agent's
prompt with what failed (`orchestrationLoop.ts`); a failing PR check is
the same verdict arriving from a different place, so it reuses that
machinery rather than growing a second copy.

- [x] Host-side `gh` probe: `pull_request.rs` and the `pr_status` command
- [x] `pullRequest.ts` — what one PR snapshot MEANS, pure and tested
- [x] `prState.ts` — one paced poll per branch-bound rail, as a store
- [x] The `pr` tool kind and the `builtin:await-pr` built-in
- [x] Launch a waiting step, and the scheduler rule that resolves it
- [x] Loop back on a failing check, quoting it in the retried prompt
- [x] Read-only PR chips on a branch-bound rail header
- [x] Suites green: `cargo test --workspace`, `npm test`, `check`, `build`
- [x] Smoke items for what only the running app can show
