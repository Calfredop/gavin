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

import { writable } from "svelte/store";
import { hotState } from "./hotState";

export type AppPanel = "sessions" | "usage";

/// Deliberately not persisted: a panel that walks the process table
/// every two seconds must not come back by itself at the next launch.
export const openAppPanel = hotState(
  "openAppPanel",
  () => writable<AppPanel | null>(null),
  import.meta.hot?.data
);

export function showAppPanel(panel: AppPanel): void {
  openAppPanel.set(panel);
}

export function closeAppPanel(): void {
  openAppPanel.set(null);
}
