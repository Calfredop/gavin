import { describe, it, expect } from "vitest";
import {
  workspaceGitSummary,
  kanbanSummary,
  railPhase,
  railsSummary,
  railStripStats,
  kanbanColumnChips,
  hasRecap,
  showGitChip,
  pageAgentsSummary,
  workspaceAgentsSummary,
  pageTabRows,
} from "$lib/sidebarSummary";
import type { PageTabState } from "$lib/sidebarSummary";
import type { LayoutNode } from "$lib/layout";
import type { GitStatus, Page, Workspace } from "$lib/workspace";
import type { Orchestration, Rail, Stage, Step } from "$lib/orchestration";
import type { Board } from "$lib/kanban";
import type { GavinContext, GavinTree, PlanFileInfo } from "$lib/gavin";
import { source } from "$lib/sources";

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
  return { sessionStatusById: {}, fileTabsById: {}, boardTabsById: {}, cardTabsById: {}, ...overrides };
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

  // A rail with nothing left to run has arrived, however it got there.
  // Filing it under "idle" would put it back in the pile of rails
  // waiting to be started.
  it("reports a rail whose remaining steps were skipped as done", () => {
    const r = rail("r1", [stage("s1", 0, [step("st1", 0)]), stage("s2", 1, [step("st2", 0)])]);
    const orch = orchestration({
      rails: [r],
      stepRuns: [
        { stepId: "st1", state: "done", sessionId: null, reason: null },
        { stepId: "st2", state: "skipped", sessionId: null, reason: null },
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

describe("railStripStats", () => {
  const none = { running: 0, attention: 0, done: 0, idle: 0, total: 0 };

  // The strip is one line in a 200px sidebar. Four stats never fit
  // beside a git and a cards group, so the rails group answers ONE
  // question at a time: what is going on, or -- when nothing is --
  // what is there. The tooltip still names all four buckets.
  it("shows the active pair when something is running", () => {
    expect(railStripStats({ ...none, running: 2, done: 3, idle: 1, total: 6 })).toEqual(["running"]);
  });

  it("shows both active stats when a rail also wants a human", () => {
    expect(railStripStats({ ...none, running: 2, attention: 1, done: 3, total: 6 })).toEqual([
      "running",
      "attention",
    ]);
  });

  // Attention alone still counts as active: it is the loudest thing the
  // recap can say, and burying it behind a done tally is how a human
  // misses the rail that is waiting on them.
  it("shows attention alone when nothing else is running", () => {
    expect(railStripStats({ ...none, attention: 1, done: 4, idle: 2, total: 7 })).toEqual(["attention"]);
  });

  // Nothing active: the group falls back to the settled pair, and shows
  // BOTH of them -- two stats is the same width the active pair costs,
  // so a settled workspace gets a complete answer for free.
  it("falls back to the settled pair when nothing is active", () => {
    expect(railStripStats({ ...none, done: 3, idle: 1, total: 4 })).toEqual(["done", "idle"]);
  });

  it("drops a zero from the settled pair rather than printing it", () => {
    expect(railStripStats({ ...none, done: 3, total: 3 })).toEqual(["done"]);
    expect(railStripStats({ ...none, idle: 2, total: 2 })).toEqual(["idle"]);
  });

  it("never returns more than two stats", () => {
    const all = { running: 1, attention: 1, done: 1, idle: 1, total: 4 };
    expect(railStripStats(all).length).toBeLessThanOrEqual(2);
  });

  // A workspace with no rails renders no rails group at all, so this is
  // the empty case rather than a bucket to pick from.
  it("returns nothing for a workspace with no rails", () => {
    expect(railStripStats(none)).toEqual([]);
  });
});

describe("kanbanColumnChips", () => {
  function cards(columns: { name: string; count: number }[]) {
    return { todo: 0, inProgress: 0, done: 0, total: 0, columns };
  }

  // What the board group expands into when it is hovered: one stat per
  // column, in the order kanbanSummary already put them (board order,
  // auto columns after), so the expansion reads left to right the way
  // the board itself does.
  it("keeps every column, in the order it was given", () => {
    const chips = kanbanColumnChips(
      cards([
        { name: "To Do", count: 8 },
        { name: "In Progress", count: 3 },
        { name: "Done", count: 41 },
      ])
    );
    expect(chips.map((c) => [c.initials, c.count])).toEqual([
      ["TD", 8],
      ["IP", 3],
      ["D", 41],
    ]);
  });

  // The expansion is the DETAIL view -- a column standing empty is a
  // fact about the board, and dropping it would silently change the
  // board's shape depending on how full it happens to be.
  it("keeps a column standing at zero", () => {
    const chips = kanbanColumnChips(cards([{ name: "Done", count: 0 }]));
    expect(chips).toEqual([{ name: "Done", initials: "D", tone: "done", count: 0 }]);
  });

  // The same slug matching and the same by-elimination fold kanbanSummary
  // uses, so the colour a column is drawn in can never disagree with the
  // bucket its cards were counted into.
  it("tones the two permanent ends by slug, not spelling", () => {
    const chips = kanbanColumnChips(cards([{ name: "to do", count: 1 }, { name: "DONE", count: 2 }]));
    expect(chips.map((c) => c.tone)).toEqual(["todo", "done"]);
  });

  it("tones a custom column as in progress -- it is neither not-started nor finished", () => {
    const chips = kanbanColumnChips(cards([{ name: "Blocked", count: 4 }]));
    expect(chips[0]).toMatchObject({ initials: "B", tone: "progress" });
  });

  it("initials a name by its words, capped so one column can never eat the row", () => {
    const chips = kanbanColumnChips(
      cards([
        { name: "Code Review", count: 1 },
        { name: "Phase 2", count: 1 },
        { name: "waiting-on-review-from-someone", count: 1 },
      ])
    );
    expect(chips.map((c) => c.initials)).toEqual(["CR", "P2", "WOR"]);
  });

  // A status the human typed that is all punctuation still gets a slot:
  // it has cards in it, and a blank one would read as a rendering fault.
  it("falls back to a placeholder for a name with no letters or digits", () => {
    expect(kanbanColumnChips(cards([{ name: "---", count: 2 }]))[0].initials).toBe("?");
  });

  it("carries the full name through for the tooltip and the label", () => {
    expect(kanbanColumnChips(cards([{ name: "In Progress", count: 3 }]))[0].name).toBe("In Progress");
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
      failed: 0,
      idle: 0,
    });
  });

  it("counts every tab, and treats a session with no status yet as idle", () => {
    expect(pageAgentsSummary(page("p1", leaf(["a", "b", "c"])), tabState())).toEqual({
      tabs: 3,
      agents: 3,
      running: 0,
      waiting: 0,
      failed: 0,
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
      failed: 0,
      idle: 1,
    });
  });

  // Before v21 this counted as idle, so the sidebar's recap told the
  // human a workspace was quietly finished when what it actually was,
  // was broken.
  it("keeps a broken agent out of the idle bucket", () => {
    const state = tabState({ sessionStatusById: { a: "failed", b: "idle" } });
    expect(pageAgentsSummary(page("p1", leaf(["a", "b"])), state)).toEqual({
      tabs: 2,
      agents: 2,
      running: 0,
      waiting: 0,
      failed: 1,
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
      failed: 0,
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
      failed: 0,
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
      failed: 0,
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
      failed: 0,
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
      failed: 0,
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
      failed: 0,
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
      failed: 0,
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

// The attention badge is the one part of these tallies no unit test can
// reach: it is a number rendered on a row. What it must not do is count
// for itself. It did, once -- a sum over ws.pages, which cannot see the
// workspace's MAIN agent session (D12, outside every page tree), so a
// Home-tab agent with a question on screen showed no badge on any row of
// the sidebar. These pin the badge to the summaries above, where the
// main session is already folded in and already tested.
describe("Sidebar attention badge wiring", () => {
  const sidebar = source("Sidebar.svelte");

  it("counts a workspace's waiting agents with workspaceAgentsSummary", () => {
    // Off `attentionState` -- the layout with a wait the human has marked
    // as read shown as idle (sessionRead.ts). This badge exists to make
    // somebody look; a wait they have already looked at is not one.
    expect(sidebar).toContain("return workspaceAgentsSummary(ws, $attentionState).waiting;");
  });

  it("draws the page badge off the recap that row already computed", () => {
    expect(sidebar).toContain("{#if tabs.waiting > 0}");
  });

  it("wears the shared agent badge rather than a glyph of its own", () => {
    expect(sidebar).toContain('indicator={agentIndicatorByState("waiting_for_input")}');
  });

  it("keeps no second walk of the layouts for the count", () => {
    expect(sidebar).not.toContain('=== "waiting_for_input"');
  });
});

// The workspace recap strip is three pills of the same shape: a glyph and
// a tally. Nothing here is testable as a value -- it is a rendering -- but
// the two numbers that decide its scale are in the committed source, so a
// grep can hold the line the same way indicatorSurfaces.test.ts does.
//
// What went wrong: git and cards each open with a category glyph at 11px
// and put their count after it at the sidebar's own text size. The rails
// group has no category glyph -- its badges ARE its identity -- but it was
// drawn at the size a badge takes where it hangs off a leading stat (10px
// glyph, 0.85em text, as the page row and the app hub draw it). So the one
// group whose badge had to carry the axis was the smallest thing in the
// row, which is what got reported as the running rail badge looking small.
describe("the workspace recap strip is drawn at one scale", () => {
  const sidebar = source("Sidebar.svelte");

  /// The strip's markup only: from the guard that renders it to the page
  /// rows below, which are a tier of their own and keep their own sizes.
  /// Both markers are asserted rather than assumed -- an `indexOf` of -1
  /// silently widens this slice to most of the file, which is how the
  /// page loop being renamed once turned this guard into a grep over
  /// every sized glyph in the sidebar.
  const stripStart = sidebar.indexOf("{#if hasRecap(");
  const stripEnd = sidebar.indexOf("{#each orderedPages(ws)");
  const strip = sidebar.slice(stripStart, stripEnd);

  it("still knows where the strip starts and ends", () => {
    expect(stripStart, "the recap strip's opening guard has moved").toBeGreaterThan(-1);
    expect(stripEnd, "the page loop below the strip has moved").toBeGreaterThan(stripStart);
  });

  it("draws every glyph in it at the same size", () => {
    const sizes = [...strip.matchAll(/size=\{(\d+)\}/g)].map((m) => m[1]);
    expect(sizes.length, "no sized glyph found -- has the strip moved?").toBeGreaterThan(3);
    expect(
      [...new Set(sizes)],
      `the strip draws glyphs at ${[...new Set(sizes)].join("/")}px; a pill drawn smaller than the pills beside it reads as a rendering fault`
    ).toEqual(["11"]);
  });

  it("gives the rails tally the same size digits as the tallies beside it", () => {
    // StatusBadge's own 0.85em is right where a badge trails a bigger
    // stat; in this strip it put one of three numbers a step below the
    // other two. Descendant :global(), never a leading one -- that would
    // resize every badge in the app.
    expect(strip).toContain('class="recap-body"');
    const css = sidebar.slice(sidebar.indexOf("<style>"));
    const at = css.indexOf(".recap-body :global(.badge-text)");
    expect(at, "the recap strip no longer sizes the badge's own text").toBeGreaterThan(-1);
    expect(css.slice(at, css.indexOf("}", at))).toContain("font-size: inherit");
  });
});
