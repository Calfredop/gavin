import { describe, it, expect } from "vitest";
import {
  setDragPayload,
  getDragKind,
  getDragPayload,
  computeDropZone,
  computeReorderPosition,
  type DragPayload,
} from "./dragDrop";

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
