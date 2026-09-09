import { describe, it, expect } from "vitest";
import {
  emptyOrchestration,
  nextActions,
  railIsFinished,
  railTriggerLabel,
  railTriggerVerdict,
  setRailTrigger,
  RAIL_TRIGGER_CHOICES,
} from "./orchestration";
import type { Orchestration, Rail, RailState, StepState } from "./orchestration";
import type { Board } from "./kanban";
import type { GavinTree, PlanFileInfo } from "./gavin";

// A rail's own start condition. The one rule in the scheduler that starts
// a rail nobody pressed Start on, so the tests here are mostly about what
// it REFUSES to start: a paused rail, a rail already going, a rail whose
// run rows are being repaired this very pass, and a condition that reads
// as satisfied only because there was nothing to satisfy it.

function board(names: string[]): Board {
  return {
    columns: names.map((name, i) => ({ id: `c${i}`, name, position: i })),
    labels: [],
    cardSessions: [],
  };
}
const BOARD = board(["To Do", "In Progress", "Done"]);

function plan(fileName: string): PlanFileInfo {
  return {
    path: `/ws/.gavin-root/plans/${fileName}`,
    fileName,
    title: fileName.replace(/\.md$/, ""),
    status: "To Do",
    priority: null,
    order: null,
    kind: "task",
    parent: null,
    labels: [],
    checklistDone: 0,
    checklistTotal: 0,
    parseWarning: false,
  };
}

function tree(names: string[]): GavinTree {
  return {
    rootPath: "/ws",
    rootMissing: false,
    contexts: [
      {
        folderPath: "/ws/.gavin-root",
        kind: "root",
        name: "ws",
        plans: names.map(plan),
        docs: [],
        specs: [],
        hasPrd: true,
        configWarning: false,
      },
    ],
  };
}

/// A rail of one stage per step id given. `[]` is a rail with no stages
/// at all, which is what a rail the human just added looks like.
function rail(id: string, name: string, stepIds: string[]): Rail {
  return {
    id,
    name,
    position: 0,
    worktreePath: null,
    pageId: null,
    stages: stepIds.map((stepId, i) => ({
      id: `${id}-s${i}`,
      position: i,
      steps: [{ id: stepId, position: 0, cardPath: `/ws/.gavin-root/plans/${stepId}.md` }],
    })),
  };
}

function orchOf(rails: Rail[], overrides: Partial<Orchestration> = {}): Orchestration {
  return { ...emptyOrchestration(), rails, ...overrides };
}

function railRun(railId: string, state: RailState, currentStageId: string | null = null) {
  return { railId, state, currentStageId };
}

function stepRun(stepId: string, state: StepState) {
  return { stepId, state, sessionId: null, reason: null };
}

function withTrigger(r: Rail, kind: string, name?: string): Rail {
  return { ...r, trigger: { kind, rail: name ?? null } };
}

describe("whether a rail has anything left to do", () => {
  it("is idle plus no unfinished stage", () => {
    const r = rail("r1", "backend", ["t1"]);
    const running = orchOf([r], {
      railRuns: [railRun("r1", "running", "r1-s0")],
      stepRuns: [stepRun("t1", "done")],
    });
    // Every step done, but the rail is still advancing: it has not
    // finished, whatever its rows add up to.
    expect(railIsFinished(running, r)).toBe(false);

    const idle = orchOf([r], { stepRuns: [stepRun("t1", "done")] });
    expect(railIsFinished(idle, r)).toBe(true);
  });

  it("is false for a PAUSED rail, however much of it is done", () => {
    const r = rail("r1", "backend", ["t1"]);
    const o = orchOf([r], {
      railRuns: [railRun("r1", "paused", "r1-s0")],
      stepRuns: [stepRun("t1", "done")],
    });
    expect(railIsFinished(o, r)).toBe(false);
  });

  it("is true, vacuously, for a rail with no steps", () => {
    // The reading a trigger needs: a column the human added and has not
    // filled must not freeze every rail waiting on the others forever.
    expect(railIsFinished(orchOf([rail("r1", "empty", [])]), rail("r1", "empty", []))).toBe(true);
  });
});

describe("a rail with no trigger", () => {
  it("waits for nothing, because nothing is what it says", () => {
    const r = rail("r1", "backend", ["t1"]);
    expect(railTriggerVerdict(orchOf([r]), r).kind).toBe("off");
    expect(railTriggerLabel(null)).toBe("starts by hand");
    expect(railTriggerLabel(undefined)).toBe("starts by hand");
  });
});

