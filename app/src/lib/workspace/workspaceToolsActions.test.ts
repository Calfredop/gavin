import { describe, it, expect, vi, beforeEach } from "vitest";
import { get, writable } from "svelte/store";

vi.mock("$lib/core/backend", () => ({
  createSession: vi.fn(),
  startToolRun: vi.fn().mockResolvedValue(undefined),
  setToolRunOutcome: vi.fn().mockResolvedValue(undefined),
  toolRuns: vi.fn().mockResolvedValue([]),
  getTools: vi.fn().mockResolvedValue([]),
}));
vi.mock("$lib/core/layoutState", () => ({
  layoutState: writable({ sessionStatusById: {} as Record<string, string> }),
  daemonCompat: writable({ daemonVersion: 30, appVersion: 30, degraded: false }),
  sessionExits: writable(new Map<string, number>()),
  resolvedAgentFor: vi.fn(),
  conversationIdForLaunch: vi.fn(() => "conv-1"),
  armFailureDetection: vi.fn().mockResolvedValue(undefined),
  handleAgentSessionSpawned: vi.fn(),
  setSessionName: vi.fn().mockResolvedValue(undefined),
  workspaceRootPath: vi.fn(() => "/repo" as string | null),
}));
vi.mock("$lib/cards/cardRunActions", () => ({ revealSession: vi.fn().mockResolvedValue(true) }));

import * as backend from "$lib/core/backend";
import {
  armFailureDetection,
  daemonCompat,
  handleAgentSessionSpawned,
  layoutState,
  resolvedAgentFor,
  setSessionName,
  workspaceRootPath,
} from "$lib/core/layoutState";
import { revealSession } from "$lib/cards/cardRunActions";
import { toolRecords, __resetForTesting as resetTools } from "$lib/orchestration/toolsState";
import {
  toolRunsStore,
  __resetForTesting as resetRuns,
} from "$lib/orchestration/toolRunsState";
import {
  cancelToolRun,
  confirmToolRun,
  initWorkspaceToolListeners,
  requestToolRun,
  toolRunRequest,
  __resetForTesting,
} from "$lib/workspace/workspaceToolsActions";
import type { Tool } from "$lib/orchestration/orchestrationTools";

const AGENT = {
  profileId: "claude-code",
  label: "Claude Code",
  file: "CLAUDE.md",
  command: "claude",
  launchCommand: "claude",
  mcpSupported: true,
  headlessArgs: "-p --",
  promptArgs: "" as string | null,
  mcpConfigFile: ".mcp.json",
  model: "",
  failurePatterns: ["API Error:"],
  failureCauses: [],
  sessionIdArgs: "--session-id",
  resumeArgs: "",
};

function tool(over: Partial<Tool> = {}): Tool {
  return {
    id: "u1",
    name: "Deploy",
    description: "",
    kind: "command",
    body: "./deploy.sh",
    params: [],
    scope: "workspace",
    cwd: null,
    ...over,
  };
}

let stopListeners: (() => void) | null = null;

beforeEach(() => {
  stopListeners?.();
  stopListeners = null;
  __resetForTesting();
  resetRuns();
  resetTools();
  vi.clearAllMocks();
  vi.mocked(resolvedAgentFor).mockReturnValue(AGENT as never);
  vi.mocked(workspaceRootPath).mockReturnValue("/repo");
  vi.mocked(backend.createSession).mockResolvedValue("sess-1");
  vi.mocked(backend.toolRuns).mockResolvedValue([]);
  daemonCompat.set({ daemonVersion: 30, appVersion: 30, degraded: false });
  layoutState.set({ sessionStatusById: {} } as never);
});

