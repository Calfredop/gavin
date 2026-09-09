import { describe, expect, it } from "vitest";
import {
  IDLE_GRACE_MS,
  RECLAIMED_CLAUSE_WINDOW_MS,
  RECLAIM_SPACING_MS,
  heldRailCount,
  mayReclaim,
  reclaimCandidates,
  reclaimNoticeBody,
  reclaimNowLabel,
  reclaimNowPrompt,
  reclaimTrigger,
  reclaimedClause,
  type ReclaimCandidate,
  type ReclaimInput,
  type ReclaimRecord,
  type ReclaimState,
} from "$lib/sessions/doneSessionReclaim";
import { DEFAULT_LAUNCH } from "$lib/agents/launchGate";
import type { Board } from "$lib/board/kanban";
import type { GavinTree, PlanFileInfo } from "$lib/core/gavin";
import type { Orchestration } from "$lib/orchestration/orchestration";
import type { Workspace } from "$lib/core/workspace";

const GB = 1024 ** 3;
const NOW = 10_000_000;
/// Long enough ago that every grace has been served.
const LONG_AGO = NOW - IDLE_GRACE_MS - 1;

function plan(overrides: Partial<PlanFileInfo> & { path: string }): PlanFileInfo {
  const fileName = overrides.path.split("/").pop()!;
  return {
    fileName,
    title: fileName.replace(/\.md$/, ""),
    status: null,
    priority: null,
    order: null,
    kind: "task",
    parent: null,
    labels: [],
    checklistDone: 0,
    checklistTotal: 0,
    parseWarning: false,
    modifiedAt: Math.floor(LONG_AGO / 1000),
    ...overrides,
  };
}

const ROOT = "/repo/.gavin-root";
const PLANS = `${ROOT}/plans`;

function tree(plans: PlanFileInfo[]): GavinTree {
  return {
    rootPath: "/repo",
    rootMissing: false,
    contexts: [
      {
        folderPath: ROOT,
        kind: "root",
        name: "root",
        plans,
        docs: [],
        specs: [],
        hasPrd: true,
        configWarning: false,
      },
    ],
  };
}

const BOARD_COLUMNS = [
  { id: "todo", name: "To Do", position: 0 },
  { id: "doing", name: "In Progress", position: 1 },
  { id: "done", name: "Done", position: 2 },
];

function board(cardSessions: Array<[string, string]>): Board {
  return {
    columns: BOARD_COLUMNS,
    labels: [],
    cardSessions: cardSessions.map(([path, sessionId]) => ({
      path,
      sessionId,
      cwd: "/repo",
      command: "claude",
    })),
  };
}

function workspace(
  tabs: string[],
  overrides: Partial<Workspace> & { pinned?: string[] } = {}
): Workspace {
  const { pinned, ...rest } = overrides;
  return {
    id: "ws",
    name: "repo",
    rootPath: "/repo",
    pages: [
      {
        id: "pg",
        name: "Agents",
        layout: { type: "leaf", tabs, activeTabIndex: 0, ...(pinned ? { pinned } : {}) },
        focusedSessionId: null,
      },
    ],
    activePageId: "pg",
    ...rest,
  } as Workspace;
}

/// The default fixture: a workspace whose Agents page holds four agent
/// tabs, each bound to a card. Only `s-done` should qualify.
function fixture(overrides: Partial<ReclaimInput> = {}): ReclaimInput {
  const state: ReclaimState = {
    workspaces: [workspace(["s-done", "s-doing", "s-busy", "s-asking"])],
    activeWorkspaceId: "ws",
    sessionStatusById: {
      "s-done": "idle",
      "s-doing": "idle",
      "s-busy": "working",
      "s-asking": "waiting_for_input",
    },
    statusSinceById: {
      "s-done": { at: LONG_AGO, watched: true },
      "s-doing": { at: LONG_AGO, watched: true },
      "s-busy": { at: LONG_AGO, watched: true },
      "s-asking": { at: LONG_AGO, watched: true },
    },
    sessionNames: { "s-done": "finished run" },
    cwdBySessionId: {},
  };
  return {
    state,
    boards: {
      ws: board([
        [`${PLANS}/done/a.md`, "s-done"],
        [`${PLANS}/b.md`, "s-doing"],
        [`${PLANS}/done/c.md`, "s-busy"],
        [`${PLANS}/done/d.md`, "s-asking"],
      ]),
    },
    trees: {
      ws: tree([
        plan({ path: `${PLANS}/done/a.md`, title: "Card A", status: "Done" }),
        plan({ path: `${PLANS}/b.md`, title: "Card B", status: "In Progress" }),
        plan({ path: `${PLANS}/done/c.md`, title: "Card C", status: "Done" }),
        plan({ path: `${PLANS}/done/d.md`, title: "Card D", status: "Done" }),
      ]),
    },
    agents: {
      "s-done": { rssBytes: 2 * GB },
      "s-doing": { rssBytes: 2 * GB },
      "s-busy": { rssBytes: 2 * GB },
      "s-asking": { rssBytes: 2 * GB },
    },
    nowMs: NOW,
    ...overrides,
  };
}

