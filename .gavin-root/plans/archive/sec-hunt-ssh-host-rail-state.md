---
order: 58368
kind: task
title: "[sec-hunt] Finish the blocked audit unit: what the desktop's rail scheduler does with orchestration state an ssh host supplies"
status: Done
priority: low
complexity: complex
labels: security, ready-for-agent
---
Finish a coverage unit the 2026-10-15 security audit (run-1) could not close. Its hunter was stopped partway through, so the unit has no disposition: it is neither a finding nor cleared. This card is the rest of that hunt. Coverage id: `app%2Fsrc-tauri%2Fsrc%2Fsession.rs%23route_for_workspace::app%2Fsrc%2Flib%2Forchestration%2ForchestrationState.ts%23readFileForViewer::app%2Fsrc%2Flib%2Forchestration::AI-AND-LLM.md%23Tool%20and%20action%20attack%20classes`.

Full record: the unit's entry in `coverage-ledger.json` and REPORT.md §6 in `~/security-audit-skill/gavin/run-1/`, outside this repo. The audit card is `review-security-audit-2026-10-15.md`.

## The unit

For an ssh workspace, the orchestration (rails, rail-run state, the tool library) lives on the HOST's daemon, and the desktop's rail scheduler consumes it. The boundary is an ssh host's daemon, or an agent on that host writing rails through the host's gavin-mcp, against the local desktop: does host-chosen state make the desktop launch work, read local files, or act on local workspaces, without the human asking for it?

## Open questions

