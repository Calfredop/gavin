import { describe, expect, it, vi } from "vitest";
import { get } from "svelte/store";
import type { Connection } from "$shell/connection/connection";
import {
  createHandover,
  handOver,
  HandoverRefused,
  notifyWord,
  syncHandover,
  type HandoverDeps,
} from "./handover";
import type { PushGatewayClient } from "./permissions";
import type { KeptRegistration } from "./registration";

const NOW = 1_800_000_000;

function gateway() {
  let minted = 0;
  const cancelled: string[] = [];
  const client: PushGatewayClient = {
    registerDevice: vi.fn(),
    putToken: vi.fn(),
    mintPermission: vi.fn(async () => {
      minted += 1;
      return { permissionId: `pid-${minted}`, permission: `perm-${minted}`, expiresAt: NOW + 90 * 86_400 };
    }),
    cancelPermission: vi.fn(async (_d: string, _s: string, id: string) => {
      cancelled.push(id);
    }),
  };
  return { client, cancelled };
}

const registration: KeptRegistration = {
  gateway: "https://push.example",
  deviceId: "dev",
  deviceSecret: "secret",
  permissions: [],
  muted: [],
};

/// Workstations, each connected or not, recording what they were handed.
function workstations(connected: string[], refuse: Record<string, HandoverRefused> = {}) {
  const handed: [string, string][] = [];
  const hand = (id: string, permission: string): Promise<void> | null => {
    if (!connected.includes(id)) return null;
    if (refuse[id]) return Promise.reject(refuse[id]);
    handed.push([id, permission]);
    return Promise.resolve();
  };
  return { hand, handed };
}

function deps(client: PushGatewayClient, hand: HandoverDeps["hand"]) {
  const kept: KeptRegistration[] = [];
  const d: HandoverDeps = { client, hand, keep: async (r) => void kept.push(r), now: () => NOW };
  return { d, kept };
}

describe("syncHandover", () => {
  it("mints one permission per Workstation and hands it to each one connected", async () => {
    const { client } = gateway();
    const ws = workstations(["ws-a"]);
    const { d, kept } = deps(client, ws.hand);
    const pass = await syncHandover(d, registration, ["ws-a", "ws-b"], new Set(), new Map());
    expect(ws.handed).toEqual([["ws-a", "perm-1"]]);
    expect(pass.status).toEqual({ "ws-a": "on", "ws-b": "waiting" });
    expect(pass.kept.permissions.map((p) => [p.workstationId, p.permission])).toEqual([
      ["ws-a", "perm-1"],
      ["ws-b", "perm-2"],
    ]);
    expect(kept.at(-1)).toEqual(pass.kept);
  });

  it("hands each permission over once, and mints none again", async () => {
    const { client } = gateway();
    const ws = workstations(["ws-a"]);
    const { d } = deps(client, ws.hand);
    const handed = new Set<string>();
    const first = await syncHandover(d, registration, ["ws-a"], handed, new Map());
    const second = await syncHandover(d, first.kept, ["ws-a"], handed, new Map());
    expect(ws.handed).toEqual([["ws-a", "perm-1"]]);
    expect(client.mintPermission).toHaveBeenCalledTimes(1);
    expect(second.status).toEqual({ "ws-a": "on" });
  });

  it("turning one Workstation off cancels its permission, tells it, and leaves the other notifying", async () => {
    const { client, cancelled } = gateway();
    const ws = workstations(["ws-a", "ws-b"]);
    const { d } = deps(client, ws.hand);
    const handed = new Set<string>();
    const first = await syncHandover(d, registration, ["ws-a", "ws-b"], handed, new Map());
    const off = { ...first.kept, muted: ["ws-a"] };
    const second = await syncHandover(d, off, ["ws-a", "ws-b"], handed, new Map());
    expect(cancelled).toEqual(["pid-1"]);
    expect(ws.handed).toEqual([
      ["ws-a", "perm-1"],
      ["ws-b", "perm-2"],
      ["ws-a", ""],
    ]);
    expect(second.kept.permissions.map((p) => p.workstationId)).toEqual(["ws-b"]);
    expect(second.status).toEqual({ "ws-a": "off", "ws-b": "on" });
  });

  it("says when a Workstation is too old to be handed a permission", async () => {
    const { client } = gateway();
    const ws = workstations(["ws-a"], { "ws-a": new HandoverRefused(true, "too old") });
    const { d } = deps(client, ws.hand);
    const pass = await syncHandover(d, registration, ["ws-a"], new Set(), new Map());
    expect(pass.status).toEqual({ "ws-a": "too-old" });
    expect(notifyWord("too-old")).toMatch(/Update Gavin at the desk/);
  });

  it("cancels the permission of a Workstation no longer paired", async () => {
    const { client, cancelled } = gateway();
    const ws = workstations([]);
    const { d } = deps(client, ws.hand);
    const first = await syncHandover(d, registration, ["ws-a", "ws-b"], new Set(), new Map());
    const second = await syncHandover(d, first.kept, ["ws-b"], new Set(), new Map());
    expect(cancelled).toEqual(["pid-1"]);
    expect(Object.keys(second.status)).toEqual(["ws-b"]);
  });
});

