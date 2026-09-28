// A Workstation whose rail is owed work, and the loading a surface does
// before it can draw that rail. Shared by the two scheduler suites, which
// differ in one thing only: whose window the code believes it is in.
import { get } from "svelte/store";
import { fetchBoard } from "$lib/board/kanbanState";
import { refreshGavinTree } from "$lib/core/gavinState";
import { layoutState } from "$lib/core/layoutState";
import { fetchOrchestration } from "$lib/orchestration/orchestrationState";
import { DEMO, sampleState, type DemoState } from "$companion/demo/sampleData";
import { settle } from "$companion/testing/demoBench";

/// The demo, at the moment an agent has just finished the card its rail
/// step was running: the card says Done and the step still says running.
///
/// That is work a scheduler owes at once -- mark the step done, move the
/// rail to its next stage -- and it is bookkeeping, so no pause and no
/// launch wall stands between a tick and the write. If a scheduler is
/// running anywhere in the page, this state makes it say so.
export function aRailOwedWork(): DemoState {
  const state = sampleState();
  const card = state.trees[DEMO.atlas].contexts[0].plans.find((p) => p.fileName === "token-refresh.md");
  if (!card) throw new Error("the demo lost the card its rail runs");
  card.status = "Done";
  return state;
}

/// What writes a rail's run state, and what a launch begins with. Any of
/// these arriving at the Workstation is a scheduler having acted.
export const SCHEDULER_COMMANDS = [
  "set_step_run",
  "set_rail_run",
  "set_orchestration",
  "create_session",
  "get_tools",
  "git_checkout",
  "git_worktree_add",
];

/// Everything a surface showing this workspace's rails would load, by
/// the desktop's own loaders. `fetchOrchestration` is the one that
/// matters: a plan ARRIVING ticks by hand, scheduler started or not.
export async function loadTheRailsAsASurfaceWould(state: DemoState): Promise<void> {
  layoutState.update((s) => ({
    ...s,
    status: "ready",
    workspaces: state.workspaces.workspaces,
    activeWorkspaceId: DEMO.atlas,
    sessionStatusById: Object.fromEntries(state.sessions.map((b) => [b.id, "idle" as const])),
    sessionsSeenWorking: new Set(state.sessions.map((b) => b.id)),
  }));
  await fetchBoard(DEMO.atlas);
  await refreshGavinTree(DEMO.atlas);
  await fetchOrchestration(DEMO.atlas);
  await settle();
  if (get(layoutState).workspaces.length === 0) throw new Error("the workspaces never loaded");
}
