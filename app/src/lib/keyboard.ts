import { get } from "svelte/store";
import { layoutState, splitPane, addTab, closeSession } from "./layoutState";
import { copySelection, pasteClipboard } from "./clipboard";
import { confirmTabClose } from "./confirmClose";

async function handleKeydown(event: KeyboardEvent): Promise<void> {
  // metaKey is Cmd on macOS -- the app is macOS-first per the project roadmap.
  if (!event.metaKey) return;
  const state = get(layoutState);
  if (!state.focusedSessionId) return;

  const key = event.key.toLowerCase();

  if (key === "d" && event.shiftKey) {
    event.preventDefault();
    event.stopPropagation();
    await splitPane(state.focusedSessionId, "column");
  } else if (key === "d") {
    event.preventDefault();
    event.stopPropagation();
    await splitPane(state.focusedSessionId, "row");
  } else if (key === "t") {
    event.preventDefault();
    event.stopPropagation();
    await addTab(state.focusedSessionId);
  } else if (key === "w") {
    event.preventDefault();
    event.stopPropagation();
    if (await confirmTabClose(state.focusedSessionId)) {
      await closeSession(state.focusedSessionId);
    }
  } else if (key === "c") {
    event.preventDefault();
    event.stopPropagation();
    await copySelection();
  } else if (key === "v") {
    event.preventDefault();
    event.stopPropagation();
    await pasteClipboard();
  }
}

export function installKeyboardShortcuts(): () => void {
  // Capture phase, not bubble -- xterm.js's own keydown handler stops
  // propagation before a bubble-phase window listener would ever see it
  // (established the hard way in Milestone B).
  const listener = (event: KeyboardEvent) => {
    void handleKeydown(event);
  };
  window.addEventListener("keydown", listener, true);
  return () => window.removeEventListener("keydown", listener, true);
}