function ids(input: ReclaimInput): string[] {
  return reclaimCandidates(input).map((c) => c.sessionId);
}

describe("reclaimCandidates", () => {
  it("names the idle agent of a done card, and nothing that is still busy or unfinished", () => {
    const [only, ...rest] = reclaimCandidates(fixture());
    expect(rest).toEqual([]);
    expect(only).toMatchObject({
      sessionId: "s-done",
      workspaceId: "ws",
      cardPath: `${PLANS}/done/a.md`,
      cardTitle: "Card A",
      label: "finished run",
      rssBytes: 2 * GB,
    });
    // Quiet since the later of the status stamp and the card's write.
    expect(only.quietSinceMs).toBe(Math.max(LONG_AGO, Math.floor(LONG_AGO / 1000) * 1000));
  });

  it("reads the done column through effectiveStatus, so a nested task follows its plan", () => {
    const input = fixture({
      boards: {
        ws: board([
          [`${PLANS}/done/child-of-done.md`, "s-done"],
          [`${PLANS}/child-of-live.md`, "s-doing"],
        ]),
      },
      trees: {
        ws: tree([
          plan({ path: `${PLANS}/done/parent.md`, kind: "plan", status: "Done" }),
          plan({ path: `${PLANS}/live.md`, kind: "plan", status: "In Progress" }),
          // No status of their own: each is drawn inside its parent.
          plan({ path: `${PLANS}/done/child-of-done.md`, parent: "parent.md" }),
          plan({ path: `${PLANS}/child-of-live.md`, parent: "live.md" }),
        ]),
      },
    });
    expect(ids(input)).toEqual(["s-done"]);
  });

  it("never touches a session the daemon is not holding as an agent", () => {
    const input = fixture();
    delete input.agents["s-done"];
    expect(ids(input)).toEqual([]);
  });

  it("spares a pinned tab, the workspace's main agent, and a session on no page", () => {
    const pinned = fixture();
    pinned.state.workspaces = [workspace(["s-done", "s-doing", "s-busy", "s-asking"], { pinned: ["s-done"] })];
    expect(ids(pinned)).toEqual([]);

    const main = fixture();
    main.state.workspaces = [
      workspace(["s-doing", "s-busy", "s-asking"], { mainSessionId: "s-done" }),
    ];
    expect(ids(main)).toEqual([]);

    const hidden = fixture();
    hidden.state.workspaces = [workspace(["s-doing", "s-busy", "s-asking"])];
    expect(ids(hidden)).toEqual([]);
  });

  it("waits out the grace on both the session's status and the card's write", () => {
    const freshStatus = fixture();
    freshStatus.state.statusSinceById["s-done"] = { at: NOW - 1000, watched: true };
    expect(ids(freshStatus)).toEqual([]);

    const freshCard = fixture();
    freshCard.trees.ws!.contexts[0].plans[0].modifiedAt = Math.floor((NOW - 1000) / 1000);
    expect(ids(freshCard)).toEqual([]);

    // The manual close passes zero: the human looking at the tabs is
    // the grace period.
    expect(ids({ ...freshCard, graceMs: 0 })).toEqual(["s-done"]);
  });

  it("skips a session gavin has never seen a status for", () => {
    const input = fixture();
    delete input.state.statusSinceById["s-done"];
    expect(ids(input)).toEqual([]);
  });

  it("treats a failed or unknown status as idle, the way the recap does", () => {
    const input = fixture();
    input.state.sessionStatusById["s-done"] = "failed";
    expect(ids(input)).toEqual(["s-done"]);
    delete input.state.sessionStatusById["s-done"];
    expect(ids(input)).toEqual(["s-done"]);
  });

  it("orders the biggest first, unmeasured rows last, and lists a twice-bound session once", () => {
    const input = fixture({
      boards: {
        ws: board([
          [`${PLANS}/done/a.md`, "s-small"],
          [`${PLANS}/done/a.md`, "s-big"],
          [`${PLANS}/done/c.md`, "s-big"],
          [`${PLANS}/done/d.md`, "s-unmeasured"],
        ]),
      },
      agents: {
        "s-small": { rssBytes: 1 * GB },
        "s-big": { rssBytes: 5 * GB },
        "s-unmeasured": { rssBytes: 0 },
      },
    });
    input.state.workspaces = [workspace(["s-small", "s-big", "s-unmeasured"])];
    input.state.sessionStatusById = { "s-small": "idle", "s-big": "idle", "s-unmeasured": "idle" };
    input.state.statusSinceById = {
      "s-small": { at: LONG_AGO, watched: true },
      "s-big": { at: LONG_AGO, watched: true },
      "s-unmeasured": { at: LONG_AGO, watched: true },
    };
    expect(ids(input)).toEqual(["s-big", "s-small", "s-unmeasured"]);
  });

  it("yields nothing for a workspace with no board, no tree or no columns", () => {
    expect(ids(fixture({ boards: {} }))).toEqual([]);
    expect(ids(fixture({ trees: {} }))).toEqual([]);
    const noColumns = fixture();
    noColumns.boards.ws = { ...noColumns.boards.ws!, columns: [] };
    expect(ids(noColumns)).toEqual([]);
  });
});

