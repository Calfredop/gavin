import { describe, it, expect, beforeEach, vi } from "vitest";
import { get } from "svelte/store";
import {
  computeOrchDropTarget,
  orchDragState,
  beginCandidate,
  movePointer,
  endPointer,
  cancelDrag,
  isPlacementDrag,
  __resetForTesting,
} from "./orchestrationDrag";
import type { MeasuredRail, OrchDragCallbacks } from "./orchestrationDrag";

// Two rails side by side, each 200 wide. r1 has two stages of height
// 100 at y=0 and y=120; r2 has one stage at y=0.
const RAILS: MeasuredRail[] = [
  {
    id: "r1",
    rect: { left: 0, top: 0, width: 200, height: 400 },
    stages: [
      { id: "s1", position: 0, rect: { left: 10, top: 0, width: 180, height: 100 }, steps: [] },
      { id: "s2", position: 1, rect: { left: 10, top: 120, width: 180, height: 100 }, steps: [] },
    ],
  },
  {
    id: "r2",
    rect: { left: 220, top: 0, width: 200, height: 400 },
    stages: [{ id: "s3", position: 0, rect: { left: 230, top: 0, width: 180, height: 100 }, steps: [] }],
  },
];

describe("computeOrchDropTarget", () => {
  it("targets the drawer when the pointer is inside it", () => {
    const drawer = { left: 500, top: 0, width: 120, height: 400 };
    expect(computeOrchDropTarget({ x: 540, y: 40 }, RAILS, drawer)).toEqual({ kind: "unplace" });
  });

  it("joins a stage from its middle band — parallel", () => {
    expect(computeOrchDropTarget({ x: 100, y: 50 }, RAILS, null)).toEqual({
      kind: "into-stage",
      stageId: "s1",
      index: 0,
    });
  });

  it("makes a new stage from a stage's top band — sequential, before it", () => {
    expect(computeOrchDropTarget({ x: 100, y: 10 }, RAILS, null)).toEqual({
      kind: "new-stage",
      railId: "r1",
      index: 0,
    });
  });

  it("makes a new stage from a stage's bottom band — sequential, after it", () => {
    expect(computeOrchDropTarget({ x: 100, y: 95 }, RAILS, null)).toEqual({
      kind: "new-stage",
      railId: "r1",
      index: 1,
    });
  });

  it("targets the gap between two stages", () => {
    expect(computeOrchDropTarget({ x: 100, y: 110 }, RAILS, null)).toEqual({
      kind: "new-stage",
      railId: "r1",
      index: 1,
    });
  });

  it("targets the end of the rail below the last stage", () => {
    expect(computeOrchDropTarget({ x: 100, y: 380 }, RAILS, null)).toEqual({
      kind: "new-stage",
      railId: "r1",
      index: 2,
    });
  });

  it("picks the rail by horizontal position only, so above the top still targets it", () => {
    expect(computeOrchDropTarget({ x: 300, y: -80 }, RAILS, null)).toEqual({
      kind: "new-stage",
      railId: "r2",
      index: 0,
    });
  });

  it("snaps to the nearest rail within maxSnapPx", () => {
    expect(computeOrchDropTarget({ x: 460, y: 300 }, RAILS, null)).toEqual({
      kind: "new-stage",
      railId: "r2",
      index: 1,
    });
  });

  it("is null beyond the snap distance", () => {
    expect(computeOrchDropTarget({ x: 900, y: 300 }, RAILS, null)).toBeNull();
  });

  it("targets index 0 of an empty rail", () => {
    const empty: MeasuredRail[] = [
      { id: "r9", rect: { left: 0, top: 0, width: 200, height: 400 }, stages: [] },
    ];
    expect(computeOrchDropTarget({ x: 100, y: 200 }, empty, null)).toEqual({
      kind: "new-stage",
      railId: "r9",
      index: 0,
    });
  });

  it("returns null when there are no rails at all", () => {
    expect(computeOrchDropTarget({ x: 100, y: 100 }, [], null)).toBeNull();
  });
});

