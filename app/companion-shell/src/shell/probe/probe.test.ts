import { describe, expect, it } from "vitest";
import {
  PROBE_FROM_FRAME,
  PROBE_REPORT,
  createProbeBench,
  probeVerdict,
  type ChecksReport,
  type NavigationReport,
  type ProbeFrame,
  type VerdictInput,
} from "$shell/probe/probe";
import type { VisitDrop } from "$shell/visit/visit";

const ORIGIN = "gavin-bundle://probe";

function checks(overrides: Partial<ChecksReport> = {}): ChecksReport {
  return {
    stage: "checks",
    origin: ORIGIN,
    capabilities: { workstation: { id: "probe" } },
    globals: { Capacitor: "undefined", "webkit.messageHandlers.bridge": "undefined", androidBridge: "undefined" },
    pluginCalls: [
      { how: "Capacitor.Plugins.BundleView.openExternal", outcome: "failed: TypeError: undefined is not an object" },
      { how: "webkit.messageHandlers.bridge", outcome: "failed: no such handler" },
    ],
    keyCalls: [
      { how: "Capacitor.Plugins.DeviceKeys.noiseKey", outcome: "failed: TypeError: undefined is not an object" },
      { how: "webkit.messageHandlers.bridge.postMessage DeviceKeys.sign", outcome: "failed: no such handler" },
    ],
    pairingCalls: [
      { how: "Capacitor.Plugins.Workstations.list", outcome: "failed: TypeError: undefined is not an object" },
      { how: "androidBridge.postMessage QrScanner.scan", outcome: "failed: TypeError: undefined is not an object" },
    ],
    frames: [iosFrame("other-origin"), iosFrame("own-origin-subframe")],
    fetches: [
      { how: "fetch https://example.com/", outcome: "failed: TypeError: Load failed" },
      { how: "fetch capacitor://localhost/", outcome: "failed: TypeError: Load failed" },
    ],
    ...overrides,
  };
}

/// On iOS a frame can see the handler, and the native side refuses it.
function iosFrame(frame: string): ProbeFrame {
  return {
    frame,
    ran: true,
    attempts: [
      { how: "window.gavinChannel", outcome: "failed: not defined here" },
      { how: "webkit.messageHandlers.gavinChannel", outcome: "posted" },
      { how: "parent.gavinChannel", outcome: "failed: SecurityError" },
    ],
  };
}

/// On Android a frame of another origin is never given the channel.
function androidFrame(frame: string): ProbeFrame {
  return {
    frame,
    ran: true,
    attempts: [
      { how: "window.gavinChannel", outcome: "failed: not defined here" },
      { how: "parent.gavinChannel", outcome: "failed: SecurityError" },
    ],
  };
}

const NAVIGATION: NavigationReport = { stage: "navigation", stillAt: `${ORIGIN}/index.html`, windowOpen: "null" };

const IOS_DROPS: VisitDrop[] = [
  { where: "native", origin: "null", mainFrame: false },
  { where: "native", origin: ORIGIN, mainFrame: false },
];

function verdict(input: Partial<VerdictInput> = {}) {
  return probeVerdict({ reports: [checks(), NAVIGATION], invokes: [PROBE_REPORT, PROBE_REPORT], drops: IOS_DROPS, ...input });
}

function check(v: ReturnType<typeof probeVerdict>, name: string) {
  const found = v.checks.find((c) => c.name === name);
  if (!found) throw new Error(`no check named "${name}"`);
  return found;
}

