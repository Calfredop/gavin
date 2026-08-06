import { writable } from "svelte/store";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import * as backend from "./backend";
import type { GavinTree, PlanFileInfo } from "./gavin";
import type { Workspace } from "./workspace";

// One live tree per workspace with a watched root. Fed exclusively by
// gavin-tree-changed pushes -- the initial WatchGavinRoot scan arrives as
// the first push, since there is no request/reply on the streaming
// connection.
export const gavinTrees = writable<Record<string, GavinTree>>({});

// Guards watchRootedWorkspaces against double-registration: bootstrap has
// two "workspaces are ready" paths (the workspaces-ready event and
// pollForStartupState), and whichever runs second must be a no-op.
let watchedOnce = false;

// Must be registered BEFORE the first watchGavinRoot call -- Tauri events
// emitted with no listener are lost, not buffered (the Milestone B race
// class). layoutState.bootstrap() registers this in its listener block.
export async function initGavinListeners(): Promise<UnlistenFn> {
  return listen<[string, GavinTree]>("gavin-tree-changed", (event) => {
    const [workspaceId, tree] = event.payload;
    gavinTrees.update((m) => ({ ...m, [workspaceId]: tree }));
  });
}

export function watchRootedWorkspaces(workspaces: Workspace[]): void {
  if (watchedOnce) return;
  watchedOnce = true;
  for (const ws of workspaces) {
    // Best-effort: a failed watch shows as a missing tree, never blocks
    // startup.
    if (ws.rootPath) void backend.watchGavinRoot(ws.id, ws.rootPath).catch(() => {});
  }
}

// Optimistic bridge for the watcher's debounce+floor confirmation latency
// (spec §2): called ONLY after a successful SetPlanFrontmatterField, so a
// dragged card doesn't snap back while waiting ~2.5s for the push. The
// eventual push carries the same tree and re-renders as a no-op.
export function patchPlanField(
  workspaceId: string,
  path: string,
  key: "status" | "priority",
  value: string
): void {
  gavinTrees.update((m) => {
    const tree = m[workspaceId];
    if (!tree) return m;
    const contexts = tree.contexts.map((ctx) => ({
      ...ctx,
      plans: ctx.plans.map((p) =>
        p.path === path
          ? key === "status"
            ? { ...p, status: value }
            : { ...p, priority: value.toLowerCase() as PlanFileInfo["priority"] }
          : p
      ),
    }));
    return { ...m, [workspaceId]: { ...tree, contexts } };
  });
}

/** @internal test-only reset for module-level state */
export function __resetForTesting(): void {
  watchedOnce = false;
  gavinTrees.set({});
}
