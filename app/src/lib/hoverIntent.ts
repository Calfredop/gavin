// A hover that has to be MEANT. Pointing at something for a moment on
// the way somewhere else should not trigger it; dwelling on it should.
//
// Split out of the component that needs it so the timing is testable at
// all -- a delay wired straight into a .svelte file is the one part of
// an interaction no suite here can see. The shape mirrors tooltip.ts,
// which learned the hard way that cancel must ALWAYS clear the timer,
// even when nothing was ever shown: a pending settle that fires after
// the pointer has gone has nothing left to take it back down again.

export interface HoverIntent {
  /// The pointer arrived over `key`'s target: arm the delay. Re-arming
  /// on a different target drops whatever the last one had pending.
  enter(key: string): void;
  /// The pointer left, or a click dismissed it: cancel anything pending
  /// AND clear whatever had already settled.
  leave(): void;
  /// Keyboard focus: settle at once. Focus is already deliberate, so
  /// there is no accidental arrival here for a delay to guard against.
  focusNow(key: string): void;
  destroy(): void;
}

/// `onSettled` is called with the key when one settles and with null
/// when it clears -- and only on an actual change, so a caller can
/// assign it straight to state without guarding for repeats.
export function createHoverIntent(
  delayMs: number,
  onSettled: (key: string | null) => void
): HoverIntent {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let settled: string | null = null;

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function settle(key: string | null): void {
    if (settled === key) return;
    settled = key;
    onSettled(key);
  }

  return {
    enter(key: string): void {
      // Already showing this one: a stray re-entry must not take it down
      // and bring it back a delay later -- a flicker caused by the very
      // timer meant to prevent one.
      if (settled === key) {
        clearTimer();
        return;
      }
      clearTimer();
      settle(null);
      timer = setTimeout(() => {
        timer = null;
        settle(key);
      }, delayMs);
    },
    leave(): void {
      clearTimer();
      settle(null);
    },
    focusNow(key: string): void {
      clearTimer();
      settle(key);
    },
    destroy(): void {
      clearTimer();
      settled = null;
    },
  };
}
