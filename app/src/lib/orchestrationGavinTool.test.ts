import { describe, it, expect } from "vitest";
import { BUILTIN_TOOLS } from "./orchestrationTools";

// The `gavin` tool kind is the one kind with no session behind it, and
// three facts about it are invisible when they break:
//
//   * Every surface that turns a tool kind into an ICON has to know it.
//     A missed ternary falls through to the script icon and the drawer
//     quietly claims Start rail is a bash script.
//   * The launch branches on it BEFORE resolving a checkout. A gavin
//     action touches no worktree, so an unbound rail in a workspace with
//     no root would otherwise stall it on something it never needed.
//   * The step is filed `done` BEFORE the target rail is armed. startRail
//     ticks, and this workspace's tick is already in flight, so the call
//     only queues a replay -- which re-reads this step and would launch
//     it a second time if it were still pending.
//
// Reads the sources rather than the rendered DOM or a live store,
// following orchestrationRunAll.test.ts.

const SOURCES = import.meta.glob("./*.{svelte,ts}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

describe("the gavin tool kind", () => {
  // Every place that picks an icon from a kind. Each used to carry its
  // own ternary, and this asserted the `gavin` arm in three of them;
  // they share one lookup now, so what is pinned is that they still
  // reach for it. WHICH glyph each kind gets, and that no two share one,
  // is ui/toolKindIcon.test.ts -- the glob here does not reach into
  // ./ui, and widening it to read one line would pull the whole folder
  // in as raw text.
  const ICON_SITES = [
    "./OrchestrationDrawer.svelte",
    "./ToolLibraryDialog.svelte",
    "./OrchestrationStepChip.svelte",
    "./WorkspaceToolsHubView.svelte",
  ];

  for (const path of ICON_SITES) {
    it(`${path} draws a tool's icon through the shared lookup`, () => {
      const source = SOURCES[path];
      expect(source, path).toBeTruthy();
      // `toolIcon` since v33, which resolves the tool's OWN icon and
      // falls back to this lookup. A surface calling `toolKindIcon`
      // directly would ignore the human's pick on that one surface --
      // exactly the drift the shared lookup was made to end.
      expect(source).toContain("toolIcon");
    });
  }

  it("is a kind a human can author", () => {
    // TOOL_KINDS drives the edit form's chips. A `gavin` chip was
    // withheld while the body was a free-text box, because a body typed
    // there could name nothing and would stall every step it was dropped
    // onto -- discoverable only at launch. That every kind is on the
    // list is asserted against the TYPE in orchestrationTools.test.ts.
    expect(SOURCES["./orchestrationTools.ts"]).toContain('"gavin",');
  });

  it("draws its body as a select over the actions, never a text box", () => {
    // This is what made the chip safe to offer: the form cannot express
    // an action gavin does not have, so `validateTool`'s refusal is left
    // guarding only a tool a NEWER gavin wrote.
    const editor = SOURCES["./orchestrationTools.ts"];
    expect(editor).toMatch(/case "gavin":[\s\S]{0,120}shape: "action"/);
    const dialog = SOURCES["./ToolLibraryDialog.svelte"];
    expect(dialog).toContain('{:else if bodyEditor.shape === "action"}');
    expect(dialog).toMatch(/#each GAVIN_ACTIONS as action/);
  });

  // A copy has always run correctly -- `executeGavinAction` branches on
  // the kind and reads the body, never on which built-in id it came
  // from -- so the Built-in section offers Duplicate on all sixteen.
  it("offers Duplicate like every other built-in", () => {
    expect(SOURCES["./ToolLibraryDialog.svelte"]).not.toContain("gavin's own");
  });
});

describe("running a gavin action", () => {
  const source = SOURCES["./orchestrationState.ts"];
  // Bounded by the function's own closing brace, so a declaration moving
  // in after it cannot silently widen what these assertions read.
  const start = source.indexOf("async function executeGavinAction");
  const action = source.slice(start, source.indexOf("\n}\n", start) + 2);

  it("branches on the kind before resolving a checkout", () => {
    const branch = source.indexOf('if (tool.kind === "gavin")');
    const cwd = source.indexOf("no worktree bound and the workspace has no root");
    expect(branch).toBeGreaterThan(-1);
    expect(cwd).toBeGreaterThan(-1);
    expect(branch).toBeLessThan(cwd);
  });

  it("files the step done before arming the target rail", () => {
    const done = action.indexOf('setStepRunAction(workspaceId, step.id, "done", null, null)');
    const start = action.indexOf("await startRail(workspaceId, verdict.railId)");
    expect(done).toBeGreaterThan(-1);
    expect(start).toBeGreaterThan(-1);
    expect(done).toBeLessThan(start);
  });

  it("starts nothing on a verdict that is not a start", () => {
    expect(action).toContain('if (verdict.kind === "start") await startRail');
  });

  // Nothing else ever ticks for this step. Every other launch leaves a
  // session whose exit or status wakes the scheduler; `orchestrations` is
  // deliberately not a scheduler input, so the done-write raises nothing.
  // Without the re-tick the rail would advance only on some unrelated
  // event -- and the noop verdicts, which do not even call startRail,
  // would raise nothing at all.
  it("asks the tick to run again once the step is resolved", () => {
    expect(action).toContain("Promise<boolean>");
    expect(action.trimEnd().endsWith("return true;\n}")).toBe(true);
    // and the launch path carries it up to executeActions
    expect(source).toContain("return await executeGavinAction(workspaceId, rail, step, tool);");
    expect(source).toContain(
      "again = (await executeLaunch(workspaceId, action.stepId)) || again;"
    );
  });

  // No session, so nothing ever reports an exit code or a status for it:
  // a `gavin` step that reached `running` would sit there forever, and
  // the daemon refuses every plan write that drops a running step.
  it("never leaves the step running", () => {
    expect(action).not.toContain('"running"');
    expect(action).not.toContain("createSessionOnPage");
  });
});

describe("the Start rail built-in", () => {
  it("is the only gavin tool shipped", () => {
    expect(BUILTIN_TOOLS.filter((t) => t.kind === "gavin").map((t) => t.id)).toEqual([
      "builtin:start-rail",
    ]);
  });
});
