---
complexity: moderate
order: 7168
title: [feat] Workspace log
status: In Progress
---
A new tab for the workspace, where activity is shown in a log. For example: new card created, card
deleted, card archived, rail created, rail started, review done, decision taken...

A **Workspace log** (see `CONTEXT.md`) — one **Log entry** per thing that happened, recorded by the
daemon as it happens. Why it is recorded rather than derived like Activity: `docs/adr/0011-the-workspace-log-is-recorded-as-it-happens.md`.

Settled in development (do not re-litigate):
- Tab **Log** on the workspace hub, after Scheduled, offered only to workspaces with a bound root. Desktop only.
- Stored in a new table in `kanban.sqlite`. It starts empty when it ships; `card_runs` is copied in once, when
  the table is first opened, and runs are journaled from then on.
- Entries:
  - Cards: created · deleted · archived · moved column (incl. Done) · title changed
  - Card runs: started · finished
  - Rails: created · started · paused · resumed · finished · failed · deleted
  - Human items: decision filed · decision answered · human test filed · passed · failed
  - Scheduled tasks: fired
  - Git: reflog lines of the main checkout and every worktree (commit, checkout, merge, pull, rebase,
    reset, push), each tagged with its branch and worktree, plus branch deleted
  - Not logged: checklist ticks
- Card and human-item entries come from the `.gavin*` watcher diffing each workspace's cards (path, title,
  status, human items) against a last-known snapshot, so every writer is caught. The diff also runs at
  startup; anything changed while the daemon was down is stamped when it is noticed and marked "noticed
  on start".
- Rail and scheduled entries come from the daemon code that performs them. Git entries come from new
  reflog lines read when the `.git` watcher wakes; branch deletion is reported by the host, because it
  leaves no reflog line.
- No "who" column. Only run entries name their agent.
- Card-related entries open their card, found by file name across `plans/`, `plans/done/` and
  `plans/archive/`, using the same jump as the inbox and the calendar. Once a card has a deleted entry,
  every entry about it says it is gone and cannot be clicked.
- Tab: newest first with day headers. Each row has the time, a kind icon, a one-line sentence, and the
  card or rail as a link. A multi-pick filter over Cards · Runs · Rails · Human items · Scheduled · Git, all
  on. Text search over card names, rail names, git branches and worktrees. Live push while the tab is open,
  older entries loaded in pages on scroll.
- Kept forever unless cleared: **Clear older than…** 1 month · 3 months · 6 months · 1 year · Everything,
  confirmed with `askConfirm` (danger). Clearing deletes log rows only, never `card_runs`.
- Out of scope: an app-hub log across workspaces, a Companion surface, feeding entries into the Activity
  calendar, a "who" column.

- [x] Journal, card/rail/human/scheduled entries and protocol v79 — `workspace-log-journal.md` (first)
- [x] Git entries — `workspace-log-git.md` (needs the journal)
- [x] The Log tab — `workspace-log-tab.md` (needs the journal's protocol; runs in parallel with the git one)
- [ ] Human test: In the running app (rebuilt, daemon restarted to v79), open a workspace's Log tab. Create, move, archive and delete a card, run a card, start and pause a rail, answer a decision, and commit in a rail worktree's terminal. Each appears live with the right sentence. The archived card still opens and the deleted one doesn't. The filter and the search (by a branch name) narrow the list, and "Clear older than… 1 month" removes only older rows.

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
