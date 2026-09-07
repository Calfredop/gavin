import { describe, it, expect } from "vitest";
import {
  DEFAULT_UNTIL_MAX,
  REASON_TAIL_LINES,
  RETRY_TAIL_LINES,
  UNTIL_MAX_CEILING,
  UNTIL_TOOL_ID,
  buildUntilScript,
  checkTail,
  exhaustedReason,
  flatSteps,
  isUntilStep,
  loopingUntilStep,
  railRetryLabel,
  retryLabel,
  retryLogFor,
  retryPromptPrefix,
  stageIdOfStep,
  stepAfter,
  stepBefore,
  untilLogPath,
  untilLogPathIn,
  setTempRoot,
  untilMax,
  untilVerdict,
  withRetryPrefix,
} from "./orchestrationLoop";
import { nextActions } from "./orchestration";
import type { Orchestration, Rail, ToolSummary } from "./orchestration";
import { BUILTIN_TOOLS, findTool } from "./orchestrationTools";
import type { Board } from "./kanban";

// ---- fixtures ---------------------------------------------------------------

const BOARD: Board = {
  columns: [
    { id: "c0", name: "To Do", position: 0 },
    { id: "c1", name: "Done", position: 1 },
  ],
  labels: [],
  cardSessions: [],
};

const UNTIL = findTool(BUILTIN_TOOLS, UNTIL_TOOL_ID)!;
const WORK_TOOL = "builtin:commit";

/// A rail of two stages: some work, then the check that guards it.
function loopRail(untilParams: Record<string, string> = {}): Rail {
  return {
    id: "r1",
    name: "r1",
    position: 0,
    worktreePath: null,
    pageId: null,
    stages: [
      {
        id: "r1-s0",
        position: 0,
        steps: [{ id: "work", position: 0, cardPath: "", toolId: WORK_TOOL, toolParams: {} }],
      },
      {
        id: "r1-s1",
        position: 1,
        steps: [
          { id: "check", position: 0, cardPath: "", toolId: UNTIL_TOOL_ID, toolParams: untilParams },
        ],
      },
    ],
  };
}

const TOOLS: ToolSummary[] = [
  { id: WORK_TOOL, name: "Commit changes", kind: "agent" },
  { id: UNTIL.id, name: UNTIL.name, kind: UNTIL.kind, params: UNTIL.params },
];

const KINDS = new Map(TOOLS.map((t) => [t.id, t.kind]));

/// The rail mid-run: the work is done and the check is running as
/// session `sess`.
function checking(
  rail: Rail,
  sess: string,
  attempts: number | null = null
): Orchestration {
  return {
    rails: [rail],
    conflictNotes: [],
    railRuns: [{ railId: "r1", state: "running", currentStageId: "r1-s1" }],
    stepRuns: [
      { stepId: "work", state: "done", sessionId: "sw", reason: null },
      {
        stepId: "check",
        state: "running",
        sessionId: sess,
        reason: null,
        resumeAttempts: attempts,
      },
    ],
  };
}

/// What the scheduler decides about a check session that has ended with
/// `code`. The session is not in the live set, which is what "ended"
/// means to nextActions.
function decide(orch: Orchestration, sess: string, code: number) {
  return nextActions(orch, BOARD, undefined, [], new Set(), TOOLS, new Map([[sess, code]]));
}

// ---- the parameters ---------------------------------------------------------