const RECT = { left: 0, top: 0, width: 100, height: 30 };

function cbs(overrides: Partial<OrchDragCallbacks> = {}): OrchDragCallbacks {
  return {
    measure: () => RAILS,
    measureDrawer: () => null,
    commit: vi.fn(),
    click: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => __resetForTesting());

describe("orchestration drag controller", () => {
  it("stays a candidate below the 5px threshold", () => {
    beginCandidate("step", "t1", "s1", 0, { x: 0, y: 0 }, RECT, cbs());
    movePointer({ x: 2, y: 2 });
    expect(get(orchDragState)).toBeNull();
  });

  it("activates past the threshold and carries a target", () => {
    beginCandidate("step", "t1", "s1", 0, { x: 100, y: 50 }, RECT, cbs());
    movePointer({ x: 100, y: 110 });
    expect(get(orchDragState)?.id).toBe("t1");
    expect(get(orchDragState)?.kind).toBe("step");
    expect(get(orchDragState)?.target).toEqual({ kind: "new-stage", railId: "r1", index: 1 });
  });

  it("a release without movement is a click, not a drop", () => {
    const c = cbs();
    beginCandidate("step", "t1", "s1", 0, { x: 0, y: 0 }, RECT, c);
    endPointer();
    expect(c.click).toHaveBeenCalledWith("t1", null);
    expect(c.commit).not.toHaveBeenCalled();
  });

  // A card step renders the whole kanban card, so a press can land on a
  // NESTED child card inside it -- that one opens as itself.
  it("reports the card the press landed on, for the click path only", () => {
    const c = cbs();
    beginCandidate("step", "t1", "s1", 0, { x: 0, y: 0 }, RECT, c, "/x/nested.md");
    endPointer();
    expect(c.click).toHaveBeenCalledWith("t1", "/x/nested.md");
  });

  it("never lets that card path reach a drop — a drag still moves the STEP", () => {
    const c = cbs();
    beginCandidate("step", "t1", "s1", 0, { x: 100, y: 50 }, RECT, c, "/x/nested.md");
    movePointer({ x: 300, y: 50 });
    endPointer();
    expect(c.commit).toHaveBeenCalledWith(expect.objectContaining({ id: "t1" }));
    expect(c.click).not.toHaveBeenCalled();
  });

  it("commits at the last computed target", () => {
    const c = cbs();
    beginCandidate("step", "t1", "s1", 0, { x: 100, y: 50 }, RECT, c);
    movePointer({ x: 300, y: 50 });
    endPointer();
    expect(c.commit).toHaveBeenCalledWith(
      expect.objectContaining({ id: "t1", target: { kind: "into-stage", stageId: "s3", index: 0 } })
    );
  });

  // sourceIndex 0 matches the index the guard recomputes here (s1 has no
  // OTHER measured members in this fixture, so the only reachable slot
  // is 0) -- dropped back at that same slot is the identity, not just a
  // same-stage drop. See the "same-slot guard" describe below for the
  // case this would get wrong if the guard were only stage-aware.
  it("does not commit a drop back into the stage it came from", () => {
    const c = cbs();
    beginCandidate("step", "t1", "s1", 0, { x: 100, y: 50 }, RECT, c);
    // Away first, so the drag really activates, then back onto s1's band.
    movePointer({ x: 300, y: 50 });
    expect(get(orchDragState)).not.toBeNull();
    movePointer({ x: 100, y: 50 });
    expect(get(orchDragState)?.target).toEqual({ kind: "into-stage", stageId: "s1", index: 0 });
    endPointer();
    expect(c.commit).not.toHaveBeenCalled();
  });

  it("treats a tracked move with no buttons as the drop (WKWebView lost pointerup)", () => {
    const c = cbs();
    beginCandidate("step", "t1", "s1", 0, { x: 100, y: 50 }, RECT, c);
    movePointer({ x: 300, y: 50 });
    movePointer({ x: 300, y: 50 }, 0);
    expect(c.commit).toHaveBeenCalled();
    expect(get(orchDragState)).toBeNull();
  });

  it("cancel drops the drag without committing", () => {
    const c = cbs();
    beginCandidate("step", "t1", "s1", 0, { x: 100, y: 50 }, RECT, c);
    movePointer({ x: 300, y: 50 });
    cancelDrag();
    expect(get(orchDragState)).toBeNull();
    expect(c.commit).not.toHaveBeenCalled();
  });

  it("commits an unplace when the pointer ends in the drawer", () => {
    const c = cbs({ measureDrawer: () => ({ left: 500, top: 0, width: 100, height: 400 }) });
    beginCandidate("step", "t1", "s1", 0, { x: 100, y: 50 }, RECT, c);
    movePointer({ x: 540, y: 50 });
    endPointer();
    expect(c.commit).toHaveBeenCalledWith(expect.objectContaining({ target: { kind: "unplace" } }));
  });
});

describe("dragging an unplaced card in", () => {
  it("commits a card drop onto a stage", () => {
    const c = cbs();
    beginCandidate("card", "/x/a.md", null, null, { x: 100, y: 300 }, RECT, c);
    movePointer({ x: 100, y: 50 });
    endPointer();
    expect(c.commit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "card",
        id: "/x/a.md",
        target: { kind: "into-stage", stageId: "s1", index: 0 },
      })
    );
  });

  it("commits a card drop into a gap as a new stage", () => {
    const c = cbs();
    beginCandidate("card", "/x/a.md", null, null, { x: 100, y: 300 }, RECT, c);
    movePointer({ x: 100, y: 110 });
    endPointer();
    expect(c.commit).toHaveBeenCalledWith(
      expect.objectContaining({ target: { kind: "new-stage", railId: "r1", index: 1 } })
    );
  });

  it("does not commit a card dropped back on the drawer — it is already unplaced", () => {
    const c = cbs({ measureDrawer: () => ({ left: 500, top: 0, width: 100, height: 400 }) });
    beginCandidate("card", "/x/a.md", null, null, { x: 540, y: 300 }, RECT, c);
    movePointer({ x: 540, y: 50 });
    expect(get(orchDragState)?.target).toEqual({ kind: "unplace" });
    endPointer();
    expect(c.commit).not.toHaveBeenCalled();
  });
});

