import { describe, it, expect } from "vitest";
import {
  NO_SELECTION,
  cpuShare,
  formatCpu,
  formatMemory,
  killBatchConfirm,
  killConfirm,
  killFailedAlert,
  killPlan,
  managerSummary,
  nextSort,
  refusedOrphanAlert,
  selectRow,
  selectedRows,
  selectionHint,
  sessionRows,
  sortRows,
  survivorsAlert,
  type ManagedSession,
  type SessionRow,
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
    const prompt = killConfirm(row);
    expect(prompt.title).toContain("claude --model opus");
    expect(prompt.lines.join(" ")).toContain("/repo");
  });

  it("is a danger prompt whose button names the verb", () => {
    // ConfirmPrompt keeps focus on the dismissing button for a danger
    // choice, so Enter cannot fire a kill by reflex; and "OK" would be
    // the one word that says nothing about what just happened.
    const [row] = rowsFor([session()]);
    const prompt = killConfirm(row);
    expect(prompt.danger).toBe(true);
    expect(prompt.confirmLabel).not.toMatch(/^ok$/i);
  });

  it("says a surviving process is part of what ends", () => {
    const [row] = rowsFor([session({ orphan: { pid: 4471, command: "claude" } })]);
    expect(killConfirm(row).lines.join(" ")).toContain("4471");
  });

  it("counts what a kill-all press covers, and separates the stale ones", () => {
    const rows = rowsFor([
      session({ id: "a" }),
      session({ id: "b", cwd: "/repo/x" }),
      session({ id: "c", orphan: { pid: 3, command: null } }),
    ]);
    const prompt = killBatchConfirm(rows, "all")!;
    expect(prompt.title).toContain("3 sessions");
    expect(prompt.lines.join(" ")).toContain("1 of them is already stale");
    expect(prompt.danger).toBe(true);
  });

  it("names the selected rows, so a mis-click shows in the prompt", () => {
    const rows = rowsFor(
      [session({ id: "a" }), session({ id: "b" })],
      { sessionNames: { a: "commit agent", b: "tests" } } as never
    );
    const prompt = killBatchConfirm(rows, "selected")!;
    expect(prompt.title).toContain("2 selected");
    expect(prompt.lines.join(" ")).toContain("commit agent");
    expect(prompt.lines.join(" ")).toContain("tests");
  });

  it("caps the list of names rather than growing a modal to the ceiling", () => {
    const rows = rowsFor(Array.from({ length: 12 }, (_, i) => session({ id: `s${i}` })));
    const prompt = killBatchConfirm(rows, "selected")!;
    expect(prompt.lines.join(" ")).toMatch(/and \d+ more/);
  });

  it("asks about a single selected row with the single-row wording", () => {
    const rows = rowsFor([session({ command: "claude" })]);
    expect(killBatchConfirm(rows, "selected")).toEqual(killConfirm(rows[0]));
  });

  it("explains what clearing each kind of stale row does", () => {
    // Clearing an exited row deletes a record; clearing an orphan sends a
    // signal to a live process. One word covering both would hide the
    // one that matters.
    const rows = rowsFor([
      session({ id: "gone", status: "exited" }),
      session({ id: "shell", interrupted: true }),
      session({ id: "alive", orphan: { pid: 9, command: "claude" } }),
    ]);
    const prompt = killBatchConfirm(rows, "stale")!;
    expect(prompt.title).toContain("3 stale");
    const text = prompt.lines.join(" ");
    expect(text).toContain("1 exited");
    expect(text).toContain("1 interrupted");
    expect(text).toContain("1 orphaned");
    expect(text).toContain("SIGTERM");
    expect(prompt.confirmLabel).toBe("Clear stale");
  });

  it("has nothing to ask when there is nothing to end", () => {
    expect(killBatchConfirm([], "all")).toBe(null);
    expect(killBatchConfirm([], "stale")).toBe(null);
    expect(killBatchConfirm([], "selected")).toBe(null);
  });
});

