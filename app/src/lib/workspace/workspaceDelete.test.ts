import { describe, it, expect } from "vitest";
import {
  applicableSteps,
  defaultAnswers,
  plannedRemovals,
  touchesDisk,
  confirmationMatches,
  summaryLines,
  stepTitle,
  stepQuestion,
  DELETE_STEPS,
  type GavinFootprint,
  type DeleteAnswers,
} from "$lib/workspace/workspaceDelete";

const full: GavinFootprint = {
  root: "/repo",
  gavinRoot: { path: "/repo/.gavin-root", cards: 12, archived: 4 },
  skills: ["/repo/.claude/skills/gavin", "/repo/.claude/skills/gavin-orchestrate"],
  agentFile: null,
  mcp: { path: "/repo/.mcp.json", serverKey: "gavin" },
  instructions: "/repo/CLAUDE.md",
  contexts: [
    { path: "/repo/api/.gavin", outside: false },
    { path: "/elsewhere/lib/.gavin", outside: true },
  ],
  worktrees: [],
};

const bare: GavinFootprint = {
  root: "/repo",
  gavinRoot: null,
  skills: [],
  agentFile: null,
  mcp: null,
  instructions: null,
  contexts: [],
  worktrees: [],
};

/// The same workspace on the opencode profile: the skills live under a
/// different root, and the profile installs an agent definition the
/// hidden commit run launches against.
const opencode: GavinFootprint = {
  ...full,
  skills: ["/repo/.opencode/skills/gavin", "/repo/.opencode/skills/gavin-orchestrate"],
  agentFile: "/repo/.opencode/agent/gavin-commit.md",
  mcp: { path: "/repo/opencode.json", serverKey: "gavin" },
  instructions: "/repo/AGENTS.md",
};

describe("applicableSteps", () => {
  it("walks every screen when the scan found everything", () => {
    expect(applicableSteps(full)).toEqual(DELETE_STEPS);
  });

  // A screen asking permission to remove nothing is a step that can only
  // be answered wrong.
  it("drops the screens for categories the scan found nothing for", () => {
    expect(applicableSteps(bare)).toEqual(["rows", "confirm"]);
  });

  it("keeps a screen whose category has exactly one entry", () => {
    expect(applicableSteps({ ...bare, skills: ["/repo/.claude/skills/gavin"] })).toEqual([
      "skills",
      "rows",
      "confirm",
    ]);
  });

  // The screen answers for skills AND the agent definition, so either
  // half on its own has to keep it: a profile could install one and not
  // the other, and a scanned file with no screen is a file the wizard
  // silently leaves behind.
  it("keeps the skills screen for an agent file with no skills beside it", () => {
    expect(
      applicableSteps({ ...bare, agentFile: "/repo/.opencode/agent/gavin-commit.md" })
    ).toEqual(["skills", "rows", "confirm"]);
  });

  // Neither is a question about the filesystem, so neither can be
  // scanned away.
  it("always keeps the daemon-rows and confirmation screens", () => {
    expect(applicableSteps(bare)).toContain("rows");
    expect(applicableSteps(bare)).toContain("confirm");
  });
});

describe("the skills screen's copy", () => {
  // The heading and the question have to describe the list the screen
  // actually renders. "Agent skills" over a permission-grant file is a
  // heading that does not match its own contents.
  it("names only skills where that is all there is", () => {
    expect(stepTitle("skills", full)).toBe("Agent skills");
    expect(stepQuestion("skills", full)).toContain("skill files");
    expect(stepQuestion("skills", full)).not.toContain("agent definition");
  });

  it("names the agent definition too where the profile installs one", () => {
    expect(stepTitle("skills", opencode)).toBe("Agent files");
    expect(stepQuestion("skills", opencode)).toContain("agent definition");
  });
});

describe("defaultAnswers", () => {
  it("says yes to everything inside the root", () => {
    const a = defaultAnswers(full);
    expect(a.plans).toBe(true);
    expect(a.skills).toBe(true);
    expect(a.mcp).toBe(true);
    expect(a.instructions).toBe(true);
    expect(a.rows).toBe(true);
  });

  // "Delete this workspace" does not, on its face, mean "and that other
  // checkout's context too" -- so that one has to be given, not merely
  // left alone.
  it("leaves a context outside the root unticked", () => {
    expect(defaultAnswers(full).contexts).toEqual(["/repo/api/.gavin"]);
  });
});

