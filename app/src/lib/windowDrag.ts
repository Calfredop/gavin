// Dragging the window by a bar, as a Svelte action.
//
// The app has no native decorations, so every pixel that moves the
// window is one the frontend nominated. That used to be easy: the title
// bar was a full-width strip whose middle was nothing but drag. It is
// not full width any more -- the hub tabs and a page's session tabs are
// the top edge of the window now, and the strip that survives only
// covers the sidebar. So the gesture has to be something more than one
// element can offer, and the three places that offer it (the strip over
// the sidebar, and the empty run of each tab row -- the hub's and a
// pane's) share it from here rather than each wiring startDragging to
// its own mousedown.
//
// A pane's tab row uses it too, and did not always: the empty run there
// used to drag the PANE. Two gestures cannot share one surface --
// startDragging() takes the pointer from the webview before any
// dragstart could fire, so whichever is armed on mousedown wins outright
// -- and of the two, the one a human reaches for on the top edge of the
// window is the window. The pane drag had no other surface and is gone;
// dragging a tab is what the row keeps.
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { createDoubleClickTracker, createDragIntent, doubleClickAction } from "./titleBarGesture";

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

/// `use:windowDragOrClick={onClick}` on a surface that a click ACTS on
/// but that is also, while it is up, the only thing covering the window's
/// title bar: the modal backdrop. Press and move it and the window moves;
/// press and release without moving and the click runs.
///
/// A modal used to freeze the window in place. The backdrop is fixed over
/// the whole window -- the tab row, the strip over the sidebar, every
/// surface `windowDrag` is on -- so with a dialog up there was nowhere
/// left to grab, and the one gesture the backdrop did have was the one
/// that dismissed it. Reaching for the window and getting a discard
/// prompt is the bug this closes: a drag is not a dismissal.
///
/// Only a press that STARTS on the node itself counts, so a selection
/// dragged out of the panel and released over the backdrop neither moves
/// the window nor closes the dialog.
export function windowDragOrClick(
  node: HTMLElement,
  onClick: (() => void) | null
): { update: (next: (() => void) | null) => void; destroy: () => void } {
  const intent = createDragIntent();
  let act = onClick;
  let watching = false;

  function stopWatching(): void {
    if (!watching) return;
    watching = false;
    window.removeEventListener("mousemove", onMouseMove, true);
    window.removeEventListener("mouseup", onMouseUp, true);
  }

  // On the window and in capture, not on the node: once the press is
  // armed the pointer is free to leave the backdrop -- over the panel,
  // over a tab row -- and the gesture still belongs to this press.
  function onMouseMove(event: MouseEvent): void {
    if (!intent.move(event)) return;
    stopWatching();
    intent.cancel();
    void getCurrentWindow().startDragging();
  }

  function onMouseUp(event: MouseEvent): void {
    const click = intent.up(event);
    stopWatching();
    if (click) act?.();
  }

  function onMouseDown(event: MouseEvent): void {
    if (!act) return;
    if (event.target !== node) return;
    if (!intent.down(event)) return;
    watching = true;
    window.addEventListener("mousemove", onMouseMove, true);
    window.addEventListener("mouseup", onMouseUp, true);
  }

  node.addEventListener("mousedown", onMouseDown);
  return {
    update(next) {
      act = next;
    },
    destroy() {
      stopWatching();
      node.removeEventListener("mousedown", onMouseDown);
    },
  };
}