describe("dragging a tool in", () => {
  it("commits a tool drop onto a stage — parallel", () => {
    const c = cbs();
    beginCandidate("tool", "builtin:push", null, null, { x: 100, y: 300 }, RECT, c);
    movePointer({ x: 100, y: 50 });
    endPointer();
    expect(c.commit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "tool",
        id: "builtin:push",
        target: { kind: "into-stage", stageId: "s1", index: 0 },
      })
    );
  });

  it("commits a tool drop into a gap as a new stage — sequential", () => {
    const c = cbs();
    beginCandidate("tool", "builtin:push", null, null, { x: 100, y: 300 }, RECT, c);
    movePointer({ x: 100, y: 110 });
    endPointer();
    expect(c.commit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "tool",
        target: { kind: "new-stage", railId: "r1", index: 1 },
      })
    );
  });

  // Same rule as a card: it was never placed, so there is nothing to
  // take off a rail.
  it("does not commit a tool dropped back on the drawer", () => {
    const c = cbs({ measureDrawer: () => ({ left: 500, top: 0, width: 100, height: 400 }) });
    beginCandidate("tool", "builtin:push", null, null, { x: 540, y: 300 }, RECT, c);
    movePointer({ x: 540, y: 50 });
    endPointer();
    expect(c.commit).not.toHaveBeenCalled();
  });

  it("a press with no movement is a click, so click-to-append still works", () => {
    const c = cbs();
    beginCandidate("tool", "builtin:push", null, null, { x: 100, y: 50 }, RECT, c);
    endPointer();
    expect(c.commit).not.toHaveBeenCalled();
    expect(c.click).toHaveBeenCalledWith("builtin:push", null);
  });
});

