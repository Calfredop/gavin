// Holding the command key for HINT_HOLD_MS reveals the shortcut badges
// on tabs, hub tabs and sidebar rows. The state machine is a pure
// reducer so its rules -- a typed shortcut must NOT flash hints, blur
// must clear them -- are testable without a DOM.
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

function modeFor(shift: boolean, alt: boolean): HintMode {
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
      // describe the combination that would fire right now.
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

export function installHintTracking(): () => void {
  let current = INITIAL_HINT_STATE;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function clearTimer(): void {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  function apply(event: HintEvent): void {
    const previous = current;
    const next = reduceHint(previous, event);
    current = next;
    modeStore.set(next.mode);

    const waiting = next.armed && !next.cancelled && next.mode === null;
    const wasWaiting = previous.armed && !previous.cancelled && previous.mode === null;
    if (waiting && !wasWaiting) {
      clearTimer();
      timer = setTimeout(() => {
        timer = null;
        apply({ type: "hold-elapsed" });
      }, HINT_HOLD_MS);
    } else if (!waiting) {
      clearTimer();
    }
  }

  function onKeydown(e: KeyboardEvent): void {
    if (!MODIFIER_KEYS.has(e.key)) {
      apply({ type: "other-key" });
      return;
    }
    apply({ type: "modifier-state", cmd: cmdHeld(e), shift: e.shiftKey, alt: e.altKey });
  }

  function onKeyup(e: KeyboardEvent): void {
    if (!MODIFIER_KEYS.has(e.key)) return;
    apply({ type: "modifier-state", cmd: cmdHeld(e), shift: e.shiftKey, alt: e.altKey });
  }

  function onBlur(): void {
    apply({ type: "blur" });
  }

  function onVisibility(): void {
    if (document.visibilityState === "hidden") apply({ type: "blur" });
  }

  // Capture, like the shortcut listener: xterm stops propagation first.
  // window blur matters on its own -- ⌘Tab away and the keyup for Meta
  // never arrives, which would otherwise leave the badges stuck on.
  window.addEventListener("keydown", onKeydown, true);
  window.addEventListener("keyup", onKeyup, true);
  window.addEventListener("blur", onBlur);
  document.addEventListener("visibilitychange", onVisibility);

  return () => {
    clearTimer();
    window.removeEventListener("keydown", onKeydown, true);
    window.removeEventListener("keyup", onKeyup, true);
    window.removeEventListener("blur", onBlur);
    document.removeEventListener("visibilitychange", onVisibility);
    current = INITIAL_HINT_STATE;
    modeStore.set(null);
  };
}
