import { beforeEach, describe, expect, it, vi } from "vitest";
import { writable } from "svelte/store";

vi.mock("$lib/core/backend", () => ({
  listScheduledTasks: vi.fn(),
  claimScheduledFire: vi.fn(),
  recordScheduledLaunch: vi.fn(async () => {}),
  createSession: vi.fn(async () => "s-new"),
  setSessionName: vi.fn(async () => {}),
  adoptSession: vi.fn(async () => true),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));

const claude = {
  profileId: "claude-code",
  label: "Claude Code",
  launchCommand: "claude",
  headlessArgs: '-p --allowedTools "Bash(git *)" --',
};
const agent = { current: claude as typeof claude };
vi.mock("$lib/core/layoutState", () => ({
  agentForCard: vi.fn(() => agent.current),
  daemonCompat: writable({ daemonVersion: 77, appVersion: 77, degraded: false }),
  layoutState: writable({ workspaces: [{ id: "ws-1", rootPath: "/ws" }] }),
  prepareCursorAgentLaunch: vi.fn(async (_ws: string, _root: string, a: unknown) => a),
  profileIdForLaunch: (a: { profileId: string }) => a.profileId,
  workspaceRootPath: () => "/ws",
}));

const walls = { paused: false, memory: false, runsHere: true };
vi.mock("$lib/agents/agentPauseState", () => ({
  mayStartWork: () => !walls.paused,
  startBlockedReason: () => "work is paused: until 14:00",
}));
vi.mock("$lib/agents/launchQueue", () => ({
  mayLaunch: () => !walls.memory,
  launchBlockedReason: () => "memory is under pressure",
}));
vi.mock("$lib/shell/appDuty", () => ({ runsRailsFor: () => walls.runsHere }));
vi.mock("$lib/agents/actionPromptsState", async () => {
  const { DEFAULT_RUN_SCHEDULED } = await import("$lib/agents/actionPromptDefaults");
  return { mustPromptBody: () => DEFAULT_RUN_SCHEDULED };
});

import * as backend from "$lib/core/backend";
import {
  answerRunNowRequest,
  refreshScheduled,
  runScheduledNow,
  scheduledTasks,
  tickScheduled,
} from "$lib/scheduling/scheduledState";
import type { FireClaim, ScheduledTask } from "$lib/scheduling/scheduledTask";

function task(over: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    path: "/ws/.gavin-root/scheduled/t.md",
    name: "t",
    title: "Nightly",
    agent: null,
    model: null,
    effort: null,
    complexity: null,
    from: "t.md",
    schedule: "at=2026-10-21T09:00 every=2m runs=3",
    rule: { at: "2026-10-21T09:00", every: { n: 2, unit: "minutes" }, runs: 3 },
    scheduleError: null,
    paused: false,
    body: "Check the build.",
    fireCount: 0,
    lastSlot: null,
    fires: [],
    ...over,
  };
}

function claim(over: Partial<FireClaim> = {}): FireClaim {
  return {
    claimed: true,
    fireId: 7,
    fireNumber: 1,
    reportPath: "/ws/.gavin-root/scheduled/runs/t/20261021-090900.md",
    skipped: null,
    why: null,
    ...over,
  };
}

const now = new Date(2026, 9, 21, 9, 9, 0);

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(walls, { paused: false, memory: false, runsHere: true });
  agent.current = claude;
  scheduledTasks.set({ "ws-1": [task()] });
  vi.mocked(backend.listScheduledTasks).mockResolvedValue([task()]);
  vi.mocked(backend.claimScheduledFire).mockResolvedValue(claim());
});

