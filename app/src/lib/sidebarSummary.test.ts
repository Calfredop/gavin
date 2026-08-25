import { describe, it, expect } from "vitest";
import {
  workspaceGitSummary,
  kanbanSummary,
  railPhase,
  railsSummary,
  hasRecap,
  showGitChip,
  pageAgentsSummary,
  workspaceAgentsSummary,
  pageTabRows,
} from "./sidebarSummary";
import type { PageTabState } from "./sidebarSummary";
import type { LayoutNode } from "./layout";
import type { GitStatus, Page, Workspace } from "./workspace";
import type { Orchestration, Rail, Stage, Step } from "./orchestration";
import type { Board } from "./kanban";
import type { GavinContext, GavinTree, PlanFileInfo } from "./gavin";

function leaf(tabs: string[]): LayoutNode {
  return { type: "leaf", tabs, activeTabIndex: 0 };
}

function page(id: string, layout: LayoutNode): Page {
  return { id, name: id, layout, focusedSessionId: null };
}

function split(children: LayoutNode[]): LayoutNode {
  return { type: "split", direction: "row", children, sizes: children.map(() => 1 / children.length) };
}

function tabState(overrides: Partial<PageTabState> = {}): PageTabState {
  return { sessionStatusById: {}, fileTabsById: {}, boardTabsById: {}, ...overrides };
}

function workspace(pages: Page[], overrides: Partial<Workspace> = {}): Workspace {
  return { id: "ws-1", name: "A", pages, activePageId: pages[0]?.id ?? null, ...overrides };
}

function gitStatus(repoRoot: string, overrides: Partial<GitStatus> = {}): GitStatus {
  return { repoRoot, branch: "main", dirty: false, ahead: 0, behind: 0, hasUpstream: false, ...overrides };
}

function step(id: string, position: number): Step {
  return { id, position, cardPath: `/ws/.gavin-root/plans/${id}.md` };
}

function stage(id: string, position: number, steps: Step[]): Stage {
  return { id, position, steps };
}

function rail(id: string, stages: Stage[]): Rail {
  return { id, name: id, position: 0, worktreePath: null, pageId: null, stages };
}

function orchestration(overrides: Partial<Orchestration> = {}): Orchestration {
  return { rails: [], conflictNotes: [], railRuns: [], stepRuns: [], ...overrides };
}

function plan(fileName: string, status: string | null): PlanFileInfo {
  return {
    path: `/ws/.gavin-root/plans/${fileName}`,
    fileName,
    title: fileName,
    status,
    priority: null,
    order: null,
    kind: "plan",
    parent: null,
    labels: [],
    checklistDone: 0,
    checklistTotal: 0,
    parseWarning: false,
  };
}

function tree(plans: PlanFileInfo[]): GavinTree {
  const ctx: GavinContext = {
    folderPath: "/ws",
    kind: "context",
    name: "ws",
    plans,
    docs: [],
    specs: [],
    hasPrd: false,
    configWarning: false,
  };
  return { rootPath: "/ws", rootMissing: false, contexts: [ctx] };
}

function board(names: string[]): Board {
  return {
    columns: names.map((name, position) => ({ id: `c${position}`, name, position })),
    labels: [],
    cardSessions: [],
  };
}

const STANDARD = board(["To Do", "In Progress", "Done"]);

