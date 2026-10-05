import { describe, expect, it } from "vitest";
import type { Orchestration } from "$lib/orchestration/orchestration";
import { DEMO, sampleState } from "$companion/demo/sampleData";
import { cardsToPlace, railRows, railStateText, type RailsInput } from "$companion/surfaces/phoneRails";

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
