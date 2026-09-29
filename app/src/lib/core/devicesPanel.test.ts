import { describe, it, expect } from "vitest";
import { source } from "$lib/sources";
import {
  DEVICES_LABEL,
  connectedCount,
  devicesBadge,
  devicesBadgeTip,
  devicesBlocked,
  panelRows,
  withConnected,
  withoutConnected,
} from "$lib/core/devicesPanel";
import type { DeviceInfo } from "$lib/core/remoteAccess";

const NOW = 1_770_000_000_000;
const dev = (id: string, over: Partial<DeviceInfo> = {}): DeviceInfo => ({
  deviceId: id,
  name: `phone ${id}`,
  role: "remote",
  createdAt: NOW / 1000 - 86_400,
  lastSeenAt: NOW / 1000 - 3600,
  revokedAt: null,
  stale: false,
  ...over,
});

describe("the connected set", () => {
  it("is replaced, never mutated, by a push", () => {
    const empty = new Set<string>();
    const one = withConnected(empty, "a");
    expect(empty.size).toBe(0);
    expect([...one]).toEqual(["a"]);
    expect(withoutConnected(one, "a").size).toBe(0);
    expect(one.size).toBe(1);
  });
});

describe("the footer badge", () => {
  it("counts connected paired Devices", () => {
    const list = [dev("a"), dev("b"), dev("c")];
    expect(connectedCount(list, new Set(["a", "c"]))).toBe(2);
    expect(devicesBadge(list, new Set(["a", "c"]))).toBe("2");
  });

  it("is absent when nothing is connected or nothing has been read", () => {
    expect(devicesBadge([dev("a")], new Set())).toBeNull();
    expect(devicesBadge(null, new Set(["a"]))).toBeNull();
  });

  it("drops a Device the moment the list calls it revoked or stale", () => {
    const list = [dev("a", { revokedAt: 1 }), dev("b", { stale: true }), dev("c")];
    expect(connectedCount(list, new Set(["a", "b", "c"]))).toBe(1);
  });

  it("ignores an id the list does not know", () => {
    expect(connectedCount([dev("a")], new Set(["ghost"]))).toBe(0);
  });

  it("says the count in words for the tooltip", () => {
    expect(devicesBadgeTip(1)).toBe("1 Device connected");
    expect(devicesBadgeTip(3)).toBe("3 Devices connected");
  });
});

describe("the panel rows", () => {
  it("says Connected for a connected row and last-seen for the rest", () => {
    const rows = panelRows([dev("a"), dev("b")], new Set(["b"]), NOW);
    const byId = Object.fromEntries(rows.map((r) => [r.deviceId, r]));
    expect(byId.b.connected).toBe(true);
    expect(byId.b.state).toBe("Connected");
    expect(byId.a.connected).toBe(false);
    expect(byId.a.state).toMatch(/^seen /);
  });

  it("lists connected Devices first, then the list's own order", () => {
    const list = [
      dev("recent", { lastSeenAt: NOW / 1000 - 10 }),
      dev("older", { lastSeenAt: NOW / 1000 - 5000 }),
      dev("live", { lastSeenAt: NOW / 1000 - 9000 }),
    ];
    const ids = panelRows(list, new Set(["live"]), NOW).map((r) => r.deviceId);
    expect(ids).toEqual(["live", "recent", "older"]);
  });

  it("never shows a revoked Device as connected, and keeps it dimmed and unrevocable", () => {
    const [row] = panelRows([dev("a", { revokedAt: 5 })], new Set(["a"]), NOW);
    expect(row.connected).toBe(false);
    expect(row.dimmed).toBe(true);
    expect(row.revocable).toBe(false);
    expect(row.note).toBe("revoked");
  });
});

describe("the gate", () => {
  it("is the remote access gate: silent before a verdict", () => {
    expect(devicesBlocked(null)).toBeNull();
  });
});

describe("the surfaces", () => {
  it("puts the footer row and the panel on the app panel store", () => {
    expect(DEVICES_LABEL).toBe("Devices");
    const sidebar = source("Sidebar.svelte");
    expect(sidebar).toContain('showAppPanel("devices")');
    expect(sidebar).toContain("{DEVICES_LABEL}");
    expect(sidebar).toContain("{$devicesBadgeText}");
    expect(sidebar).toContain('$openAppPanel === "devices"');
    expect(sidebar).toContain("<DevicesPanel");
    expect(source("appPanels.ts")).toContain('"devices"');
  });

  it("titles the panel with the same constant and gates every control", () => {
    const panel = source("DevicesPanel.svelte");
    expect(panel).toContain("<h2>{DEVICES_LABEL}</h2>");
    expect(panel).toContain("Pair a device");
    expect(panel).toContain("Revoke all devices");
    expect(source("devicesPanel.ts")).toContain('featureBlockedReason(compat, "remoteAccess")');
    const disabled = [...panel.matchAll(/disabled=\{([^}]*)\}/g)].map((m) => m[1]);
    expect(disabled.length).toBe(3);
    for (const d of disabled) expect(d).toContain("gate !== null");
  });
});
