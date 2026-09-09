import { describe, it, expect } from "vitest";
import {
  railDeleteConfirm,
  railClearDoneConfirm,
  clearFinishedRailsConfirm,
  clearAndArchiveFinishedRailsConfirm,
  groupRemoveConfirm,
  runAllConfirm,
} from "$lib/orchestration/railConfirm";
import type { CardEntry, Orchestration, Rail, Stage, Step } from "$lib/orchestration/orchestration";
import type { PlanFileInfo } from "$lib/core/gavin";
import { launchEstimate } from "$lib/agents/launchEstimate";

function plan(fileName: string, overrides: Partial<PlanFileInfo> = {}): PlanFileInfo {
  return {
    path: `/ws/.gavin-root/plans/${fileName}`,
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
    ...overrides,
  };
}

function cardIndexOf(plans: PlanFileInfo[]): Map<string, CardEntry> {
  return new Map(plans.map((p) => [p.path, { plan: p, contextFolder: "/ws/.gavin-root" }]));
}

function stage(steps: Step[], name: string | null = null): Stage {
  return { id: "s1", position: 0, name, steps };
}

function rail(id: string, stages: Array<Array<[string, string]>>): Rail {
  return {
    id,
    name: id,
    position: 0,
    worktreePath: null,
    pageId: null,
    stages: stages.map((steps, si) => ({
      id: `${id}-s${si}`,
      position: si,
      steps: steps.map(([stepId, cardPath], pi) => ({ id: stepId, position: pi, cardPath })),
    })),
  };
}

function orchOf(r: Rail, over: Partial<Orchestration> = {}): Orchestration {
  return { rails: [r], conflictNotes: [], railRuns: [], stepRuns: [], ...over };
}

describe("railDeleteConfirm", () => {
  const r = rail("r1", [
    [["t1", "/ws/.gavin-root/plans/a.md"]],
    [
      ["t2", "/ws/.gavin-root/plans/b.md"],
      ["t3", "/ws/.gavin-root/plans/a.md"],
    ],
  ]);

  it("names the rail and counts its stages and steps", () => {
    const c = railDeleteConfirm(r, orchOf(r));
    expect(c.title).toBe('Delete rail "r1"?');
    expect(c.lines[0]).toBe("Removes 2 stages and 3 steps from the plan.");
    expect(c.confirmLabel).toBe("Delete rail");
  });

  it("counts each card once, however many steps point at it", () => {
    expect(railDeleteConfirm(r, orchOf(r)).lines).toContain(
      "2 cards stay — a step is only a reference."
    );
  });

  it("says an empty rail is empty, rather than counting to zero", () => {
    const empty = rail("r1", []);
    const c = railDeleteConfirm(empty, orchOf(empty));
    expect(c.lines).toEqual(["This rail is empty — only the rail itself goes."]);
  });

  it("says nothing about cards on a rail that carries only tool steps", () => {
    const tools = rail("r1", [[["t1", ""]]]);
    tools.stages[0].steps[0].toolId = "tool-1";
    const c = railDeleteConfirm(tools, orchOf(tools));
    expect(c.lines).toEqual(["Removes 1 stage and 1 step from the plan."]);
  });

  it("singularizes a one-stage, one-step, one-card rail", () => {
    const one = rail("r1", [[["t1", "/ws/.gavin-root/plans/a.md"]]]);
    const c = railDeleteConfirm(one, orchOf(one));
    expect(c.lines[0]).toBe("Removes 1 stage and 1 step from the plan.");
    expect(c.lines[1]).toBe("1 card stays — a step is only a reference.");
  });

  it("mentions the run state only when the rail has one", () => {
    expect(railDeleteConfirm(r, orchOf(r)).lines.some((l) => l.includes("run state"))).toBe(false);
    const paused = orchOf(r, { railRuns: [{ railId: "r1", state: "paused", currentStageId: null }] });
    expect(railDeleteConfirm(r, paused).lines).toContain("Its run state (paused) goes with it.");
  });

  it("warns that a running step refuses the delete", () => {
    const running = orchOf(r, {
      railRuns: [{ railId: "r1", state: "running", currentStageId: "r1-s0" }],
      stepRuns: [{ stepId: "t1", state: "running", sessionId: "s1", reason: null }],
    });
    expect(railDeleteConfirm(r, running).lines).toContain(
      "1 step is still running — a live one refuses the delete, so pause the rail first."
    );
  });

  it("promises the bound worktree itself is left alone", () => {
    const bound = { ...r, worktreePath: "/x/wt" };
    expect(railDeleteConfirm(bound, orchOf(bound)).lines).toContain(
      "The worktree /x/wt is left as it is — only the rail's binding to it goes."
    );
  });
});