describe("handOver", () => {
  function answering(reply: unknown) {
    const sent: unknown[] = [];
    const connection = {
      request: async (message: unknown, answers: (r: unknown) => boolean) => {
        sent.push(message);
        expect(answers(reply)).toBe(true);
        return reply;
      },
    } as unknown as Connection;
    return { connection, sent };
  }

  it("sends protocol::Request::SetThisDeviceSendPermission", async () => {
    const { connection, sent } = answering({ type: "Ok" });
    await handOver(connection, "v1.a.b");
    expect(sent).toEqual([{ type: "SetThisDeviceSendPermission", permission: "v1.a.b" }]);
  });

  it("reads an older daemon's refusal of an unknown request as too old", async () => {
    const { connection } = answering({ type: "Forbidden", request_type: "Unknown", role: "remote" });
    await expect(handOver(connection, "v1.a.b")).rejects.toMatchObject({ tooOld: true });
  });

  it("passes the daemon's own refusal on", async () => {
    const { connection } = answering({ type: "Error", message: "gavin-daemon: not a permission" });
    await expect(handOver(connection, "x")).rejects.toMatchObject({
      tooOld: false,
      message: "gavin-daemon: not a permission",
    });
  });
});

describe("createHandover", () => {
  it("hands nothing over until notifications are on, then keeps the toggle", async () => {
    const { client, cancelled } = gateway();
    const ws = workstations(["ws-a", "ws-b"]);
    const kept: KeptRegistration[] = [];
    const handover = createHandover({ client, hand: ws.hand, keep: async (r) => void kept.push(r), now: () => NOW });
    handover.sync(["ws-a", "ws-b"]);
    await vi.waitFor(() => expect(get(handover.status)).toEqual({}));
    expect(client.mintPermission).not.toHaveBeenCalled();

    handover.use(registration);
    await vi.waitFor(() => expect(get(handover.status)).toEqual({ "ws-a": "on", "ws-b": "on" }));

    handover.setMuted("ws-b", true);
    await vi.waitFor(() => expect(get(handover.status)).toEqual({ "ws-a": "on", "ws-b": "off" }));
    expect(cancelled).toEqual(["pid-2"]);
    expect(kept.some((r) => r.muted.includes("ws-b"))).toBe(true);
    expect(ws.handed.at(-1)).toEqual(["ws-b", ""]);
  });
});

describe("createHandover's registration", () => {
  it("keeps the permissions it minted when handed the same Device's registration again", async () => {
    const { client } = gateway();
    const ws = workstations(["ws-a"]);
    const handover = createHandover({ client, hand: ws.hand, keep: async () => {}, now: () => NOW });
    handover.sync(["ws-a"]);
    handover.use(registration);
    await vi.waitFor(() => expect(get(handover.status)).toEqual({ "ws-a": "on" }));
    // The setup's copy, read before anything was minted.
    handover.use({ ...registration });
    handover.sync(["ws-a"]);
    await new Promise((r) => setTimeout(r, 20));
    expect(client.mintPermission).toHaveBeenCalledTimes(1);
    expect(ws.handed).toEqual([["ws-a", "perm-1"]]);
  });
});
