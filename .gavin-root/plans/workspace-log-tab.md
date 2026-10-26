---
kind: task
title: Workspace log: the Log tab
parent: feat-backlog.md
complexity: moderate
---
Build the desktop **Log** tab described on the parent card `feat-backlog.md`. Needs `workspace-log-journal.md`'s protocol; it can run in parallel with the git card. Logic goes in a plain `app/src/lib/log/workspaceLog.ts` with unit tests; `WorkspaceLogHubView.svelte` stays a thin template over it.

1. **Register the tab:** `log`, label "Log", `requiresRoot: true`, after Scheduled, in `app/src/lib/hub/hubViewMeta.ts` and `workspaceViews.ts`, with a lucide icon (e.g. `ScrollText`).
2. **Pure module:**
   - one sentence per kind ("Card *[feat] x* moved To Do → In Progress", "Rail *api* paused", "Commit on *feat/x* in *wt-api*: <subject>", "Decision answered on *[feat] x*")
   - day grouping in the machine's time zone
   - kind filter state (Cards · Runs · Rails · Human items · Scheduled · Git, all on)
   - merging live pushes into a paged list
   - a card's openability: found by file name across `plans/`, `plans/done/` and `plans/archive/`; not openable once any entry about it is a delete
   - a "noticed on start" marker
3. **View:**
   - newest first with day headers, each row with time, kind icon, sentence, and the card or rail as a link
   - a multi-pick filter dropdown like the Activity calendar's
   - text search (sent to the daemon's query: card/rail names, git branches and worktrees)
   - older pages loaded on scroll
   - live pushes while the tab is open
   - card links use `openRunCard` (`app/src/lib/activity/activityNav.ts`); a deleted card's row is plain text that says it is gone
   - async results guarded with a token counter, not identity (Svelte 5 proxies)
4. **Clear older than…** menu (1 month · 3 months · 6 months · 1 year · Everything), confirmed with `askConfirm` as `danger`; the button names the action.
5. **Gate** every request through `featureBlockedReason` with the v79 `FEATURE_MIN_VERSION` entry. An older daemon shows a "restart the daemon" message, not an empty list.

Run `cd app && npm test && npm run check && npm run build`. The rendered surface is the parent's human test, not yours.
