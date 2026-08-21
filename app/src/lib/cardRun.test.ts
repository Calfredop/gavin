import { describe, it, expect } from "vitest";
import {
  composeTaskPrompt,
  composePlanPrompt,
  shellQuote,
  buildRunCommand,
  buildToolCommand,
  runStatusNeeded,
} from "./cardRun";

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

describe("buildToolCommand", () => {
  // The daemon already runs a session command as `sh -c <line>`, so a
  // one-liner needs no wrapping -- only the epilogue.
  it("runs a command tool's body directly", () => {
    const out = buildToolCommand("command", "git push -u origin HEAD", "Push");
    expect(out.split("\n")[0]).toBe("git push -u origin HEAD");
  });

  // A script wants bash, not sh: `[[`, arrays and pipefail must behave
  // as the author wrote them.
  it("runs a script tool's body under bash", () => {
    const out = buildToolCommand("script", "set -e\necho hi", "Deploy");
    expect(out.split("\n")[0]).toBe("bash -c 'set -e");
    expect(out).toContain("bash -c 'set -e\necho hi'");
  });

  it("quotes a script body containing single quotes", () => {
    const out = buildToolCommand("script", "echo 'hi'", "Deploy");
    expect(out).toContain(`bash -c 'echo '\\''hi'\\'''`);
  });

  // The step's verdict IS the exit status (tools spec T5), so the
  // epilogue must not swallow it.
  it("re-raises the body's exit status", () => {
    const out = buildToolCommand("command", "false", "Tests");
    expect(out).toContain("__gavin_code=$?");
    expect(out.endsWith('exit "$__gavin_code"')).toBe(true);
  });

  // A PTY that exits closes its tab at once, so a failure has to say so
  // on screen before it goes.
  it("announces a non-zero exit with the tool's name", () => {
    const out = buildToolCommand("command", "false", "Run tests");
    expect(out).toContain('[ "$__gavin_code" -ne 0 ]');
    expect(out).toContain("'Run tests'");
  });

  it("quotes a tool name containing a single quote", () => {
    expect(buildToolCommand("command", "true", "Bob's tool")).toContain(`'Bob'\\''s tool'`);
  });

  // The format string is SHELL source: it must carry the two characters
  // backslash-n for printf to interpret, not a real newline that happens
  // to print the same thing while splitting the command across lines.
  it("emits a printf escape, not a literal newline, in the format string", () => {
    const out = buildToolCommand("command", "true", "Push");
    const epilogue = out.split("\n").find((l) => l.includes("printf")) as string;
    expect(epilogue).toContain("printf '\\n[gavin] %s exited with code %s\\n'");
  });
});
