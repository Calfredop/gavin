import { describe, it, expect } from "vitest";
import {
  SLEPT_REASON_PREFIX,
  MAX_AUTO_RESUME_ATTEMPTS,
  STAGGER_SPREAD_MS,
  WAVE_ABORT_WINDOW_MS,
  autoResumeDecision,
  autoResumePolicy,
  classifyFailure,
  isImmediateRefailure,
  resumeDelayMs,
  resumeNotificationBody,
  resumeNoteFor,
  resumeSkippedBody,
  resumeTrailLine,
  staggerDelays,
  type AutoResumeInput,
  type FailureCausePattern,
} from "$lib/agents/autoResume";

// claude-code's table, in the order agent_setup.rs lists it. Copied
// rather than imported because the point of several tests below is that
// the ORDER the profile chose is what decides the answer.
const CLAUDE: FailureCausePattern[] = [
  { pattern: "/login", cause: "auth" },
  { pattern: "OAuth token has expired", cause: "auth" },
  { pattern: "exceeded your usage limit", cause: "usage-limit" },
  { pattern: "usage limit", cause: "usage-limit" },
  { pattern: "529 Overloaded", cause: "outage" },
  { pattern: "Overloaded", cause: "outage" },
  { pattern: "Connection dropped", cause: "network" },
  { pattern: "ECONNRESET", cause: "network" },
  { pattern: "empty or malformed response", cause: "network" },
  { pattern: "Connection error", cause: "network" },
];

describe("classifyFailure", () => {
  // Every string here is a line the failure-detection spec RECORDED off
  // a real Claude Code screen, not one invented to make a test pass.
  it("names each measured Claude Code failure line", () => {
    expect(classifyFailure("API Error: Connection dropped (ECONNRESET)", CLAUDE)).toBe("network");
    expect(
      classifyFailure(
        "API Error: API returned an empty or malformed response (HTTP 200)",
        CLAUDE
      )
    ).toBe("network");
    expect(
      classifyFailure("API Error: 529 Overloaded. This is a server-side issue", CLAUDE)
    ).toBe("outage");
    expect(
      classifyFailure(
        "API Error: Server is temporarily limiting requests. You have exceeded your usage limit.",
        CLAUDE
      )
    ).toBe("usage-limit");
  });

  // The ordering trap: the expired-token line carries "API Error:" too,
  // and every generic network row would match a substring of it. Auth
  // has to win, or gavin resumes an agent straight into a login prompt.
  it("reads the expired-token line as auth even though it is also an API error", () => {
    const line = "Please run /login · API Error: 401 OAuth token has expired. Please run /login";
    expect(classifyFailure(line, CLAUDE)).toBe("auth");
  });

  it("recognises gavin's own suspend sentence without a profile", () => {
    expect(
      classifyFailure(`${SLEPT_REASON_PREFIX} 2h 14m and this agent has not spoken since`, [])
    ).toBe("suspend");
  });

  // A profile with no table gets NO classification, never a guess -- the
  // same posture failure_patterns takes, and for the same reason.
  it("classifies nothing for a profile that verified no causes", () => {
    expect(classifyFailure("API Error: Connection dropped (ECONNRESET)", [])).toBe("unknown");
  });

  it("treats a missing or blank reason as unknown", () => {
    expect(classifyFailure(null, CLAUDE)).toBe("unknown");
    expect(classifyFailure("   ", CLAUDE)).toBe("unknown");
  });

  // A newer profile row naming a cause this build has never heard of
  // must not be passed through into a branch that acts on it -- the same
  // rule parseSessionStatus enforces for a status.
  it("refuses a cause id it does not know rather than trusting it", () => {
    expect(classifyFailure("boom", [{ pattern: "boom", cause: "cosmic-ray" }])).toBe("unknown");
  });
});

