// Which of its two views the Orchestration tab is in: the rail strip, or
// the node graph (orchestrationNodes.ts).
//
// A view preference and nothing more. The plan has no row to hang it on
// -- neither rendering changes what a rail IS -- and it is the human's
// choice about how to look, not workspace data. So it lives where the
// conflicts box keeps its collapse (orchestrationConflictBanner.ts): in
// localStorage, per workspace, because `+page.svelte` renders ONE hub
// view at a time and a switch to Kanban and back rebuilds this tab from
// scratch. Without this a human who chose the graph would be handed the
// strip again on every visit.

/// Storage is injected (defaulting to the browser's) so this module stays
/// testable under vitest's node environment, where localStorage does not
/// exist at all.
type MaybeStorage = Pick<Storage, "getItem" | "setItem"> | undefined;

function defaultStorage(): MaybeStorage {
  return typeof localStorage === "undefined" ? undefined : localStorage;
}

export type OrchestrationViewMode = "rails" | "nodes";

/// In the order the switcher offers them: the strip first, because it is
/// the view every existing workspace was built in and the one drag and
/// drop works on.
export const VIEW_MODES: OrchestrationViewMode[] = ["rails", "nodes"];

/// Per workspace, like the conflicts collapse: the graph is the right
/// view for a workspace with cross-rail arrows to read and the wrong one
/// for a workspace with a single rail, and the human decides that per
/// workspace.
export function viewModeStorageKey(workspaceId: string): string {
  return `gavin.orchestrationViewMode.${workspaceId}`;
}

/// Anything but a remembered mode this build knows reads as the strip --
/// absent, corrupt, a value a newer gavin wrote, or a storage that
/// refuses to be read. Forgetting is the only acceptable failure mode
/// for a view preference.
export function loadViewMode(
  workspaceId: string,
  storage: MaybeStorage = defaultStorage()
): OrchestrationViewMode {
  try {
    const raw = storage?.getItem(viewModeStorageKey(workspaceId));
    return raw === "nodes" ? "nodes" : "rails";
  } catch {
    return "rails";
  }
}

export function saveViewMode(
  workspaceId: string,
  mode: OrchestrationViewMode,
  storage: MaybeStorage = defaultStorage()
): void {
  try {
    // Written either way: switching back to the strip is an answer too,
    // and must outlive the next remount just as switching away does.
    storage?.setItem(viewModeStorageKey(workspaceId), mode);
  } catch {
    // Best-effort: a full or blocked storage must never break the tab.
  }
}