describe("plannedRemovals", () => {
  const yes = (over: Partial<DeleteAnswers> = {}): DeleteAnswers => ({
    ...defaultAnswers(full),
    contexts: full.contexts.map((c) => c.path),
    ...over,
  });

  it("trashes the gavin root, the skills and the ticked contexts", () => {
    expect(plannedRemovals(full, yes()).trash).toEqual([
      "/repo/.gavin-root",
      "/repo/.claude/skills/gavin",
      "/repo/.claude/skills/gavin-orchestrate",
      "/repo/api/.gavin",
      "/elsewhere/lib/.gavin",
    ]);
  });

  // One answer, because one screen asked. The agent file goes last,
  // matching the order that screen listed it in.
  it("trashes the agent definition with the skills that share its screen", () => {
    const answers = { ...defaultAnswers(opencode), contexts: [] };
    expect(plannedRemovals(opencode, answers).trash).toEqual([
      "/repo/.gavin-root",
      "/repo/.opencode/skills/gavin",
      "/repo/.opencode/skills/gavin-orchestrate",
      "/repo/.opencode/agent/gavin-commit.md",
    ]);
  });

  // Declining is the whole point of the screen: a workspace that keeps
  // its agent file keeps a definition that still names gavin's grant,
  // which is the user's call to make.
  it("keeps the agent definition when the skills screen was declined", () => {
    const answers = { ...defaultAnswers(opencode), skills: false, contexts: [] };
    expect(plannedRemovals(opencode, answers).trash).toEqual(["/repo/.gavin-root"]);
  });

  // A shared config file is somebody else's too: gavin's entry comes
  // out, the file stays.
  it("edits the MCP config and the instructions file rather than trashing them", () => {
    const plan = plannedRemovals(full, yes());
    expect(plan.stripMcpKey).toEqual([{ path: "/repo/.mcp.json", serverKey: "gavin" }]);
    expect(plan.cutBlock).toEqual(["/repo/CLAUDE.md"]);
    expect(plan.trash).not.toContain("/repo/.mcp.json");
    expect(plan.trash).not.toContain("/repo/CLAUDE.md");
  });

  it("leaves out every category that was declined", () => {
    const plan = plannedRemovals(
      full,
      yes({ plans: false, skills: false, mcp: false, instructions: false, contexts: [] })
    );
    expect(plan).toEqual({ trash: [], stripMcpKey: [], cutBlock: [], rows: true });
  });

  it("carries the daemon-rows answer through untouched", () => {
    expect(plannedRemovals(full, yes({ rows: false })).rows).toBe(false);
  });

  // The only paths this wizard may remove are the ones it found and
  // showed.
  it("ignores a context path the scan never reported", () => {
    const plan = plannedRemovals(full, yes({ contexts: ["/repo/api/.gavin", "/etc"] }));
    expect(plan.trash).toContain("/repo/api/.gavin");
    expect(plan.trash).not.toContain("/etc");
  });

  it("plans nothing at all for a root with no gavin in it", () => {
    const plan = plannedRemovals(bare, defaultAnswers(bare));
    expect(touchesDisk(plan)).toBe(false);
  });

  it("counts an edit as touching the disk", () => {
    const onlyMcp: GavinFootprint = { ...bare, mcp: { path: "/repo/.mcp.json", serverKey: "gavin" } };
    expect(touchesDisk(plannedRemovals(onlyMcp, defaultAnswers(onlyMcp)))).toBe(true);
  });
});

describe("confirmationMatches", () => {
  it("accepts the exact name", () => {
    expect(confirmationMatches("Gavin", "Gavin")).toBe(true);
  });

  it("forgives surrounding whitespace, which a paste picks up", () => {
    expect(confirmationMatches("  Gavin \n", "Gavin")).toBe(true);
  });

  it("rejects the wrong case and the wrong name", () => {
    expect(confirmationMatches("gavin", "Gavin")).toBe(false);
    expect(confirmationMatches("Gavn", "Gavin")).toBe(false);
    expect(confirmationMatches("", "Gavin")).toBe(false);
  });

  // Otherwise an empty box would unlock a workspace whose name is blank.
  it("rejects everything when the workspace has no name", () => {
    expect(confirmationMatches("", "")).toBe(false);
    expect(confirmationMatches("  ", "   ")).toBe(false);
  });
});

describe("summaryLines", () => {
  it("names every path, edit and row group, then the sessions and the workspace", () => {
    const lines = summaryLines(full, defaultAnswers(full), 3);
    expect(lines).toEqual([
      "Move to Trash: /repo/.gavin-root",
      "Move to Trash: /repo/.claude/skills/gavin",
      "Move to Trash: /repo/.claude/skills/gavin-orchestrate",
      "Move to Trash: /repo/api/.gavin",
      'Edit: remove the "gavin" server from /repo/.mcp.json',
      "Edit: cut the gavin block from /repo/CLAUDE.md",
      "Clear this workspace's board, rails, tools and card links from the daemon",
      "End 3 terminal sessions",
      "Remove the workspace from gavin",
    ]);
  });

  it("says plainly that declined rows are kept", () => {
    const lines = summaryLines(bare, { ...defaultAnswers(bare), rows: false }, 0);
    expect(lines).toEqual([
      "Keep this workspace's board, rails, tools and card links in the daemon",
      "Remove the workspace from gavin",
    ]);
  });

  it("singularizes a lone session and omits the line when there are none", () => {
    expect(summaryLines(bare, defaultAnswers(bare), 1)).toContain("End 1 terminal session");
    expect(summaryLines(bare, defaultAnswers(bare), 0).join("\n")).not.toContain("terminal session");
  });

  // Nothing in DeleteAnswers can remove one -- the wizard never plans to
  // touch a live checkout -- so the summary is the only place a human
  // learns it is still there, and where to actually take it out.
  it("says a live worktree is left in place and where to remove it", () => {
    const withWorktree: GavinFootprint = {
      ...bare,
      worktrees: ["/repo/.gavin-worktrees/feat-x"],
    };
    const lines = summaryLines(withWorktree, defaultAnswers(withWorktree), 0);
    const line = lines.find((l) => l.includes("feat-x"));
    expect(line).toBeDefined();
    expect(line).toContain("Git tab");
    expect(line).toContain("git worktree remove");
  });

  it("counts several worktrees without naming a screenful", () => {
    const withWorktrees: GavinFootprint = {
      ...bare,
      worktrees: ["/repo/.gavin-worktrees/feat-x", "/repo/.gavin-worktrees/feat-y"],
    };
    const lines = summaryLines(withWorktrees, defaultAnswers(withWorktrees), 0);
    expect(lines.some((l) => l.includes("feat-x") && l.includes("feat-y"))).toBe(true);
  });
});
