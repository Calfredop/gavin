import { describe, it, expect } from "vitest";
import {
  buildExplorerTree,
  followRenamedContext,
  followRenamedPath,
  slugFileName,
  isUnderRoot,
  statusOptions,
  newFilePath,
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