describe("untilMax", () => {
  it("is the tool's own default when the step overrides nothing", () => {
    expect(untilMax(UNTIL, {})).toBe(5);
  });

  it("is the step's override when it has one", () => {
    expect(untilMax(UNTIL, { max: "2" })).toBe(2);
  });

  // A typo in a text field must never turn a loop into a step that gives
  // up on its first failure -- which is what reading "" or "five" as 0
  // would do.
  it.each(["", "  ", "five", "0", "-3", "2.7.1"])("falls back to the default for %o", (raw) => {
    expect(untilMax(UNTIL, { max: raw })).toBe(DEFAULT_UNTIL_MAX);
  });

  it("caps whatever the human types", () => {
    expect(untilMax(UNTIL, { max: "1000" })).toBe(UNTIL_MAX_CEILING);
  });

  // An override for a parameter the tool no longer declares must not
  // outlive it -- the same answer resolveToolParam gives.
  it("ignores an override for a parameter the tool does not declare", () => {
    expect(untilMax({ params: [] }, { max: "2" })).toBe(DEFAULT_UNTIL_MAX);
    expect(untilMax(undefined, { max: "2" })).toBe(DEFAULT_UNTIL_MAX);
  });
});

// ---- the check's output -----------------------------------------------------

describe("buildUntilScript", () => {
  const script = buildUntilScript("npm test", "/tmp/gavin-until-x.log");

  // Without pipefail the pipeline's status is tee's, which is 0 -- so
  // every check would pass and no loop would ever run.
  it("takes the CHECK's exit status, not tee's", () => {
    expect(script).toContain("set -o pipefail");
  });

  it("keeps the output on screen while copying it to the log", () => {
    expect(script).toContain("| tee '/tmp/gavin-until-x.log'");
    expect(script).toContain("2>&1");
  });

  // A check may be several commands; without the group only the last
  // one's output would be redirected.
  it("groups a multi-line check so the whole thing is captured", () => {
    const multi = buildUntilScript("npm run lint\nnpm test", "/tmp/l.log");
    expect(multi).toContain("{\nnpm run lint\nnpm test\n}");
  });

  it("quotes the log path", () => {
    expect(buildUntilScript("x", "/tmp/a b.log")).toContain("tee '/tmp/a b.log'");
  });
});

describe("untilLogPath", () => {
  it("is derived from the step id, so nothing has to be remembered", () => {
    expect(untilLogPath("abc-123")).toBe("/tmp/gavin-until-abc-123.log");
    expect(untilLogPath("abc-123")).toBe(untilLogPath("abc-123"));
  });

  it("keeps a hand-edited id out of the shell", () => {
    expect(untilLogPath("a b;rm -rf /")).toBe("/tmp/gavin-until-abrm-rf.log");
  });

  it("hangs off the temp directory the host names, not a hardcoded /tmp", () => {
    // The Windows bug this parameter exists for: Git Bash maps `/tmp` to
    // %TEMP% when the check writes the file, while a read of `/tmp` from
    // the app looks for C:\tmp -- two names for what has to be one file.
    expect(untilLogPathIn("C:/Users/ada/AppData/Local/Temp", "check")).toBe(
      "C:/Users/ada/AppData/Local/Temp/gavin-until-check.log"
    );
    // However the host spelled it, and whatever it left on the end.
    expect(untilLogPathIn("C:\\Users\\ada\\Temp\\", "check")).toBe(
      "C:\\Users\\ada\\Temp/gavin-until-check.log"
    );
    expect(untilLogPathIn("/tmp/", "check")).toBe("/tmp/gavin-until-check.log");
  });

  it("uses /tmp until the host says otherwise, and blank never says otherwise", () => {
    setTempRoot("   ");
    expect(untilLogPath("check")).toBe("/tmp/gavin-until-check.log");
    setTempRoot("/var/folders/xx/T");
    expect(untilLogPath("check")).toBe("/var/folders/xx/T/gavin-until-check.log");
    setTempRoot("/tmp");
  });
});

describe("checkTail", () => {
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");

  it("keeps the last lines, in order", () => {
    expect(checkTail(lines(50))).toBe(
      Array.from({ length: RETRY_TAIL_LINES }, (_, i) => `line ${50 - RETRY_TAIL_LINES + i + 1}`).join("\n")
    );
  });

  it("keeps a short output whole", () => {
    expect(checkTail("one\ntwo")).toBe("one\ntwo");
  });

  it("drops the trailing newline a shell always leaves", () => {
    expect(checkTail("boom\n\n\n")).toBe("boom");
  });

  it("is empty for nothing, so callers can treat it as 'nothing to quote'", () => {
    expect(checkTail("")).toBe("");
    expect(checkTail("   \n \n")).toBe("");
  });

  it("takes a shorter tail on request, for the stall reason", () => {
    expect(checkTail(lines(50), REASON_TAIL_LINES).split("\n")).toHaveLength(REASON_TAIL_LINES);
  });
});

