import { describe, it, expect } from "vitest";
import {
  NAME_TAB_FIRST,
  composeTaskPrompt,
  composePlanPrompt,
  composeResumeTaskPrompt,
  composeResumePlanPrompt,
  composeDevelopPrompt,
  shellQuote,
  buildRunCommand,
  buildHeadlessCommand,
  COMMIT_PROMPT,
  buildToolCommand,
  runStatusNeeded,
  developAvailable,
  provisionalSessionName,
} from "./cardRun";

describe("composeTaskPrompt", () => {
  it("wraps the body with the card pointer and the status contract", () => {
    const p = composeTaskPrompt("/p/t.md", "Fix login", "Do the thing.\nCarefully.");
    expect(p).toBe(
      `${NAME_TAB_FIRST}\n\n` +
        'You are executing the task card at /p/t.md ("Fix login").\n\n' +
        "Do the thing.\nCarefully.\n\n" +
        "While you work, keep this card's status current with gavin_set_plan_field on /p/t.md; " +
        "set it to the board's done column when finished."
    );
  });
});

describe("attachments in the composed prompts", () => {
  const files = ["/ws/docs/spec.md", "/Users/x/shot.png"];

  it("a task prompt lists them before the body, told to be read first", () => {
    const p = composeTaskPrompt("/p/t.md", "Fix login", "Do the thing.", files);
    expect(p).toContain("- /ws/docs/spec.md");
    expect(p).toContain("- /Users/x/shot.png");
    // Context FOR the body, so it precedes it.
    expect(p.indexOf("/ws/docs/spec.md")).toBeLessThan(p.indexOf("Do the thing."));
  });

  it("a plan prompt carries them too", () => {
    expect(composePlanPrompt("/p/plan.md", files)).toContain("- /ws/docs/spec.md");
  });

  it("both resume prompts carry them — it is the same card", () => {
    expect(composeResumeTaskPrompt("/p/t.md", "T", "b", files)).toContain("- /ws/docs/spec.md");
    expect(composeResumePlanPrompt("/p/plan.md", files)).toContain("- /ws/docs/spec.md");
  });

  it("no attachments leaves every prompt byte-identical to before the field existed", () => {
    expect(composeTaskPrompt("/p/t.md", "T", "b", [])).toBe(composeTaskPrompt("/p/t.md", "T", "b"));
    expect(composePlanPrompt("/p/plan.md", [])).toBe(composePlanPrompt("/p/plan.md"));
    expect(composeTaskPrompt("/p/t.md", "T", "b")).not.toContain("attached to this card");
  });
});

describe("composePlanPrompt", () => {
  it("points at the file instead of inlining it", () => {
    const p = composePlanPrompt("/p/plan.md");
    expect(p).toBe(
      `${NAME_TAB_FIRST}\n\n` +
        "Read /p/plan.md and execute that plan. Work its checklist top to bottom: " +
        "tick items (- [x]) as you complete them, promote items that need their own agent " +
        "with gavin_promote_task, and keep the plan's status current with gavin_set_plan_field."
    );
  });
});

describe("resume prompts", () => {
  it("send the task's agent to the skill, keep the body, keep the status contract", () => {
    const p = composeResumeTaskPrompt("/p/t.md", "Fix login", "Do the thing.");
    expect(p).toBe(
      `${NAME_TAB_FIRST}\n\n` +
        'Use the gavin-resume skill to resume the task card at /p/t.md ("Fix login"). ' +
        "Work on it already started and stopped.\n\n" +
        "Do the thing.\n\n" +
        "Find what is already done before you write anything, then carry on from there. " +
        "Keep this card's status current with gavin_set_plan_field on /p/t.md; " +
        "set it to the board's done column when finished."
    );
  });

  it("point the plan's agent at the file and at the ticks already there", () => {
    const p = composeResumePlanPrompt("/p/plan.md");
    expect(p).toContain("Use the gavin-resume skill to resume the plan at /p/plan.md.");
    expect(p).toContain("find what is already done before you write anything");
    expect(p).toContain("gavin_promote_task");
    expect(p).toContain("gavin_set_plan_field");
    // Never inlines the body -- the plan file is the agent's to read.
    expect(p).not.toContain("You are executing");
  });
});

