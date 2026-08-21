import { describe, it, expect, beforeEach } from "vitest";
import { get } from "svelte/store";
import {
  dragState,
  beginCandidate,
  movePointer,
  refreshTarget,
  endPointer,
  cancelDrag,
  buildDisplaySlots,
  buildNestedSlots,
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
      planCards: [
        { id: "B", rect: r(0, 0, 240, 50) },
        { id: "C", rect: r(0, 56, 240, 50) },
      ],
    },
    { id: "col2", rect: r(252, 0, 240, 400), auto: false, planCards: [] },
  ];
}

function makeCallbacks(overrides: Partial<DragCallbacks> = {}): DragCallbacks & {
  commits: (ActiveDrag & { target: { columnId: string; index: number; nest?: string } })[];
  clicks: [string, string, boolean][];
} {
  const commits: (ActiveDrag & { target: { columnId: string; index: number; nest?: string } })[] = [];
  const clicks: [string, string, boolean][] = [];
  return {
    commits,
    clicks,
    measure: () => makeColumns(),
    measureColumns: () => [{ id: "col2", rect: r(252, 0, 240, 400) }],
    commit: (d) => commits.push(d),
    click: (kind, id, mods) => clicks.push([kind, id, mods.shift]),
    ...overrides,
  };
}

beforeEach(() => {
  __resetForTesting();
});

// A card drag candidate for card "A" grabbed at (10, 10) inside its
// rect at (0, 0, 240, 50), source col1 index 0, free-standing.
function grabA(cbs: DragCallbacks, sourceNest: string | null = null, shift = false): void {
  beginCandidate("plan", "A", "col1", 0, sourceNest, { x: 10, y: 10 }, r(0, 0, 240, 50), cbs, shift);
}

describe("click vs drag", () => {
  it("pointer up below the threshold is a click, never a drag", () => {
    const cbs = makeCallbacks();
    grabA(cbs);
    movePointer({ x: 12, y: 12 });
    expect(get(dragState)).toBeNull();
    endPointer();
    expect(cbs.clicks).toEqual([["plan", "A", false]]);
    expect(cbs.commits).toEqual([]);
  });

  it("crossing the threshold activates the drag with grab offset and size", () => {
    const cbs = makeCallbacks();
    grabA(cbs);
    movePointer({ x: 20, y: 10 });
    const d = get(dragState);
    expect(d).not.toBeNull();
    expect(d?.kind).toBe("plan");
    expect(d?.id).toBe("A");
    expect(d?.sourceColumnId).toBe("col1");
    expect(d?.sourceIndex).toBe(0);
    expect(d?.sourceNest).toBeNull();
    expect(d?.grabOffset).toEqual({ x: 10, y: 10 });
    expect(d?.size).toEqual({ width: 240, height: 50 });
  });

  // Shift+click is the multi-select gesture: it must never turn into a
  // drag, or picking a card would fling it into another column.
  it("a shift grab never activates a drag, however far it moves", () => {
    const cbs = makeCallbacks();
    grabA(cbs, null, true);
    movePointer({ x: 300, y: 300 });
    expect(get(dragState)).toBeNull();
    endPointer();
    expect(cbs.commits).toEqual([]);
    expect(cbs.clicks).toEqual([["plan", "A", true]]);
  });

  it("reports the shift modifier with the click so the board can select instead of open", () => {
    const cbs = makeCallbacks();
    grabA(cbs, null, true);
    endPointer();
    grabA(cbs);
    endPointer();
    expect(cbs.clicks).toEqual([
      ["plan", "A", true],
      ["plan", "A", false],
    ]);
  });
});

