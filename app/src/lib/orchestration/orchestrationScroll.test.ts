import { describe, it, expect } from "vitest";
import { source } from "$lib/sources";
import {
  attachRememberedScroll,
  axisFor,
  offsetOf,
  readScroll,
  remembersScroll,
  sameScrollKey,
  setOffset,
  stepRestore,
  writeScroll,
  RESTORE_FRAMES,
  type ScrollKey,
  type ScrollNode,
} from "$lib/orchestration/orchestrationScroll";

const STRIP: ScrollKey = { workspaceId: "w1", railId: null };
const RAIL: ScrollKey = { workspaceId: "w1", railId: "r1" };

/// A scroller standing in for the DOM node: enough surface for the
/// action, a hand-driven frame queue in place of the browser's, and a
/// `scroll()` that does what a real one does -- move the element and
/// raise the event -- so a test can tell a recorded scroll from a
/// dropped one.
///
/// `max` is the clamp, which is the whole reason the restore retries: a
/// scroller writes what it is given only as far as its content goes.
function scroller(over: { max?: number; at?: number } = {}) {
  const max = over.max ?? 1000;
  let handler: (() => void) | null = null;
  let offset = over.at ?? 0;
  const frames: (() => void)[] = [];
  const node = {
    get scrollLeft() {
      return offset;
    },
    set scrollLeft(next: number) {
      move(next);
    },
    get scrollTop() {
      return offset;
    },
    set scrollTop(next: number) {
      move(next);
    },
    addEventListener(_type: "scroll", h: () => void) {
      handler = h;
    },
    removeEventListener(_type: "scroll", h: () => void) {
      if (handler === h) handler = null;
    },
  };
  /// A write, clamped and silent: a real scroller raises its `scroll`
  /// event at the START of the next frame's rendering update, never
  /// inline, and the whole settle rule turns on that ordering.
  function move(next: number): void {
    const landed = Math.max(0, Math.min(max, next));
    if (landed === offset) return;
    offset = landed;
    pendingEcho = true;
  }
  let pendingEcho = false;
  return {
    node: node as unknown as ScrollNode,
    /// Runs the frame the restore queued, delivering the previous
    /// write's echo first -- the browser's own order.
    tick(): void {
      const next = frames.shift();
      if (pendingEcho) {
        pendingEcho = false;
        handler?.();
      }
      next?.();
    },
    /// Runs every queued frame; returns how many ran.
    settle(): number {
      let ran = 0;
      while (frames.length > 0) {
        this.tick();
        ran += 1;
      }
      // The last write's echo lands a frame after the frame that made
      // it, with no frame of its own queued behind it.
      if (pendingEcho) {
        pendingEcho = false;
        handler?.();
      }
      return ran;
    },
    frame: (fn: () => void) => void frames.push(fn),
    /// A human scrolling the element themselves.
    scroll(to: number): void {
      move(to);
      pendingEcho = false;
      handler?.();
    },
    get offset(): number {
      return offset;
    },
    get listening(): boolean {
      return handler !== null;
    },
    get queued(): number {
      return frames.length;
    },
  };
}

describe("the remembered offsets", () => {
  it("start at 0, so a first visit restores a scroller to where it already is", () => {
    expect(readScroll({ workspaceId: "fresh", railId: null })).toBe(0);
    expect(readScroll({ workspaceId: "fresh", railId: "never-scrolled" })).toBe(0);
  });

  it("keeps the strip's x apart from every rail's y", () => {
    writeScroll(STRIP, 240);
    writeScroll(RAIL, 600);
    expect(readScroll(STRIP)).toBe(240);
    expect(readScroll(RAIL)).toBe(600);
  });

  it("keeps each rail's y apart from its neighbours'", () => {
    // The point of the whole module: the strip stopped being one shared
    // scroll, so one number for the tab would put every rail back at
    // whatever the last one it read was left at.
    writeScroll({ workspaceId: "w2", railId: "a" }, 120);
    writeScroll({ workspaceId: "w2", railId: "b" }, 880);
    expect(readScroll({ workspaceId: "w2", railId: "a" })).toBe(120);
    expect(readScroll({ workspaceId: "w2", railId: "b" })).toBe(880);
  });

  it("keeps one workspace's offsets out of another's", () => {
    // Rail ids collide across workspaces far more readily than they look
    // like they would -- the hub view is reused across a workspace
    // switch rather than remounted.
    writeScroll({ workspaceId: "left", railId: "r1" }, 40);
    writeScroll({ workspaceId: "right", railId: "r1" }, 400);
    expect(readScroll({ workspaceId: "left", railId: "r1" })).toBe(40);
    expect(readScroll({ workspaceId: "right", railId: "r1" })).toBe(400);
  });
});

