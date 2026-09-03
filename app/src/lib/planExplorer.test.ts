import { describe, it, expect } from "vitest";
import {
  buildExplorerTree,
  followRenamedContext,
  followRenamedPath,
  slugFileName,
  isUnderRoot,
  statusOptions,
  newFilePath,
  groupFolder,
  isCardGroup,
  loadExplorerSelection,
  saveExplorerSelection,
  selectionStorageKey,
} from "./planExplorer";
import type { GavinContext, GavinTree, PlanFileInfo } from "./gavin";

function plan(fileName: string, overrides: Partial<PlanFileInfo> = {}): PlanFileInfo {
  return {
    path: `/ws/.gavin-root/plans/${fileName}`,
    fileName,
    title: fileName.replace(/\.md$/, ""),
    status: "To Do",
    priority: null,
    order: null,
    kind: "plan",
    parent: null,
    labels: [],
    checklistDone: 0,
    checklistTotal: 0,
    parseWarning: false,
    ...overrides,
  };
}

function ctx(folderPath: string, name: string, over: Partial<GavinContext> = {}): GavinContext {
  return {
    folderPath,
    kind: "context",
    name,
    plans: [],
    docs: [],
    specs: [],
    hasPrd: false,
    configWarning: false,
    ...over,
  };
}

function tree(contexts: GavinContext[]): GavinTree {
  return { rootPath: "/ws", rootMissing: false, contexts };
}

