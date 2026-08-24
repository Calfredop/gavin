import { describe, it, expect } from "vitest";
import { compatMessage, featureBlockedReason } from "./daemonCompat";

describe("compatMessage", () => {
  it("says nothing when the daemon matches", () => {
    expect(compatMessage({ daemonVersion: 12, appVersion: 12, degraded: false }, 3)).toBeNull();
  });

  it("says nothing when there is no daemon yet", () => {
    expect(compatMessage(null, 0)).toBeNull();
  });

  it("names both versions when degraded", () => {
    const msg = compatMessage({ daemonVersion: 9, appVersion: 12, degraded: true }, 0)!;
    expect(msg).toContain("v9");
    expect(msg).toContain("v12");
  });

  it("warns about the cost of restarting when agents are running", () => {
    const msg = compatMessage({ daemonVersion: 9, appVersion: 12, degraded: true }, 3)!;
    expect(msg).toContain("3");
  });

  it("does not pluralise a single agent", () => {
    const msg = compatMessage({ daemonVersion: 9, appVersion: 12, degraded: true }, 1)!;
    expect(msg).toContain("1 running agent");
    expect(msg).not.toContain("1 running agents");
  });
});

describe("featureBlockedReason", () => {
  const v9 = { daemonVersion: 9, appVersion: 12, degraded: true };

  it("blocks orchestration on a v9 daemon", () => {
    expect(featureBlockedReason(v9, "orchestration")).toContain("v10");
  });

  it("stops blocking orchestration at exactly v10", () => {
    const v10 = { daemonVersion: 10, appVersion: 12, degraded: true };
    expect(featureBlockedReason(v10, "orchestration")).toBeNull();
  });

  it("blocks nothing on a matching daemon", () => {
    const v12 = { daemonVersion: 12, appVersion: 12, degraded: false };
    expect(featureBlockedReason(v12, "orchestration")).toBeNull();
  });

  it("blocks nothing before a connection exists", () => {
    expect(featureBlockedReason(null, "orchestration")).toBeNull();
  });
});
