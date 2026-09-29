---
order: 7360
kind: task
title: Headroom 06: honest failures
status: Done
labels: ready-for-agent
parent: headroom.md
complexity: complex
---
Blocked by: headroom-02-compressed-launches-claude-code.md, headroom-05-savings.md

Part of `headroom.md`. Read the spec (section "Failures") first.

## What to build

- **A `headroom` failure cause.** It applies when a compressed session fails and Headroom fails its health check at that moment. Without it, the failure reads as `network`, and auto-resume retries into the same broken proxy across the whole fleet. Add it to `FailureCause` and `KNOWN_CAUSES` in `autoResume.ts`; an older build reads it as `unknown`, which never resumes.
- **Relaunch without Headroom.** Auto-resume relaunches a `headroom` failure uncompressed: the spawn carries an explicit "not compressed" override that the daemon's decision honours.
- **Not reaching Headroom.** A compressed session that finishes a turn while Headroom has seen no request tagged with its id is flagged. Use 05's per-session request count, or read `/stats` live.
- **The exception mark.** A tab mark in the `ui/indicators.ts` vocabulary (`StatusBadge`), shown only on a session in a compressed workspace that is not compressed. It names one of three reasons: Headroom was not ready, it failed and the session was relaunched without it, or the session is not reaching Headroom. A compressed session carries no mark.

## Acceptance criteria

- [x] The cause is classified `headroom` only when the session is compressed and the health check fails; otherwise the existing classification stands (tested)
- [x] Auto-resume relaunches a `headroom` failure uncompressed, and the new session carries the mark (tested)
- [x] A compressed session with zero Headroom requests after a finished turn gets "not reaching Headroom" (tested)
- [x] The mark is decided in a pure module and appears only in the three exception cases (tested)
- [x] `cargo test --workspace`, `npm test` and `npm run check` green
- [ ] Human test: After rebuilding the app and restarting the daemon (v50), and before Headroom is installed on this machine: turn compression on for a workspace and run a card with Claude Code. Its tab shows the Headroom mark (a grey shrink glyph) whose tooltip says Headroom was not ready. Once Headroom is installed and running, a new card run's tab shows no Headroom mark.

## Result (2026-09-29)

Done on branch `feat/headroom`, commit `c1de88b8`, on top of 05's `d946dd95`. Not pushed. Protocol **v50 (provisional)**.

Every check in CLAUDE.md is green on the committed tree: `cargo test --workspace` (daemon 875 with `gavin::tests`, app host 669, protocol 145, gavin-mcp 72, `headroom_sessions.rs` 26 of which 6 are new), `npm test` (7220), `npm run check` (0 errors), `npm run build`, and the Companion's three. The guards the new tests rest on were broken on purpose and seen to fail: the blame rule, the reach verdict's restart clause, the headroom prefix in the classifier, the run gate, and auto-resume's override.

### Where things are

- **The cause.** `failure_verdict` in `server.rs` asks `blame_headroom`: a compressed session (its registry row) whose Headroom fails `/readyz`, asked live on the daemon's port, gets gavin's own sentence, `Headroom stopped answering, …` (`HEADROOM_REASON_PREFIX`, pinned in Rust and in `autoResume.ts`). The app classifies the prefix as `headroom`. The agent's line is left OUT of that reason, so an app older than v50 reads `unknown` (never resumes) rather than `network` (resumes into the broken proxy).
- **The relaunch.** `headroom` resumes on reachability, and auto-resume passes `withoutHeadroom` to `resumeStep`/`resumeCard`, which send `CreateSession.without_headroom`. The daemon honours it ahead of readiness and records `headroom-failed`. It travels as one `LaunchProfile` value (`compression.ts`) down the same seams the profile already took, so no other launch changes its arguments. `FEATURE_MIN_VERSION.headroomFailures` (50) declines a `headroom` failure against an older daemon with that reason, and the host withholds the field besides. A queued card intent carries it across the launch wall.
- **Not reaching Headroom.** `headroomReachDriver.ts` asks `HeadroomReach` when a run's turn ends (working → idle). The daemon reads `/stats` live (`reach.rs`, pure): any request counted is `reached`, for good; nothing counted is `unreached` only from the Headroom process the session was pointed at, with its `per_project` map below its limit. Otherwise `unknown`, which marks nothing. The daemon keeps the verdict, so `SessionSummary.headroom_reach` carries it through a reload.
- **The mark.** `headroomMark.ts` (pure) decides it; `ui/indicators.ts` has a `headroom` axis; `Pane.svelte` draws it on the tab. What the daemon decided reaches the app with the session itself: `SessionCreated` and `AgentSessionSpawned` were widened, the host emits `session-compression`, and the session baselines carry all three facts.

### Decided here, where the card left it open

1. **"Finishes a turn" is a run's.** Only sessions bound to a card run or a rail step are asked about, because they were launched with a prompt. A terminal the human opened goes quiet after painting its welcome screen and whenever they pause mid-sentence, and a reopened conversation (resume, review) goes quiet once while its history paints; that first quiet is passed over.
2. **An absence has to be believable.** Headroom's own count loses sessions that did reach it: `per_project` evicts past 50, and a restarted Headroom forgot what it had not yet written (it writes every 25 requests). So **in a fleet past 50 tagged sessions this check stays silent.** The open Decision on `headroom-05-savings.md` covers the same source: its option B, `--log-file`, would make this check exact too.
3. **Two reasons are not marks.** `no-recipe` and `unsupported-agent` are uncompressed by design and Settings says so beside the agent's row. A mark also needs the workspace's switch on NOW, not only at launch.
4. **Glyphs.** Not ready is a neutral `Shrink`, relaunched a warning `Shrink`, not reaching a warning `RouteOff`: the vocabulary's own test requires the states of one axis to render differently.

The spec's "Failures" section now records these decisions too.

### Known limits

- **Only the daemon's own verdict can be Headroom's.** A profile with no failure table (Codex, opencode, custom) is never called failed by the daemon; its failures come from the TypeSafe turn verdict and stay `network`/`unknown`. A relaunch of one is still decided afresh against Headroom, which catches a Headroom that is down.
- **A mark from another window arrives on reload.** The verdict is asked by the window that runs the workspace's rails; other windows read it from the baselines.
- **02's open Decision** (should a launch say so when the daemon is too old) is still open; its option B would be a fourth reason here.

### For the merge

v50 is provisional. Five places move together: `PROTOCOL_VERSION`, `HEADROOM_FAILURES_MIN_VERSION`, the `min_version_for` arm for `HeadroomReach`, the band test's `50 => 1`, and `FEATURE_MIN_VERSION.headroomFailures`.

<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->
