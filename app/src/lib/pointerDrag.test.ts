import { describe, it, expect } from "vitest";
import {
  exceedsThreshold,
  computeDropTarget,
  computeColumnDropIndex,
  autoScrollVelocity,
  type MeasuredColumn,
  type Rect,
} from "./pointerDrag";

const r = (left: number, top: number, width: number, height: number): Rect => ({ left, top, width, height });

// Two real columns side by side (12px gap) plus one auto column. col1
// holds free-form cards A y:[0,50) and B y:[56,106) and plan cards
// P y:[120,170); col2 and the auto column are empty except for plans.
function columns(): MeasuredColumn[] {
  return [
    {
      id: "col1",
      rect: r(0, 0, 240, 400),
      auto: false,
      cards: [
        { id: "A", rect: r(0, 0, 240, 50) },
        { id: "B", rect: r(0, 56, 240, 50) },
      ],
      planCards: [{ id: "P", rect: r(0, 120, 240, 50) }],
    },
    { id: "col2", rect: r(252, 0, 240, 400), auto: false, cards: [], planCards: [] },
    {
      id: "auto:Blocked",
      rect: r(504, 0, 240, 400),
      auto: true,
      cards: [],
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

describe("computeDropTarget", () => {
  it("slots by card midpoints: above A's mid -> 0, between mids -> 1, below B's mid -> 2", () => {
    expect(computeDropTarget({ x: 100, y: 10 }, columns(), "card")).toEqual({ columnId: "col1", index: 0 });
    expect(computeDropTarget({ x: 100, y: 40 }, columns(), "card")).toEqual({ columnId: "col1", index: 1 });
    expect(computeDropTarget({ x: 100, y: 200 }, columns(), "card")).toEqual({ columnId: "col1", index: 2 });
  });

  it("indices are post-removal by construction: dragged excluded, hovering before the last card's midpoint gives its slot", () => {
    // Simulates dragging A within col1: measured list is just [B, C'].
    const cols: MeasuredColumn[] = [
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
    ];
    // Pointer just above C's midpoint -> index 1 -> moveCard(..., 1) => [B, A, C].
    expect(computeDropTarget({ x: 100, y: 70 }, cols, "card")).toEqual({ columnId: "col1", index: 1 });
  });

  it("picks the nearest column when the pointer is in the gap between columns", () => {
    expect(computeDropTarget({ x: 244, y: 10 }, columns(), "card")).toEqual({ columnId: "col1", index: 0 });
    expect(computeDropTarget({ x: 250, y: 10 }, columns(), "card")).toEqual({ columnId: "col2", index: 0 });
  });

  it("null when farther than maxSnapPx from every column", () => {
    expect(computeDropTarget({ x: 2000, y: 10 }, columns(), "card")).toBeNull();
    expect(computeDropTarget({ x: -200, y: 10 }, columns(), "card")).toBeNull();
  });

  it("card drags skip auto columns entirely; plan drags target them", () => {
    // Pointer squarely over the auto column:
    expect(computeDropTarget({ x: 600, y: 10 }, columns(), "card")).toBeNull(); // col2's right edge is 108px away
    expect(computeDropTarget({ x: 600, y: 10 }, columns(), "plan")).toEqual({
      columnId: "auto:Blocked",
      index: 0,
    });
  });

  it("kind selects the block: plan drag indexes planCards, card drag indexes cards", () => {
    // y=200 is below P's midpoint (145): plan index 1; card index 2 (below both card mids).
    expect(computeDropTarget({ x: 100, y: 200 }, columns(), "plan")).toEqual({ columnId: "col1", index: 1 });
    expect(computeDropTarget({ x: 100, y: 130 }, columns(), "plan")).toEqual({ columnId: "col1", index: 0 });
    expect(computeDropTarget({ x: 100, y: 200 }, columns(), "card")).toEqual({ columnId: "col1", index: 2 });
  });

  it("pointer above/below a column still targets it; vertical position only picks the slot", () => {
    expect(computeDropTarget({ x: 100, y: -50 }, columns(), "card")).toEqual({ columnId: "col1", index: 0 });
    expect(computeDropTarget({ x: 100, y: 900 }, columns(), "card")).toEqual({ columnId: "col1", index: 2 });
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
    expect(autoScrollVelocity(20, 0, 1000)).toBe(-6); // half the zone -> half of 12
    expect(autoScrollVelocity(0, 0, 1000)).toBe(-12);
    expect(autoScrollVelocity(-30, 0, 1000)).toBe(-12); // past the edge clamps
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
