// The remote shim for `@tauri-apps/api/window`.
//
// The spec names two modules to replace, core and event. This is a third,
// and the rule it carries is the one ADR 0003 singles out: THE COMPANION
// NEVER RUNS A RAIL.
//
// The desktop decides who runs a workspace's rails -- and who holds the
// app's pollers -- from the label of the window asking (appDuty.ts's
// `runsRailsFor`, `holdsAppDuties`). With no Tauri window behind it,
// `currentWindowLabel` falls back to "main": the right answer under
// vitest and in a static build, and exactly the wrong one here, because
// "main" is the window that DOES run them. A bundle that loaded a rail
// only to draw it would then tick it, beside the desk, and every step
// would launch twice.
//
// So the bundle says whose window it is. The label below belongs to no
// desktop window, which makes every one of the desktop's own gates
// answer "not here" -- without a single desktop module learning that
// phones exist. The rest of the surface is what the desktop's modules
// call on a window, answered for a page that has no window to move.
export const COMPANION_WINDOW_LABEL = "companion";

export type Theme = "light" | "dark";

export type UnlistenFn = () => void;

/// What a close request hands its handler on the desktop. Never built
/// here -- nothing asks a Companion's page to close -- but the desktop's
/// handler is typed against it.
export interface CloseRequestedEvent {
  preventDefault(): void;
  isPreventDefault(): boolean;
}

export type ResizeDirection =
  | "East"
  | "North"
  | "NorthEast"
  | "NorthWest"
  | "South"
  | "SouthEast"
  | "SouthWest"
  | "West";

const LIGHT = "(prefers-color-scheme: light)";

function scheme(): MediaQueryList | null {
  return typeof matchMedia === "function" ? matchMedia(LIGHT) : null;
}

export interface CompanionWindow {
  readonly label: string;
  isFocused(): Promise<boolean>;
  theme(): Promise<Theme | null>;
  onThemeChanged(handler: (event: { payload: Theme }) => void): Promise<UnlistenFn>;
  onCloseRequested(handler: (event: CloseRequestedEvent) => void | Promise<void>): Promise<UnlistenFn>;
  onResized(handler: (event: { payload: { width: number; height: number } }) => void): Promise<UnlistenFn>;
  isMaximized(): Promise<boolean>;
  startDragging(): Promise<void>;
  startResizeDragging(direction: ResizeDirection): Promise<void>;
  toggleMaximize(): Promise<void>;
  minimize(): Promise<void>;
  close(): Promise<void>;
  destroy(): Promise<void>;
}

const nothing = async (): Promise<void> => {};

const companionWindow: CompanionWindow = {
  label: COMPANION_WINDOW_LABEL,

  // The desktop asks this to decide whether a status change deserves an
  // OS notification: not while its window is in front. A bundle on
  // screen IS in front, and one that is not has no connection left to
  // hear a status on -- the Unlock ended with it. What reaches a phone in
  // the background is the shell's encrypted push, never this page.
  isFocused: async () => true,

  // "System" on a phone is the phone's appearance, not the desk's.
  theme: async () => {
    const list = scheme();
    if (!list) return null;
    return list.matches ? "light" : "dark";
  },

  onThemeChanged: async (handler) => {
    const list = scheme();
    if (!list) return () => {};
    const changed = (e: { matches: boolean }): void => handler({ payload: e.matches ? "light" : "dark" });
    list.addEventListener("change", changed);
    return () => list.removeEventListener("change", changed);
  },

  // Leaving a Workstation is `return-to-hub`, asked of the shell.
  onCloseRequested: async () => () => {},
  // The desk watches this to redraw its maximize button. A page follows
  // its screen with its own layout, and has no such button.
  onResized: async () => () => {},

  isMaximized: async () => false,
  startDragging: nothing,
  startResizeDragging: nothing,
  toggleMaximize: nothing,
  minimize: nothing,
  close: nothing,
  destroy: nothing,
};

export function getCurrentWindow(): CompanionWindow {
  return companionWindow;
}
