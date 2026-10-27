// How long a bundle waits on its Workstation, as the shell sees it.
//
// Each call is timed from when the shell sends it to when its answer
// comes back, and calls are gathered into bursts: a burst runs from the
// first call made while none was out to the moment none is out again.
// That is what opening a Workstation, a workspace or a surface costs, in
// one number, and the call that held it up the longest. A burst too small
// to be one of those -- a key typed into a terminal -- is not said.

export interface WireBurst {
  calls: number;
  ms: number;
  /// The call that took longest, and how long.
  slowest: { what: string; ms: number };
}

/// The fewest calls a burst is said for, unless it took `SLOW_BURST_MS`.
export const MIN_BURST_CALLS = 5;
export const SLOW_BURST_MS = 1000;

/// A clock for calls. `start(what)` is called as a call is sent and
/// returns what to call when its answer, or its failure, comes back.
export function wireTiming(now: () => number, report: (burst: WireBurst) => void): (what: string) => () => void {
  let out = 0;
  let began = 0;
  let calls = 0;
  let slowest: WireBurst["slowest"] = { what: "", ms: -1 };
  return (what) => {
    const sentAt = now();
    if (out === 0) {
      began = sentAt;
      calls = 0;
      slowest = { what: "", ms: -1 };
    }
    out += 1;
    calls += 1;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const at = now();
      if (at - sentAt > slowest.ms) slowest = { what, ms: at - sentAt };
      out -= 1;
      if (out > 0) return;
      const ms = at - began;
      if (calls >= MIN_BURST_CALLS || ms >= SLOW_BURST_MS) report({ calls, ms, slowest });
    };
  };
}

export function describeBurst(burst: WireBurst): string {
  const round = (ms: number): number => Math.round(ms);
  return `[gavin-visit] ${burst.calls} call${burst.calls === 1 ? "" : "s"} in ${round(burst.ms)} ms; slowest ${burst.slowest.what} (${round(burst.slowest.ms)} ms)`;
}
