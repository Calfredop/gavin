import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { get } from "svelte/store";

const backendMock = vi.hoisted(() => ({
  systemMemory: vi.fn(),
  watchmanStatus: vi.fn(),
  listManagedSessions: vi.fn(),
}));

vi.mock("$lib/core/backend", () => backendMock);

vi.mock("$lib/core/layoutState", async () => {
  const { writable } = await import("svelte/store");
  return {
    layoutState: writable({ workspaces: [], activeWorkspaceId: null }),
    resolvedAgentFor: () => ({ profileId: "claude-code" }),
  };
});

// The other windows, as the host would carry them: `emit` is recorded,
// and `fire` plays a message another window sent.
const eventMock = vi.hoisted(() => {
  const handlers = new Map<string, Array<(event: { payload: unknown }) => void>>();
  return {
    handlers,
    listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      return () => {
        handlers.set(
          name,
          (handlers.get(name) ?? []).filter((h) => h !== handler)
        );
      };
    }),
    emit: vi.fn(async (_name: string, _message: unknown) => {}),
    fire(name: string, payload: unknown): void {
      for (const handler of handlers.get(name) ?? []) handler({ payload });
    },
  };
});

vi.mock("@tauri-apps/api/event", () => ({ listen: eventMock.listen, emit: eventMock.emit }));

import {
  __resetMemoryForTesting,
  agentSessions,
  initMemorySharing,
  startMemoryPoll,
  systemMemory,
  watchmanStore,
} from "$lib/agents/memoryState";
import { appDuty } from "$lib/shell/appDuty";
import type { SystemMemorySample, WatchmanSample } from "$lib/agents/memory";

const SAMPLE = {
  supported: true,
  totalBytes: 32,
  usedBytes: 16,
  sampledAtMs: 1,
} as unknown as SystemMemorySample;
const WATCHMAN = { pid: 7, rssBytes: 4, rootsJson: "[]" } as unknown as WatchmanSample;
const AGENT = {
  id: "s1",
  command: "claude",
  status: "running",
  rssBytes: 8,
  processCount: 3,
  workspacePath: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  eventMock.handlers.clear();
  __resetMemoryForTesting();
  appDuty.set({ holder: "main", windows: ["main"] });
  backendMock.systemMemory.mockResolvedValue(SAMPLE);
  backendMock.watchmanStatus.mockResolvedValue(WATCHMAN);
  backendMock.listManagedSessions.mockResolvedValue({ sessions: [AGENT], metrics: true });
});

afterEach(() => {
  __resetMemoryForTesting();
});

/// Lets the poll's three awaits settle.
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe("memory across windows", () => {
  it("tells the other windows everything a pass read", async () => {
    appDuty.set({ holder: "main", windows: ["main", "ws-2"] });
    startMemoryPoll();
    await settle();
    expect(eventMock.emit).toHaveBeenCalledWith("memory-reading", {
      origin: "main",
      payload: {
        system: SAMPLE,
        watchman: WATCHMAN,
        agents: {
          s1: {
            sessionId: "s1",
            profileId: null,
            rssBytes: 8,
            processCount: 3,
            command: "claude",
          },
        },
      },
    });
  });

  it("tells nobody when it is the only window", async () => {
    startMemoryPoll();
    await settle();
    expect(backendMock.systemMemory).toHaveBeenCalled();
    expect(eventMock.emit).not.toHaveBeenCalled();
  });

  it("takes another window's reading without asking the host", async () => {
    await initMemorySharing();
    const agents = {
      s1: { sessionId: "s1", profileId: "claude-code", rssBytes: 8, processCount: 3, command: "claude" },
    };
    eventMock.fire("memory-reading", {
      origin: "ws-2",
      payload: { system: SAMPLE, watchman: WATCHMAN, agents },
    });
    expect(get(systemMemory)).toEqual(SAMPLE);
    expect(get(watchmanStore)).toEqual(WATCHMAN);
    expect(get(agentSessions)).toEqual(agents);
    expect(backendMock.systemMemory).not.toHaveBeenCalled();
    expect(backendMock.watchmanStatus).not.toHaveBeenCalled();
    expect(backendMock.listManagedSessions).not.toHaveBeenCalled();
  });
});