describe("“after every other rail”", () => {
  const target = () => withTrigger(rail("r3", "release", ["t3"]), "all-rails-done");

  it("fires once no other rail has anything left", () => {
    const o = orchOf([rail("r1", "backend", ["t1"]), rail("r2", "ui", ["t2"]), target()], {
      stepRuns: [stepRun("t1", "done"), stepRun("t2", "skipped")],
    });
    // `skipped` counts: the human sent the rail past that step, so it is
    // as much behind it as one that ran.
    expect(railTriggerVerdict(o, o.rails[2])).toEqual({ kind: "fire" });
  });

  it("waits on a rail that is still going, and names it", () => {
    const o = orchOf([rail("r1", "backend", ["t1"]), rail("r2", "ui", ["t2"]), target()], {
      railRuns: [railRun("r1", "running", "r1-s0")],
      stepRuns: [stepRun("t2", "done")],
    });
    const v = railTriggerVerdict(o, o.rails[2]);
    expect(v.kind).toBe("wait");
    expect(v.kind === "wait" && v.reason).toContain("backend");
  });

  it("waits on a rail nobody has started yet", () => {
    // Idle with work is pending work, not finished work -- "after every
    // other rail" has to mean the ones that never ran too.
    const o = orchOf([rail("r1", "backend", ["t1"]), target()]);
    expect(railTriggerVerdict(o, o.rails[1]).kind).toBe("wait");
  });

  it("waits on a PAUSED rail rather than counting it done", () => {
    const o = orchOf([rail("r1", "backend", ["t1"]), target()], {
      railRuns: [railRun("r1", "paused", "r1-s0")],
      stepRuns: [stepRun("t1", "done")],
    });
    expect(railTriggerVerdict(o, o.rails[1]).kind).toBe("wait");
  });

  it("is not held up by an empty rail", () => {
    const o = orchOf([rail("r1", "scratch", []), target()]);
    expect(railTriggerVerdict(o, o.rails[1])).toEqual({ kind: "fire" });
  });

  it("counts rather than lists once there are too many to read", () => {
    const many = [1, 2, 3, 4].map((n) => rail(`other-${n}`, `rail ${n}`, [`t${n}`]));
    const o = orchOf([...many, target()]);
    const v = railTriggerVerdict(o, o.rails[4]);
    expect(v.kind === "wait" && v.reason).toBe("waiting for 4 rails that still have work");
  });

  it("refuses to fire when this is the only rail there is", () => {
    // Vacuously true, and meaningless: "after everything else" in a
    // workspace with no everything else means "the moment a card lands
    // on me", which is not what anyone picking this asked for.
    const o = orchOf([target()]);
    const v = railTriggerVerdict(o, o.rails[0]);
    expect(v.kind).toBe("broken");
    expect(v.kind === "broken" && v.reason).toContain("only rail");
  });
});

describe("“after one named rail”", () => {
  it("fires when that rail has finished, matching its name loosely", () => {
    const o = orchOf(
      [rail("r1", "Backend", ["t1"]), withTrigger(rail("r2", "release", ["t2"]), "rail-done", " backend ")],
      { stepRuns: [stepRun("t1", "done")] }
    );
    expect(railTriggerVerdict(o, o.rails[1])).toEqual({ kind: "fire" });
  });

  it("waits while that rail still has work", () => {
    const o = orchOf([
      rail("r1", "backend", ["t1"]),
      withTrigger(rail("r2", "release", ["t2"]), "rail-done", "backend"),
    ]);
    const v = railTriggerVerdict(o, o.rails[1]);
    expect(v.kind).toBe("wait");
    expect(v.kind === "wait" && v.reason).toContain("backend");
  });

  it("waits on a named rail with no steps rather than firing on it", () => {
    // The opposite reading of the empty rail "after every other rail"
    // allows, and deliberately: naming a rail is a claim that it does
    // something, so an empty one is a wait a human ends by filling it.
    const o = orchOf([
      rail("r1", "backend", []),
      withTrigger(rail("r2", "release", ["t2"]), "rail-done", "backend"),
    ]);
    const v = railTriggerVerdict(o, o.rails[1]);
    expect(v.kind).toBe("wait");
    expect(v.kind === "wait" && v.reason).toContain("no steps");
  });

  it("is broken when it names nothing, something gone, or two rails at once", () => {
    const noName = orchOf([
      rail("r1", "backend", ["t1"]),
      withTrigger(rail("r2", "release", ["t2"]), "rail-done"),
    ]);
    expect(railTriggerVerdict(noName, noName.rails[1]).kind).toBe("broken");

    const gone = orchOf([withTrigger(rail("r2", "release", ["t2"]), "rail-done", "backend")]);
    const goneV = railTriggerVerdict(gone, gone.rails[0]);
    expect(goneV.kind === "broken" && goneV.reason).toContain("no rail called");

    const twice = orchOf([
      rail("r1", "backend", ["t1"]),
      rail("r3", "backend", ["t3"]),
      withTrigger(rail("r2", "release", ["t2"]), "rail-done", "backend"),
    ]);
    const twiceV = railTriggerVerdict(twice, twice.rails[2]);
    expect(twiceV.kind === "broken" && twiceV.reason).toContain("2 rails");
  });

  it("is broken when a rail names itself", () => {
    const o = orchOf([withTrigger(rail("r1", "release", ["t1"]), "rail-done", "release")]);
    const v = railTriggerVerdict(o, o.rails[0]);
    expect(v.kind === "broken" && v.reason).toContain("cannot wait for itself");
  });
});

