import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: vi.fn(),
  requestPermission: vi.fn(),
  sendNotification: vi.fn(),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: vi.fn(),
}));

import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { maybeNotifyStatusChange, maybeNotifyAgentCommit, agentCommitBody, __resetForTesting } from "./notifications";

/// Today's behaviour: both events enabled. The per-workspace toggles
/// (D38) get their own test below; every pre-existing case asserts the
/// rules that are unchanged by them.
const ALL_ON = { needsInput: true, finished: true };

function mockWindow(isFocused: boolean): void {
  vi.mocked(getCurrentWindow).mockReturnValue({ isFocused: vi.fn().mockResolvedValue(isFocused) } as never);
}

beforeEach(async () => {
  await __resetForTesting();
  vi.clearAllMocks();
  mockWindow(false);
  vi.mocked(isPermissionGranted).mockResolvedValue(true);
});

describe("maybeNotifyStatusChange", () => {
  it("notifies on a transition into waiting_for_input", async () => {
    await maybeNotifyStatusChange("s-1", "working", "waiting_for_input", "my-project", ALL_ON);
    expect(sendNotification).toHaveBeenCalledTimes(1);
    const call = vi.mocked(sendNotification).mock.calls[0][0] as { title: string; body: string };
    expect(call.body).toContain("my-project");
  });

  it("notifies on a transition into waiting_for_input even from idle (not just from working)", async () => {
    await maybeNotifyStatusChange("s-1", "idle", "waiting_for_input", "my-project", ALL_ON);
    expect(sendNotification).toHaveBeenCalledTimes(1);
  });

  it("notifies on working -> idle", async () => {
    await maybeNotifyStatusChange("s-1", "working", "idle", "my-project", ALL_ON);
    expect(sendNotification).toHaveBeenCalledTimes(1);
  });

  it("does not notify on idle -> working", async () => {
    await maybeNotifyStatusChange("s-1", "idle", "working", "my-project", ALL_ON);
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("does not notify on waiting_for_input -> working", async () => {
    await maybeNotifyStatusChange("s-1", "waiting_for_input", "working", "my-project", ALL_ON);
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("does not notify when there is no previous status and the new status isn't waiting_for_input", async () => {
    // The very first StatusChanged a session ever receives (previousStatus
    // undefined) is a baseline, not a transition -- idle/working as a
    // first-ever value must never read as "working -> idle" or similar.
    await maybeNotifyStatusChange("s-1", undefined, "idle", "my-project", ALL_ON);
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("does notify when the very first status a session ever receives is waiting_for_input", async () => {
    await maybeNotifyStatusChange("s-1", undefined, "waiting_for_input", "my-project", ALL_ON);
    expect(sendNotification).toHaveBeenCalledTimes(1);
  });

  it("suppresses the notification entirely when the window is frontmost", async () => {
    mockWindow(true);
    await maybeNotifyStatusChange("s-1", "working", "idle", "my-project", ALL_ON);
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("does not notify when permission was never granted and the user declines the lazy request", async () => {
    vi.mocked(isPermissionGranted).mockResolvedValue(false);
    vi.mocked(requestPermission).mockResolvedValue("denied");
    await maybeNotifyStatusChange("s-1", "working", "idle", "my-project", ALL_ON);
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("requests permission only once across multiple notification-worthy transitions, not on every one", async () => {
    vi.mocked(isPermissionGranted).mockResolvedValue(false);
    vi.mocked(requestPermission).mockResolvedValue("denied");
    await maybeNotifyStatusChange("s-1", "working", "idle", "my-project", ALL_ON);
    await maybeNotifyStatusChange("s-2", "working", "idle", "other-project", ALL_ON);
    expect(requestPermission).toHaveBeenCalledTimes(1);
  });

  it("does not call requestPermission at all once permission is already granted", async () => {
    vi.mocked(isPermissionGranted).mockResolvedValue(true);
    await maybeNotifyStatusChange("s-1", "working", "idle", "my-project", ALL_ON);
    expect(requestPermission).not.toHaveBeenCalled();
    expect(sendNotification).toHaveBeenCalledTimes(1);
  });

  it("checks window focus before ever touching permission state, for a non-notification-worthy transition", async () => {
    await maybeNotifyStatusChange("s-1", "idle", "working", "my-project", ALL_ON);
    expect(isPermissionGranted).not.toHaveBeenCalled();
  });
});

describe("per-workspace toggles", () => {
  it("suppresses only the event whose toggle is off", async () => {
    await __resetForTesting();
    vi.mocked(isPermissionGranted).mockResolvedValue(true);
    vi.mocked(getCurrentWindow).mockReturnValue({ isFocused: async () => false } as never);

    await maybeNotifyStatusChange("s-1", "working", "idle", "zsh", { needsInput: true, finished: false });
    expect(sendNotification).not.toHaveBeenCalled();

    await maybeNotifyStatusChange("s-1", "working", "idle", "zsh", { needsInput: true, finished: true });
    expect(sendNotification).toHaveBeenCalledOnce();

    vi.mocked(sendNotification).mockClear();
    await maybeNotifyStatusChange("s-1", "idle", "waiting_for_input", "zsh", {
      needsInput: false,
      finished: true,
    });
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("does not even ask for permission when the event is silenced", async () => {
    await __resetForTesting();
    vi.mocked(isPermissionGranted).mockResolvedValue(false);
    vi.mocked(getCurrentWindow).mockReturnValue({ isFocused: async () => false } as never);

    await maybeNotifyStatusChange("s-1", "working", "idle", "zsh", { needsInput: true, finished: false });
    expect(requestPermission).not.toHaveBeenCalled();
  });
});

describe("maybeNotifyAgentCommit", () => {
  const ON_SCREEN = true;
  const ELSEWHERE = false;

  it("names the workspace and says what the run did", async () => {
    await maybeNotifyAgentCommit("gavin", { kind: "committed" }, ALL_ON, ELSEWHERE);
    expect(sendNotification).toHaveBeenCalledTimes(1);
    const call = vi.mocked(sendNotification).mock.calls[0][0] as { title: string; body: string };
    expect(call.body).toBe("gavin: changes committed");
  });

  it("reports a failure and a half-done run as themselves, not as 'finished'", () => {
    expect(agentCommitBody("gavin", { kind: "failed", exitCode: 2 })).toBe("gavin: commit agent failed (exit 2)");
    expect(agentCommitBody("gavin", { kind: "left-dirty", changes: 4 })).toBe(
      "gavin: commit agent left 4 changes uncommitted"
    );
    expect(agentCommitBody("gavin", { kind: "left-dirty", changes: 1 })).toBe(
      "gavin: commit agent left 1 change uncommitted"
    );
  });

  // The whole point of the card: the human clicked the button and went
  // to work on another tab. Being inside the app is not being told.
  it("still notifies a focused window that is showing some other tab", async () => {
    mockWindow(true);
    await maybeNotifyAgentCommit("gavin", { kind: "committed" }, ALL_ON, ELSEWHERE);
    expect(sendNotification).toHaveBeenCalledTimes(1);
  });

  it("stays quiet only when the Git tab is both focused and on screen", async () => {
    mockWindow(true);
    await maybeNotifyAgentCommit("gavin", { kind: "committed" }, ALL_ON, ON_SCREEN);
    expect(sendNotification).not.toHaveBeenCalled();
  });

  // A background window's Git tab shows nothing at all, even though it
  // is that workspace's current view.
  it("notifies when the Git tab is on screen but the window is not frontmost", async () => {
    mockWindow(false);
    await maybeNotifyAgentCommit("gavin", { kind: "failed", exitCode: 2 }, ALL_ON, ON_SCREEN);
    expect(sendNotification).toHaveBeenCalledTimes(1);
  });

  it("obeys the workspace's 'finished' toggle, and asks nothing of the OS when it is off", async () => {
    vi.mocked(isPermissionGranted).mockResolvedValue(false);
    await maybeNotifyAgentCommit("gavin", { kind: "committed" }, { needsInput: true, finished: false }, ELSEWHERE);
    expect(sendNotification).not.toHaveBeenCalled();
    expect(requestPermission).not.toHaveBeenCalled();
    expect(getCurrentWindow).not.toHaveBeenCalled();
  });

  it("does not notify when the lazy permission request is declined", async () => {
    vi.mocked(isPermissionGranted).mockResolvedValue(false);
    vi.mocked(requestPermission).mockResolvedValue("denied");
    await maybeNotifyAgentCommit("gavin", { kind: "committed" }, ALL_ON, ELSEWHERE);
    expect(sendNotification).not.toHaveBeenCalled();
  });
});