describe("workspaceGitSummary", () => {
  it("counts no repos when no session has a status", () => {
    const ws = workspace([page("p1", leaf(["a", "b"]))]);
    expect(workspaceGitSummary(ws, {})).toEqual({ repoCount: 0, dirtyCount: 0, ahead: 0, behind: 0, committing: false });
  });

  it("ignores sessions whose status is explicitly null", () => {
    const ws = workspace([page("p1", leaf(["a", "b"]))]);
    expect(workspaceGitSummary(ws, { a: null, b: null }).repoCount).toBe(0);
  });

  it("dedupes by repoRoot across every page in the workspace", () => {
    const ws = workspace([page("p1", leaf(["a", "b"])), page("p2", leaf(["c"]))]);
    const summary = workspaceGitSummary(ws, {
      a: gitStatus("/repo-a"),
      b: gitStatus("/repo-a"),
      c: gitStatus("/repo-b"),
    });
    expect(summary.repoCount).toBe(2);
  });

  it("counts the main agent session, which lives outside every page tree", () => {
    const ws = workspace([page("p1", leaf(["a"]))], { mainSessionId: "main" });
    const summary = workspaceGitSummary(ws, { a: gitStatus("/repo-a"), main: gitStatus("/repo-root") });
    expect(summary.repoCount).toBe(2);
  });

  it("finds a rooted workspace's repo through the main session alone when its pages are empty", () => {
    const ws = workspace([], { mainSessionId: "main" });
    expect(workspaceGitSummary(ws, { main: gitStatus("/repo-root", { dirty: true }) })).toEqual({
      repoCount: 1,
      dirtyCount: 1,
      ahead: 0,
      behind: 0,
      committing: false,
    });
  });

  // Passed in, not counted: the commit agent is a hidden session with no
  // tab and no git status of its own, so nothing this function reads
  // could find it.
  it("carries the commit-run flag through untouched", () => {
    const ws = workspace([], { mainSessionId: "main" });
    expect(workspaceGitSummary(ws, { main: gitStatus("/repo-root") }, true).committing).toBe(true);
  });

  it("counts dirty repos, not dirty sessions", () => {
    const ws = workspace([page("p1", leaf(["a", "b", "c"]))]);
    const summary = workspaceGitSummary(ws, {
      a: gitStatus("/repo-a", { dirty: true }),
      b: gitStatus("/repo-a", { dirty: true }),
      c: gitStatus("/repo-b", { dirty: false }),
    });
    expect(summary).toMatchObject({ repoCount: 2, dirtyCount: 1 });
  });

  it("sums ahead/behind across repos that have an upstream", () => {
    const ws = workspace([page("p1", leaf(["a", "b"]))]);
    const summary = workspaceGitSummary(ws, {
      a: gitStatus("/repo-a", { hasUpstream: true, ahead: 2, behind: 1 }),
      b: gitStatus("/repo-b", { hasUpstream: true, ahead: 3, behind: 0 }),
    });
    expect(summary).toMatchObject({ ahead: 5, behind: 1 });
  });

  it("ignores ahead/behind on a repo with no upstream", () => {
    const ws = workspace([page("p1", leaf(["a"]))]);
    const summary = workspaceGitSummary(ws, {
      a: gitStatus("/repo-a", { hasUpstream: false, ahead: 7, behind: 4 }),
    });
    expect(summary).toMatchObject({ repoCount: 1, ahead: 0, behind: 0 });
  });

  it("ignores sessions that belong to no page of this workspace", () => {
    const ws = workspace([page("p1", leaf(["a"]))]);
    expect(workspaceGitSummary(ws, { a: gitStatus("/repo-a"), elsewhere: gitStatus("/repo-b") }).repoCount).toBe(1);
  });
});

describe("railPhase", () => {
  it("reports a rail whose run state is running as running, even with unfinished steps", () => {
    const r = rail("r1", [stage("s1", 0, [step("st1", 0)])]);
    const orch = orchestration({
      rails: [r],
      railRuns: [{ railId: "r1", state: "running", currentStageId: "s1" }],
    });
    expect(railPhase(orch, r)).toBe("running");
  });

  it("reports a rail whose every step is done as done", () => {
    const r = rail("r1", [stage("s1", 0, [step("st1", 0)]), stage("s2", 1, [step("st2", 0)])]);
    const orch = orchestration({
      rails: [r],
      stepRuns: [
        { stepId: "st1", state: "done", sessionId: null, reason: null },
        { stepId: "st2", state: "done", sessionId: null, reason: null },
      ],
    });
    expect(railPhase(orch, r)).toBe("done");
  });

  it("reports a rail with one unfinished step as idle", () => {
    const r = rail("r1", [stage("s1", 0, [step("st1", 0), step("st2", 1)])]);
    const orch = orchestration({
      rails: [r],
      stepRuns: [{ stepId: "st1", state: "done", sessionId: null, reason: null }],
    });
    expect(railPhase(orch, r)).toBe("idle");
  });

  it("treats a paused rail as idle -- it stopped, it did not arrive", () => {
    const r = rail("r1", [stage("s1", 0, [step("st1", 0)])]);
    const orch = orchestration({
      rails: [r],
      railRuns: [{ railId: "r1", state: "paused", currentStageId: "s1" }],
      stepRuns: [{ stepId: "st1", state: "stalled", sessionId: null, reason: "boom" }],
    });
    expect(railPhase(orch, r)).toBe("idle");
  });

  it("treats a rail with no steps as idle, not vacuously done", () => {
    const r = rail("r1", []);
    expect(railPhase(orchestration({ rails: [r] }), r)).toBe("idle");
    const withEmptyStage = rail("r2", [stage("s1", 0, [])]);
    expect(railPhase(orchestration({ rails: [withEmptyStage] }), withEmptyStage)).toBe("idle");
  });

  // Attention outranks every other phase: it is the only one that means
  // a human has to do something, and it is true of a running rail and a
  // paused one alike.
  it("reports a rail wanting a human as attention, whatever else it is", () => {
    const r = rail("r1", [stage("s1", 0, [step("st1", 0)])]);
    const orch = orchestration({
      rails: [r],
      railRuns: [{ railId: "r1", state: "running", currentStageId: "s1" }],
    });
    expect(railPhase(orch, r, new Set(["r1"]))).toBe("attention");
  });

  it("leaves a rail nobody flagged in the phase it already had", () => {
    const r = rail("r1", [stage("s1", 0, [step("st1", 0)])]);
    const orch = orchestration({
      rails: [r],
      railRuns: [{ railId: "r1", state: "running", currentStageId: "s1" }],
    });
    expect(railPhase(orch, r, new Set())).toBe("running");
  });

  it("reports a finished rail as done once its run state falls back to idle", () => {
    const r = rail("r1", [stage("s1", 0, [step("st1", 0)])]);
    const orch = orchestration({
      rails: [r],
      railRuns: [{ railId: "r1", state: "idle", currentStageId: null }],
      stepRuns: [{ stepId: "st1", state: "done", sessionId: null, reason: null }],
    });
    expect(railPhase(orch, r)).toBe("done");
  });
});