describe("railClearDoneConfirm", () => {
  const r = rail("r1", [
    [["t1", "/ws/.gavin-root/plans/a.md"]],
    [["t2", "/ws/.gavin-root/plans/b.md"]],
  ]);
  const cards = cardIndexOf([plan("a.md"), plan("b.md")]);

  it("counts the steps a clear would take off, by run state", () => {
    const orch = orchOf(r, {
      stepRuns: [{ stepId: "t1", state: "done", sessionId: null, reason: null }],
    });
    const c = railClearDoneConfirm(r, orch, cards, "Done");
    expect(c.title).toBe('Clear done steps from "r1"?');
    expect(c.lines[0]).toBe("Takes 1 done step off this rail.");
    expect(c.confirmLabel).toBe("Clear 1 step");
  });

  it("counts a step whose card is already in the done column", () => {
    const done = cardIndexOf([plan("a.md", { status: "Done" }), plan("b.md", { status: "Done" })]);
    const c = railClearDoneConfirm(r, orchOf(r), done, "Done");
    expect(c.lines[0]).toBe("Takes 2 done steps off this rail.");
    expect(c.confirmLabel).toBe("Clear 2 steps");
  });

  it("always promises the cards themselves survive", () => {
    expect(railClearDoneConfirm(r, orchOf(r), cards, "Done").lines).toContain(
      "The cards stay — only the steps that pointed at them leave."
    );
  });

  it("tells a running rail where its run picks up", () => {
    const idle = railClearDoneConfirm(r, orchOf(r), cards, "Done");
    expect(idle.lines.some((l) => l.includes("first unfinished stage"))).toBe(false);
    const running = orchOf(r, {
      railRuns: [{ railId: "r1", state: "running", currentStageId: "r1-s0" }],
    });
    expect(railClearDoneConfirm(r, running, cards, "Done").lines).toContain(
      "The run picks up from the first unfinished stage that is left."
    );
  });
});

describe("groupRemoveConfirm", () => {
  const cards = cardIndexOf([plan("a.md"), plan("b.md")]);

  it("names the group and counts its steps", () => {
    const s = stage(
      [
        { id: "t1", position: 0, cardPath: "/ws/.gavin-root/plans/a.md" },
        { id: "t2", position: 1, cardPath: "/ws/.gavin-root/plans/b.md" },
      ],
      "Ship it"
    );
    const c = groupRemoveConfirm(s, cards);
    expect(c.title).toBe('Remove group "Ship it"?');
    expect(c.lines[0]).toBe("Removes 2 steps from the plan.");
    expect(c.confirmLabel).toBe("Remove group");
  });

  it("falls back to a generic title when the group has no name", () => {
    const s = stage([
      { id: "t1", position: 0, cardPath: "/ws/.gavin-root/plans/a.md" },
      { id: "t2", position: 1, cardPath: "/ws/.gavin-root/plans/b.md" },
    ]);
    expect(groupRemoveConfirm(s, cards).title).toBe("Remove this group?");
  });

  it("counts each card once, however many steps point at it", () => {
    const s = stage([
      { id: "t1", position: 0, cardPath: "/ws/.gavin-root/plans/a.md" },
      { id: "t2", position: 1, cardPath: "/ws/.gavin-root/plans/a.md" },
    ]);
    expect(groupRemoveConfirm(s, cards).lines).toContain(
      "1 card stays — a step is only a reference."
    );
  });

  it("singularizes a two-step group with one card", () => {
    const s = stage([
      { id: "t1", position: 0, cardPath: "/ws/.gavin-root/plans/a.md" },
      { id: "t2", position: 1, cardPath: "/ws/.gavin-root/plans/b.md" },
    ]);
    const c = groupRemoveConfirm(s, cards);
    expect(c.lines[0]).toBe("Removes 2 steps from the plan.");
    expect(c.lines[1]).toBe("2 cards stay — a step is only a reference.");
  });

  it("says nothing about cards when the group holds only tool steps", () => {
    const s = stage([
      { id: "t1", position: 0, cardPath: "", toolId: "tool-1" },
      { id: "t2", position: 1, cardPath: "", toolId: "tool-2" },
    ]);
    expect(groupRemoveConfirm(s, cards).lines).toEqual(["Removes 2 steps from the plan."]);
  });

  it("does not count a card whose file no longer exists", () => {
    const s = stage([
      { id: "t1", position: 0, cardPath: "/ws/.gavin-root/plans/a.md" },
      { id: "t2", position: 1, cardPath: "/ws/.gavin-root/plans/missing.md" },
    ]);
    expect(groupRemoveConfirm(s, cards).lines).toContain(
      "1 card stays — a step is only a reference."
    );
  });
});

