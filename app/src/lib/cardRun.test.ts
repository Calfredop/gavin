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
  buildResumeCommand,
  unresumableConversationReason,
  mintConversationId,
  withFreshConversationId,
  noPromptReason,
  agentPromptBlocker,
  buildHeadlessCommand,
  COMMIT_PROMPT,
  buildToolCommand,
  runStatusNeeded,
  developAvailable,
  provisionalSessionName,
  cardHomeNote,
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

  it("a withheld entry is named on every composer, without handing over a path to read", () => {
    const withheld = ["~/Desktop/shot.png"];
    expect(composeTaskPrompt("/p/t.md", "T", "b", [], null, withheld)).toContain(
      "~/Desktop/shot.png"
    );
    expect(composePlanPrompt("/p/plan.md", [], null, withheld)).toContain("~/Desktop/shot.png");
    expect(composeResumeTaskPrompt("/p/t.md", "T", "b", [], withheld)).toContain(
      "~/Desktop/shot.png"
    );
    expect(composeResumePlanPrompt("/p/plan.md", [], withheld)).toContain("~/Desktop/shot.png");
  });

  it("no withheld entries leaves every prompt byte-identical to before the field existed", () => {
    expect(composeTaskPrompt("/p/t.md", "T", "b", files, null, [])).toBe(
      composeTaskPrompt("/p/t.md", "T", "b", files)
    );
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

// The decoy: where `.gavin*` is tracked in git, every worktree carries
// its own copy of every card at the same relative path, and a rail step
// launches its agent INSIDE one. Writing the copy is silent -- the board
// never moves, the step never completes, and the divergence rides the
// branch into a merge conflict.
describe("cardHomeNote", () => {
  it("says nothing when the card is inside the launch directory", () => {
    expect(cardHomeNote("/ws/.gavin-root/plans/a.md", "/ws/.gavin-root")).toBe("");
    expect(cardHomeNote("/ws/.gavin-root/plans/a.md", "/ws")).toBe("");
  });

  // A board Run passes no cwd at all, and must read exactly as it did
  // before this existed.
  it("says nothing with no launch directory", () => {
    expect(cardHomeNote("/ws/.gavin-root/plans/a.md")).toBe("");
    expect(composePlanPrompt("/p/plan.md", [], null)).toBe(composePlanPrompt("/p/plan.md"));
  });

  // Three things, and all three earn their place: which file is real,
  // what the other one is, and what happens if it is written.
  it("names the real path, the decoy, and the consequence", () => {
    const note = cardHomeNote("/ws/.gavin-root/plans/a.md", "/wt/rail-a");
    expect(note).toContain("/ws/.gavin-root/plans/a.md");
    expect(note).toContain("decoy");
    expect(note).toContain("invisible to the board");
  });

  it("rides on both launched prompts when the run is in a worktree", () => {
    expect(composePlanPrompt("/ws/.gavin-root/plans/a.md", [], "/wt/rail-a")).toContain("decoy");
    expect(composeTaskPrompt("/ws/.gavin-root/plans/a.md", "A", "body", [], "/wt/rail-a")).toContain(
      "decoy"
    );
  });

  // After the status contract, not before it: the sentence the note
  // qualifies is the one telling the agent to write the card's status.
  it("comes last, after the instruction it qualifies", () => {
    const p = composeTaskPrompt("/ws/.gavin-root/plans/a.md", "A", "body", [], "/wt/rail-a");
    expect(p.indexOf("gavin_set_plan_field")).toBeLessThan(p.indexOf("decoy"));
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
  it("names every shape, the kind and the level, and forbids writing before approval", () => {
    const p = composeDevelopPrompt("/p/t.md", "Fix login");
    expect(p).toBe(
      `${NAME_TAB_FIRST}\n\n` +
        'Use the gavin-develop skill on the card at /p/t.md ("Fix login"): develop it into ' +
        "work an agent can execute — a checklist, nested task cards, both, or, when it is " +
        "really one sitting, a sharper prompt — and set the card's kind and complexity to " +
        "match what you wrote.\n\n" +
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
  // on the board says so. The level is the third of exactly the same
  // kind: unrated runs the workspace's default agent, so a card the
  // interview established was the deep end comes back off whatever model
  // a rename would have used.
  it("leaves room for a card that was never big, and orders the kind and the level set", () => {
    const p = composeDevelopPrompt("/p/t.md", "Fix login");
    expect(p).toContain("one sitting, a sharper prompt");
    expect(p).toContain("set the card's kind and complexity to match");
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
    expect(buildRunCommand("claude", "", "do it")).toBe("claude 'do it'");
    expect(buildRunCommand("claude --model x", "", "a'b")).toBe("claude --model x 'a'\\''b'");
  });

  // opencode's shape. The `=` lives in the prefix, so the flag and its
  // value come out ATTACHED -- `--prompt 'x'` is parsed by yargs, which
  // reads a value beginning with `-` as the next flag and prints its
  // usage banner instead of starting a session.
  it("attaches the prompt to a flagged profile's prefix", () => {
    expect(buildRunCommand("opencode", "--prompt=", "do it")).toBe("opencode --prompt='do it'");
    expect(buildRunCommand("opencode --model a/b", "--prompt=", "-x")).toBe(
      "opencode --model a/b --prompt='-x'"
    );
  });

  // The quoting is the same either way: one concatenation, one quoter.
  it("quotes a flagged prompt exactly as it quotes a positional one", () => {
    const prompt = "O'Brien said \"hi\"\nand left";
    expect(buildRunCommand("opencode", "--prompt=", prompt)).toBe(
      `opencode --prompt=${shellQuote(prompt)}`
    );
    expect(buildRunCommand("claude", "", prompt)).toBe(`claude ${shellQuote(prompt)}`);
  });

  // The case this signature exists for. `cursor 'Fix the login flow'`
  // and `opencode 'Fix the login flow'` both read the prompt as a PATH:
  // cursor opens a file that is not there, opencode dies with "Failed to
  // change directory to …". Neither reports anything a card run could
  // catch, so the refusal has to happen before the launch.
  it("refuses to build a line for a profile that takes no prompt", () => {
    expect(buildRunCommand("cursor", null, "Fix the login flow")).toBeNull();
    expect(buildRunCommand("my-agent", null, "")).toBeNull();
  });
});

describe("noPromptReason", () => {
  // It names the agent and where to change it: the block is never about
  // the card, and a sentence that only says "cannot start" sends the
  // human looking at the wrong thing.
  it("names the agent and points at Settings", () => {
    const reason = noPromptReason("Cursor");
    expect(reason).toContain("Cursor");
    expect(reason).toContain("Settings");
  });
});

describe("agentPromptBlocker", () => {
  it("is null while the profile can carry a prompt, and the reason when it cannot", () => {
    expect(agentPromptBlocker("", "Claude Code")).toBeNull();
    expect(agentPromptBlocker("--prompt=", "opencode")).toBeNull();
    expect(agentPromptBlocker(null, "Cursor")).toBe(noPromptReason("Cursor"));
  });
});

describe("buildRunCommand with a conversation id", () => {
  // Ahead of the prompt, because the prompt is a positional: anything
  // after it would be read as a second one.
  it("fixes the conversation id at launch, before the prompt", () => {
    expect(buildRunCommand("claude", "", "do it", "--session-id", "abc-123")).toBe(
      "claude --session-id abc-123 'do it'"
    );
  });

  // Dropped TOGETHER: an id with no argv to carry it, or argv with no
  // id, would each put a stray token in front of the prompt.
  it("drops both halves unless it has both", () => {
    expect(buildRunCommand("claude", "", "do it", "--session-id", null)).toBe("claude 'do it'");
    expect(buildRunCommand("claude", "", "do it", "", "abc-123")).toBe("claude 'do it'");
    expect(buildRunCommand("claude", "", "do it", "   ", "abc-123")).toBe("claude 'do it'");
  });

  it("composes with the model flag the launch command already carries", () => {
    expect(buildRunCommand("claude --model opus", "", "go", "--session-id", "u1")).toBe(
      "claude --model opus --session-id u1 'go'"
    );
  });

  // The id and the prompt prefix are two different conventions on the
  // same line: the id sits ahead, the prefix stays glued to the prompt.
  it("keeps the prompt prefix attached when an id is fixed as well", () => {
    expect(buildRunCommand("opencode", "--prompt=", "go", "--session-id", "u1")).toBe(
      "opencode --session-id u1 --prompt='go'"
    );
  });

  // A profile that takes no prompt is refused whatever else it verified.
  it("still refuses a no-prompt profile", () => {
    expect(buildRunCommand("cursor", null, "go", "--session-id", "u1")).toBeNull();
  });
});

describe("mintConversationId", () => {
  it("mints a real UUID, which is what the CLI validates", () => {
    const id = mintConversationId("--session-id");
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(mintConversationId("--session-id")).not.toBe(id);
  });

  // A profile whose argv nobody has verified gets no id, and falls back
  // to the written reconstruction. Guessing a flag here would put
  // garbage in somebody's argv.
  it("mints nothing for a profile with no verified argv", () => {
    expect(mintConversationId("")).toBeNull();
    expect(mintConversationId("  ")).toBeNull();
  });
});

describe("buildResumeCommand", () => {
  // No prompt. Resume puts the agent back at the end of its OWN
  // transcript; a prompt here would be a fresh instruction on top of a
  // conversation that already holds the whole task.
  it("reopens the conversation and hands the agent nothing else", () => {
    expect(buildResumeCommand("claude --model opus", "--resume", "u1")).toBe(
      "claude --model opus --resume u1"
    );
  });

  it("returns null without both a verified argv and an id", () => {
    expect(buildResumeCommand("claude", "", "u1")).toBeNull();
    expect(buildResumeCommand("claude", "--resume", null)).toBeNull();
    expect(buildResumeCommand("claude", "--resume", undefined)).toBeNull();
    expect(buildResumeCommand("claude", "--resume", "  ")).toBeNull();
  });

  // The id gavin minted is proof that a launch was ATTEMPTED, not that a
  // conversation happened: minting it is the one thing gavin does before
  // the agent has done anything at all. A binding whose transcript does
  // not exist gets no command -- `claude --resume <uuid>` would open,
  // say it cannot find that session, and exit, and the card would offer
  // the same doomed button for ever.
  it("refuses an id whose conversation was never written", () => {
    expect(buildResumeCommand("claude", "--resume", "u1", "missing")).toBeNull();
  });

  // Only a log gavin can SEE and which does not hold the file is evidence
  // the conversation is gone. `unknown` -- no TokenLog for the profile,
  // a CLAUDE_CONFIG_DIR pointed elsewhere, the check itself failing -- is
  // today's behaviour: build the command and let the CLI answer.
  it("reopens a conversation whose log is present or unknowable", () => {
    expect(buildResumeCommand("claude", "--resume", "u1", "present")).toBe("claude --resume u1");
    expect(buildResumeCommand("claude", "--resume", "u1", "unknown")).toBe("claude --resume u1");
    expect(buildResumeCommand("claude", "--resume", "u1")).toBe("claude --resume u1");
  });
});

describe("unresumableConversationReason", () => {
  // The refusal has to say what happened AND what to do instead: the
  // human who pressed Resume is looking at a card that still says its
  // agent stopped, and the honest way forward is the button beside it.
  it("names the cause and the way forward for a missing log", () => {
    const reason = unresumableConversationReason("missing", "Re-launch starts the card again");
    expect(reason).toMatch(/before it wrote a line/);
    expect(reason).toContain("Re-launch starts the card again");
  });

  it("has nothing to say when the conversation is there or unknowable", () => {
    expect(unresumableConversationReason("present", "x")).toBeNull();
    expect(unresumableConversationReason("unknown", "x")).toBeNull();
  });
});

describe("withFreshConversationId", () => {
  // Measured against the real binary: re-running a command that carries
  // `--session-id <uuid>` does not repeat the conversation, it FAILS --
  // "Session ID <uuid> is already in use" -- so a re-launch that replayed
  // the stored command would never start at all.
  it("swaps the baked-in id for a new one", () => {
    const { command, conversationId } = withFreshConversationId(
      "claude --session-id 11111111-1111-1111-1111-111111111111 'do it'",
      "--session-id"
    );
    expect(conversationId).not.toBe("11111111-1111-1111-1111-111111111111");
    expect(command).toBe(`claude --session-id ${conversationId} 'do it'`);
  });

  it("leaves a command with no id in it exactly as it was", () => {
    expect(withFreshConversationId("claude 'do it'", "--session-id")).toEqual({
      command: "claude 'do it'",
      conversationId: null,
    });
    expect(withFreshConversationId("claude --session-id x 'do it'", "")).toEqual({
      command: "claude --session-id x 'do it'",
      conversationId: null,
    });
    expect(withFreshConversationId(null, "--session-id")).toEqual({
      command: null,
      conversationId: null,
    });
  });

  // The argv always sits AHEAD of the quoted prompt, so the first
  // occurrence is the id even when the prompt quotes the same flag.
  it("swaps the launch flag, not a mention of it inside the prompt", () => {
    const { command } = withFreshConversationId(
      "claude --session-id 11111111-1111-1111-1111-111111111111 'run --session-id 9 for me'",
      "--session-id"
    );
    expect(command).toContain("'run --session-id 9 for me'");
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
