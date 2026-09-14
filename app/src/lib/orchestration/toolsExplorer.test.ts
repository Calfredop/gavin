import { describe, expect, it } from "vitest";
import {
  editableToolsFor,
  matchesExplorerSearch,
  promptListItems,
  sourceLabel,
} from "./toolsExplorer";
import type { Tool } from "./orchestrationTools";

const tool = (partial: Partial<Tool> & Pick<Tool, "id" | "name" | "scope">): Tool => ({
  description: "",
  kind: "agent",
  body: "do it",
  params: [],
  ...partial,
});

describe("toolsExplorer", () => {
  it("lists prompt groups and filters by query", () => {
    const all = promptListItems({}, {}, "");
    expect(all.some((g) => g.items.some((i) => i.id === "builtin:commit"))).toBe(true);
    const filtered = promptListItems({}, {}, "critical");
    expect(filtered.flatMap((g) => g.items).every((i) => /critical/i.test(i.name + i.description))).toBe(
      true
    );
  });

  it("marks override source", () => {
    const items = promptListItems({ "action:develop": "x" }, { "builtin:commit": "y" }, "");
    const develop = items.flatMap((g) => g.items).find((i) => i.id === "action:develop")!;
    const commit = items.flatMap((g) => g.items).find((i) => i.id === "builtin:commit")!;
    expect(develop.source).toBe("app");
    expect(commit.source).toBe("workspace");
    expect(sourceLabel("app", "workspace")).toBe("Using app default");
  });

  it("lists only editable custom tools for the scope", () => {
    const library = [
      tool({ id: "builtin:commit", name: "Commit", scope: "builtin" }),
      tool({ id: "g1", name: "Global", scope: "global" }),
      tool({ id: "w1", name: "Workspace", scope: "workspace" }),
    ];
    expect(editableToolsFor(library, "app", "").map((t) => t.id)).toEqual(["g1"]);
    expect(editableToolsFor(library, "workspace", "").map((t) => t.id).sort()).toEqual(["g1", "w1"]);
  });

  it("matchesExplorerSearch is case-insensitive", () => {
    expect(matchesExplorerSearch("Commit via agent", "COMMIT")).toBe(true);
    expect(matchesExplorerSearch("Commit", "merge")).toBe(false);
  });
});
