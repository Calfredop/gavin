import { describe, expect, it } from "vitest";
import { BUILTIN_TOOLS, type Tool } from "$lib/orchestration/orchestrationTools";
import type { ToolRun } from "$lib/workspace/workspaceTools";
import { seededValues, toolGroups, toolRows, toolsEmptyLine } from "$companion/surfaces/phoneTools";

function tool(over: Partial<Tool> = {}): Tool {
  return {
    id: "u1",
    name: "Deploy",
    description: "ships it",
    kind: "command",
    body: "./deploy.sh",
    params: [],
    scope: "workspace",
    cwd: null,
    ...over,
  };
}

function run(over: Partial<ToolRun> = {}): ToolRun {
  return {
    id: 1,
    toolId: "u1",
    sessionId: "s1",
    command: null,
    launchCwd: null,
    conversationId: null,
    startedAt: 1_000,
    endedAt: null,
    exitCode: null,
    outcome: "running",
    ...over,
  };
}

const BASE = { lastRuns: new Map<string, ToolRun>(), search: "", compat: null, rootPath: "/repo", nowMs: 2_000_000 };

describe("toolGroups", () => {
  it("heads each block of the library, in the desk's order, and leaves an empty one out", () => {
    const library = [tool({ id: "g", name: "Global", scope: "global" }), tool(), ...BUILTIN_TOOLS];
    const groups = toolGroups({ ...BASE, library });
    expect(groups.map((g) => g.title)).toEqual(["This workspace", "All workspaces", "Built-in"]);
    expect(toolGroups({ ...BASE, library: BUILTIN_TOOLS }).map((g) => g.title)).toEqual(["Built-in"]);
  });
});

describe("toolRows", () => {
  it("says where a tool runs in its own spelling, and nothing at the root", () => {
    expect(toolRows({ ...BASE, library: [tool({ cwd: "apps/web" })] })[0].cwd).toBe("apps/web");
    expect(toolRows({ ...BASE, library: [tool()] })[0].cwd).toBeNull();
  });

  it("darkens Run while the last run is open, and says it is", () => {
    const [row] = toolRows({ ...BASE, library: [tool()], lastRuns: new Map([["u1", run()]]) });
    expect(row.run).toMatchObject({ open: true, sentence: "Still running." });
    expect(row.blocked).toMatch(/already running/);
  });

  it("darkens Run in a workspace with no folder", () => {
    expect(toolRows({ ...BASE, rootPath: null, library: [tool()] })[0].blocked).toMatch(/no root folder/);
  });

  it("finds a tool by its name, its description or its kind", () => {
    const library = [tool(), tool({ id: "u2", name: "Lint", description: "style", kind: "script" })];
    expect(toolRows({ ...BASE, library, search: "lint" }).map((r) => r.id)).toEqual(["u2"]);
    expect(toolRows({ ...BASE, library, search: "ships" }).map((r) => r.id)).toEqual(["u1"]);
    expect(toolRows({ ...BASE, library, search: "script" }).map((r) => r.id)).toEqual(["u2"]);
  });
});

describe("seededValues", () => {
  it("starts each parameter at its default, under what the human typed", () => {
    const params = [
      { name: "env", label: "", default: "staging" },
      { name: "tag", label: "", default: "" },
    ];
    expect(seededValues(params, { tag: "v2" })).toEqual({ env: "staging", tag: "v2" });
    expect(seededValues(params, { stray: "x" })).toEqual({ env: "staging", tag: "" });
  });
});

describe("toolsEmptyLine", () => {
  it("names the search that matched nothing", () => {
    expect(toolsEmptyLine("  zzz ")).toBe("No tool matches “zzz”.");
    expect(toolsEmptyLine("")).toMatch(/desk/);
  });
});
