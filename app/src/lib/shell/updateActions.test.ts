import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AvailableUpdate } from "$lib/shell/updates";
import type { ManagedSession } from "$lib/sessions/sessionsManager";

const host = vi.hoisted(() => ({
  listManagedSessions: vi.fn(),
  installUpdate: vi.fn(),
  setUpdateEndpoint: vi.fn(),
}));
const gate = vi.hoisted(() => ({ grantForAnsweredPrompt: vi.fn() }));

vi.mock("$lib/backend", () => host);
vi.mock("$lib/confirmGate", () => gate);

import { installConfirmPrompt, runInstall, saveEndpoint } from "$lib/shell/updateActions";

const UPDATE: AvailableUpdate = {
  version: "0.2.0",
  currentVersion: "0.1.0",
  notes: null,
  date: null,
};

function session(over: Partial<ManagedSession> = {}): ManagedSession {
  return {
    id: "s1",
    workspacePath: "/w",
    cwd: "/w",
    status: "running",
    restored: false,
    interrupted: false,
    orphan: null,
    command: "claude",
    pid: 1,
    rssBytes: 0,
    cpuTimeUs: 0,
    processCount: 1,
    sampledAtUs: 0,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("installConfirmPrompt", () => {
  it("counts the live sessions into the prompt", async () => {
    host.listManagedSessions.mockResolvedValue({
      sessions: [session(), session({ id: "s2" }), session({ id: "s3", status: "exited" })],
    });
    const prompt = await installConfirmPrompt(UPDATE);
    expect(prompt.lines.join(" ")).toContain("2 terminal sessions keep running");
  });

  // An unreachable daemon must not block the install behind a sentence
  // it could not compose. The daemon consequence is still stated.
  it("still describes the install when the session list is unavailable", async () => {
    host.listManagedSessions.mockRejectedValue(new Error("no daemon"));
    const prompt = await installConfirmPrompt(UPDATE);
    expect(prompt.title).toBe("Install gavin 0.2.0?");
    expect(prompt.lines.join(" ")).toMatch(/daemon .*stays on the old version/);
  });
});

describe("runInstall", () => {
  it("binds the token to the version and sends both", async () => {
    gate.grantForAnsweredPrompt.mockResolvedValue("tok");
    host.installUpdate.mockResolvedValue(undefined);
    await runInstall(UPDATE);
    expect(gate.grantForAnsweredPrompt).toHaveBeenCalledWith("install_update", ["0.2.0"]);
    expect(host.installUpdate).toHaveBeenCalledWith("0.2.0", "tok");
  });

  it("lets a refusal reach the caller", async () => {
    gate.grantForAnsweredPrompt.mockResolvedValue("");
    host.installUpdate.mockRejectedValue(new Error("this needs a confirmation gavin drew"));
    await expect(runInstall(UPDATE)).rejects.toThrow(/confirmation/);
  });
});

describe("saveEndpoint", () => {
  it("passes null through as a clear", async () => {
    host.setUpdateEndpoint.mockResolvedValue(undefined);
    await saveEndpoint(null);
    expect(host.setUpdateEndpoint).toHaveBeenCalledWith(null);
  });
});
