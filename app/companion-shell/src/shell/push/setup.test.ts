import { describe, expect, it, vi } from "vitest";
import type { PushPlugin, PushRegistered, PushStatus } from "$shell/native/push";
import { notifyLine, setUpNotifications, type SetupDeps } from "./setup";

function push(status: PushStatus, registered: PushRegistered = { permission: "granted", token: "ab", environment: "development" }) {
  const plugin = {
    status: vi.fn(async () => status),
    register: vi.fn(async () => registered),
    gateway: vi.fn(async () => ({ status: 201, body: '{"device_id":"d1","device_secret":"s1"}' })),
    registration: vi.fn(async () => ({ record: null as string | null })),
    keepRegistration: vi.fn(async () => {}),
  } satisfies SetupDeps["push"];
  return plugin;
}

const gateway = "https://push.example";

describe("setUpNotifications", () => {
  it("does not ask at launch, and says what tapping would do", async () => {
    const p = push({ permission: "prompt", gateway, environment: "development" });
    await expect(setUpNotifications({ push: p, platform: "ios" }, false)).resolves.toEqual({ state: "prompt" });
    expect(p.register).not.toHaveBeenCalled();
  });

  it("asks on the owner's tap, registers the token and keeps the registration", async () => {
    const p = push({ permission: "prompt", gateway, environment: "development" });
    await expect(setUpNotifications({ push: p, platform: "ios" }, true)).resolves.toMatchObject({ state: "on", fresh: true });
    expect(p.gateway).toHaveBeenCalledWith({
      method: "POST",
      path: "/v1/devices",
      body: '{"platform":"ios","token":"ab","environment":"development"}',
    });
    expect(p.keepRegistration).toHaveBeenCalledWith({
      record: JSON.stringify({ gateway, deviceId: "d1", deviceSecret: "s1", permissions: [], muted: [] }),
    });
  });

  it("refreshes the token at launch once allowed, without asking", async () => {
    const p = push({ permission: "granted", gateway, environment: "production" });
    p.registration.mockResolvedValue({ record: JSON.stringify({ gateway, deviceId: "d1", deviceSecret: "s1" }) });
    p.gateway.mockResolvedValue({ status: 204, body: "" });
    await expect(setUpNotifications({ push: p, platform: "ios" }, false)).resolves.toMatchObject({
      state: "on",
      fresh: false,
      kept: { deviceId: "d1" },
    });
    expect(p.keepRegistration).not.toHaveBeenCalled();
  });

  it("reflects a refusal, at the prompt or from Settings", async () => {
    const asked = push({ permission: "prompt", gateway, environment: "development" }, { permission: "denied" });
    await expect(setUpNotifications({ push: asked, platform: "ios" }, true)).resolves.toEqual({ state: "denied" });
    const before = push({ permission: "denied", gateway, environment: "development" });
    await expect(setUpNotifications({ push: before, platform: "ios" }, true)).resolves.toEqual({ state: "denied" });
    expect(before.register).not.toHaveBeenCalled();
  });

  it("says so when the build names no gateway", async () => {
    const p = push({ permission: "granted", environment: "development" });
    await expect(setUpNotifications({ push: p, platform: "ios" }, false)).resolves.toEqual({ state: "no-gateway" });
  });

  it("says nothing on a phone with no push", async () => {
    const p = push({ permission: "granted", environment: "development" });
    p.status.mockRejectedValue(new Error("not implemented on android"));
    await expect(setUpNotifications({ push: p as unknown as PushPlugin, platform: "android" }, false)).resolves.toEqual({
      state: "unavailable",
    });
  });

  it("names what failed", async () => {
    const p = push({ permission: "granted", gateway, environment: "development" });
    p.gateway.mockResolvedValue({ status: 422, body: '{"error":"platform_unavailable"}' });
    await expect(setUpNotifications({ push: p, platform: "ios" }, false)).resolves.toEqual({
      state: "failed",
      problem: "the Push gateway refused (422 platform_unavailable)",
    });
  });
});

describe("notifyLine", () => {
  it("offers to turn on, and to try again, and nothing while it says nothing", () => {
    expect(notifyLine({ state: "prompt" })?.action).toBe("Turn on notifications");
    expect(notifyLine({ state: "failed", problem: "x" })).toEqual({
      text: "Notifications could not be turned on: x.",
      action: "Try again",
    });
    const kept = { gateway: "g", deviceId: "d", deviceSecret: "s", permissions: [], muted: [] };
    expect(notifyLine({ state: "on", fresh: false, kept })?.action).toBeNull();
    expect(notifyLine({ state: "checking" })).toBeNull();
    expect(notifyLine({ state: "unavailable" })).toBeNull();
  });
});
