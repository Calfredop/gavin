// Which app-level panel is open, if any.
//
// The task manager and the usage panel belong to no workspace -- they
// report on the whole daemon and on every agent the fleet runs -- and
// they are now reachable from two places: the sidebar footer's rows and
// the app hub's own recaps. A `let showX = $state(false)` inside
// Sidebar.svelte could only ever be flipped from inside Sidebar.svelte,
// so the flag has to leave the component that used to own it.
//
// One store rather than a boolean each: both are modals, only one can be
// on screen, and a single value makes that structural instead of a rule
// every new call site has to remember.

import { get, writable } from "svelte/store";
import { hotState } from "$lib/hotState";

export type AppPanel = "sessions" | "usage";

/// Deliberately not persisted: a panel that walks the process table
/// every two seconds must not come back by itself at the next launch.
export const openAppPanel = hotState(
  "openAppPanel",
  () => writable<AppPanel | null>(null),
  import.meta.hot?.data
);

/// A sort the sessions panel should open with, consumed once.
///
/// The pressure banner's "Open sessions" means "show me what is holding
/// the memory", which is the panel sorted by memory descending -- and
/// the panel's own sort is component state that no caller can reach. A
/// one-shot request rather than a persisted preference: the human's own
/// sort must survive the next time they open the panel themselves.
export const requestedSessionSort = writable<"memory" | null>(null);

export function showAppPanel(panel: AppPanel, sort?: "memory"): void {
  if (sort) requestedSessionSort.set(sort);
  openAppPanel.set(panel);
}

/// Reads and clears the request, so a second mount does not re-apply it.
export function takeSessionSortRequest(): "memory" | null {
  const requested = get(requestedSessionSort);
  if (requested) requestedSessionSort.set(null);
  return requested;
}

export function closeAppPanel(): void {
  openAppPanel.set(null);
}
