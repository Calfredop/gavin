---
complexity: moderate
order: 6144
kind: plan
title: [feat] scheduled tasks/plans
status: In Progress
---
Allow in the task/plan card to add a schedule, with both single shot and repeat n (where n= 2 -> indefinite). This kind of tasks should reside in a dedicated tab. Each normal task or plan card (archived ones too) can be “promoted” to this kind of tasks. Scheduled items should be executed silently, but with an accessible last session terminal, in a similar way the Review and Decisions tabs do. A few concepts for the ui:
- last run
- total runs

## Settled design

Read `docs/adr/0010-a-scheduled-task-is-a-copy.md` and the Scheduling terms in `CONTEXT.md` (Scheduled task, Fire, Run report) first.

- **A Scheduled task is a copy.** "Schedule…" on a task card (on the board, in `done/`, or archived; a nested task loses `parent:`) writes `.gavin-root/scheduled/<name>.md`: the body, plus `title`, `agent`, `model`, `effort`, `complexity` copied over, `from: <source card file name>`, `schedule:`, `paused:`. Committed; outside `plans/`, so the board and tree never see it. The original card is untouched; nothing syncs. "New scheduled task" writes one from scratch. Plan cards are refused: "plans can't be scheduled yet".
- **Schedule rule**: a start date-time (machine local), an optional "every N minutes|hours|days|weeks" (minimum 1 minute), and a run count: 1 (single shot), n, or indefinite. Next fire = start + k·interval on a fixed grid, never a countdown. Fires missed while the app was closed collapse into ONE fire on relaunch.
- **Fired by the app**, like the rail "At a date and time" trigger (`startScheduler`, `runsRailsFor`): nothing fires with the app closed. The Companion never fires (ADR 0003). The daemon arbitrates: a fire launches only if an atomic "claim fire k" succeeds, because the dev and release apps share `kanban.sqlite`. The claim is where the fire count increments.
- **Skipped fires** (previous run still going, pause wall, memory wall, agent has no headless mode) are recorded with the reason and count toward n. Never queued, never two runs at once. "Run now" does not count toward n.
- **Silent = headless**: `buildHeadlessCommand` via the commit-via-agent path, in the workspace's main checkout (a branch or worktree, if needed, is the task body's business). No "finished" notification. The run is recorded in run history. If the resolved agent has no headless argv, the Schedule dialog offers a picker of agents that do and writes the choice as `agent:` on the copy; if none do, scheduling is disabled with the reason. Re-checked at every fire.
- **Run report**: the prompt names a path, `.gavin-root/scheduled/runs/<name>/<YYYYMMDD-HHMMSS>.md` (`runs/` gitignored, last 20 kept per task), and asks for a first-line `#` result headline, what it did, what changed (files, commits), and anything that needs the human. The headline is the tab's "Last run result". If the agent writes none, the run reads "no report" and the daemon's saved raw terminal output stands in.
- **Scheduled tab** (workspace hub): rows with last run, last run result, total runs, next run, and status. While a run is going, its live terminal shows in a `ReviewAgentPane`. Controls: Edit schedule, Pause/Resume, Run now, Open report, Open card (a file link that still works once the source is archived; it reads "gone" only when the file no longer exists), Duplicate, Delete, Unschedule. A failed run puts a dot on the tab, not on the Decisions inbox.
- **Companion**: a Scheduled surface with the same list, controls and last report view.
- **Out of scope**: ssh workspaces, cron syntax, firing with the app closed, per-run worktrees, scheduling plans.

## Checklist

- [x] Daemon + protocol: the scheduled store, fire claim, run records, report pruning (child `scheduled-01-daemon-protocol.md`)
- [x] App scheduler: due logic and the headless fire (child `scheduled-02-app-scheduler.md`)
- [x] Scheduled hub tab and the Schedule dialog (child `scheduled-03-hub-tab.md`)
- [x] Companion Scheduled surface (child `scheduled-04-companion.md`)
- [ ] Human test: Schedule a task card (one archived card too) one minute ahead, single shot: it runs with no tab appearing; the Scheduled tab then shows last run, its result headline, total runs 1 and the report, and the source card is still where it was
- [ ] Human test: Schedule a task every 2 minutes ×3: it fires three times then reads completed; Pause stops the next fire, Run now runs without changing the count, and a run still going when the next is due shows that fire as skipped
- [ ] Human test: With the dev and release apps both open on this workspace, a scheduled fire launches once, not twice
- [ ] Human test: On the Companion, the Scheduled surface lists the same tasks, Pause/Run now/Delete act on the desk, and the last report opens
- [x] Decision: What may a scheduled run do unattended? The commit agent's headless argv grants Claude Code git only, which cannot even write the Run report. Built now: Claude Code gets `--permission-mode acceptEdits` plus git (edit files, run git, no other shell); codex/gemini/cursor keep their headless grants; opencode is not offered (its headless mode is the git-only commit agent).
  Options: A) Keep it: edit files + git only B) Widen Claude Code to any shell command (--allowedTools Bash) C) Bypass all permissions for scheduled runs D) Give opencode a scheduled-run agent definition too
  Answer (2026-10-21): Keep it: edit files + git only

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