// ---- the prompt prefix ------------------------------------------------------

describe("the retry prompt", () => {
  it("opens with the failure, fenced, and an instruction", () => {
    expect(retryPromptPrefix("FAIL src/x.test.ts")).toBe(
      "The previous attempt failed this check:\n" +
        "```\n" +
        "FAIL src/x.test.ts\n" +
        "```\n" +
        "Fix it, then finish."
    );
  });

  it("quotes only the tail of a long run", () => {
    const long = Array.from({ length: 100 }, (_, i) => `l${i}`).join("\n");
    const prefix = retryPromptPrefix(long);
    expect(prefix).toContain("l99");
    expect(prefix).not.toContain("l50\n");
  });

  it("goes in front of the step's own prompt, separated by a blank line", () => {
    expect(withRetryPrefix("Do the card.", "boom")).toBe(
      `${retryPromptPrefix("boom")}\n\nDo the card.`
    );
  });

  // The common case, and the one that must stay byte-identical: this
  // function is on the launch path of every card step in the app.
  it("leaves the prompt untouched when this launch is not a retry", () => {
    expect(withRetryPrefix("Do the card.", null)).toBe("Do the card.");
    expect(withRetryPrefix("Do the card.", "")).toBe("Do the card.");
    expect(withRetryPrefix("Do the card.", "  \n ")).toBe("Do the card.");
  });
});

describe("exhaustedReason", () => {
  it("says how many tries it took and quotes the last of them", () => {
    expect(exhaustedReason(5, "1 failing test")).toBe(
      "the check still failed after 5 retries — 1 failing test"
    );
  });

  it("counts one retry in the singular", () => {
    expect(exhaustedReason(1, "boom")).toContain("after 1 retry");
  });

  it("stands alone when the check said nothing", () => {
    expect(exhaustedReason(3, "")).toBe("the check still failed after 3 retries");
  });
});

describe("retryLabel", () => {
  it("reads as the rail header shows it", () => {
    expect(retryLabel(2, 5)).toBe("retry 2 of 5");
  });
});

// ---- walking the rail -------------------------------------------------------

describe("walking a rail", () => {
  const rail = loopRail();

  it("orders steps the way the rail runs them", () => {
    expect(flatSteps(rail).map((s) => s.id)).toEqual(["work", "check"]);
  });

  it("finds the step before and after one", () => {
    expect(stepBefore(rail, "check")?.id).toBe("work");
    expect(stepAfter(rail, "work")?.id).toBe("check");
  });

  // An until step first on its rail has nothing to send the rail back
  // to, and says so rather than looping over itself.
  it("has nothing before the first step", () => {
    expect(stepBefore(rail, "work")).toBeNull();
    expect(stepAfter(rail, "check")).toBeNull();
  });

  it("names the stage a step sits in", () => {
    expect(stageIdOfStep(rail, "work")).toBe("r1-s0");
    expect(stageIdOfStep(rail, "nope")).toBeNull();
  });

  it("recognises an until step by its tool's KIND, never its id", () => {
    const check = flatSteps(rail)[1];
    expect(isUntilStep(check, KINDS)).toBe(true);
    expect(isUntilStep(flatSteps(rail)[0], KINDS)).toBe(false);
    // A duplicate under another id loops for the same reason this one
    // does -- which is what makes this a kind rather than a branch.
    const clone = { ...check, toolId: "custom-uuid" };
    expect(isUntilStep(clone, new Map([["custom-uuid", "until" as const]]))).toBe(true);
  });

  // Null tools is "the library has not loaded", the same cold-start rule
  // launchBlocker follows -- it must not read as a decision.
  it("decides nothing while the library is still loading", () => {
    expect(isUntilStep(flatSteps(rail)[1], null)).toBe(false);
  });
});

