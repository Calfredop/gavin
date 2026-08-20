# Git tab "à la Fork" — brainstorm (session log, 2026-08-20)

A Git tab in the workspace home hub with a classic Fork-style UI. Decisions
are numbered G1…; phase decisions D1–D34
(`2026-08-06-agent-orchestration-brainstorm.md`) still govern the hub (D11 tab
row, D33 front door).

## Context found before the first question

- Hub tabs are registered in `app/src/lib/workspaceViews.ts` (`HUB_VIEWS`);
  a Git tab is one more `HubView` with `requiresRoot: true`.
- `crates/daemon/src/git_status.rs` already shells out to `git` (porcelain
  v2), resolves repo roots and owns a per-repo watcher with a hard rule:
  never tight-poll `git status` (it touches `index.lock` — cmux #2722/#4779).
- Feature backends live either Tauri-side (`fileviewer.rs`, direct
  `#[tauri::command]`s) or daemon-side over the protocol (`kanban.rs`,
  `gavin.rs`).

## Decisions

- **G1 (2026-08-20):** **Local Changes first** (recommended, approved). v1's
  primary job is reviewing and committing agent work; the commit graph is a
  later sub-project.
- **G2 (2026-08-20):** **Files + hunks + lines staging** (owner picked the
  fullest option). Needs a frontend patch builder + `git apply --cached`.
- **G3 (2026-08-20):** **Unified + side-by-side toggle** from day one (owner
  picked over unified-only). One row model, two layouts; selection survives
  the switch.
- **G4 (2026-08-20):** v1 action surface (owner, multi-select): discard
  (file/hunk/line), amend, Fetch/Pull/Push toolbar, stash/pop, **plus forks
  and worktrees**.
- **G5 (2026-08-20):** "Forks" = **remotes (origin + upstream)** AND
  **branch-off worktrees (agent forks)**; not GitHub/`gh` integration.
- **G6 (2026-08-20):** **Worktree switcher in the tab** (recommended,
  approved): toolbar dropdown over root checkout + `git worktree list`; every
  action targets the selected worktree. New/remove live in the dropdown;
  merge-back is a branch action.
- **G7 (2026-08-20):** **Decomposition** (approved):
  1. Git tab + Local Changes (this spec)
  2. Sync, branches, stashes — fetch/pull/push + progress, multi-remote,
     branch list with checkout/create/delete, stash/pop
  3. Worktrees (agent forks) — switcher, fork branch+worktree from a commit,
     remove, merge back, spawn an agent in it
  4. History graph — deferred past v1
- **G8 (2026-08-20):** **Backend approach A — Tauri-side `git.rs` shelling
  out to the system `git`** (recommended, approved over B daemon-over-
  protocol and C libgit2). Credentials/SSH/hooks/config behave exactly as the
  user's terminal; no protocol churn. Hooks run as-is (owner confirmed).
- **G9 (2026-08-20):** **Refresh = watcher, never timer.** Tauri-side
  recursive `notify` watch on the worktree, 300 ms debounce, `.git/` filtered
  to HEAD/index/refs/MERGE_HEAD/packed-refs; each trigger runs only
  `git status --porcelain=v2`. Immediate refresh after our own mutations and
  on tab activation; manual refresh button.

## Section approvals

All five design sections approved as presented (2026-08-20): tab + Fork
three-pane layout; backend command table + watcher; diff viewer + staging
model + patch builder; frontend state/refresh/destructive rules; edge cases
+ testing.

Spec: `docs/superpowers/specs/2026-08-20-git-tab-local-changes-design.md`.

## Execution notes — plan 1 (Local Changes, 2026-08-20)

Implemented on branch `worktree-git-tab-local-changes` (18 tasks, one commit
each). 131 Rust tests (33 new) · 510 Vitest tests (44 new) · svelte-check 0
errors · production build clean. Manual smoke pass (Smoke Test workspace →
“Git tab” section) still to run.

Deviations from the spec, all deliberate:

- **Binary files** show “Binary file — no text diff” (no byte size; spec §1
  said “— N bytes”). Size plumbing wasn't worth a command for SP1.
- **Binary detection** reads git's own `Binary files … differ` line from the
  single diff invocation instead of a second `--numstat` call (spec §2).
  Same outcome, one subprocess.
- **Unborn HEAD** is detected with `rev-parse --verify -q HEAD`; spec
  corrected during planning (`symbolic-ref` still succeeds on an unborn
  branch).
- **Failed `git apply`** surfaces in the view-level error banner rather than
  “inline in the diff header” (spec §3) — one error surface for every
  mutation, same information.
- **Watcher scope**: only the worktree root is watched. A linked worktree's
  real gitdir lives under the main repo's `.git/worktrees/<name>/`; SP3
  (worktrees) owns that.
- **Porcelain `u` records**: the plan's test fixture had one token too many
  (the real format is 4 modes + 3 hashes); the parser was right, the fixture
  was fixed.
- **Subset-of-adds fixture**: the plan originally had `+new1` before the
  unselected ` delta` context line; corrected to keep original hunk order
  (matches `git add -p` edit semantics), verified with `git apply --check`.
