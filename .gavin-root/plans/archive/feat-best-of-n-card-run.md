---
order: 4096
title: Best-of-N card run
status: Done
priority: high
---
Run one card on N agent profiles or models at once, each in its own worktree, watch them side by side in the tiled layout, pick one, merge it, and close the rest.

Cursor's `/best-of-n` hides the candidates in chat; Gavin's version shows them live in terminals, which is the product thesis. Prerequisite: a per-run profile and model override — today the profile is per workspace only (`agent_setup.rs`, `.gavin-root/config.toml [agent]`). Picking one must close the losing sessions and remove their worktrees; merging stays the human's action.

Borrowed from Cursor's /best-of-n + /apply-worktree (2026-09-03 feature scan).

## Shape

A **candidate** is the workspace's agent with a profile and/or model of its own,
in a fresh worktree on a fresh branch. N candidates run the card's ordinary run
prompt, side by side, on one tiled page named for the card. Picking one keeps its
worktree and binds it to the card; the losers' sessions close and their worktrees
and branches go. Merging is the human's, on the Git tab, as it always was.

Three decisions the checklist assumes:

- **The run record lives in localStorage, per workspace.** It is machine-local
  state about machine-local folders, and its worst failure is a sweep the human
  does by hand. A ninth `config.json` field would touch every `persist_workspaces`
  call site for that. Precedents: the orchestration conflicts box, the Plans tab's
  selection memory. Read back reconciled against the live layout, never trusted raw.
- **No protocol bump and no compat gate.** Everything here is app-side: worktrees
  through the Tauri git commands, sessions through `createSession`, the override
  composed onto the launch command by `composeLaunchCommand`.
- **Setup runs per candidate.** A fresh worktree needs `[worktree] setup` before an
  agent is any use in it, so each candidate's session runs the same one-line
  `setupPlan` the fork dialog builds — setup `&&` agent.

Out of scope for this card: a diff/compare view across candidates. The terminals
are the comparison; the Git tab is where a worktree gets read.

## Checklist

- [x] `bestOfN.ts`: the candidate model (profile + model override), the branch and
      folder each candidate gets off the card title, validation (two or more,
      distinct, and an agent that takes a prompt), and the launch line per
      candidate reusing `setupPlan`
- [x] `layout.ts`: `presetTiled(ids)` — one row up to three, rows of two beyond —
      agreeing with `presetSingle` / `presetSideBySide` / `presetGrid2x2`
- [x] `candidateAgent()`: a per-run profile/model override resolved through the
      existing `resolveAgentConfig`, so a candidate resolves exactly like a
      workspace agent and inherits everything it does not override
- [x] `bestOfNState.ts`: the per-workspace run record, its reconciliation against
      the live layout, and the lookups the UI needs (is this session a candidate,
      does this card have a run)
- [x] Start a run: N worktrees, N sessions on one tiled page named for the card,
      the card set In Progress once, the run recorded
- [x] Pick a winner: bind the winner to the card, close the losing sessions, and
      remove their worktrees and branches behind one `danger` confirm that names
      every folder it deletes
- [x] Abandon a run: the same cleanup with no winner, and the card left where the
      run found it
- [x] `BestOfNDialog.svelte`: choose the candidates and see, before agreeing, the
      branches and folders that will be created and the line each will run
- [x] Entry points on the card context menu and the card detail modal, both
      refusing with the same sentence when the agent takes no prompt
- [x] Pick affordances where the human is actually watching: an entry on each
      candidate tab's menu, and the run's own panel in the card detail modal
- [x] Smoke items in `smokeChecklist.ts` for the parts only the GUI can show
- [x] Suites green: `npm test`, `npm run check`, `npm run build`