describe("buildExplorerTree", () => {
  it("puts the root context first, then contexts by folder path", () => {
    const t = tree([
      ctx("/ws/zeta", "zeta", { plans: [plan("z.md")] }),
      ctx("/ws", "root", { kind: "root", plans: [plan("r.md")] }),
      ctx("/ws/alpha", "alpha", { plans: [plan("a.md")] }),
    ]);
    expect(buildExplorerTree(t).map((c) => c.name)).toEqual(["root", "alpha", "zeta"]);
  });

  it("omits empty groups and labels files per group", () => {
    const t = tree([
      ctx("/ws/auth", "auth", {
        plans: [plan("login.md", { title: "Login flow" })],
        docs: [{ path: "/ws/auth/.gavin/docs/guides/setup.md", relPath: "guides/setup.md" }],
      }),
    ]);
    const [node] = buildExplorerTree(t);
    expect(node.groups.map((g) => g.group)).toEqual(["plans", "docs"]);
    expect(node.groups[0].files[0].label).toBe("Login flow");
    expect(node.groups[1].files[0].label).toBe("guides/setup.md");
  });

  it("collects done/ plans under one archived node and leaves flat plans in place", () => {
    const t = tree([
      ctx("/ws", "root", {
        kind: "root",
        plans: [
          plan("live.md"),
          plan("old.md", { path: "/ws/.gavin-root/plans/done/old.md", status: "Done" }),
          plan("older.md", { path: "/ws/.gavin-root/plans/done/older.md", status: "Done" }),
        ],
      }),
    ]);
    const plans = buildExplorerTree(t)[0].groups[0];
    expect(plans.files.map((f) => f.path)).toEqual(["/ws/.gavin-root/plans/live.md"]);
    expect(plans.archived.map((f) => f.path)).toEqual([
      "/ws/.gavin-root/plans/done/old.md",
      "/ws/.gavin-root/plans/done/older.md",
    ]);
    expect(plans.archived[0].status).toBe("Done");
  });

  it("leaves the archived node empty when nothing is filed under done/", () => {
    const t = tree([ctx("/ws", "root", { kind: "root", plans: [plan("live.md")] })]);
    const plans = buildExplorerTree(t)[0].groups[0];
    expect(plans.archived).toEqual([]);
  });

  it("keeps the plans group when every card in it is archived", () => {
    const t = tree([
      ctx("/ws", "root", {
        kind: "root",
        plans: [plan("old.md", { path: "/ws/.gavin-root/plans/done/old.md", status: "Done" })],
      }),
    ]);
    const plans = buildExplorerTree(t)[0].groups[0];
    expect(plans.group).toBe("plans");
    expect(plans.files).toEqual([]);
    expect(plans.archived).toHaveLength(1);
  });

  it("gives plans/archive/ a folder of its own, beside Plans", () => {
    const t = tree([
      ctx("/ws", "root", {
        kind: "root",
        plans: [
          plan("live.md"),
          plan("done.md", { path: "/ws/.gavin-root/plans/done/done.md", status: "Done" }),
          plan("filed.md", { path: "/ws/.gavin-root/plans/archive/filed.md", status: "Done" }),
        ],
        docs: [{ path: "/ws/.gavin-root/docs/a.md", relPath: "a.md" }],
      }),
    ]);
    const [node] = buildExplorerTree(t);
    expect(node.groups.map((g) => g.group)).toEqual(["plans", "archive", "docs"]);

    // The archive is a flat list -- it has no Done fold of its own, and
    // the Done fold in Plans is untouched by it.
    const [plans, archive] = node.groups;
    expect(plans.files.map((f) => f.path)).toEqual(["/ws/.gavin-root/plans/live.md"]);
    expect(plans.archived.map((f) => f.path)).toEqual(["/ws/.gavin-root/plans/done/done.md"]);
    expect(archive.label).toBe("Archive");
    expect(archive.files.map((f) => f.path)).toEqual(["/ws/.gavin-root/plans/archive/filed.md"]);
    expect(archive.archived).toEqual([]);
  });

  it("archive rows keep the card's status, so the facets can read them", () => {
    const t = tree([
      ctx("/ws", "root", {
        kind: "root",
        plans: [plan("filed.md", { path: "/ws/.gavin-root/plans/archive/filed.md", status: "Done" })],
      }),
    ]);
    const [archive] = buildExplorerTree(t)[0].groups;
    expect(archive.group).toBe("archive");
    expect(archive.files[0].status).toBe("Done");
  });

  it("shows no Archive folder when nothing is archived", () => {
    const t = tree([ctx("/ws", "root", { kind: "root", plans: [plan("live.md")] })]);
    expect(buildExplorerTree(t)[0].groups.map((g) => g.group)).toEqual(["plans"]);
  });

  it("shows no Plans folder when EVERY card is archived", () => {
    // The opposite edge of the one above: an empty "Plans 0" row above a
    // full Archive would be a row about nothing.
    const t = tree([
      ctx("/ws", "root", {
        kind: "root",
        plans: [plan("filed.md", { path: "/ws/.gavin-root/plans/archive/filed.md" })],
      }),
    ]);
    expect(buildExplorerTree(t)[0].groups.map((g) => g.group)).toEqual(["archive"]);
  });

  it("docs and specs groups never carry archived files", () => {
    const t = tree([
      ctx("/ws", "root", {
        kind: "root",
        docs: [{ path: "/ws/.gavin-root/docs/a.md", relPath: "a.md" }],
      }),
    ]);
    expect(buildExplorerTree(t)[0].groups[0].archived).toEqual([]);
  });

  it("folds archived plans in a nested .gavin context, not just the root's", () => {
    const t = tree([
      ctx("/ws/app", "app", {
        plans: [
          plan("live.md", { path: "/ws/app/.gavin/plans/live.md" }),
          plan("old.md", { path: "/ws/app/.gavin/plans/done/old.md", status: "Done" }),
        ],
      }),
    ]);
    const plans = buildExplorerTree(t)[0].groups[0];
    expect(plans.files.map((f) => f.path)).toEqual(["/ws/app/.gavin/plans/live.md"]);
    expect(plans.archived.map((f) => f.path)).toEqual(["/ws/app/.gavin/plans/done/old.md"]);
  });

  it("leaves a hand-made folder alone even when it happens to be called done", () => {
    const t = tree([
      ctx("/ws", "root", {
        kind: "root",
        plans: [plan("q3.md", { path: "/ws/.gavin-root/plans/roadmap/done/q3.md", status: "Done" })],
      }),
    ]);
    const plans = buildExplorerTree(t)[0].groups[0];
    expect(plans.archived).toEqual([]);
    expect(plans.files.map((f) => f.path)).toEqual(["/ws/.gavin-root/plans/roadmap/done/q3.md"]);
  });

  it("carries plan metadata onto file rows", () => {
    const t = tree([
      ctx("/ws", "root", {
        kind: "root",
        plans: [plan("a.md", { status: "In Progress", priority: "high", parseWarning: true })],
      }),
    ]);
    const file = buildExplorerTree(t)[0].groups[0].files[0];
    expect(file.status).toBe("In Progress");
    expect(file.priority).toBe("high");
    expect(file.parseWarning).toBe(true);
  });

  it("computes each context's gavin directory from its kind", () => {
    const t = tree([
      ctx("/ws", "root", { kind: "root", plans: [plan("a.md")] }),
      ctx("/ws/auth", "auth", { plans: [plan("b.md")] }),
    ]);
    const [root, auth] = buildExplorerTree(t);
    expect(root.gavinDir).toBe("/ws/.gavin-root");
    expect(auth.gavinDir).toBe("/ws/auth/.gavin");
  });

  it("assigns depth by nesting among contexts, not path segments", () => {
    const t = tree([
      ctx("/ws", "root", { kind: "root", plans: [plan("r.md")] }),
      // Two folders below the root but only one context deep.
      ctx("/ws/src/auth", "auth", { plans: [plan("a.md")] }),
      ctx("/ws/src/auth/tokens", "tokens", { plans: [plan("t.md")] }),
      // Sibling subtree: depth resets to 1 under the root.
      ctx("/ws/ui", "ui", { plans: [plan("u.md")] }),
    ]);
    expect(buildExplorerTree(t).map((c) => [c.name, c.depth])).toEqual([
      ["root", 0],
      ["auth", 1],
      ["tokens", 2],
      ["ui", 1],
    ]);
  });

  it("does not treat a segment-prefix lookalike folder as an ancestor", () => {
    const t = tree([
      ctx("/ws", "root", { kind: "root", plans: [plan("r.md")] }),
      ctx("/ws/auth", "auth", { plans: [plan("a.md")] }),
      ctx("/ws/auth-ui", "auth-ui", { plans: [plan("b.md")] }),
    ]);
    expect(buildExplorerTree(t).map((c) => [c.name, c.depth])).toEqual([
      ["root", 0],
      ["auth", 1],
      ["auth-ui", 1],
    ]);
  });

  it("flags outside contexts and sorts them after every workspace context", () => {
    const t = tree([
      ctx("/elsewhere/lib", "lib", { outside: true, plans: [plan("l.md")] }),
      ctx("/ws", "root", { kind: "root", plans: [plan("r.md")] }),
      ctx("/ws/zeta", "zeta", { plans: [plan("z.md")] }),
    ]);
    expect(buildExplorerTree(t).map((c) => [c.name, c.outside, c.depth])).toEqual([
      ["root", false, 0],
      ["zeta", false, 1],
      ["lib", true, 0],
    ]);
  });

  it("is empty for an absent or root_missing tree", () => {
    expect(buildExplorerTree(undefined)).toEqual([]);
    expect(buildExplorerTree({ rootPath: "/ws", rootMissing: true, contexts: [] })).toEqual([]);
  });
});

