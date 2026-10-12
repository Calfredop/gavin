import { describe, expect, it, vi } from "vitest";
import { GatewayError } from "./gateway";
import type { PushGatewayClient } from "./permissions";
import { readRegistration, registerToken, type CurrentToken } from "./registration";

function client(overrides: Partial<PushGatewayClient> = {}): PushGatewayClient {
  return {
    registerDevice: vi.fn(async () => ({ deviceId: "d-new", deviceSecret: "s-new" })),
    putToken: vi.fn(async () => {}),
    mintPermission: vi.fn(),
    cancelPermission: vi.fn(),
    ...overrides,
  };
}

const now: CurrentToken = { gateway: "https://push.example", platform: "ios", token: "ab", environment: "development" };
const kept = { gateway: "https://push.example", deviceId: "d1", deviceSecret: "s1", permissions: [], muted: [] };

describe("registerToken", () => {
  it("registers the first time, with the APNs environment", async () => {
    const c = client();
    await expect(registerToken(c, null, now)).resolves.toEqual({
      kept: { gateway: "https://push.example", deviceId: "d-new", deviceSecret: "s-new", permissions: [], muted: [] },
      fresh: true,
    });
    expect(c.registerDevice).toHaveBeenCalledWith({ platform: "ios", token: "ab", environment: "development" });
  });

  it("tells the gateway the token on every launch after that", async () => {
    const c = client();
    await expect(registerToken(c, kept, now)).resolves.toEqual({ kept, fresh: false });
    expect(c.putToken).toHaveBeenCalledWith("d1", "s1", { token: "ab", environment: "development" });
    expect(c.registerDevice).not.toHaveBeenCalled();
  });

  it("registers again when the gateway no longer knows the Device, and keeps what was turned off", async () => {
    const c = client({ putToken: vi.fn(async () => Promise.reject(new GatewayError(401, "device_unauthorized"))) });
    const before = {
      ...kept,
      permissions: [{ workstationId: "ws-a", permissionId: "p", permission: "v1", expiresAt: 1 }],
      muted: ["ws-b"],
    };
    await expect(registerToken(c, before, now)).resolves.toMatchObject({
      fresh: true,
      kept: { deviceId: "d-new", permissions: [], muted: ["ws-b"] },
    });
  });

  it("registers again with a gateway the record was not made with", async () => {
    const c = client();
    await registerToken(c, { ...kept, gateway: "https://other.example" }, now);
    expect(c.putToken).not.toHaveBeenCalled();
    expect(c.registerDevice).toHaveBeenCalled();
  });

  it("passes any other refusal on", async () => {
    const c = client({ putToken: vi.fn(async () => Promise.reject(new GatewayError(503, "upstream_unavailable"))) });
    await expect(registerToken(c, kept, now)).rejects.toMatchObject({ code: "upstream_unavailable" });
    expect(c.registerDevice).not.toHaveBeenCalled();
  });

  it("sends no environment for an Android token", async () => {
    const c = client();
    await registerToken(c, null, { ...now, platform: "android" });
    expect(c.registerDevice).toHaveBeenCalledWith({ platform: "android", token: "ab", environment: undefined });
  });
});

describe("readRegistration", () => {
  it("reads what was kept, and nothing else", () => {
    expect(readRegistration(JSON.stringify(kept))).toEqual(kept);
    // A record kept before permissions were: none minted, none off.
    expect(readRegistration(JSON.stringify({ gateway: "g", deviceId: "d", deviceSecret: "s" }))).toEqual({
      gateway: "g",
      deviceId: "d",
      deviceSecret: "s",
      permissions: [],
      muted: [],
    });
    expect(readRegistration(null)).toBeNull();
    expect(readRegistration("{")).toBeNull();
    expect(readRegistration(JSON.stringify({ gateway: "g", deviceId: "d" }))).toBeNull();
  });
});
