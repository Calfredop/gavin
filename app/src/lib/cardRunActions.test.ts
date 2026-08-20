import { describe, it, expect, vi, beforeEach } from "vitest";
import { get, writable } from "svelte/store";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));
vi.mock("./backend", () => ({
  createSession: vi.fn(),
  readFileForViewer: vi.fn(),
  setPlanFrontmatterField: vi.fn(),
  linkCardSession: vi.fn(),
  unlinkCardSession: vi.fn(),
  getBoard: vi.fn(),
}));
vi.mock("./layoutState", () => ({
  layoutState: writable({
    workspaces: [
      {
        id: "ws-1",
        name: "ws",
        pages: [
          {
            id: "pg-1",
            name: "Agents",
            layout: { type: "leaf", tabs: ["s-live"], activeTab: "s-live" },
          },
        ],
        activePageId: "pg-1",
      },
    ],
    sessionStatusById: {},
    sessionNames: {},
    cwdBySessionId: {},
  }),
  handleAgentSessionSpawned: vi.fn(),
  switchWorkspaceView: vi.fn().mockResolvedValue(undefined),
  switchToSessionInPage: vi.fn().mockResolvedValue(undefined),
  resolvedAgentFor: vi.fn(() => ({
    profileId: "claude-code",
    file: "CLAUDE.md",
    command: "claude --model opus",
    mcpSupported: true,
  })),
}));
vi.mock("./workspace", () => ({
  findSessionLocation: vi.fn(),
}));

import * as backend from "./backend";
import { handleAgentSessionSpawned, switchToSessionInPage } from "./layoutState";
import { findSessionLocation } from "./workspace";
import { kanbanState } from "./kanbanState";
import { gavinTrees } from "./gavinState";
import { runCard, relaunchCard, jumpToBoundSession } from "./cardRunActions";
import type { CardView } from "./planBoard";
import type { Board } from "./kanban";

function card(kind: "note" | "task" | "plan", status: string | null): CardView {
  return {
    id: "/ws/.gavin-root/plans/t.md",
    title: "Fix login",
    status,
    priority: null,
    order: null,
    kind,
    parent: null,
    parentTitle: null,
    parentBroken: false,
    labels: [],
    checklistDone: 0,
    checklistTotal: 0,
    contextName: "root",
    contextFolder: "/ws",
    fileName: "t.md",
    parseWarning: false,
    nestedChildren: [],
  };
}

function board(cardSessions: Board["cardSessions"] = []): Board {
  return { columns: [{ id: "c1", name: "To Do", position: 0 }], labels: [], cardSessions };
}

beforeEach(() => {
  vi.clearAllMocks();
  kanbanState.set({ "ws-1": board() });
  gavinTrees.set({});
  vi.mocked(findSessionLocation).mockReturnValue(null);
});