// ---- the verdict ------------------------------------------------------------

describe("untilVerdict", () => {
  const base = { attempts: 0, max: 5, previousStepId: "work" };

  it("passes on exit 0", () => {
    expect(untilVerdict({ ...base, exitCode: 0 })).toEqual({ kind: "pass" });
  });

  // Nobody saw the exit, so the caller falls back to the rule it already
  // had for that: a stall, never a pass.
  it("says so when nobody witnessed the exit", () => {
    expect(untilVerdict({ ...base, exitCode: undefined })).toEqual({ kind: "unwitnessed" });
  });

  it("retries a failure with budget left, counting from one", () => {
    expect(untilVerdict({ ...base, exitCode: 1 })).toEqual({
      kind: "retry",
      previousStepId: "work",
      attempt: 1,
      max: 5,
    });
    expect(untilVerdict({ ...base, exitCode: 1, attempts: 3 })).toMatchObject({ attempt: 4 });
  });

  it("gives up on the attempt that would exceed the budget", () => {
    expect(untilVerdict({ ...base, exitCode: 1, attempts: 4 })).toMatchObject({ kind: "retry" });
    expect(untilVerdict({ ...base, exitCode: 1, attempts: 5 })).toEqual({
      kind: "exhausted",
      max: 5,
    });
    // A count past the budget -- a hand-edited row, a lowered max -- is
    // still spent, never a fresh start.
    expect(untilVerdict({ ...base, exitCode: 1, attempts: 99 })).toMatchObject({
      kind: "exhausted",
    });
  });

  it("reads an absent count as none spent", () => {
    expect(untilVerdict({ ...base, exitCode: 1, attempts: null })).toMatchObject({ attempt: 1 });
    expect(untilVerdict({ ...base, exitCode: 1, attempts: undefined })).toMatchObject({
      attempt: 1,
    });
  });

  it("is stuck, not looping, when nothing runs before it", () => {
    expect(untilVerdict({ ...base, exitCode: 1, previousStepId: null })).toEqual({
      kind: "stuck",
      reason: "nothing runs before this step, so the check has nothing to send the rail back to",
    });
  });
});

// ---- what the rail says while it loops --------------------------------------

describe("the rail header's retry line", () => {
  const looping = (attempt: number, params: Record<string, string> = {}): Orchestration => ({
    rails: [loopRail(params)],
    conflictNotes: [],
    railRuns: [{ railId: "r1", state: "running", currentStageId: "r1-s0" }],
    stepRuns: [
      { stepId: "work", state: "running", sessionId: "s2", reason: null },
      { stepId: "check", state: "pending", sessionId: null, reason: null, resumeAttempts: attempt },
    ],
  });

  it("counts the retry against the budget", () => {
    expect(railRetryLabel(loopRail(), looping(2), TOOLS)).toBe("retry 2 of 5");
    expect(railRetryLabel(loopRail({ max: "3" }), looping(1, { max: "3" }), TOOLS)).toBe(
      "retry 1 of 3"
    );
  });

  // A loop is a state a rail passes through, not one it sits in. A badge
  // that were always there would say nothing.
  it("is absent when nothing is looping", () => {
    const fresh = checking(loopRail(), "s2");
    expect(railRetryLabel(loopRail(), fresh, TOOLS)).toBeNull();
    expect(loopingUntilStep(loopRail(), fresh, KINDS)).toBeNull();
  });

  it("is absent while the library is loading", () => {
    expect(railRetryLabel(loopRail(), looping(2), null)).toBeNull();
  });
});

