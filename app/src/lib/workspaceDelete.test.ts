import { describe, it, expect } from "vitest";
import {
  applicableSteps,
  defaultAnswers,
  plannedRemovals,
  touchesDisk,
  confirmationMatches,
  summaryLines,
  DELETE_STEPS,
  type GavinFootprint,
  type DeleteAnswers,
} from "./workspaceDelete";

const full: GavinFootprint = {
  root: "/repo",
  gavinRoot: { path: "/repo/.gavin-root", cards: 12, archived: 4 },
  skills: ["/repo/.claude/skills/gavin", "/repo/.claude/skills/gavin-orchestrate"],
  mcp: { path: "/repo/.mcp.json", serverKey: "gavin" },
  instructions: "/repo/CLAUDE.md",
  contexts: [
    { path: "/repo/api/.gavin", outside: false },
    { path: "/elsewhere/lib/.gavin", outside: true },
  ],
};

const bare: GavinFootprint = {
  root: "/repo",
  gavinRoot: null,
  skills: [],
  mcp: null,
  instructions: null,
  contexts: [],
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

  // Neither is a question about the filesystem, so neither can be
  // scanned away.
  it("always keeps the daemon-rows and confirmation screens", () => {
    expect(applicableSteps(bare)).toContain("rows");
    expect(applicableSteps(bare)).toContain("confirm");
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
});
