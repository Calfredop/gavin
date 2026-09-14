import { describe, it, expect } from "vitest";
import { needsChromeRow } from "$lib/shell/windowChrome";

const ready = {
  status: "ready",
  appHubOpen: false,
  appSettingsOpen: false,
  hasWorkspace: true,
  activeView: "kanban",
  hasPageTree: true,
};

describe("needsChromeRow", () => {
  // Every hub tab draws its own strip, and a terminal page draws its
  // pane's tab bar -- neither needs a row of the window's own.
  it("is false where a header is already drawn", () => {
    expect(needsChromeRow(ready)).toBe(false);
    expect(needsChromeRow({ ...ready, activeView: "terminal" })).toBe(false);
  });

  // A connecting or failed screen has no workspace chrome at all, and a
  // window with no top edge to grab cannot be moved by it.
  it("is true for anything but a ready connection", () => {
    expect(needsChromeRow({ ...ready, status: "connecting" })).toBe(true);
    expect(needsChromeRow({ ...ready, status: "error" })).toBe(true);
  });

  it("is true for the app hub, which is drawn over every workspace", () => {
    expect(needsChromeRow({ ...ready, appHubOpen: true })).toBe(true);
  });

  it("is true for app Settings, which is also a full page over every workspace", () => {
    expect(needsChromeRow({ ...ready, appSettingsOpen: true })).toBe(true);
  });

  it("is true for a window holding no workspace", () => {
    expect(needsChromeRow({ ...ready, hasWorkspace: false })).toBe(true);
  });

  // The narrow case: the terminal view before its page has any panes,
  // where there is no tab bar to be the top edge.
  it("is true for a terminal page with no panes yet", () => {
    expect(needsChromeRow({ ...ready, activeView: "terminal", hasPageTree: false })).toBe(true);
  });

  // ...and only for the terminal view. A hub tab has its strip whether
  // or not the workspace has a page tree behind it.
  it("is false for a hub tab even with no page tree", () => {
    expect(needsChromeRow({ ...ready, activeView: "kanban", hasPageTree: false })).toBe(false);
  });
});
