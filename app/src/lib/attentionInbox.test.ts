import { describe, it, expect } from "vitest";
import {
  attentionInbox,
  waitLabel,
  rowTip,
  REASON_LABEL,
  type AttentionInboxInput,
  type AttentionState,
} from "./attentionInbox";
import { PHASE_LABEL } from "./appHub";
import type { AttentionRow } from "./attentionInbox";
import type { Page, Workspace } from "./workspace";
import type { LayoutNode } from "./layout";
import type { Board } from "./kanban";
import type { GavinContext, GavinTree, PlanFileInfo } from "./gavin";
import type { Orchestration, StepAttention } from "./orchestration";

const NOW = 1_000_000_000;
const MINUTE = 60_000;

function leaf(tabs: string[]): LayoutNode {
  return { type: "leaf", tabs, activeTabIndex: 0 };
}

function page(id: string, tabs: string[], name = id): Page {
  return { id, name, layout: leaf(tabs), focusedSessionId: null };
}

function wsWith(id: string, pages: Page[], overrides: Partial<Workspace> = {}): Workspace {
  return { id, name: id.toUpperCase(), pages, activePageId: pages[0]?.id ?? null, ...overrides };
}

function inboxState(workspaces: Workspace[], overrides: Partial<AttentionState> = {}): AttentionState {
  return {
    workspaces,
    activeWorkspaceId: workspaces[0]?.id ?? null,
    sessionStatusById: {},
    fileTabsById: {},
    cardTabsById: {},
    boardTabsById: {},
    interruptedSessionIds: new Set(),
    sessionNames: {},
    cwdBySessionId: {},
    failureReasonById: {},
    statusSinceById: {},
    ...overrides,
  };
}

function input(state: AttentionState, overrides: Partial<AttentionInboxInput> = {}): AttentionInboxInput {
  return { state, boards: {}, trees: {}, orchestrations: {}, ...overrides };
}

/// A session that has been in its current status for `minutes`, watched
/// by this app run (the ordinary case: gavin saw the transition happen).
function since(minutes: number): { at: number; watched: boolean } {
  return { at: NOW - minutes * MINUTE, watched: true };
}

function boardWith(cardSessions: Array<{ path: string; sessionId: string }>): Board {
  return {
    columns: ["To Do", "In Progress", "Done"].map((name, position) => ({
      id: `c${position}`,
      name,
      position,
    })),
    labels: [],
    cardSessions: cardSessions.map((cs) => ({ ...cs, cwd: "/ws", command: null })),
  };
}

function planCard(fileName: string, overrides: Partial<PlanFileInfo> = {}): PlanFileInfo {
  return {
    path: `/ws/.gavin-root/plans/${fileName}`,
    fileName,
    title: fileName.replace(/\.md$/, ""),
    status: "In Progress",
    priority: null,
    order: null,
    kind: "plan",
    parent: null,
    labels: [],
    checklistDone: 0,
    checklistTotal: 0,
    parseWarning: false,
    ...overrides,
  };
}

function treeWith(plans: PlanFileInfo[]): GavinTree {
  const ctx: GavinContext = {
    folderPath: "/ws/.gavin-root",
    kind: "root",
    name: "ws",
    plans,
    docs: [],
    specs: [],
    hasPrd: false,
    configWarning: false,
  };
  return { rootPath: "/ws", rootMissing: false, contexts: [ctx] };
}

const CARD = "/ws/.gavin-root/plans/card.md";

/// A rail whose one step is running the given session, so a `turn-ended`
/// mark on that step has somewhere to come from.
function orchRunning(stepId: string, sessionId: string, cardPath = CARD): Orchestration {
  return {
    rails: [
      {
        id: "r1",
        name: "R",
        position: 0,
        worktreePath: null,
        pageId: null,
        stages: [{ id: "st1", position: 0, steps: [{ id: stepId, position: 0, cardPath }] }],
      },
    ],
    conflictNotes: [],
    railRuns: [],
    stepRuns: [{ stepId, state: "running", sessionId, reason: null }],
  };
}

function marks(entries: Array<[string, StepAttention]>): Map<string, StepAttention> {
  return new Map(entries);
}

