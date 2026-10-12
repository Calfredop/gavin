import { describe, expect, it } from "vitest";
import type { GatewayAnswer, GatewayRequest } from "$shell/native/push";
import { GatewayError, gatewayClient } from "./gateway";

function recording(answers: GatewayAnswer[]) {
  const sent: GatewayRequest[] = [];
  const call = async (request: GatewayRequest) => {
    sent.push(request);
    const answer = answers.shift();
    if (!answer) throw new Error("no answer left");
    return answer;
  };
  return { sent, client: gatewayClient(call) };
}

describe("gatewayClient", () => {
  it("registers a Device and reads its id and secret", async () => {
    const { sent, client } = recording([{ status: 201, body: '{"device_id":"d1","device_secret":"s1"}' }]);
    await expect(client.registerDevice({ platform: "ios", token: "ab", environment: "development" })).resolves.toEqual({
      deviceId: "d1",
      deviceSecret: "s1",
    });
    expect(sent).toEqual([
      { method: "POST", path: "/v1/devices", body: '{"platform":"ios","token":"ab","environment":"development"}' },
    ]);
  });

  it("sends a newer token with the Device's secret", async () => {
    const { sent, client } = recording([{ status: 204, body: "" }]);
    await client.putToken("d/1", "s1", { token: "cd" });
    expect(sent).toEqual([{ method: "PUT", path: "/v1/devices/d%2F1/token", bearer: "s1", body: '{"token":"cd"}' }]);
  });

  it("mints a permission and reads it", async () => {
    const { client } = recording([
      { status: 201, body: '{"permission_id":"p1","permission":"v1.a.b","expires_at":2000000000}' },
    ]);
    await expect(client.mintPermission("d1", "s1")).resolves.toEqual({
      permissionId: "p1",
      permission: "v1.a.b",
      expiresAt: 2_000_000_000,
    });
  });

  it("refuses with the gateway's own code", async () => {
    const { client } = recording([{ status: 401, body: '{"error":"device_unauthorized"}' }]);
    const refused = await client.putToken("d1", "wrong", { token: "x" }).catch((e) => e);
    expect(refused).toBeInstanceOf(GatewayError);
    expect(refused).toMatchObject({ status: 401, code: "device_unauthorized" });
  });

  it("names the status when the answer is not the gateway's JSON", async () => {
    const { client } = recording([{ status: 502, body: "<html>Bad gateway</html>" }]);
    await expect(client.registerDevice({ platform: "ios", token: "ab" })).rejects.toMatchObject({ code: "http_502" });
  });

  it("takes a permission already gone as cancelled", async () => {
    const { client } = recording([{ status: 404, body: '{"error":"permission_not_found"}' }]);
    await expect(client.cancelPermission("d1", "s1", "p1")).resolves.toBeUndefined();
  });
});