describe("a due fire", () => {
  it("is claimed at its latest slot, launched headless in the checkout, and recorded", async () => {
    await tickScheduled("ws-1", now);
    expect(backend.claimScheduledFire).toHaveBeenCalledWith("ws-1", "/ws/.gavin-root/scheduled/t.md", 4, "20261021-090900", null);
    const [cwd, command, root, profile] = vi.mocked(backend.createSession).mock.calls[0];
    expect([cwd, root, profile]).toEqual(["/ws", "/ws", "claude-code"]);
    expect(command).toMatch(/^claude -p --permission-mode acceptEdits --allowedTools "Bash\(git \*\)" -- '/);
    expect(command).toContain("scheduled run #1");
    expect(command).toContain("Check the build.");
    expect(command).toContain("/ws/.gavin-root/scheduled/runs/t/20261021-090900.md");
    expect(backend.recordScheduledLaunch).toHaveBeenCalledWith("ws-1", 7, "s-new", null);
  });

  it("is not launched when another app won the claim", async () => {
    vi.mocked(backend.claimScheduledFire).mockResolvedValue(claim({ claimed: false, fireId: null, why: "that fire was already claimed" }));
    await tickScheduled("ws-1", now);
    expect(backend.createSession).not.toHaveBeenCalled();
  });

  it("is claimed as skipped, with the reason, behind the pause or the memory wall", async () => {
    walls.memory = true;
    vi.mocked(backend.claimScheduledFire).mockResolvedValue(claim({ skipped: "memory is under pressure", reportPath: null }));
    await tickScheduled("ws-1", now);
    expect(vi.mocked(backend.claimScheduledFire).mock.calls[0][4]).toBe("memory is under pressure");
    expect(backend.createSession).not.toHaveBeenCalled();

    vi.clearAllMocks();
    walls.memory = false;
    walls.paused = true;
    vi.mocked(backend.claimScheduledFire).mockResolvedValue(claim({ skipped: "x", reportPath: null }));
    await tickScheduled("ws-1", now);
    expect(vi.mocked(backend.claimScheduledFire).mock.calls[0][4]).toBe("work is paused: until 14:00");
  });

  it("is skipped when the agent it resolves to has no headless mode", async () => {
    agent.current = { ...claude, profileId: "custom", label: "My CLI", headlessArgs: "" };
    vi.mocked(backend.claimScheduledFire).mockResolvedValue(claim({ skipped: "x", reportPath: null }));
    await tickScheduled("ws-1", now);
    expect(vi.mocked(backend.claimScheduledFire).mock.calls[0][4]).toBe("My CLI has no headless mode a scheduled run can use");
  });

  it("is never fired by a window that does not run this workspace's rails", async () => {
    walls.runsHere = false;
    await tickScheduled("ws-1", now);
    expect(backend.claimScheduledFire).not.toHaveBeenCalled();
  });

  it("records why a claimed launch could not start", async () => {
    vi.mocked(backend.createSession).mockRejectedValueOnce(new Error("no pty"));
    await tickScheduled("ws-1", now);
    expect(backend.recordScheduledLaunch).toHaveBeenCalledWith("ws-1", 7, null, "The run could not start: no pty");
  });
});

describe("nothing due", () => {
  it("claims nothing before the start, while paused, or once completed", async () => {
    for (const t of [task({ paused: true }), task({ fireCount: 3, lastSlot: 2 })]) {
      scheduledTasks.set({ "ws-1": [t] });
      await tickScheduled("ws-1", now);
    }
    await tickScheduled("ws-1", new Date(2026, 9, 21, 8, 0));
    expect(backend.claimScheduledFire).not.toHaveBeenCalled();
  });
});

describe("Run now", () => {
  it("claims no slot and runs through a pause, but not the memory wall", async () => {
    walls.paused = true;
    vi.mocked(backend.claimScheduledFire).mockResolvedValue(claim({ fireNumber: null }));
    expect(await runScheduledNow("ws-1", task())).toBeNull();
    expect(vi.mocked(backend.claimScheduledFire).mock.calls[0][2]).toBeNull();
    expect(vi.mocked(backend.createSession).mock.calls[0][1]).toContain("a run started by hand (Run now)");

    walls.memory = true;
    expect(await runScheduledNow("ws-1", task())).toBe("memory is under pressure");
  });

  it("says why when a run is already going", async () => {
    vi.mocked(backend.claimScheduledFire).mockResolvedValue(
      claim({ claimed: false, fireId: null, why: "a run of this task is already going" })
    );
    expect(await runScheduledNow("ws-1", task())).toBe("a run of this task is already going");
    expect(backend.createSession).not.toHaveBeenCalled();
  });
});

describe("a Device's Run now", () => {
  it("is the desk's own launch, answered with why when it does not start", async () => {
    vi.mocked(backend.claimScheduledFire).mockResolvedValue(claim({ fireNumber: null }));
    expect(await answerRunNowRequest({ id: 1, workspaceId: "ws-1", path: task().path })).toEqual({ value: null });
    expect(backend.createSession).toHaveBeenCalled();
    expect(await answerRunNowRequest({ id: 2, workspaceId: "ws-1", path: "/elsewhere.md" })).toEqual({
      refused: "This Scheduled task is no longer on the Workstation.",
    });
  });
});

describe("after a restart", () => {
  it("attaches to a run that is still going", async () => {
    vi.mocked(backend.listScheduledTasks).mockResolvedValue([
      task({
        fires: [
          {
            id: 1, slot: 0, at: 0, outcome: "running", skipReason: null, sessionId: "s-old", exitCode: null,
            endedAt: null, reportPath: null, headline: null, hasReport: false, hasRaw: false,
          },
        ],
      }),
    ]);
    await refreshScheduled("ws-1");
    expect(backend.adoptSession).toHaveBeenCalledWith("s-old");
  });
});
