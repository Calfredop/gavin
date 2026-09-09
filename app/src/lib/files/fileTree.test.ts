import { describe, it, expect } from "vitest";
import {
  DEFAULT_TREE_SHARE,
  NO_MATCH_MESSAGE,
  afterCreate,
  afterDelete,
  afterRename,
  ancestorsWithin,
  baseName,
  collapseDir,
  emptyTree,
  expandDir,
  filesGridColumns,
  filesMemoryKey,
  formatSize,
  isUnder,
  joinPath,
  loadFilesMemory,
  loadedDirs,
  loadedNodeCount,
  forgetChildren,
  nodeAt,
  nodesFrom,
  parentPath,
  resolveTreeShare,
  restoreTargets,
  saveFilesMemory,
  toggleDir,
  verifyRestored,
  visibleRows,
  withChildren,
  withError,
  type DirEntry,
  type FileTreeState,
} from "$lib/files/fileTree";

const ROOT = "/repo";

function entry(name: string, over: Partial<DirEntry> = {}): DirEntry {
  return { name, isDir: false, size: 0, symlink: false, ...over };
}

/// The tree used by most of the row tests:
///
///   /repo
///     app/        (open)
///       src/      (closed, but read)
///         main.ts
///       README.md
///     Cargo.toml
function sampleTree(): FileTreeState {
  let state = emptyTree(ROOT);
  state = expandDir(state, ROOT);
  state = withChildren(state, ROOT, [entry("app", { isDir: true }), entry("Cargo.toml", { size: 9 })]);
  state = expandDir(state, "/repo/app");
  state = withChildren(state, "/repo/app", [
    entry("src", { isDir: true }),
    entry("README.md", { size: 20 }),
  ]);
  state = withChildren(state, "/repo/app/src", [entry("main.ts", { size: 100 })]);
  return state;
}

function paths(state: FileTreeState, query = ""): string[] {
  return visibleRows(state, query).rows.map((r) => r.node.path);
}

describe("path arithmetic", () => {
  it("joins, splits and contains without tripping on a shared prefix", () => {
    expect(joinPath("/repo", "app")).toBe("/repo/app");
    // A root of "/" must not produce "//app".
    expect(joinPath("/", "app")).toBe("/app");
    expect(baseName("/repo/app/main.ts")).toBe("main.ts");
    expect(baseName("/repo/app/")).toBe("app");
    expect(parentPath("/repo/app/main.ts")).toBe("/repo/app");
    expect(parentPath("/repo")).toBe("/");

    expect(isUnder("/repo", "/repo/app")).toBe(true);
    // The separator is required: /repo-old is a different repository.
    expect(isUnder("/repo", "/repo-old/app")).toBe(false);
    // Strictly inside -- a directory does not contain itself.
    expect(isUnder("/repo", "/repo")).toBe(false);
  });

  it("lists the ancestors between the root and a file, and nothing outside it", () => {
    expect(ancestorsWithin("/repo", "/repo/app/src/main.ts")).toEqual([
      "/repo",
      "/repo/app",
      "/repo/app/src",
    ]);
    expect(ancestorsWithin("/repo", "/repo/Cargo.toml")).toEqual(["/repo"]);
    // A path from a root that has since moved opens nothing.
    expect(ancestorsWithin("/repo", "/elsewhere/a.md")).toEqual([]);
  });
});

describe("ordering", () => {
  it("puts directories first and sorts the rest case-insensitively", () => {
    const nodes = nodesFrom("/repo", [
      entry("README.md"),
      entry("app", { isDir: true }),
      entry("Cargo.toml"),
      entry("Zed", { isDir: true }),
      entry("build.rs"),
    ]);
    expect(nodes.map((n) => n.name)).toEqual(["app", "Zed", "build.rs", "Cargo.toml", "README.md"]);
  });

  it("gives every node an absolute path and keeps the host's link verdict", () => {
    const nodes = nodesFrom("/repo", [entry("link", { symlink: true }), entry("src", { isDir: true })]);
    expect(nodes[0].path).toBe("/repo/src");
    const link = nodes.find((n) => n.name === "link")!;
    expect(link.path).toBe("/repo/link");
    // The host reports a symlink as a non-directory precisely so the
    // tree never offers to walk through it.
    expect(link.symlink).toBe(true);
    expect(link.isDir).toBe(false);
  });
});

