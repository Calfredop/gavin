---
order: 11264
title: Per-run Changes view
status: Done
priority: high
---
Show what a specific card run changed, live, as a diff from the commit the run started on — and let the human discard that run's changes from the same baseline.

Today the Git tab is one checkout per workspace (`gitState.ts`) and nothing links a session or a card run to a diff. Record the HEAD sha when a card run starts (the run row), then surface "Changes" on the card detail modal and the tab bar, scoped to the run's worktree. A "Discard this run" action resets that worktree to the baseline, which is Cursor's checkpoint restore done with git.

Borrowed from Cursor's live agent diff + checkpoints (2026-09-03 feature scan).

## Decided

- **The baseline lives on the CARD binding, not on the step run.** `card_sessions`
  already carries a run's `launch_cwd`, `conversation_id` and `resume_attempts`,
  and a rail's card step writes one through `linkCardSessionAction` exactly like a
  board Run does — so one column, `base_sha`, gives every card run a baseline
  including the ones a rail started. `StepRun` is left alone: a tool step has no
  card, and neither named surface (the card modal, the tab chip) can reach one.
- **The sha is recorded at LAUNCH, by the app, in the run's launch cwd.** It cannot
  be recovered afterwards — the first thing an agent does is move HEAD or dirty the
  tree — so a run with no sha has no Changes view, and says so rather than guessing.
- **Resume carries the baseline; Re-launch mints a fresh one.** Same rule, same
  reason as `resumeAttempts`: a resume is the same run continuing, a re-launch is
  "run this again from the beginning".
- **A claim must not wipe the run's record.** `ClaimCardForSession` re-links with
  `None` for every run field today, so an agent writing In Progress on the card its
  own gavin-launched session is running erases the conversation id, the launch cwd
  and the resume budget. It has to carry the held row's values through, or the
  baseline would be the fourth field a status write silently destroys. A claim with
  NO prior binding gets HEAD resolved daemon-side from the session's cwd — that is
  the only baseline available for work the workspace agent picked up itself.
- **The diff is `git diff <base>` in the run's worktree, plus untracked.** Staged and
  unstaged together: the human is asking "what did this run change", not "what is
  indexed". Commits made since the baseline are counted, because they are part of
  the answer and the whole of what Discard would drop.
- **Discard is `git reset --hard <base>`, and untracked files go to the Trash.**
  The reflog can recover a dropped commit; nothing recovers a `git clean`. The one
  destructive half of this feature therefore reuses `workspace_delete.rs`'s
  `trash_path` (NsFileManager, no Finder), the same choice the delete wizard made.
- **Discard refuses while the run's agent is live.** Resetting a checkout under a
  working agent is the one way this action destroys work nobody asked it to touch —
  `developCard` already refuses on the same evidence.
- **`FEATURE_MIN_VERSION.runChanges` is the only gate there is.** `base_sha` widens
  an EXISTING request (`LinkCardSession`), which `min_version_for` gates by TYPE and
  cannot see: an older daemon parses the launch fine and drops the sha, leaving a
  Changes button that would diff against nothing. So the LAUNCH refuses to resolve a
  sha against an older daemon (`baseShaForLaunch`, mirroring
  `conversationIdForLaunch`), and both surfaces say why instead of offering a view
  that cannot work.

## Out of scope

- **Tool steps and the workspace main agent.** Neither writes a card binding, so
  neither has a run to scope a diff to. `StepRun.base_sha` can be added later
  without moving anything decided here.
- **Run history.** One live binding per card is one baseline; "every run this card
  ever had" is `feat-card-run-history-cost.md`.
- **Staging, committing or line-level actions in the run view.** It is a read-only
  diff plus one destructive button; the Git tab is where a checkout is edited.
- **Watching the worktree.** The view fetches when it opens and on an explicit
  Refresh. A per-run file watcher for a fleet of agents is a poller nobody asked
  for, and the Git tab's watcher is scoped to the workspace checkout.

## Steps

- [x] `PROTOCOL_VERSION` 26: `CardSession.base_sha` (`serde(default)`) and
      `Request::LinkCardSession { base_sha }`, with the version comment saying why
      the wire gate is structurally blind to it. `min_version_for` is untouched —
      this widens a request, it does not add one.
- [x] Daemon: `card_sessions.base_sha`, added by ALTER as well as in
      `CREATE TABLE` (a column only in the CREATE never reaches an existing
      database), read in `get_board` / `card_session`, written in
      `link_card_session`, threaded through the `server.rs` handler. Tests: a
      pre-v26 database opens and still loads a board; a binding round-trips its sha.
