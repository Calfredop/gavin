// Holding the command key for HINT_HOLD_MS reveals the shortcut badges
// on tabs, hub tabs and sidebar rows. Split in two so both halves are
// testable without a DOM: `reduceHint` says WHAT the state is, and
// `createHintTracker` says WHEN the hold has lasted long enough.
// `installHintTracking` is then only the DOM wiring.
import { readonly, writable, type Readable } from "svelte/store";
import { cmdHeld } from "./platform";

export type HintMode = "cmd" | "cmd-shift" | "cmd-alt";

export interface HintState {
  /// The command key is down: the hold timer is running, or has elapsed.
  armed: boolean;
  /// Another key was pressed during this hold: no hints until release.
  cancelled: boolean;
  /// The Shift/Alt state as last seen, so the mode is known when the
  /// hold elapses -- holding ⌘⇧ from the start must show page badges,
  /// not tab badges.
  shift: boolean;
  alt: boolean;
  mode: HintMode | null;
}

export type HintEvent =
  | { type: "modifier-state"; cmd: boolean; shift: boolean; alt: boolean }
  | { type: "other-key" }
  | { type: "hold-elapsed" }
  | { type: "blur" };

export const INITIAL_HINT_STATE: HintState = {
  armed: false,
  cancelled: false,
  shift: false,
  alt: false,
  mode: null,
};
export const HINT_HOLD_MS = 500;

// null for ⌘⇧⌥: the router refuses that combination, and a badge that
// advertises an action which will not fire is the one thing this feature
// must never do.
function modeFor(shift: boolean, alt: boolean): HintMode | null {
  if (shift && alt) return null;
  if (shift) return "cmd-shift";
  if (alt) return "cmd-alt";
  return "cmd";
}

export function reduceHint(state: HintState, event: HintEvent): HintState {
  switch (event.type) {
    case "modifier-state": {
      // Releasing the command key ends the hold outright, cancel and all.
      if (!event.cmd) return INITIAL_HINT_STATE;
      const seen = { ...state, armed: true, shift: event.shift, alt: event.alt };
      if (state.cancelled) return seen;
      // Already showing: follow Shift/Alt live, so the badges always
      // describe the combination that would fire right now (and vanish
      // for a combination that would fire nothing).
      if (state.mode) return { ...seen, mode: modeFor(event.shift, event.alt) };
      return seen;
    }
    case "other-key":
      return state.armed ? { ...state, cancelled: true, mode: null } : state;
    case "hold-elapsed":
      if (!state.armed || state.cancelled) return state;
      return { ...state, mode: state.mode ?? modeFor(state.shift, state.alt) };
    case "blur":
      return INITIAL_HINT_STATE;
  }
}

const modeStore = writable<HintMode | null>(null);

/// The hint mode every surface reads to decide whether to draw badges.
export const hintMode: Readable<HintMode | null> = readonly(modeStore);

const MODIFIER_KEYS = new Set(["Meta", "Control", "Shift", "Alt", "CapsLock"]);

/// Just the facts a tracker needs from a keyboard event.
export interface HintKeyEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export interface HintTracker {
  keydown(e: HintKeyEvent): void;
  keyup(e: HintKeyEvent): void;
  blur(): void;
  /// Cancels any pending hold timer.
  dispose(): void;
}

export interface HintClock {
  setTimeout: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (handle: ReturnType<typeof setTimeout>) => void;
}

/// The timer half of the hint layer, with no DOM in sight. The clock and
/// the mode sink are injectable so the wiring -- which is where a stuck
/// badge or a leaked timer would come from -- can be tested directly.
export function createHintTracker(
  onMode: (mode: HintMode | null) => void,
  // Wrapped in arrows on purpose: `{ setTimeout, clearTimeout }` would be
  // called as methods of this object, and WebKit refuses that with "Can
  // only call Window.setTimeout on instances of Window" -- which threw on
  // every ⌘ keydown and left the badges permanently off.
  clock: HintClock = {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle),
  },
  holdMs: number = HINT_HOLD_MS
): HintTracker {
  let current = INITIAL_HINT_STATE;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function clearTimer(): void {
    if (timer !== null) clock.clearTimeout(timer);
    timer = null;
  }

  function apply(event: HintEvent): void {
    const previous = current;
    const next = reduceHint(previous, event);
    current = next;
    onMode(next.mode);

    const waiting = next.armed && !next.cancelled && next.mode === null;
    const wasWaiting = previous.armed && !previous.cancelled && previous.mode === null;
    // Only on the transition INTO waiting: modifier key-repeat, and
    // adding Shift mid-hold, must not re-charge the user another holdMs.
    if (waiting && !wasWaiting) {
      clearTimer();
      timer = clock.setTimeout(() => {
        timer = null;
        apply({ type: "hold-elapsed" });
      }, holdMs);
    } else if (!waiting) {
      clearTimer();
    }
  }

  return {
    keydown(e) {
      if (!MODIFIER_KEYS.has(e.key)) {
        apply({ type: "other-key" });
        return;
      }
      apply({ type: "modifier-state", cmd: cmdHeld(e), shift: e.shiftKey, alt: e.altKey });
    },
    keyup(e) {
      // A non-modifier keyup says nothing: the cancel stands until the
      // command key itself comes up.
      if (!MODIFIER_KEYS.has(e.key)) return;
      apply({ type: "modifier-state", cmd: cmdHeld(e), shift: e.shiftKey, alt: e.altKey });
    },
    blur() {
      apply({ type: "blur" });
    },
    dispose() {
      clearTimer();
      current = INITIAL_HINT_STATE;
    },
  };
}

export function installHintTracking(): () => void {
  const tracker = createHintTracker((mode) => modeStore.set(mode));

  const onKeydown = (e: KeyboardEvent): void => tracker.keydown(e);
  const onKeyup = (e: KeyboardEvent): void => tracker.keyup(e);
  const onBlur = (): void => tracker.blur();
  const onVisibility = (): void => {
    if (document.visibilityState === "hidden") tracker.blur();
  };

  // Capture, like the shortcut listener: xterm stops propagation first.
  // window blur matters on its own -- ⌘Tab away and the keyup for Meta
  // never arrives, which would otherwise leave the badges stuck on.
  window.addEventListener("keydown", onKeydown, true);
  window.addEventListener("keyup", onKeyup, true);
  window.addEventListener("blur", onBlur);
  document.addEventListener("visibilitychange", onVisibility);

  return () => {
    window.removeEventListener("keydown", onKeydown, true);
    window.removeEventListener("keyup", onKeyup, true);
    window.removeEventListener("blur", onBlur);
    document.removeEventListener("visibilitychange", onVisibility);
    tracker.dispose();
    modeStore.set(null);
  };
}
