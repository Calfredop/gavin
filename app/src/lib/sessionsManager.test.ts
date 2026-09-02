import { describe, it, expect } from "vitest";
import {
  cpuShare,
  formatCpu,
  formatMemory,
  killAllConfirm,
  killConfirm,
  killPlan,
  managerSummary,
  sessionRows,
  type ManagedSession,
} from "./sessionsManager";
import type { Workspace } from "./workspace";

const SECOND = 1_000_000;

function session(over: Partial<ManagedSession> = {}): ManagedSession {
  return {
    id: "s1",
    workspacePath: "/repo",
    cwd: "/repo",
    status: "idle",
    restored: false,
    interrupted: false,
    orphan: null,
    command: null,
    pid: 4172,
    rssBytes: 100 * 1024 * 1024,
    cpuTimeUs: 0,
    processCount: 1,
    sampledAtUs: 10 * SECOND,
    ...over,
  };
}

function workspace(over: Partial<Workspace> = {}): Workspace {
  return {
    id: "ws-1",
    name: "gavin",
    rootPath: "/repo",
    pages: [
      { id: "pg-1", name: "Work", layout: { type: "leaf", tabs: ["s1"], activeTabIndex: 0 } },
    ],
    activePageId: "pg-1",
    ...over,
  } as Workspace;
}

/// A workspace whose one page is showing exactly these sessions, so a
/// test can say which ids are meant to be visible.
function showing(...ids: string[]): Workspace {
  return workspace({
    pages: [{ id: "pg-1", name: "Work", layout: { type: "leaf", tabs: ids, activeTabIndex: 0 } }],
  } as Partial<Workspace>);
}

function rowsFor(sessions: ManagedSession[], over: Parameters<typeof sessionRows>[0] | null = null) {
  return sessionRows({
    sample: { sessions, metrics: true },
    previous: null,
    workspaces: [workspace()],
    sessionNames: {},
    ...(over ?? {}),
  });
}