describe("target tracking", () => {
  it("movePointer recomputes the drop target from fresh measurements", () => {
    const cbs = makeCallbacks();
    grabA(cbs);
    movePointer({ x: 100, y: 70 });
    expect(get(dragState)?.target).toEqual({ columnId: "col1", index: 1 });
    movePointer({ x: 300, y: 10 });
    expect(get(dragState)?.target).toEqual({ columnId: "col2", index: 0 });
  });

  it("refreshTarget re-measures at the current pointer (auto-scroll frames)", () => {
    let cards = [{ id: "B", rect: r(0, 0, 240, 50) }];
    const cbs = makeCallbacks({
      measure: () => [{ id: "col1", rect: r(0, 0, 240, 400), auto: false, planCards: cards }],
    });
    grabA(cbs);
    movePointer({ x: 100, y: 100 });
    expect(get(dragState)?.target).toEqual({ columnId: "col1", index: 1 });
    cards = [{ id: "B", rect: r(0, 150, 240, 50) }];
    refreshTarget();
    expect(get(dragState)?.target).toEqual({ columnId: "col1", index: 0 });
    expect(get(dragState)?.pointer).toEqual({ x: 100, y: 100 });
  });

  it("column drags hit-test the strip via measureColumns", () => {
    const cbs = makeCallbacks();
    beginCandidate("column", "col1", null, 0, null, { x: 10, y: 10 }, r(0, 0, 240, 400), cbs);
    movePointer({ x: 400, y: 10 });
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
    expect(get(dragState)).toBeNull();
  });

  it("a no-op drop (same column and index, free-standing) does not commit", () => {
    const cbs = makeCallbacks();
    grabA(cbs);
    movePointer({ x: 100, y: 10 });
    expect(get(dragState)?.target).toEqual({ columnId: "col1", index: 0 });
    endPointer();
    expect(cbs.commits).toEqual([]);
  });

  it("a nested card dropped into a column at its plan's slot is NOT a no-op", () => {
    const cbs = makeCallbacks();
    grabA(cbs, "P.md"); // was nested
    movePointer({ x: 100, y: 10 }); // col1 index 0 == sourceColumnId/sourceIndex
    endPointer();
    expect(cbs.commits).toHaveLength(1); // freeing always commits
  });

  it("a nest drop back into the same plan at the same index is a no-op", () => {
    const cols: MeasuredColumn[] = [
      {
        id: "col1",
        rect: r(0, 0, 240, 400),
        auto: false,
        planCards: [{ id: "P.md", rect: r(0, 0, 240, 100), nest: { rect: null, children: [] } }],
      },
    ];
    const cbs = makeCallbacks({ measure: () => cols });
    grabA(cbs, "P.md");
    movePointer({ x: 100, y: 50 }); // middle band -> nest P.md index 0
    expect(get(dragState)?.target).toEqual({ columnId: "col1", index: 0, nest: "P.md" });
    endPointer();
    expect(cbs.commits).toEqual([]);
  });

  it("a nest drop into a different plan commits", () => {
    const cols: MeasuredColumn[] = [
      {
        id: "col1",
        rect: r(0, 0, 240, 400),
        auto: false,
        planCards: [{ id: "Q.md", rect: r(0, 0, 240, 100), nest: { rect: null, children: [] } }],
      },
    ];
    const cbs = makeCallbacks({ measure: () => cols });
    grabA(cbs, "P.md");
    movePointer({ x: 100, y: 50 });
    endPointer();
    expect(cbs.commits[0].target).toEqual({ columnId: "col1", index: 0, nest: "Q.md" });
  });

  it("cancelDrag clears without committing; a stale endPointer is inert", () => {
    const cbs = makeCallbacks();
    grabA(cbs);
    movePointer({ x: 300, y: 10 });
    cancelDrag();
    expect(cbs.commits).toEqual([]);
    expect(get(dragState)).toBeNull();
    endPointer();
    expect(cbs.commits).toEqual([]);
    expect(cbs.clicks).toEqual([]);
  });

  it("a tracked move with no buttons pressed ends the drag (lost-pointerup recovery)", () => {
    const cbs = makeCallbacks();
    grabA(cbs);
    movePointer({ x: 300, y: 10 });
    movePointer({ x: 305, y: 12 }, 0);
    expect(cbs.commits).toHaveLength(1);
    expect(get(dragState)).toBeNull();
  });

  it("state is fully reset: a fresh candidate works after a completed drag", () => {
    const cbs = makeCallbacks();
    grabA(cbs);
    movePointer({ x: 300, y: 10 });
    endPointer();
    grabA(cbs);
    endPointer();
    expect(cbs.clicks).toEqual([["plan", "A", false]]);
  });
});

describe("buildDisplaySlots", () => {
  const items = [{ id: "A" }, { id: "B" }, { id: "C" }];
  const idOf = (t: { id: string }) => t.id;

  function activeDrag(partial: Partial<ActiveDrag>): ActiveDrag {
    return {
      kind: "plan",
      id: "A",
      sourceColumnId: "col1",
      sourceIndex: 0,
      sourceNest: null,
      target: { columnId: "col1", index: 1 },
      pointer: { x: 0, y: 0 },
      grabOffset: { x: 0, y: 0 },
      size: { width: 240, height: 50 },
      ...partial,
    };
  }

  it("no drag: plain item slots", () => {
    expect(buildDisplaySlots(items, idOf, null, "col1")).toHaveLength(3);
  });

  it("hides the dragged item and inserts the placeholder at the target", () => {
    const slots = buildDisplaySlots(items, idOf, activeDrag({}), "col1");
    expect(slots).toEqual([
      { type: "item", item: { id: "B" } },
      { type: "placeholder" },
      { type: "item", item: { id: "C" } },
    ]);
  });

  it("no placeholder in a column the target does not point at (dragged still hidden)", () => {
    const slots = buildDisplaySlots(items, idOf, activeDrag({ target: { columnId: "col2", index: 0 } }), "col1");
    expect(slots).toEqual([
      { type: "item", item: { id: "B" } },
      { type: "item", item: { id: "C" } },
    ]);
  });

  it("a nest target suppresses every column placeholder", () => {
    const slots = buildDisplaySlots(
      items,
      idOf,
      activeDrag({ target: { columnId: "col1", index: 1, nest: "P.md" } }),
      "col1"
    );
    expect(slots).toEqual([
      { type: "item", item: { id: "B" } },
      { type: "item", item: { id: "C" } },
    ]);
  });

  it("placeholder lands in an empty target column", () => {
    expect(buildDisplaySlots([], idOf, activeDrag({ target: { columnId: "col2", index: 0 } }), "col2")).toEqual([
      { type: "placeholder" },
    ]);
  });

  describe("buildNestedSlots", () => {
    const children = [{ id: "c1" }, { id: "c2" }];

    it("placeholder appears only in the targeted plan's area", () => {
      const drag = activeDrag({ target: { columnId: "col1", index: 1, nest: "P.md" } });
      expect(buildNestedSlots(children, idOf, drag, "P.md")).toEqual([
        { type: "item", item: { id: "c1" } },
        { type: "placeholder" },
        { type: "item", item: { id: "c2" } },
      ]);
      expect(buildNestedSlots(children, idOf, drag, "Q.md")).toHaveLength(2);
    });

    it("hides the dragged child from its own plan's area", () => {
      const drag = activeDrag({ id: "c1", sourceNest: "P.md", target: { columnId: "col1", index: 0 } });
      expect(buildNestedSlots(children, idOf, drag, "P.md")).toEqual([{ type: "item", item: { id: "c2" } }]);
    });
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
      sourceNest: null,
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
