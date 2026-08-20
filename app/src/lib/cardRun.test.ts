import { describe, it, expect } from "vitest";
import { composeTaskPrompt, composePlanPrompt, shellQuote, buildRunCommand, runStatusNeeded } from "./cardRun";

describe("composeTaskPrompt", () => {
  it("wraps the body with the card pointer and the status contract", () => {
    const p = composeTaskPrompt("/p/t.md", "Fix login", "Do the thing.\nCarefully.");
    expect(p).toBe(
      'You are executing the task card at /p/t.md ("Fix login").\n\n' +
        "Do the thing.\nCarefully.\n\n" +
        "While you work, keep this card's status current with gavin_set_plan_field on /p/t.md; " +
        "set it to the board's done column when finished."
    );
  });
});

describe("composePlanPrompt", () => {
  it("points at the file instead of inlining it", () => {
    const p = composePlanPrompt("/p/plan.md");
    expect(p).toBe(
      "Read /p/plan.md and execute that plan. Work its checklist top to bottom: " +
        "tick items (- [x]) as you complete them, promote items that need their own agent " +
        "with gavin_promote_task, and keep the plan's status current with gavin_set_plan_field."
    );
  });
});

describe("shellQuote", () => {
  it("single-quotes and escapes embedded single quotes", () => {
    expect(shellQuote("plain")).toBe("'plain'");
    expect(shellQuote("it's here")).toBe("'it'\\''s here'");
    expect(shellQuote('say "hi"\nnewline \\ backslash')).toBe("'say \"hi\"\nnewline \\ backslash'");
  });
});

describe("buildRunCommand", () => {
  it("appends the quoted prompt to the agent command", () => {
    expect(buildRunCommand("claude", "do it")).toBe("claude 'do it'");
    expect(buildRunCommand("claude --model x", "a'b")).toBe("claude --model x 'a'\\''b'");
  });
});

describe("runStatusNeeded", () => {
  it("is false only when the status already slug-matches In Progress", () => {
    expect(runStatusNeeded("In Progress")).toBe(false);
    expect(runStatusNeeded("in-progress")).toBe(false);
    expect(runStatusNeeded(" IN  PROGRESS ")).toBe(false);
    expect(runStatusNeeded(null)).toBe(true);
    expect(runStatusNeeded("Done")).toBe(true);
    expect(runStatusNeeded("To Do")).toBe(true);
  });
});
