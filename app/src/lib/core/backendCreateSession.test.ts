import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve("s1")) }));

import { invoke } from "@tauri-apps/api/core";
import { createSession, headroomReach } from "$lib/core/backend";
import { withoutHeadroom } from "$lib/agents/compression";

beforeEach(() => {
  vi.mocked(invoke).mockClear();
});

// What reaches the host is what reaches the daemon. Every launch but one
// must send the arguments it always sent; the one is auto-resume's
// relaunch of a run that broke on Headroom.
describe("createSession", () => {
  it("sends the bare profile, and no override, for every ordinary launch", async () => {
    await createSession("/ws/tree", "claude 'go'", "/ws", "claude-code");
    expect(invoke).toHaveBeenCalledWith("create_session", {
      cwd: "/ws/tree",
      command: "claude 'go'",
      workspaceRoot: "/ws",
      profileId: "claude-code",
    });
  });

  it("sends the override beside the profile for a relaunch without Headroom", async () => {
    await createSession("/ws/tree", "claude --resume u-1", "/ws", withoutHeadroom("claude-code"));
    expect(invoke).toHaveBeenCalledWith("create_session", {
      cwd: "/ws/tree",
      command: "claude --resume u-1",
      workspaceRoot: "/ws",
      profileId: "claude-code",
      withoutHeadroom: true,
    });
  });

  // A daemon too old to take a profile has nothing to override: the
  // launch goes on as the shell-shaped request it always was.
  it("has nothing to override when no profile is named", async () => {
    expect(withoutHeadroom(undefined)).toBeUndefined();
    await createSession("/ws", "claude --resume u-1", "/ws", withoutHeadroom(undefined));
    expect(invoke).toHaveBeenCalledWith("create_session", {
      cwd: "/ws",
      command: "claude --resume u-1",
      workspaceRoot: "/ws",
      profileId: undefined,
    });
  });
});

// A Companion's start names the workspace it is in, which the host never
// reads and the daemon records for the desk to place it by.
describe("createSession from a Companion", () => {
  it("names the workspace beside the launch, and only when asked", async () => {
    await createSession(undefined, undefined, undefined, undefined, false, "w-scratch");
    expect(vi.mocked(invoke).mock.calls[0]).toEqual(["create_session", { workspaceId: "w-scratch" }]);
    await createSession("/ws", "claude", "/ws", "claude-code", true, "w1");
    expect(vi.mocked(invoke).mock.calls[1][1]).toMatchObject({ workspaceAgent: true, workspaceId: "w1" });
    await createSession("/ws", "claude", "/ws", "claude-code");
    expect(vi.mocked(invoke).mock.calls[2][1]).not.toHaveProperty("workspaceId");
  });
});

describe("headroomReach", () => {
  it("asks the host about one session", async () => {
    vi.mocked(invoke).mockResolvedValueOnce("unreached");
    expect(await headroomReach("s1")).toBe("unreached");
    expect(invoke).toHaveBeenCalledWith("headroom_reach", { sessionId: "s1" });
  });
});
