import { describe, it, expect } from "vitest";
import {
  describeOrphan,
  endOrphanConfirm,
  endOrphanOutcome,
  interruptedCardNote,
  orphanDetectionAvailable,
  restoredBadge,
  type OrphanProcess,
} from "$lib/orphan";
import { FEATURE_MIN_VERSION, type DaemonCompat } from "$lib/daemonCompat";

const CURRENT: DaemonCompat = {
  daemonVersion: FEATURE_MIN_VERSION.orphanDetection,
  appVersion: FEATURE_MIN_VERSION.orphanDetection,
  degraded: false,
};
const OLDER: DaemonCompat = {
  daemonVersion: FEATURE_MIN_VERSION.orphanDetection - 1,
  appVersion: FEATURE_MIN_VERSION.orphanDetection,
  degraded: true,
};

const ORPHAN: OrphanProcess = { pid: 4172, command: "claude --model opus" };

describe("describeOrphan", () => {
  it("names the command and the pid, so the human can find it without gavin", () => {
    expect(describeOrphan(ORPHAN)).toBe("claude --model opus (pid 4172)");
  });

  it("falls back to the pid alone for a session that carried no command", () => {
    expect(describeOrphan({ pid: 90, command: null })).toBe("pid 90");
  });

  it("treats a blank command as no command rather than printing empty parentheses", () => {
    expect(describeOrphan({ pid: 90, command: "   " })).toBe("pid 90");
  });
});

describe("orphanDetectionAvailable", () => {
  it("is true on a daemon that actually probes", () => {
    expect(orphanDetectionAvailable(CURRENT)).toBe(true);
  });

  it("is false on an older daemon, which never looked", () => {
    expect(orphanDetectionAvailable(OLDER)).toBe(false);
  });

  it("does not hedge before the app has connected", () => {
    // Same rule featureBlockedReason follows on null: startup must not
    // pre-emptively caveat everything the app says.
    expect(orphanDetectionAvailable(null)).toBe(true);
  });
});

describe("restoredBadge", () => {
  it("shows nothing for a session that was never restored", () => {
    expect(
      restoredBadge({ restored: false, interrupted: false, orphan: null, compat: CURRENT })
    ).toBeNull();
  });

  it("keeps the plain restored note for a terminal session that lost no run", () => {
    const badge = restoredBadge({
      restored: true,
      interrupted: false,
      orphan: null,
      compat: CURRENT,
    });
    expect(badge?.tone).toBe("restored");
    expect(badge?.canEnd).toBe(false);
  });

  it("says the process is gone only when a daemon actually checked", () => {
    const badge = restoredBadge({
      restored: true,
      interrupted: true,
      orphan: null,
      compat: CURRENT,
    });
    expect(badge?.tone).toBe("interrupted");
    expect(badge?.title).toContain("its process is gone");
  });

  it("refuses to claim a clean stop on a daemon that never probed", () => {
    // The setupProgress trap, in its most expensive form: on an older
    // daemon "no orphan" is silence, and asserting the agent exited would
    // send the human off to press Resume next to a live agent.
    const badge = restoredBadge({
      restored: true,
      interrupted: true,
      orphan: null,
      compat: OLDER,
    });
    expect(badge?.tone).toBe("interrupted");
    expect(badge?.title).not.toContain("its process is gone");
    expect(badge?.title).toContain("too old to check");
  });

  it("escalates to orphaned and offers the action when a process survived", () => {
    const badge = restoredBadge({
      restored: true,
      interrupted: true,
      orphan: ORPHAN,
      compat: CURRENT,
    });
    expect(badge?.tone).toBe("orphaned");
    expect(badge?.canEnd).toBe(true);
    expect(badge?.title).toContain("claude --model opus (pid 4172)");
    expect(badge?.title).toContain("DID NOT STOP");
  });

  it("reports an orphan even on a tab whose restored marker was already dismissed", () => {
    // `restored` is cleared the moment the human types into the shell,
    // and a live agent editing the checkout does not stop mattering
    // because someone ran `ls` in the tab in front of it.
    const badge = restoredBadge({
      restored: false,
      interrupted: true,
      orphan: ORPHAN,
      compat: CURRENT,
    });
    expect(badge?.tone).toBe("orphaned");
  });
});

describe("interruptedCardNote", () => {
  it("tells the human to end the survivor BEFORE it mentions resuming", () => {
    // The card modal is where Resume lives, and resuming next to a live
    // agent is the second-agent-in-one-checkout outcome by a different
    // route than the re-run v20 closed.
    const note = interruptedCardNote({ orphan: ORPHAN, compat: CURRENT });
    expect(note).toContain("DID NOT STOP");
    expect(note).toContain("claude --model opus (pid 4172)");
    expect(note).toContain("End it before you resume");
    expect(note).toContain("two agents");
  });

  it("says the process is gone when a daemon actually checked", () => {
    const note = interruptedCardNote({ orphan: null, compat: CURRENT });
    expect(note).toContain("Its process is gone");
    expect(note).toContain("Resume picks that work up");
  });

  it("admits it does not know on a daemon that never probed", () => {
    const note = interruptedCardNote({ orphan: null, compat: OLDER });
    expect(note).not.toContain("Its process is gone");
    expect(note).toContain("too old to check");
    expect(note).toContain("confirm it is gone before resuming");
  });
});

describe("endOrphanConfirm", () => {
  it("names the process it is about to kill", () => {
    expect(endOrphanConfirm(ORPHAN).title).toContain("claude --model opus (pid 4172)");
  });

  it("says what survives, so the prompt is not read as an undo", () => {
    expect(endOrphanConfirm(ORPHAN).lines.join(" ")).toContain("stays");
  });

  it("is a danger prompt with a verb on the button", () => {
    // ConfirmPrompt parks focus on Cancel for a danger choice, so Enter
    // cannot end a process gavin no longer hosts by reflex.
    const prompt = endOrphanConfirm(ORPHAN);
    expect(prompt.danger).toBe(true);
    expect(prompt.confirmLabel).not.toMatch(/^ok$/i);
  });
});

describe("endOrphanOutcome", () => {
  it("says nothing when the process actually ended", () => {
    // The badge vanishing is the feedback; a modal confirming what the
    // human just watched happen is noise.
    expect(endOrphanOutcome(ORPHAN, { ended: true, stillRunning: false })).toBeNull();
  });

  it("speaks up when the process ignored the signal, and offers the escape hatch", () => {
    const alert = endOrphanOutcome(ORPHAN, { ended: false, stillRunning: true })!;
    expect(alert.title).toContain("still running");
    expect(alert.lines.join(" ")).toContain("kill -9 4172");
  });

  it("distinguishes an already-gone process from one that refused", () => {
    const alert = endOrphanOutcome(ORPHAN, { ended: false, stillRunning: false })!;
    expect(alert.title).toContain("already gone");
    expect(alert.lines.join(" ")).not.toContain("kill -9");
  });
});
