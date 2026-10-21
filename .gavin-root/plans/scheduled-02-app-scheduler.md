---
kind: task
title: Scheduled tasks: app scheduler + headless fire
parent: feat-scheduled-tasks-plans.md
complexity: complex
---
Build the app side that fires Scheduled tasks. Requires `scheduled-01-daemon-protocol.md` landed. Read the parent card `feat-scheduled-tasks-plans.md` (Settled design) and ADR 0010 first.

Do:
- A pure module `app/src/lib/scheduling/schedule.ts` with unit tests: next fire on the fixed grid (absolute time, never a countdown), due-now, collapse of fires missed while closed into one, completed after n, paused, single shot, indefinite, "Run now" not counting.
- A scheduler beside the rail one (`startScheduler` in `orchestration/orchestrationState.ts`): it ticks only in the window that `runsRailsFor` the workspace, and never in the Companion bundle. When due: check skip reasons (previous run of this task still alive, pause wall, memory wall, resolved agent has no `headless_args`), claim fire k at the daemon, and only on success launch; record skips with their reason.
- Launch headless via the commit-via-agent seam (`prepareCursorAgentLaunch(..., "headless")` + `buildHeadlessCommand` in `cards/cardRun.ts`, see `git/gitState.ts` `launchAgentCommit`), in the workspace's main checkout, with the copy's agent/model/effort/complexity resolved the way a card Run resolves them. No visible tab, no "finished" notification. Record the run (session id, report path) on the fire row so the tab can show its live terminal, and adopt it after an app restart the way `adoptAgentCommits` does.
- Prompt: a new `DEFAULT_RUN_SCHEDULED` in `agents/actionPromptDefaults.ts`, editable like the others: "scheduled run #k of <name>", the body inlined, and the Run report contract — write `<report path>` with a first-line `# <result headline>`, what you did, what changed (files, commits), what needs the human. Unit-test the composer.

Done when `cd app && npm test && npm run check` are green.

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