describe("alerts", () => {
  it("names the row that could not be ended, and carries the reason", () => {
    const [row] = rowsFor([session({ command: "claude" })]);
    const alert = killFailedAlert(row, new Error("no such session"));
    expect(alert.title).toContain("claude");
    expect(alert.lines.join(" ")).toContain("no such session");
  });

  it("hands over the pid when a process refused to stop", () => {
    const [row] = rowsFor([session({ orphan: { pid: 4471, command: "claude" } })]);
    const alert = refusedOrphanAlert(row);
    expect(alert.title).toContain("still running");
    expect(alert.lines.join(" ")).toContain("kill -9 4471");
  });

  it("lists the survivors of a batch once, by name", () => {
    const alert = survivorsAlert(["stuck", "also stuck"], 5);
    expect(alert.title).toContain("2 of 5");
    expect(alert.lines.join(" ")).toContain("stuck, also stuck");
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

describe("state", () => {
  it("gives every row one word, staleness first, then visibility, then what it is doing", () => {
    const rows = sessionRows({
      sample: {
        sessions: [
          session({ id: "orphan", orphan: { pid: 1, command: null } }),
          session({ id: "gone", status: "exited" }),
          session({ id: "shell", interrupted: true }),
          session({ id: "hidden", status: "working" }),
          session({ id: "busy", status: "working" }),
          session({ id: "quiet", status: "idle" }),
          session({ id: "asking", status: "waiting_for_input" }),
          session({ id: "broken", status: "failed" }),
        ],
        metrics: true,
      },
      previous: null,
      workspaces: [showing("busy", "quiet", "asking", "broken")],
      sessionNames: {},
    });
    const state = Object.fromEntries(rows.map((r) => [r.id, r.state]));
    expect(state).toEqual({
      orphan: "orphaned",
      gone: "exited",
      shell: "interrupted",
      hidden: "hidden",
      busy: "active",
      quiet: "idle",
      asking: "waiting",
      broken: "failed",
    });
  });
});

describe("sortRows", () => {
  const rows = sessionRows({
    sample: {
      sessions: [
        session({ id: "b-big", rssBytes: 900, status: "idle" }),
        session({ id: "a-small", rssBytes: 100, status: "working" }),
        session({ id: "c-none", rssBytes: 500, processCount: 0, pid: null }),
        session({ id: "d-gone", status: "exited", rssBytes: 300 }),
      ],
      metrics: true,
    },
    previous: null,
    workspaces: [showing("b-big", "a-small", "c-none", "d-gone")],
    sessionNames: { "b-big": "beta", "a-small": "alpha", "c-none": "gamma", "d-gone": "delta" },
  });
  const ids = (sorted: SessionRow[]) => sorted.map((r) => r.id);

  it("sorts by name in both directions", () => {
    expect(ids(sortRows(rows, { key: "name", dir: "asc" }))).toEqual([
      "a-small",
      "b-big",
      "d-gone",
      "c-none",
    ]);
    expect(ids(sortRows(rows, { key: "name", dir: "desc" }))).toEqual([
      "c-none",
      "d-gone",
      "b-big",
      "a-small",
    ]);
  });

  it("sorts by memory with the unmeasured rows always last", () => {
    // A row nothing measured has no memory figure, not a memory of zero:
    // putting it first under ascending would read as "the smallest".
    expect(ids(sortRows(rows, { key: "mem", dir: "desc" }))).toEqual([
      "b-big",
      "d-gone",
      "a-small",
      "c-none",
    ]);
    expect(ids(sortRows(rows, { key: "mem", dir: "asc" }))).toEqual([
      "a-small",
      "d-gone",
      "b-big",
      "c-none",
    ]);
  });

  it("sorts by state with the rows that need attention first, and ties on name", () => {
    expect(ids(sortRows(rows, { key: "state", dir: "asc" }))).toEqual([
      "d-gone",
      "a-small",
      "b-big",
      "c-none",
    ]);
    expect(ids(sortRows(rows, { key: "state", dir: "desc" }))).toEqual([
      "b-big",
      "c-none",
      "a-small",
      "d-gone",
    ]);
  });

  it("does not touch the rows it was given", () => {
    const before = ids(rows);
    sortRows(rows, { key: "name", dir: "desc" });
    expect(ids(rows)).toEqual(before);
  });
});

describe("nextSort", () => {
  it("flips the direction on the column already sorted", () => {
    expect(nextSort({ key: "name", dir: "asc" }, "name")).toEqual({ key: "name", dir: "desc" });
    expect(nextSort({ key: "name", dir: "desc" }, "name")).toEqual({ key: "name", dir: "asc" });
  });

  it("starts a new column ascending, except memory, which starts with the biggest", () => {
    // Nobody sorts by memory to find the smallest shell.
    expect(nextSort({ key: "state", dir: "asc" }, "name")).toEqual({ key: "name", dir: "asc" });
    expect(nextSort({ key: "state", dir: "asc" }, "mem")).toEqual({ key: "mem", dir: "desc" });
  });
});

describe("selection", () => {
  const ordered = ["a", "b", "c", "d", "e"];
  const plain = { shift: false, cmd: false };
  const shift = { shift: true, cmd: false };
  const cmd = { shift: false, cmd: true };

  it("selects one row on a plain click, and clears it on a second", () => {
    const one = selectRow(NO_SELECTION, ordered, "b", plain);
    expect(one).toEqual({ ids: ["b"], anchor: "b" });
    expect(selectRow(one, ordered, "b", plain)).toEqual(NO_SELECTION);
  });

  it("replaces a wider selection with the plainly clicked row", () => {
    const many = { ids: ["a", "b", "c"], anchor: "a" };
    expect(selectRow(many, ordered, "b", plain)).toEqual({ ids: ["b"], anchor: "b" });
  });

  it("toggles one row under the command key without touching the rest", () => {
    const one = selectRow(NO_SELECTION, ordered, "a", plain);
    const two = selectRow(one, ordered, "d", cmd);
    expect(two.ids).toEqual(["a", "d"]);
    expect(two.anchor).toBe("d");
    expect(selectRow(two, ordered, "a", cmd).ids).toEqual(["d"]);
  });

  it("selects the range from the anchor under shift, in either direction", () => {
    const from = selectRow(NO_SELECTION, ordered, "d", plain);
    expect(selectRow(from, ordered, "b", shift)).toEqual({ ids: ["b", "c", "d"], anchor: "d" });
    expect(selectRow(from, ordered, "e", shift)).toEqual({ ids: ["d", "e"], anchor: "d" });
  });

  it("keeps the anchor across shift clicks, so the range can be re-aimed", () => {
    const from = selectRow(NO_SELECTION, ordered, "c", plain);
    const wide = selectRow(from, ordered, "e", shift);
    expect(selectRow(wide, ordered, "a", shift).ids).toEqual(["a", "b", "c"]);
  });

  it("adds the range to what is there when both keys are held", () => {
    const one = selectRow(NO_SELECTION, ordered, "a", plain);
    const far = selectRow(one, ordered, "d", cmd);
    expect(selectRow(far, ordered, "e", { shift: true, cmd: true }).ids).toEqual(["a", "d", "e"]);
  });

  it("treats a shift click with no usable anchor as a plain click", () => {
    expect(selectRow(NO_SELECTION, ordered, "c", shift)).toEqual({ ids: ["c"], anchor: "c" });
    // The anchor was killed or scrolled out of the sample: not in `ordered`.
    const gone = { ids: ["z"], anchor: "z" };
    expect(selectRow(gone, ordered, "c", shift)).toEqual({ ids: ["c"], anchor: "c" });
  });

  it("resolves to rows in display order, dropping ids that have gone", () => {
    const rows = rowsFor([session({ id: "a" }), session({ id: "b" }), session({ id: "c" })]);
    const picked = selectedRows(rows, { ids: ["c", "gone", "a"], anchor: "c" });
    expect(picked.map((r) => r.id)).toEqual(["a", "c"]);
  });
});

describe("selectionHint", () => {
  it("names the platform's own keys", () => {
    expect(selectionHint(true)).toContain("⌘");
    expect(selectionHint(true)).toContain("⇧");
    expect(selectionHint(false)).toContain("Ctrl");
    expect(selectionHint(false)).toContain("Shift");
    expect(selectionHint(false)).not.toContain("⌘");
  });
});