describe("isPlacementDrag", () => {
  it("is true for the drawer kinds and false for a step", () => {
    expect(isPlacementDrag("card")).toBe(true);
    expect(isPlacementDrag("tool")).toBe(true);
    expect(isPlacementDrag("step")).toBe(false);
  });
});

describe("into-stage index over a GROUP", () => {
  // A group at y 100..200 holding two members that tile it: t1 at
  // 100..150 (midpoint 125), t2 at 150..200 (midpoint 175).
  const rails: MeasuredRail[] = [
    {
      id: "r1",
      rect: { left: 0, top: 0, width: 200, height: 400 },
      stages: [
        {
          id: "s1",
          position: 0,
          rect: { left: 0, top: 100, width: 200, height: 100 },
          steps: [
            { id: "t1", rect: { left: 0, top: 100, width: 200, height: 50 } },
            { id: "t2", rect: { left: 0, top: 150, width: 200, height: 50 } },
          ],
        },
      ],
    },
  ];

  it("is 0 over the first member's top half", () => {
    // Reachable only because a GROUP drops the three-band rule: under it
    // y=110 would be an outer band, and the first slot would have no
    // gesture at all.
    expect(computeOrchDropTarget({ x: 100, y: 110 }, rails, null)).toEqual({
      kind: "into-stage",
      stageId: "s1",
      index: 0,
    });
  });

  it("is 1 over the first member's bottom half", () => {
    expect(computeOrchDropTarget({ x: 100, y: 140 }, rails, null)).toEqual({
      kind: "into-stage",
      stageId: "s1",
      index: 1,
    });
  });

  it("is 1 over the second member's top half", () => {
    expect(computeOrchDropTarget({ x: 100, y: 160 }, rails, null)).toEqual({
      kind: "into-stage",
      stageId: "s1",
      index: 1,
    });
  });

  it("is 2 over the last member's bottom half", () => {
    expect(computeOrchDropTarget({ x: 100, y: 190 }, rails, null)).toEqual({
      kind: "into-stage",
      stageId: "s1",
      index: 2,
    });
  });

  it("means BEFORE the group when the pointer is on its header strip", () => {
    // The header and the padding are inside the stage rect but over no
    // member, which is how "before/after the whole group" stays
    // reachable once the three-band rule is gone.
    const withHead: MeasuredRail[] = [
      {
        ...rails[0],
        stages: [{ ...rails[0].stages[0], rect: { left: 0, top: 80, width: 200, height: 120 } }],
      },
    ];
    expect(computeOrchDropTarget({ x: 100, y: 90 }, withHead, null)).toEqual({
      kind: "new-stage",
      railId: "r1",
      index: 0,
    });
  });
});

describe("into-stage index over a SINGLE-STEP stage", () => {
  // The three-band rule still applies here: the outer bands are what
  // distinguish "go before/after this stage" from "group with it".
  const rails: MeasuredRail[] = [
    {
      id: "r1",
      rect: { left: 0, top: 0, width: 200, height: 400 },
      stages: [
        {
          id: "s1",
          position: 0,
          rect: { left: 0, top: 100, width: 200, height: 100 },
          steps: [{ id: "t1", rect: { left: 0, top: 110, width: 200, height: 80 } }],
        },
      ],
    },
  ];

  it("groups above the member, at slot 0", () => {
    expect(computeOrchDropTarget({ x: 100, y: 135 }, rails, null)).toEqual({
      kind: "into-stage",
      stageId: "s1",
      index: 0,
    });
  });

  it("groups below the member, at slot 1", () => {
    expect(computeOrchDropTarget({ x: 100, y: 165 }, rails, null)).toEqual({
      kind: "into-stage",
      stageId: "s1",
      index: 1,
    });
  });

  it("still means before/after in the outer bands", () => {
    expect(computeOrchDropTarget({ x: 100, y: 105 }, rails, null)).toEqual({
      kind: "new-stage",
      railId: "r1",
      index: 0,
    });
    expect(computeOrchDropTarget({ x: 100, y: 195 }, rails, null)).toEqual({
      kind: "new-stage",
      railId: "r1",
      index: 1,
    });
  });
});

