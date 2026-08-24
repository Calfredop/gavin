import { describe, it, expect, vi } from "vitest";
import { fileMenuItems, contextRowMenuItems, groupRowMenuItems, type TreeMenuCallbacks } from "./planTreeMenu";
import type { ExplorerContextNode, ExplorerFile } from "./planExplorer";

function callbacks(over: Partial<TreeMenuCallbacks> = {}): TreeMenuCallbacks {
  return {
    onSelect: vi.fn(),
    onOpenInSplit: vi.fn(),
    onDeleteFile: vi.fn(),
    onRestoreFile: vi.fn(),
    restoreBlocked: null,
    onCompose: vi.fn(),
    onRemoveOutside: vi.fn(),
    onShowInFinder: vi.fn(),
    ...over,
  };
}

function file(over: Partial<ExplorerFile> = {}): ExplorerFile {
  return {
    path: "/ws/.gavin-root/plans/a.md",
    label: "a",
    group: "plans",
    status: null,
    priority: null,
    parseWarning: false,
    ...over,
  };
}

function ctx(over: Partial<ExplorerContextNode> = {}): ExplorerContextNode {
  return {
    folderPath: "/ws",
    name: "ws",
    kind: "root",
    configWarning: false,
    gavinDir: "/ws/.gavin-root",
    depth: 0,
    outside: false,
    groups: [],
    ...over,
  };
}

describe("fileMenuItems", () => {
  it("offers open, split and delete, wired to the file's path", () => {
    const cb = callbacks();
    const items = fileMenuItems(file(), cb);
    expect(items.map((i) => i.label)).toEqual(["Open", "Open beside terminal", "Delete…"]);
    items[0].onPick();
    expect(cb.onSelect).toHaveBeenCalledWith("/ws/.gavin-root/plans/a.md");
    items[1].onPick();
    expect(cb.onOpenInSplit).toHaveBeenCalledWith("/ws/.gavin-root/plans/a.md");
    items[2].onPick();
    expect(cb.onDeleteFile).toHaveBeenCalledWith(file());
    expect(items[2].danger).toBe(true);
  });

  it("omits the split entry when no terminal anchors one", () => {
    const items = fileMenuItems(file(), callbacks({ onOpenInSplit: null }));
    expect(items.map((i) => i.label)).toEqual(["Open", "Delete…"]);
  });

  const archived = file({ path: "/ws/.gavin-root/plans/archive/a.md", group: "archive" });

  it("offers restore for a file in the archive, wired to that file", () => {
    const cb = callbacks();
    const items = fileMenuItems(archived, cb);
    expect(items.map((i) => i.label)).toEqual([
      "Open",
      "Open beside terminal",
      "Restore from archive",
      "Delete…",
    ]);
    items[2].onPick();
    expect(cb.onRestoreFile).toHaveBeenCalledWith(archived);
    expect(items[2].disabled).toBeFalsy();
  });

  it("offers restore nowhere else — a plans, docs or specs row has no way back", () => {
    for (const group of ["plans", "docs", "specs"] as const) {
      const items = fileMenuItems(file({ group }), callbacks());
      expect(items.map((i) => i.label).join()).not.toContain("Restore");
    }
  });

  it("omits restore when there is no board projection to restore through", () => {
    const items = fileMenuItems(archived, callbacks({ onRestoreFile: null }));
    expect(items.map((i) => i.label)).toEqual(["Open", "Open beside terminal", "Delete…"]);
  });

  it("shows restore disabled, saying why, when the daemon is too old", () => {
    const cb = callbacks({ restoreBlocked: "Needs daemon v13; the running daemon is v12." });
    const items = fileMenuItems(archived, cb);
    const restore = items.find((i) => i.label.startsWith("Restore"));
    expect(restore?.disabled).toBe(true);
    expect(restore?.label).toContain("restart the daemon");
  });
});

describe("contextRowMenuItems", () => {
  it("offers a composer entry per group, then Show in Finder for the context folder", () => {
    const cb = callbacks();
    const items = contextRowMenuItems(ctx(), cb);
    expect(items.map((i) => i.label)).toEqual(["New plan…", "New doc…", "New spec…", "Show in Finder"]);
    items[1].onPick();
    expect(cb.onCompose).toHaveBeenCalledWith("/ws", "docs");
    items[3].onPick();
    expect(cb.onShowInFinder).toHaveBeenCalledWith("/ws");
  });

  it("adds Remove from navigator only for outside contexts", () => {
    const cb = callbacks();
    const outside = ctx({ outside: true, folderPath: "/elsewhere/lib" });
    const items = contextRowMenuItems(outside, cb);
    expect(items.at(-1)?.label).toBe("Remove from navigator");
    expect(items.at(-1)?.danger).toBe(true);
    items.at(-1)?.onPick();
    expect(cb.onRemoveOutside).toHaveBeenCalledWith(outside);
    expect(contextRowMenuItems(ctx(), cb).map((i) => i.label)).not.toContain("Remove from navigator");
  });
});

describe("groupRowMenuItems", () => {
  it("offers the composer entry for that group, then Show in Finder for the group folder", () => {
    const cb = callbacks();
    const items = groupRowMenuItems(ctx(), "specs", cb);
    expect(items.map((i) => i.label)).toEqual(["New spec…", "Show in Finder"]);
    items[0].onPick();
    expect(cb.onCompose).toHaveBeenCalledWith("/ws", "specs");
    items[1].onPick();
    expect(cb.onShowInFinder).toHaveBeenCalledWith("/ws/.gavin-root/specs");
  });

  it("offers no composer for the archive — nothing is authored into it", () => {
    const cb = callbacks();
    const items = groupRowMenuItems(ctx(), "archive", cb);
    expect(items.map((i) => i.label)).toEqual(["Show in Finder"]);
    items[0].onPick();
    // ...and the folder it opens is the real one, inside plans/.
    expect(cb.onShowInFinder).toHaveBeenCalledWith("/ws/.gavin-root/plans/archive");
  });
});
