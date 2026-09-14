import { describe, it, expect, vi, beforeEach } from "vitest";
import { writable } from "svelte/store";

// The in-app dialog, never @tauri-apps/plugin-dialog: that plugin is
// capability-narrowed to the file picker, so a native confirm() here
// rejects at the permission layer and the button silently does nothing
// -- which is exactly the bug "kill all does nothing" turned out to be.
vi.mock("$lib/core/dialog", () => ({
  askConfirm: vi.fn().mockResolvedValue(true),
  showAlert: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("$lib/core/backend", () => ({
  endOrphan: vi.fn(),
  killSession: vi.fn(),
}));
vi.mock("$lib/core/layoutState", () => ({
  layoutState: writable({ workspaces: [] }),
  handleAgentSessionSpawned: vi.fn(),
  handleOrphanEnded: vi.fn(),
  handleSessionExited: vi.fn(),
  restartDaemonInPlace: vi.fn(),
  switchToSessionInPage: vi.fn().mockResolvedValue(undefined),
  switchWorkspaceView: vi.fn().mockResolvedValue(undefined),
}));

import { askConfirm, showAlert } from "$lib/core/dialog";
import * as backend from "$lib/core/backend";
import {
  handleAgentSessionSpawned,
  handleOrphanEnded,
  handleSessionExited,
  layoutState,
  restartDaemonInPlace,
  switchToSessionInPage,
  switchWorkspaceView,
} from "$lib/core/layoutState";
import {
  endAllSessions,
  endIdleSessions,
  endSelectedSessions,
  endSession,
  endStaleSessions,
  jumpToSession,
  restartDaemon,
} from "$lib/sessions/sessionsManagerActions";
import type { KillAlert, KillPrompt, SessionRow } from "$lib/sessions/sessionsManager";

/// The prompt the first ask carried. Throws rather than returning
/// undefined so a test that expected a prompt fails on THAT, not on a
/// property of nothing.
function asked(): KillPrompt {
  const call = vi.mocked(askConfirm).mock.calls[0];
  if (!call) throw new Error("askConfirm was not called");
  return call[0] as KillPrompt;
}

function alerted(): KillAlert {
  const call = vi.mocked(showAlert).mock.calls[0];
  if (!call) throw new Error("showAlert was not called");
  return call[0] as KillAlert;
}

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
    state: "active",
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
  vi.mocked(askConfirm).mockClear().mockResolvedValue(true);
  vi.mocked(showAlert).mockClear();
  vi.mocked(backend.endOrphan).mockReset().mockResolvedValue({ ended: true, stillRunning: false });
  vi.mocked(backend.killSession).mockReset().mockResolvedValue(undefined);
  vi.mocked(handleAgentSessionSpawned).mockClear();
  vi.mocked(handleOrphanEnded).mockClear();
  vi.mocked(handleSessionExited).mockClear();
  vi.mocked(switchToSessionInPage).mockClear();
  vi.mocked(switchWorkspaceView).mockClear();
  vi.mocked(restartDaemonInPlace).mockReset().mockResolvedValue(null);
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
    // orchestration Organize is a real session with nowhere to watch it.
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
    vi.mocked(askConfirm).mockResolvedValue(false);
    expect(await endSession(row())).toBe(false);
    expect(backend.killSession).not.toHaveBeenCalled();
  });

  it("kills the session and takes its tab with it", async () => {
    expect(await endSession(row())).toBe(true);
    expect(backend.killSession).toHaveBeenCalledWith("s-1");
    // The daemon pushes session-exited for a session it was hosting, but
    // not for a row it had already marked exited -- so the tab would sit
    // there dead until the next reload.
    expect(handleSessionExited).toHaveBeenCalledWith("s-1", { force: true });
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
    expect(alerted().lines.join(" ")).toContain("4471");
  });

  it("says so when the daemon refuses the kill", async () => {
    vi.mocked(backend.killSession).mockRejectedValue(new Error("no such session"));
    expect(await endSession(row())).toBe(false);
    expect(showAlert).toHaveBeenCalled();
  });
});