describe("expansion", () => {
  it("toggles a directory and keeps its listing when it closes", () => {
    let state = sampleTree();
    expect(paths(state)).toEqual([
      "/repo",
      "/repo/app",
      "/repo/app/src",
      "/repo/app/README.md",
      "/repo/Cargo.toml",
    ]);

    state = toggleDir(state, "/repo/app");
    expect(paths(state)).toEqual(["/repo", "/repo/app", "/repo/Cargo.toml"]);
    // Re-opening must not cost a second read of a directory nothing has
    // been told changed.
    expect(state.children["/repo/app"]).toBeDefined();
    state = toggleDir(state, "/repo/app");
    expect(paths(state)).toContain("/repo/app/README.md");
  });

  it("marks an open but unread directory unloaded rather than empty", () => {
    let state = expandDir(emptyTree(ROOT), ROOT);
    state = withChildren(state, ROOT, [entry("target", { isDir: true })]);
    state = expandDir(state, "/repo/target");

    const row = visibleRows(state).rows.find((r) => r.node.path === "/repo/target")!;
    expect(row.expanded).toBe(true);
    // "We have not looked" is not "there is nothing there".
    expect(row.loaded).toBe(false);

    state = withError(state, "/repo/target", "permission denied");
    expect(visibleRows(state).rows.find((r) => r.node.path === "/repo/target")!.error).toBe(
      "permission denied"
    );
    // A read that succeeds afterwards clears the explanation.
    state = withChildren(state, "/repo/target", []);
    const healed = visibleRows(state).rows.find((r) => r.node.path === "/repo/target")!;
    expect(healed.error).toBeNull();
    expect(healed.loaded).toBe(true);
  });

  it("Refresh forgets the listings and keeps what is open", () => {
    let state = sampleTree();
    expect(loadedDirs(state).sort()).toEqual(["/repo", "/repo/app", "/repo/app/src"]);
    state = forgetChildren(state, loadedDirs(state));
    expect(loadedDirs(state)).toEqual([]);
    expect(state.expanded["/repo/app"]).toBe(true);
  });
});

describe("the filter", () => {
  it("narrows to matching names and keeps their ancestors visible", () => {
    const state = sampleTree();
    // main.ts sits in a CLOSED directory: filtering ignores expansion,
    // because a match nobody can see is not a match.
    expect(paths(state, "main")).toEqual(["/repo", "/repo/app", "/repo/app/src", "/repo/app/src/main.ts"]);
    const src = visibleRows(state, "main").rows.find((r) => r.node.path === "/repo/app/src")!;
    expect(src.expanded).toBe(true);
  });

  it("shows a matching directory without dragging its whole subtree along", () => {
    const view = visibleRows(sampleTree(), "src");
    expect(view.rows.map((r) => r.node.path)).toEqual(["/repo", "/repo/app", "/repo/app/src"]);
    // It matched on its own name, so it renders closed.
    expect(view.rows[2].expanded).toBe(false);
  });

  it("matches case-insensitively and counts against everything it has loaded", () => {
    const view = visibleRows(sampleTree(), "README");
    expect(view.rows.map((r) => r.node.path)).toEqual(["/repo", "/repo/app", "/repo/app/README.md"]);
    expect(view.filtering).toBe(true);
    // app, Cargo.toml, src, README.md, main.ts.
    expect(view.total).toBe(loadedNodeCount(sampleTree()));
    expect(view.total).toBe(5);
    expect(view.shown).toBe(2);
  });

  it("keeps the root row when nothing matches, and blames only the folders it has opened", () => {
    const view = visibleRows(sampleTree(), "nothing-like-this");
    expect(view.rows.map((r) => r.node.path)).toEqual(["/repo"]);
    expect(view.shown).toBe(0);
    // The filter only ever sees loaded nodes -- walking to find the rest
    // is the trap the lazy tree exists to avoid -- so the empty state
    // must say which folders it looked in.
    expect(NO_MATCH_MESSAGE).toContain("folders you have opened");
  });

  it("treats whitespace as no filter at all", () => {
    const view = visibleRows(sampleTree(), "   ");
    expect(view.filtering).toBe(false);
    expect(view.rows.length).toBe(5);
  });
});

