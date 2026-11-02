import { describe, it, expect } from "vitest";
import type { GavinTree, PlanFileInfo } from "$lib/core/gavin";
import type { WorkspacesData } from "$lib/core/workspace";
import type { QueueTarget } from "$lib/agents/queuedInput";
import {
  CARD_FOLLOW_UP_MODES,
  cardFollowUpCandidates,
  cardFollowUpHold,
  cardFollowUpRefusal,
  cardFollowUpsMayFire,
  followUpButtonTip,
  parseCardFollowUps,
  serializeCardFollowUps,
  workspaceOfSession,
  type CardFollowUp,
} from "$lib/agents/cardFollowUp";

function plan(over: Partial<PlanFileInfo> & { fileName: string }): PlanFileInfo {
  return {
    path: `/ws/.gavin-root/plans/${over.fileName}`,
    title: over.fileName.replace(/\.md$/, ""),
    status: "To Do",
    priority: null,
    order: null,
    kind: "task",
    parent: null,
    labels: [],
    checklistDone: 0,
    checklistTotal: 0,
    parseWarning: false,
    ...over,
  };
}

function tree(plans: PlanFileInfo[]): GavinTree {
  return {
    rootPath: "/ws",
    rootMissing: false,
    contexts: [{ folderPath: "/ws", kind: "root", name: "root", plans, docs: [], specs: [], hasPrd: false, configWarning: false }],
  } as unknown as GavinTree;
}

const target = (over: Partial<QueueTarget> = {}): QueueTarget => ({
  status: "working",
  interrupted: false,
  blockedReason: null,
  verdict: null,
  ...over,
});
const asking = { state: "read", reading: { kind: "asking" } } as unknown as QueueTarget["verdict"];

function held(cardPath = "/ws/.gavin-root/plans/a.md"): CardFollowUp {
  return { id: "cf-1", sessionId: "s-1", workspaceId: "ws-1", cardPath, title: "a", askedAtMs: 1, error: null };
}

describe("cardFollowUpCandidates", () => {
  const t = tree([
    plan({ fileName: "login-flow.md", title: "Fix the login flow" }),
    plan({ fileName: "remember.md", title: "Remember milk", kind: "note" }),
    plan({ fileName: "shipped.md", title: "Shipped thing", status: "Done" }),
    plan({ fileName: "filed.md", title: "Filed thing", path: "/ws/.gavin-root/plans/done/filed.md", status: null }),
    plan({ fileName: "old.md", title: "Old thing", path: "/ws/.gavin-root/plans/archive/old.md" }),
    plan({ fileName: "rework.md", title: "Auth rework", kind: "plan", status: "In Progress" }),
  ]);

  it("offers runnable, open cards only", () => {
    // A note is never runnable, and running a Done or archived card from
    // a picker would un-file it as a side effect of scrolling a list.
    expect(cardFollowUpCandidates(t, "").map((c) => c.title)).toEqual([
      "Fix the login flow",
      "Auth rework",
    ]);
  });

  it("matches every word, in any order, against the title and the file name", () => {
    expect(cardFollowUpCandidates(t, "flow fix").map((c) => c.title)).toEqual(["Fix the login flow"]);
    expect(cardFollowUpCandidates(t, "REWORK").map((c) => c.title)).toEqual(["Auth rework"]);
    expect(cardFollowUpCandidates(t, "login-flow.md").map((c) => c.title)).toEqual(["Fix the login flow"]);
    expect(cardFollowUpCandidates(t, "nothing like it")).toEqual([]);
  });

  it("caps the list and survives a workspace with no tree", () => {
    const many = tree(Array.from({ length: 30 }, (_, i) => plan({ fileName: `c${i}.md` })));
    expect(cardFollowUpCandidates(many, "", 5)).toHaveLength(5);
    expect(cardFollowUpCandidates(undefined, "")).toEqual([]);
  });
});

describe("workspaceOfSession", () => {
  const state = {
    workspaces: [
      { id: "ws-a", mainSessionId: "main-a", pages: [{ id: "p", layout: { type: "leaf", tabs: ["t-1"], activeTab: "t-1" } }] },
      {
        id: "ws-b",
        pages: [
          {
            id: "p",
            layout: {
              type: "split",
              direction: "row",
              children: [
                { type: "leaf", tabs: ["t-2"], activeTab: "t-2" },
                { type: "leaf", tabs: ["t-3"], activeTab: "t-3" },
              ],
              sizes: [50, 50],
            },
          },
        ],
      },
    ],
  } as unknown as WorkspacesData;

  it("finds a Home agent, a tab, and a tab deep in a split", () => {
    expect(workspaceOfSession(state, "main-a")).toBe("ws-a");
    expect(workspaceOfSession(state, "t-1")).toBe("ws-a");
    expect(workspaceOfSession(state, "t-3")).toBe("ws-b");
    expect(workspaceOfSession(state, "gone")).toBeNull();
  });
});

