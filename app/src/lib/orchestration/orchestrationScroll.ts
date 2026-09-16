// Where the Orchestration tab was left scrolled to, kept across a tab
// switch.
//
// `+page.svelte` renders ONE hub view at a time, so leaving this tab
// destroys the whole strip -- every rail, every scroller with it -- and
// coming back builds it again from the plan. Both of the tab's axes go
// with it, and since the strip stopped being one shared scroll (see
// orchestrationRailScroll.test.ts) that is not one offset but many: the
// strip's own sideways position, plus the independent vertical position
// of every rail's body. Reading the foot of a long rail, stepping to the
// Agents page to watch the step it names, and stepping back put the
// human at the top of every rail again, with no way back but scrolling
// each one by hand.
//
// So the offsets live somewhere the switch does not reach: this module,
// subscribed to nothing and owned by no component, the way
// orchestrationState's scheduler is.
//
// In memory only, deliberately. The ask is "on tab switch"; where a
// strip is scrolled is a fact about a glance, not about the plan, and
// persisting it would buy a daemon write per wheel notch and a stale
// offset restored over a strip the next launch rebuilt from different
// rails.

/// Which remembered offset an element owns.
///
/// Compared by VALUE, never by identity -- see `sameScrollKey`.
export interface ScrollKey {
  workspaceId: string;
  /// The rail whose body this is, or `null` for the strip that holds
  /// them. That choice is also the axis (see `axisFor`).
  railId: string | null;
}

/// One workspace's offsets: the strip's own x, and each rail's y by rail
/// id. Rails are keyed rather than indexed because the strip reorders
/// and a filtered strip renders a subset -- a position in the row is not
/// a name for the rail standing there.
///
/// Nothing prunes this. A deleted rail leaves one number behind and a
/// closed workspace a handful, ids are never reissued so neither can be
/// restored onto the wrong scroller, and the whole map is bounded by the
/// rails an app RUN ever showed -- a cheaper thing to carry than a
/// cleanup hook in every module that can remove one.
interface TabScroll {
  x: number;
  rails: Map<string, number>;
}

const byWorkspace = new Map<string, TabScroll>();

function tabScrollFor(workspaceId: string): TabScroll {
  const found = byWorkspace.get(workspaceId);
  if (found) return found;
  const fresh: TabScroll = { x: 0, rails: new Map() };
  byWorkspace.set(workspaceId, fresh);
  return fresh;
}

/// The offset an element should be put back to. 0 -- the top, the left --
/// for anything never scrolled, which is also where a scroller starts,
/// so a first visit restores to exactly where it already is.
export function readScroll(key: ScrollKey): number {
  const tab = tabScrollFor(key.workspaceId);
  return key.railId === null ? tab.x : (tab.rails.get(key.railId) ?? 0);
}

export function writeScroll(key: ScrollKey, offset: number): void {
  const tab = tabScrollFor(key.workspaceId);
  if (key.railId === null) tab.x = offset;
  else tab.rails.set(key.railId, offset);
}

/// Whether two keys name the same offset.
///
/// By value, because Svelte re-runs an action's `update` whenever
/// anything the parameter expression read has changed, and a rail's
/// parameter reads `rail.id` off a prop the daemon replaces wholesale on
/// every plan push -- a rail advancing a step hands down a new object
/// with the same id several times a minute. An identity check would call
/// each of those a new element and restart the restore, dragging the
/// human's scroll back to where they left it while they were reading.
export function sameScrollKey(a: ScrollKey, b: ScrollKey): boolean {
  return a.workspaceId === b.workspaceId && a.railId === b.railId;
}

// ---- Axes -------------------------------------------------------------------

/// The one axis a scroller on this tab actually scrolls on.
export type ScrollAxis = "x" | "y";

/// Read off the key rather than passed beside it, so the wrong pairing
/// cannot be written down. The layout is what makes this total: the
/// strip is `overflow-x: auto` over `overflow-y: hidden`, and a rail body
/// is `overflow-y: auto`, both pinned by orchestrationRailScroll.test.ts.
/// Reading the axis a scroller does not have is silent -- a constant 0,
/// remembered and restored forever.
export function axisFor(key: ScrollKey): ScrollAxis {
  return key.railId === null ? "x" : "y";
}