// The launch reads this instead of a note held in a variable, which is
// what lets a loop survive an app reload mid-retry.
describe("retryLogFor", () => {
  const looping: Orchestration = {
    rails: [loopRail()],
    conflictNotes: [],
    railRuns: [{ railId: "r1", state: "running", currentStageId: "r1-s0" }],
    stepRuns: [
      { stepId: "work", state: "pending", sessionId: null, reason: null },
      { stepId: "check", state: "pending", sessionId: null, reason: null, resumeAttempts: 1 },
    ],
  };

  it("points the re-armed step at the check that failed", () => {
    expect(retryLogFor(loopRail(), "work", looping, KINDS)).toBe(untilLogPath("check"));
  });

  it("says nothing on a first run, where no check has failed yet", () => {
    const first: Orchestration = {
      ...looping,
      stepRuns: [
        { stepId: "work", state: "pending", sessionId: null, reason: null },
        { stepId: "check", state: "pending", sessionId: null, reason: null, resumeAttempts: 0 },
      ],
    };
    expect(retryLogFor(loopRail(), "work", first, KINDS)).toBeNull();
  });

  it("says nothing once the check has passed", () => {
    const passed: Orchestration = {
      ...looping,
      stepRuns: [
        { stepId: "work", state: "done", sessionId: null, reason: null },
        { stepId: "check", state: "done", sessionId: null, reason: null, resumeAttempts: 2 },
      ],
    };
    expect(retryLogFor(loopRail(), "work", passed, KINDS)).toBeNull();
  });

  it("says nothing for a step no until step follows", () => {
    expect(retryLogFor(loopRail(), "check", looping, KINDS)).toBeNull();
  });
});

// ---- the scheduler ----------------------------------------------------------

describe("a loop-until step on a running rail", () => {
  it("passes: the check exits 0, the step is done and the rail finishes", () => {
    const actions = decide(checking(loopRail(), "s2"), "s2", 0);
    expect(actions).toEqual([
      { kind: "markDone", stepId: "check" },
      { kind: "complete", railId: "r1" },
    ]);
  });

  it("sends the rail back over the step before it when the check fails", () => {
    expect(decide(checking(loopRail(), "s2"), "s2", 1)).toEqual([
      { kind: "loopBack", stepId: "check", previousStepId: "work", attempt: 1, max: 5 },
    ]);
  });

  // The whole point of the tool. A stall would pause the rail (rule 5),
  // which is a rail that never retries anything.
  it("neither stalls the step nor pauses the rail while it has budget", () => {
    const actions = decide(checking(loopRail(), "s2"), "s2", 1);
    expect(actions.some((a) => a.kind === "stall")).toBe(false);
    expect(actions.some((a) => a.kind === "advance" || a.kind === "complete")).toBe(false);
  });

  it("counts each round against the budget", () => {
    expect(decide(checking(loopRail(), "s2", 3), "s2", 1)).toEqual([
      { kind: "loopBack", stepId: "check", previousStepId: "work", attempt: 4, max: 5 },
    ]);
  });

  it("honours the step's own budget over the tool's default", () => {
    const rail = loopRail({ max: "2" });
    expect(decide(checking(rail, "s2", 1), "s2", 1)).toMatchObject([{ max: 2, attempt: 2 }]);
    expect(decide(checking(rail, "s2", 2), "s2", 1)).toEqual([
      { kind: "loopExhausted", stepId: "check", max: 2 },
    ]);
  });

  it("gives up once the budget is spent", () => {
    expect(decide(checking(loopRail(), "s2", 5), "s2", 1)).toEqual([
      { kind: "loopExhausted", stepId: "check", max: 5 },
    ]);
  });

  // An unwitnessed exit is the one case that falls back to the rule
  // every tool step already had: nobody saw the check, so nobody may
  // call it a pass.
  it("stalls rather than looping when nobody saw the check end", () => {
    const actions = nextActions(
      checking(loopRail(), "s2"),
      BOARD,
      undefined,
      [],
      new Set(),
      TOOLS,
      new Map()
    );
    expect(actions).toEqual([
      {
        kind: "stall",
        stepId: "check",
        reason: `${UNTIL.name}'s session ended while gavin was not watching`,
      },
    ]);
  });

  // Looping is something a rail does while it is ADVANCING. Re-arming a
  // step under a rail nobody started would launch work out of nowhere.
  it("does not loop on a rail that is not running", () => {
    const idle: Orchestration = {
      ...checking(loopRail(), "s2"),
      railRuns: [{ railId: "r1", state: "paused", currentStageId: "r1-s1" }],
    };
    expect(nextActions(idle, BOARD, undefined, [], new Set(), TOOLS, new Map([["s2", 1]]))).toEqual([
      { kind: "stall", stepId: "check", reason: `${UNTIL.name} exited with code 1` },
    ]);
  });
});

