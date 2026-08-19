import { describe, it, expect, vi, beforeEach } from "vitest";
import { get } from "svelte/store";
import {
  dragState,
  beginCandidate,
  movePointer,
  refreshTarget,
  endPointer,
  cancelDrag,
  buildDisplaySlots,
  buildColumnSlots,
  __resetForTesting,
  type DragCallbacks,
  type ActiveDrag,
} from "./kanbanDrag";
import type { MeasuredColumn, Rect } from "./pointerDrag";

const r = (left: number, top: number, width: number, height: number): Rect => ({ left, top, width, height });

function makeColumns(): MeasuredColumn[] {
  return [
    {
      id: "col1",
      rect: r(0, 0, 240, 400),
      auto: false,
      cards: [
        { id: "B", rect: r(0, 0, 240, 50) },
        { id: "C", rect: r(0, 56, 240, 50) },
      ],
      planCards: [],
    },
    { id: "col2", rect: r(252, 0, 240, 400), auto: false, cards: [], planCards: [] },
  ];
}

function makeCallbacks(overrides: Partial<DragCallbacks> = {}): DragCallbacks & {
  commits: (ActiveDrag & { target: { columnId: string; index: number } })[];
  clicks: [string, string][];
} {
  const commits: (ActiveDrag & { target: { columnId: string; index: number } })[] = [];
  const clicks: [string, string][] = [];
  return {
    commits,
    clicks,
    measure: () => makeColumns(),
    measureColumns: () => [
      { id: "col2", rect: r(252, 0, 240, 400) }, // dragged col1 excluded
    ],
    commit: (d) => commits.push(d),
    click: (kind, id) => clicks.push([kind, id]),
    ...overrides,
  };
}

beforeEach(() => {
  __resetForTesting();
});

// A card drag candidate for card "A" grabbed at (10, 10) inside its
// rect at (0, 0, 240, 50), source col1 index 0.
function grabA(cbs: DragCallbacks): void {
  beginCandidate("card", "A", "col1", 0, { x: 10, y: 10 }, r(0, 0, 240, 50), cbs);
}

describe("click vs drag", () => {
  it("pointer up below the threshold is a click, never a drag", () => {
    const cbs = makeCallbacks();
    grabA(cbs);
    movePointer({ x: 12, y: 12 });
    expect(get(dragState)).toBeNull();
    endPointer();
    expect(cbs.clicks).toEqual([["card", "A"]]);
    expect(cbs.commits).toEqual([]);
  });

  it("crossing the threshold activates the drag with grab offset and size", () => {
    const cbs = makeCallbacks();
    grabA(cbs);
    movePointer({ x: 20, y: 10 });
    const d = get(dragState);
    expect(d).not.toBeNull();
    expect(d?.kind).toBe("card");
    expect(d?.id).toBe("A");
    expect(d?.sourceColumnId).toBe("col1");
    expect(d?.sourceIndex).toBe(0);
    expect(d?.grabOffset).toEqual({ x: 10, y: 10 });
    expect(d?.size).toEqual({ width: 240, height: 50 });
    expect(d?.pointer).toEqual({ x: 20, y: 10 });
  });
});

describe("target tracking", () => {
  it("movePointer recomputes the drop target from fresh measurements", () => {
    const cbs = makeCallbacks();
    grabA(cbs);
    movePointer({ x: 100, y: 70 }); // activates; above C's midpoint
    expect(get(dragState)?.target).toEqual({ columnId: "col1", index: 1 });
    movePointer({ x: 300, y: 10 });
    expect(get(dragState)?.target).toEqual({ columnId: "col2", index: 0 });
  });

  it("refreshTarget re-measures at the current pointer (auto-scroll frames)", () => {
    let cards = [{ id: "B", rect: r(0, 0, 240, 50) }];
    const cbs = makeCallbacks({
      measure: () => [{ id: "col1", rect: r(0, 0, 240, 400), auto: false, cards, planCards: [] }],
    });
    grabA(cbs);
    movePointer({ x: 100, y: 100 });
    expect(get(dragState)?.target).toEqual({ columnId: "col1", index: 1 });
    // The column scrolled: B moved below the pointer.
    cards = [{ id: "B", rect: r(0, 150, 240, 50) }];
    refreshTarget();
    expect(get(dragState)?.target).toEqual({ columnId: "col1", index: 0 });
    expect(get(dragState)?.pointer).toEqual({ x: 100, y: 100 });
  });

  it("column drags hit-test the strip via measureColumns", () => {
    const cbs = makeCallbacks();
    beginCandidate("column", "col1", null, 0, { x: 10, y: 10 }, r(0, 0, 240, 400), cbs);
    movePointer({ x: 400, y: 10 }); // past col2's midpoint (372)
    expect(get(dragState)?.target).toEqual({ columnId: "", index: 1 });
  });
});

