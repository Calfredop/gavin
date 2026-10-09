// The Push gateway's HTTP API (docs/push-gateway.md) over the native call
// the shell makes it with (`Push.gateway`): what `permissions.ts` and
// `registration.ts` are written against. Every refusal is the gateway's own
// `{"error": "<code>"}`, kept as `GatewayError.code` for callers to branch on.
import type { GatewayAnswer, GatewayRequest } from "$shell/native/push";
import type { MintedPermission, PushGatewayClient, RegisteredDevice, RegisterDeviceRequest } from "$shell/push/permissions";

export class GatewayError extends Error {
  constructor(
    readonly status: number,
    readonly code: string
  ) {
    super(`the Push gateway refused (${status} ${code})`);
    this.name = "GatewayError";
  }
}

export type GatewayCall = (request: GatewayRequest) => Promise<GatewayAnswer>;

export function gatewayClient(call: GatewayCall): PushGatewayClient {
  async function send(request: GatewayRequest, expect: number): Promise<unknown> {
    const answer = await call(request);
    if (answer.status !== expect) throw new GatewayError(answer.status, errorCode(answer));
    if (!answer.body) return null;
    try {
      return JSON.parse(answer.body);
    } catch {
      throw new GatewayError(answer.status, "unreadable_answer");
    }
  }
  const device = (id: string) => `/v1/devices/${encodeURIComponent(id)}`;

  return {
    async registerDevice(body: RegisterDeviceRequest): Promise<RegisteredDevice> {
      const answer = (await send({ method: "POST", path: "/v1/devices", body: JSON.stringify(body) }, 201)) as {
        device_id?: unknown;
        device_secret?: unknown;
      } | null;
      if (typeof answer?.device_id !== "string" || typeof answer.device_secret !== "string") {
        throw new GatewayError(201, "unreadable_answer");
      }
      return { deviceId: answer.device_id, deviceSecret: answer.device_secret };
    },
    async putToken(deviceId, deviceSecret, body) {
      await send({ method: "PUT", path: `${device(deviceId)}/token`, bearer: deviceSecret, body: JSON.stringify(body) }, 204);
    },
    async mintPermission(deviceId, deviceSecret): Promise<MintedPermission> {
      const answer = (await send({ method: "POST", path: `${device(deviceId)}/permissions`, bearer: deviceSecret }, 201)) as {
        permission_id?: unknown;
        permission?: unknown;
        expires_at?: unknown;
      } | null;
      if (
        typeof answer?.permission_id !== "string" ||
        typeof answer.permission !== "string" ||
        typeof answer.expires_at !== "number"
      ) {
        throw new GatewayError(201, "unreadable_answer");
      }
      return { permissionId: answer.permission_id, permission: answer.permission, expiresAt: answer.expires_at };
    },
    async cancelPermission(deviceId, deviceSecret, permissionId) {
      try {
        await send(
          {
            method: "DELETE",
            path: `${device(deviceId)}/permissions/${encodeURIComponent(permissionId)}`,
            bearer: deviceSecret,
          },
          204
        );
      } catch (e) {
        // Already gone is what cancelling asked for.
        if (e instanceof GatewayError && e.code === "permission_not_found") return;
        throw e;
      }
    },
  };
}

function errorCode(answer: GatewayAnswer): string {
  try {
    const parsed = JSON.parse(answer.body) as { error?: unknown };
    if (typeof parsed?.error === "string") return parsed.error;
  } catch {
    // Not the gateway's JSON: a proxy's page, say.
  }
  return `http_${answer.status}`;
}
