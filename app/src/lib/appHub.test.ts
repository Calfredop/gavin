import { describe, it, expect } from "vitest";
import {
  recentWorkspaces,
  relativeTime,
  appLinks,
  workspaceRecapLine,
  runningTasks,
  runningTaskCount,
  fleetSummary,
  APP_LINKS,
  APP_VERSION,
  type AppLink,
  type FleetInput,
  type FleetState,
  type WorkspaceRunning,
} from "./appHub";
import type { WorkspaceAgentsSummary } from "./sidebarSummary";
import { UNFILED_WORKSPACE_ID, type Page, type Workspace } from "./workspace";
import type { LayoutNode } from "./layout";
import type { Board } from "./kanban";
import type { GavinContext, GavinTree, PlanFileInfo } from "./gavin";
import type { Orchestration } from "./orchestration";

function ws(id: string, lastActiveAt?: number): Workspace {
  return { id, name: id.toUpperCase(), pages: [], activePageId: null, lastActiveAt };
}

describe("recentWorkspaces", () => {
  it("orders stamped workspaces newest first", () => {
    const list = [ws("a", 100), ws("b", 300), ws("c", 200)];
    expect(recentWorkspaces(list).map((w) => w.id)).toEqual(["b", "c", "a"]);
  });

  it("puts never-switched workspaces after every stamped one", () => {
    const list = [ws("never1"), ws("a", 100), ws("never2"), ws("b", 300)];
    expect(recentWorkspaces(list).map((w) => w.id)).toEqual(["b", "a", "never1", "never2"]);
  });

  it("keeps never-switched workspaces in sidebar order, Scratchpad pinned first", () => {
    const list = [ws("a"), ws(UNFILED_WORKSPACE_ID), ws("b")];
    expect(recentWorkspaces(list).map((w) => w.id)).toEqual([UNFILED_WORKSPACE_ID, "a", "b"]);
  });

  it("breaks a tie on sidebar order rather than on array order", () => {
    // Both stamped at 100; sidebarWorkspaceOrder pins the Scratchpad
    // ahead of "a" even though it comes second in the input.
    const list = [ws("a", 100), ws(UNFILED_WORKSPACE_ID, 100)];
    expect(recentWorkspaces(list).map((w) => w.id)).toEqual([UNFILED_WORKSPACE_ID, "a"]);
  });

  it("treats the Scratchpad as an ordinary recent once it has been used", () => {
    const list = [ws(UNFILED_WORKSPACE_ID, 100), ws("a", 300)];
    expect(recentWorkspaces(list).map((w) => w.id)).toEqual(["a", UNFILED_WORKSPACE_ID]);
  });

  it("does not mutate the array it was given", () => {
    const list = [ws("a", 100), ws("b", 300)];
    recentWorkspaces(list);
    expect(list.map((w) => w.id)).toEqual(["a", "b"]);
  });

  it("is empty for an empty list", () => {
    expect(recentWorkspaces([])).toEqual([]);
  });
});

describe("relativeTime", () => {
  const now = 10 * 24 * 60 * 60 * 1000; // day 10, so every unit has room below it

  it("reads never for a workspace that has no stamp", () => {
    expect(relativeTime(undefined, now)).toBe("never");
    expect(relativeTime(null, now)).toBe("never");
  });

  it("reads never for a stamp in the future rather than inventing a countdown", () => {
    expect(relativeTime(now + 60_000, now)).toBe("never");
  });

  it("reads just now below a minute, including the same millisecond", () => {
    expect(relativeTime(now, now)).toBe("just now");
    expect(relativeTime(now - 59_000, now)).toBe("just now");
  });

  it("steps to minutes, hours, days and weeks at each boundary", () => {
    expect(relativeTime(now - 60_000, now)).toBe("1m ago");
    expect(relativeTime(now - 59 * 60_000, now)).toBe("59m ago");
    expect(relativeTime(now - 60 * 60_000, now)).toBe("1h ago");
    expect(relativeTime(now - 23 * 60 * 60_000, now)).toBe("23h ago");
    expect(relativeTime(now - 24 * 60 * 60_000, now)).toBe("1d ago");
    expect(relativeTime(now - 6 * 24 * 60 * 60_000, now)).toBe("6d ago");
    expect(relativeTime(now - 7 * 24 * 60 * 60_000, now)).toBe("1w ago");
  });

  it("keeps counting in weeks rather than growing a new unit", () => {
    expect(relativeTime(0, 60 * 7 * 24 * 60 * 60_000)).toBe("60w ago");
  });
});