describe("the probe's verdict", () => {
  it("passes a sealed webview, the way iOS seals it", () => {
    const v = verdict();
    expect(v.checks.filter((c) => !c.passed)).toEqual([]);
    expect(v.passed).toBe(true);
  });

  it("passes a sealed webview, the way Android seals it", () => {
    const v = verdict({
      reports: [
        checks({
          globals: { Capacitor: "undefined", androidBridge: "undefined" },
          frames: [androidFrame("other-origin"), { ...iosFrame("own-origin-subframe") }],
        }),
        NAVIGATION,
      ],
      drops: [{ where: "native", origin: ORIGIN, mainFrame: false }],
    });
    expect(v.checks.filter((c) => !c.passed)).toEqual([]);
  });

  it("fails when a plugin call from the bundle went through", () => {
    const v = verdict({
      reports: [
        checks({ pluginCalls: [{ how: "Capacitor.Plugins.BundleView.openExternal", outcome: "ran" }] }),
        NAVIGATION,
      ],
    });
    expect(check(v, "a plugin call from the bundle webview fails").passed).toBe(false);
    expect(v.passed).toBe(false);
  });

  it("fails when a call to the Device's keys went through", () => {
    const v = verdict({
      reports: [
        checks({ keyCalls: [{ how: "Capacitor.Plugins.DeviceKeys.noiseKey", outcome: 'ran: {"privateKey":"00"}' }] }),
        NAVIGATION,
      ],
    });
    expect(check(v, "the Device's keys are out of the bundle's reach").passed).toBe(false);
    expect(v.passed).toBe(false);
  });

  it("fails when the probe never tried the Device's keys: silence proves nothing", () => {
    const v = verdict({ reports: [checks({ keyCalls: [] }), NAVIGATION] });
    expect(check(v, "the Device's keys are out of the bundle's reach")).toMatchObject({
      passed: false,
      detail: "the probe made no call to the keys plugin",
    });
  });

  it("fails when a call to the paired Workstations went through, or none was tried", () => {
    const ran = verdict({
      reports: [
        checks({ pairingCalls: [{ how: "Capacitor.Plugins.Workstations.list", outcome: 'ran: {"records":[]}' }] }),
        NAVIGATION,
      ],
    });
    const name = "the paired Workstations and the camera are out of the bundle's reach";
    expect(check(ran, name).passed).toBe(false);
    expect(ran.passed).toBe(false);
    expect(check(verdict({ reports: [checks({ pairingCalls: [] }), NAVIGATION] }), name)).toMatchObject({
      passed: false,
      detail: "the probe made no call to the Workstations or QrScanner plugin",
    });
  });

  it("fails when the bundle can see a bridge", () => {
    const v = verdict({
      reports: [checks({ globals: { Capacitor: "object", androidBridge: "undefined" } }), NAVIGATION],
    });
    expect(check(v, "the bundle webview has no Capacitor bridge")).toMatchObject({
      passed: false,
      detail: "Capacitor is object",
    });
  });

  it("fails when a frame's message reached the Workstation", () => {
    const v = verdict({ invokes: [PROBE_REPORT, `${PROBE_FROM_FRAME}:other-origin`, PROBE_REPORT] });
    expect(check(v, "a channel message from another origin is dropped").passed).toBe(false);
    expect(check(v, "a channel message from a subframe is dropped").passed).toBe(true);
  });

  it("fails when a frame posted and nothing says it was dropped natively", () => {
    const v = verdict({ drops: [] });
    expect(check(v, "a channel message from another origin is dropped").passed).toBe(false);
    expect(check(v, "a channel message from a subframe is dropped").passed).toBe(false);
  });

  it("fails a frame whose script never ran: silence proves nothing", () => {
    const v = verdict({
      reports: [checks({ frames: [{ ...androidFrame("other-origin"), ran: false }, iosFrame("own-origin-subframe")] }), NAVIGATION],
    });
    expect(check(v, "a channel message from another origin is dropped")).toMatchObject({
      passed: false,
      detail: "the frame's script did not run",
    });
  });

  it("fails when the bundle reached the network", () => {
    const v = verdict({
      reports: [checks({ fetches: [{ how: "fetch https://example.com/", outcome: "200" }] }), NAVIGATION],
    });
    expect(check(v, "the bundle cannot reach the network or the shell's origin").passed).toBe(false);
  });

  it("fails when a navigation left the bundle's origin, or never reported", () => {
    expect(
      check(verdict({ reports: [checks(), { ...NAVIGATION, stillAt: "https://example.com/" }] }), "navigating away is blocked")
        .passed
    ).toBe(false);
    expect(check(verdict({ reports: [checks()] }), "navigating away is blocked").passed).toBe(false);
  });

  it("fails everything when no report arrived at all", () => {
    const v = probeVerdict({ reports: [], invokes: [], drops: [] });
    expect(v.passed).toBe(false);
    expect(v.checks[0]).toMatchObject({ passed: false, detail: "no report arrived" });
  });
});

describe("the probe Workstation", () => {
  it("records what reaches it, answers reports, and finishes on the last one", async () => {
    const bench = createProbeBench();
    const replies: unknown[] = [];
    const say = (message: object) =>
      bench.visit.endpoint.receive(JSON.stringify({ v: 1, ...message }), (raw) => replies.push(JSON.parse(raw)));
    say({ type: "invoke", id: 1, cmd: PROBE_REPORT, args: checks() });
    say({ type: "invoke", id: 2, cmd: PROBE_FROM_FRAME, args: { frame: "other-origin" } });
    say({ type: "invoke", id: 3, cmd: PROBE_REPORT, args: NAVIGATION });
    await bench.finished;
    expect(bench.invokes).toEqual([PROBE_REPORT, `${PROBE_FROM_FRAME}:other-origin`, PROBE_REPORT]);
    expect(bench.reports.map((r) => r.stage)).toEqual(["checks", "navigation"]);
    expect(replies.map((r) => (r as { ok: boolean }).ok)).toEqual([true, false, true]);
  });
});