describe("runAllConfirm", () => {
  function named(id: string, name: string, position: number): Rail {
    return { ...rail(id, [[["s-" + id, "/ws/.gavin-root/plans/a.md"]]]), name, position };
  }

  function orchOfMany(rails: Rail[], over: Partial<Orchestration> = {}): Orchestration {
    return { rails, conflictNotes: [], railRuns: [], stepRuns: [], ...over };
  }

  it("names the rails it is about to start, in screen order", () => {
    const o = orchOfMany([named("r1", "docs", 1), named("r2", "daemon", 0)]);
    const c = runAllConfirm(o);
    expect(c.title).toBe("Run 2 idle rails?");
    expect(c.lines[0]).toBe("Starts: daemon, docs.");
    expect(c.confirmLabel).toBe("Start 2 rails");
  });

  it("singularizes a lone rail", () => {
    const c = runAllConfirm(orchOfMany([named("r1", "docs", 0)]));
    expect(c.title).toBe("Run 1 idle rail?");
    expect(c.confirmLabel).toBe("Start 1 rail");
  });

  it("accounts for the running rails it is leaving alone", () => {
    const o = orchOfMany([named("r1", "docs", 0), named("r2", "daemon", 1)], {
      railRuns: [{ railId: "r2", state: "running", currentStageId: "r2-s0" }],
    });
    const c = runAllConfirm(o);
    expect(c.lines[0]).toBe("Starts: docs.");
    expect(c.lines).toContain("1 rail already running keeps going, untouched.");
  });

  it("accounts for the paused rails it is leaving alone", () => {
    const o = orchOfMany([named("r1", "docs", 0), named("r2", "daemon", 1)], {
      railRuns: [{ railId: "r2", state: "paused", currentStageId: "r2-s0" }],
    });
    const c = runAllConfirm(o);
    expect(c.lines.some((l) => l.startsWith("1 rail paused stays paused"))).toBe(true);
  });

  // The number eleven rails would have needed. The lines above say WHO
  // runs; this one says what it takes, and it goes last so a reader who
  // stops early has still read the list.
  it("carries the memory estimate as its last line", () => {
    const o = orchOfMany([named("r1", "docs", 0), named("r2", "daemon", 1)]);
    const c = runAllConfirm(
      o,
      launchEstimate({
        count: 2,
        profileId: "claude-code",
        means: { "claude-code": 2 * 1024 ** 3 },
        storedMeans: {},
        measuredAgents: 3,
        sample: {
          supported: true,
          totalBytes: 32 * 1024 ** 3,
          freePercent: 50,
          pressureLevel: 1,
          swapUsedBytes: 0,
          sampledAtMs: 0,
        },
        maxInFlight: 4,
        inFlight: 0,
      })
    );
    expect(c.lines[c.lines.length - 1]).toBe(
      "2 agents ≈ 4 GB (2 GB each, from the 3 running now) on top of 16 of 32 GB."
    );
  });

  // Optional, so a test about the rail arithmetic need not build a
  // machine -- and so a surface with no sample yet still gets a dialog.
  it("says nothing about memory when no estimate is passed", () => {
    const c = runAllConfirm(orchOfMany([named("r1", "docs", 0)]));
    expect(c.lines.some((l) => l.includes("GB"))).toBe(false);
  });

  it("accounts for an idle rail with nothing left to run", () => {
    const o = orchOfMany([named("r1", "docs", 0), named("r2", "daemon", 1)], {
      stepRuns: [{ stepId: "s-r2", state: "done", sessionId: null, reason: null }],
    });
    const c = runAllConfirm(o);
    expect(c.lines[0]).toBe("Starts: docs.");
    expect(c.lines).toContain("1 idle rail has nothing left to run.");
  });

  it("says nothing about exclusions that do not apply", () => {
    const c = runAllConfirm(orchOfMany([named("r1", "docs", 0)]));
    expect(c.lines).toHaveLength(2);
  });
});

