import { describe, it, expect } from "vitest";
import { dropIntent, wouldGroup, type CommittedDrag, type DropContext } from "$lib/orchestration/orchestrationDrop";
import type { OrchDragKind, OrchDropTarget } from "$lib/orchestration/orchestrationDrag";
import type { GroupTemplate } from "$lib/orchestration/orchestrationGroups";

const TEMPLATE: GroupTemplate = {
  id: "t1",
  name: "Review pair",
  description: "",
  mode: "parallel",
  steps: [],
  scope: "workspace",
};

function drag(kind: OrchDragKind, id: string, target: OrchDropTarget): CommittedDrag {
  return {
    kind,
    id,
    sourceStageId: null,
    sourceIndex: null,
    target,
    pointer: { x: 0, y: 0 },
    grabOffset: { x: 0, y: 0 },
    size: { width: 0, height: 0 },
  };
}

const ctx = (over: Partial<DropContext> = {}): DropContext => ({
  groupsBlocked: null,
  templates: [TEMPLATE],
  ...over,
});

const intoStage: OrchDropTarget = { kind: "into-stage", stageId: "st1", index: 2 };
const newStage: OrchDropTarget = { kind: "new-stage", railId: "r1", index: 3 };
const unplace: OrchDropTarget = { kind: "unplace" };

describe("wouldGroup", () => {
  // The two forced cases: into-stage forms or grows a group, and a
  // template writes `mode` whichever target it lands on.
  it("is true for any into-stage drop and for every template drop", () => {
    expect(wouldGroup(drag("step", "s1", intoStage))).toBe(true);
    expect(wouldGroup(drag("card", "/p.md", intoStage))).toBe(true);
    expect(wouldGroup(drag("template", "t1", newStage))).toBe(true);
  });

  // Gated as a matter of scope, not necessity -- neither reachable
  // target writes `mode`, but the gesture only exists because groups do.
  it("is true for a whole-stage drag on either of its targets", () => {
    expect(wouldGroup(drag("stage", "st1", newStage))).toBe(true);
    expect(wouldGroup(drag("stage", "st1", unplace))).toBe(true);
  });

  it("is false for a plain placement that forms no group", () => {
    expect(wouldGroup(drag("card", "/p.md", newStage))).toBe(false);
    expect(wouldGroup(drag("tool", "tool1", newStage))).toBe(false);
    expect(wouldGroup(drag("step", "s1", unplace))).toBe(false);
  });
});

describe("dropIntent", () => {
  // Refused BEFORE any mapping, so all three ways of asking (the drawer
  // rows, the header's controls, a drop) say the one sentence.
  it("blocks a grouping drop against a daemon that cannot carry a mode", () => {
    const blocked = ctx({ groupsBlocked: "needs daemon v15" });
    expect(dropIntent(drag("card", "/p.md", intoStage), blocked)).toEqual({
      kind: "blocked",
      reason: "needs daemon v15",
    });
    expect(dropIntent(drag("stage", "st1", unplace), blocked)).toEqual({
      kind: "blocked",
      reason: "needs daemon v15",
    });
  });

  it("lets a non-grouping drop through the same gate", () => {
    const blocked = ctx({ groupsBlocked: "needs daemon v15" });
    expect(dropIntent(drag("card", "/p.md", newStage), blocked)?.kind).toBe("add-card-as-stage");
  });

  it("routes a card to a stage or to a new one", () => {
    expect(dropIntent(drag("card", "/p.md", intoStage), ctx())).toEqual({
      kind: "add-card-to-stage",
      stageId: "st1",
      cardPath: "/p.md",
      index: 2,
    });
    expect(dropIntent(drag("card", "/p.md", newStage), ctx())).toEqual({
      kind: "add-card-as-stage",
      railId: "r1",
      cardPath: "/p.md",
      index: 3,
    });
  });

  it("routes a tool the same two ways", () => {
    expect(dropIntent(drag("tool", "tool1", intoStage), ctx())?.kind).toBe("add-tool-to-stage");
    expect(dropIntent(drag("tool", "tool1", newStage), ctx())?.kind).toBe("add-tool-as-stage");
  });

  // A card, a tool and a template all come OFF the drawer, so there is
  // nothing on the plan for an unplace to take back.
  it("does nothing when a drawer kind is dropped on the drawer", () => {
    expect(dropIntent(drag("card", "/p.md", unplace), ctx())).toBeNull();
    expect(dropIntent(drag("tool", "tool1", unplace), ctx())).toBeNull();
    expect(dropIntent(drag("template", "t1", unplace), ctx())).toBeNull();
  });

  it("resolves a template against the library it was dragged from", () => {
    const intent = dropIntent(drag("template", "t1", newStage), ctx());
    expect(intent).toEqual({ kind: "add-template-as-stage", railId: "r1", template: TEMPLATE, index: 3 });
  });

  // Deleted mid-drag by another session or the manager tab: placing a
  // stale copy is worse than placing nothing.
  it("does nothing for a template the library no longer holds", () => {
    expect(dropIntent(drag("template", "gone", newStage), ctx())).toBeNull();
  });

  it("moves a whole stage, and asks before removing one", () => {
    expect(dropIntent(drag("stage", "st1", newStage), ctx())).toEqual({
      kind: "move-stage",
      stageId: "st1",
      railId: "r1",
      index: 3,
    });
    // Removing a stage takes every step it holds off the plan, unlike
    // every other unplace -- so it prompts rather than running.
    expect(dropIntent(drag("stage", "st1", unplace), ctx())).toEqual({
      kind: "confirm-remove-stage",
      stageId: "st1",
    });
  });

  // A step is the one kind already ON the plan, so it is the only one
  // that can be dropped back off it.
  it("routes a step all three ways", () => {
    expect(dropIntent(drag("step", "s1", unplace), ctx())).toEqual({ kind: "remove-step", stepId: "s1" });
    expect(dropIntent(drag("step", "s1", intoStage), ctx())).toEqual({
      kind: "move-step-into-stage",
      stepId: "s1",
      stageId: "st1",
      index: 2,
    });
    expect(dropIntent(drag("step", "s1", newStage), ctx())).toEqual({
      kind: "move-step-to-new-stage",
      stepId: "s1",
      railId: "r1",
      index: 3,
    });
  });
});