describe("appLinks", () => {
  it("omits a link whose url is null", () => {
    const links: AppLink[] = [
      { id: "a", label: "A", url: "https://example.com" },
      { id: "b", label: "B", url: null },
    ];
    expect(appLinks(links).map((l) => l.id)).toEqual(["a"]);
  });

  it("renders the repo and issue links and holds the website back", () => {
    expect(appLinks().map((l) => l.id)).toEqual(["repo", "issues"]);
  });

  it("ships no link that points nowhere", () => {
    for (const link of appLinks()) {
      expect(link.url).toMatch(/^https:\/\//);
    }
  });

  it("keeps a website slot for the day there is a site", () => {
    expect(APP_LINKS.some((l) => l.id === "website")).toBe(true);
  });
});

describe("workspaceRecapLine", () => {
  function summary(over: Partial<WorkspaceAgentsSummary> = {}): WorkspaceAgentsSummary {
    return { pages: 0, tabs: 0, agents: 0, running: 0, waiting: 0, idle: 0, ...over };
  }

  it("leads with what is happening, then how big the workspace is", () => {
    expect(workspaceRecapLine(summary({ running: 2, pages: 4 }))).toBe("2 running · 4 pages");
  });

  it("gives waiting agents their own phrase, after running", () => {
    expect(workspaceRecapLine(summary({ running: 1, waiting: 3, pages: 2 }))).toBe(
      "1 running · 3 waiting · 2 pages"
    );
  });

  it("says nothing about a bucket that is empty", () => {
    expect(workspaceRecapLine(summary({ pages: 3 }))).toBe("3 pages");
    expect(workspaceRecapLine(summary({ waiting: 1, pages: 1 }))).toBe("1 waiting · 1 page");
  });

  it("singularises one page", () => {
    expect(workspaceRecapLine(summary({ pages: 1 }))).toBe("1 page");
  });

  it("says so when a workspace has no pages at all", () => {
    expect(workspaceRecapLine(summary())).toBe("no pages");
    expect(workspaceRecapLine(summary({ running: 1 }))).toBe("1 running · no pages");
  });
});

describe("APP_VERSION", () => {
  it("is the package version, not a placeholder", () => {
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});

// --- the fleet: running tasks and the stats strip ---------------------

function leaf(tabs: string[]): LayoutNode {
  return { type: "leaf", tabs, activeTabIndex: 0 };
}

function page(id: string, tabs: string[], name = id): Page {
  return { id, name, layout: leaf(tabs), focusedSessionId: null };
}

function wsWith(id: string, pages: Page[], overrides: Partial<Workspace> = {}): Workspace {
  return { id, name: id.toUpperCase(), pages, activePageId: pages[0]?.id ?? null, ...overrides };
}

function fleetState(workspaces: Workspace[], overrides: Partial<FleetState> = {}): FleetState {
  return {
    workspaces,
    activeWorkspaceId: workspaces[0]?.id ?? null,
    sessionStatusById: {},
    fileTabsById: {},
    boardTabsById: {},
    gitStatusById: {},
    interruptedSessionIds: new Set(),
    ...overrides,
  };
}

function boardWith(cardSessions: Array<{ path: string; sessionId: string }>, names = ["To Do", "In Progress", "Done"]): Board {
  return {
    columns: names.map((name, position) => ({ id: `c${position}`, name, position })),
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

function input(state: FleetState, overrides: Partial<FleetInput> = {}): FleetInput {
  return { state, boards: {}, trees: {}, orchestrations: {}, ...overrides };
}

const CARD = "/ws/.gavin-root/plans/card.md";

describe("runningTasks", () => {
  it("has nothing to say about a fleet with no bindings", () => {
    const state = fleetState([wsWith("a", [page("p1", ["s1"])])]);
    expect(runningTasks(input(state))).toEqual([]);
  });

  it("reports a bound live session as a running task", () => {
    const state = fleetState([wsWith("a", [page("p1", ["s1"], "Agents")])], {
      sessionStatusById: { s1: "working" },
    });
    const groups = runningTasks(
      input(state, {
        boards: { a: boardWith([{ path: CARD, sessionId: "s1" }]) },
        trees: { a: treeWith([planCard("card.md", { title: "Fix the login flow" })]) },
      })
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].workspaceId).toBe("a");
    expect(groups[0].tasks).toEqual([
      {
        workspaceId: "a",
        sessionId: "s1",
        path: CARD,
        title: "Fix the login flow",
        cardStatus: "In Progress",
        phase: "working",
        pageId: "p1",
        pageName: "Agents",
        pageWorkspaceId: "a",
        view: "kanban",
      },
    ]);
  });

  it("drops a binding whose session has exited", () => {
    // No tree holds "gone", so the binding outlived its session.
    const state = fleetState([wsWith("a", [page("p1", ["s1"])])]);
    const groups = runningTasks(
      input(state, { boards: { a: boardWith([{ path: CARD, sessionId: "gone" }]) } })
    );
    expect(groups).toEqual([]);
  });

  it("calls a run the daemon replaced with a bare shell interrupted, not idle", () => {
    const state = fleetState([wsWith("a", [page("p1", ["s1"])])], {
      // The daemon's status describes the SHELL, not the agent that was
      // there -- reading it would report a stopped run as working.
      sessionStatusById: { s1: "working" },
      interruptedSessionIds: new Set(["s1"]),
    });
    const groups = runningTasks(
      input(state, { boards: { a: boardWith([{ path: CARD, sessionId: "s1" }]) } })
    );
    expect(groups[0].tasks[0].phase).toBe("interrupted");
  });

  it("falls back to the file name when the tree has not seen the card", () => {
    const state = fleetState([wsWith("a", [page("p1", ["s1"])])]);
    const groups = runningTasks(
      input(state, { boards: { a: boardWith([{ path: CARD, sessionId: "s1" }]) } })
    );
    expect(groups[0].tasks[0].title).toBe("card.md");
    expect(groups[0].tasks[0].cardStatus).toBeNull();
  });

  it("reads a nested task's status off its parent", () => {
    const state = fleetState([wsWith("a", [page("p1", ["s1"])])]);
    const groups = runningTasks(
      input(state, {
        boards: { a: boardWith([{ path: "/ws/.gavin-root/plans/step.md", sessionId: "s1" }]) },
        trees: {
          a: treeWith([
            planCard("parent.md", { status: "Done" }),
            planCard("step.md", { kind: "task", status: null, parent: "parent.md" }),
          ]),
        },
      })
    );
    expect(groups[0].tasks[0].cardStatus).toBe("Done");
  });

  it("points a card that sits on a rail at the Orchestration tab", () => {
    const state = fleetState([wsWith("a", [page("p1", ["s1"])])]);
    const orch: Orchestration = {
      rails: [
        {
          id: "r1",
          name: "R",
          position: 0,
          worktreePath: null,
          pageId: null,
          stages: [{ id: "st1", position: 0, steps: [{ id: "t1", position: 0, cardPath: CARD }] }],
        },
      ],
      conflictNotes: [],
      railRuns: [],
      stepRuns: [],
    };
    const groups = runningTasks(
      input(state, {
        boards: { a: boardWith([{ path: CARD, sessionId: "s1" }]) },
        orchestrations: { a: orch },
      })
    );
    expect(groups[0].tasks[0].view).toBe("orchestration");
  });

  it("orders what needs a human first, then by title", () => {
    const state = fleetState([wsWith("a", [page("p1", ["s1", "s2", "s3", "s4"])])], {
      sessionStatusById: { s1: "idle", s2: "working", s3: "waiting_for_input", s4: "working" },
      interruptedSessionIds: new Set(),
    });
    const groups = runningTasks(
      input(state, {
        boards: {
          a: boardWith([
            { path: "/ws/.gavin-root/plans/d.md", sessionId: "s1" },
            { path: "/ws/.gavin-root/plans/c.md", sessionId: "s2" },
            { path: "/ws/.gavin-root/plans/a.md", sessionId: "s3" },
            { path: "/ws/.gavin-root/plans/b.md", sessionId: "s4" },
          ]),
        },
      })
    );
    expect(groups[0].tasks.map((t) => t.title)).toEqual(["a.md", "b.md", "c.md", "d.md"]);
    expect(groups[0].tasks.map((t) => t.phase)).toEqual(["waiting", "working", "working", "idle"]);
  });

  it("groups by workspace in the hub's own recents order", () => {
    const state = fleetState(
      [
        wsWith("old", [page("p1", ["s1"])], { lastActiveAt: 100 }),
        wsWith("new", [page("p2", ["s2"])], { lastActiveAt: 300 }),
      ],
      { sessionStatusById: { s1: "working", s2: "working" } }
    );
    const groups = runningTasks(
      input(state, {
        boards: {
          old: boardWith([{ path: CARD, sessionId: "s1" }]),
          new: boardWith([{ path: CARD, sessionId: "s2" }]),
        },
      })
    );
    expect(groups.map((g) => g.workspaceId)).toEqual(["new", "old"]);
  });

  it("counts a busy agent with no card as a loose agent", () => {
    const state = fleetState([wsWith("a", [page("p1", ["s1", "s2"])])], {
      sessionStatusById: { s1: "working", s2: "waiting_for_input" },
    });
    const groups = runningTasks(input(state));
    expect(groups).toHaveLength(1);
    expect(groups[0].tasks).toEqual([]);
    expect(groups[0].looseAgents).toBe(2);
  });

  it("does not count a quiet terminal, or a file or board tab, as a loose agent", () => {
    const state = fleetState([wsWith("a", [page("p1", ["s1", "f1", "b1"])])], {
      sessionStatusById: { s1: "idle", f1: "working", b1: "working" },
      fileTabsById: { f1: { path: "/x.md" } },
      boardTabsById: { b1: {} },
    });
    expect(runningTasks(input(state))).toEqual([]);
  });

  it("does not count a card's own agent twice as a loose one", () => {
    const state = fleetState([wsWith("a", [page("p1", ["s1"])])], {
      sessionStatusById: { s1: "working" },
    });
    const groups = runningTasks(
      input(state, { boards: { a: boardWith([{ path: CARD, sessionId: "s1" }]) } })
    );
    expect(groups[0].looseAgents).toBe(0);
  });

  it("finds the page a bound tab was dragged to", () => {
    const state = fleetState([wsWith("a", [page("p1", []), page("p2", ["s1"], "Second")])], {
      sessionStatusById: { s1: "working" },
    });
    const groups = runningTasks(
      input(state, { boards: { a: boardWith([{ path: CARD, sessionId: "s1" }]) } })
    );
    expect(groups[0].tasks[0].pageName).toBe("Second");
  });
});

describe("runningTaskCount", () => {
  it("adds up the tasks, never the loose agents", () => {
    const groups = [
      { workspaceId: "a", name: "A", tasks: [{}, {}], looseAgents: 3 },
      { workspaceId: "b", name: "B", tasks: [{}], looseAgents: 0 },
    ] as unknown as WorkspaceRunning[];
    expect(runningTaskCount(groups)).toBe(3);
  });
});

describe("fleetSummary", () => {
  it("is all zeros for an empty fleet", () => {
    const summary = fleetSummary(input(fleetState([])));
    expect(summary.workspaces).toBe(0);
    expect(summary.rooted).toBe(0);
    expect(summary.tasks).toBe(0);
    expect(summary.cards.columns).toEqual([]);
    expect(summary.git.repoCount).toBe(0);
  });

  it("counts rooted workspaces apart from the whole fleet", () => {
    const state = fleetState([
      wsWith("a", [], { rootPath: "/ws" }),
      wsWith("b", []),
    ]);
    const summary = fleetSummary(input(state));
    expect(summary.workspaces).toBe(2);
    expect(summary.rooted).toBe(1);
  });

  it("sums agents and pages over every workspace", () => {
    const state = fleetState(
      [
        wsWith("a", [page("p1", ["s1", "s2"])]),
        wsWith("b", [page("p2", ["s3"]), page("p3", [])]),
      ],
      { sessionStatusById: { s1: "working", s2: "waiting_for_input", s3: "idle" } }
    );
    const summary = fleetSummary(input(state));
    expect(summary.agents).toEqual({ pages: 3, tabs: 3, agents: 3, running: 1, waiting: 1, idle: 1 });
  });

  it("counts one checkout shared by two workspaces once", () => {
    const state = fleetState(
      [wsWith("a", [page("p1", ["s1"])]), wsWith("b", [page("p2", ["s2"])])],
      {
        gitStatusById: {
          s1: { repoRoot: "/repo", branch: "main", dirty: true, ahead: 2, behind: 0, hasUpstream: true },
          s2: { repoRoot: "/repo", branch: "main", dirty: true, ahead: 2, behind: 0, hasUpstream: true },
        },
      }
    );
    const summary = fleetSummary(input(state));
    expect(summary.git).toEqual({ repoCount: 1, dirtyCount: 1, ahead: 2, behind: 0, committing: false });
  });

  it("raises the committing flag when any workspace has a run in flight", () => {
    const state = fleetState([wsWith("a", [])]);
    expect(fleetSummary(input(state, { committing: new Set(["a"]) })).git.committing).toBe(true);
    expect(fleetSummary(input(state, { committing: new Set() })).git.committing).toBe(false);
  });

  it("merges two boards' columns by slug, keeping first-appearance order", () => {
    const state = fleetState([wsWith("a", []), wsWith("b", [])]);
    const summary = fleetSummary(
      input(state, {
        boards: { a: boardWith([], ["To Do", "In Progress", "Done"]), b: boardWith([], ["to do", "Blocked", "Done"]) },
        trees: {
          a: treeWith([planCard("x.md", { status: "To Do" }), planCard("y.md", { status: "Done" })]),
          b: treeWith([planCard("z.md", { status: "to do" }), planCard("w.md", { status: "Blocked" })]),
        },
      })
    );
    expect(summary.cards.columns).toEqual([
      { name: "To Do", count: 2 },
      { name: "In Progress", count: 0 },
      { name: "Done", count: 1 },
      { name: "Blocked", count: 1 },
    ]);
    expect(summary.cards.total).toBe(4);
    expect(summary.cards.todo).toBe(2);
    expect(summary.cards.done).toBe(1);
    expect(summary.cards.inProgress).toBe(1);
  });

  it("sums rails by phase across the fleet, attention included", () => {
    const railed = (id: string, running: boolean): Orchestration => ({
      rails: [
        {
          id,
          name: id,
          position: 0,
          worktreePath: null,
          pageId: null,
          stages: [{ id: `${id}-s`, position: 0, steps: [{ id: `${id}-t`, position: 0, cardPath: CARD }] }],
        },
      ],
      conflictNotes: [],
      railRuns: running ? [{ railId: id, state: "running", currentStageId: null }] : [],
      stepRuns: [],
    });
    const state = fleetState([wsWith("a", []), wsWith("b", [])]);
    const summary = fleetSummary(
      input(state, {
        orchestrations: { a: railed("r1", true), b: railed("r2", false) },
        attention: { b: new Set(["r2"]) },
      })
    );
    expect(summary.rails).toEqual({ running: 1, attention: 1, done: 0, idle: 0, total: 2 });
  });

  it("counts the same running tasks the column renders", () => {
    const state = fleetState([wsWith("a", [page("p1", ["s1", "s2"])])], {
      sessionStatusById: { s1: "working", s2: "working" },
    });
    const bundle = input(state, {
      boards: {
        a: boardWith([
          { path: "/ws/.gavin-root/plans/a.md", sessionId: "s1" },
          { path: "/ws/.gavin-root/plans/b.md", sessionId: "s2" },
        ]),
      },
    });
    expect(fleetSummary(bundle).tasks).toBe(runningTaskCount(runningTasks(bundle)));
    expect(fleetSummary(bundle).tasks).toBe(2);
  });
});