describe("attentionInbox", () => {
  it("is empty when nothing is waiting on anybody", () => {
    const state = inboxState([wsWith("a", [page("p1", ["s1"])])], {
      sessionStatusById: { s1: "working" },
      statusSinceById: { s1: since(5) },
    });
    expect(attentionInbox(input(state), NOW)).toEqual([]);
  });

  // --- the three reasons ---------------------------------------------

  it("lists a session that is asking the human something", () => {
    const state = inboxState([wsWith("a", [page("p1", ["s1"], "Agents")])], {
      sessionStatusById: { s1: "waiting_for_input" },
      statusSinceById: { s1: since(3) },
      sessionNames: { s1: "login flow" },
    });
    const rows = attentionInbox(input(state), NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sessionId: "s1",
      workspaceId: "a",
      workspaceName: "A",
      pageId: "p1",
      pageName: "Agents",
      tabName: "login flow",
      reason: "asking",
      waitedMs: 3 * MINUTE,
      watched: true,
    });
  });

  it("lists a session whose agent broke, carrying its own line about it", () => {
    const state = inboxState([wsWith("a", [page("p1", ["s1"])])], {
      sessionStatusById: { s1: "failed" },
      statusSinceById: { s1: since(9) },
      failureReasonById: { s1: "API Error: 529 Overloaded" },
    });
    const rows = attentionInbox(input(state), NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe("failed");
    expect(rows[0].failureReason).toBe("API Error: 529 Overloaded");
  });

  it("lists a rail step whose agent's turn ended with the card unmoved", () => {
    const state = inboxState([wsWith("a", [page("p1", ["s1"])])], {
      sessionStatusById: { s1: "idle" },
      statusSinceById: { s1: since(12) },
    });
    const rows = attentionInbox(
      input(state, {
        orchestrations: { a: orchRunning("t1", "s1") },
        stepAttentions: { a: marks([["t1", "turn-ended"]]) },
      }),
      NOW
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe("turn-ended");
  });

  // The aged form of the row above. Nothing about the session changed --
  // only how long it has been that way -- so the inbox has to accept it
  // on the same terms or a wait that got worse would drop off the list.
  it("lists a rail step whose turn ended long enough ago to be stale", () => {
    const state = inboxState([wsWith("a", [page("p1", ["s1"])])], {
      sessionStatusById: { s1: "idle" },
      statusSinceById: { s1: since(30) },
    });
    const rows = attentionInbox(
      input(state, {
        orchestrations: { a: orchRunning("t1", "s1") },
        stepAttentions: { a: marks([["t1", "stale"]]) },
      }),
      NOW
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe("stale");
  });

  // The decoy row is the one that does NOT need the session to be quiet:
  // the wrong file is already written, so an agent still talking is no
  // less unable to reach the board.
  it("lists a rail step that edited its worktree's copy, even while working", () => {
    const state = inboxState([wsWith("a", [page("p1", ["s1"])])], {
      sessionStatusById: { s1: "working" },
      statusSinceById: { s1: since(2) },
    });
    const rows = attentionInbox(
      input(state, {
        orchestrations: { a: orchRunning("t1", "s1") },
        stepAttentions: { a: marks([["t1", "decoy-edit"]]) },
      }),
      NOW
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe("decoy-edit");
  });

  // --- what is NOT in it ----------------------------------------------

  // The whole point of the list: a terminal that is merely sitting at
  // its prompt is not waiting on you, it is just open.
  it("leaves an idle shell out", () => {
    const state = inboxState([wsWith("a", [page("p1", ["s1"])])], {
      sessionStatusById: { s1: "idle" },
      statusSinceById: { s1: since(90) },
    });
    expect(attentionInbox(input(state), NOW)).toEqual([]);
  });

  // An idle session only enters on a rail's say-so, so an idle one on a
  // rail whose step is NOT marked stays out too.
  it("leaves an idle rail step with no attention mark out", () => {
    const state = inboxState([wsWith("a", [page("p1", ["s1"])])], {
      sessionStatusById: { s1: "idle" },
      statusSinceById: { s1: since(12) },
    });
    const rows = attentionInbox(
      input(state, {
        orchestrations: { a: orchRunning("t1", "s1") },
        stepAttentions: { a: marks([]) },
      }),
      NOW
    );
    expect(rows).toEqual([]);
  });

  // The daemon's status describes the bare SHELL that replaced the run,
  // exactly as the hub's running column reads it -- believing it would
  // put a session with no agent in it on a list of agents waiting.
  it("leaves an interrupted session out whatever its status says", () => {
    const state = inboxState([wsWith("a", [page("p1", ["s1"])])], {
      sessionStatusById: { s1: "waiting_for_input" },
      statusSinceById: { s1: since(4) },
      interruptedSessionIds: new Set(["s1"]),
    });
    expect(attentionInbox(input(state), NOW)).toEqual([]);
  });

  it("leaves file and board tabs out — no agent stands behind either", () => {
    const state = inboxState([wsWith("a", [page("p1", ["f1", "b1"])])], {
      sessionStatusById: { f1: "waiting_for_input", b1: "failed" },
      statusSinceById: { f1: since(4), b1: since(4) },
      fileTabsById: { f1: { path: "/ws/README.md" } },
      boardTabsById: { b1: { contextFolder: "/ws/.gavin-root" } },
    });
    expect(attentionInbox(input(state), NOW)).toEqual([]);
  });

  // --- ordering --------------------------------------------------------

  it("puts the longest wait first, whatever the reason", () => {
    const state = inboxState(
      [
        wsWith("a", [page("p1", ["short", "long"])]),
        wsWith("b", [page("p2", ["middle"])]),
      ],
      {
        sessionStatusById: {
          short: "waiting_for_input",
          long: "failed",
          middle: "waiting_for_input",
        },
        statusSinceById: { short: since(2), long: since(120), middle: since(30) },
      }
    );
    expect(attentionInbox(input(state), NOW).map((r) => r.sessionId)).toEqual([
      "long",
      "middle",
      "short",
    ]);
  });

  // A session gavin has no stamp for is not "waiting zero minutes" -- it
  // is a wait nobody measured, and sorting it to the top would hand the
  // list's first row to the one thing it knows least about.
  it("sorts a session with no stamp last rather than as a fresh one", () => {
    const state = inboxState([wsWith("a", [page("p1", ["unstamped", "waited"])])], {
      sessionStatusById: { unstamped: "waiting_for_input", waited: "waiting_for_input" },
      statusSinceById: { waited: since(1) },
    });
    const rows = attentionInbox(input(state), NOW);
    expect(rows.map((r) => r.sessionId)).toEqual(["waited", "unstamped"]);
    expect(rows[1].waitedMs).toBeNull();
  });

  // Two sessions stamped in the same millisecond is not information to
  // sort on, so the order falls back to something that does not move as
  // the fleet ticks.
  it("breaks a tie on workspace then tab name", () => {
    const state = inboxState(
      [wsWith("b", [page("p2", ["zulu", "alpha"])]), wsWith("a", [page("p1", ["solo"])])],
      {
        sessionStatusById: {
          zulu: "waiting_for_input",
          alpha: "waiting_for_input",
          solo: "waiting_for_input",
        },
        statusSinceById: { zulu: since(5), alpha: since(5), solo: since(5) },
        sessionNames: { zulu: "zulu", alpha: "alpha", solo: "solo" },
      }
    );
    expect(attentionInbox(input(state), NOW).map((r) => r.sessionId)).toEqual([
      "solo",
      "alpha",
      "zulu",
    ]);
  });

  // A clock that moved backwards is the only way to get one; reporting a
  // negative wait would sort it to the bottom and read as nonsense.
  it("floors a stamp from the future at no wait at all", () => {
    const state = inboxState([wsWith("a", [page("p1", ["s1"])])], {
      sessionStatusById: { s1: "waiting_for_input" },
      statusSinceById: { s1: { at: NOW + 60_000, watched: true } },
    });
    expect(attentionInbox(input(state), NOW)[0].waitedMs).toBe(0);
  });

  // --- what a row says --------------------------------------------------

  it("names the card behind the session, wherever it is filed", () => {
    const state = inboxState([wsWith("a", [page("p1", ["s1"])])], {
      sessionStatusById: { s1: "waiting_for_input" },
      statusSinceById: { s1: since(3) },
    });
    const rows = attentionInbox(
      input(state, {
        boards: { a: boardWith([{ path: CARD, sessionId: "s1" }]) },
        trees: { a: treeWith([planCard("card.md", { title: "Fix the login flow" })]) },
      }),
      NOW
    );
    expect(rows[0].cardTitle).toBe("Fix the login flow");
    expect(rows[0].cardPath).toBe(CARD);
    expect(rows[0].cardWorkspaceId).toBe("a");
  });

  it("falls back to the file name for a card the tree has not seen", () => {
    const state = inboxState([wsWith("a", [page("p1", ["s1"])])], {
      sessionStatusById: { s1: "waiting_for_input" },
      statusSinceById: { s1: since(3) },
    });
    const rows = attentionInbox(
      input(state, { boards: { a: boardWith([{ path: CARD, sessionId: "s1" }]) } }),
      NOW
    );
    expect(rows[0].cardTitle).toBe("card.md");
  });

  it("says so plainly when no card is bound", () => {
    const state = inboxState([wsWith("a", [page("p1", ["s1"])])], {
      sessionStatusById: { s1: "waiting_for_input" },
      statusSinceById: { s1: since(3) },
    });
    const rows = attentionInbox(input(state), NOW);
    expect(rows[0].cardTitle).toBeNull();
    expect(rows[0].cardPath).toBeNull();
  });

  // The same fallback chain the tab bar's own labels use, so a row names
  // a session the way the tab it points at does.
  it("labels a nameless tab by its folder", () => {
    const state = inboxState([wsWith("a", [page("p1", ["s1"])])], {
      sessionStatusById: { s1: "waiting_for_input" },
      statusSinceById: { s1: since(3) },
      cwdBySessionId: { s1: "/Users/me/code/gavin" },
    });
    expect(attentionInbox(input(state), NOW)[0].tabName).toBe("gavin");
  });

  // The main agent panel is a session like any other and can sit waiting
  // on you; it just has no page. A null pageId is what tells the click
  // to land on the Home tab rather than on a terminal.
  it("lists the workspace's own Home agent with no page of its own", () => {
    const state = inboxState([wsWith("a", [page("p1", [])], { mainSessionId: "home1" })], {
      sessionStatusById: { home1: "waiting_for_input" },
      statusSinceById: { home1: since(6) },
    });
    const rows = attentionInbox(input(state), NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0].pageId).toBeNull();
    expect(rows[0].pageName).toBe("Home");
  });

  // A tab dragged to another workspace is still that workspace's tab --
  // the row has to follow the TAB, because that is where the click goes.
  it("files a row under the workspace whose page holds the tab", () => {
    const state = inboxState(
      [wsWith("a", []), wsWith("b", [page("p2", ["s1"], "Agents")])],
      {
        sessionStatusById: { s1: "waiting_for_input" },
        statusSinceById: { s1: since(3) },
      }
    );
    const rows = attentionInbox(
      input(state, {
        boards: { a: boardWith([{ path: CARD, sessionId: "s1" }]) },
        trees: { a: treeWith([planCard("card.md")]) },
      }),
      NOW
    );
    expect(rows[0].workspaceId).toBe("b");
    expect(rows[0].cardWorkspaceId).toBe("a");
  });

  it("never lists one session twice, however many trees hold it", () => {
    const state = inboxState([wsWith("a", [page("p1", ["s1"]), page("p2", ["s1"])])], {
      sessionStatusById: { s1: "waiting_for_input" },
      statusSinceById: { s1: since(3) },
    });
    expect(attentionInbox(input(state), NOW)).toHaveLength(1);
  });

  // `failed` outranks a mark, exactly as ATTENTION_RANK has it: a broken
  // agent is not a rail deciding its turn ended.
  it("calls a broken agent on a marked rail step broken", () => {
    const state = inboxState([wsWith("a", [page("p1", ["s1"])])], {
      sessionStatusById: { s1: "failed" },
      statusSinceById: { s1: since(3) },
    });
    const rows = attentionInbox(
      input(state, {
        orchestrations: { a: orchRunning("t1", "s1") },
        stepAttentions: { a: marks([["t1", "turn-ended"]]) },
      }),
      NOW
    );
    expect(rows[0].reason).toBe("failed");
  });
});

describe("REASON_LABEL", () => {
  // One vocabulary: the inbox must not invent a second wording for the
  // states the hub's running column already names.
  it("reuses the hub's own words for the two states it shares", () => {
    expect(REASON_LABEL.asking).toBe(PHASE_LABEL.waiting);
    expect(REASON_LABEL.failed).toBe(PHASE_LABEL.failed);
  });

  it("has a word of its own for a turn that ended", () => {
    expect(REASON_LABEL["turn-ended"]).toBeTruthy();
    expect(REASON_LABEL["turn-ended"]).not.toBe(REASON_LABEL.asking);
  });
});

describe("waitLabel", () => {
  it("reads as a dash when nothing was measured", () => {
    expect(waitLabel(null, true)).toBe("—");
    expect(waitLabel(null, false)).toBe("—");
  });

  it("steps through the same ladder the hub's ages use", () => {
    expect(waitLabel(0, true)).toBe("just now");
    expect(waitLabel(59 * 1000, true)).toBe("just now");
    expect(waitLabel(MINUTE, true)).toBe("1m");
    expect(waitLabel(59 * MINUTE, true)).toBe("59m");
    expect(waitLabel(60 * MINUTE, true)).toBe("1h");
    expect(waitLabel(23 * 60 * MINUTE, true)).toBe("23h");
    expect(waitLabel(24 * 60 * MINUTE, true)).toBe("1d");
  });

  // A status already in place when gavin attached has no start time --
  // the daemon does not report one -- so the label says how long the app
  // has KNOWN about it and never claims that is how long it has waited.
  it("marks an unwatched wait as a lower bound, not a measurement", () => {
    expect(waitLabel(5 * MINUTE, false)).toBe("≥5m");
    expect(waitLabel(3 * 60 * MINUTE, false)).toBe("≥3h");
  });

  it("says an unwatched wait began at launch while it is still under a minute", () => {
    expect(waitLabel(0, false)).toBe("since launch");
    expect(waitLabel(59 * 1000, false)).toBe("since launch");
  });
});

describe("rowTip", () => {
  function aRow(overrides: Partial<AttentionRow> = {}): AttentionRow {
    return {
      sessionId: "s1",
      workspaceId: "a",
      workspaceName: "Gavin",
      pageId: "p1",
      pageName: "Agents",
      tabName: "login flow",
      reason: "asking",
      cardTitle: null,
      cardPath: null,
      cardWorkspaceId: null,
      waitedMs: 12 * MINUTE,
      watched: true,
      failureReason: null,
      ...overrides,
    };
  }

  it("leads with the reason and the wait, then where the session is", () => {
    const tip = rowTip(aRow());
    expect(tip.startsWith(`${REASON_LABEL.asking} · 12m`)).toBe(true);
    expect(tip).toContain("Gavin · Agents · login flow");
  });

  it("names the card when one is bound and says nothing when none is", () => {
    expect(rowTip(aRow({ cardTitle: "Fix the login flow" }))).toContain("Fix the login flow");
    expect(rowTip(aRow())).not.toContain("—  —");
  });

  it("carries the agent's own line about what broke", () => {
    const tip = rowTip(aRow({ reason: "failed", failureReason: "API Error: 529 Overloaded" }));
    expect(tip).toContain("API Error: 529 Overloaded");
  });

  // A wait gavin did not watch begin has to say so somewhere, and the
  // "≥" in the column is a mark, not a sentence.
  it("explains a lower-bound wait rather than leaving the ≥ unexplained", () => {
    expect(rowTip(aRow({ watched: false }))).toContain("attached");
    expect(rowTip(aRow({ watched: true }))).not.toContain("attached");
  });

  // The two clicks land in different places, so the bubble must not
  // promise the one it is not making.
  it("says which jump the click makes", () => {
    expect(rowTip(aRow())).toContain("open the session");
    expect(rowTip(aRow({ pageId: null, pageName: "Home" }))).toContain("open the Home tab");
  });
});
