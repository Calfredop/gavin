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

## SP2 + SP3 decisions (2026-08-20, same session)

- **G10:** **Plain git semantics for Pull/Push** (recommended, approved):
  `git pull` honours the user's merge/rebase config; conflicts land in the
  in-progress banner, which gains Abort (merge/rebase) and Continue
  (rebase). `git push`, auto `-u <remote> <branch>` on a branch with no
  upstream ("Publish"). No force push in v1.
- **G11:** **Fork worktrees default to a sibling folder** `../<repo>-<branch>`
  (recommended, approved); path editable in the dialog.
- **G12:** **Merge back = merge + optional cleanup** (recommended, approved):
  `git merge <fork-branch>` in the root checkout, then offer "remove
  worktree + delete branch". Conflicts switch the view to the root checkout
  and use the banner's Abort.
- **G13:** Long-running ops stream stderr progress via `git-op-progress`
  events, 10-minute ceiling, cancellable; one op at a time (SP1's `busy`
  gate). Credentials are never prompted (GIT_TERMINAL_PROMPT=0) — SSH agent
  and credential helpers work as in the terminal; anything else fails with
  git's message.
- **G14:** Checkout never auto-stashes; git's refusal is shown verbatim.

Sections approved as presented: SP2 backend; SP2 UI (toolbar trio + badges,
remote dropdown, op bar, banner buttons, collapsible sidebar sections,
stash view); SP3 worktrees (switcher, linked-gitdir watcher fix, fork
dialog + agent spawn, merge back, remove/prune); testing + build order
(two plans, executed back-to-back on the SP1 branch so the whole Git tab is
smoke-tested once).

Spec: `docs/superpowers/specs/2026-08-20-git-tab-sync-worktrees-design.md`.

## Execution notes — SP2 + SP3 (sync/branches/stashes, worktrees; 2026-08-20)

Both shipped on the SP1 branch `worktree-git-tab-local-changes` so the whole
Git tab is smoke-tested once. Rust: 49 git tests (17 new, incl. an offline
bare-remote fetch/pull/push round-trip and a cancellable hung fetch via the
`ext::` transport); Vitest: 525 total (11 new store/helper tests).

Deviations / notes:

- `stash list --format` uses `%x00` for NUL (log-style formats), not
  for-each-ref's `%00` — caught by the first real-repo test.
- The cancel test can't use `sh -c '…'` through `ext::` (git splits the
  command on whitespace); it writes a sleeper script instead.
- `gitdir_for` canonicalises both paths (macOS `/var` → `/private/var`).
- The op bar shows the last stderr line only (no percentage parsing); git's
  own progress strings are informative enough.
- Worktree "Remove" of the selected worktree switches the view to the root
  first; the main worktree row has no remove/merge actions.
- `GitDiscardDialog` grew `confirmLabel`/`cancelLabel`/`skipLabel` and now
  serves every destructive confirm (branch delete, stash drop, worktree
  remove, merge-back cleanup).

## SP4 decisions (2026-08-21)

- **G15:** **All branches by default** (recommended, approved): `git log --all
  --topo-order`, 300-commit pages with Load more; a persisted toggle narrows
  to the current branch.
- **G16:** Commit actions (owner picked all four): checkout detached + new
  branch here; copy SHA/message; cherry-pick + revert (in-progress banner
  gains cherry-pick/revert kinds with Abort/Continue); reset soft/mixed/hard
  behind a dialog where *hard* requires typing the short SHA.
- Sections approved: log backend + lane model; UI/actions/testing. The graph
  replaces the middle column and the commit detail replaces the diff column
  while "All Commits" is selected; per-file diffs reuse the SP1 viewer
  read-only.

Spec: `docs/superpowers/specs/2026-08-21-git-tab-history-design.md`.