1. **Zero-click launch.** Can a rail step on an ssh workspace launch with no click on the desk, because the host's store says the rail is `running`? If so, where does it run (on the host, through the link, or locally), and with what command?
2. **Local reads and local actions.** Which local-disk reads does the scheduler make for paths the host chose (`step.cardPath`, a retry source's `source.path`), and can a host-supplied workspace id in `OrchestrationChanged`, `ToolsChanged` or `GavinTreeChanged`, or a `builtin:start-rail` step's workspace parameter, make the scheduler read or act on a LOCAL workspace?
3. **The review gate.** How do the first-run review (`cardReviewed`, the step stall) and the workspace's `requireReview` setting apply on this path, and what reaches an agent when review is off?

## What is already known

- Settled by the hunter: `untilLogPath` reduces the step id to `[A-Za-z0-9_-]` (`app/src/lib/orchestration/orchestrationLoop.ts:116-129`), and a local read of that path is confined by `allowed_roots` (`app/src-tauri/src/fileviewer.rs:86`, `:200`), so the host cannot use it for traversal.
- `get_orchestration`, `set_orchestration` and `set_rail_run` go to the host through `route_for_workspace` (`app/src-tauri/src/session.rs:7007`, `:7029`, `:7075`; `app/src-tauri/src/remote.rs:1344`). `OrchestrationChanged`, `GavinTreeChanged` and `ToolsChanged` from the link are emitted into the webview with the workspace id as given (`app/src-tauri/src/session.rs:5522-5535`, in attach_and_relay).
- Rail-run state is daemon-stored; `setRailRunAction` writes it (`app/src/lib/orchestration/orchestrationState.ts:604`), so on an ssh workspace the host's store decides which rails are armed. `startRail` refuses only while `sshLaunchBlocker` answers (`orchestrationState.ts:841`), which is only a link that is down or a host daemon older than v40 (`app/src/lib/workspace/sshWorkspace.ts:130`, `FEATURE_MIN_VERSION.sshCardRuns = 40` in `app/src/lib/core/daemonCompat.ts:371`). Whether `tick` or `executeLaunch` asks the same question was not traced.
- `tick` runs for every loaded workspace in the window `runsRailsFor` names (`orchestrationState.ts:2162`; `app/src/lib/shell/appDuty.ts:131`).
- Local reads on host-named paths: `executeLaunch` reads `step.cardPath` (`orchestrationState.ts:1598`) and then stalls on an unreviewed card (`:1615-1621`); `retryNoteFor` reads `source.path` (`:1172`) and puts the content in the prompt; `readCheckLog` reads `untilLogPath` (`:1134`). `read_file_for_viewer` goes to the link only when the path is textually under an ssh root, and reads the local disk under `allowed_roots` otherwise (`app/src-tauri/src/fileviewer.rs:192-200`).
- The needs-validation lead "An ssh host's daemon can name a LOCAL file as a card, which the desktop reads from its own disk and sends back to the host inside the agent prompt" (`NEEDS-VALIDATION.md`) is this unit's click-driven sibling: it traced the Run, Resume, Re-launch and Develop paths and left the rail path to this unit. If question 1 comes out "yes", that lead loses its human click whenever review is off.

## Method

Source trace first: follow `tick` -> `runTick` -> `executeLaunch` (and the tool-step launch) for an ssh workspace, and every place a host-pushed workspace id is used as a key into local state. Then confirm what the trace says against an isolated daemon under a temp `$HOME` (its own socket and databases; see the CLAUDE.md note on the daemon), standing in for the host, with a vitest that drives the scheduler over a backend mock forwarding `readFileForViewer` to the real `fileviewer` logic. Never use the live daemon, never `pkill gavin-daemon`, and never point a real ssh link at anything but a disposable host or a fixture.

## Outcome

For each root cause you confirm, file a `sec-fix-<slug>.md` card in the shape of the confirmed audit cards (`sec-fix-relaunch-review-gate.md` is a good model), with a failing regression test named in its Fix. For each question that holds, record the evidence under a dated "## Comments" heading on this card: the code path, the line, and the test or observation that shows it.

## Done when

- Each of the three open questions has an answer on this card, backed by a source trace and, where the answer is "it holds", a test or an isolated-daemon observation.
- Every confirmed root cause has its own `sec-fix-*` card, linked from the Comments.
- Nothing was run against the live daemon or a real host.

## Comments

### 2026-10-19 — answers to the three open questions

Source trace in this worktree; vitest observations only (no live daemon, no real ssh host). Line numbers as of this date — re-read before editing.

#### 1. Zero-click launch — **yes, on the host**

A rail whose host-stored `railRuns` row is `running` is launched by the desktop scheduler with no Start click on the desk.

- `tick` → `runTick` → `executeActions` → `executeLaunch` (`orchestrationState.ts` `tick` / `executeActions` / `executeLaunch`). `tick` and `executeLaunch` do **not** call `sshLaunchBlocker`; only human `startRail` does (`:838-844`).
- `setRailRun` / `get_orchestration` for an ssh workspace go through `route_for_workspace` to the host. Host `gavin_start_rail` (or any host write of the run row) is enough to arm.
- Sessions are created with `createSessionOnRailPage` → `create_session` → `route_for_root(workspaceRootPath(ssh workspace))` → `Route::Remote`: the agent or tool command runs **on the host** through the link (`session.rs` `create_session`).
- Observation: `orchestrationState.test.ts` describe `a rail armed from outside the app (a push carrying run state)` — `adopts the running row and launches the rail's first step` and `starts it in a workspace the scheduler is not ticking` both reach `createSessionOnPage` after an `orchestration-changed` push with `railRuns: running`, with no `startRail` call. Re-ran 2026-10-19: pass.

This path is the intentional half of `gavin_start_rail` (daemon writes the row, desk adopts and ticks). It is not filed as its own fix; it is the precondition the other two questions hang on.

#### 2. Local reads and local actions — **partial; two root causes filed**

**Local-disk reads of host-chosen card paths (the sibling lead's rail half): does not hold after `sec-fix-ssh-tree-card-paths-under-root`.**

- `executeLaunch` looks up `step.cardPath` in `gavinTrees[workspaceId]` first and stalls with "card file is missing" if absent (`orchestrationState.ts` `:1558-1561`), then reads with `readFileForViewer(step.cardPath)` (`:1611`).
- Host trees are confined at the desk: `confine_host_tree` (`session.rs`) drops paths outside the ssh workspace root and drops trees for non-owned workspace ids. So a host-named local absolute path never becomes a tree card id, the index miss stalls the step, and the local read is not taken for launch.
- `retryNoteFor` / `readCheckLog` only read `untilLogPath` (sanitised temp path, `orchestrationLoop.ts` `:116-129`) or a PR report — not an arbitrary host path. Settled by the earlier hunter.

**Host-supplied workspace ids in pushes — holds for OrchestrationChanged and ToolsChanged.**

- `GavinTreeChanged` is confined; `OrchestrationChanged` and `ToolsChanged` still emit the host's `workspace_id` as given (`session.rs` attach_and_relay arms) and the listeners key on it (`initOrchestrationListeners`, `initToolListeners`).
- Observation: `orchestrationState.test.ts` `applies a push under whatever workspace id the payload names` — a push naming `ws-local` (never fetched) stores the hostile `railRuns: running` plan and reaches `createSessionOnPage` for that local workspace. Pass 2026-10-19.
- Fix card: [`sec-fix-ssh-orch-tools-push-workspace-id.md`](sec-fix-ssh-orch-tools-push-workspace-id.md).

**`builtin:start-rail` workspace parameter — holds.**

- `executeGavinAction` → `startRailTargetWorkspace` accepts any open workspace id; `startRail` on a local target is not blocked by `sshLaunchBlocker`.
- Observation: existing test `a gavin action can arm a rail in a workspace of its own choosing` — step on `ws-1` with `workspace: "ws-2"` calls `setRailRun` on `ws-2`. Pass 2026-10-19.
- Fix card: [`sec-fix-ssh-start-rail-local-workspace.md`](sec-fix-ssh-start-rail-local-workspace.md).

#### 3. The review gate — **stalls when on; silent when off**

- `executeLaunch` reads the card file, then calls `cardReviewed(workspaceId, step.cardPath, { title, body, attachments })` (`orchestrationState.ts` `:1627-1635`). On false it `stallLaunch`s with `unreviewedStallReason` — no modal (a tick has no one to ask).
- `cardReviewed` (`layoutState.ts`) returns **true unconditionally** when the workspace's resolved `requireReview` is off (`resolveRequireReview` / `requireReviewDefault`). So with review off, the host-armed zero-click path above sends the card body (or tool command) to the host agent with no sheet and no stall.
- Observation: `orchestrationState.test.ts` `stalls a step whose card nobody has read, instead of launching it` — with `cardReviewed` false, no `createSession*`, step `stalled` with `UNREVIEWED_STALL`. Pass 2026-10-19. Combined with Q1, review-off is what makes the sibling local-file lead's zero-click concern real **on the host's own cards**; after the tree confine, that is host→host content, not a local-disk read.

No separate fix card for the gate itself: it already enforces AG-01 on the rail path when review is on. The filed findings are about host state reaching local workspaces, not about weakening the stall.
