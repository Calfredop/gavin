// The "New page" dropdown, as data and policy: the layouts a fresh page
// can start in, and the menu that offers them. NewPageButton.svelte is a
// thin template over this.
//
// It used to live in the title bar, beside the pane controls, because
// the title bar was the app's one always-visible strip. It no longer is:
// the hub tabs and a page's session tabs are the top edge now, so the
// button rides on both of those rows instead, and the pane controls went
// with the pane they act on (Pane.svelte). What is left here is the part
// neither of those two hosts should own twice.
import { presetGrid2x2, presetSideBySide, presetSingle, type LayoutNode } from "./layout";
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
/// instead of a fourth button competing for tab-bar width.
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

/// The label of the dropdown's one non-preset row.
export const WITH_AGENT_LABEL = "With agent";

/// What the menu calls itself. The button that opens it is an icon on a
/// tab row now -- there is no room beside a strip of tabs for a worded
/// button, and the row would reflow every time the word appeared or
/// went. The words moved in here, where a menu has room for them.
export const NEW_PAGE_TITLE = "New page";

/// The "New page" dropdown's entries, built over the shared context menu
/// layer -- one menu implementation in the app, with its viewport
/// clamping, Escape and click-away already solved.
///
/// The heading leads: it is what the button no longer says out loud.
/// Then "With agent", as a checkbox: it qualifies every row under it
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
    { heading: NEW_PAGE_TITLE },
    { label: WITH_AGENT_LABEL, checked: withAgent, keepOpen: true, onPick: onToggleAgent },
    { separator: true },
    ...PAGE_PRESETS.map((preset) => ({ label: preset.label, onPick: () => onPick(preset) })),
  ];
}