describe("railsSummary", () => {
  it("counts nothing for an orchestration that has not loaded", () => {
    expect(railsSummary(undefined)).toEqual({ running: 0, attention: 0, done: 0, idle: 0, total: 0 });
    expect(railsSummary(null)).toEqual({ running: 0, attention: 0, done: 0, idle: 0, total: 0 });
  });

  it("tallies each rail into exactly one bucket", () => {
    const running = rail("r1", [stage("s1", 0, [step("st1", 0)])]);
    const done = rail("r2", [stage("s2", 0, [step("st2", 0)])]);
    const idle = rail("r3", [stage("s3", 0, [step("st3", 0)])]);
    const orch = orchestration({
      rails: [running, done, idle],
      railRuns: [{ railId: "r1", state: "running", currentStageId: "s1" }],
      stepRuns: [{ stepId: "st2", state: "done", sessionId: null, reason: null }],
    });
    expect(railsSummary(orch)).toEqual({ running: 1, attention: 0, done: 1, idle: 1, total: 3 });
  });

  // A rail waiting on a human is still running -- but "3 running" tells
  // the human nothing about which of the three wants them, which is the
  // entire reason this bucket exists. It takes the rail OUT of running so
  // each rail is still counted exactly once and the two numbers sum.
  it("counts a rail wanting a human under attention rather than running", () => {
    const r = rail("r1", [stage("s1", 0, [step("st1", 0)])]);
    const orch = orchestration({
      rails: [r],
      railRuns: [{ railId: "r1", state: "running", currentStageId: "s1" }],
    });
    expect(railsSummary(orch, new Set(["r1"]))).toEqual({
      running: 0, attention: 1, done: 0, idle: 0, total: 1,
    });
  });

  // Attention beats every other phase, including idle: a paused rail
  // holding a step stuck `running` with a live agent is exactly the wedge
  // worth surfacing, since it is why the rail cannot be edited or deleted.
  it("counts a paused rail wanting a human under attention too", () => {
    const r = rail("r1", [stage("s1", 0, [step("st1", 0)])]);
    const orch = orchestration({
      rails: [r],
      railRuns: [{ railId: "r1", state: "paused", currentStageId: "s1" }],
    });
    expect(railsSummary(orch, new Set(["r1"])).attention).toBe(1);
  });

  it("ignores a rail id that wants attention but is not in this orchestration", () => {
    const r = rail("r1", [stage("s1", 0, [step("st1", 0)])]);
    const orch = orchestration({ rails: [r] });
    expect(railsSummary(orch, new Set(["elsewhere"]))).toMatchObject({ attention: 0, idle: 1 });
  });
});