- [x] `claim_card_for_session` carries the HELD binding's `conversation_id`,
      `launch_cwd`, `resume_attempts` and `base_sha` through instead of NULL, and
      resolves HEAD in the session's cwd when there is no prior binding (a
      `head_sha` helper beside `resolve_repo_root` in `git_status.rs`). Tests: a
      claim over a gavin-launched run preserves all four; a first claim records a
      sha; a claim outside a repo records none and still binds.
- [x] Tauri `git_run_changes(cwd, baseSha)` → `RunChanges { root, baseMissing,
      notARepo, files, added, removed, commits, baseSubject }`: `git diff
      --name-status -M <base>` for tracked, `ls-files --others --exclude-standard`
      for untracked, `--shortstat` for the counts, `rev-list --count <base>..HEAD`
      for the commits. A baseline whose object is gone from this checkout answers
      `baseMissing` rather than an error string nobody can act on.
- [x] Tauri `git_diff_since(cwd, baseSha, path, oldPath, untracked)` → the existing
      `FileDiff`, so `diffRows.ts` and `GitDiffUnified` render it unchanged.
- [x] Tauri `git_discard_run(cwd, baseSha, untracked)` → per-path outcomes:
      `reset --hard <base>` first, then each untracked path to the Trash via a
      `trash_path` lifted out of `workspace_delete.rs` into a shared helper. One
      failure does not abort the rest; a missing baseline object refuses outright.
      Rust tests over `testutil::temp_repo`: commits and edits since the baseline
      are gone, an untracked file is trashed and not deleted, a path outside the
      repo root is refused.
- [x] `FEATURE_MIN_VERSION.runChanges = 26` and `baseShaForLaunch(cwd)` in
      `layoutState.ts`: null when the daemon is too old, when the cwd is in no repo,
      or when HEAD is unborn — the same two-gate shape as
      `conversationIdForLaunch`, and for the same reason.
- [x] Every card launch records one: `launchCard` (run mints, resume carries
      `binding.baseSha`), `relaunchCard` (fresh), `executeLaunch` and `resumeStep`
      in `orchestrationState.ts`. `backend.linkCardSession`,
      `linkCardSessionAction` and the `CardSession` type in `kanban.ts` gain the
      field. Tests in `cardRunActions.test.ts` / `orchestrationState.test.ts`.
- [x] `runChanges.ts` — the pure module: `runBaseline(binding, compat)` (the sha and
      cwd, or the reason there is none), `changesSummary` / `changesProblem` (a state
      with an explanation never reduces to a count), `discardBlockedReason` and
      `discardPrompt`, the accounting the confirm shows (files, commits,
      untracked-to-Trash). Unit tested.
- [x] `runChangesState.ts` — the store: fetch a card's summary, fetch one file's
      diff, run the discard, each guarded by a token counter (a `$state` proxy makes
      identity comparison useless) and keyed by card path.
- [x] `RunChangesModal.svelte` — baseline header (short sha, subject, worktree), the
      file list (`GitFileRow` in `readonly` mode), the diff (`toUnifiedRows` +
      `GitDiffUnified` with `canAct` false and no discard labels), Refresh, and the
      danger button. Mounted from the card detail modal and the tab chip.
- [x] The card detail modal's Agent session section gains a Changes row: a button
      naming the baseline, or the quiet reason there is no baseline
      (`featureBlockedReason` for the daemon case). No count beside it, and for the
      same reason the chip carries none: a summary here would mean a `git diff`
      every time a card is opened, on a board where opening cards is the main verb.
      The counts live in the modal, where somebody asked for them.
- [x] `Pane.svelte`'s tab bar gains a Changes chip beside the card link, on the same
      `linkedCardFor` lookup — glyph and tooltip only, no counts, because a count on
      a chip means a git call per tab per render.
- [x] The discard flow: `askConfirm` (no native dialogs) with the accounting and a
      `danger` choice, the live-agent refusal ahead of it, and a refresh of the run
      view afterwards. The Git tab needs no call of its own: its `git-changed`
      watcher fires on the reset, which is exactly what that watcher is for.
- [x] `smokeChecklist.ts`: run a card in a worktree, let the agent edit and commit,
      open Changes from the tab chip and from the card modal, discard it and confirm
      the commits are gone from the branch and the new files are in the Trash; and
      the same card against a v25 daemon showing the reason instead of the button.
- [x] `cargo test --workspace` and `cd app && npm test && npm run check && npm run
      build` green in this worktree.