describe("dragging a whole stage", () => {
  const rails: MeasuredRail[] = [
    {
      id: "r1",
      rect: { left: 0, top: 0, width: 200, height: 400 },
      stages: [
        {
          id: "s1",
          position: 0,
          rect: { left: 0, top: 100, width: 200, height: 100 },
          steps: [{ id: "t1", rect: { left: 0, top: 110, width: 200, height: 80 } }],
        },
      ],
    },
  ];

  it("never targets into-stage, because groups do not nest", () => {
    const target = computeOrchDropTarget({ x: 100, y: 160 }, rails, null, 100, "stage");
    expect(target).toEqual({ kind: "new-stage", railId: "r1", index: 1 });
  });

  it("still targets the drawer", () => {
    const drawer = { left: 300, top: 0, width: 100, height: 400 };
    expect(computeOrchDropTarget({ x: 350, y: 50 }, rails, drawer, 100, "stage")).toEqual({ kind: "unplace" });
  });
});

describe("isPlacementDrag", () => {
  it("is true for a template, which has no step to detach", () => {
    expect(isPlacementDrag("template")).toBe(true);
  });

  it("is false for a stage, which is already placed", () => {
    expect(isPlacementDrag("stage")).toBe(false);
  });
});

describe("same-slot guard uses the index, not just the stage", () => {
  // A 2-member GROUP as it measures with the dragged (a 3rd, middle)
  // member already excluded -- the remaining slots tile stage s1 exactly
  // as the GROUP fixture above. sourceIndex 1 is where the dragged chip
  // sat in the PRE-removal list: splicing it back in at 1 reproduces
  // that list exactly, which is the whole of the identity this guard
  // relies on (see endPointer).
  const groupRails: MeasuredRail[] = [
    {
      id: "r1",
      rect: { left: 0, top: 0, width: 200, height: 400 },
      stages: [
        {
          id: "s1",
          position: 0,
          rect: { left: 0, top: 100, width: 200, height: 100 },
          steps: [
            { id: "m1", rect: { left: 0, top: 100, width: 200, height: 50 } },
            { id: "m2", rect: { left: 0, top: 150, width: 200, height: 50 } },
          ],
        },
      ],
    },
  ];

  it("does not commit a same-stage drop back at the source slot", () => {
    const c = cbs({ measure: () => groupRails });
    beginCandidate("step", "t-dragged", "s1", 1, { x: 100, y: 300 }, RECT, c);
    movePointer({ x: 100, y: 140 }); // index 1 -- the dragged chip's own slot
    expect(get(orchDragState)?.target).toEqual({ kind: "into-stage", stageId: "s1", index: 1 });
    endPointer();
    expect(c.commit).not.toHaveBeenCalled();
  });

  it("commits a same-stage drop at a different slot -- a real reorder", () => {
    const c = cbs({ measure: () => groupRails });
    beginCandidate("step", "t-dragged", "s1", 1, { x: 100, y: 300 }, RECT, c);
    movePointer({ x: 100, y: 110 }); // index 0 -- not where it started
    expect(get(orchDragState)?.target).toEqual({ kind: "into-stage", stageId: "s1", index: 0 });
    endPointer();
    expect(c.commit).toHaveBeenCalledWith(
      expect.objectContaining({ target: { kind: "into-stage", stageId: "s1", index: 0 } })
    );
  });
});