describe("sessionRows", () => {
  it("names a session by its human-given name before anything else", () => {
    const [row] = sessionRows({
      sample: { sessions: [session({ command: "claude --model opus" })], metrics: true },
      previous: null,
      workspaces: [workspace()],
      sessionNames: { s1: "login flow" },
    });
    expect(row.label).toBe("login flow");
  });

  it("falls back to the command, then to a plain shell", () => {
    expect(rowsFor([session({ command: "claude --model opus" })])[0].label).toBe(
      "claude --model opus"
    );
    expect(rowsFor([session({ command: null })])[0].label).toBe("shell");
  });

  it("places a session that a page is showing, and calls it visible", () => {
    const [row] = rowsFor([session()]);
    expect(row.visible).toBe(true);
    expect(row.workspaceName).toBe("gavin");
    expect(row.where).toBe("Work");
  });

  it("calls a session no page holds invisible, and still names its workspace", () => {
    // The git-commit agent and the orchestration Generate run are both
    // this: real sessions, doing real work, that nothing in the app is
    // rendering. Naming the workspace is what makes such a row
    // actionable rather than an anonymous pid.
    const [row] = rowsFor([session({ id: "hidden-1", cwd: "/repo/sub" })]);
    expect(row.visible).toBe(false);
    expect(row.where).toBe(null);
    expect(row.workspaceName).toBe("gavin");
  });

  it("counts the main agent panel as visible, on Home", () => {
    // It lives outside every page tree (D12), so the layout search can
    // never find it -- without this it would be reported as an invisible
    // session next to a kill button, which it is not.
    const [row] = sessionRows({
      sample: { sessions: [session({ id: "main-1" })], metrics: true },
      previous: null,
      workspaces: [workspace({ mainSessionId: "main-1" })],
      sessionNames: {},
    });
    expect(row.visible).toBe(true);
    expect(row.where).toBe("Home");
  });

  it("marks a surviving orphan stale, ahead of every other reading", () => {
    const [row] = rowsFor([
      session({
        status: "exited",
        interrupted: true,
        orphan: { pid: 4471, command: "claude" },
      }),
    ]);
    expect(row.staleness).toBe("orphaned");
    expect(row.note).toContain("4471");
  });

  it("marks an exited row and an interrupted one stale too", () => {
    expect(rowsFor([session({ status: "exited", pid: null, processCount: 0 })])[0].staleness).toBe(
      "exited"
    );
    expect(rowsFor([session({ interrupted: true })])[0].staleness).toBe("interrupted");
  });

  it("does not call a merely restored session stale", () => {
    // A restored shell lost its scrollback and nothing else. Calling
    // that stale would put a warning on every row after any daemon
    // restart, which is how a stale indicator stops meaning anything.
    const [row] = rowsFor([session({ restored: true })]);
    expect(row.staleness).toBe(null);
    expect(row.stale).toBe(false);
  });

  it("puts the rows that need attention first, and keeps the order stable", () => {
    // Sorted on facts that do not change between polls -- never on CPU,
    // which would make rows swap places under the pointer every couple
    // of seconds.
    const rows = sessionRows({
      sample: {
        sessions: [
          session({ id: "quiet", cpuTimeUs: 9 * SECOND }),
          session({ id: "hidden", cwd: "/repo/x" }),
          session({ id: "orphan", orphan: { pid: 1, command: null } }),
        ],
        metrics: true,
      },
      previous: null,
      workspaces: [showing("quiet")],
      sessionNames: { quiet: "a", hidden: "b", orphan: "c" },
    });
    expect(rows.map((r) => r.id)).toEqual(["orphan", "hidden", "quiet"]);
  });

  it("reports no figures at all until there is a second sample to divide by", () => {
    const [row] = rowsFor([session({ cpuTimeUs: 5 * SECOND })]);
    expect(row.cpuPercent).toBe(null);
    expect(row.memBytes).toBe(100 * 1024 * 1024);
  });

  it("turns two samples into a share of one CPU", () => {
    const previous = { sessions: [session({ cpuTimeUs: SECOND, sampledAtUs: 8 * SECOND })], metrics: true };
    const [row] = sessionRows({
      sample: { sessions: [session({ cpuTimeUs: 2 * SECOND, sampledAtUs: 10 * SECOND })], metrics: true },
      previous,
      workspaces: [workspace()],
      sessionNames: {},
    });
    // One CPU-second over two wall-clock seconds is half a core.
    expect(row.cpuPercent).toBeCloseTo(50, 5);
  });

  it("has nothing to report for a session it could not measure", () => {
    // processCount 0 is the daemon saying "I looked and there is nothing
    // there" -- which must not render as a confident 0.0% / 0 MB.
    const [row] = rowsFor([session({ pid: null, processCount: 0, rssBytes: 0 })]);
    expect(row.cpuPercent).toBe(null);
    expect(row.memBytes).toBe(null);
  });

  it("reports nothing when the daemon was never asked for figures", () => {
    const [row] = sessionRows({
      sample: { sessions: [session()], metrics: false },
      previous: { sessions: [session({ cpuTimeUs: 0, sampledAtUs: 8 * SECOND })], metrics: false },
      workspaces: [workspace()],
      sessionNames: {},
    });
    expect(row.cpuPercent).toBe(null);
    expect(row.memBytes).toBe(null);
  });
});

describe("cpuShare", () => {
  const now = { cpuTimeUs: 3 * SECOND, sampledAtUs: 10 * SECOND, pid: 7, processCount: 1 };

  it("is null without a previous sample", () => {
    expect(cpuShare(now, null)).toBe(null);
  });

  it("floors a shrinking tree at zero rather than reporting negative CPU", () => {
    // The counter is monotonic per process but not per TREE: a child
    // exiting between two samples takes its share of the total with it.
    const before = { cpuTimeUs: 9 * SECOND, sampledAtUs: 8 * SECOND, pid: 7, processCount: 4 };
    expect(cpuShare(now, before)).toBe(0);
  });

  it("refuses to subtract across a change of process", () => {
    // A session whose process was replaced between polls has two
    // unrelated counters; their difference is not a rate of anything.
    const before = { cpuTimeUs: SECOND, sampledAtUs: 8 * SECOND, pid: 99, processCount: 1 };
    expect(cpuShare(now, before)).toBe(null);
  });

  it("refuses a zero or backwards interval", () => {
    const same = { cpuTimeUs: SECOND, sampledAtUs: 10 * SECOND, pid: 7, processCount: 1 };
    expect(cpuShare(now, same)).toBe(null);
    expect(cpuShare(now, { ...same, sampledAtUs: 12 * SECOND })).toBe(null);
  });

  it("can exceed one hundred percent, because a tree can use several cores", () => {
    const before = { cpuTimeUs: 0, sampledAtUs: 9 * SECOND, pid: 7, processCount: 4 };
    expect(cpuShare(now, before)).toBeCloseTo(300, 5);
  });
});