describe("drop", () => {
  it("endPointer commits the final target and clears state", () => {
    const cbs = makeCallbacks();
    grabA(cbs);
    movePointer({ x: 300, y: 10 });
    endPointer();
    expect(cbs.commits).toHaveLength(1);
    expect(cbs.commits[0].target).toEqual({ columnId: "col2", index: 0 });
    expect(cbs.clicks).toEqual([]);
    expect(get(dragState)).toBeNull();
  });

  it("a no-op drop (same column and index) does not commit but still clears", () => {
    const cbs = makeCallbacks();
    grabA(cbs);
    movePointer({ x: 100, y: 10 }); // index 0 in col1 = the source slot
    expect(get(dragState)?.target).toEqual({ columnId: "col1", index: 0 });
    endPointer();
    expect(cbs.commits).toEqual([]);
    expect(get(dragState)).toBeNull();
  });

  it("a null target drops nowhere: no commit, no click", () => {
    const cbs = makeCallbacks();
    grabA(cbs);
    movePointer({ x: 2000, y: 10 });
    expect(get(dragState)?.target).toBeNull();
    endPointer();
    expect(cbs.commits).toEqual([]);
    expect(cbs.clicks).toEqual([]);
  });

  it("cancelDrag clears without committing", () => {
    const cbs = makeCallbacks();
    grabA(cbs);
    movePointer({ x: 300, y: 10 });
    cancelDrag();
    expect(cbs.commits).toEqual([]);
    expect(get(dragState)).toBeNull();
    // A stale endPointer (the pointerup after Escape) must be inert:
    endPointer();
    expect(cbs.commits).toEqual([]);
    expect(cbs.clicks).toEqual([]);
  });

  it("state is fully reset: a fresh candidate works after a completed drag", () => {
    const cbs = makeCallbacks();
    grabA(cbs);
    movePointer({ x: 300, y: 10 });
    endPointer();
    grabA(cbs);
    endPointer();
    expect(cbs.clicks).toEqual([["card", "A"]]);
  });
});

describe("buildDisplaySlots", () => {
  const items = [{ id: "A" }, { id: "B" }, { id: "C" }];
  const idOf = (t: { id: string }) => t.id;

  function activeDrag(partial: Partial<ActiveDrag>): ActiveDrag {
    return {
      kind: "card",
      id: "A",
      sourceColumnId: "col1",
      sourceIndex: 0,
      target: { columnId: "col1", index: 1 },
      pointer: { x: 0, y: 0 },
      grabOffset: { x: 0, y: 0 },
      size: { width: 240, height: 50 },
      ...partial,
    };
  }

  it("no drag: plain item slots", () => {
    expect(buildDisplaySlots(items, idOf, null, "col1", "card")).toEqual([
      { type: "item", item: { id: "A" } },
      { type: "item", item: { id: "B" } },
      { type: "item", item: { id: "C" } },
    ]);
  });

  it("hides the dragged item and inserts the placeholder at the target", () => {
    const slots = buildDisplaySlots(items, idOf, activeDrag({}), "col1", "card");
    expect(slots).toEqual([
      { type: "item", item: { id: "B" } },
      { type: "placeholder" },
      { type: "item", item: { id: "C" } },
    ]);
  });

  it("no placeholder in a column the target does not point at (dragged still hidden)", () => {
    const slots = buildDisplaySlots(items, idOf, activeDrag({ target: { columnId: "col2", index: 0 } }), "col1", "card");
    expect(slots).toEqual([
      { type: "item", item: { id: "B" } },
      { type: "item", item: { id: "C" } },
    ]);
  });

  it("a different kind's drag leaves the list untouched", () => {
    const slots = buildDisplaySlots(items, idOf, activeDrag({ kind: "plan" }), "col1", "card");
    expect(slots).toHaveLength(3);
    expect(slots.every((s) => s.type === "item")).toBe(true);
  });

  it("placeholder lands in an empty target column", () => {
    expect(buildDisplaySlots([], idOf, activeDrag({ target: { columnId: "col2", index: 0 } }), "col2", "card")).toEqual([
      { type: "placeholder" },
    ]);
  });
});

describe("buildColumnSlots", () => {
  const cols = [{ id: "x" }, { id: "y" }, { id: "z" }];
  const idOf = (c: { id: string }) => c.id;

  it("no drag / non-column drag: plain slots", () => {
    expect(buildColumnSlots(cols, idOf, null)).toHaveLength(3);
  });

  it("hides the dragged column and places the placeholder at the strip index", () => {
    const drag: ActiveDrag = {
      kind: "column",
      id: "x",
      sourceColumnId: null,
      sourceIndex: 0,
      target: { columnId: "", index: 1 },
      pointer: { x: 0, y: 0 },
      grabOffset: { x: 0, y: 0 },
      size: { width: 240, height: 400 },
    };
    expect(buildColumnSlots(cols, idOf, drag)).toEqual([
      { type: "item", item: { id: "y" } },
      { type: "placeholder" },
      { type: "item", item: { id: "z" } },
    ]);
  });
});