describe("autoResumePolicy", () => {
  it("resumes only the externally-caused, transient failures", () => {
    expect(autoResumePolicy("suspend")).toEqual({ kind: "resume", on: "wake" });
    expect(autoResumePolicy("network")).toEqual({ kind: "resume", on: "reachable" });
    expect(autoResumePolicy("outage")).toEqual({ kind: "resume", on: "backoff" });
  });

  // The two the card names explicitly, and they are NOT the same refusal:
  // a usage limit will pass on its own, an expired token will not.
  it("holds a usage limit and never resumes an auth failure", () => {
    expect(autoResumePolicy("usage-limit").kind).toBe("hold");
    expect(autoResumePolicy("auth").kind).toBe("never");
  });

  it("never resumes a crash or a cause it cannot name", () => {
    expect(autoResumePolicy("crashed").kind).toBe("never");
    expect(autoResumePolicy("unknown").kind).toBe("never");
  });

  // An outage is the one cause with nothing observable to wait for, so
  // trying IS the probe -- and the wait has to be long enough to be
  // worth spending the single attempt on.
  it("waits far longer for an outage than for a signal that already arrived", () => {
    expect(resumeDelayMs("backoff")).toBeGreaterThan(resumeDelayMs("reachable"));
    expect(resumeDelayMs("wake")).toBe(resumeDelayMs("reachable"));
  });
});

function input(over: Partial<AutoResumeInput> = {}): AutoResumeInput {
  return {
    consented: true,
    reason: "API Error: Connection dropped (ECONNRESET)",
    causes: CLAUDE,
    previousStatus: "working",
    attempts: 0,
    conversationId: "conv-1",
    workFinished: false,
    ...over,
  };
}

describe("autoResumeDecision", () => {
  it("resumes a consented run whose network died", () => {
    expect(autoResumeDecision(input())).toEqual({
      kind: "resume",
      cause: "network",
      on: "reachable",
      delayMs: resumeDelayMs("reachable"),
    });
  });

  // Consent given in advance is the whole answer to "a rail resuming
  // itself six hours later made a decision that was mine". Without it,
  // nothing else about the run matters.
  it("does nothing at all without consent, however resumable the failure", () => {
    const d = autoResumeDecision(input({ consented: false }));
    expect(d.kind).toBe("skip");
    expect(d.kind === "skip" && d.why).toMatch(/off/);
  });

  // An agent can finish its edits and die before reporting them.
  // Re-running finished work is the failure mode this whole family of
  // cards exists to stop, so it outranks the cause.
  it("refuses to resume work that is already finished", () => {
    const d = autoResumeDecision(input({ workFinished: true }));
    expect(d).toEqual({
      kind: "skip",
      cause: "network",
      why: "the work was already finished when the agent stopped",
    });
  });

  it("never resumes a session that was waiting on the human", () => {
    const d = autoResumeDecision(input({ previousStatus: "waiting_for_input" }));
    expect(d.kind === "skip" && d.why).toMatch(/waiting on an answer/);
  });

  // Gavin auto-resumes exactly the runs it launched AND holds a
  // conversation id for. Without one, "resume" would be a fresh agent
  // starting over -- the exact bug wearing a better name.
  it("refuses a run it holds no conversation id for", () => {
    for (const id of [null, undefined, "  "]) {
      const d = autoResumeDecision(input({ conversationId: id }));
      expect(d.kind === "skip" && d.why).toMatch(/no conversation/);
    }
  });

  // One attempt. No exponential ladder and no second wind.
  it("spends the budget exactly once", () => {
    expect(autoResumeDecision(input({ attempts: 0 })).kind).toBe("resume");
    expect(autoResumeDecision(input({ attempts: MAX_AUTO_RESUME_ATTEMPTS })).kind).toBe("skip");
    expect(autoResumeDecision(input({ attempts: 9 })).kind).toBe("skip");
    // An absent count is a run that has never been resumed, not a run
    // that cannot be.
    expect(autoResumeDecision(input({ attempts: null })).kind).toBe("resume");
    expect(autoResumeDecision(input({ attempts: undefined })).kind).toBe("resume");
  });

  it("reports the caller's own blocker verbatim, so the trail can say it", () => {
    const d = autoResumeDecision(input({ blocked: "two steps of this parallel stage failed together" }));
    expect(d).toEqual({
      kind: "skip",
      cause: "network",
      why: "two steps of this parallel stage failed together",
    });
  });

  it("carries the cause through a skip, so a hold reads differently from a refusal", () => {
    const limit = autoResumeDecision(
      input({ reason: "API Error: You have exceeded your usage limit." })
    );
    expect(limit).toMatchObject({ kind: "skip", cause: "usage-limit" });
    expect(limit.kind === "skip" && limit.why).toMatch(/reset/);

    const auth = autoResumeDecision(input({ reason: "Please run /login · API Error: 401" }));
    expect(auth).toMatchObject({ kind: "skip", cause: "auth" });
    expect(auth.kind === "skip" && auth.why).toMatch(/login/);
  });
});