describe("endAllSessions", () => {
  it("asks once for the batch, not once per session", async () => {
    await endAllSessions([row({ id: "a" }), row({ id: "b" }), row({ id: "c" })]);
    expect(askConfirm).toHaveBeenCalledTimes(1);
    expect(backend.killSession).toHaveBeenCalledTimes(3);
  });

  it("does nothing at all when the answer is no", async () => {
    vi.mocked(askConfirm).mockResolvedValue(false);
    expect(await endAllSessions([row()])).toBe(0);
    expect(backend.killSession).not.toHaveBeenCalled();
  });

  it("has nothing to ask about an empty list", async () => {
    expect(await endAllSessions([])).toBe(0);
    expect(askConfirm).not.toHaveBeenCalled();
  });

  it("carries on past one that refuses, and names the survivors once", async () => {
    // One orphan ignoring SIGTERM must not leave the other sessions
    // running -- and the human still has to be told which are left.
    vi.mocked(backend.killSession).mockImplementation(async (id: string) => {
      if (id === "b") throw new Error("nope");
    });
    expect(await endAllSessions([row({ id: "a" }), row({ id: "b", label: "stuck" }), row({ id: "c" })])).toBe(2);
    expect(alerted().lines.join(" ")).toContain("stuck");
  });

  it("asks as a danger prompt, so Enter cannot fire it by reflex", async () => {
    await endAllSessions([row({ id: "a" }), row({ id: "b" })]);
    expect(asked().danger).toBe(true);
  });
});

describe("endStaleSessions", () => {
  it("ends only the stale rows, and leaves the live ones alone", async () => {
    const ended = await endStaleSessions([
      row({ id: "live" }),
      row({ id: "gone", stale: true, staleness: "exited", state: "exited", status: "exited" }),
      row({ id: "shell", stale: true, staleness: "interrupted", state: "interrupted" }),
    ]);
    expect(ended).toBe(2);
    expect(vi.mocked(backend.killSession).mock.calls.map((c) => c[0])).toEqual(["gone", "shell"]);
  });

  it("has nothing to ask when nothing is stale", async () => {
    expect(await endStaleSessions([row()])).toBe(0);
    expect(askConfirm).not.toHaveBeenCalled();
  });

  it("asks once, with the stale wording", async () => {
    await endStaleSessions([
      row({ id: "gone", stale: true, staleness: "exited", state: "exited" }),
      row({ id: "gone-2", stale: true, staleness: "exited", state: "exited" }),
    ]);
    expect(askConfirm).toHaveBeenCalledTimes(1);
    expect(asked().confirmLabel).toBe("Clear stale");
  });
});

describe("endIdleSessions", () => {
  it("ends only idle rows, and leaves working and waiting alone", async () => {
    const ended = await endIdleSessions([
      row({ id: "busy", status: "working", state: "active" }),
      row({ id: "quiet", status: "idle", state: "idle" }),
      row({ id: "ask", status: "waiting_for_input", state: "waiting" }),
      row({ id: "hidden-quiet", status: "idle", state: "hidden", visible: false }),
    ]);
    expect(ended).toBe(2);
    expect(vi.mocked(backend.killSession).mock.calls.map((c) => c[0])).toEqual([
      "quiet",
      "hidden-quiet",
    ]);
  });

  it("leaves stale rows to Clear stale", async () => {
    expect(
      await endIdleSessions([
        row({ id: "gone", stale: true, staleness: "exited", state: "exited", status: "exited" }),
      ])
    ).toBe(0);
    expect(askConfirm).not.toHaveBeenCalled();
  });

  it("asks once with the Kill idle wording, including the lost-work warning", async () => {
    await endIdleSessions([
      row({ id: "a", status: "idle", state: "idle" }),
      row({ id: "b", status: "idle", state: "idle" }),
    ]);
    expect(askConfirm).toHaveBeenCalledTimes(1);
    expect(asked().confirmLabel).toBe("Kill idle");
    expect(asked().danger).toBe(true);
    expect(asked().lines.join(" ")).toMatch(/might still get lost/i);
  });

  it("does nothing when the answer is no", async () => {
    vi.mocked(askConfirm).mockResolvedValue(false);
    expect(await endIdleSessions([row({ id: "a", status: "idle", state: "idle" })])).toBe(0);
    expect(backend.killSession).not.toHaveBeenCalled();
  });
});

