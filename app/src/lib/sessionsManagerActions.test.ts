import { describe, it, expect, vi, beforeEach } from "vitest";
import { writable } from "svelte/store";

vi.mock("@tauri-apps/plugin-dialog", () => ({
  confirm: vi.fn().mockResolvedValue(true),
  message: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./backend", () => ({
  endOrphan: vi.fn(),
  killSession: vi.fn(),
}));
vi.mock("./layoutState", () => ({
  layoutState: writable({ workspaces: [] }),
  handleAgentSessionSpawned: vi.fn(),
  handleOrphanEnded: vi.fn(),
  handleSessionExited: vi.fn(),
  switchToSessionInPage: vi.fn().mockResolvedValue(undefined),
  switchWorkspaceView: vi.fn().mockResolvedValue(undefined),
}));

import { confirm, message } from "@tauri-apps/plugin-dialog";
import * as backend from "./backend";
import {
  handleAgentSessionSpawned,
  handleOrphanEnded,
  handleSessionExited,
  layoutState,
  switchToSessionInPage,
  switchWorkspaceView,
} from "./layoutState";
import { endAllSessions, endSession, jumpToSession } from "./sessionsManagerActions";
import type { SessionRow } from "./sessionsManager";

function row(over: Partial<SessionRow> = {}): SessionRow {
  return {
    id: "s-1",
    label: "claude",
    command: "claude",
    cwd: "/repo",
    status: "working",
    workspaceName: "gavin",
    where: "Work",
    visible: true,
    staleness: null,
    stale: false,
    note: null,
    cpuPercent: 12,
    memBytes: 1000,
    processCount: 2,
    pid: 4172,
    orphan: null,
    ...over,
  };
}

/// A layout where `tabbed` ids sit on a page and nothing else does.
function withLayout(tabbed: string[], over: Record<string, unknown> = {}): void {
  layoutState.set({
    workspaces: [
      {
        id: "ws-1",
        name: "gavin",
        rootPath: "/repo",
        pages: [{ id: "pg-1", name: "Work", layout: { type: "leaf", tabs: tabbed, activeTabIndex: 0 } }],
        activePageId: "pg-1",
        ...over,
      },
    ],
  } as never);
}

beforeEach(() => {
  vi.mocked(confirm).mockClear().mockResolvedValue(true);
  vi.mocked(message).mockClear();
  vi.mocked(backend.endOrphan).mockReset().mockResolvedValue({ ended: true, stillRunning: false });
  vi.mocked(backend.killSession).mockReset().mockResolvedValue(undefined);
  vi.mocked(handleAgentSessionSpawned).mockClear();
  vi.mocked(handleOrphanEnded).mockClear();
  vi.mocked(handleSessionExited).mockClear();
  vi.mocked(switchToSessionInPage).mockClear();
  vi.mocked(switchWorkspaceView).mockClear();
  withLayout(["s-1"]);
});

describe("jumpToSession", () => {
  it("goes straight to a session a page is already showing", async () => {
    expect(await jumpToSession(row())).toBe(true);
    expect(handleAgentSessionSpawned).not.toHaveBeenCalled();
    expect(switchToSessionInPage).toHaveBeenCalledWith("ws-1", "pg-1", "s-1");
  });

  it("gives a session with no tab one first, then jumps to it", async () => {
    // The whole reason the card asks for this: a git-commit run or an
    // orchestration Generate is a real session with nowhere to watch it.
    withLayout([]);
    vi.mocked(handleAgentSessionSpawned).mockImplementation(() => withLayout(["hidden-1"]));

    expect(await jumpToSession(row({ id: "hidden-1", visible: false, where: null }))).toBe(true);
    expect(handleAgentSessionSpawned).toHaveBeenCalledWith("ws-1", "hidden-1");
    expect(switchToSessionInPage).toHaveBeenCalledWith("ws-1", "pg-1", "hidden-1");
  });

  it("sends the main agent panel to Home instead of adopting it onto a page", async () => {
    // It lives outside every page tree on purpose; giving it a tab would
    // move it out of the panel that owns it.
    withLayout([], { mainSessionId: "main-1" });
    expect(await jumpToSession(row({ id: "main-1", visible: true, where: "Home" }))).toBe(true);
    expect(handleAgentSessionSpawned).not.toHaveBeenCalled();
    expect(switchWorkspaceView).toHaveBeenCalledWith("ws-1", "hub");
  });

  it("reports failure when no open workspace can hold the session", async () => {
    withLayout([]);
    expect(await jumpToSession(row({ id: "orphan-1", visible: false, workspaceName: null }))).toBe(
      false
    );
    expect(handleAgentSessionSpawned).not.toHaveBeenCalled();
  });
});

