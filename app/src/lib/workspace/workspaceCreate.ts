// The one workspace-creation flow: name it, create it, offer the setup
// modal, hand off to the wizard.
//
// It lived inside Sidebar.svelte until the app hub grew a "+ New
// workspace…" button of its own. Two copies of a four-step handoff is
// exactly the shape that drifts -- one of them would eventually forget
// to open the wizard, or forget that skipping leaves an unrooted
// workspace behind -- so the steps live here and both surfaces drive
// them. The surfaces still own their own naming input; what they must
// not own is what happens after it.

import { get, writable } from "svelte/store";
import { createWorkspace, layoutState, openWizard } from "$lib/layoutState";

/// Which surface asked for a workspace. The sidebar's + and the app
/// hub's "+ New workspace…" both drive this one flow, and both render a
/// naming box from it -- so the box has to say WHERE it belongs, or a
/// click on the sidebar's + with the hub open opens two of them, both
/// bound to the same text and both grabbing focus.
export type CreateSurface = "sidebar" | "hub";

export interface NewWorkspaceNaming {
  surface: CreateSurface;
  name: string;
}

export interface NewWorkspaceFlow {
  /// The naming box in progress, or null when there is none. One object
  /// rather than a surface beside a nullable string: "" is a box that is
  /// currently empty, which is a real state, and there is then no way to
  /// be naming with no surface, or to have a surface and no box.
  naming: NewWorkspaceNaming | null;
  /// The freshly created workspace whose setup modal is up, or null.
  /// Set only after the workspace actually exists, so the modal can
  /// never be up for an id nothing has been created under.
  pendingSetupId: string | null;
}

export const newWorkspaceFlow = writable<NewWorkspaceFlow>({ naming: null, pendingSetupId: null });

/// Opens a naming box on one surface, always empty -- a half-typed name
/// from a run the user escaped out of must not come back on the next
/// click. Opening one on the other surface replaces it rather than
/// stacking: there is one flow, so there is one box.
export function startCreatingWorkspace(surface: CreateSurface): void {
  newWorkspaceFlow.update((f) => ({ ...f, naming: { surface, name: "" } }));
}

/// Ignored when no naming is in progress, so a stale input event from a
/// box that has just been dismissed cannot reopen it.
export function setNewWorkspaceName(name: string): void {
  newWorkspaceFlow.update((f) => (f.naming === null ? f : { ...f, naming: { ...f.naming, name } }));
}

export function cancelNewWorkspace(): void {
  newWorkspaceFlow.update((f) => ({ ...f, naming: null }));
}

/// Creates the workspace and puts its setup modal up. A blank (or
/// whitespace-only) name cancels instead -- committing an empty box is
/// how the sidebar's input has always been dismissed by clicking away,
/// and that must stay a dismissal rather than create a nameless
/// workspace.
///
/// The naming box closes BEFORE the await, not after: createWorkspace is
/// a round trip through the Tauri host, and leaving the input up across
/// it invites a second Enter that creates a second workspace.
export async function commitNewWorkspace(): Promise<void> {
  const naming = get(newWorkspaceFlow).naming;
  if (naming === null) return;
  const trimmed = naming.name.trim();
  newWorkspaceFlow.update((f) => ({ ...f, naming: null }));
  if (!trimmed) return;
  await createWorkspace(trimmed);
  // createWorkspace makes the new workspace the active one, so this is
  // it. Read after the await rather than returned from createWorkspace,
  // which has never reported the id it minted.
  newWorkspaceFlow.update((f) => ({ ...f, pendingSetupId: get(layoutState).activeWorkspaceId }));
}

/// Backs out of setup. The workspace stays -- unrooted, exactly what
/// creation produced before the modal existed.
export function skipSetup(): void {
  newWorkspaceFlow.update((f) => ({ ...f, pendingSetupId: null }));
}

/// Closes the setup modal and opens the wizard on the same workspace.
export function finishSetup(): void {
  const id = get(newWorkspaceFlow).pendingSetupId;
  newWorkspaceFlow.update((f) => ({ ...f, pendingSetupId: null }));
  if (id) openWizard(id);
}