describe("cardFollowUpRefusal", () => {
  it("refuses inline on exactly what refuses a typed follow-up", () => {
    expect(cardFollowUpRefusal("inline", target(), null, [], "/x")).toBeNull();
    expect(cardFollowUpRefusal("inline", target(), "Needs v29", [], "/x")).toBe("Needs v29");
  });

  it("lets a new session wait on a question, but not on a turn that never ends", () => {
    // A new tab cannot be mistaken for the answer to the question; it
    // just waits for the turn after it.
    expect(cardFollowUpRefusal("new-session", target({ verdict: asking }), "asking", [], "/x")).toBeNull();
    // The app holds this queue, so the daemon's version gate is not its.
    expect(cardFollowUpRefusal("new-session", target(), "Needs v29", [], "/x")).toBeNull();
    expect(cardFollowUpRefusal("new-session", target({ interrupted: true }), null, [], "/x")).toContain(
      "never end"
    );
  });

  it("does not hold the same card twice for one session", () => {
    const path = "/ws/.gavin-root/plans/a.md";
    expect(cardFollowUpRefusal("new-session", target(), null, [held(path)], path)).toContain("already waiting");
    expect(cardFollowUpRefusal("new-session", target(), null, [held(path)], "/other.md")).toBeNull();
  });
});

describe("cardFollowUpsMayFire", () => {
  it("fires when the turn has ended, and only then", () => {
    expect(cardFollowUpsMayFire(target({ status: "idle" }))).toBe(true);
    for (const status of ["working", "waiting_for_input", "failed", undefined] as const) {
      expect(cardFollowUpsMayFire(target({ status }))).toBe(false);
    }
  });

  it("does not take a question for the end of the work", () => {
    expect(cardFollowUpsMayFire(target({ status: "idle", verdict: asking }))).toBe(false);
    expect(cardFollowUpsMayFire(target({ status: "idle", interrupted: true }))).toBe(false);
  });
});

describe("cardFollowUpHold", () => {
  it("says nothing with nothing held, and why the rest wait", () => {
    expect(cardFollowUpHold(target(), 0)).toBeNull();
    expect(cardFollowUpHold(target(), 1)).toContain("when this agent's turn ends");
    expect(cardFollowUpHold(target({ status: "idle" }), 1)).toBe("Opening now.");
    expect(cardFollowUpHold(target({ status: "idle", verdict: asking }), 1)).toContain("asking you");
    expect(cardFollowUpHold(target({ status: "failed" }), 2)).toContain("Open these now");
    expect(cardFollowUpHold(target({ interrupted: true }), 1)).toContain("never end");
  });
});

describe("followUpButtonTip", () => {
  it("adds the held cards to the typed queue's tip, or stands alone", () => {
    expect(followUpButtonTip(null, 0)).toBeNull();
    expect(followUpButtonTip("1 follow-up queued", 0)).toBe("1 follow-up queued");
    expect(followUpButtonTip(null, 1)).toBe("1 card to open in a new tab");
    expect(followUpButtonTip("1 follow-up queued", 2)).toBe("1 follow-up queued\n2 cards to open in new tabs");
  });
});

describe("persistence", () => {
  it("round-trips, grouped by session", () => {
    const a = held();
    const b = { ...held("/ws/b.md"), id: "cf-2", sessionId: "s-2", error: "refused" };
    const back = parseCardFollowUps(serializeCardFollowUps({ "s-1": [a], "s-2": [b] }));
    expect(back).toEqual({ "s-1": [a], "s-2": [b] });
  });

  it("drops a malformed row without losing the rest", () => {
    const good = held();
    const raw = JSON.stringify([good, { id: "x" }, null, { ...good, id: "cf-3", askedAtMs: "soon" }]);
    expect(parseCardFollowUps(raw)).toEqual({ "s-1": [good] });
    expect(parseCardFollowUps("not json")).toEqual({});
    expect(parseCardFollowUps(null)).toEqual({});
  });
});

describe("the two modes", () => {
  it("are offered in that order, each with what it does", () => {
    expect(CARD_FOLLOW_UP_MODES.map((m) => m.mode)).toEqual(["inline", "new-session"]);
    for (const m of CARD_FOLLOW_UP_MODES) expect(m.note.length).toBeGreaterThan(0);
  });
});