describe("reclaimTrigger", () => {
  const base = { config: DEFAULT_LAUNCH, queued: 0, railsHeld: 0 };

  it("fires at critical pressure whether or not anything is waiting", () => {
    expect(reclaimTrigger({ ...base, pressure: "critical" })).toBe("critical");
    expect(reclaimTrigger({ ...base, pressure: "critical", queued: 3 })).toBe("critical");
  });

  it("fires at warn pressure only when work is held behind it", () => {
    expect(reclaimTrigger({ ...base, pressure: "warn" })).toBeNull();
    expect(reclaimTrigger({ ...base, pressure: "warn", queued: 1 })).toBe("blocking");
    expect(reclaimTrigger({ ...base, pressure: "warn", railsHeld: 1 })).toBe("blocking");
  });

  it("never fires at normal pressure, and never with the switch off", () => {
    expect(reclaimTrigger({ ...base, pressure: "normal", queued: 5, railsHeld: 2 })).toBeNull();
    const off = { ...DEFAULT_LAUNCH, reclaimDoneSessions: false };
    expect(reclaimTrigger({ ...base, config: off, pressure: "critical" })).toBeNull();
  });
});

describe("heldRailCount", () => {
  function orch(overrides: Partial<Orchestration> = {}): Orchestration {
    return {
      rails: [
        {
          id: "r1",
          name: "Rail",
          position: 0,
          worktreePath: null,
          stages: [
            { id: "st1", position: 0, steps: [{ id: "a", position: 0, cardPath: "/a.md" }] },
            { id: "st2", position: 1, steps: [{ id: "b", position: 0, cardPath: "/b.md" }] },
          ],
        } as Orchestration["rails"][number],
      ],
      conflictNotes: [],
      railRuns: [{ railId: "r1", state: "running", currentStageId: "st1" }],
      stepRuns: [],
      ...overrides,
    };
  }

  it("counts a running rail whose current stage still has a pending step", () => {
    expect(heldRailCount({ ws: orch() }, false)).toBe(1);
  });

  it("is zero while launches are allowed, for an idle rail, and for a stage the rail is not on", () => {
    expect(heldRailCount({ ws: orch() }, true)).toBe(0);
    expect(heldRailCount({ ws: orch({ railRuns: [] }) }, false)).toBe(0);
    // The current stage's step already running: the pending one is a
    // stage away, waiting on the rail rather than on memory.
    const later = orch({
      stepRuns: [{ stepId: "a", state: "running", sessionId: "s", reason: null }],
    });
    expect(heldRailCount({ ws: later }, false)).toBe(0);
    expect(heldRailCount({ ws: undefined }, false)).toBe(0);
  });
});

