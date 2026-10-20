---
labels: security, ready-for-agent
kind: task
title: [sec] An ssh link's OrchestrationChanged and ToolsChanged pushes are not confined to that host's ssh workspace ids
status: Done
priority: medium
complexity: moderate
---
Fix a medium-severity finding from the 2026-10-15 security audit unit finished by `sec-hunt-ssh-host-rail-state.md` (run-1 coverage id ending in `Tool and action attack classes` for ssh host rail state). Fingerprint: `app/src-tauri/src/session.rs:attach_and_relay:OrchestrationChanged:no-host-workspace-confine`.

Full record: Comments on `sec-hunt-ssh-host-rail-state.md` in `.gavin-root/plans/` (or `plans/done/` once filed), and the unit entry in `~/security-audit-skill/gavin/run-1/coverage-ledger.json`. The audit card is `review-security-audit-2026-10-15.md`.

## What is wrong

GavinTreeChanged from a remote link is confined once at the desk: `confine_host_tree` keeps the push only when `workspace_id` is an ssh workspace on that host, and drops every path outside that workspace's root (`session.rs` around the GavinTreeChanged arm and `get_gavin_tree`). OrchestrationChanged and ToolsChanged from the same link are emitted into the webview with the `workspace_id` as given (`session.rs` OrchestrationChanged / ToolsChanged arms). The Svelte listeners key on that id (`orchestrationState.ts` `initOrchestrationListeners`, `toolsState.ts` `initToolListeners`) and replace that workspace's in-memory rails or tool library. A host that learns a LOCAL workspace id can therefore overwrite that local workspace's plan or tools. When the local workspace had never been fetched, the first-seen branch stores the payload wholesale (including `railRuns: running`) and `tick` launches steps with no desk click. Observation: `orchestrationState.test.ts` "applies a push under whatever workspace id the payload names" — a push naming `ws-local` arms a rail and reaches `createSessionOnPage` for that local workspace.

## Root cause

The tree confine from `sec-fix-ssh-tree-card-paths-under-root` was applied only to GavinTreeChanged / get_gavin_tree. Orchestration and tools pushes from `RelayOwner::Remote` were left unfiltered, so a host-chosen workspace id is trusted as a key into local desk state.

## The invariant to enforce

A push that arrives from an ssh link may only describe that host's own ssh workspaces. OrchestrationChanged and ToolsChanged for any other workspace id are dropped before emit, the same way a foreign GavinTreeChanged is. get_orchestration / get_tools for a remote route already go through `route_for_workspace` and so only answer for that workspace when the desktop asks by id; the push path must match.

## Trace (re-read before editing)

- `app/src-tauri/src/session.rs` (`confine_host_tree`): Keeps a host tree only when workspace_id is an ssh workspace on `host`.
- `app/src-tauri/src/session.rs` (GavinTreeChanged arm): Applies `confine_host_tree` and skips the emit on None.
- `app/src-tauri/src/session.rs` (OrchestrationChanged arm): Emits `(workspace_id, orchestration)` with no host/workspace check.
- `app/src-tauri/src/session.rs` (ToolsChanged arm): Emits `(workspace_id, tools)` with no host/workspace check.
- `app/src/lib/orchestration/orchestrationState.ts` (`initOrchestrationListeners`): Stores under the payload's workspace id and calls `tick(workspaceId)`.
- `app/src/lib/orchestration/toolsState.ts` (`initToolListeners`): Replaces `toolRecords[workspaceId]` from the payload.

## Fix

In `attach_and_relay`, when `owner` is `RelayOwner::Remote`, refuse OrchestrationChanged and ToolsChanged unless `workspace_id` is an ssh workspace whose `ssh.host` equals that link's host (the same membership test `confine_host_tree` starts with). Skip the emit otherwise. Add Rust tests beside `confine_host_tree_tests`: a remote OrchestrationChanged / ToolsChanged for a local workspace id is not emitted; one for that host's ssh workspace id is.

Invert the vitest `applies a push under whatever workspace id the payload names` in `orchestrationState.test.ts` once the Tauri side drops the push (or, if the suite cannot drive the relay, add an app/src-tauri test that is the sole regression and leave the vitest as a comment pointing at it). Add a matching tools-changed case in `toolsState.test.ts` if the listener stays reachable with a forged id from a unit mock — the authoritative refuse is in session.rs.

## Done when

- A remote link cannot make the desk store orchestration or tools under a workspace id that is not one of that host's ssh workspaces.
- The regression cases named above fail before the change and pass after it.
- You commit only the files you touched.
