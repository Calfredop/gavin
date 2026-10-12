// This install's registration with the Push gateway (docs/push-gateway.md):
// register the token once, and tell the gateway every token after that --
// on every launch, as it asks. The Device id and secret come back once and
// are kept natively (`Push.keepRegistration`, the keychain), because the
// secret mints the permissions that let a Workstation notify this phone.
import { GatewayError } from "$shell/push/gateway";
import type { PushGatewayClient, PushPlatform, WorkstationPermission } from "$shell/push/permissions";

export interface KeptRegistration {
  /// The gateway it was made with: another one knows nothing of it.
  gateway: string;
  deviceId: string;
  deviceSecret: string;
  /// The permission minted for each Workstation (`handover.ts`). Gone with
  /// a fresh registration: the gateway cancelled them with the old Device.
  permissions: WorkstationPermission[];
  /// The Workstations the owner turned off: none of their permission.
  muted: string[];
}

export interface CurrentToken {
  gateway: string;
  platform: PushPlatform;
  token: string;
  environment: "development" | "production";
}

/// The kept record, or null when there is none this build can use.
export function readRegistration(json: string | null): KeptRegistration | null {
  if (!json) return null;
  try {
    const r = JSON.parse(json) as Partial<KeptRegistration> | null;
    if (typeof r?.gateway === "string" && typeof r.deviceId === "string" && typeof r.deviceSecret === "string") {
      return {
        gateway: r.gateway,
        deviceId: r.deviceId,
        deviceSecret: r.deviceSecret,
        permissions: Array.isArray(r.permissions) ? r.permissions.filter(isPermission) : [],
        muted: Array.isArray(r.muted) ? r.muted.filter((id): id is string => typeof id === "string") : [],
      };
    }
  } catch {
    // Unreadable: register again.
  }
  return null;
}

function isPermission(p: unknown): p is WorkstationPermission {
  const r = p as Partial<WorkstationPermission> | null;
  return (
    typeof r?.workstationId === "string" &&
    typeof r.permissionId === "string" &&
    typeof r.permission === "string" &&
    typeof r.expiresAt === "number"
  );
}

/// Tells the gateway this install's token. `fresh` is true when it had to
/// register anew -- the first time, after a change of gateway, or because
/// the gateway no longer knows the Device -- and every permission minted
/// under the old registration is gone with it.
export async function registerToken(
  client: PushGatewayClient,
  kept: KeptRegistration | null,
  now: CurrentToken
): Promise<{ kept: KeptRegistration; fresh: boolean }> {
  const environment = now.platform === "ios" ? now.environment : undefined;
  if (kept && kept.gateway === now.gateway) {
    try {
      await client.putToken(kept.deviceId, kept.deviceSecret, { token: now.token, environment });
      return { kept, fresh: false };
    } catch (e) {
      // A reinstall's registration of the same token replaced it, or the
      // gateway lost its database: the two read the same on purpose.
      if (!(e instanceof GatewayError && e.code === "device_unauthorized")) throw e;
    }
  }
  const device = await client.registerDevice({ platform: now.platform, token: now.token, environment });
  return { kept: { gateway: now.gateway, ...device, permissions: [], muted: kept?.muted ?? [] }, fresh: true };
}