describe("slugFileName", () => {
  it("slugifies a title into a daemon-legal filename", () => {
    expect(slugFileName("Auth flow rework")).toBe("auth-flow-rework.md");
    expect(slugFileName("  Spaces  &  Symbols!! ")).toBe("spaces-symbols.md");
    expect(slugFileName("Already-kebab")).toBe("already-kebab.md");
  });

  it("returns null when nothing usable survives", () => {
    expect(slugFileName("   ")).toBeNull();
    expect(slugFileName("!!!")).toBeNull();
  });
});

describe("isUnderRoot", () => {
  it("accepts a folder strictly inside the root", () => {
    expect(isUnderRoot("/ws", "/ws/src/auth")).toBe(true);
  });

  it("rejects the root itself", () => {
    expect(isUnderRoot("/ws", "/ws")).toBe(false);
  });

  it("rejects outside paths and segment-prefix lookalikes", () => {
    expect(isUnderRoot("/ws", "/elsewhere")).toBe(false);
    expect(isUnderRoot("/ws", "/ws2/src")).toBe(false);
  });
});

describe("statusOptions", () => {
  it("offers the board's columns", () => {
    expect(statusOptions(["To Do", "In Progress", "Done"], "To Do")).toEqual(["To Do", "In Progress", "Done"]);
  });

  it("appends the current value when no column matches it", () => {
    expect(statusOptions(["To Do", "Done"], "Shipped")).toEqual(["To Do", "Done", "Shipped"]);
  });

  it("matches columns slug-insensitively before appending", () => {
    expect(statusOptions(["In Progress"], "in-progress")).toEqual(["In Progress"]);
  });

  it("handles a null current value and an empty board", () => {
    expect(statusOptions(["To Do"], null)).toEqual(["To Do"]);
    expect(statusOptions([], "Blocked")).toEqual(["Blocked"]);
  });
});

describe("newFilePath", () => {
  it("builds paths under the context's gavin directory", () => {
    expect(newFilePath("/ws/.gavin-root", "docs", "notes.md")).toBe("/ws/.gavin-root/docs/notes.md");
    expect(newFilePath("/ws/auth/.gavin", "specs", "api.md")).toBe("/ws/auth/.gavin/specs/api.md");
  });
});

