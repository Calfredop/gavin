// One preference, kept out of the component that shows it: whether the
// orchestration tab's conflicts box is collapsed.
//
// The box used to hold that in plain component state, and `+page.svelte`
// renders ONE hub view at a time -- switching to Kanban and back destroys
// the whole tree, so every visit re-ran `$state(false)` and re-opened a
// box the human had just closed. Nothing else remembers it for them: the
// list is derived from rails on every push, so there is no row in the
// plan to hang it on, and it is a per-human view preference rather than
// workspace data anyway. Hence localStorage, the same place the sidebar
// keeps which rows are unfolded.
//
// Absent means expanded, which is the "only expand on first appearance"
// half of the rule: a box nobody has ruled on yet opens itself, and after
// that the human's last answer stands until they change it -- including
// when conflicts vanish and later come back, because re-opening on a
// change is the very behaviour that made this annoying.

/// Storage is injected (defaulting to the browser's) so this module stays
/// testable under vitest's node environment, where localStorage does not
/// exist at all.
type MaybeStorage = Pick<Storage, "getItem" | "setItem"> | undefined;

function defaultStorage(): MaybeStorage {
  return typeof localStorage === "undefined" ? undefined : localStorage;
}

/// Per workspace: rails, and so conflicts, belong to one workspace, and
/// closing one workspace's box says nothing about another's.
export function collapseStorageKey(workspaceId: string): string {
  return `gavin.orchestrationConflictsCollapsed.${workspaceId}`;
}

/// Anything but a remembered `true` reads as expanded -- absent, corrupt,
/// hand-edited, or a storage that refuses to be read. Forgetting is the
/// only acceptable failure mode for a view preference.
export function loadConflictsCollapsed(
  workspaceId: string,
  storage: MaybeStorage = defaultStorage()
): boolean {
  try {
    return storage?.getItem(collapseStorageKey(workspaceId)) === "true";
  } catch {
    return false;
  }
}

export function saveConflictsCollapsed(
  workspaceId: string,
  collapsed: boolean,
  storage: MaybeStorage = defaultStorage()
): void {
  try {
    // Written either way: an explicit re-open is an answer too, and must
    // outlive the next remount just as a collapse does.
    storage?.setItem(collapseStorageKey(workspaceId), collapsed ? "true" : "false");
  } catch {
    // Best-effort: a full or blocked storage must never break the box.
  }
}