describe("a condition this build does not know", () => {
  it("never fires, and says so rather than reading as no trigger", () => {
    // A hand edit, or a workspace shared with an app one version ahead.
    // Firing on a rule this process cannot state is the one outcome that
    // must not happen; drawing it as "starts by hand" would be a lie the
    // human acts on.
    const o = orchOf([rail("r1", "backend", ["t1"]), withTrigger(rail("r2", "release", ["t2"]), "on-tuesdays")], {
      stepRuns: [stepRun("t1", "done")],
    });
    const v = railTriggerVerdict(o, o.rails[1]);
    expect(v.kind).toBe("broken");
    expect(v.kind === "broken" && v.reason).toContain("on-tuesdays");
    expect(railTriggerLabel({ kind: "on-tuesdays" })).toContain("on-tuesdays");
  });
});

describe("the picker's choices", () => {
  it("are the kinds the verdict actually evaluates", () => {
    // One list, so a choice offered is a choice the scheduler can act on.
    expect(RAIL_TRIGGER_CHOICES.map((c) => c.kind)).toEqual(["all-rails-done", "rail-done"]);
    expect(RAIL_TRIGGER_CHOICES.map((c) => c.needsRail)).toEqual([false, true]);
  });
});

// ---- What the scheduler does with it ---------------------------------------

function actionsFor(o: Orchestration, steps: string[] = ["t1", "t2", "t3"]) {
  return nextActions(o, BOARD, tree(steps.map((s) => `${s}.md`)), [], new Set());
}

describe("the scheduler's trigger rule", () => {
  it("arms an idle rail at the stage Start would have armed", () => {
    const o = orchOf(
      [rail("r1", "backend", ["t1"]), withTrigger(rail("r2", "release", ["t2", "t3"]), "all-rails-done")],
      { stepRuns: [stepRun("t1", "done"), stepRun("t2", "done")] }
    );
    expect(actionsFor(o)).toContainEqual({ kind: "arm", railId: "r2", stageId: "r2-s1" });
  });

  it("leaves a PAUSED rail alone", () => {
    // A pause is a human's decision or a stalled step's, and a condition
    // written in advance must not overrule either.
    const o = orchOf(
      [rail("r1", "backend", ["t1"]), withTrigger(rail("r2", "release", ["t2"]), "all-rails-done")],
      {
        railRuns: [railRun("r2", "paused", "r2-s0")],
        stepRuns: [stepRun("t1", "done")],
      }
    );
    expect(actionsFor(o).some((a) => a.kind === "arm")).toBe(false);
  });

  it("leaves a rail with nothing unfinished alone", () => {
    // Nothing to arm: startRail refuses such a rail too, and arming it
    // would set a rail running with no stage to point at.
    const o = orchOf(
      [rail("r1", "backend", ["t1"]), withTrigger(rail("r2", "release", ["t2"]), "all-rails-done")],
      { stepRuns: [stepRun("t1", "done"), stepRun("t2", "done")] }
    );
    expect(actionsFor(o).some((a) => a.kind === "arm")).toBe(false);
  });

  it("does not arm a rail whose own run rows this pass is repairing", () => {
    // A stale `running` row on an idle rail is corrected here (the
    // session is long gone), and stalling a step pauses its rail -- so
    // arming in the same pass would set a rail running and then pause it.
    // The tick after the repair decides on rows that are true.
    const o = orchOf(
      [
        rail("r1", "backend", ["t1"]),
        withTrigger(rail("r2", "release", ["t2", "t3"]), "all-rails-done"),
      ],
      {
        stepRuns: [
          stepRun("t1", "done"),
          { stepId: "t2", state: "running", sessionId: "sess-gone", reason: null },
        ],
      }
    );
    const actions = actionsFor(o);
    expect(actions.some((a) => a.kind === "stall" || a.kind === "markDone")).toBe(true);
    expect(actions.some((a) => a.kind === "arm")).toBe(false);
  });

  it("stays standing: a finished rail given new work arms again", () => {
    // Nothing records that a trigger has fired, because there is no such
    // fact -- "start when the others are done" is a condition, not an
    // event. A second stage dropped onto a rail that already ran is work
    // its condition still covers.
    const o = orchOf(
      [rail("r1", "backend", ["t1"]), withTrigger(rail("r2", "release", ["t2", "t3"]), "all-rails-done")],
      { stepRuns: [stepRun("t1", "done"), stepRun("t2", "done")] }
    );
    expect(actionsFor(o)).toContainEqual({ kind: "arm", railId: "r2", stageId: "r2-s1" });
  });

  it("arms nothing for a rail with no trigger at all", () => {
    const o = orchOf([rail("r1", "backend", ["t1"]), rail("r2", "release", ["t2"])], {
      stepRuns: [stepRun("t1", "done")],
    });
    expect(actionsFor(o).some((a) => a.kind === "arm")).toBe(false);
  });
});