describe("groupFolder", () => {
  it("is the group name for the three authored folders", () => {
    expect(groupFolder("/ws/.gavin-root", "plans")).toBe("/ws/.gavin-root/plans");
    expect(groupFolder("/ws/.gavin-root", "docs")).toBe("/ws/.gavin-root/docs");
  });

  it("nests the archive inside plans/, which is where it actually lives", () => {
    expect(groupFolder("/ws/.gavin-root", "archive")).toBe("/ws/.gavin-root/plans/archive");
  });
});

describe("isCardGroup", () => {
  it("is true for the two groups holding card files", () => {
    expect(isCardGroup("plans")).toBe(true);
    expect(isCardGroup("archive")).toBe(true);
    expect(isCardGroup("docs")).toBe(false);
    expect(isCardGroup("specs")).toBe(false);
  });
});

describe("followRenamedPath", () => {
  const before = tree([ctx("/ws", "ws", { kind: "root", plans: [plan("auth.md"), plan("git.md")] })]);

  it("follows the selection when one file left and one arrived", () => {
    const after = tree([
      ctx("/ws", "ws", { kind: "root", plans: [plan("auth-flow.md"), plan("git.md")] }),
    ]);
    expect(followRenamedPath(before, after, "/ws/.gavin-root/plans/auth.md")).toBe(
      "/ws/.gavin-root/plans/auth-flow.md"
    );
  });

  it("follows a file moved into another context", () => {
    const after = tree([
      ctx("/ws", "ws", { kind: "root", plans: [plan("git.md")] }),
      ctx("/ws/api", "api", {
        plans: [plan("auth.md", { path: "/ws/api/.gavin/plans/auth.md" })],
      }),
    ]);
    expect(followRenamedPath(before, after, "/ws/.gavin-root/plans/auth.md")).toBe(
      "/ws/api/.gavin/plans/auth.md"
    );
  });

  it("returns null when the selection is still there", () => {
    const after = tree([
      ctx("/ws", "ws", { kind: "root", plans: [plan("auth.md"), plan("git.md"), plan("new.md")] }),
    ]);
    expect(followRenamedPath(before, after, "/ws/.gavin-root/plans/auth.md")).toBeNull();
  });

  it("returns null for a plain delete -- nothing arrived to follow", () => {
    const after = tree([ctx("/ws", "ws", { kind: "root", plans: [plan("git.md")] })]);
    expect(followRenamedPath(before, after, "/ws/.gavin-root/plans/auth.md")).toBeNull();
  });

  it("refuses to guess when more than one file changed in the same push", () => {
    const after = tree([
      ctx("/ws", "ws", { kind: "root", plans: [plan("auth-flow.md"), plan("notes.md")] }),
    ]);
    // auth.md AND git.md went, two arrived: which one is the rename is
    // genuinely unknowable, so the selection is reported gone instead.
    expect(followRenamedPath(before, after, "/ws/.gavin-root/plans/auth.md")).toBeNull();
  });

  it("does not follow when a DIFFERENT file was the one renamed", () => {
    const after = tree([
      ctx("/ws", "ws", { kind: "root", plans: [plan("auth.md"), plan("git-tab.md")] }),
    ]);
    expect(followRenamedPath(before, after, "/ws/.gavin-root/plans/git.md")).toBe(
      "/ws/.gavin-root/plans/git-tab.md"
    );
    expect(followRenamedPath(before, after, "/ws/.gavin-root/plans/auth.md")).toBeNull();
  });

  it("follows docs and specs too, not just plans", () => {
    const withDoc = tree([
      ctx("/ws", "ws", {
        kind: "root",
        docs: [{ path: "/ws/.gavin-root/docs/setup.md", relPath: "setup.md" }],
      }),
    ]);
    const renamed = tree([
      ctx("/ws", "ws", {
        kind: "root",
        docs: [{ path: "/ws/.gavin-root/docs/getting-started.md", relPath: "getting-started.md" }],
      }),
    ]);
    expect(followRenamedPath(withDoc, renamed, "/ws/.gavin-root/docs/setup.md")).toBe(
      "/ws/.gavin-root/docs/getting-started.md"
    );
  });

  it("returns null with no previous tree to compare against", () => {
    expect(followRenamedPath(undefined, before, "/ws/.gavin-root/plans/auth.md")).toBeNull();
  });
});

