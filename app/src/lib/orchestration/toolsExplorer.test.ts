import { describe, expect, it } from "vitest";
import {
  promptListItems,
  matchesExplorerSearch,
  sourceLabel,
  toolBodyIsPromptOverride,
  toolsForExplorer,
} from "./toolsExplorer";
import type { Tool } from "./orchestrationTools";
import { BUILTIN_TOOLS } from "./orchestrationTools";

const tool = (partial: Partial<Tool> & Pick<Tool, "id" | "name" | "scope">): Tool => ({
  description: "",
  kind: "agent",
  body: "do it",
  params: [],
  ...partial,
});

describe("toolsExplorer", () => {
  it("lists tools including built-ins, and filters", () => {
    const items = toolsForExplorer(BUILTIN_TOOLS, "workspace", "commit");
    expect(items.some((t) => t.id === "builtin:commit")).toBe(true);
    expect(items.every((t) => /commit/i.test(t.name + t.description + t.tool.kind))).toBe(true);
  });

  it("keeps global+builtin in app scope, drops workspace tools", () => {
    const library = [
      ...BUILTIN_TOOLS.slice(0, 2),
      tool({ id: "g1", name: "Global", scope: "global" }),
      tool({ id: "w1", name: "Workspace", scope: "workspace" }),
    ];
    const ids = toolsForExplorer(library, "app", "").map((t) => t.id);
    expect(ids).toContain("g1");
    expect(ids).not.toContain("w1");
    expect(ids.some((id) => id.startsWith("builtin:"))).toBe(true);
  });

  it("omits tool-backed prompts from the action-prompt groups", () => {
    const groups = promptListItems({}, {}, "");
    const ids = groups.flatMap((g) => g.items.map((i) => i.id));
    expect(ids).toContain("action:run-task");
    expect(ids).not.toContain("builtin:commit");
  });

  it("marks prompt-override tools", () => {
    expect(toolBodyIsPromptOverride({ id: "builtin:commit", scope: "builtin" })).toBe(true);
    expect(toolBodyIsPromptOverride({ id: "builtin:push", scope: "builtin" })).toBe(false);
    expect(toolBodyIsPromptOverride({ id: "g1", scope: "global" })).toBe(false);
  });

  it("sourceLabel and search helpers", () => {
    expect(sourceLabel("app", "workspace")).toBe("Using app default");
    expect(matchesExplorerSearch("Commit via agent", "COMMIT")).toBe(true);
  });
});
