// The eight grips that resize a borderless window, as data.
//
// macOS does not need them: an NSWindow with `decorations: false` keeps
// the OS's own edge-drag resizing (only the title-bar DOUBLE-click is
// lost, which mac_window.rs puts back with an event monitor). GTK does
// not. `gtk_window_set_decorated(false)` removes the frame that owns the
// resize grips along with the title bar, so under WebKitGTK a gavin
// window can be moved -- windowDrag hands the pointer to the window
// manager -- and never resized, at any edge, with no visible reason why.
//
// The frontend has to nominate those pixels the same way it nominates
// the ones that drag: eight fixed strips over the window's own border,
// each handing the pointer to `startResizeDragging` in its direction.
// Which is exactly what a GTK client-side-decorated app does; the only
// difference is that ours is drawn in the DOM.
//
// The table lives here rather than in the component because it is the
// part with rules -- a direction paired with the wrong cursor, or a
// corner that an edge covers, is a bug you can only see by dragging --
// and because .svelte files are the one thing the suites cannot read.

/** Tauri's `ResizeDirection`, spelled out so this module needs no import. */
export type ResizeDirection =
  | "North"
  | "South"
  | "East"
  | "West"
  | "NorthEast"
  | "NorthWest"
  | "SouthEast"
  | "SouthWest";

export interface ResizeZone {
  direction: ResizeDirection;
  /** The CSS cursor that names the axis this grip moves along. */
  cursor: string;
  /** Absolute placement inside the window-sized overlay. */
  style: string;
}

/// How wide a grip is. Six, not the two or three a border looks like:
/// the pointer has to be able to find it without the pixel-hunting a
/// hairline forces, and this is the figure GTK's own invisible resize
/// border uses.
export const GRIP = 6;

/// A corner grip is square and bigger than the edge is thick, so the
/// diagonal drag -- the one people reach for -- is not a 6x6 target.
export const CORNER = 14;

/// The eight zones, EDGES FIRST.
///
/// The order is the whole of the hit-testing: these are siblings in one
/// stacking context, so a later one paints over an earlier one, and a
/// corner has to beat the two edges it overlaps or the diagonal drag is
/// unreachable everywhere except a 14x8 sliver.
export function resizeZones(): ResizeZone[] {
  const edge = (
    direction: ResizeDirection,
    cursor: string,
    style: string
  ): ResizeZone => ({ direction, cursor, style });
  return [
    edge("North", "ns-resize", `top:0;left:0;right:0;height:${GRIP}px`),
    edge("South", "ns-resize", `bottom:0;left:0;right:0;height:${GRIP}px`),
    edge("West", "ew-resize", `top:0;bottom:0;left:0;width:${GRIP}px`),
    edge("East", "ew-resize", `top:0;bottom:0;right:0;width:${GRIP}px`),
    edge("NorthWest", "nwse-resize", corner("top:0;left:0")),
    edge("NorthEast", "nesw-resize", corner("top:0;right:0")),
    edge("SouthWest", "nesw-resize", corner("bottom:0;left:0")),
    edge("SouthEast", "nwse-resize", corner("bottom:0;right:0")),
  ];
}

function corner(anchor: string): string {
  return `${anchor};width:${CORNER}px;height:${CORNER}px`;
}

/// Whether this platform draws its own resize grips, given what
/// `platform()` reported. macOS does; every other target of this app is
/// a borderless GTK window that does not.
export function needsResizeGrips(macOS: boolean): boolean {
  return !macOS;
}
