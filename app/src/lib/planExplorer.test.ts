import { describe, it, expect } from "vitest";
import { buildExplorerTree, slugFileName, isUnderRoot, statusOptions, newFilePath } from "./planExplorer";
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