describe("requestToolRun", () => {
  // A tool whose whole definition is on the row in front of the human
  // does not need a confirmation. Asking would be a click that buys
  // nothing.
  it("launches a parameterless tool straight away", async () => {
    expect(await requestToolRun("ws-1", tool())).toBeNull();
    expect(get(toolRunRequest)).toBeNull();
    expect(backend.createSession).toHaveBeenCalledWith(
      "/repo",
      expect.stringContaining("./deploy.sh"),
      "/repo"
    );
  });

  it("asks for parameters before launching a tool that has them", async () => {
    const withParams = tool({ params: [{ name: "env", label: "Environment", default: "staging" }] });
    expect(await requestToolRun("ws-1", withParams)).toBeNull();
    expect(backend.createSession).not.toHaveBeenCalled();
    expect(get(toolRunRequest)?.values).toEqual({ env: "staging" });
    // Resolved when the dialog OPENS, so the dialog can say where it
    // will run.
    expect(get(toolRunRequest)?.cwd).toBe("/repo");
  });

  it("cancels without launching", async () => {
    await requestToolRun("ws-1", tool({ params: [{ name: "env", label: "", default: "" }] }));
    cancelToolRun();
    expect(get(toolRunRequest)).toBeNull();
    expect(backend.createSession).not.toHaveBeenCalled();
  });

  // The compat gate with a real consumer: against a v29 daemon there is
  // nowhere to keep the run, so the launch is refused with the version
  // rather than started and forgotten.
  it("refuses against a daemon too old to keep the run", async () => {
    daemonCompat.set({ daemonVersion: 29, appVersion: 30, degraded: true });
    expect(await requestToolRun("ws-1", tool())).toMatch(/v30/);
    expect(backend.createSession).not.toHaveBeenCalled();
  });

  it("refuses a tool kind that only means something on a rail", async () => {
    expect(await requestToolRun("ws-1", tool({ kind: "until" }))).toMatch(/rail/);
    expect(backend.createSession).not.toHaveBeenCalled();
  });

  it("refuses when the workspace has no root to run in", async () => {
    vi.mocked(workspaceRootPath).mockReturnValue(null);
    expect(await requestToolRun("ws-1", tool())).toMatch(/root folder/);
    expect(backend.createSession).not.toHaveBeenCalled();
  });
});

describe("the launch", () => {
  it("runs a tool with its own directory THERE, not at the root", async () => {
    await requestToolRun("ws-1", tool({ cwd: "apps/web" }));
    // Its own directory is where it RUNS; the workspace root is the scope
    // the daemon gives the agent, and a tool with a cwd of its own is
    // exactly where those two part company.
    expect(backend.createSession).toHaveBeenCalledWith("/repo/apps/web", expect.any(String), "/repo");
  });

  it("substitutes the values the dialog collected", async () => {
    await requestToolRun(
      "ws-1",
      tool({ body: "./deploy.sh {{env}}", params: [{ name: "env", label: "", default: "staging" }] })
    );
    expect(await confirmToolRun({ env: "prod" })).toBeNull();
    expect(backend.createSession).toHaveBeenCalledWith(
      "/repo",
      expect.stringContaining("./deploy.sh prod"),
      "/repo"
    );

    expect(get(toolRunRequest)).toBeNull();
  });

  // Named, revealed and spawned exactly as a rail step is: a shell
  // tool's PTY can close in under a second, so an unnamed tab nobody was
  // shown is a run with no evidence left.
  it("names the tab, reveals the session and registers it with the workspace", async () => {
    await requestToolRun("ws-1", tool());
    expect(setSessionName).toHaveBeenCalledWith("sess-1", "Deploy");
    expect(revealSession).toHaveBeenCalledWith("sess-1");
    expect(handleAgentSessionSpawned).toHaveBeenCalledWith("ws-1", "sess-1");
  });

  it("files the run with the daemon, so a failure nobody watched survives", async () => {
    await requestToolRun("ws-1", tool({ cwd: "apps/web" }));
    expect(backend.startToolRun).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      toolId: "u1",
      sessionId: "sess-1",
      command: expect.stringContaining("./deploy.sh"),
      launchCwd: "/repo/apps/web",
      conversationId: null,
    });
    // And locally, so the row says `running` before the next fetch.
    expect(get(toolRunsStore)["ws-1"].runs[0].outcome).toBe("running");
  });

  // Only an agent tool gets a conversation and failure detection: a
  // shell has no conversation, and its verdict is its exit code.
  it("arms failure detection and mints a conversation only for an agent tool", async () => {
    await requestToolRun("ws-1", tool({ kind: "agent", body: "do the thing" }));
    expect(armFailureDetection).toHaveBeenCalledWith("sess-1", ["API Error:"]);
    expect(backend.startToolRun).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: "conv-1" })
    );

    vi.clearAllMocks();
    vi.mocked(backend.createSession).mockResolvedValue("sess-2");
    await requestToolRun("ws-1", tool({ id: "u2" }));
    expect(armFailureDetection).not.toHaveBeenCalled();
    expect(backend.startToolRun).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: null })
    );
  });

  it("reports a session that could not be started", async () => {
    vi.mocked(backend.createSession).mockRejectedValue(new Error("no pty"));
    expect(await requestToolRun("ws-1", tool())).toMatch(/no pty/);
    expect(backend.startToolRun).not.toHaveBeenCalled();
  });

  // The run is already going in front of the human; a failed rename or
  // an unfiled row is a missing chip, not a failed launch.
  it("still succeeds when naming the tab or filing the run fails", async () => {
    vi.mocked(setSessionName).mockRejectedValue(new Error("nope"));
    vi.mocked(backend.startToolRun).mockRejectedValue(new Error("nope"));
    expect(await requestToolRun("ws-1", tool())).toBeNull();
  });
});