describe("staggerDelays", () => {
  it("leaves a lone resume exactly where the policy put it", () => {
    expect(staggerDelays([3000])).toEqual([3000]);
    expect(staggerDelays([])).toEqual([]);
  });

  // The herd is the point: N agents hitting the API the instant a flaky
  // network returns spends every budget at the worst possible moment.
  it("spreads a wave out in stable position order", () => {
    const delays = staggerDelays([3000, 3000, 3000, 3000], () => 0);
    expect(delays).toEqual([3000, 8000, 13000, 18000]);
    for (let i = 1; i < delays.length; i++) {
      expect(delays[i]).toBeGreaterThan(delays[i - 1]);
    }
  });

  it("keeps the whole wave inside the spread it advertises", () => {
    const delays = staggerDelays(new Array(5).fill(1000), () => 0.999);
    expect(Math.max(...delays) - 1000).toBeLessThanOrEqual(STAGGER_SPREAD_MS);
  });

  // Jitter, not just slots: two gavins waking on the same network must
  // not land on the same second.
  it("jitters inside each slot", () => {
    const low = staggerDelays([0, 0, 0], () => 0);
    const high = staggerDelays([0, 0, 0], () => 0.9);
    expect(high).not.toEqual(low);
  });

  it("respects each resume's own base delay", () => {
    const [a, b] = staggerDelays([3000, 60000], () => 0);
    expect(a).toBe(3000);
    expect(b).toBe(70000);
  });
});

describe("isImmediateRefailure", () => {
  // Reachability earns the right to try; it never predicts success. A
  // resume that breaks again in seconds is evidence about the network,
  // not a second independent failure.
  it("reads a failure right after a resume as the network not being back", () => {
    expect(isImmediateRefailure(1_000, 1_000 + WAVE_ABORT_WINDOW_MS)).toBe(true);
    expect(isImmediateRefailure(1_000, 1_000 + WAVE_ABORT_WINDOW_MS + 1)).toBe(false);
  });
});

describe("the audit trail", () => {
  const record = {
    cause: "network" as const,
    reason: "API Error: Connection dropped (ECONNRESET)",
    failedAt: Date.parse("2026-09-02T09:14:00Z"),
    resumedAt: Date.parse("2026-09-02T14:22:00Z"),
  };

  // A resume that leaves no trace is indistinguishable from a step that
  // never failed. Coming back to a green rail, you have to be able to
  // find out it was not green all along.
  it("says when it broke, when it came back, and what broke", () => {
    const line = resumeTrailLine(record);
    expect(line).toMatch(/resumed automatically/);
    expect(line).toContain("Connection dropped");
    // Rendered in the reader's own locale and zone, so the assertion is
    // on the pair of stamps rather than on two literal strings.
    const stamps = line.match(/\d{1,2}[:.]\d{2}/g) ?? [];
    expect(stamps).toHaveLength(2);
  });

  it("keeps the tray body short and still specific", () => {
    expect(resumeNotificationBody("ship the thing", record)).toBe(
      "ship the thing broke and was resumed automatically — API Error: Connection dropped (ECONNRESET)"
    );
  });

  // The times live in memory and the COUNT lives on the run row, so a
  // reload keeps the fact and loses only the detail. Losing the fact is
  // what would make a green rail indistinguishable from one that never
  // broke.
  it("falls back to the persisted count when the detail is gone", () => {
    expect(resumeNoteFor(record, 1)).toBe(resumeTrailLine(record));
    expect(resumeNoteFor(undefined, 1)).toMatch(/resumed this run automatically once/);
    expect(resumeNoteFor(undefined, 2)).toMatch(/2 times/);
    expect(resumeNoteFor(undefined, 0)).toBeNull();
    expect(resumeNoteFor(undefined, null)).toBeNull();
    expect(resumeNoteFor(undefined, undefined)).toBeNull();
  });

  // Silence is the failure mode on the other branch too: a rail that
  // stalled for a reason nobody stated looks like one gavin forgot.
  it("says why it did NOT resume, in the same voice", () => {
    expect(resumeSkippedBody("ship the thing", "gavin already resumed this run once")).toBe(
      "ship the thing stopped and was not resumed — gavin already resumed this run once"
    );
  });
});
