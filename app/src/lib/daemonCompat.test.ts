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

  // The v10 daemon is the one that stores orchestrations but knows
  // nothing of tools: it has no `tool_id` column, so a tool step handed
  // to it lands as a step with neither a card nor a tool. Blocking the
  // Tools UI there is what stops that step ever being written.
  it("blocks tools on a v10 daemon that allows orchestration", () => {
    const v10 = { daemonVersion: 10, appVersion: 12, degraded: true };
    expect(featureBlockedReason(v10, "orchestration")).toBeNull();
    expect(featureBlockedReason(v10, "tools")).toContain("v11");
  });

  it("stops blocking tools at exactly v11", () => {
    const v11 = { daemonVersion: 11, appVersion: 12, degraded: true };
    expect(featureBlockedReason(v11, "tools")).toBeNull();
  });

  // The v13 daemon is the one that archives happily and still refuses
  // `[agent] model`: SetRootConfigField parses fine, then the allow-list
  // rejects the key. Nothing on the wire gate catches that, so the
  // Settings row has to be blocked here or it fails on blur.
  it("blocks the agent model on a v13 daemon that allows archiving", () => {
    const v13 = { daemonVersion: 13, appVersion: 14, degraded: true };
    expect(featureBlockedReason(v13, "archive")).toBeNull();
    expect(featureBlockedReason(v13, "agentModel")).toContain("v14");
  });

  it("stops blocking the agent model at exactly v14", () => {
    const v14 = { daemonVersion: 14, appVersion: 14, degraded: false };
    expect(featureBlockedReason(v14, "agentModel")).toBeNull();
  });

  it("blocks nothing before a connection exists", () => {
    expect(featureBlockedReason(null, "orchestration")).toBeNull();
  });
});

describe("the groups gate", () => {
  it("blocks grouping on a daemon that would drop the mode", () => {
    // A v14 daemon parses SetOrchestration perfectly and has no `mode`
    // column: it accepts a sequential group and returns it parallel. The
    // wire gate cannot see a widened request, so this is the only gate.
    const c = { daemonVersion: 14, appVersion: 15, degraded: true };
    expect(featureBlockedReason(c, "groups")).toContain("v15");
  });

  it("allows grouping on a v15 daemon", () => {
    expect(featureBlockedReason({ daemonVersion: 15, appVersion: 15, degraded: false }, "groups")).toBeNull();
  });
});
