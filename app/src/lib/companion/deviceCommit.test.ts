import { beforeEach, describe, expect, it, vi } from "vitest";

const heard = vi.hoisted(() => ({ handler: null as ((e: { payload: unknown }) => void) | null }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((_event: string, handler: (e: { payload: unknown }) => void) => {
    heard.handler = handler;
    return Promise.resolve(() => {});
  }),
}));
vi.mock("$lib/core/backend", () => ({ answerAgentCommitRequest: vi.fn().mockResolvedValue(undefined) }));
vi.mock("$lib/git/gitState", () => ({
  commitViaAgentForDevice: vi.fn(),
  stopAgentCommitForDevice: vi.fn(),
  watchesAgentCommit: vi.fn(() => false),
}));
vi.mock("$lib/shell/appDuty", () => ({ runsRailsFor: vi.fn(() => true) }));

import { listen } from "@tauri-apps/api/event";
import * as backend from "$lib/core/backend";
import { commitViaAgentForDevice, stopAgentCommitForDevice, watchesAgentCommit } from "$lib/git/gitState";
import { runsRailsFor } from "$lib/shell/appDuty";
import {
  AGENT_COMMIT_REQUESTED,
  answerRequest,
  answersRequest,
  startDeviceCommitRequests,
  type AgentCommitRequested,
} from "$lib/companion/deviceCommit";

const START: AgentCommitRequested = { id: 7, workspaceId: "ws", action: "start", cwd: "/r" };
const STOP: AgentCommitRequested = { id: 8, workspaceId: "ws", action: "stop", sessionId: "agent-1" };

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("which window answers", () => {
  it("a start: the window whose work the workspace is", () => {
    vi.mocked(runsRailsFor).mockReturnValueOnce(true).mockReturnValueOnce(false);
    expect(answersRequest(START)).toBe(true);
    expect(answersRequest(START)).toBe(false);
    expect(runsRailsFor).toHaveBeenCalledWith("ws");
  });

  it("a stop: the window watching that run, wherever it was started", () => {
    vi.mocked(watchesAgentCommit).mockReturnValueOnce(true);
    expect(answersRequest(STOP)).toBe(true);
    expect(watchesAgentCommit).toHaveBeenCalledWith("ws", "agent-1");
    expect(runsRailsFor).not.toHaveBeenCalled();
  });
});

describe("the answer", () => {
  it("names the session a start began", async () => {
    vi.mocked(commitViaAgentForDevice).mockResolvedValueOnce({ sessionId: "agent-1", startedAt: 5 });
    expect(await answerRequest(START)).toEqual({ value: { sessionId: "agent-1", startedAt: 5 } });
    expect(commitViaAgentForDevice).toHaveBeenCalledWith("ws", "/r");
  });

  it("passes a refusal on in its own words", async () => {
    vi.mocked(commitViaAgentForDevice).mockResolvedValueOnce({ refused: "Nothing to commit" });
    expect(await answerRequest(START)).toEqual({ refused: "Nothing to commit" });
    vi.mocked(stopAgentCommitForDevice).mockResolvedValueOnce("Could not stop the commit agent: gone");
    expect(await answerRequest(STOP)).toEqual({ refused: "Could not stop the commit agent: gone" });
  });

  it("answers a stop on its way with nothing", async () => {
    vi.mocked(stopAgentCommitForDevice).mockResolvedValueOnce(null);
    expect(await answerRequest(STOP)).toEqual({ value: null });
  });

  it("turns a throw into a refusal, so the phone hears something", async () => {
    vi.mocked(commitViaAgentForDevice).mockRejectedValueOnce(new Error("boom"));
    expect(await answerRequest(START)).toEqual({ refused: "boom" });
  });
});

describe("listening", () => {
  it("answers the requests that are this window's, by id, and leaves the rest alone", async () => {
    await startDeviceCommitRequests();
    expect(listen).toHaveBeenCalledWith(AGENT_COMMIT_REQUESTED, expect.any(Function));

    vi.mocked(commitViaAgentForDevice).mockResolvedValueOnce({ sessionId: "agent-1", startedAt: 5 });
    heard.handler?.({ payload: START });
    await flush();
    expect(backend.answerAgentCommitRequest).toHaveBeenCalledWith(7, { value: { sessionId: "agent-1", startedAt: 5 } });

    vi.mocked(backend.answerAgentCommitRequest).mockClear();
    heard.handler?.({ payload: STOP });
    await flush();
    expect(stopAgentCommitForDevice).not.toHaveBeenCalled();
    expect(backend.answerAgentCommitRequest).not.toHaveBeenCalled();
  });
});