describe("composeDevelopPrompt", () => {
  // Develop is the To Do counterpart of Resume: same shape -- skill
  // pointer, what makes THIS job different, then the contract -- and one
  // composer for both kinds, because the skill's first move is to read
  // the card whatever it is.
  it("names every shape and the kind, and forbids writing before approval", () => {
    const p = composeDevelopPrompt("/p/t.md", "Fix login");
    expect(p).toBe(
      `${NAME_TAB_FIRST}\n\n` +
        'Use the gavin-develop skill on the card at /p/t.md ("Fix login"): develop it into ' +
        "work an agent can execute — a checklist, nested task cards, both, or, when it is " +
        "really one sitting, a sharper prompt — and set the card's kind to match what you " +
        "wrote.\n\n" +
        "Interview me in this tab before you decide anything, and write nothing to the card " +
        "until I approve what you propose. Leave the card's status where it is: developing a " +
        "card is not starting it."
    );
  });

  // The small shape has to be ON the prompt, not only in the skill: this
  // line is what an agent reads first, and one that offers checklists and
  // child cards only has already decided the card was big. Same for the
  // kind -- a developed card whose `kind:` was left behind runs with the
  // wrong prompt of the two (cardRunActions branches on it), and nothing
  // on the board says so.
  it("leaves room for a card that was never big, and orders the kind set", () => {
    const p = composeDevelopPrompt("/p/t.md", "Fix login");
    expect(p).toContain("one sitting, a sharper prompt");
    expect(p).toContain("set the card's kind to match");
  });

  // The card's body is the seed idea, not a prompt to execute: inlining
  // it is what makes an agent start building instead of interviewing.
  it("never inlines the body or orders the work done", () => {
    const p = composeDevelopPrompt("/p/t.md", "Fix login");
    expect(p).not.toContain("You are executing");
    expect(p).not.toContain("execute that plan");
    expect(p).not.toContain("done column");
  });
});

describe("every launched prompt", () => {
  it("opens by ordering the agent to name its tab", () => {
    // Board Run, board Resume and an orchestration launch all compose
    // through these four -- naming the tab is not optional for any of them.
    for (const p of [
      composeTaskPrompt("/p/t.md", "T", "b"),
      composePlanPrompt("/p/plan.md"),
      composeResumeTaskPrompt("/p/t.md", "T", "b"),
      composeResumePlanPrompt("/p/plan.md"),
      composeDevelopPrompt("/p/t.md", "T"),
    ]) {
      expect(p.startsWith(NAME_TAB_FIRST)).toBe(true);
      expect(p).toContain("gavin_name_session");
    }
  });
});

describe("provisionalSessionName", () => {
  it("collapses whitespace so a wrapped title cannot widen the tab bar", () => {
    expect(provisionalSessionName("  Fix   the\n login  flow ")).toBe("Fix the login flow");
  });

  it("caps at the same 40 characters gavin-mcp's clean_session_name does", () => {
    const long = "a".repeat(60);
    expect(provisionalSessionName(long)).toBe("a".repeat(40) + "\u2026");
    expect(provisionalSessionName("b".repeat(40))).toBe("b".repeat(40));
  });

  it("returns null for a title with nothing in it, rather than naming a tab \"\"", () => {
    expect(provisionalSessionName("   ")).toBeNull();
    expect(provisionalSessionName("")).toBeNull();
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

describe("buildHeadlessCommand", () => {
  it("puts the profile's headless argv between the command and the quoted prompt", () => {
    expect(buildHeadlessCommand("claude", '-p --allowedTools "Bash(git *)" --', "do it")).toBe(
      'claude -p --allowedTools "Bash(git *)" -- \'do it\''
    );
  });

  it("quotes the prompt the same way an interactive run does", () => {
    expect(buildHeadlessCommand("claude", "-p", "a'b")).toBe("claude -p 'a'\\''b'");
  });

  // A profile with no verified headless argv would launch a TUI that
  // never exits -- invisibly, since the whole point is a hidden session.
  // Refused, so the caller has to disable the action instead.
  it("refuses a profile that has no headless argv", () => {
    expect(buildHeadlessCommand("codex", "", "do it")).toBeNull();
    expect(buildHeadlessCommand("codex", "   ", "do it")).toBeNull();
  });
});

describe("COMMIT_PROMPT", () => {
  // The human wrote this line on the card; it is the whole instruction
  // the hidden agent gets, so it is asserted verbatim rather than
  // spot-checked.
  it("is the card's text, and forbids pushing", () => {
    expect(COMMIT_PROMPT).toBe(
      "Commit pending and unversioned changes, in logical chunks. Do not push."
    );
  });
});

describe("developAvailable", () => {
  // One rule, two surfaces (the card menu and the detail modal), so it
  // lives here rather than being spelled out twice in templates.
  it("is true only for an unbound, non-note card sitting in To Do", () => {
    expect(developAvailable("task", "To Do", false)).toBe(true);
    expect(developAvailable("plan", "To Do", false)).toBe(true);
  });

  it("reads the column the way the board does, not by exact spelling", () => {
    expect(developAvailable("task", "to-do", false)).toBe(true);
    expect(developAvailable("task", " TO  DO ", false)).toBe(true);
  });

  it("is false past To Do: started, finished, custom, and a nested task", () => {
    for (const status of ["In Progress", "Done", "Shipped", null]) {
      expect(developAvailable("task", status, false), `status ${status}`).toBe(false);
    }
  });

  it("is false for a note, and false once a session is bound", () => {
    expect(developAvailable("note", "To Do", false)).toBe(false);
    expect(developAvailable("task", "To Do", true)).toBe(false);
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
