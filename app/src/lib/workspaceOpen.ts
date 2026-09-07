// "Open workspace…": pick a folder, and put a workspace on it.
//
// The other half of workspaceCreate.ts, which names a workspace first and
// asks about a folder afterwards. This one starts from the folder, which
// is how a human who already has a repo thinks about it -- and it is the
// action the sidebar offers now, because the sidebar's list is a list of
// FOLDERS you are working in. Making an empty, unrooted workspace from a
// name is the app hub's job, where there is room to explain what one is.
//
// Nothing is created until the answer is known. An "Open" that made a
// workspace and then asked whether to initialize gavin in the folder
// would leave a nameless, rootless row behind on every cancel -- which
// is exactly the state the sidebar's + used to produce and the whole
// reason it is gone.

import { get, writable } from "svelte/store";
import { open } from "@tauri-apps/plugin-dialog";
import * as backend from "./backend";
import {
  createWorkspace,
  layoutState,
  setWorkspaceRoot,
  switchWorkspace,
  type LayoutState,
} from "./layoutState";
import { folderName } from "./paths";
import { sameRoot } from "./workspace";
import { showAlert } from "./dialog";

/// A picked folder that holds no `.gavin*` yet, waiting on the three-way
/// answer (initialize / bind as-is / cancel). Null the rest of the time.
///
/// A store rather than the caller's own state because the question
/// outlives the click that raised it: the picker is an OS dialog, and
/// the sidebar can be re-rendered while it is up.
export interface PendingOpen {
  rootPath: string;
  /// What the workspace would be called -- the folder's own basename.
  /// Resolved here rather than at the prompt so the prompt can say it.
  name: string;
}

export const pendingOpen = writable<PendingOpen | null>(null);

/// The workspace already bound to this folder, or null. Exported for the
/// test: "open a folder that is already open" must switch to it rather
/// than build a second workspace on the same root, and that is a rule
/// about state, not about the picker.
export function workspaceForRoot(state: LayoutState, rootPath: string): string | null {
  const match = state.workspaces.find((w) => w.rootPath && sameRoot(w.rootPath, rootPath));
  return match?.id ?? null;
}

/// The name a folder gets when it becomes a workspace: the folder's own
/// basename. Not the full path -- the sidebar row is 200px wide and the
/// path is on the Settings tab, which is where a full path belongs.
export function nameForRoot(rootPath: string): string {
  return folderName(rootPath.replace(/[/\\]+$/, ""));
}

/// Opens the folder picker and takes it from there. Silent on a
/// cancelled pick, which is not an error.
export async function openWorkspaceFolder(): Promise<void> {
  const picked = await open({ directory: true, multiple: false, title: "Open workspace" });
  if (typeof picked !== "string") return;

  const already = workspaceForRoot(get(layoutState), picked);
  if (already) {
    await switchWorkspace(already);
    return;
  }

  // Bound straight away when gavin already lives there: a folder that
  // has been a workspace before has nothing left to ask about, and
  // setWorkspaceRoot is what offers the reclaim if one is owed.
  if (await backend.gavinRootExists(picked)) {
    await bindNewWorkspace(picked);
    return;
  }
  pendingOpen.set({ rootPath: picked, name: nameForRoot(picked) });
}

/// Scaffolds `.gavin-root/` and then opens the folder. The init runs
/// BEFORE the workspace exists, for the reason WorkspaceRootControl
/// states about its own order: the watch started by binding should see
/// the skeleton in its first push rather than an empty folder.
///
/// `trackInGit` is the tick-box beside the prompt, seeded from the
/// app-wide default. Applied here rather than inside `init_gavin_root`
/// because the daemon scaffolds the folder and the ignore rule is the
/// app's business: a `.gitignore` is a fact about this checkout, and the
/// daemon serves several.
export async function initAndOpen(pending: PendingOpen, trackInGit: boolean): Promise<void> {
  pendingOpen.set(null);
  try {
    await backend.initGavinRoot(pending.rootPath, pending.name);
  } catch (e) {
    await showAlert({
      title: "Couldn't initialize gavin in that folder",
      lines: [String(e)],
    });
    return;
  }
  await applyInitTracking(pending.rootPath, trackInGit);
  await bindNewWorkspace(pending.rootPath);
}

/// Writes the ignore rule when the human declined tracking, and does
/// nothing at all when they did not.
///
/// Nothing, deliberately: "tracked" is what a repo with no rule already
/// does, so an "on" has nothing to write, and a folder outside a git repo
/// has nowhere to write it. `untrack` is false because init has just
/// created these files -- there is no index entry for them to remove, and
/// asking the backend to stage deletions during a folder-open is a
/// surprise nobody consented to.
///
/// Failures are swallowed on purpose. The workspace is scaffolded and
/// about to open; a `.gitignore` that could not be written is a line in
/// Settings › Git away from being fixed, and is not worth a modal over an
/// init that otherwise worked.
export async function applyInitTracking(rootPath: string, trackInGit: boolean): Promise<void> {
  if (trackInGit) return;
  try {
    await backend.setGavinGitTracking(rootPath, false, false);
  } catch {
    // See above.
  }
}

/// Opens the folder without scaffolding anything. A perfectly ordinary
/// answer: a repo can be a workspace for its terminals and its git tab
/// long before anyone wants a board in it.
export async function bindWithoutInit(pending: PendingOpen): Promise<void> {
  pendingOpen.set(null);
  await bindNewWorkspace(pending.rootPath);
}

export function cancelOpen(): void {
  pendingOpen.set(null);
}

/// Creates the workspace and binds it. createWorkspace makes what it
/// created active, so the id is read back off the store afterwards --
/// the same read commitNewWorkspace does, and for the same reason: that
/// function has never reported the id it minted.
async function bindNewWorkspace(rootPath: string): Promise<void> {
  await createWorkspace(nameForRoot(rootPath));
  const id = get(layoutState).activeWorkspaceId;
  if (!id) return;
  await setWorkspaceRoot(id, rootPath);
}
