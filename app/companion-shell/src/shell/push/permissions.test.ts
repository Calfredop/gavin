import { describe, it, expect, vi } from "vitest";
import {
  cancelWorkstationPermission,
  ensureWorkstationPermissions,
  type MintedPermission,
  type PushGatewayClient,
  type RegisteredDevice,
  type WorkstationPermission,
} from "./permissions";

function fakeClient(overrides: Partial<PushGatewayClient> = {}): PushGatewayClient & {
  cancelled: string[];
  minted: number;
} {
  const cancelled: string[] = [];
  let minted = 0;
  const client: PushGatewayClient & { cancelled: string[]; minted: number } = {
    cancelled,
    get minted() {
      return minted;
    },
    registerDevice: vi.fn(),
    putToken: vi.fn(),
    mintPermission: vi.fn(async () => {
      minted += 1;
      const n = minted;
      return {
        permissionId: `pid-${n}`,
        permission: `perm-${n}`,
        expiresAt: 2_000_000_000 + n,
      } satisfies MintedPermission;
    }),
    cancelPermission: vi.fn(async (_d, _s, permissionId) => {
      cancelled.push(permissionId);
    }),
    ...overrides,
  };
  return client;
}

const device: RegisteredDevice = { deviceId: "dev", deviceSecret: "secret" };

describe("ensureWorkstationPermissions", () => {
  it("mints one permission per Workstation and hands them over", async () => {
    const client = fakeClient();
    const { next, handTo } = await ensureWorkstationPermissions(
      client,
      device,
      ["ws-a", "ws-b"],
      [],
      1_700_000_000,
    );
    expect(handTo).toHaveLength(2);
    expect(next.map((p) => p.workstationId)).toEqual(["ws-a", "ws-b"]);
    expect(client.minted).toBe(2);
  });

  it("leaves a still-fresh permission alone", async () => {
    const client = fakeClient();
    const current: WorkstationPermission[] = [
      {
        workstationId: "ws-a",
        permissionId: "pid-old",
        permission: "perm-old",
        expiresAt: 1_700_000_000 + 30 * 24 * 3600,
      },
    ];
    const { next, handTo } = await ensureWorkstationPermissions(
      client,
      device,
      ["ws-a"],
      current,
      1_700_000_000,
    );
    expect(handTo).toEqual([]);
    expect(next).toEqual(current);
    expect(client.minted).toBe(0);
  });

  it("cancels a unpaired Workstation's permission", async () => {
    const client = fakeClient();
    const current: WorkstationPermission[] = [
      {
        workstationId: "ws-gone",
        permissionId: "pid-gone",
        permission: "perm-gone",
        expiresAt: 2_000_000_000,
      },
    ];
    await ensureWorkstationPermissions(client, device, [], current, 1_700_000_000);
    expect(client.cancelled).toEqual(["pid-gone"]);
  });
});

describe("cancelWorkstationPermission", () => {
  it("silences only the named Workstation", async () => {
    const client = fakeClient();
    const current: WorkstationPermission[] = [
      {
        workstationId: "ws-a",
        permissionId: "pid-a",
        permission: "perm-a",
        expiresAt: 2_000_000_000,
      },
      {
        workstationId: "ws-b",
        permissionId: "pid-b",
        permission: "perm-b",
        expiresAt: 2_000_000_000,
      },
    ];
    const next = await cancelWorkstationPermission(client, device, current, "ws-a");
    expect(client.cancelled).toEqual(["pid-a"]);
    expect(next.map((p) => p.workstationId)).toEqual(["ws-b"]);
  });
});