// The sequence the feature exists for, walked one tick at a time with
// the executor's writes applied by hand.
describe("fail, then pass", () => {
  it("re-runs the work, re-runs the check, and completes", () => {
    const rail = loopRail();

    // 1. The check fails.
    const first = decide(checking(rail, "s2"), "s2", 1);
    expect(first).toEqual([
      { kind: "loopBack", stepId: "check", previousStepId: "work", attempt: 1, max: 5 },
    ]);

    // 2. executeLoopBack: both steps pending, the count on the check's
    //    row, the rail pointed back at the work's stage.
    const rearmed: Orchestration = {
      rails: [rail],
      conflictNotes: [],
      railRuns: [{ railId: "r1", state: "running", currentStageId: "r1-s0" }],
      stepRuns: [
        { stepId: "work", state: "pending", sessionId: null, reason: null },
        {
          stepId: "check",
          state: "pending",
          sessionId: null,
          reason: null,
          resumeAttempts: 1,
        },
      ],
    };
    expect(railRetryLabel(rail, rearmed, TOOLS)).toBe("retry 1 of 5");
    expect(
      nextActions(rearmed, BOARD, undefined, [], new Set(), TOOLS, new Map())
    ).toEqual([{ kind: "launch", stepId: "work" }]);

    // 3. The work's second attempt ends its turn; the rail advances and
    //    the check runs again.
    const reworked: Orchestration = {
      ...rearmed,
      stepRuns: [
        { stepId: "work", state: "running", sessionId: "s3", reason: null },
        { ...rearmed.stepRuns[1] },
      ],
    };
    expect(
      nextActions(
        reworked,
        BOARD,
        undefined,
        [],
        new Set(["s3"]),
        TOOLS,
        new Map(),
        new Map([["s3", "idle" as const]])
      )
    ).toEqual([
      { kind: "markDone", stepId: "work" },
      { kind: "advance", railId: "r1", stageId: "r1-s1" },
      { kind: "launch", stepId: "check" },
    ]);

    // 4. The second check passes. The count is NOT reset here -- every
    //    path that runs the step again (Reset, Retry, an exhausted
    //    stall) writes 0 for itself.
    const rechecked = checking(rail, "s4", 1);
    expect(decide(rechecked, "s4", 0)).toEqual([
      { kind: "markDone", stepId: "check" },
      { kind: "complete", railId: "r1" },
    ]);
  });
});

// ---- the wiring the pure module cannot see ----------------------------------
// Read from the sources, following orchestrationGavinTool.test.ts: these
// are one-line decisions whose failure mode is silent.