describe("endSelectedSessions", () => {
  it("ends the given rows after one prompt that names them", async () => {
    const ended = await endSelectedSessions([row({ id: "a", label: "one" }), row({ id: "b", label: "two" })]);
    expect(ended).toBe(2);
    expect(askConfirm).toHaveBeenCalledTimes(1);
    expect(asked().lines.join(" ")).toContain("one");
  });

  it("asks about one selected row exactly as the row's own button would", async () => {
    await endSelectedSessions([row({ label: "solo" })]);
    expect(asked().title).toContain("solo");
  });

  it("does nothing when the answer is no", async () => {
    vi.mocked(askConfirm).mockResolvedValue(false);
    expect(await endSelectedSessions([row({ id: "a" }), row({ id: "b" })])).toBe(0);
    expect(backend.killSession).not.toHaveBeenCalled();
  });
});

describe("restartDaemon", () => {
  const V25 = { daemonVersion: 25, appVersion: 25, degraded: false };

  it("asks before taking the daemon away, with this list's own count", async () => {
    expect(await restartDaemon([row({ id: "a" }), row({ id: "b" })], V25)).toBe(true);
    expect(askConfirm).toHaveBeenCalledTimes(1);
    expect(asked().title).toContain("Restart gavin-daemon");
    expect(asked().lines.join(" ")).toContain("All 2 sessions in this list");
    expect(asked().danger).toBe(true);
  });

  it("does nothing at all when the answer is no", async () => {
    vi.mocked(askConfirm).mockResolvedValue(false);
    expect(await restartDaemon([row()], V25)).toBe(false);
    expect(restartDaemonInPlace).not.toHaveBeenCalled();
  });

  it("goes through restartDaemonInPlace, which re-reads what recovery rebuilt", async () => {
    // backend.restartDaemon alone would leave the app holding a picture
    // of sessions the daemon has just replaced with bare shells.
    await restartDaemon([row()], V25);
    expect(restartDaemonInPlace).toHaveBeenCalledTimes(1);
  });

  it("tells the caller the daemon is gone before it goes, and only then", async () => {
    // The panel stops polling on this signal and labels its button with
    // it. Firing at the click would make the button say "Restarting…"
    // while a dialog is still asking whether to.
    const events: string[] = [];
    vi.mocked(askConfirm).mockImplementation(async () => {
      events.push("asked");
      return true;
    });
    vi.mocked(restartDaemonInPlace).mockImplementation(async () => {
      events.push("restarting");
      return null;
    });
    await restartDaemon([row()], V25, () => events.push("confirmed"));
    expect(events).toEqual(["asked", "confirmed", "restarting"]);
  });

  it("never signals the confirmed hook when the human said no", async () => {
    vi.mocked(askConfirm).mockResolvedValue(false);
    const onConfirmed = vi.fn();
    await restartDaemon([row()], V25, onConfirmed);
    expect(onConfirmed).not.toHaveBeenCalled();
  });

  it("reports a failed restart rather than looking like it worked", async () => {
    vi.mocked(restartDaemonInPlace).mockRejectedValue(new Error("pkill unavailable"));
    expect(await restartDaemon([row()], V25)).toBe(false);
    expect(alerted().lines.join(" ")).toContain("pkill unavailable");
  });

  it("says so when the daemon came back at the very same old version", async () => {
    // The silent failure this button has: the gavin-daemon binary beside
    // the app is itself the stale one, so the restart happens and can
    // never help. A press that reads as a no-op is what that looks like.
    const same = { daemonVersion: 24, appVersion: 25, degraded: true };
    vi.mocked(restartDaemonInPlace).mockResolvedValue(same);
    expect(await restartDaemon([row()], same)).toBe(true);
    expect(alerted().lines.join(" ")).toContain("the same version");
  });

  it("stays quiet when the restart actually lifted the gap", async () => {
    vi.mocked(restartDaemonInPlace).mockResolvedValue(V25);
    expect(await restartDaemon([row()], { daemonVersion: 24, appVersion: 25, degraded: true })).toBe(
      true
    );
    expect(showAlert).not.toHaveBeenCalled();
  });
});