describe("hasRecap", () => {
  const noGit = { repoCount: 0, dirtyCount: 0, ahead: 0, behind: 0, committing: false };
  const noCards = { todo: 0, inProgress: 0, done: 0, total: 0, columns: [] };
  const noRails = { running: 0, attention: 0, done: 0, idle: 0, total: 0 };

  it("is false when there is no repo, no card and no rail", () => {
    expect(hasRecap(noGit, noCards, noRails)).toBe(false);
  });

  it("is true with a repo alone", () => {
    expect(hasRecap({ ...noGit, repoCount: 1 }, noCards, noRails)).toBe(true);
  });

  it("is true with a card alone", () => {
    expect(hasRecap(noGit, { ...noCards, todo: 1, total: 1 }, noRails)).toBe(true);
  });

  it("is true with a rail alone", () => {
    expect(hasRecap(noGit, noCards, { ...noRails, idle: 1, total: 1 })).toBe(true);
  });

  // The case the chip exists for: a workspace whose sessions report no
  // repo between them still has an agent committing in it, and nothing
  // else on screen would say so.
  it("is true for a commit run alone, with no repo counted", () => {
    expect(hasRecap({ ...noGit, committing: true }, noCards, noRails)).toBe(true);
    expect(showGitChip({ ...noGit, committing: true })).toBe(true);
    expect(showGitChip(noGit)).toBe(false);
  });
});

describe("kanbanSummary", () => {
  it("counts nothing when the board has not loaded", () => {
    expect(kanbanSummary(undefined, tree([plan("a.md", "To Do")]))).toMatchObject({
      todo: 0,
      inProgress: 0,
      done: 0,
      total: 0,
    });
  });

  it("counts nothing when the tree has not loaded", () => {
    expect(kanbanSummary(STANDARD, undefined)).toMatchObject({ total: 0 });
  });

  it("buckets the three permanent columns", () => {
    const summary = kanbanSummary(
      STANDARD,
      tree([plan("a.md", "To Do"), plan("b.md", "In Progress"), plan("c.md", "Done"), plan("d.md", "Done")])
    );
    expect(summary).toMatchObject({ todo: 1, inProgress: 1, done: 2, total: 4 });
  });

  it("matches column names by slug, not spelling", () => {
    const summary = kanbanSummary(board(["to-do", "in progress", "DONE"]), tree([plan("a.md", "To Do"), plan("b.md", "done")]));
    expect(summary).toMatchObject({ todo: 1, inProgress: 0, done: 1, total: 2 });
  });

  it("folds a custom column into in progress -- it is neither not-started nor finished", () => {
    const summary = kanbanSummary(
      board(["To Do", "In Progress", "Blocked", "Done"]),
      tree([plan("a.md", "Blocked"), plan("b.md", "In Progress")])
    );
    expect(summary).toMatchObject({ todo: 0, inProgress: 2, done: 0, total: 2 });
  });

  it("folds an auto column -- a status no column matches -- into in progress", () => {
    const summary = kanbanSummary(STANDARD, tree([plan("a.md", "Reviewing")]));
    expect(summary).toMatchObject({ todo: 0, inProgress: 1, done: 0, total: 1 });
  });

  it("counts a card with no status wherever the board itself puts it: the first column", () => {
    expect(kanbanSummary(STANDARD, tree([plan("a.md", null)]))).toMatchObject({ todo: 1, total: 1 });
    expect(kanbanSummary(board(["Done", "To Do"]), tree([plan("a.md", null)]))).toMatchObject({ done: 1, total: 1 });
  });

  it("keeps the per-column breakdown the buckets fold away, auto columns last", () => {
    const summary = kanbanSummary(
      board(["To Do", "In Progress", "Blocked", "Done"]),
      tree([plan("a.md", "Blocked"), plan("b.md", "Reviewing"), plan("c.md", "Done")])
    );
    expect(summary.columns).toEqual([
      { name: "To Do", count: 0 },
      { name: "In Progress", count: 0 },
      { name: "Blocked", count: 1 },
      { name: "Done", count: 1 },
      { name: "Reviewing", count: 1 },
    ]);
  });
});

