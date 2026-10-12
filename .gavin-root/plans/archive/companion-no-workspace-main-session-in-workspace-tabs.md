---
order: 29696
kind: task
title: Companion: no workspace main session in workspace tabs
status: Done
---
<!-- gavin:auto-commit -->
When the implementation is done, commit it. Commit only the files you touched — never `git add -A`. Do not push.
<!-- /gavin:auto-commit -->

The owner's reading (2026-10-08): on the phone the Gavin workspace showed no WORKSPACE AGENT, and there was no way to start one.

Done: a rooted workspace's Sessions tab always has its WORKSPACE AGENT group, holding the agent or a "Start workspace agent" row. The start is `create_session` with `workspaceAgent: true`. The daemon copies that flag into the Device's presence (`DeviceStartedSession.workspace_agent`, serde-default, no protocol bump), and the desk's `placeDeviceSession` makes the session `mainSessionId` when the workspace has a folder and no agent; otherwise it lands as a tab on the Agents page. A Device still never saves the layout itself. Needs a daemon and app rebuild to reach the phone. With an older daemon the start degrades to a plain agent tab.

- [ ] Human test: After rebuilding and restarting the daemon and the app: on the iPhone, open a workspace with a folder and no Home agent (e.g. Grimoria), go to Sessions, tap "Start workspace agent" under WORKSPACE AGENT — the row becomes the running agent, the desk's Home tab shows that same agent (no new tab on the Agents page), and a workspace whose Home agent is running (Gavin) lists it under WORKSPACE AGENT with no Start row
