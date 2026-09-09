import { describe, it, expect } from "vitest";
import {
  templateLibrary,
  toTemplateRecord,
  templateFromStage,
  droppedCardCount,
  stepsFromTemplate,
} from "$lib/orchestration/orchestrationGroups";
import type { GroupTemplate, GroupTemplateRecord } from "$lib/orchestration/orchestrationGroups";
import type { Stage } from "$lib/orchestration/orchestration";

function record(over: Partial<GroupTemplateRecord> = {}): GroupTemplateRecord {
  return {
    id: "g1",
    workspaceId: "ws-1",
    name: "Merge and push",
    description: "",
    mode: "sequence",
    steps: [{ toolId: "builtin:push", toolParams: { remote: "origin" } }],
    position: 0,
    ...over,
  };
}

describe("templateLibrary", () => {
  it("derives scope from workspaceId", () => {
    // Same rule as ToolScope: the daemon stores the id, the app labels it.
    const lib = templateLibrary([record(), record({ id: "g2", workspaceId: null })]);
    expect(lib.map((t) => t.scope)).toEqual(["workspace", "global"]);
  });

  it("orders workspace templates before global ones, each alphabetical", () => {
    const lib = templateLibrary([
      record({ id: "a", workspaceId: null, name: "Zebra" }),
      record({ id: "b", workspaceId: null, name: "Alpha" }),
      record({ id: "c", workspaceId: "ws-1", name: "Nomad" }),
    ]);
    expect(lib.map((t) => t.name)).toEqual(["Nomad", "Alpha", "Zebra"]);
  });
});

describe("toTemplateRecord", () => {
  it("maps global scope to a null workspaceId", () => {
    const t: GroupTemplate = {
      id: "g1", name: "Merge and push", description: "", mode: "sequence",
      steps: [{ toolId: "builtin:push", toolParams: {} }], scope: "global",
    };
    expect(toTemplateRecord(t, "ws-1", 3).workspaceId).toBeNull();
    expect(toTemplateRecord(t, "ws-1", 3).position).toBe(3);
  });

  it("maps workspace scope to the workspace id", () => {
    const t: GroupTemplate = {
      id: "g1", name: "Merge and push", description: "", mode: "sequence",
      steps: [{ toolId: "builtin:push", toolParams: {} }], scope: "workspace",
    };
    expect(toTemplateRecord(t, "ws-1", 0).workspaceId).toBe("ws-1");
  });

  it("refuses a blank name -- the save form disables Save for this, but the guard is the real backstop", () => {
    const t: GroupTemplate = {
      id: "g1", name: "   ", description: "", mode: "sequence",
      steps: [{ toolId: "builtin:push", toolParams: {} }], scope: "workspace",
    };
    expect(() => toTemplateRecord(t, "ws-1", 0)).toThrow("A template needs a name.");
  });

  it("refuses zero steps -- a template with nothing to place is not a template", () => {
    const t: GroupTemplate = {
      id: "g1", name: "Merge and push", description: "", mode: "sequence",
      steps: [], scope: "workspace",
    };
    expect(() => toTemplateRecord(t, "ws-1", 0)).toThrow("A template needs at least one tool step.");
  });
});

describe("templateFromStage", () => {
  const mixed: Stage = {
    id: "s1",
    position: 0,
    mode: "sequence",
    name: "Land it",
    steps: [
      { id: "t1", position: 0, cardPath: "", toolId: "builtin:merge-into", toolParams: { base: "main" } },
      { id: "t2", position: 1, cardPath: "/ws/plans/a.md", toolId: null, toolParams: {} },
      { id: "t3", position: 2, cardPath: "", toolId: "builtin:push", toolParams: {} },
    ],
  };

  it("keeps the tool steps, in order, with their overrides", () => {
    const t = templateFromStage(mixed, "Merge and push", "", "workspace");
    expect(t.steps).toEqual([
      { toolId: "builtin:merge-into", toolParams: { base: "main" } },
      { toolId: "builtin:push", toolParams: {} },
    ]);
  });

  it("carries the group's mode", () => {
    expect(templateFromStage(mixed, "x", "", "workspace").mode).toBe("sequence");
  });

  it("excludes card steps, and says how many it dropped", () => {
    // A card step is an absolute path into one workspace, so it can
    // never be a template member (G7) -- and a template that silently
    // lost half a group would be worse than one that refused to save.
    expect(templateFromStage(mixed, "x", "", "workspace").steps).toHaveLength(2);
    expect(droppedCardCount(mixed)).toBe(1);
  });
});

describe("stepsFromTemplate", () => {
  it("mints a fresh id per member and numbers them in order", () => {
    // Step ids are run-state keys: reusing one would graft a finished
    // run onto a step that has not started.
    let n = 0;
    const steps = stepsFromTemplate(
      {
        id: "g1", name: "Merge and push", description: "", mode: "sequence", scope: "workspace",
        steps: [
          { toolId: "builtin:merge-into", toolParams: { base: "main" } },
          { toolId: "builtin:push", toolParams: {} },
        ],
      },
      () => `new-${n++}`
    );
    expect(steps).toEqual([
      { id: "new-0", position: 0, cardPath: "", toolId: "builtin:merge-into", toolParams: { base: "main" } },
      { id: "new-1", position: 1, cardPath: "", toolId: "builtin:push", toolParams: {} },
    ]);
  });
});
