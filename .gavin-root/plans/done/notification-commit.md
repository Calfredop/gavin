---
kind: task
title: Notification commit
status: Done
---
# Notification commit

A "Commit via agent" run is hidden by design: no tab, no page, the Git tab's
button is the whole interface. That makes the Git tab the only place its
verdict lands — the "Committed" flash (4s, then gone) and the error banner
both live in `GitViewState`. A run started and then left alone announces
itself nowhere, which is the one thing a several-minute background job has to
do.

Fix: the verdict sends an OS notification, through `notifications.ts` — the
module that already owns "is this transition worth interrupting the human
for".

## Rules

- **Which events.** All three verdicts `watchAgentCommit` can reach: clean
  exit over a clean tree (committed), non-zero exit, clean exit that left the
  tree dirty. A run abandoned by a worktree switch, or dropped on adoption
  because its session is gone, reaches no verdict and so says nothing — same
  as today.
- **Which toggle.** The workspace's existing `notifyFinished` ("When a
  session finishes working"). A hidden run *is* a session finishing; a
  silenced workspace stays silenced. No third toggle for one button.
- **When suppressed.** Only when the gavin window is focused **and** that
  workspace's Git tab is the view on screen. This is the deliberate
  refinement of the session rule ("suppressed whenever gavin is frontmost"):
  there, any focused window means the status dot is visible; here, the
  verdict shows on exactly one tab, so being in the app on some other tab is
  the reported gap, not a reason to stay quiet.
- **What it says.** The notification is the pointer, the banner is the
  record — short bodies, detail stays in the Git tab.

## Checklist

- [x] `workspace.ts`: `hubViewIsOnScreen(state, workspaceId, viewId)` — the
      active workspace showing that hub view. Tests in `workspace.test.ts`.
- [x] `notifications.ts`: `AgentCommitVerdict` + `maybeNotifyAgentCommit`,
      owning the whole suppression rule (focused && on screen), the
      `notifyFinished` gate, permission, and the three bodies.
- [x] `notifications.test.ts`: the gate, the two-part suppression, the
      bodies, and no permission prompt for a suppressed or silenced one.
- [x] `gitState.ts`: fire it at the three verdict points in
      `watchAgentCommit`, with the workspace name as the label.
- [x] `gitState.test.ts`: each verdict notifies; an abandoned run does not;
      an adopted run notifies on the same path.
- [x] `SettingsHubView.svelte`: the hint under the toggles is now wrong
      ("Never shown while the gavin window is focused") — say what the
      commit verdict actually does.
- [x] `smokeChecklist.ts`: one item for the verdict arriving while the Git
      tab is closed.
- [x] `cargo test --workspace`, `npm test`, `npm run check`, `npm run build`.
- [ ] Commit (own files only) — held for the human, per the workspace rule
      that commits happen when they ask.

## Verified

The shared tree currently carries another session's `blankProbe` debug
edits to `layoutState.ts`, which fail 7 of its own tests, so the suites
were run in a detached worktree at `12967ab` carrying only this card's
eight files:

- `npm test` — 1427 passed, 71 files, 0 failed
- `npm run check` — 0 errors
- `npm run build` — clean
- `cargo test --workspace` — 210 + 265 pass; the daemon's `gavin::tests`
  and one socket-timing test in `session.rs` fail only under full-suite
  parallelism and pass per-module (86/86, 7/7). No Rust was touched.

Ready to commit: `notifications.ts`, `notifications.test.ts`,
`gitState.ts`, `gitState.test.ts`, `workspace.ts`, `workspace.test.ts`,
`smokeChecklist.ts`, `SettingsHubView.svelte`.