describe("reconciling a mutation", () => {
  it("inserts a created entry in sort order without a re-read", () => {
    let state = sampleTree();
    state = afterCreate(state, "/repo/app/Makefile", false);
    expect(state.children["/repo/app"].map((n) => n.name)).toEqual([
      "src",
      "Makefile",
      "README.md",
    ]);

    // A new directory is known to be empty -- it was just made, so
    // opening it must not sit on "reading…" for a listing that can only
    // come back empty.
    state = afterCreate(state, "/repo/docs", true);
    expect(state.children["/repo/docs"]).toEqual([]);
    expect(nodeAt(state, "/repo/docs")?.isDir).toBe(true);
  });

  it("leaves an unopened parent alone", () => {
    const state = afterCreate(sampleTree(), "/repo/target/debug/gavin", false);
    // Nothing invented under a folder nobody has read: it will be there
    // when it is opened.
    expect(state.children["/repo/target/debug"]).toBeUndefined();
  });

  it("drops a deleted entry and everything the tree knew beneath it", () => {
    let state = sampleTree();
    state = afterDelete(state, "/repo/app");
    expect(state.children["/repo"].map((n) => n.name)).toEqual(["Cargo.toml"]);
    // Left behind, these would resurrect under a folder recreated later
    // with the same name.
    expect(state.children["/repo/app"]).toBeUndefined();
    expect(state.children["/repo/app/src"]).toBeUndefined();
    expect(state.expanded["/repo/app"]).toBeUndefined();
  });

  it("re-keys a renamed subtree instead of folding it shut", () => {
    let state = sampleTree();
    state = expandDir(state, "/repo/app/src");
    state = afterRename(state, "/repo/app", "/repo/application");

    expect(state.children["/repo"].map((n) => n.name)).toEqual(["application", "Cargo.toml"]);
    // The human's own rename must not close the folders they were
    // working in.
    expect(state.expanded["/repo/application"]).toBe(true);
    expect(state.expanded["/repo/application/src"]).toBe(true);
    expect(state.children["/repo/application/src"].map((n) => n.path)).toEqual([
      "/repo/application/src/main.ts",
    ]);
    expect(state.children["/repo/app"]).toBeUndefined();
    expect(paths(state)).toEqual([
      "/repo",
      "/repo/application",
      "/repo/application/src",
      "/repo/application/src/main.ts",
      "/repo/application/README.md",
      "/repo/Cargo.toml",
    ]);
  });

  it("moves an entry between two open directories and re-sorts the destination", () => {
    let state = sampleTree();
    state = afterRename(state, "/repo/Cargo.toml", "/repo/app/Cargo.toml");
    expect(state.children["/repo"].map((n) => n.name)).toEqual(["app"]);
    expect(state.children["/repo/app"].map((n) => n.name)).toEqual([
      "src",
      "Cargo.toml",
      "README.md",
    ]);
    // The file's own facts travel with it.
    expect(nodeAt(state, "/repo/app/Cargo.toml")?.size).toBe(9);
  });

  it("still patches the destination when the source was never listed", () => {
    const state = afterRename(sampleTree(), "/repo/target/x.log", "/repo/x.log");
    expect(state.children["/repo"].map((n) => n.name)).toEqual(["app", "Cargo.toml", "x.log"]);
  });
});

