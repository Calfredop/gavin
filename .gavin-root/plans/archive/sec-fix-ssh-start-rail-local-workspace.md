---
labels: security, ready-for-agent
kind: task
title: [sec] A builtin:start-rail step on an ssh workspace can arm a LOCAL workspace's rail
status: Done
priority: medium
complexity: moderate
---
Fix a medium-severity finding from the 2026-10-15 security audit unit finished by `sec-hunt-ssh-host-rail-state.md` (run-1 coverage id ending in `Tool and action attack classes` for ssh host rail state). Fingerprint: `app/src/lib/orchestration/orchestrationState.ts:executeGavinAction:start-rail:cross-trust-workspace`.

Full record: Comments on `sec-hunt-ssh-host-rail-state.md`. The audit card is `review-security-audit-2026-10-15.md`.

## What is wrong

`builtin:start-rail` may name a target workspace via its `workspace` parameter (`startRailTargetWorkspace` in `orchestration.ts`). `executeGavinAction` (`orchestrationState.ts`) resolves that id against every workspace in `layoutState` and, on a `start` verdict, calls `startRail(targetWorkspaceId, …)`. Cross-workspace arming is intentional between local workspaces (the StepParamsDialog picker). On an ssh workspace, though, the orchestration plan — including that parameter — lives on the HOST and is host-writable through the host's gavin-mcp / daemon. A host-controlled step can therefore arm a LOCAL workspace's rail. `startRail` only asks `sshLaunchBlocker` of the TARGET, which is null for a local workspace, so the arm proceeds. The existing test `a gavin action can arm a rail in a workspace of its own choosing` in `orchestrationState.test.ts` shows the cross-workspace path reaches `setRailRun` on the target. Once armed, the local scheduler's `tick` launches that rail's steps on the local machine with no further desk click on the ssh workspace.

The workspace id is a UUID the host does not invent: it must be known (a human previously configured a cross-workspace start-rail step that was stored on the host, or the id leaked). Knowing one local id is enough.

## Root cause

`executeGavinAction` treats every open workspace id as an equal peer for `builtin:start-rail`. It does not ask whether the CALLING workspace is ssh (host-controlled plan) and the TARGET is local (desk-trusted). The trust boundary the ssh link establishes for trees and sessions is not applied to this action.

## The invariant to enforce

A `builtin:start-rail` step whose calling workspace is an ssh workspace may only arm a rail in that same workspace, or in another ssh workspace on the same host. It must refuse a target that is local (no `ssh`) or on a different host. Local-to-local cross-workspace start-rail stays as it is.

## Trace (re-read before editing)

- `app/src/lib/orchestration/orchestration.ts` (`startRailTargetWorkspace`): Empty workspace param → own workspace; non-empty → any id present in `layoutState.workspaces`.
- `app/src/lib/orchestration/orchestrationState.ts` (`executeGavinAction`): On `gavinActionOf(tool) === "start-rail"`, resolves the target and calls `startRail(targetWorkspaceId, …)` with no ssh/local check.
- `app/src/lib/orchestration/orchestrationState.ts` (`startRail`): `sshLaunchBlocker(workspaceId)` only — for a local target this returns null.
- `app/src/lib/orchestration/orchestrationState.test.ts` (`a gavin action can arm a rail in a workspace of its own choosing`): Proves the arm reaches `backend.setRailRun` on `ws-2` from a step on `ws-1`.

## Fix

In `executeGavinAction` (or in `startRailTargetWorkspace` with enough context), when the calling workspace is ssh, refuse a target whose workspace is missing `ssh` or whose `ssh.host` differs from the caller's. Stall the step with a reason that names the refusal (same shape as an unknown workspace). Keep local-to-local and same-host ssh-to-ssh working.

Regression test in `orchestrationState.test.ts`: an ssh calling workspace (fixture with `ssh: { host: "h" }`) and a local target `ws-local`; a `builtin:start-rail` step with `workspace: "ws-local"` must stall, must not call `setRailRun` for `ws-local`, and must leave the calling step not `done`. A second case: same host, two ssh workspaces, arm still succeeds.

## Done when

- An ssh workspace's start-rail step cannot arm a local workspace's rail.
- The regression cases named above fail before the change and pass after it.
- You commit only the files you touched.
