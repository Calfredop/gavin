import { describe, it, expect, vi } from "vitest";
import { fileMenuItems, contextRowMenuItems, groupRowMenuItems, type TreeMenuCallbacks } from "./planTreeMenu";
import type { ExplorerContextNode, ExplorerFile } from "./planExplorer";

function callbacks(over: Partial<TreeMenuCallbacks> = {}): TreeMenuCallbacks {
  return {
    onSelect: vi.fn(),
    onOpenInSplit: vi.fn(),
    onDeleteFile: vi.fn(),
    onCompose: vi.fn(),
    onRemoveOutside: vi.fn(),
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
});

describe("contextRowMenuItems", () => {
  it("offers a composer entry per group", () => {
    const cb = callbacks();
    const items = contextRowMenuItems(ctx(), cb);
    expect(items.map((i) => i.label)).toEqual(["New plan…", "New doc…", "New spec…"]);
    items[1].onPick();
    expect(cb.onCompose).toHaveBeenCalledWith("/ws", "docs");
  });

  it("adds Remove from navigator only for outside contexts", () => {
    const cb = callbacks();
    const outside = ctx({ outside: true, folderPath: "/elsewhere/lib" });
    const items = contextRowMenuItems(outside, cb);
    expect(items.at(-1)?.label).toBe("Remove from navigator");
    expect(items.at(-1)?.danger).toBe(true);
    items.at(-1)?.onPick();
    expect(cb.onRemoveOutside).toHaveBeenCalledWith(outside);
  });
});

describe("groupRowMenuItems", () => {
  it("offers a single composer entry for that group", () => {
    const cb = callbacks();
    const items = groupRowMenuItems(ctx(), "specs", cb);
    expect(items.map((i) => i.label)).toEqual(["New spec…"]);
    items[0].onPick();
    expect(cb.onCompose).toHaveBeenCalledWith("/ws", "specs");
  });
});
