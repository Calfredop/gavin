// The shell's clock for a bundle's calls: bursts, and the slowest call in
// each.
import { describe, expect, it } from "vitest";
import { describeBurst, MIN_BURST_CALLS, wireTiming, type WireBurst } from "$shell/visit/wireTiming";

function clock() {
  let t = 0;
  return { now: () => t, to: (ms: number) => (t = ms) };
}

describe("timing a bundle's calls", () => {
  it("says a burst once none is out, with the slowest call in it", () => {
    const c = clock();
    const bursts: WireBurst[] = [];
    const start = wireTiming(c.now, (b) => bursts.push(b));
    const done = ["get_workspaces_state", "get_session_names", "get_session_baselines", "get_board", "get_gavin_tree"].map(
      (what) => start(what)
    );
    c.to(100);
    done[0]();
    done[1]();
    c.to(700);
    done[2]();
    expect(bursts).toEqual([]);
    c.to(900);
    done[3]();
    done[4]();
    expect(bursts).toEqual([{ calls: 5, ms: 900, slowest: { what: "get_board", ms: 900 } }]);
  });

  it("starts a new burst with the next call made while none is out", () => {
    const c = clock();
    const bursts: WireBurst[] = [];
    const start = wireTiming(c.now, (b) => bursts.push(b));
    const first = Array.from({ length: MIN_BURST_CALLS }, () => start("a"));
    c.to(50);
    for (const done of first) done();
    c.to(1000);
    const second = Array.from({ length: MIN_BURST_CALLS }, () => start("b"));
    c.to(1020);
    for (const done of second) done();
    expect(bursts.map((b) => [b.calls, b.ms, b.slowest.what])).toEqual([
      [MIN_BURST_CALLS, 50, "a"],
      [MIN_BURST_CALLS, 20, "b"],
    ]);
  });

  it("says nothing of a key typed, but says a lone call that was slow", () => {
    const c = clock();
    const bursts: WireBurst[] = [];
    const start = wireTiming(c.now, (b) => bursts.push(b));
    const key = start("write_to_session");
    c.to(80);
    key();
    expect(bursts).toEqual([]);
    const slow = start("get_session_baselines");
    c.to(1500);
    slow();
    expect(bursts).toEqual([{ calls: 1, ms: 1420, slowest: { what: "get_session_baselines", ms: 1420 } }]);
  });

  it("counts a call once, however often it is said to be done", () => {
    const c = clock();
    const bursts: WireBurst[] = [];
    const start = wireTiming(c.now, (b) => bursts.push(b));
    const one = start("a");
    const two = start("b");
    c.to(2000);
    one();
    one();
    expect(bursts).toEqual([]);
    two();
    expect(bursts).toHaveLength(1);
  });

  it("reads as one line", () => {
    expect(describeBurst({ calls: 37, ms: 1240.4, slowest: { what: "get_session_baselines", ms: 610.6 } })).toBe(
      "[gavin-visit] 37 calls in 1240 ms; slowest get_session_baselines (611 ms)"
    );
  });
});
