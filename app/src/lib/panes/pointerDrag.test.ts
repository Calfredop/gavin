import { describe, it, expect } from "vitest";
import {
  exceedsThreshold,
  computeDropTarget,
  computeColumnDropIndex,
  autoScrollVelocity,
  type MeasuredColumn,
  type Rect,
} from "$lib/panes/pointerDrag";

const r = (left: number, top: number, width: number, height: number): Rect => ({ left, top, width, height });

// Two real columns side by side (12px gap) plus one auto column. col1
// holds cards A y:[0,50) and B y:[56,106); the auto column holds Q.
function columns(): MeasuredColumn[] {
  return [
    {
      id: "col1",
      rect: r(0, 0, 240, 400),
      auto: false,
      planCards: [
        { id: "A", rect: r(0, 0, 240, 50) },
        { id: "B", rect: r(0, 56, 240, 50) },
      ],
    },
    { id: "col2", rect: r(252, 0, 240, 400), auto: false, planCards: [] },
    {
      id: "auto:Blocked",
      rect: r(504, 0, 240, 400),
      auto: true,
      planCards: [{ id: "Q", rect: r(504, 0, 240, 50) }],
    },
  ];
}

describe("exceedsThreshold", () => {
  it("false under 5px, true at 5px", () => {
    expect(exceedsThreshold({ x: 0, y: 0 }, { x: 3, y: 3 })).toBe(false);
    expect(exceedsThreshold({ x: 0, y: 0 }, { x: 5, y: 0 })).toBe(true);
    expect(exceedsThreshold({ x: 10, y: 10 }, { x: 7, y: 6 })).toBe(true); // hypot 5
  });
});

describe("computeDropTarget — column slotting", () => {
  it("slots by card midpoints: above A's mid -> 0, between mids -> 1, below B's mid -> 2", () => {
    expect(computeDropTarget({ x: 100, y: 10 }, columns())).toEqual({ columnId: "col1", index: 0 });
    expect(computeDropTarget({ x: 100, y: 40 }, columns())).toEqual({ columnId: "col1", index: 1 });
    expect(computeDropTarget({ x: 100, y: 200 }, columns())).toEqual({ columnId: "col1", index: 2 });
  });

  it("picks the nearest column when the pointer is in the gap between columns", () => {
    expect(computeDropTarget({ x: 244, y: 10 }, columns())).toEqual({ columnId: "col1", index: 0 });
    expect(computeDropTarget({ x: 250, y: 10 }, columns())).toEqual({ columnId: "col2", index: 0 });
  });

  it("null when farther than maxSnapPx from every column", () => {
    expect(computeDropTarget({ x: 2000, y: 10 }, columns())).toBeNull();
    expect(computeDropTarget({ x: -200, y: 10 }, columns())).toBeNull();
  });

  it("auto columns are plain targets (every drag is a file card now)", () => {
    expect(computeDropTarget({ x: 600, y: 200 }, columns())).toEqual({ columnId: "auto:Blocked", index: 1 });
  });

  it("pointer above/below a column still targets it; vertical position only picks the slot", () => {
    expect(computeDropTarget({ x: 100, y: -50 }, columns())).toEqual({ columnId: "col1", index: 0 });
    expect(computeDropTarget({ x: 100, y: 900 }, columns())).toEqual({ columnId: "col1", index: 2 });
  });
});

describe("computeDropTarget — nesting", () => {
  // col1: plan P y:[0,100) carrying nest info, card B y:[106,156).
  function nestColumns(expanded: boolean): MeasuredColumn[] {
    return [
      {
        id: "col1",
        rect: r(0, 0, 240, 400),
        auto: false,
        planCards: [
          {
            id: "P",
            rect: r(0, 0, 240, 100),
            nest: expanded
              ? {
                  rect: r(8, 60, 224, 36),
                  children: [
                    { id: "c1", rect: r(8, 60, 224, 16) },
                    { id: "c2", rect: r(8, 78, 224, 16) },
                  ],
                }
              : { rect: null, children: [] },
          },
          { id: "B", rect: r(0, 106, 240, 50) },
        ],
      },
    ];
  }

  it("middle band of a nestable plan targets nest index 0; edge bands slot the column", () => {
    expect(computeDropTarget({ x: 100, y: 50 }, nestColumns(false))).toEqual({
      columnId: "col1",
      index: 0,
      nest: "P",
    });
    // Top band (y 10 of 100): before P in the column.
    expect(computeDropTarget({ x: 100, y: 10 }, nestColumns(false))).toEqual({ columnId: "col1", index: 0 });
    // Bottom band (y 90): after P.
    expect(computeDropTarget({ x: 100, y: 90 }, nestColumns(false))).toEqual({ columnId: "col1", index: 1 });
  });

  it("an expanded nested area slots among the children by midpoint", () => {
    expect(computeDropTarget({ x: 100, y: 62 }, nestColumns(true))).toEqual({
      columnId: "col1",
      index: 0,
      nest: "P",
    });
    expect(computeDropTarget({ x: 100, y: 75 }, nestColumns(true))).toEqual({
      columnId: "col1",
      index: 1,
      nest: "P",
    });
    expect(computeDropTarget({ x: 100, y: 92 }, nestColumns(true))).toEqual({
      columnId: "col1",
      index: 2,
      nest: "P",
    });
  });

  it("a plan without nest info never nests (note/plan drags, cross-context)", () => {
    const cols = nestColumns(false);
    cols[0].planCards[0].nest = null;
    // Plain midpoint slotting applies: past P's midpoint (50) -> after P.
    expect(computeDropTarget({ x: 100, y: 51 }, cols)).toEqual({ columnId: "col1", index: 1 });
    expect(computeDropTarget({ x: 100, y: 49 }, cols)).toEqual({ columnId: "col1", index: 0 });
  });
});

describe("computeColumnDropIndex", () => {
  const strip = [
    { id: "x", rect: r(0, 0, 240, 400) }, // mid 120
    { id: "y", rect: r(252, 0, 240, 400) }, // mid 372
  ];

  it("counts columns whose horizontal midpoint is left of the pointer", () => {
    expect(computeColumnDropIndex({ x: 100, y: 10 }, strip)).toBe(0);
    expect(computeColumnDropIndex({ x: 200, y: 10 }, strip)).toBe(1);
    expect(computeColumnDropIndex({ x: 400, y: 10 }, strip)).toBe(2);
  });

  it("clamps to the ends for far-left / far-right pointers", () => {
    expect(computeColumnDropIndex({ x: -500, y: 10 }, strip)).toBe(0);
    expect(computeColumnDropIndex({ x: 5000, y: 10 }, strip)).toBe(2);
  });
});

describe("autoScrollVelocity", () => {
  it("0 in the middle", () => {
    expect(autoScrollVelocity(500, 0, 1000)).toBe(0);
  });

  it("negative near the start edge, max at/past the edge", () => {
    expect(autoScrollVelocity(20, 0, 1000)).toBe(-6);
    expect(autoScrollVelocity(0, 0, 1000)).toBe(-12);
    expect(autoScrollVelocity(-30, 0, 1000)).toBe(-12);
  });

  it("positive near the end edge", () => {
    expect(autoScrollVelocity(980, 0, 1000)).toBe(6);
    expect(autoScrollVelocity(1000, 0, 1000)).toBe(12);
    expect(autoScrollVelocity(1030, 0, 1000)).toBe(12);
  });

  it("respects custom zone and speed", () => {
    expect(autoScrollVelocity(10, 0, 1000, 20, 30)).toBe(-15);
  });
});
