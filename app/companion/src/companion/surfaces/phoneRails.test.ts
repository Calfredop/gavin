import { describe, expect, it } from "vitest";
import type { Orchestration } from "$lib/orchestration/orchestration";
import { DEMO, sampleState } from "$companion/demo/sampleData";
import type { Workspace } from "$lib/core/workspace";
import {
  agentPresses,
  cardsToPlace,
  openingRail,
  railRows,
  railStateText,
  type RailRow,
  type RailsInput,
} from "$companion/surfaces/phoneRails";

function atlas(edit?: (orch: Orchestration) => void): RailsInput {
  const state = sampleState();
  const orch = state.orchestrations[DEMO.atlas];
  edit?.(orch);
  return { orch, tree: state.trees[DEMO.atlas], board: state.boards[DEMO.atlas] };
}

describe("a rail's row", () => {
  it("says a running rail is where it is, and offers Pause", () => {
    const [auth] = railRows(atlas());
    expect(auth).toMatchObject({ name: "auth", state: "running", press: "pause", finished: false, stepCount: 2 });
    expect(railStateText(auth)).toBe("running · stage 1");
    expect(auth.stages.map((s) => s.current)).toEqual([true, false]);
    expect(auth.stages[0].steps[0]).toMatchObject({
      title: "Token refresh rework",
      column: "In Progress",
      state: "running",
      sessionId: "s-atlas-auth",
    });
  });

  it("offers Start to an idle rail with work left, and Resume to a paused one", () => {
    const rows = railRows(atlas());
    expect(rows[1]).toMatchObject({ name: "fixes", state: "idle", press: "start" });
    expect(railStateText(rows[1])).toBe("idle");

    const [auth] = railRows(atlas((o) => (o.railRuns[0].state = "paused")));
    expect(auth.press).toBe("resume");
  });

  it("offers nothing to a rail whose every step is done", () => {
    const [, fixes] = railRows(
      atlas((o) => {
        o.stepRuns.push(
          { stepId: "step-flaky-expiry", state: "done", sessionId: null, reason: null },
          { stepId: "step-proration", state: "skipped", sessionId: null, reason: null }
        );
      })
    );
    expect(fixes).toMatchObject({ press: null, finished: true });
    expect(railStateText(fixes)).toBe("finished");
  });

  it("names a stage, says a group's mode, and knows its ends for moving", () => {
    const [auth] = railRows(
      atlas((o) => {
        const stage = o.rails[0].stages[1];
        stage.name = "harden";
        stage.mode = "sequence";
        stage.steps.push({ id: "extra", position: 1, cardPath: `${DEMO.atlasRoot}/.gavin-root/plans/oauth-upgrade.md` });
      })
    );
    expect(auth.stages[1]).toMatchObject({ label: "harden", group: true, mode: "sequence", first: false, last: true });
    expect(auth.stages[0]).toMatchObject({ group: false, first: true, last: false });
  });

  it("carries a stalled step's reason, and titles a step whose card is gone by its file", () => {
    const [auth] = railRows(
      atlas((o) => {
        o.rails[0].stages[1].steps[0].cardPath = `${DEMO.atlasRoot}/.gavin-root/plans/gone.md`;
        o.stepRuns.push({ stepId: "step-rate-limit", state: "stalled", sessionId: null, reason: "card file is missing" });
      })
    );
    expect(auth.stages[1].steps[0]).toMatchObject({ title: "gone.md", column: null, state: "stalled", reason: "card file is missing" });
  });

  it("names a built-in tool step by the tool", () => {
    const [auth] = railRows(
      atlas((o) => {
        o.rails[0].stages[1].steps[0] = { id: "t", position: 0, cardPath: "", toolId: "builtin:commit" };
      })
    );
    expect(auth.stages[1].steps[0]).toMatchObject({ title: "Commit changes", cardPath: null, column: null });
  });
});