describe("mayReclaim", () => {
  it("allows the first close, then waits for the sample or the spacing", () => {
    expect(mayReclaim({ lastReclaimMs: null, nowMs: NOW, lastReclaimObserved: false })).toBe(true);
    expect(mayReclaim({ lastReclaimMs: NOW - 1000, nowMs: NOW, lastReclaimObserved: false })).toBe(false);
    expect(mayReclaim({ lastReclaimMs: NOW - 1000, nowMs: NOW, lastReclaimObserved: true })).toBe(true);
    expect(
      mayReclaim({ lastReclaimMs: NOW - RECLAIM_SPACING_MS, nowMs: NOW, lastReclaimObserved: false })
    ).toBe(true);
  });
});

describe("the words", () => {
  const record = (overrides: Partial<ReclaimRecord> = {}): ReclaimRecord => ({
    sessionId: "s",
    label: "finished run",
    cardTitle: "Card A",
    rssBytes: 2 * GB,
    atMs: NOW,
    reason: "critical",
    ...overrides,
  });

  it("names a lone close, counts a burst, and says which trigger it was", () => {
    expect(reclaimNoticeBody([record()])).toBe(
      'Closed idle agent "finished run" of done card "Card A" to free 2 GB — memory was critical.'
    );
    expect(
      reclaimNoticeBody([record({ reason: "blocking" }), record({ sessionId: "t", rssBytes: 1.5 * GB, reason: "blocking" })])
    ).toBe("Closed 2 idle agents of done cards to free 3.5 GB — launches were held for memory.");
    // A burst with one critical close in it was a critical burst.
    expect(reclaimNoticeBody([record({ reason: "blocking" }), record({ sessionId: "t" })])).toContain(
      "memory was critical"
    );
  });

  it("leaves the figure out rather than printing a zero nobody measured", () => {
    expect(reclaimNoticeBody([record({ rssBytes: 0 })])).toBe(
      'Closed idle agent "finished run" of done card "Card A" — memory was critical.'
    );
  });

  it("mentions recent closes on the banner and forgets old ones", () => {
    const old = record({ atMs: NOW - RECLAIMED_CLAUSE_WINDOW_MS - 1 });
    expect(reclaimedClause([old], NOW)).toBeNull();
    expect(reclaimedClause([record(), record({ sessionId: "t", rssBytes: 0 })], NOW)).toBe(
      "Closed 2 idle agents of done cards (2 GB)."
    );
    expect(reclaimedClause([record({ rssBytes: 0 })], NOW)).toBe("Closed 1 idle agent of done cards.");
  });

  const candidate = (overrides: Partial<ReclaimCandidate> = {}): ReclaimCandidate => ({
    sessionId: "s",
    workspaceId: "ws",
    cardPath: `${PLANS}/done/a.md`,
    cardTitle: "Card A",
    label: "finished run",
    rssBytes: 2 * GB,
    quietSinceMs: LONG_AGO,
    ...overrides,
  });

  it("offers the manual close only when there is something to close", () => {
    expect(reclaimNowLabel([])).toBeNull();
    expect(reclaimNowLabel([candidate()])).toBe("Close 1 agent of done cards");
    expect(reclaimNowLabel([candidate(), candidate({ sessionId: "t" })])).toBe("Close 2 agents of done cards");
  });

  it("asks with every session named, the cost, and what stays possible", () => {
    const prompt = reclaimNowPrompt([candidate(), candidate({ sessionId: "t", label: "other", cardTitle: "Card B", rssBytes: 0 })]);
    expect(prompt.title).toBe("Close 2 idle agents of done cards?");
    expect(prompt.confirmLabel).toBe("Close 2 sessions");
    expect(prompt.danger).toBe(true);
    expect(prompt.lines).toEqual([
      "Ends 2 terminal sessions, freeing about 2 GB.",
      "finished run — Card A",
      "other — Card B",
      "Idle means the agent is neither working nor waiting on you, and its card is already done.",
      'Each card keeps its binding, so "Re-launch agent" can bring one back.',
    ]);
    expect(reclaimNowPrompt([candidate({ rssBytes: 0 })]).lines[0]).toBe("Ends 1 terminal session.");
  });
});