describe("followRenamedContext", () => {
  const before = tree([ctx("/ws", "ws", { kind: "root" }), ctx("/ws/api", "api")]);

  it("follows a pinned board tab through a folder rename", () => {
    const after = tree([ctx("/ws", "ws", { kind: "root" }), ctx("/ws/core", "core")]);
    expect(followRenamedContext(before, after, "/ws/api")).toBe("/ws/core");
  });

  it("returns null when the context is simply gone", () => {
    const after = tree([ctx("/ws", "ws", { kind: "root" })]);
    expect(followRenamedContext(before, after, "/ws/api")).toBeNull();
  });

  it("returns null when the context is still there", () => {
    const after = tree([ctx("/ws", "ws", { kind: "root" }), ctx("/ws/api", "api"), ctx("/ws/web", "web")]);
    expect(followRenamedContext(before, after, "/ws/api")).toBeNull();
  });

  it("refuses to guess when one context left and two arrived", () => {
    const after = tree([ctx("/ws", "ws", { kind: "root" }), ctx("/ws/core", "core"), ctx("/ws/web", "web")]);
    expect(followRenamedContext(before, after, "/ws/api")).toBeNull();
  });

  it("never reads a vanished root as a rename", () => {
    // The whole root going missing empties `contexts`; that is a
    // disconnected workspace, not a folder that moved.
    const gone: GavinTree = { rootPath: "/ws", rootMissing: true, contexts: [] };
    expect(followRenamedContext(before, gone, "/ws/api")).toBeNull();
  });
});

describe("plan explorer selection memory", () => {
  const md = "/ws/.gavin-root/plans/auth.md";

  function fakeStorage(initial: Record<string, string> = {}) {
    const data = { ...initial };
    return {
      data,
      getItem: (k: string) => data[k] ?? null,
      setItem: (k: string, v: string) => {
        data[k] = v;
      },
      removeItem: (k: string) => {
        delete data[k];
      },
    };
  }

  it("keys the memory per workspace, under the app's namespace", () => {
    expect(selectionStorageKey("w1")).toMatch(/^gavin\./);
    expect(selectionStorageKey("w1")).not.toBe(selectionStorageKey("w2"));
  });

  it("remembers nothing until something was selected", () => {
    expect(loadExplorerSelection("w1", fakeStorage())).toBeNull();
  });

  it("round-trips the selected file and its mode, per workspace", () => {
    const storage = fakeStorage();
    saveExplorerSelection("w1", { path: md, mode: "edit" }, storage);
    expect(loadExplorerSelection("w1", storage)).toEqual({ path: md, mode: "edit" });
    // Another workspace's Plans tab has its own memory.
    expect(loadExplorerSelection("w2", storage)).toBeNull();
  });

  it("forgets when the selection is cleared", () => {
    const storage = fakeStorage();
    saveExplorerSelection("w1", { path: md, mode: "plain" }, storage);
    saveExplorerSelection("w1", null, storage);
    expect(loadExplorerSelection("w1", storage)).toBeNull();
    expect(storage.data[selectionStorageKey("w1")]).toBeUndefined();
  });

  // A stale or hand-edited key must not decide the tab is broken:
  // forgetting is the only acceptable failure mode for a view preference.
  it("reads a corrupt or foreign payload as nothing remembered", () => {
    for (const raw of [
      "",
      "yes",
      "{}",
      "[1]",
      "null",
      '{"path":""}',
      '{"mode":"edit"}',
      '{"path":3,"mode":"edit"}',
    ]) {
      expect(loadExplorerSelection("w1", fakeStorage({ [selectionStorageKey("w1")]: raw }))).toBeNull();
    }
  });

  it("falls back to the file's default mode when the remembered one is unknown or illegal for it", () => {
    const unknown = fakeStorage({
      [selectionStorageKey("w1")]: JSON.stringify({ path: md, mode: "wysiwyg" }),
    });
    expect(loadExplorerSelection("w1", unknown)).toEqual({ path: md, mode: "formatted" });
    // Only markdown has a rendered form; a remembered Formatted on
    // anything else would strand the editor in a mode it can't offer.
    const txt = "/ws/.gavin-root/docs/notes.txt";
    const illegal = fakeStorage({
      [selectionStorageKey("w1")]: JSON.stringify({ path: txt, mode: "formatted" }),
    });
    expect(loadExplorerSelection("w1", illegal)).toEqual({ path: txt, mode: "plain" });
  });

  it("survives storage being absent or refusing the access", () => {
    expect(loadExplorerSelection("w1", undefined)).toBeNull();
    expect(() => saveExplorerSelection("w1", { path: md, mode: "edit" }, undefined)).not.toThrow();
    const blocked = () => {
      throw new Error("blocked");
    };
    const broken = { getItem: blocked, setItem: blocked, removeItem: blocked };
    expect(loadExplorerSelection("w1", broken)).toBeNull();
    expect(() => saveExplorerSelection("w1", null, broken)).not.toThrow();
    expect(() => saveExplorerSelection("w1", { path: md, mode: "edit" }, broken)).not.toThrow();
  });
});
