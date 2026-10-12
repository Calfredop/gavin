import { describe, it, expect } from "vitest";
import {
  DEVELOPING_BLOCK,
  DEVELOPING_STALL,
  developBaseline,
  developRunOver,
  developWriteSeen,
  developingRunFor,
  developingRunIn,
} from "$lib/cards/developingCards";
import type { DevelopingCardRecord, SessionLiveness } from "$lib/core/workspace";
import type { GavinTree } from "$lib/core/gavin";

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
  it("is over when the session is gone, interrupted or broken, written or not", () => {
    for (const liveness of ["gone", "interrupted", "failed"] as SessionLiveness[]) {
      expect(developRunOver(liveness, "working", false), liveness).toBe(true);
    }
  });

  it("is over when a live agent goes idle after writing the card: that is the finish line", () => {
    expect(developRunOver("live", "idle", true)).toBe(true);
  });

  // The bug this signature exists for: the agent's first move is a
  // question in prose, which the daemon reads as idle. Freeing the card
  // there dropped the badge seconds into the run.
  it("is NOT over when the agent is idle but has not written the card yet", () => {
    expect(developRunOver("live", "idle", false)).toBe(false);
  });

  // The daemon registers a new session idle and only pushes on a
  // CHANGE, so "nothing said yet" arrives as undefined.
  it("is NOT over when the daemon has said nothing about the session yet", () => {
    expect(developRunOver("live", undefined, true)).toBe(false);
  });

  it("is NOT over while the agent is working or waiting on the human", () => {
    expect(developRunOver("live", "working", true)).toBe(false);
    expect(developRunOver("live", "waiting_for_input", true)).toBe(false);
  });
});

describe("developWriteSeen", () => {
  function tree(modifiedAt: number | null, path = RUN.path): GavinTree {
    return {
      rootPath: "/ws",
      rootMissing: false,
      contexts: [
        {
          folderPath: "/ws",
          kind: "root",
          name: "ws",
          plans: [{ path, fileName: "thin.md", title: "Thin", status: "To Do", priority: null, order: null, kind: "task", parent: null, labels: [], checklistDone: 0, checklistTotal: 0, parseWarning: false, modifiedAt }],
          docs: [],
          specs: [],
          hasPrd: true,
          configWarning: false,
        },
      ],
    } as GavinTree;
  }
  const STAMPED = { ...RUN, baselineModifiedAt: 1_000 };

  it("reads the baseline off the tree at launch", () => {
    expect(developBaseline(tree(1_000), RUN.path)).toBe(1_000);
    expect(developBaseline(tree(null), RUN.path)).toBeNull();
    expect(developBaseline(undefined, RUN.path)).toBeNull();
    expect(developBaseline(tree(1_000, "/elsewhere.md"), RUN.path)).toBeNull();
  });

  it("is false while the card is still at its launch mtime, and true once it is newer", () => {
    expect(developWriteSeen(STAMPED, tree(1_000))).toBe(false);
    expect(developWriteSeen(STAMPED, tree(1_001))).toBe(true);
  });

  // Not known is not written: the records load with the workspaces, the
  // trees a moment later, and an idle agent in between must not be read
  // as finished.
  it("is false before the tree has loaded, or when the card has no mtime", () => {
    expect(developWriteSeen(STAMPED, undefined)).toBe(false);
    expect(developWriteSeen(STAMPED, tree(null))).toBe(false);
  });

  it("is true once the card has left the tree: filed, archived or renamed", () => {
    expect(developWriteSeen(STAMPED, tree(1_000, "/ws/.gavin-root/plans/done/thin.md"))).toBe(true);
  });

  // A record an older build wrote carries no baseline, and neither does
  // one whose card the tree had no mtime for: both keep idle-ends-it.
  it("is true with no baseline, which keeps the rule from before the baseline existed", () => {
    expect(developWriteSeen(RUN, tree(1_000))).toBe(true);
    expect(developWriteSeen({ ...RUN, baselineModifiedAt: null }, undefined)).toBe(true);
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