const SOURCES = import.meta.glob("./*.{svelte,ts}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

describe("the until step's wiring", () => {
  it("ships as a built-in, so it is in the + Add step picker's Tools list", () => {
    expect(BUILTIN_TOOLS.some((t) => t.id === UNTIL_TOOL_ID)).toBe(true);
    // The picker renders the WHOLE library rather than a chosen subset,
    // which is what makes shipping the tool enough.
    expect(SOURCES["./OrchestrationHubView.svelte"]).toContain("{#each tools as tool (tool.id)}");
    expect(SOURCES["./OrchestrationHubView.svelte"]).toContain(
      "void addToolAsStepAction(workspaceId, railId, tool.id)"
    );
  });

  it("declares both parameters the scheduler and the shell need", () => {
    expect(UNTIL.params.map((p) => p.name)).toEqual(["check", "max"]);
    expect(UNTIL.body).toBe("{{check}}");
  });

  // The check is a shell session in the rail's page like any other tool
  // step -- not a hidden probe.
  it("runs the check as a visible session, through the rail's page", () => {
    const source = SOURCES["./orchestrationState.ts"];
    expect(source).toContain(
      'buildToolCommand("script", buildUntilScript(body, untilLogPath(step.id)), tool.name)'
    );
    expect(source).toContain("createSessionOnRailPage(workspaceId, rail.id, cwd, command)");
  });

  // The budget lives in `resumeAttempts` on the run row. Every other
  // launch zeroes that field, and zeroing it here would make the budget
  // unspendable and the loop unbounded.
  it("preserves the loop budget across the check's own relaunches", () => {
    expect(SOURCES["./orchestrationState.ts"]).toContain('tool.kind === "until" ? null : 0');
  });

  // ...and the two paths that mean "start over" clear it, since no
  // launch will. (The third, an exhausted stall, has a test of its own
  // in orchestrationState.test.ts, where the write is observable.)
  it("clears the budget wherever a run starts over", () => {
    const source = SOURCES["./orchestrationState.ts"];
    const body = (name: string) => {
      const at = source.indexOf(`export async function ${name}(`);
      expect(at, name).toBeGreaterThan(-1);
      return source.slice(at, source.indexOf("\n}\n", at));
    };
    expect(body("resetRail")).toContain('"pending", null, null, null, null, 0)');
    expect(body("retryStep")).toContain('"pending", null, null, null, null, 0)');
  });

  // The reverse of what this asserted until 2026-09-04. What kept `until`
  // off the chips was never the scheduler -- every rule about the loop
  // branches on the KIND, so an authored one has always looped -- it was
  // the edit form, which had one body field and would have handed back a
  // plain command. `toolBodyEditor` gives the kind its own, so the chip
  // is offered and the field it opens says Check command.
  it("is a kind a human can author, with a body field of its own", () => {
    // The membership itself is asserted against the TYPE in
    // orchestrationTools.test.ts ("leaves no kind unauthorable"); what
    // this pins is the two halves that make the chip usable.
    expect(SOURCES["./orchestrationTools.ts"]).toContain('"until",');
    expect(SOURCES["./orchestrationTools.ts"]).toContain('label: "Check command"');
    expect(SOURCES["./ToolLibraryDialog.svelte"]).toContain("toolBodyEditor(editing.kind)");
  });

  // Its budget is an ARGUMENT rather than text pasted into the body, and
  // `summaryParam` ignores a param the tool does not declare -- so a
  // budget typed into `retries` reads as no budget rather than as an
  // error. The form has to say the name.
  it("tells an author what its parameters are called", () => {
    expect(SOURCES["./orchestrationTools.ts"]).toMatch(/case "until":[\s\S]{0,200}`max`/);
    expect(SOURCES["./ToolLibraryDialog.svelte"]).toContain("toolKindParamNote(editing.kind)");
  });

  // The four sites that draw a tool by its kind used to carry a private
  // ternary each, and this asserted the `until` arm in three of them.
  // They now share `toolKindIcon`, so what is worth pinning is that they
  // still go through it -- which glyph each kind gets, and that no two
  // share one, is ui/toolKindIcon.test.ts.
  for (const path of [
    "./OrchestrationDrawer.svelte",
    "./ToolLibraryDialog.svelte",
    "./OrchestrationStepChip.svelte",
    "./WorkspaceToolsHubView.svelte",
  ]) {
    it(`${path} draws a tool's icon from its kind`, () => {
      expect(SOURCES[path], path).toContain("toolKindIcon");
    });
  }

});