describe("pageAgentsSummary", () => {
  it("counts nothing for a page with no tabs at all", () => {
    expect(pageAgentsSummary(page("p1", leaf([])), tabState())).toEqual({
      tabs: 0,
      agents: 0,
      running: 0,
      waiting: 0,
      idle: 0,
    });
  });

  it("counts every tab, and treats a session with no status yet as idle", () => {
    expect(pageAgentsSummary(page("p1", leaf(["a", "b", "c"])), tabState())).toEqual({
      tabs: 3,
      agents: 3,
      running: 0,
      waiting: 0,
      idle: 3,
    });
  });

  it("buckets each agent by its status", () => {
    const state = tabState({
      sessionStatusById: { a: "working", b: "waiting_for_input", c: "idle", d: "working" },
    });
    expect(pageAgentsSummary(page("p1", leaf(["a", "b", "c", "d"])), state)).toEqual({
      tabs: 4,
      agents: 4,
      running: 2,
      waiting: 1,
      idle: 1,
    });
  });

  it("keeps waiting_for_input out of both running and idle -- it is its own bucket", () => {
    const state = tabState({ sessionStatusById: { a: "waiting_for_input" } });
    expect(pageAgentsSummary(page("p1", leaf(["a"])), state)).toMatchObject({ running: 0, idle: 0, waiting: 1 });
  });

  it("counts a file tab and a board tab as tabs but never as agents", () => {
    const state = tabState({
      fileTabsById: { f: { path: "/ws/README.md" } },
      boardTabsById: { b: { workspaceId: "ws-1", contextFolder: "/ws" } },
      sessionStatusById: { a: "working" },
    });
    expect(pageAgentsSummary(page("p1", leaf(["a", "f", "b"])), state)).toEqual({
      tabs: 3,
      agents: 1,
      running: 1,
      waiting: 0,
      idle: 0,
    });
  });

  it("does not count a file tab as an idle agent even if a status was recorded against its id", () => {
    const state = tabState({
      fileTabsById: { f: { path: "/ws/README.md" } },
      sessionStatusById: { f: "working" },
    });
    expect(pageAgentsSummary(page("p1", leaf(["f"])), state)).toEqual({
      tabs: 1,
      agents: 0,
      running: 0,
      waiting: 0,
      idle: 0,
    });
  });

  it("walks the whole layout tree, not just the first leaf", () => {
    const layout = split([leaf(["a", "b"]), split([leaf(["c"]), leaf(["d"])])]);
    const state = tabState({ sessionStatusById: { a: "working", d: "waiting_for_input" } });
    expect(pageAgentsSummary(page("p1", layout), state)).toEqual({
      tabs: 4,
      agents: 4,
      running: 1,
      waiting: 1,
      idle: 2,
    });
  });

  it("splits the agents exactly three ways -- running + waiting + idle is always the agent count", () => {
    const state = tabState({
      fileTabsById: { f: { path: "/ws/README.md" } },
      sessionStatusById: { a: "working", b: "waiting_for_input", c: "idle" },
    });
    const summary = pageAgentsSummary(page("p1", leaf(["a", "b", "c", "d", "f"])), state);
    expect(summary.running + summary.waiting + summary.idle).toBe(summary.agents);
    expect(summary.agents).toBeLessThan(summary.tabs);
  });
});

