---
kind: task
title: [fix] a rail armed without Start runs on the workspace's active page
status: Done
priority: high
---
Make a rail's own page a LAUNCH-time invariant instead of an arm-time one, so a rail's sessions land on a page named after the rail however the rail came to be running.

What happened (Grimoria workspace, 2026-09-03): the orchestrating agent found no start action in the MCP and armed five rails by writing `SetRailRun { state: "running" }` straight to the daemon socket (its transcript at 14:03:31, its own conflict note `n-armed-via-socket`, and a paragraph in its project memory saying to do it again). The app adopted those run rows through `refreshOrchestration` when the Orchestration tab mounted and ticked. Nothing on that path calls `ensureRailPage`, so every rail kept `pageId: null`; `createSessionOnPage(null)` fell through to `createSessionForCard`, which appends to the workspace's ACTIVE page. Result: 0 rail pages, `page_id` NULL for all six rails in `orch_rails`, and 20+ agent tabs stacked on "Page 1". The worktrees existed, the app was current, and `ensureRailPage` is correct — it was simply never reached.

Why it is a real gap and not just the agent's fault: `ensureRailPage` is called from exactly two places, `startRail` and `resumeRail` (app/src/lib/orchestrationState.ts). A run row can also reach the store via `refreshOrchestration`, via `fetchOrchestration` on a fresh store (a rail left running across an app restart), or via the `orchestration-changed` push when the workspace was not loaded yet — and once a rail is running with no page, every later launch on it (advance to the next stage, `retryStep`, `resumeStep`, auto-resume) inherits the fallback. Spec O16 says "only an unbound or closed-page rail gets a fresh one", which is the right rule; it is just enforced at the wrong moment.

Read first: `ensureRailPage`, `startRail`, `resumeRail`, `executeLaunch`, `executeToolLaunch`, `resumeStep` in `app/src/lib/orchestrationState.ts`; `pageToSpawnForRail` in `orchestration.ts`; `createPage` / `createSessionOnPage` / `createSessionForCard` in `layoutState.ts`; spec §4.1 "Arming spawns the rail's page (O16)" and §4.3 step 4 in `docs/superpowers/specs/2026-08-21-orchestration-tab-design.md`.

Behaviour:
- Before each of the three `createSessionOnPage` call sites (card launch, tool launch — not the `gavin` kind, which has no session — and step resume), call `ensureRailPage(workspaceId, rail.id)` and then RE-READ the rail from the store before passing `rail.pageId`: the binding is an optimistic `mutatePlan`, and the `rail` captured at the top of the function is stale. One helper for "page, then session" so the three sites cannot drift.
- Keep the existing calls in `startRail` / `resumeRail`: the chip should name the page before the first tick, as today.
- `ensureRailPage` already answers null when the bound page still exists and dedupes on `spawningPages`; keep it non-fatal (spec §4.3: a failed page creation still launches onto the fallback and never stalls the step).
- No protocol change and no daemon change, so no `FEATURE_MIN_VERSION` entry.

Tests (`orchestrationState.test.ts`): a rail whose run row arrives as `running` with `pageId: null` without ever passing through `startRail` launches its first step onto a page named after the rail and binds it; the rail's second launch reuses that page; a rail whose page was closed gets a fresh one at the next launch; a page creation that fails still launches the step onto the fallback and leaves the run row `running`.

Also: reword spec O16 and §4.1 so the page is made "at arming, or at the first launch of a rail that was armed some other way"; add a smoke item to `smokeChecklist.ts` (arm a rail by writing `SetRailRun` to the daemon socket while the workspace is active, confirm the step lands on a page named after the rail).

Out of scope: an MCP start-rail tool (a protocol addition — file separately if wanted); moving Grimoria's existing tabs (the human can drag them).

Done when: the new tests are green, `cd app && npm test && npm run check && npm run build` pass, the spec and smoke item are updated.

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
