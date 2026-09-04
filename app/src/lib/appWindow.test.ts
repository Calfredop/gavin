import { describe, it, expect } from "vitest";
import {
  MAIN_WINDOW_LABEL,
  activeWorkspaceForWindow,
  isInAnotherWindow,
  nextActiveAfterHandoff,
  ownerLabel,
  windowAction,
  windowActionLabel,
  workspaceWindowLabel,
  workspacesInWindow,
  type WorkspaceWindowMap,
} from "./appWindow";
import type { Workspace } from "./workspace";

const ws = (id: string): Workspace => ({
  id,
  name: id.toUpperCase(),
  pages: [],
  activePageId: null,
});

const three = [ws("a"), ws("b"), ws("c")];

describe("ownerLabel", () => {
  it("reads absence as the main window", () => {
    expect(ownerLabel({}, "a")).toBe(MAIN_WINDOW_LABEL);
    expect(ownerLabel({ a: "ws-a" }, "b")).toBe(MAIN_WINDOW_LABEL);
  });

  it("reads a recorded workspace as being in its own window", () => {
    expect(ownerLabel({ a: "ws-a" }, "a")).toBe("ws-a");
  });
});

describe("isInAnotherWindow", () => {
  // The question every activation asks before putting a workspace on
  // screen. A false negative here is two live panes on one PTY, each
  // reporting its own size to the daemon.
  it("is false for a workspace this window holds, either way it holds it", () => {
    expect(isInAnotherWindow({}, "a", MAIN_WINDOW_LABEL)).toBe(false);
    expect(isInAnotherWindow({ a: "ws-a" }, "a", "ws-a")).toBe(false);
  });

  it("is true for one held somewhere else -- including from the main window", () => {
    expect(isInAnotherWindow({ a: "ws-a" }, "a", MAIN_WINDOW_LABEL)).toBe(true);
    expect(isInAnotherWindow({}, "a", "ws-b")).toBe(true);
    expect(isInAnotherWindow({ a: "ws-a" }, "a", "ws-b")).toBe(true);
  });
});

describe("workspacesInWindow", () => {
  it("gives the main window everything nobody else took", () => {
    const map: WorkspaceWindowMap = { b: "ws-b" };
    expect(workspacesInWindow(three, map, MAIN_WINDOW_LABEL).map((w) => w.id)).toEqual(["a", "c"]);
  });

  it("gives a workspace window only what was handed to it", () => {
    const map: WorkspaceWindowMap = { b: "ws-b", c: "ws-c" };
    expect(workspacesInWindow(three, map, "ws-b").map((w) => w.id)).toEqual(["b"]);
  });

  it("keeps the stored order, which is the order the sidebar draws", () => {
    expect(workspacesInWindow(three, {}, MAIN_WINDOW_LABEL).map((w) => w.id)).toEqual(["a", "b", "c"]);
  });
});

describe("activeWorkspaceForWindow", () => {
  it("honours the stored id when this window actually holds it", () => {
    expect(activeWorkspaceForWindow(three, {}, MAIN_WINDOW_LABEL, "b")).toBe("b");
  });

  // The stored id is one value shared by every window, so it is a
  // preference, never an instruction: obeying it is how a workspace ends
  // up drawn in two windows at once.
  it("ignores a stored id that has moved into another window", () => {
    expect(activeWorkspaceForWindow(three, { b: "ws-b" }, MAIN_WINDOW_LABEL, "b")).toBe("a");
  });

  it("gives a workspace window its own workspace, whatever the file says", () => {
    expect(activeWorkspaceForWindow(three, { b: "ws-b" }, "ws-b", "a")).toBe("b");
  });

  it("answers null when this window holds nothing", () => {
    const everywhereElse = { a: "ws-a", b: "ws-b", c: "ws-c" };
    expect(activeWorkspaceForWindow(three, everywhereElse, MAIN_WINDOW_LABEL, "a")).toBe(null);
    expect(activeWorkspaceForWindow([], {}, MAIN_WINDOW_LABEL, null)).toBe(null);
  });
});

describe("nextActiveAfterHandoff", () => {
  it("looks at the workspace under the one that left", () => {
    expect(nextActiveAfterHandoff(three, {}, MAIN_WINDOW_LABEL, "a")).toBe("b");
    expect(nextActiveAfterHandoff(three, {}, MAIN_WINDOW_LABEL, "b")).toBe("c");
  });

  it("falls back up the list when the one that left was last", () => {
    expect(nextActiveAfterHandoff(three, {}, MAIN_WINDOW_LABEL, "c")).toBe("b");
  });

  // Skipping them is the point: they are in other windows, and switching
  // to one here is exactly what must never happen.
  it("never lands on a workspace another window is showing", () => {
    expect(nextActiveAfterHandoff(three, { b: "ws-b" }, MAIN_WINDOW_LABEL, "a")).toBe("c");
  });

  it("answers null when nothing is left -- the caller's cue to open the hub", () => {
    expect(nextActiveAfterHandoff([ws("a")], {}, MAIN_WINDOW_LABEL, "a")).toBe(null);
  });
});

describe("what the two entry points offer", () => {
  it("offers a window to a workspace the main window holds", () => {
    expect(windowAction({}, "a", MAIN_WINDOW_LABEL)).toBe("open");
    expect(windowActionLabel({}, "a", MAIN_WINDOW_LABEL)).toBe("Open in New Window");
  });

  // Never a second window onto one workspace -- the whole rule, stated
  // where the human reads it.
  it("offers only the way back to one that already has a window", () => {
    expect(windowAction({ a: "ws-a" }, "a", MAIN_WINDOW_LABEL)).toBe("show");
    expect(windowActionLabel({ a: "ws-a" }, "a", MAIN_WINDOW_LABEL)).toBe("Show in Its Window");
  });

  // From a workspace window, a workspace in the MAIN window is still
  // "somewhere else": the way to it is to raise that window, not to give
  // it a third one.
  it("sends a workspace window back to the main window for what lives there", () => {
    expect(windowAction({ a: "ws-a" }, "b", "ws-a")).toBe("show");
  });

  // The window a workspace IS has nothing to offer for it. Both gestures
  // would end where they started.
  it("offers nothing for the workspace this window was opened for", () => {
    const label = workspaceWindowLabel("a");
    expect(windowAction({ a: label }, "a", label)).toBe("none");
    expect(windowActionLabel({ a: label }, "a", label)).toBe(null);
  });

  // A workspace CREATED inside somebody else's workspace window is
  // sharing that window, not living in its own -- so it can still be
  // given one, and the label it would get proves which case this is.
  it("still offers a window to a workspace merely sharing one", () => {
    const label = workspaceWindowLabel("a");
    expect(windowAction({ a: label, b: label }, "b", label)).toBe("open");
  });
});
