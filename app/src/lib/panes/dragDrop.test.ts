import { describe, it, expect } from "vitest";
import {
  setDragPayload,
  getDragKind,
  getDragPayload,
  computeDropZone,
  computeReorderPosition,
  computeReorderPositionX,
  computeTabInsertion,
  reorderIndexWithin,
  type DragPayload,
} from "$lib/panes/dragDrop";

// Minimal fake covering only the DataTransfer members this module
// actually reads/writes -- avoids depending on a specific test
// environment providing a real DataTransfer implementation.
function fakeDragEvent(): { event: DragEvent; dataTransfer: { types: string[]; data: Map<string, string> } } {
  const dataTransfer = { types: [] as string[], data: new Map<string, string>() };
  const fakeDataTransfer = {
    get types() {
      return dataTransfer.types;
    },
    effectAllowed: "none",
    setData(type: string, value: string) {
      dataTransfer.data.set(type, value);
      if (!dataTransfer.types.includes(type)) dataTransfer.types.push(type);
    },
    getData(type: string) {
      return dataTransfer.data.get(type) ?? "";
    },
  };
  const event = { dataTransfer: fakeDataTransfer } as unknown as DragEvent;
  return { event, dataTransfer };
}

describe("setDragPayload / getDragKind / getDragPayload", () => {
  it("roundtrips a workspace payload", () => {
    const { event } = fakeDragEvent();
    const payload: DragPayload = { kind: "workspace", workspaceId: "ws-1" };
    setDragPayload(event, payload);
    expect(getDragKind(event)).toBe("workspace");
    expect(getDragPayload(event)).toEqual(payload);
  });

  it("roundtrips a pane payload", () => {
    const { event } = fakeDragEvent();
    const payload: DragPayload = { kind: "pane", workspaceId: "ws-1", pageId: "page-1", sessionId: "s1" };
    setDragPayload(event, payload);
    expect(getDragKind(event)).toBe("pane");
    expect(getDragPayload(event)).toEqual(payload);
  });

  it("getDragKind returns null when nothing was set", () => {
    const { event } = fakeDragEvent();
    expect(getDragKind(event)).toBeNull();
  });

  it("getDragPayload returns null when nothing was set", () => {
    const { event } = fakeDragEvent();
    expect(getDragPayload(event)).toBeNull();
  });
});

describe("computeDropZone", () => {
  const rect = { left: 0, top: 0, width: 100, height: 100 } as DOMRect;

  it("returns left for the left edge band", () => {
    expect(computeDropZone(rect, 10, 50)).toBe("left");
  });

  it("returns right for the right edge band", () => {
    expect(computeDropZone(rect, 90, 50)).toBe("right");
  });

  it("returns top for the top edge band", () => {
    expect(computeDropZone(rect, 50, 10)).toBe("top");
  });

  it("returns bottom for the bottom edge band", () => {
    expect(computeDropZone(rect, 50, 90)).toBe("bottom");
  });

  it("returns center for the middle region", () => {
    expect(computeDropZone(rect, 50, 50)).toBe("center");
  });
});

describe("computeReorderPosition", () => {
  const rect = { left: 0, top: 0, width: 100, height: 20 } as DOMRect;

  it("returns before for the top half", () => {
    expect(computeReorderPosition(rect, 5)).toBe("before");
  });

  it("returns after for the bottom half", () => {
    expect(computeReorderPosition(rect, 15)).toBe("after");
  });
});

describe("computeTabInsertion", () => {
  // Three 40px tabs with 10px gaps: 0..40, 50..90, 100..140.
  const boxes = [
    { left: 0, width: 40 },
    { left: 50, width: 40 },
    { left: 100, width: 40 },
  ];

  it("inserts before the tab whose left half the pointer is over", () => {
    expect(computeTabInsertion(boxes, 55)).toEqual({ index: 1, anchorIndex: 1, position: "before" });
  });

  it("inserts after the tab whose right half the pointer is over", () => {
    expect(computeTabInsertion(boxes, 85)).toEqual({ index: 2, anchorIndex: 1, position: "after" });
  });

  it("reads the gap between two tabs as before the one on its right", () => {
    expect(computeTabInsertion(boxes, 95)).toEqual({ index: 2, anchorIndex: 2, position: "before" });
  });

  it("reads the empty run past the last tab as append -- the whole point of the bar taking the drop", () => {
    expect(computeTabInsertion(boxes, 600)).toEqual({ index: 3, anchorIndex: 2, position: "after" });
  });

  it("reads the room left of the first tab as prepend", () => {
    expect(computeTabInsertion(boxes, -20)).toEqual({ index: 0, anchorIndex: 0, position: "before" });
  });

  it("has no answer for a bar with no tabs", () => {
    expect(computeTabInsertion([], 10)).toBeNull();
  });
});

describe("reorderIndexWithin", () => {
  // Dropping [a,b,c]'s `a` after `b` reads as caret index 2, but the
  // splice has already made b index 0 -- so the landing index is 1.
  // Without this the tab overshoots its neighbour by one.
  it("steps back an insertion to the right of where the tab started", () => {
    expect(reorderIndexWithin(2, 0)).toBe(1);
    expect(reorderIndexWithin(3, 0)).toBe(2);
  });

  // Leftwards nothing is spliced out ahead of the caret, so the index
  // the caret named is already the one to land on.
  it("leaves an insertion to the left alone", () => {
    expect(reorderIndexWithin(0, 2)).toBe(0);
    expect(reorderIndexWithin(1, 2)).toBe(1);
  });

  // Both sides of the tab's own position mean "stay put", and both have
  // to resolve to the index it is already at.
  it("is a no-op on either side of the tab's own place", () => {
    expect(reorderIndexWithin(1, 1)).toBe(1);
    expect(reorderIndexWithin(2, 1)).toBe(1);
  });
});

describe("computeReorderPositionX", () => {
  const rect = { left: 100, width: 40 } as DOMRect;

  it("splits a tab down its middle", () => {
    expect(computeReorderPositionX(rect, 105)).toBe("before");
    expect(computeReorderPositionX(rect, 135)).toBe("after");
  });

  // Exactly on the midpoint reads as `after`, matching the vertical
  // split -- so the two axes cannot disagree about the boundary.
  it("puts the midpoint itself after, like the vertical split", () => {
    expect(computeReorderPositionX(rect, 120)).toBe("after");
    expect(computeReorderPosition({ top: 0, height: 40 } as DOMRect, 20)).toBe("after");
  });
});