describe("the cards a rail can take on", () => {
  it("are the desk picker's: unplaced, runnable, not nested, not done", () => {
    const titles = cardsToPlace(atlas()).map((c) => c.title);
    // On a rail already.
    expect(titles).not.toContain("Token refresh rework");
    expect(titles).not.toContain("Fix the flaky session-expiry test");
    // A note, a nested task, a done plan.
    expect(titles).not.toContain("Ask design about the empty state");
    expect(titles).not.toContain("Rotate refresh tokens on use");
    expect(titles).not.toContain("Audit log export");
    expect(titles).toContain("Upgrade the OAuth library");
    expect(titles).toEqual([...titles].sort((a, b) => a.localeCompare(b)));
  });
});

describe("the rail the surface opens on", () => {
  const row = (id: string, state: RailRow["state"]): RailRow => ({
    id,
    name: id,
    state,
    finished: false,
    press: null,
    trigger: null,
    stages: [],
    stepCount: 0,
  });

  it("is the one running, wherever it sits", () => {
    expect(openingRail([row("a", "idle"), row("b", "paused"), row("c", "running")])).toBe("c");
  });

  it("is one paused on the human when none runs", () => {
    expect(openingRail([row("a", "idle"), row("b", "paused")])).toBe("b");
  });

  it("is the first when nothing moves, and none without rails", () => {
    expect(openingRail([row("a", "idle"), row("b", "idle")])).toBe("a");
    expect(openingRail([])).toBeNull();
  });

  it("is the demo's running rail", () => {
    expect(openingRail(railRows(atlas()))).toBe(railRows(atlas())[0].id);
  });
});

describe("Organize and a rail's Reorganize", () => {
  function workspace(edit?: (ws: Workspace) => void): Workspace {
    const ws = sampleState().workspaces.workspaces.find((w) => w.id === DEMO.atlas)!;
    edit?.(ws);
    return ws;
  }
  const ready = { daemonBlocked: null, unplacedCount: 2 };

  it("start an agent while no run holds the workspace's slot", () => {
    const presses = agentPresses({ workspace: workspace(), ...ready });
    expect(presses.organize.kind).toBe("start");
    expect(presses.organizeLabel).toBe("Organize with agent…");
    expect(presses.reorganize("rail-fixes").kind).toBe("start");
    expect(presses.running).toBe(false);
  });

  it("show the run holding the slot instead of starting a second, from every press", () => {
    const presses = agentPresses({
      workspace: workspace((ws) => {
        ws.orchestrationAgent = { sessionId: "s-run", label: "Reorganize “fixes”", railId: "rail-fixes" };
      }),
      ...ready,
    });
    expect(presses.organize.kind).toBe("jump");
    expect(presses.organizeLabel).toBe("Agent running…");
    expect(presses.reorganize("rail-fixes")).toMatchObject({ kind: "jump", tip: expect.stringContaining("This rail") });
    expect(presses.reorganize("rail-other")).toMatchObject({ kind: "jump", tip: expect.stringContaining("fixes") });
    expect(presses.running).toBe(true);
  });

  it("say why they cannot start: nothing to place, no root, a daemon too old", () => {
    expect(agentPresses({ workspace: workspace(), daemonBlocked: null, unplacedCount: 0 }).organize).toMatchObject({
      kind: "blocked",
      tip: expect.stringContaining("Nothing is left to place"),
    });
    const rootless = agentPresses({ workspace: workspace((ws) => (ws.rootPath = "")), ...ready });
    expect(rootless.organize).toMatchObject({ kind: "blocked", tip: expect.stringContaining("no root folder") });
    expect(rootless.reorganize("rail-fixes").kind).toBe("blocked");
    const old = agentPresses({ workspace: workspace(), daemonBlocked: "Needs a newer daemon", unplacedCount: 2 });
    expect(old.organize).toEqual({ kind: "blocked", tip: "Needs a newer daemon" });
  });
});