describe("the remembered tab", () => {
  function fakeStorage() {
    const map = new Map<string, string>();
    return {
      map,
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
    };
  }

  it("round-trips the selection, the open folders and the split", () => {
    const storage = fakeStorage();
    saveFilesMemory(
      "ws-1",
      { selected: "/repo/app/README.md", expanded: ["/repo", "/repo/app"], treeShare: 0.4 },
      storage
    );
    expect(storage.map.has(filesMemoryKey("ws-1"))).toBe(true);
    expect(loadFilesMemory("ws-1", storage)).toEqual({
      selected: "/repo/app/README.md",
      expanded: ["/repo", "/repo/app"],
      treeShare: 0.4,
    });
    // Per workspace: each has its own root, so one says nothing about
    // another.
    expect(loadFilesMemory("ws-2", storage).selected).toBeNull();
  });

  it("reads a corrupt or hand-edited record as nothing remembered", () => {
    const storage = fakeStorage();
    storage.setItem(filesMemoryKey("ws-1"), "{not json");
    expect(loadFilesMemory("ws-1", storage)).toEqual({
      selected: null,
      expanded: [],
      treeShare: DEFAULT_TREE_SHARE,
    });

    storage.setItem(
      filesMemoryKey("ws-1"),
      JSON.stringify({ selected: 42, expanded: ["/repo", 7], treeShare: 5 })
    );
    const loaded = loadFilesMemory("ws-1", storage);
    expect(loaded.selected).toBeNull();
    expect(loaded.expanded).toEqual(["/repo"]);
    // A share of 5 would push the divider off the pane with nothing left
    // on screen to drag it back with.
    expect(loaded.treeShare).toBe(DEFAULT_TREE_SHARE);
  });

  it("survives a storage that refuses to be read or written", () => {
    const dead = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {},
    };
    expect(loadFilesMemory("ws-1", dead).selected).toBeNull();
    expect(() =>
      saveFilesMemory("ws-1", { selected: "/a", expanded: [], treeShare: 0.3 }, dead)
    ).not.toThrow();
  });

  it("opens the remembered folders plus every ancestor of the remembered file", () => {
    const targets = restoreTargets("/repo", {
      selected: "/repo/app/src/main.ts",
      expanded: ["/repo/docs", "/elsewhere/nope"],
      treeShare: 0.3,
    });
    // Parents before children, so every read finds its parent listed.
    expect(targets).toEqual(["/repo", "/repo/app", "/repo/docs", "/repo/app/src"]);
    // A root that moved must not send the tree reading outside it.
    expect(targets).not.toContain("/elsewhere/nope");
  });

  it("holds a restored selection open until the tree can answer for it", () => {
    let state = emptyTree(ROOT);
    // Clearing it now would silently drop the human's open file on every
    // visit to the tab.
    expect(verifyRestored(state, "/repo/app/README.md")).toBe("unknown");

    state = withChildren(state, "/repo", [entry("app", { isDir: true })]);
    expect(verifyRestored(state, "/repo/app/README.md")).toBe("unknown");

    state = withChildren(state, "/repo/app", [entry("README.md")]);
    expect(verifyRestored(state, "/repo/app/README.md")).toBe("present");
    expect(verifyRestored(state, "/repo/app/gone.md")).toBe("missing");
    // A path from another root is not this tree's to hold.
    expect(verifyRestored(state, "/elsewhere/a.md")).toBe("missing");
  });

  it("renders the split as fr tracks and never as a runaway float", () => {
    expect(resolveTreeShare(0.4)).toBe(0.4);
    expect(resolveTreeShare(null)).toBe(DEFAULT_TREE_SHARE);
    expect(resolveTreeShare(Number.NaN)).toBe(DEFAULT_TREE_SHARE);
    expect(resolveTreeShare(0.01)).toBe(DEFAULT_TREE_SHARE);
    expect(filesGridColumns(0.3)).toBe("0.3fr 6px 0.7fr");
    expect(filesGridColumns(1 / 3)).toBe("0.3333fr 6px 0.6667fr");
  });
});

describe("formatSize", () => {
  it("keeps bytes exact and rounds larger units", () => {
    expect(formatSize(0)).toBe("0 B");
    expect(formatSize(999)).toBe("999 B");
    expect(formatSize(1024)).toBe("1 KB");
    expect(formatSize(1536)).toBe("1.5 KB");
    expect(formatSize(20 * 1024)).toBe("20 KB");
    expect(formatSize(5 * 1024 * 1024)).toBe("5 MB");
    expect(formatSize(-1)).toBe("");
  });
});

describe("collapse", () => {
  it("is a no-op on a directory that is already shut", () => {
    const state = sampleTree();
    expect(collapseDir(collapseDir(state, "/repo/app"), "/repo/app").expanded["/repo/app"]).toBeUndefined();
  });
});
