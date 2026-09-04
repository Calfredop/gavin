// Dragging the window by a bar, as a Svelte action.
//
// The app has no native decorations, so every pixel that moves the
// window is one the frontend nominated. That used to be easy: the title
// bar was a full-width strip whose middle was nothing but drag. It is
// not full width any more -- the hub tabs and a page's session tabs are
// the top edge of the window now, and the strip that survives only
// covers the sidebar. So the gesture has to be something more than one
// element can offer, and the two places that offer it (the strip over
// the sidebar, and the empty run of the hub tab row) share it from here
// rather than each wiring startDragging to its own mousedown.
//
// A pane's tab row deliberately does NOT use this: the empty space on
// that row already means "drag this pane", and a bar that moved either
// the pane or the whole window depending on invisible state is worse
// than a small drag handle.
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { createDoubleClickTracker, doubleClickAction } from "./titleBarGesture";

/// `use:windowDrag` on any element whose empty space should move the
/// window. data-tauri-drag-region alone is unreliable depending on the
/// webview version -- startDragging() is the documented, directly
/// controlled mechanism and is what actually makes a bar draggable.
/// Left-click only, so this never hijacks right- or middle-click.
///
/// Double-click: the tracker keeps the 2nd mousedown from starting a
/// drag (a native drag swallows the mouseup) and fires on the mouseup if
/// the cursor stayed put -- macOS semantics. The action honors the
/// user's "Double-click a window's title bar to" System Setting, read
/// from NSUserDefaults on the Rust side (null off macOS -> zoom).
export function windowDrag(node: HTMLElement): { destroy: () => void } {
  const doubleClick = createDoubleClickTracker();

  function onMouseDown(event: MouseEvent): void {
    if (doubleClick.mousedown(event) === "drag") {
      void getCurrentWindow().startDragging();
    }
  }

  async function onMouseUp(event: MouseEvent): Promise<void> {
    if (!doubleClick.mouseup(event)) return;
    const pref = await invoke<string | null>("title_bar_double_click_action");
    const win = getCurrentWindow();
    switch (doubleClickAction(pref)) {
      case "toggleMaximize":
        await win.toggleMaximize();
        break;
      case "minimize":
        await win.minimize();
        break;
      case "none":
        break;
    }
  }

  const up = (event: MouseEvent): void => void onMouseUp(event);
  node.addEventListener("mousedown", onMouseDown);
  node.addEventListener("mouseup", up);
  return {
    destroy() {
      node.removeEventListener("mousedown", onMouseDown);
      node.removeEventListener("mouseup", up);
    },
  };
}