describe("writing the condition", () => {
  it("sets and clears it on the rail alone", () => {
    const o = orchOf([rail("r1", "backend", ["t1"]), rail("r2", "release", ["t2"])]);
    const set = setRailTrigger(o, "r2", { kind: "rail-done", rail: "backend" });
    expect(set.rails[1].trigger).toEqual({ kind: "rail-done", rail: "backend" });
    expect(set.rails[0].trigger).toBeUndefined();

    const cleared = setRailTrigger(set, "r2", null);
    expect(cleared.rails[1].trigger).toBeNull();
  });
});

// ---- The surfaces the pure rule needs to work ------------------------------
// None of the three below is reachable from the pure suite, and each is
// silent when it breaks: a rail that arms and never launches, a rail that
// arms and is immediately idled, and a picker whose choice never reaches
// disk.

const SOURCES = import.meta.glob("./*.{ts,svelte}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const STATE = SOURCES["./orchestrationState.ts"];
const DIALOG = SOURCES["./RailBindDialog.svelte"];

describe("executing an arm", () => {
  it("has a branch of its own, ahead of the one that idles a rail", () => {
    // The trap this guards: `complete` used to be the bare `else`, and
    // both actions carry a railId -- so an `arm` added to the union would
    // have type-checked straight into "set this rail idle", silently
    // undoing every trigger.
    expect(STATE).toContain('} else if (action.kind === "arm") {');
    expect(STATE).toContain('} else if (action.kind === "complete") {');
    const arm = STATE.indexOf('action.kind === "arm"');
    const complete = STATE.indexOf('action.kind === "complete"');
    expect(arm).toBeGreaterThan(-1);
    expect(arm).toBeLessThan(complete);
  });

  it("asks for another pass, because the pass that armed it read the rail as idle", () => {
    const from = STATE.indexOf('} else if (action.kind === "arm") {');
    const to = STATE.indexOf('} else if (action.kind === "complete") {', from);
    expect(STATE.slice(from, to)).toContain("again = true;");
  });

  it("re-looks after a rail finishes, since that is what a trigger waits for", () => {
    // `orchestrations` is deliberately not a tick input, so nothing else
    // would say a rail has completed -- and both routes to "this rail is
    // finished now" have to ask: the completion of a running rail, and
    // the reconciling markDone that finishes the last step of an idle one.
    expect(STATE).toContain("function armsItself(orch: Orchestration): boolean {");
    expect(STATE).toContain("return orch.rails.some((r) => r.trigger);");
    expect(STATE.match(/again = armsItself\(orch\) \|\| again;/g)).toHaveLength(2);
  });

  it("looks the moment a condition is written, not at the next unrelated event", () => {
    const fn = STATE.slice(STATE.indexOf("export async function setRailTriggerAction"));
    expect(fn.slice(0, fn.indexOf("\n}"))).toContain("if (!error) await tick(workspaceId);");
  });
});

describe("the dialog's Trigger panel", () => {
  it("is the surface that produces the payload, so it carries the version gate", () => {
    // `trigger` widens SetOrchestration, which min_version_for gates by
    // request TYPE -- so an older daemon takes the write and drops the
    // field, and this entry is the only gate there is.
    expect(DIALOG).toContain('featureBlockedReason($daemonCompat, "railTrigger")');
    expect(DIALOG).toContain("disabled={Boolean(triggerBlocked)}");
    expect(DIALOG).toContain("{triggerBlocked}");
  });

  it("offers the choices from the shared list, never its own copy", () => {
    expect(DIALOG).toContain("{#each RAIL_TRIGGER_CHOICES as choice (choice.kind)}");
  });

  it("says what the condition is doing right now, not only what it is set to", () => {
    // "after all rails" is the same words on a rail that fires in a
    // minute and on the only rail in the workspace, which never will.
    expect(DIALOG).toContain("railTriggerVerdict(orch, rail)");
    expect(DIALOG).toContain('{#if verdict.kind === "broken"}');
  });
});
