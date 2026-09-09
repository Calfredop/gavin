import { describe, it, expect, vi } from "vitest";
import {
  directoryMenuItems,
  fileMenuItems,
  openLabel,
  rowMenuItems,
  trashPromptLines,
  type FileTreeMenuCallbacks,
} from "./fileTreeMenu";
import type { FileNode } from "./fileTree";

function node(over: Partial<FileNode> = {}): FileNode {
  return {
    path: "/repo/app/README.md",
    name: "README.md",
    isDir: false,
    size: 20,
    symlink: false,
    ...over,
  };
}

function callbacks(over: Partial<FileTreeMenuCallbacks> = {}): FileTreeMenuCallbacks {
  return {
    onOpen: vi.fn(),
    onOpenInTab: vi.fn(),
    onCopyPath: vi.fn(),
    onRevealInFinder: vi.fn(),
    onNewFile: vi.fn(),
    onNewFolder: vi.fn(),
    onRename: vi.fn(),
    onTrash: vi.fn(),
    onRefresh: vi.fn(),
    onIgnore: vi.fn(),
    ...over,
  };
}

const ctx = (over: { isRoot: boolean; viewable: boolean }) => ({ root: "/repo", ...over });

const labels = (items: { label: string }[]) => items.map((i) => i.label);

describe("a file row's menu", () => {
  it("opens, tabs, copies, reveals, offers to ignore, renames and trashes", () => {
    const items = fileMenuItems(node(), ctx({ isRoot: false, viewable: true }), callbacks());
    expect(labels(items)).toEqual([
      "Open",
      "Open in a tab",
      "Copy path",
      "Reveal in Finder",
      "Ignore this file",
      "Ignore all *.md files",
      "Ignore this file (this checkout only)",
      "Rename…",
      "Move to Trash",
    ]);
    // Trash is the only red entry, and it is last.
    expect(items.filter((i) => i.danger).map((i) => i.label)).toEqual(["Move to Trash"]);
  });

  it("builds the ignore patterns from the path with the workspace root stripped off", () => {
    const cb = callbacks();
    const items = fileMenuItems(node(), ctx({ isRoot: false, viewable: true }), cb);
    items.find((i) => i.label === "Ignore this file")?.onPick();
    items.find((i) => i.label === "Ignore all *.md files")?.onPick();
    items.find((i) => i.label === "Ignore this file (this checkout only)")?.onPick();
    expect(cb.onIgnore).toHaveBeenNthCalledWith(1, "gitignore", "/app/README.md");
    expect(cb.onIgnore).toHaveBeenNthCalledWith(2, "gitignore", "*.md");
    expect(cb.onIgnore).toHaveBeenNthCalledWith(3, "exclude", "/app/README.md");
  });

  it("omits the extension entry for a file with none", () => {
    const items = fileMenuItems(
      node({ path: "/repo/Makefile", name: "Makefile" }),
      ctx({ isRoot: false, viewable: true }),
      callbacks()
    );
    expect(labels(items).some((l) => l.startsWith("Ignore all"))).toBe(false);
    expect(labels(items)).toContain("Ignore this file");
  });

  it("says where a file gavin cannot render will open, and offers it no tab", () => {
    const items = fileMenuItems(
      node({ path: "/repo/logo.png", name: "logo.png" }),
      ctx({ isRoot: false, viewable: false }),
      callbacks()
    );
    // The human should not have to click to find out it leaves the app.
    expect(labels(items)[0]).toBe("Open in the default app");
    expect(openLabel(false)).toBe("Open in the default app");
    // A tab hosts gavin's editor; a file the editor cannot render has
    // nothing to open in one.
    expect(labels(items)).not.toContain("Open in a tab");
  });

  it("omits the tab entry when there is no session to anchor a split to", () => {
    const items = fileMenuItems(
      node(),
      ctx({ isRoot: false, viewable: true }),
      callbacks({ onOpenInTab: null })
    );
    expect(labels(items)).not.toContain("Open in a tab");
    // Omitted rather than shown dead -- same call as the Plans tree's.
    expect(items.some((i) => i.disabled)).toBe(false);
  });

  it("hands the row's own node to whichever action was picked", () => {
    const cb = callbacks();
    const file = node();
    const items = fileMenuItems(file, ctx({ isRoot: false, viewable: true }), cb);
    for (const item of items) item.onPick();
    expect(cb.onOpen).toHaveBeenCalledWith(file);
    expect(cb.onOpenInTab).toHaveBeenCalledWith(file);
    expect(cb.onCopyPath).toHaveBeenCalledWith(file);
    expect(cb.onRevealInFinder).toHaveBeenCalledWith(file);
    expect(cb.onRename).toHaveBeenCalledWith(file);
    expect(cb.onTrash).toHaveBeenCalledWith(file);
  });
});

describe("a directory row's menu", () => {
  const dir = node({ path: "/repo/app", name: "app", isDir: true, size: 0 });

  it("creates, refreshes, offers to ignore, renames and trashes", () => {
    const items = directoryMenuItems(dir, ctx({ isRoot: false, viewable: false }), callbacks());
    expect(labels(items)).toEqual([
      "New file…",
      "New folder…",
      "Refresh",
      "Copy path",
      "Reveal in Finder",
      "Ignore this folder",
      "Ignore this folder (this checkout only)",
      "Rename…",
      "Move to Trash",
    ]);
  });

  it("builds a directory-only pattern, never an extension entry", () => {
    const cb = callbacks();
    const items = directoryMenuItems(dir, ctx({ isRoot: false, viewable: false }), cb);
    items.find((i) => i.label === "Ignore this folder")?.onPick();
    items.find((i) => i.label === "Ignore this folder (this checkout only)")?.onPick();
    expect(cb.onIgnore).toHaveBeenNthCalledWith(1, "gitignore", "/app/");
    expect(cb.onIgnore).toHaveBeenNthCalledWith(2, "exclude", "/app/");
  });

  it("refuses to offer the root a rename, a trash, or an ignore rule", () => {
    const root = node({ path: "/repo", name: "repo", isDir: true, size: 0 });
    const items = directoryMenuItems(root, ctx({ isRoot: true, viewable: false }), callbacks());
    // The host refuses rename and trash, and an entry that can only fail
    // is worse than no entry -- but the root is still where a top-level
    // file is created. Ignoring the repo root makes no sense at all.
    expect(labels(items)).not.toContain("Rename…");
    expect(labels(items)).not.toContain("Move to Trash");
    expect(labels(items)).not.toContain("Ignore this folder");
    expect(labels(items)).toContain("New file…");
    expect(labels(items)).toContain("Refresh");
  });

  it("is what rowMenuItems picks for a directory", () => {
    const cb = callbacks();
    expect(labels(rowMenuItems(dir, ctx({ isRoot: false, viewable: false }), cb))).toEqual(
      labels(directoryMenuItems(dir, ctx({ isRoot: false, viewable: false }), cb))
    );
    expect(labels(rowMenuItems(node(), ctx({ isRoot: false, viewable: true }), cb))).toEqual(
      labels(fileMenuItems(node(), ctx({ isRoot: false, viewable: true }), cb))
    );
  });
});

describe("the Trash prompt", () => {
  it("says what a folder costs, and that nothing is destroyed", () => {
    const folder = trashPromptLines(node({ name: "app", isDir: true }));
    expect(folder[0]).toContain("everything in it");
    expect(trashPromptLines(node())[0]).toBe("Moves README.md to the Trash.");
    // The promise the whole trash route exists to make.
    for (const lines of [folder, trashPromptLines(node())]) {
      expect(lines.at(-1)).toContain("put it back");
    }
  });
});
