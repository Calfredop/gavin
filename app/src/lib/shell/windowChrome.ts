// Whether a window has to draw a chrome row of its own.
//
// Most of the app's branches come with a header: a workspace on a hub tab
// has its tab strip, a terminal page has its pane's tab bar. These are
// the ones that have none -- the two connection states, the app hub, a
// window holding no workspace, and a workspace whose page has no panes
// yet.
//
// A window's top edge has two jobs it cannot go without: leaving room for
// whatever of the window's corner overhangs a collapsed sidebar rail, and
// offering somewhere to grab the window. A branch that draws no header
// and no chrome row is a window that cannot be moved by its own top edge.

export interface WindowChromeInput {
  /// layoutState's connection status. Anything but `ready` is a
  /// connecting or failed screen, which draws no header of its own.
  status: string;
  /// The app hub is open over every workspace, and has no strip.
  appHubOpen: boolean;
  /// App-level Settings as a full page — same chrome need as the hub.
  appSettingsOpen: boolean;
  /// This window holds no workspace at all.
  hasWorkspace: boolean;
  /// The hub tab (or `terminal`) the active workspace is showing.
  activeView: string;
  /// True where the terminal view has a page tree to render panes from.
  /// A page with no panes yet has no tab bar, and so no header.
  hasPageTree: boolean;
}

export function needsChromeRow(input: WindowChromeInput): boolean {
  if (input.status !== "ready") return true;
  if (input.appHubOpen) return true;
  if (input.appSettingsOpen) return true;
  if (!input.hasWorkspace) return true;
  // Every hub tab draws its own strip; only the terminal view can be
  // left without a header, and only before it has a page to draw.
  return input.activeView === "terminal" && !input.hasPageTree;
}