describe("runCard", () => {
  it("task: reads the body, composes the command, lands on Agents, links, sets In Progress", async () => {
    vi.mocked(backend.readFileForViewer).mockResolvedValue({
      content: "---\nkind: task\ntitle: Fix login\nstatus: To Do\n---\nDo the thing.\n",
      truncated: false,
      exists: true,
    });
    vi.mocked(backend.createSession).mockResolvedValue("s-9");
    vi.mocked(backend.linkCardSession).mockResolvedValue(undefined);
    vi.mocked(backend.setPlanFrontmatterField).mockResolvedValue(undefined);

    const err = await runCard("ws-1", card("task", "To Do"));

    expect(err).toBeNull();
    const [cwd, command] = vi.mocked(backend.createSession).mock.calls[0];
    expect(cwd).toBe("/ws");
    expect(command).toContain("claude --model opus '");
    expect(command).toContain("Do the thing.");
    expect(command).toContain('the task card at /ws/.gavin-root/plans/t.md');
    expect(handleAgentSessionSpawned).toHaveBeenCalledWith("ws-1", "s-9");
    expect(backend.linkCardSession).toHaveBeenCalled();
    expect(backend.setPlanFrontmatterField).toHaveBeenCalledWith(
      "/ws/.gavin-root/plans/t.md",
      "status",
      "In Progress"
    );
  });

  it("plan: pointer prompt, never reads the body", async () => {
    vi.mocked(backend.createSession).mockResolvedValue("s-9");
    vi.mocked(backend.linkCardSession).mockResolvedValue(undefined);
    vi.mocked(backend.setPlanFrontmatterField).mockResolvedValue(undefined);

    const err = await runCard("ws-1", card("plan", "In Progress"));

    expect(err).toBeNull();
    expect(backend.readFileForViewer).not.toHaveBeenCalled();
    const [, command] = vi.mocked(backend.createSession).mock.calls[0];
    expect(command).toContain("Read /ws/.gavin-root/plans/t.md and execute that plan");
    // Already slug-matching In Progress: no status write.
    expect(backend.setPlanFrontmatterField).not.toHaveBeenCalled();
  });

  it("jumps instead of spawning when a live binding exists", async () => {
    kanbanState.set({
      "ws-1": board([{ path: "/ws/.gavin-root/plans/t.md", sessionId: "s-live", cwd: "/ws", command: "x" }]),
    });
    vi.mocked(findSessionLocation).mockReturnValue({ workspaceId: "ws-1", pageId: "pg-1" });

    const err = await runCard("ws-1", card("task", "To Do"));

    expect(err).toBeNull();
    expect(backend.createSession).not.toHaveBeenCalled();
    expect(switchToSessionInPage).toHaveBeenCalledWith("ws-1", "pg-1", "s-live");
  });

  it("notes are not runnable; createSession failures surface without linking", async () => {
    expect(await runCard("ws-1", card("note", null))).toContain("not runnable");

    vi.mocked(backend.readFileForViewer).mockResolvedValue({ content: "x", truncated: false, exists: true });
    vi.mocked(backend.createSession).mockRejectedValue(new Error("spawn failed"));
    const err = await runCard("ws-1", card("task", null));
    expect(err).toContain("spawn failed");
    expect(backend.linkCardSession).not.toHaveBeenCalled();
  });
});

describe("relaunchCard", () => {
  it("recreates from the stored binding and re-links", async () => {
    kanbanState.set({
      "ws-1": board([{ path: "/p/t.md", sessionId: "s-dead", cwd: "/p", command: "claude 'x'" }]),
    });
    vi.mocked(backend.createSession).mockResolvedValue("s-new");
    vi.mocked(backend.linkCardSession).mockResolvedValue(undefined);

    const err = await relaunchCard("ws-1", "/p/t.md");

    expect(err).toBeNull();
    expect(backend.createSession).toHaveBeenCalledWith("/p", "claude 'x'");
    expect(handleAgentSessionSpawned).toHaveBeenCalledWith("ws-1", "s-new");
    expect(get(kanbanState)["ws-1"].cardSessions[0].sessionId).toBe("s-new");
  });

  it("errors when nothing is remembered", async () => {
    expect(await relaunchCard("ws-1", "/p/absent.md")).toContain("No session");
  });
});

describe("jumpToBoundSession", () => {
  it("jumps when the binding's session is alive", async () => {
    kanbanState.set({
      "ws-1": board([{ path: "/p/t.md", sessionId: "s-live", cwd: "/p", command: null }]),
    });
    vi.mocked(findSessionLocation).mockReturnValue({ workspaceId: "ws-1", pageId: "pg-1" });

    expect(await jumpToBoundSession("ws-1", "/p/t.md")).toBe("jumped");
    expect(switchToSessionInPage).toHaveBeenCalledWith("ws-1", "pg-1", "s-live");
  });

  it("reports exited and none without navigating", async () => {
    kanbanState.set({
      "ws-1": board([{ path: "/p/t.md", sessionId: "s-dead", cwd: "/p", command: null }]),
    });
    vi.mocked(findSessionLocation).mockReturnValue(null);
    expect(await jumpToBoundSession("ws-1", "/p/t.md")).toBe("exited");
    expect(await jumpToBoundSession("ws-1", "/p/unbound.md")).toBe("none");
    expect(switchToSessionInPage).not.toHaveBeenCalled();
  });
});
