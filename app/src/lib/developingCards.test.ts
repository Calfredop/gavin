import { describe, it, expect } from "vitest";
import {
  DEVELOPING_BLOCK,
  DEVELOPING_STALL,
  developRunOver,
  developingRunFor,
  developingRunIn,
} from "./developingCards";
import type { DevelopingCardRecord, SessionLiveness } from "./workspace";

const RUN: DevelopingCardRecord = { path: "/ws/.gavin-root/plans/thin.md", sessionId: "s-dev" };

describe("developingRunFor", () => {
  it("finds the run by card path, and answers null for every other card", () => {
    expect(developingRunFor([RUN], RUN.path)).toEqual(RUN);
    expect(developingRunFor([RUN], "/ws/.gavin-root/plans/other.md")).toBeNull();
  });

  // Absent and empty are the normal states -- the field is only written
  // once a card has ever been developed in this workspace.
  it("treats an absent or empty list as nothing developing", () => {
    expect(developingRunFor(undefined, RUN.path)).toBeNull();
    expect(developingRunFor([], RUN.path)).toBeNull();
  });
});

describe("developingRunIn", () => {
  const state = {
    workspaces: [
      { id: "ws-1", developingCards: [RUN] },
      { id: "ws-2" },
    ],
  } as unknown as Parameters<typeof developingRunIn>[0];

  it("reads the workspace's own records, and never another workspace's", () => {
    expect(developingRunIn(state, "ws-1", RUN.path)).toEqual(RUN);
    // The same card path under a workspace that is not developing it: two
    // workspaces can hold the same repo, and a lock is one workspace's.
    expect(developingRunIn(state, "ws-2", RUN.path)).toBeNull();
    expect(developingRunIn(state, "ws-gone", RUN.path)).toBeNull();
  });
});

describe("developRunOver", () => {
  // An interactive agent never exits, so none of the three signals is an
  // exit code -- the same rule the orchestration agent slot runs on.
  it("is over when the session is gone, interrupted or broken", () => {
    for (const liveness of ["gone", "interrupted", "failed"] as SessionLiveness[]) {
      expect(developRunOver(liveness, "working"), liveness).toBe(true);
    }
  });

  it("is over when a live agent goes idle: for a one-shot request that is the finish line", () => {
    expect(developRunOver("live", "idle")).toBe(true);
  });

  // The trap this rule exists to avoid: the daemon registers a new
  // session idle and only pushes on a CHANGE, so "nothing said yet"
  // arrives as undefined. Reading that as idle would free the card in the
  // very tick its develop run launched.
  it("is NOT over when the daemon has said nothing about the session yet", () => {
    expect(developRunOver("live", undefined)).toBe(false);
  });

  // And the common case rather than an edge: the develop agent's first
  // move is to interview the human, so a run spends most of its life
  // here. Freeing the card would unlock it for the whole conversation.
  it("is NOT over while the agent is working or waiting on the human", () => {
    expect(developRunOver("live", "working")).toBe(false);
    expect(developRunOver("live", "waiting_for_input")).toBe(false);
  });
});

describe("the refusals", () => {
  // Two lengths for two surfaces: a sentence where there is room to
  // explain, a clause for a rail's step chip.
  it("say what is happening before they say no", () => {
    expect(DEVELOPING_BLOCK).toMatch(/developing this card/);
    expect(DEVELOPING_BLOCK.length).toBeGreaterThan(DEVELOPING_STALL.length);
    expect(DEVELOPING_STALL).toBe("the card is being developed");
  });
});