describe("clearFinishedRailsConfirm", () => {
  function named(id: string, name: string, position: number, steps = 1): Rail {
    const stages = [
      Array.from({ length: steps }, (_, i): [string, string] => [
        `${id}-t${i}`,
        `/ws/.gavin-root/plans/${id}-${i}.md`,
      ]),
    ];
    return { ...rail(id, stages), name, position };
  }

  function orchOfMany(rails: Rail[], over: Partial<Orchestration> = {}): Orchestration {
    return { rails, conflictNotes: [], railRuns: [], stepRuns: [], ...over };
  }

  const done = (stepId: string): Orchestration["stepRuns"][number] => ({
    stepId,
    state: "done",
    sessionId: null,
    reason: null,
  });

  const cards = cardIndexOf([plan("r1-0.md"), plan("r2-0.md"), plan("r2-1.md")]);

  it("names every rail it is about to remove, in screen order", () => {
    const o = orchOfMany([named("r1", "docs", 1), named("r2", "daemon", 0)], {
      stepRuns: [done("r1-t0"), done("r2-t0")],
    });
    const c = clearFinishedRailsConfirm(o, cards);
    expect(c.title).toBe("Remove 2 finished rails?");
    expect(c.lines[0]).toBe("Removes: daemon, docs.");
    expect(c.confirmLabel).toBe("Remove 2 rails");
  });

  it("singularizes a lone rail", () => {
    const o = orchOfMany([named("r1", "docs", 0)], { stepRuns: [done("r1-t0")] });
    const c = clearFinishedRailsConfirm(o, cards);
    expect(c.title).toBe("Remove 1 finished rail?");
    expect(c.confirmLabel).toBe("Remove 1 rail");
  });

  it("promises the cards stay, counted across every rail going", () => {
    const o = orchOfMany([named("r1", "docs", 0), named("r2", "daemon", 1, 2)], {
      stepRuns: [done("r1-t0"), done("r2-t0"), done("r2-t1")],
    });
    expect(clearFinishedRailsConfirm(o, cards).lines).toContain(
      "3 cards stay — a step is only a reference."
    );
  });

  it("does not promise to keep a card whose file is gone", () => {
    const o = orchOfMany([named("r1", "docs", 0)], { stepRuns: [done("r1-t0")] });
    expect(clearFinishedRailsConfirm(o, new Map()).lines.some((l) => l.includes("card"))).toBe(
      false
    );
  });

  it("says out loud when a step was skipped rather than done", () => {
    const o = orchOfMany([named("r1", "docs", 0)], {
      stepRuns: [{ stepId: "r1-t0", state: "skipped", sessionId: null, reason: null }],
    });
    expect(clearFinishedRailsConfirm(o, cards).lines).toContain(
      "1 step was skipped rather than done — nothing is left to run either way."
    );
  });

  it("names the one worktree it is leaving behind", () => {
    const bound = { ...named("r1", "docs", 0), worktreePath: "/x/wt" };
    const o = orchOfMany([bound], { stepRuns: [done("r1-t0")] });
    expect(clearFinishedRailsConfirm(o, cards).lines).toContain(
      "The worktree /x/wt is left as it is — only the rail's binding to it goes."
    );
  });

  it("counts several worktrees rather than listing them", () => {
    const o = orchOfMany(
      [
        { ...named("r1", "docs", 0), worktreePath: "/x/one" },
        { ...named("r2", "daemon", 1), worktreePath: "/x/two" },
      ],
      { stepRuns: [done("r1-t0"), done("r2-t0")] }
    );
    expect(clearFinishedRailsConfirm(o, cards).lines).toContain(
      "2 worktrees are left as they are — only the rails' bindings to them go."
    );
  });

  it("accounts for a finished rail that stays because it is paused", () => {
    const o = orchOfMany([named("r1", "docs", 0), named("r2", "daemon", 1)], {
      railRuns: [{ railId: "r2", state: "paused", currentStageId: "r2-s0" }],
      stepRuns: [done("r1-t0"), done("r2-t0")],
    });
    const c = clearFinishedRailsConfirm(o, cards);
    expect(c.lines[0]).toBe("Removes: docs.");
    expect(c.lines).toContain("1 rail with nothing left to do is running or paused, so it stays.");
  });

  it("says nothing about a rail that still has work on it", () => {
    const o = orchOfMany([named("r1", "docs", 0), named("r2", "daemon", 1)], {
      stepRuns: [done("r1-t0")],
    });
    const c = clearFinishedRailsConfirm(o, cards);
    expect(c.lines[0]).toBe("Removes: docs.");
    expect(c.lines.some((l) => l.includes("running or paused"))).toBe(false);
  });
});

