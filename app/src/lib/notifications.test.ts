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
import { maybeNotifyStatusChange, __resetForTesting } from "./notifications";

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
    await maybeNotifyStatusChange("s-1", "working", "waiting_for_input", "my-project");
    expect(sendNotification).toHaveBeenCalledTimes(1);
    const call = vi.mocked(sendNotification).mock.calls[0][0] as { title: string; body: string };
    expect(call.body).toContain("my-project");
  });

  it("notifies on a transition into waiting_for_input even from idle (not just from working)", async () => {
    await maybeNotifyStatusChange("s-1", "idle", "waiting_for_input", "my-project");
    expect(sendNotification).toHaveBeenCalledTimes(1);
  });

  it("notifies on working -> idle", async () => {
    await maybeNotifyStatusChange("s-1", "working", "idle", "my-project");
    expect(sendNotification).toHaveBeenCalledTimes(1);
  });

  it("does not notify on idle -> working", async () => {
    await maybeNotifyStatusChange("s-1", "idle", "working", "my-project");
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("does not notify on waiting_for_input -> working", async () => {
    await maybeNotifyStatusChange("s-1", "waiting_for_input", "working", "my-project");
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("does not notify when there is no previous status and the new status isn't waiting_for_input", async () => {
    // The very first StatusChanged a session ever receives (previousStatus
    // undefined) is a baseline, not a transition -- idle/working as a
    // first-ever value must never read as "working -> idle" or similar.
    await maybeNotifyStatusChange("s-1", undefined, "idle", "my-project");
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("does notify when the very first status a session ever receives is waiting_for_input", async () => {
    await maybeNotifyStatusChange("s-1", undefined, "waiting_for_input", "my-project");
    expect(sendNotification).toHaveBeenCalledTimes(1);
  });

  it("suppresses the notification entirely when the window is frontmost", async () => {
    mockWindow(true);
    await maybeNotifyStatusChange("s-1", "working", "idle", "my-project");
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("does not notify when permission was never granted and the user declines the lazy request", async () => {
    vi.mocked(isPermissionGranted).mockResolvedValue(false);
    vi.mocked(requestPermission).mockResolvedValue("denied");
    await maybeNotifyStatusChange("s-1", "working", "idle", "my-project");
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("requests permission only once across multiple notification-worthy transitions, not on every one", async () => {
    vi.mocked(isPermissionGranted).mockResolvedValue(false);
    vi.mocked(requestPermission).mockResolvedValue("denied");
    await maybeNotifyStatusChange("s-1", "working", "idle", "my-project");
    await maybeNotifyStatusChange("s-2", "working", "idle", "other-project");
    expect(requestPermission).toHaveBeenCalledTimes(1);
  });

  it("does not call requestPermission at all once permission is already granted", async () => {
    vi.mocked(isPermissionGranted).mockResolvedValue(true);
    await maybeNotifyStatusChange("s-1", "working", "idle", "my-project");
    expect(requestPermission).not.toHaveBeenCalled();
    expect(sendNotification).toHaveBeenCalledTimes(1);
  });

  it("checks window focus before ever touching permission state, for a non-notification-worthy transition", async () => {
    await maybeNotifyStatusChange("s-1", "idle", "working", "my-project");
    expect(isPermissionGranted).not.toHaveBeenCalled();
  });
});
