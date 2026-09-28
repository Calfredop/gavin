// Push registration for the Companion shell.
//
// The shell registers its APNs / FCM token with the Push gateway once,
// mints one send permission per Workstation, and hands that permission
// over the encrypted channel. Cancelling one Workstation's permission
// silences only that Workstation (spec "Notifications"; docs/push-gateway.md).
//
// This module is the pure shape of those calls. The HTTP transport is
// injected so vitest can drive a fake gateway without a network.

export type PushPlatform = "ios" | "android";

export interface RegisterDeviceRequest {
  platform: PushPlatform;
  token: string;
  /** iOS only: development-signed builds use the APNs sandbox. */
  environment?: "production" | "development";
}

export interface RegisteredDevice {
  deviceId: string;
  deviceSecret: string;
}

export interface MintedPermission {
  permissionId: string;
  permission: string;
  expiresAt: number;
}

export interface PushGatewayClient {
  registerDevice(body: RegisterDeviceRequest): Promise<RegisteredDevice>;
  putToken(
    deviceId: string,
    deviceSecret: string,
    body: { token: string; environment?: "production" | "development" },
  ): Promise<void>;
  mintPermission(deviceId: string, deviceSecret: string): Promise<MintedPermission>;
  cancelPermission(
    deviceId: string,
    deviceSecret: string,
    permissionId: string,
  ): Promise<void>;
}

/** One Workstation's live send permission on this Device. */
export interface WorkstationPermission {
  workstationId: string;
  permissionId: string;
  permission: string;
  expiresAt: number;
}

/**
 * Ensure each Workstation has a live send permission. Mints missing ones
 * and renews any that expire within `renewWithinSecs`. Returns the
 * permissions that should be handed to those Workstations.
 */
export async function ensureWorkstationPermissions(
  client: PushGatewayClient,
  device: RegisteredDevice,
  workstationIds: readonly string[],
  current: readonly WorkstationPermission[],
  nowSecs: number,
  renewWithinSecs = 7 * 24 * 3600,
): Promise<{ next: WorkstationPermission[]; handTo: WorkstationPermission[] }> {
  const byWs = new Map(current.map((p) => [p.workstationId, p]));
  const next: WorkstationPermission[] = [];
  const handTo: WorkstationPermission[] = [];

  for (const workstationId of workstationIds) {
    const existing = byWs.get(workstationId);
    const needsMint =
      !existing || existing.expiresAt - nowSecs <= renewWithinSecs;
    if (!needsMint && existing) {
      next.push(existing);
      continue;
    }
    if (existing) {
      await client.cancelPermission(device.deviceId, device.deviceSecret, existing.permissionId);
    }
    const minted = await client.mintPermission(device.deviceId, device.deviceSecret);
    const row: WorkstationPermission = {
      workstationId,
      permissionId: minted.permissionId,
      permission: minted.permission,
      expiresAt: minted.expiresAt,
    };
    next.push(row);
    handTo.push(row);
  }

  // Keep permissions for Workstations that are no longer paired? No —
  // cancel them so the gateway stops accepting pushes from them.
  for (const existing of current) {
    if (!workstationIds.includes(existing.workstationId)) {
      await client.cancelPermission(
        device.deviceId,
        device.deviceSecret,
        existing.permissionId,
      );
    }
  }

  return { next, handTo };
}

/**
 * Cancel one Workstation's permission and leave every other one alone.
 */
export async function cancelWorkstationPermission(
  client: PushGatewayClient,
  device: RegisteredDevice,
  current: readonly WorkstationPermission[],
  workstationId: string,
): Promise<WorkstationPermission[]> {
  const target = current.find((p) => p.workstationId === workstationId);
  if (target) {
    await client.cancelPermission(device.deviceId, device.deviceSecret, target.permissionId);
  }
  return current.filter((p) => p.workstationId !== workstationId);
}