describe("sameScrollKey", () => {
  it("matches equal keys that are different objects", () => {
    // The identity check this replaces: Svelte hands the action a fresh
    // object literal on every update, and a rail's parameter reads
    // `rail.id` off a prop the daemon replaces on every plan push.
    expect(sameScrollKey({ workspaceId: "w1", railId: "r1" }, { workspaceId: "w1", railId: "r1" })).toBe(true);
    expect(sameScrollKey({ workspaceId: "w1", railId: null }, { workspaceId: "w1", railId: null })).toBe(true);
  });

  it("separates the strip from a rail, and each workspace from the next", () => {
    expect(sameScrollKey(STRIP, RAIL)).toBe(false);
    expect(sameScrollKey(RAIL, { workspaceId: "w2", railId: "r1" })).toBe(false);
    expect(sameScrollKey(RAIL, { workspaceId: "w1", railId: "r2" })).toBe(false);
  });
});

describe("axisFor", () => {
  it("gives the strip x and a rail y", () => {
    // Not a preference: `.grid` is `overflow-x: auto` over
    // `overflow-y: hidden` and `.rail-body` is `overflow-y: auto` --
    // both pinned in orchestrationRailScroll.test.ts.
    expect(axisFor(STRIP)).toBe("x");
    expect(axisFor(RAIL)).toBe("y");
  });
});

describe("offsetOf / setOffset", () => {
  it("reads and writes the axis it is given, and only that one", () => {
    const el = { scrollLeft: 0, scrollTop: 0 } as ScrollNode;
    setOffset(el, "x", 30);
    expect(el.scrollLeft).toBe(30);
    expect(el.scrollTop).toBe(0);
    setOffset(el, "y", 70);
    expect(el.scrollTop).toBe(70);
    expect(el.scrollLeft).toBe(30);
    expect(offsetOf(el, "x")).toBe(30);
    expect(offsetOf(el, "y")).toBe(70);
  });
});

describe("stepRestore", () => {
  it("writes the target while the scroller is short of it", () => {
    expect(stepRestore(500, 0, RESTORE_FRAMES)).toEqual({ kind: "write", offset: 500 });
    // Short because the write was CLAMPED, not because it was not made:
    // the content is still arriving and the scroller cannot go that far
    // yet.
    expect(stepRestore(500, 180, 2)).toEqual({ kind: "write", offset: 500 });
  });

  it("settles the frame the target is reached, with no write in it", () => {
    // The ordering the whole echo rule rests on. A settle that also
    // wrote would turn the listener back on with its own event still in
    // flight.
    expect(stepRestore(500, 500, RESTORE_FRAMES)).toEqual({ kind: "settle" });
  });

  it("settles a scroller that was already there, without touching it", () => {
    // Every first visit: nothing remembered, nothing scrolled.
    expect(stepRestore(0, 0, RESTORE_FRAMES)).toEqual({ kind: "settle" });
  });

  it("gives up on a spent budget rather than writing forever", () => {
    // The content shrank while the tab was away, so the target is past
    // an end that now exists. Without this the listener never records
    // again and the rail's offset is frozen for the life of the app.
    expect(stepRestore(500, 200, 0)).toEqual({ kind: "settle" });
    expect(stepRestore(500, 200, -1)).toEqual({ kind: "settle" });
  });
});