describe("formatting", () => {
  it("shows memory at a size a human reads, and an em dash for nothing", () => {
    expect(formatMemory(null)).toBe("—");
    expect(formatMemory(0)).toBe("0 KB");
    expect(formatMemory(912 * 1024)).toBe("912 KB");
    expect(formatMemory(184 * 1024 * 1024)).toBe("184 MB");
    expect(formatMemory(1536 * 1024 * 1024)).toBe("1.5 GB");
  });

  it("shows CPU to one decimal, and an em dash for nothing", () => {
    expect(formatCpu(null)).toBe("—");
    expect(formatCpu(0)).toBe("0.0%");
    expect(formatCpu(31.44)).toBe("31.4%");
    expect(formatCpu(312.5)).toBe("312.5%");
  });
});

describe("killPlan", () => {
  it("ends the orphan before the session, never after", () => {
    // The orphan is recorded ON the session row, and killing the session
    // deletes that row -- so the other order leaves a live process with
    // nothing left that knows how to end it.
    const [row] = rowsFor([session({ orphan: { pid: 4471, command: "claude" } })]);
    expect(killPlan(row)).toEqual({ endOrphan: true, killSession: true });
  });

  it("kills only the session when there is no survivor", () => {
    const [row] = rowsFor([session()]);
    expect(killPlan(row)).toEqual({ endOrphan: false, killSession: true });
  });

  it("still clears a row with nothing running, because the row is the thing left", () => {
    const [row] = rowsFor([session({ status: "exited", pid: null, processCount: 0 })]);
    expect(killPlan(row)).toEqual({ endOrphan: false, killSession: true });
  });
});

describe("confirmations", () => {
  it("names what is about to die, not the category", () => {
    const [row] = rowsFor([session({ command: "claude --model opus" })]);
    const text = killConfirm(row);
    expect(text).toContain("claude --model opus");
    expect(text).toContain("/repo");
  });

  it("says a surviving process is part of what ends", () => {
    const [row] = rowsFor([session({ orphan: { pid: 4471, command: "claude" } })]);
    expect(killConfirm(row)).toContain("4471");
  });

  it("counts what a kill-all press covers, and separates the stale ones", () => {
    const rows = rowsFor([
      session({ id: "a" }),
      session({ id: "b", cwd: "/repo/x" }),
      session({ id: "c", orphan: { pid: 3, command: null } }),
    ]);
    const text = killAllConfirm(rows);
    expect(text).toContain("3 sessions");
    expect(text).toContain("1");
  });

  it("has nothing to ask when there is nothing to end", () => {
    expect(killAllConfirm([])).toBe(null);
  });
});

describe("managerSummary", () => {
  it("counts sessions, the hidden ones and the stale ones", () => {
    const rows = sessionRows({
      sample: {
        sessions: [
          session({ id: "a" }),
          session({ id: "b", cwd: "/repo/x" }),
          session({ id: "c", orphan: { pid: 3, command: null } }),
        ],
        metrics: true,
      },
      previous: null,
      workspaces: [showing("a")],
      sessionNames: {},
    });
    expect(managerSummary(rows)).toBe("3 sessions · 2 hidden · 1 stale");
  });

  it("drops the parts that are zero", () => {
    expect(managerSummary(rowsFor([session()]))).toBe("1 session");
  });

  it("says so when there are none", () => {
    expect(managerSummary([])).toBe("no sessions");
  });
});
