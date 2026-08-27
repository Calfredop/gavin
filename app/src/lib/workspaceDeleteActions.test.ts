import { describe, it, expect, vi, beforeEach } from "vitest";
import * as backend from "./backend";
import { deleteWorkspaceFromApp } from "./layoutState";
import { executeWorkspaceDelete } from "./workspaceDeleteActions";
import { defaultAnswers, type GavinFootprint } from "./workspaceDelete";

vi.mock("./backend", () => ({
  removeGavinFootprint: vi.fn().mockResolvedValue({ done: [], failed: [] }),
  getBoard: vi.fn().mockResolvedValue({ columns: [], labels: [], cardSessions: [] }),
  unlinkCardSession: vi.fn().mockResolvedValue(undefined),
  setOrchestration: vi.fn().mockResolvedValue(undefined),
  getTools: vi.fn().mockResolvedValue([]),
  deleteTool: vi.fn().mockResolvedValue(undefined),
  getGroupTemplates: vi.fn().mockResolvedValue([]),
  deleteGroupTemplate: vi.fn().mockResolvedValue(undefined),
  deleteBoard: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./layoutState", () => ({ deleteWorkspaceFromApp: vi.fn().mockResolvedValue(undefined) }));

const footprint: GavinFootprint = {
  root: "/repo",
  gavinRoot: { path: "/repo/.gavin-root", cards: 3, archived: 1 },
  skills: ["/repo/.claude/skills/gavin"],
  mcp: { path: "/repo/.mcp.json", serverKey: "gavin" },
  instructions: "/repo/CLAUDE.md",
  contexts: [],
};

const bare: GavinFootprint = {
  root: "/repo",
  gavinRoot: null,
  skills: [],
  mcp: null,
  instructions: null,
  contexts: [],
};

// clearAllMocks resets call history but keeps implementations, so a
// rejection set by one test would still be in force in the next.
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(backend.removeGavinFootprint).mockResolvedValue({ done: [], failed: [] });
  vi.mocked(backend.getBoard).mockResolvedValue({ columns: [], labels: [], cardSessions: [] });
  vi.mocked(backend.getTools).mockResolvedValue([]);
  vi.mocked(backend.getGroupTemplates).mockResolvedValue([]);
  vi.mocked(backend.unlinkCardSession).mockResolvedValue(undefined);
  vi.mocked(backend.setOrchestration).mockResolvedValue(undefined);
  vi.mocked(backend.deleteTool).mockResolvedValue(undefined);
  vi.mocked(backend.deleteGroupTemplate).mockResolvedValue(undefined);
  vi.mocked(backend.deleteBoard).mockResolvedValue(undefined);
});

const tool = (id: string, workspaceId: string | null, name = id) => ({
  id,
  workspaceId,
  name,
  description: "",
  kind: "command" as const,
  body: "",
  params: [],
  position: 0,
});

const template = (id: string, workspaceId: string | null, name = id) => ({
  id,
  workspaceId,
  name,
  description: "",
  mode: "sequence" as const,
  steps: [],
  position: 0,
});

describe("executeWorkspaceDelete", () => {
  it("hands Rust exactly the plan the answers add up to", async () => {
    await executeWorkspaceDelete("ws-1", footprint, defaultAnswers(footprint));

    expect(backend.removeGavinFootprint).toHaveBeenCalledWith("/repo", {
      trash: ["/repo/.gavin-root", "/repo/.claude/skills/gavin"],
      stripMcpKey: [{ path: "/repo/.mcp.json", serverKey: "gavin" }],
      cutBlock: ["/repo/CLAUDE.md"],
    });
  });

  it("does not call Rust at all when nothing on disk was chosen", async () => {
    await executeWorkspaceDelete("ws-1", bare, defaultAnswers(bare));

    expect(backend.removeGavinFootprint).not.toHaveBeenCalled();
  });

  // delete_board leaves card_sessions behind, so clearing the board is
  // not enough on its own -- and the links can only be read while the
  // board is still there.
  it("unlinks every card session before the board goes", async () => {
    vi.mocked(backend.getBoard).mockResolvedValue({
      columns: [],
      labels: [],
      cardSessions: [
        { path: "a.md", sessionId: "s1", cwd: "/repo", command: null },
        { path: "b.md", sessionId: "s2", cwd: "/repo", command: null },
      ],
    });

    await executeWorkspaceDelete("ws-1", bare, defaultAnswers(bare));

    expect(backend.unlinkCardSession).toHaveBeenCalledWith("ws-1", "a.md");
    expect(backend.unlinkCardSession).toHaveBeenCalledWith("ws-1", "b.md");
    expect(vi.mocked(backend.unlinkCardSession).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(backend.deleteBoard).mock.invocationCallOrder[0]
    );
  });

  it("clears the rails and the board", async () => {
    await executeWorkspaceDelete("ws-1", bare, defaultAnswers(bare));

    expect(backend.setOrchestration).toHaveBeenCalledWith("ws-1", [], []);
    expect(backend.deleteBoard).toHaveBeenCalledWith("ws-1");
  });

  // A global row is shared with every other workspace on the machine.
  it("deletes this workspace's tools and templates, never the globals", async () => {
    vi.mocked(backend.getTools).mockResolvedValue([tool("t1", "ws-1"), tool("t2", null)]);
    vi.mocked(backend.getGroupTemplates).mockResolvedValue([
      template("g1", "ws-1"),
      template("g2", null),
    ]);

    await executeWorkspaceDelete("ws-1", bare, defaultAnswers(bare));

    expect(backend.deleteTool).toHaveBeenCalledWith("t1");
    expect(backend.deleteTool).not.toHaveBeenCalledWith("t2");
    expect(backend.deleteGroupTemplate).toHaveBeenCalledWith("g1");
    expect(backend.deleteGroupTemplate).not.toHaveBeenCalledWith("g2");
  });

  it("touches no daemon row when that screen was declined", async () => {
    await executeWorkspaceDelete("ws-1", bare, { ...defaultAnswers(bare), rows: false });

    expect(backend.deleteBoard).not.toHaveBeenCalled();
    expect(backend.setOrchestration).not.toHaveBeenCalled();
    expect(backend.getTools).not.toHaveBeenCalled();
    expect(backend.getGroupTemplates).not.toHaveBeenCalled();
  });

  it("removes the workspace from the app, without a tombstone, once everything landed", async () => {
    const result = await executeWorkspaceDelete("ws-1", bare, defaultAnswers(bare));

    expect(deleteWorkspaceFromApp).toHaveBeenCalledWith("ws-1");
    expect(result.removed).toBe(true);
    expect(result.done).toContain("Removed the workspace from gavin");
  });

  // Removing the workspace would take away the one handle the user has
  // on whatever is left over.
  it("keeps the workspace when a path failed, and reports it with its reason", async () => {
    vi.mocked(backend.removeGavinFootprint).mockResolvedValue({
      done: ["Moved to Trash: /repo/.claude/skills/gavin"],
      failed: [["/repo/.gavin-root", "Permission denied"]],
    });

    const result = await executeWorkspaceDelete("ws-1", footprint, defaultAnswers(footprint));

    expect(result.removed).toBe(false);
    expect(deleteWorkspaceFromApp).not.toHaveBeenCalled();
    expect(result.failed).toEqual([["/repo/.gavin-root", "Permission denied"]]);
    expect(result.done).toContain("Moved to Trash: /repo/.claude/skills/gavin");
  });

  it("keeps the workspace when a daemon row failed", async () => {
    vi.mocked(backend.deleteBoard).mockRejectedValue(new Error("daemon is away"));

    const result = await executeWorkspaceDelete("ws-1", bare, defaultAnswers(bare));

    expect(result.removed).toBe(false);
    expect(result.failed).toEqual([["Cleared the board's columns and labels", "daemon is away"]]);
  });

  // A run that dies on the first row leaves the rest untried and the
  // report silent about them.
  it("keeps going after one row fails", async () => {
    vi.mocked(backend.setOrchestration).mockRejectedValue(new Error("nope"));

    const result = await executeWorkspaceDelete("ws-1", bare, defaultAnswers(bare));

    expect(backend.deleteBoard).toHaveBeenCalled();
    expect(result.done).toContain("Cleared the board's columns and labels");
    expect(result.failed).toEqual([["Cleared the rails and run state", "nope"]]);
  });

  it("reports the whole file half as one failure when the command itself refuses", async () => {
    vi.mocked(backend.removeGavinFootprint).mockRejectedValue(new Error("root does not exist"));

    const result = await executeWorkspaceDelete("ws-1", footprint, defaultAnswers(footprint));

    expect(result.failed).toEqual([["/repo", "root does not exist"]]);
    expect(result.removed).toBe(false);
  });
});