describe("workspaceAgentsSummary", () => {
  it("counts nothing for a workspace with no pages", () => {
    expect(workspaceAgentsSummary(workspace([]), tabState())).toEqual({
      pages: 0,
      tabs: 0,
      agents: 0,
      running: 0,
      waiting: 0,
      idle: 0,
    });
  });

  it("sums every page's tally and reports how many pages it summed", () => {
    const state = tabState({
      sessionStatusById: { a: "working", b: "waiting_for_input", c: "working", d: "idle" },
    });
    const ws = workspace([page("p1", leaf(["a", "b"])), page("p2", leaf(["c", "d"]))]);
    expect(workspaceAgentsSummary(ws, state)).toEqual({
      pages: 2,
      tabs: 4,
      agents: 4,
      running: 2,
      waiting: 1,
      idle: 1,
    });
  });

  it("agrees exactly with the per-page recaps it is built from", () => {
    const state = tabState({
      fileTabsById: { f: { path: "/ws/README.md" } },
      sessionStatusById: { a: "working", c: "waiting_for_input" },
    });
    const pages = [page("p1", leaf(["a", "f"])), page("p2", split([leaf(["b"]), leaf(["c"])]))];
    const total = workspaceAgentsSummary(workspace(pages), state);
    const perPage = pages.map((p) => pageAgentsSummary(p, state));
    for (const key of ["tabs", "agents", "running", "waiting", "idle"] as const) {
      expect(total[key]).toBe(perPage.reduce((sum, s) => sum + s[key], 0));
    }
  });

  it("folds in the main agent session, which sits outside every page tree", () => {
    const state = tabState({ sessionStatusById: { main: "working" } });
    const ws = workspace([page("p1", leaf(["a"]))], { mainSessionId: "main" });
    expect(workspaceAgentsSummary(ws, state)).toEqual({
      pages: 1,
      tabs: 2,
      agents: 2,
      running: 1,
      waiting: 0,
      idle: 1,
    });
  });

  it("counts a main session that has never reported in as idle", () => {
    const ws = workspace([], { mainSessionId: "main" });
    expect(workspaceAgentsSummary(ws, tabState())).toMatchObject({ agents: 1, running: 0, idle: 1 });
  });

  it("counts a main session waiting for input in its own bucket", () => {
    const state = tabState({ sessionStatusById: { main: "waiting_for_input" } });
    const ws = workspace([], { mainSessionId: "main" });
    expect(workspaceAgentsSummary(ws, state)).toMatchObject({ agents: 1, running: 0, waiting: 1, idle: 0 });
  });

  it("counts a main session that also sits on a page exactly once", () => {
    const state = tabState({ sessionStatusById: { main: "working" } });
    const ws = workspace([page("p1", leaf(["main"]))], { mainSessionId: "main" });
    expect(workspaceAgentsSummary(ws, state)).toEqual({
      pages: 1,
      tabs: 1,
      agents: 1,
      running: 1,
      waiting: 0,
      idle: 0,
    });
  });

  it("splits the agents exactly three ways, main session included", () => {
    const state = tabState({
      fileTabsById: { f: { path: "/ws/README.md" } },
      sessionStatusById: { a: "working", b: "waiting_for_input" },
    });
    const ws = workspace([page("p1", leaf(["a", "b", "c", "f"]))], { mainSessionId: "main" });
    const summary = workspaceAgentsSummary(ws, state);
    expect(summary.running + summary.waiting + summary.idle).toBe(summary.agents);
    expect(summary.agents).toBeLessThan(summary.tabs);
  });
});

describe("pageTabRows", () => {
  it("classifies each tab, and leaves file and board tabs without a status", () => {
    const state = tabState({
      fileTabsById: { f: { path: "/ws/README.md" } },
      boardTabsById: { b: { workspaceId: "ws-1", contextFolder: "/ws" } },
      sessionStatusById: { a: "working" },
    });
    expect(pageTabRows(page("p1", leaf(["a", "f", "b"])), state)).toEqual([
      { id: "a", kind: "session", status: "working" },
      { id: "f", kind: "file", status: null },
      { id: "b", kind: "board", status: null },
    ]);
  });

  it("reads a session that has not reported in yet as idle", () => {
    expect(pageTabRows(page("p1", leaf(["a"])), tabState())).toEqual([
      { id: "a", kind: "session", status: "idle" },
    ]);
  });

  it("keeps layout order across a nested split", () => {
    const layout = split([leaf(["a", "b"]), split([leaf(["c"]), leaf(["d"])])]);
    expect(pageTabRows(page("p1", layout), tabState()).map((r) => r.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("has a row for every tab and nothing else", () => {
    const layout = split([leaf(["a", "f"]), leaf(["b"])]);
    const state = tabState({ fileTabsById: { f: { path: "/ws/README.md" } } });
    expect(pageTabRows(page("p1", layout), state)).toHaveLength(3);
  });

  it("tallies to exactly what pageAgentsSummary counts", () => {
    const layout = split([leaf(["a", "b", "f"]), leaf(["c", "d", "bd"])]);
    const state = tabState({
      fileTabsById: { f: { path: "/ws/README.md" } },
      boardTabsById: { bd: { workspaceId: "ws-1", contextFolder: "/ws" } },
      sessionStatusById: { a: "working", b: "waiting_for_input", c: "idle" },
    });
    const rows = pageTabRows(page("p1", layout), state);
    const summary = pageAgentsSummary(page("p1", layout), state);
    const sessions = rows.filter((r) => r.kind === "session");
    expect(rows).toHaveLength(summary.tabs);
    expect(sessions).toHaveLength(summary.agents);
    expect(sessions.filter((r) => r.status === "working")).toHaveLength(summary.running);
    expect(sessions.filter((r) => r.status === "waiting_for_input")).toHaveLength(summary.waiting);
    expect(sessions.filter((r) => r.status === "idle")).toHaveLength(summary.idle);
  });
});