/// The minimum an element has to be for the action below to drive it --
/// declared so the tests can drive a plain object rather than a DOM node.
export interface ScrollNode {
  scrollLeft: number;
  scrollTop: number;
  addEventListener(type: "scroll", handler: () => void): void;
  removeEventListener(type: "scroll", handler: () => void): void;
}

export function offsetOf(node: ScrollNode, axis: ScrollAxis): number {
  return axis === "x" ? node.scrollLeft : node.scrollTop;
}

export function setOffset(node: ScrollNode, axis: ScrollAxis, offset: number): void {
  if (axis === "x") node.scrollLeft = offset;
  else node.scrollTop = offset;
}

// ---- Putting an offset back -------------------------------------------------

/// How many animation frames a restore keeps putting the offset back
/// before it accepts where it landed.
///
/// One synchronous write is normally the whole of it: coming back to this
/// tab finds `orchestrations`, the board and the tool library all warm,
/// so the rails render at full height in the flush that creates them and
/// the write sticks. The extra frames are for the other case -- a store
/// answering a beat later makes the strip wider or a rail taller, and a
/// write made before that growth was silently CLAMPED to the short
/// extent the scroller had at the time.
///
/// Small on purpose. Every frame in the window is a frame the listener is
/// not recording, so a human's own scroll inside it would be both
/// overwritten and forgotten. Four frames is under a tenth of a second,
/// comfortably shorter than the gap between a tab switch and the hand
/// that follows it.
export const RESTORE_FRAMES = 4;

/// What a restore frame should do.
export type RestoreStep = { kind: "write"; offset: number } | { kind: "settle" };

/// One frame of a restore.
///
/// Settling on the target is the ordinary end. Settling on a spent budget
/// is the other one: the content shrank while the tab was away -- a rail
/// deleted, a stage cleared, a search box left filtering -- and no number
/// of further writes makes a scroller go past its own end.
///
/// A settle never shares a frame with a write, and that is the point
/// rather than an accident. A write raises a `scroll` event of its own,
/// delivered at the START of the next frame's rendering update, before
/// that frame's animation callbacks; the listener has to still be silent
/// when it arrives. Settling only on a frame that wrote nothing puts
/// every echo behind us -- including the echo of a write clamped to 0,
/// which recorded would erase the very offset being put back.
export function stepRestore(target: number, current: number, framesLeft: number): RestoreStep {
  if (current === target || framesLeft <= 0) return { kind: "settle" };
  return { kind: "write", offset: target };
}

/// Schedules the next restore frame. Node -- and so a unit test -- has no
/// `requestAnimationFrame`, and there the first, synchronous attempt is
/// the whole restore.
function browserFrame(fn: () => void): void {
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(fn);
}

export interface RememberedScroll {
  update(key: ScrollKey): void;
  destroy(): void;
}

/// `remembersScroll` with its frame scheduler handed in -- the seam the
/// tests drive, since a restore's retries are frames.
export function attachRememberedScroll(
  node: ScrollNode,
  key: ScrollKey,
  frame: (fn: () => void) => void
): RememberedScroll {
  let current = key;
  let recording = false;
  let live = true;

  function onScroll(): void {
    // Silent while a restore is in flight: the only scrolling in that
    // window is the restore's own, and recording it is how the offset was
    // lost rather than how it is kept.
    if (!recording) return;
    writeScroll(current, offsetOf(node, axisFor(current)));
  }

  function restore(): void {
    recording = false;
    const axis = axisFor(current);
    const target = readScroll(current);
    let framesLeft = RESTORE_FRAMES;
    const attempt = (): void => {
      if (!live) return;
      const step = stepRestore(target, offsetOf(node, axis), framesLeft);
      if (step.kind === "settle") {
        recording = true;
        return;
      }
      framesLeft -= 1;
      setOffset(node, axis, step.offset);
      frame(attempt);
    };
    attempt();
  }

  node.addEventListener("scroll", onScroll);
  restore();

  return {
    update(next: ScrollKey): void {
      if (sameScrollKey(next, current)) return;
      current = next;
      restore();
    },
    destroy(): void {
      live = false;
      node.removeEventListener("scroll", onScroll);
    },
  };
}

/// Svelte action, applied to a scroller on the Orchestration tab:
/// `use:remembersScroll={{ workspaceId, railId: rail.id }}` on a rail's
/// body, `railId: null` on the strip that holds them.
export function remembersScroll(node: ScrollNode, key: ScrollKey): RememberedScroll {
  return attachRememberedScroll(node, key, browserFrame);
}
