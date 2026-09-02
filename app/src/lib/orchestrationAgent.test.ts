import { describe, it, expect } from "vitest";
import {
  GENERATE_LABEL,
  generateAction,
  generateButtonLabel,
  orchestrationAgentOver,
  reorganizeAction,
  reorganizeLabel,
} from "./orchestrationAgent";
import type { OrchestrationAgentRecord } from "./workspace";

function run(over: Partial<OrchestrationAgentRecord> = {}): OrchestrationAgentRecord {
  return { sessionId: "s-1", railId: null, label: GENERATE_LABEL, ...over };
}

describe("reorganizeLabel", () => {
  it("quotes the rail so a multi-word name cannot run into the message", () => {
    expect(reorganizeLabel("backend rewrite")).toBe("Reorganize “backend rewrite”");
  });
});

describe("orchestrationAgentOver", () => {
  it("is over when the session left the layout", () => {
    expect(orchestrationAgentOver("gone", "working")).toBe(true);
  });

  it("is over when the daemon restart left a bare shell wearing its id", () => {
    // The tree still holds the id, so "is it in the tree" would say the
    // run is going and the slot would never free.
    expect(orchestrationAgentOver("interrupted", "working")).toBe(true);
  });

  it("is over once the agent stops talking", () => {
    expect(orchestrationAgentOver("live", "idle")).toBe(true);
  });

  it("is NOT over while the agent is working", () => {
    expect(orchestrationAgentOver("live", "working")).toBe(false);
  });

  it("is NOT over while the agent is asking the human something", () => {
    expect(orchestrationAgentOver("live", "waiting_for_input")).toBe(false);
  });

  it("is NOT over when the daemon has reported nothing yet", () => {
    // The launch race: the daemon registers a new session idle and only
    // pushes on a change, so an absent status is "nothing reported yet".
    // Reading it as idle would end the run in the tick it started.
    expect(orchestrationAgentOver("live", undefined)).toBe(false);
  });
});

describe("generateAction", () => {
  const ready = { run: null, unplacedCount: 3, hasRoot: true, daemonBlocked: null };

  it("starts when there are unplaced cards and nothing is running", () => {
    expect(generateAction(ready)).toEqual({
      kind: "start",
      tip: "Hand the unplaced cards to a new agent…",
    });
  });

  it("does not need the workspace's main agent", () => {
    // The whole point of the dedicated session: Generate used to be
    // paste-only, so a stopped Home agent made it impossible.
    expect(generateAction(ready).kind).toBe("start");
  });

  it("jumps to the run holding the slot instead of refusing", () => {
    expect(generateAction({ ...ready, run: run({ label: "Reorganize “backend”" }) })).toEqual({
      kind: "jump",
      tip: "Reorganize “backend” is already running — jump to its tab",
    });
  });

  it("puts the running run ahead of having nothing to place", () => {
    // Otherwise the human is told "nothing left to place" by a button
    // that is actually held by the agent placing it.
    expect(generateAction({ ...ready, unplacedCount: 0, run: run() }).kind).toBe("jump");
  });

  it("is blocked with nothing left to place", () => {
    const action = generateAction({ ...ready, unplacedCount: 0 });
    expect(action.kind).toBe("blocked");
    expect(action.tip).toContain("already on a rail");
  });

  it("is blocked without a root folder to start the agent in", () => {
    const action = generateAction({ ...ready, hasRoot: false });
    expect(action.kind).toBe("blocked");
    expect(action.tip).toContain("no root folder");
  });

  it("puts the daemon's own reason first, before any of them", () => {
    const action = generateAction({
      ...ready,
      hasRoot: false,
      unplacedCount: 0,
      run: run(),
      daemonBlocked: "needs daemon v10",
    });
    expect(action).toEqual({ kind: "blocked", tip: "needs daemon v10" });
  });
});

describe("reorganizeAction", () => {
  const ready = { run: null, railId: "rail-1", hasRoot: true, daemonBlocked: null };

  it("starts when nothing is running", () => {
    expect(reorganizeAction(ready)).toEqual({
      kind: "start",
      tip: "Reorganize this rail with a new agent…",
    });
  });

  it("names this rail's own run when it is the one going", () => {
    const action = reorganizeAction({ ...ready, run: run({ railId: "rail-1" }) });
    expect(action).toEqual({
      kind: "jump",
      tip: "This rail's reorganize is already running — jump to its tab",
    });
  });

  it("is held by ANOTHER rail's run, and says whose", () => {
    // The slot is the workspace's: both requests rewrite the whole plan,
    // so two rails reorganized at once overwrite each other.
    const action = reorganizeAction({
      ...ready,
      run: run({ railId: "rail-2", label: "Reorganize “frontend”" }),
    });
    expect(action).toEqual({
      kind: "jump",
      tip: "Reorganize “frontend” is already running — jump to its tab",
    });
  });

  it("is held by a Generate too", () => {
    expect(reorganizeAction({ ...ready, run: run() })).toEqual({
      kind: "jump",
      tip: "Generate is already running — jump to its tab",
    });
  });

  it("is blocked without a root folder", () => {
    expect(reorganizeAction({ ...ready, hasRoot: false }).kind).toBe("blocked");
  });

  it("puts the daemon's own reason first", () => {
    expect(
      reorganizeAction({ ...ready, run: run(), daemonBlocked: "needs daemon v10" })
    ).toEqual({ kind: "blocked", tip: "needs daemon v10" });
  });
});

describe("generateButtonLabel", () => {
  it("offers to generate when the slot is free", () => {
    expect(generateButtonLabel(null)).toBe("Generate with agent…");
  });

  it("stops offering while its own run is going", () => {
    expect(generateButtonLabel(run())).toBe("Generating…");
  });

  it("does not claim a rail's reorganize as a generate", () => {
    expect(generateButtonLabel(run({ railId: "rail-1", label: "Reorganize “backend”" }))).toBe(
      "Agent running…"
    );
  });
});