describe("endSession", () => {
  it("asks first, and does nothing when the answer is no", async () => {
    vi.mocked(confirm).mockResolvedValue(false);
    expect(await endSession(row())).toBe(false);
    expect(backend.killSession).not.toHaveBeenCalled();
  });

  it("kills the session and takes its tab with it", async () => {
    expect(await endSession(row())).toBe(true);
    expect(backend.killSession).toHaveBeenCalledWith("s-1");
    // The daemon pushes session-exited for a session it was hosting, but
    // not for a row it had already marked exited -- so the tab would sit
    // there dead until the next reload.
    expect(handleSessionExited).toHaveBeenCalledWith("s-1");
  });

  it("ends a surviving process BEFORE the session that records it", async () => {
    // KillSession deletes the registry row, and the orphan's pid lives on
    // that row: the other order leaves a live process with nothing left
    // that knows how to end it.
    await endSession(row({ orphan: { pid: 4471, command: "claude" } }));
    expect(vi.mocked(backend.endOrphan).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(backend.killSession).mock.invocationCallOrder[0]
    );
  });

  it("stops rather than erasing the only handle on a process that refused", async () => {
    // A SIGTERM-ignoring orphan keeps its session, because that row is
    // where its pid is recorded and the human is not done with it.
    vi.mocked(backend.endOrphan).mockResolvedValue({ ended: false, stillRunning: true });
    expect(await endSession(row({ orphan: { pid: 4471, command: "claude" } }))).toBe(false);
    expect(backend.killSession).not.toHaveBeenCalled();
    expect(vi.mocked(message).mock.calls[0][0]).toContain("4471");
  });

  it("says so when the daemon refuses the kill", async () => {
    vi.mocked(backend.killSession).mockRejectedValue(new Error("no such session"));
    expect(await endSession(row())).toBe(false);
    expect(message).toHaveBeenCalled();
  });
});

describe("endAllSessions", () => {
  it("asks once for the batch, not once per session", async () => {
    await endAllSessions([row({ id: "a" }), row({ id: "b" }), row({ id: "c" })]);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(backend.killSession).toHaveBeenCalledTimes(3);
  });

  it("does nothing at all when the answer is no", async () => {
    vi.mocked(confirm).mockResolvedValue(false);
    expect(await endAllSessions([row()])).toBe(0);
    expect(backend.killSession).not.toHaveBeenCalled();
  });

  it("has nothing to ask about an empty list", async () => {
    expect(await endAllSessions([])).toBe(0);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("carries on past one that refuses, and names the survivors once", async () => {
    // One orphan ignoring SIGTERM must not leave the other sessions
    // running -- and the human still has to be told which are left.
    vi.mocked(backend.killSession).mockImplementation(async (id: string) => {
      if (id === "b") throw new Error("nope");
    });
    expect(await endAllSessions([row({ id: "a" }), row({ id: "b", label: "stuck" }), row({ id: "c" })])).toBe(2);
    expect(vi.mocked(message).mock.calls[0][0]).toContain("stuck");
  });
});