describe("clearAndArchiveFinishedRailsConfirm", () => {
  function named(id: string, name: string, position: number, steps = 1): Rail {
    const stages = [
      Array.from({ length: steps }, (_, i): [string, string] => [
        `${id}-t${i}`,
        `/ws/.gavin-root/plans/${id}-${i}.md`,
      ]),
    ];
    return { ...rail(id, stages), name, position };
  }

  function orchOfMany(rails: Rail[], over: Partial<Orchestration> = {}): Orchestration {
    return { rails, conflictNotes: [], railRuns: [], stepRuns: [], ...over };
  }

  const done = (stepId: string): Orchestration["stepRuns"][number] => ({
    stepId,
    state: "done",
    sessionId: null,
    reason: null,
  });

  // Same three cards clearFinishedRailsConfirm's suite uses, but with a
  // real board status: only the ones filed "Done" are eligible to be
  // archived -- the whole point of this function over its sibling.
  const cards = cardIndexOf([
    plan("r1-0.md", { status: "Done" }),
    plan("r2-0.md", { status: "Done" }),
    plan("r2-1.md", { status: "In Progress" }),
  ]);

  it("promises the Done cards get archived, not merely kept", () => {
    const o = orchOfMany([named("r1", "docs", 0), named("r2", "daemon", 1, 2)], {
      stepRuns: [done("r1-t0"), done("r2-t0"), done("r2-t1")],
    });
    const c = clearAndArchiveFinishedRailsConfirm(o, cards, "Done");
    expect(c.title).toBe("Remove and archive 2 finished rails?");
    expect(c.lines).toContain("2 cards are archived — filed away, not deleted.");
    expect(c.lines).toContain("1 card stays — not in the Done column, so only the step goes.");
    expect(c.confirmLabel).toBe("Remove and archive 2 cards");
  });

  it("archives nothing when the workspace has no Done column", () => {
    const o = orchOfMany([named("r1", "docs", 0)], { stepRuns: [done("r1-t0")] });
    const c = clearAndArchiveFinishedRailsConfirm(o, cards, null);
    expect(c.lines.some((l) => l.includes("archived"))).toBe(false);
    expect(c.confirmLabel).toBe("Remove 1 rail");
  });

  it("still says out loud when a step was skipped rather than done", () => {
    const o = orchOfMany([named("r1", "docs", 0)], {
      stepRuns: [{ stepId: "r1-t0", state: "skipped", sessionId: null, reason: null }],
    });
    expect(clearAndArchiveFinishedRailsConfirm(o, cards, "Done").lines).toContain(
      "1 step was skipped rather than done — nothing is left to run either way."
    );
  });

  it("still leaves a held rail's worktree and run state out of the promise", () => {
    const o = orchOfMany([named("r1", "docs", 0), named("r2", "daemon", 1)], {
      railRuns: [{ railId: "r2", state: "paused", currentStageId: "r2-s0" }],
      stepRuns: [done("r1-t0"), done("r2-t0")],
    });
    const c = clearAndArchiveFinishedRailsConfirm(o, cards, "Done");
    expect(c.lines[0]).toBe("Removes: docs.");
    expect(c.lines).toContain("1 rail with nothing left to do is running or paused, so it stays.");
  });
});