describe("an agent tool's verdict", () => {
  const agentTool = {
    id: "u-agent",
    workspaceId: "ws-1",
    name: "Consolidate",
    description: "",
    kind: "agent" as const,
    body: "do it",
    params: [],
    position: 0,
    cwd: null,
    icon: null,
  };

  beforeEach(() => {
    toolRecords.set({ "ws-1": [agentTool] });
    toolRunsStore.set({
      "ws-1": {
        runs: [
          {
            id: 1,
            toolId: "u-agent",
            sessionId: "sess-1",
            command: "claude 'do it'",
            launchCwd: "/repo",
            conversationId: "conv-1",
            startedAt: 1,
            endedAt: null,
            exitCode: null,
            outcome: "running",
          },
        ],
        loading: false,
        error: null,
        token: 1,
      },
    });
    stopListeners = initWorkspaceToolListeners();
  });

  // An interactive agent's session never exits, so nothing the daemon
  // watches would ever close the row. Its turn ending IS its completion
  // -- the same rule a rail's agent tool step runs on.
  it("passes when the session's turn ends", async () => {
    layoutState.set({ sessionStatusById: { "sess-1": "idle" } } as never);
    await Promise.resolve();
    expect(backend.setToolRunOutcome).toHaveBeenCalledWith("sess-1", "passed");
  });

  // A broken agent and a finished one are byte-identical to the daemon's
  // quiet-period heuristic; failure detection is what tells them apart.
  it("fails when failure detection fires", async () => {
    layoutState.set({ sessionStatusById: { "sess-1": "failed" } } as never);
    await Promise.resolve();
    expect(backend.setToolRunOutcome).toHaveBeenCalledWith("sess-1", "failed");
  });

  it("says nothing while the agent is still working", async () => {
    layoutState.set({ sessionStatusById: { "sess-1": "working" } } as never);
    await Promise.resolve();
    expect(backend.setToolRunOutcome).not.toHaveBeenCalled();
  });

  // A status that flickers idle → working → idle must not file twice.
  it("files one verdict per session", async () => {
    layoutState.set({ sessionStatusById: { "sess-1": "idle" } } as never);
    await Promise.resolve();
    layoutState.set({ sessionStatusById: { "sess-1": "working" } } as never);
    layoutState.set({ sessionStatusById: { "sess-1": "idle" } } as never);
    await Promise.resolve();
    expect(vi.mocked(backend.setToolRunOutcome).mock.calls).toHaveLength(1);
  });

  // A SHELL tool's verdict is its exit code, and the daemon writes it
  // off the exit it already watches. The app filing one too would be a
  // second opinion about the same run.
  it("leaves a command tool's run to the daemon", async () => {
    toolRecords.set({ "ws-1": [{ ...agentTool, kind: "command" }] });
    layoutState.set({ sessionStatusById: { "sess-1": "idle" } } as never);
    await Promise.resolve();
    expect(backend.setToolRunOutcome).not.toHaveBeenCalled();
  });

  // A library still loading, or a tool since deleted. Completing on a
  // guess is what "the run keeps waiting for its session to end" avoids.
  it("waits rather than guessing when the tool is not in the library", async () => {
    toolRecords.set({ "ws-1": [] });
    layoutState.set({ sessionStatusById: { "sess-1": "idle" } } as never);
    await Promise.resolve();
    expect(backend.setToolRunOutcome).not.toHaveBeenCalled();
  });

  it("files nothing against a daemon that keeps no runs", async () => {
    daemonCompat.set({ daemonVersion: 29, appVersion: 30, degraded: true });
    layoutState.set({ sessionStatusById: { "sess-1": "idle" } } as never);
    await Promise.resolve();
    expect(backend.setToolRunOutcome).not.toHaveBeenCalled();
  });
});
