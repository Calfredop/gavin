import { describe, it, expect } from "vitest";
import {
  compatMessage,
  featureBlockedReason,
  restartConfirmLines,
  restartOutcome,
} from "$lib/daemonCompat";

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

// The reported bug: pressing "Restart daemon" on the compat banner looked
// like it did nothing. It did restart the daemon -- and re-spawned the same
// stale gavin-daemon binary, so the banner came back with byte-identical
// text. These pin the wording that makes the difference visible.
describe("restartOutcome", () => {
  it("says nothing when the restart cleared the degradation", () => {
    expect(restartOutcome(9, { daemonVersion: 12, appVersion: 12, degraded: false })).toBeNull();
  });

  it("says nothing when there is no verdict to report", () => {
    expect(restartOutcome(9, null)).toBeNull();
  });

  it("names the no-op when the daemon comes back at the same version", () => {
    const msg = restartOutcome(16, { daemonVersion: 16, appVersion: 17, degraded: true })!;
    expect(msg).toContain("v16");
    expect(msg).toContain("same version");
    // The actionable half: the button is not broken, the binary is stale.
    expect(msg).toContain("gavin-daemon");
  });

  it("reports a daemon that moved but is still behind", () => {
    const msg = restartOutcome(15, { daemonVersion: 16, appVersion: 17, degraded: true })!;
    expect(msg).toContain("v16");
    expect(msg).toContain("v15");
    expect(msg).toContain("v17");
    expect(msg).not.toContain("same version");
  });

  it("still reports the versions when the pre-restart verdict is unknown", () => {
    const msg = restartOutcome(null, { daemonVersion: 16, appVersion: 17, degraded: true })!;
    expect(msg).toContain("v16");
    expect(msg).toContain("v17");
    // Nothing to compare against, so it must not claim the version held.
    expect(msg).not.toContain("same version");
  });
});

describe("featureBlockedReason", () => {
  const v9 = { daemonVersion: 9, appVersion: 12, degraded: true };

  // v21 widened SetStepRun and LinkCardSession rather than adding a
  // request type, so min_version_for -- which gates TYPES -- is
  // structurally blind to it: a v20 daemon parses both fine and drops
  // `conversation_id` and `launch_cwd` on the floor. This entry is the
  // only gate there is, and its consumer is the LAUNCH: an id that
  // cannot be persisted is an id no Resume can ever use.
  it("blocks conversation resume below v21 and allows it at exactly v21", () => {
    expect(featureBlockedReason({ daemonVersion: 20, appVersion: 21, degraded: true }, "conversationResume")).toContain("v21");
    expect(featureBlockedReason({ daemonVersion: 21, appVersion: 21, degraded: false }, "conversationResume")).toBeNull();
  });

  it("blocks failure detection below v21, which is what the copy about it depends on", () => {
    expect(featureBlockedReason({ daemonVersion: 20, appVersion: 21, degraded: true }, "failureDetection")).toContain("v21");
    expect(featureBlockedReason({ daemonVersion: 21, appVersion: 21, degraded: false }, "failureDetection")).toBeNull();
  });

  it("blocks orchestration on a v9 daemon", () => {
    expect(featureBlockedReason(v9, "orchestration")).toContain("v10");
  });

  // Client identity: a pre-v35 daemon has no Hello to answer, so the
  // Remote access surface greys itself with the version it needs rather
  // than writing require_local_token to a daemon that would not read it.
  it("blocks client identity below v35 and allows it at exactly v35", () => {
    expect(featureBlockedReason({ daemonVersion: 34, appVersion: 35, degraded: true }, "clientIdentity")).toContain("v35");
    expect(featureBlockedReason({ daemonVersion: 35, appVersion: 35, degraded: false }, "clientIdentity")).toBeNull();
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

  // The pickable PRD path. Unlike `groups` and `railBranch`, a v16
  // daemon refuses the write outright -- but it also keeps resolving the
  // PRD against the hard-coded path, so a choice that somehow landed
  // would split the tab from the board and from gavin_read_prd.
  it("blocks the PRD path on a v16 daemon that allows rail branches", () => {
    const v16 = { daemonVersion: 16, appVersion: 17, degraded: true };
    expect(featureBlockedReason(v16, "railBranch")).toBeNull();
    expect(featureBlockedReason(v16, "prdPath")).toContain("v17");
  });

  it("stops blocking the PRD path at exactly v17", () => {
    const v17 = { daemonVersion: 17, appVersion: 17, degraded: false };
    expect(featureBlockedReason(v17, "prdPath")).toBeNull();
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

describe("the rail-branch gate", () => {
  // The same blind spot as `groups`, one version later: a v15 daemon
  // parses SetOrchestration fine and has no `branch` column on
  // orch_rails, so it takes the binding, drops the field and hands the
  // rail back unbound. The human sees their choice snap back to "None"
  // and the rail then runs on whatever is checked out.
  it("blocks branch binding on a daemon that would drop the branch", () => {
    const c = { daemonVersion: 15, appVersion: 16, degraded: true };
    expect(featureBlockedReason(c, "railBranch")).toContain("v16");
  });

  // Groups still work on that same daemon -- the two gates are
  // independent, and blocking one must not read as blocking the other.
  it("leaves grouping alone on that daemon", () => {
    const c = { daemonVersion: 15, appVersion: 16, degraded: true };
    expect(featureBlockedReason(c, "groups")).toBeNull();
  });

  it("allows branch binding at exactly v16", () => {
    const c = { daemonVersion: 16, appVersion: 16, degraded: false };
    expect(featureBlockedReason(c, "railBranch")).toBeNull();
  });
});

// The one screen whose COPY asserts v20's recovery behaviour. A
// confirmation that promises "stopped, not restarted" and then hands the
// work to a daemon that re-runs every command from scratch is worse than
// no confirmation at all.
describe("restartConfirmLines", () => {
  const lines = (c: Parameters<typeof restartConfirmLines>[0]) => restartConfirmLines(c).join(" ");

  it("promises the safe behaviour on a daemon that delivers it", () => {
    expect(lines({ daemonVersion: 20, appVersion: 20, degraded: false })).toContain(
      "stopped, and not restarted"
    );
  });

  it("warns that an older daemon will re-run the command instead", () => {
    const said = lines({ daemonVersion: 19, appVersion: 20, degraded: true });
    expect(said).toContain("RE-RUN its command from the beginning");
    expect(said).not.toContain("stopped, and not restarted");
  });

  // Not connected yet: the app's own behaviour is the honest default,
  // matching featureBlockedReason's "don't pre-emptively grey things out".
  it("uses the current behaviour when there is no verdict yet", () => {
    expect(lines(null)).toContain("stopped, and not restarted");
  });

  it("always says the other three things, whichever daemon it is", () => {
    for (const c of [null, { daemonVersion: 19, appVersion: 20, degraded: true }]) {
      expect(restartConfirmLines(c)).toHaveLength(4);
      expect(restartConfirmLines(c)[0]).toContain("fresh shell");
      expect(restartConfirmLines(c)[2]).toContain("Scrollback");
      expect(restartConfirmLines(c)[3]).toContain("window stays open");
    }
  });
});
