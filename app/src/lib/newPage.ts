// What the title bar offers, as data and policy: which of its controls
// apply to whatever is on screen, and the page presets behind its "New
// page" dropdown. TitleBar.svelte is a thin template over this.
import { presetGrid2x2, presetSideBySide, presetSingle, type LayoutNode } from "./layout";
import { getActiveView, getActiveWorkspace, type WorkspacesData } from "./workspace";
import type { ContextMenuEntry } from "./contextMenu";

/// One entry of the "New page" dropdown: how many sessions the page
/// starts with, and the tree those sessions are arranged into. `build`
/// is handed exactly `sessionCount` fresh session ids.
export interface PagePreset {
  id: string;
  label: string;
  sessionCount: number;
  build: (freshIds: string[]) => LayoutNode;
}

/// The presets, in menu order. A table rather than one button each: the
/// dropdown lists whatever is in here, so a new layout is one entry
/// instead of a fourth button competing for title bar width.
export const PAGE_PRESETS: PagePreset[] = [
  { id: "single", label: "Single", sessionCount: 1, build: ([a]) => presetSingle(a) },
  {
    id: "side-by-side",
    label: "Side by Side",
    sessionCount: 2,
    build: ([a, b]) => presetSideBySide(a, b),
  },
  {
    id: "grid-2x2",
    label: "2×2 Grid",
    sessionCount: 4,
    build: ([a, b, c, d]) => presetGrid2x2(a, b, c, d),
  },
];

/// Whether the pane controls -- split right, split down, close pane --
/// address anything the human can see. They act on the FOCUSED pane of
/// the active page, and a workspace parked on a hub tab keeps that focus
/// while showing none of it (switchWorkspaceView leaves it alone on
/// purpose, so coming back restores the same pane). Clicking Split from
/// the Kanban tab therefore spawned a session into a page nowhere on
/// screen, and Close Pane killed one. The keyboard router already
/// refuses the same chords for the same reason -- keyboard.ts's
/// focusedTerminalSession -- and the bar is what was left over.
///
/// The app hub counts too: it is drawn over every workspace, so the
/// terminal underneath it is just as invisible.
export function paneControlsApply(state: WorkspacesData, appHubOpen: boolean): boolean {
  if (appHubOpen) return false;
  const ws = getActiveWorkspace(state);
  return ws !== null && getActiveView(ws) === "terminal";
}

/// The label of the dropdown's one non-preset row.
export const WITH_AGENT_LABEL = "With agent";

/// The "New page" dropdown's entries, built over the shared context menu
/// layer -- one menu implementation in the app, with its viewport
/// clamping, Escape and click-away already solved.
///
/// "With agent" leads, as a checkbox: it qualifies every row under it
/// rather than being a fourth thing to pick, so it has to be readable
/// BEFORE the preset that consumes it. It keeps the menu open (the
/// checkbox is in the menu it changes) and the presets stay plain
/// picks, so one click still adds a page.
export function newPageEntries(
  withAgent: boolean,
  onToggleAgent: () => void,
  onPick: (preset: PagePreset) => void
): ContextMenuEntry[] {
  return [
    { label: WITH_AGENT_LABEL, checked: withAgent, keepOpen: true, onPick: onToggleAgent },
    { separator: true },
    ...PAGE_PRESETS.map((preset) => ({ label: preset.label, onPick: () => onPick(preset) })),
  ];
}