describe("attachRememberedScroll", () => {
  it("puts a remembered offset back on the frame it attaches", () => {
    writeScroll({ workspaceId: "attach", railId: "r" }, 320);
    const el = scroller();
    attachRememberedScroll(el.node, { workspaceId: "attach", railId: "r" }, el.frame);
    expect(el.offset).toBe(320);
  });

  it("restores a rail on y and the strip on x", () => {
    writeScroll({ workspaceId: "axes", railId: null }, 210);
    const strip = { scrollLeft: 0, scrollTop: 0, addEventListener() {}, removeEventListener() {} };
    attachRememberedScroll(strip as unknown as ScrollNode, { workspaceId: "axes", railId: null }, () => {});
    expect(strip.scrollLeft).toBe(210);
    expect(strip.scrollTop).toBe(0);
  });

  it("records the human's own scrolling", () => {
    const key = { workspaceId: "record", railId: "r" };
    const el = scroller();
    attachRememberedScroll(el.node, key, el.frame);
    el.settle();
    el.scroll(450);
    expect(readScroll(key)).toBe(450);
  });

  it("keeps trying while the content is still arriving", () => {
    // The bug the retry exists for: a rail that renders short -- its
    // board cards a store behind -- clamps the write, and one attempt
    // would leave the human at the top.
    const key = { workspaceId: "growing", railId: "r" };
    writeScroll(key, 500);
    const el = scroller({ max: 0 });
    attachRememberedScroll(el.node, key, el.frame);
    expect(el.offset).toBe(0);
    el.tick();
    expect(el.offset).toBe(0);
    el.node.scrollTop = 0; // the clamp is the scroller's, not the test's
    expect(readScroll(key)).toBe(500);
  });

  it("does not let a clamped write erase the offset it is putting back", () => {
    // The echo. A write raises a `scroll` event even when the browser
    // clamped it to 0, and a listener recording that event turns "we
    // could not reach 500 yet" into "the human is at the top".
    const key = { workspaceId: "echo", railId: "r" };
    writeScroll(key, 500);
    const el = scroller({ max: 120 });
    attachRememberedScroll(el.node, key, el.frame);
    el.settle();
    expect(readScroll(key)).toBe(500);
  });

  it("stops retrying once the budget is spent, and records again after", () => {
    const key = { workspaceId: "spent", railId: "r" };
    writeScroll(key, 500);
    const el = scroller({ max: 120 });
    attachRememberedScroll(el.node, key, el.frame);
    // The budget counts WRITES, and the first is made synchronously at
    // attach. Each one queues a frame; the last of those frames finds
    // nothing left to spend and settles without queueing another.
    expect(el.settle()).toBe(RESTORE_FRAMES);
    expect(el.queued).toBe(0);
    // Silence past the budget would freeze this rail's offset forever.
    el.scroll(90);
    expect(readScroll(key)).toBe(90);
  });

  it("records nothing after destroy, and queues no further frames", () => {
    const key = { workspaceId: "destroyed", railId: "r" };
    writeScroll(key, 500);
    const el = scroller({ max: 0 });
    const handle = attachRememberedScroll(el.node, key, el.frame);
    handle.destroy();
    expect(el.listening).toBe(false);
    el.settle();
    expect(readScroll(key)).toBe(500);
  });

  it("ignores an update to an equal key, leaving the human where they scrolled", () => {
    // A plan push per second while a rail runs; each one hands the
    // action a new object naming the same rail.
    const key = { workspaceId: "same", railId: "r" };
    writeScroll(key, 100);
    const el = scroller();
    const handle = attachRememberedScroll(el.node, key, el.frame);
    el.settle();
    el.scroll(640);
    handle.update({ workspaceId: "same", railId: "r" });
    expect(el.offset).toBe(640);
    expect(readScroll(key)).toBe(640);
  });

  it("restores the new offset when the key genuinely changes", () => {
    // The strip survives a workspace switch -- `+page.svelte` reuses the
    // hub view and only re-props it -- so the element outlives the
    // offset it was showing.
    writeScroll({ workspaceId: "from", railId: null }, 50);
    writeScroll({ workspaceId: "to", railId: null }, 700);
    const el = scroller();
    const handle = attachRememberedScroll(el.node, { workspaceId: "from", railId: null }, el.frame);
    el.settle();
    handle.update({ workspaceId: "to", railId: null });
    expect(el.offset).toBe(700);
    el.settle();
    el.scroll(720);
    expect(readScroll({ workspaceId: "to", railId: null })).toBe(720);
    expect(readScroll({ workspaceId: "from", railId: null })).toBe(50);
  });
});

// The action is one line in each of two components and nothing that
// mounts them exists in this suite, so the wiring is pinned the way the
// rest of this tab's layout is -- by reading the source.
describe("the wiring", () => {
  it("remembers the strip's x on the element that scrolls sideways", () => {
    const hub = source("OrchestrationHubView.svelte");
    const at = hub.indexOf('<div class="grid"');
    expect(at).toBeGreaterThan(-1);
    const tag = hub.slice(at, hub.indexOf(">", at));
    expect(tag).toContain("use:remembersScroll={{ workspaceId, railId: null }}");
  });

  it("remembers each rail's y on the body that scrolls, keyed by the rail", () => {
    const rail = source("OrchestrationRail.svelte");
    const at = rail.indexOf('<div class="rail-body"');
    expect(at).toBeGreaterThan(-1);
    const tag = rail.slice(at, rail.indexOf(">", at));
    // Keyed by the rail, not by its position: the strip reorders, and a
    // filtered strip renders a subset.
    expect(tag).toContain("use:remembersScroll={{ workspaceId, railId: rail.id }}");
  });

  it("is not put on the rail itself, which does not scroll", () => {
    // `.rail` is the flex column; `.rail-body` is its one scroller. The
    // action on the wrong one reads a constant 0 and says nothing.
    const rail = source("OrchestrationRail.svelte");
    const at = rail.indexOf('<div class="rail" ');
    expect(at).toBeGreaterThan(-1);
    expect(rail.slice(at, rail.indexOf(">", at))).not.toContain("remembersScroll");
  });
});

// Named so a reader of the action's type sees it is the Svelte action,
// not only the seam the tests above drive.
describe("remembersScroll", () => {
  it("is attachRememberedScroll with the browser's frames", () => {
    writeScroll({ workspaceId: "action", railId: "r" }, 88);
    const el = scroller();
    const handle = remembersScroll(el.node, { workspaceId: "action", railId: "r" });
    expect(el.offset).toBe(88);
    handle.destroy();
    expect(el.listening).toBe(false);
  });
});
