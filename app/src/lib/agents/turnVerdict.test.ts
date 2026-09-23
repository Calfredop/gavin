import { describe, it, expect } from "vitest";
import {
  ACTIVE_NOUL_VETO,
  CAUSE_MIN_CONFIDENCE,
  SCREEN_TAIL_ROWS,
  TYPESAFE_MODEL,
  VERDICT_MIN_CONFIDENCE,
  VERDICT_QUESTIONS,
  agentLastLine,
  blockedStepReason,
  parseVerdictAnswers,
  readTurn,
  refineCause,
  screenTail,
  verdictCompletesTurn,
  verdictIsAsking,
  verdictRequest,
  verdictStallReason,
  type TurnReading,
  type VerdictAnswers,
} from "$lib/agents/turnVerdict";

// A response body in TypeSafe's own shape, so every test below goes
// through the real parser rather than hand-building the normalised
// struct. The defaults are a confident, unremarkable finished turn;
// each test overrides only the answers it is about.
function body(over: {
  verdict?: string;
  verdictConfidence?: number;
  cause?: string;
  causeConfidence?: number;
  nAsks?: number;
  nBroke?: number;
  nActive?: number;
  nDone?: number;
  nOptionalOffer?: number;
} = {}) {
  return {
    model: TYPESAFE_MODEL,
    answers: {
      verdict: {
        type: "choice",
        choice: over.verdict ?? "finished",
        probabilities: {},
        confidence: over.verdictConfidence ?? 0.95,
      },
      cause: {
        type: "choice",
        choice: over.cause ?? "none",
        probabilities: {},
        confidence: over.causeConfidence ?? 0.95,
      },
      n_asks: { type: "noul", noul: over.nAsks ?? 0.02 },
      n_broke: { type: "noul", noul: over.nBroke ?? 0.01 },
      n_active: { type: "noul", noul: over.nActive ?? 0.02 },
      n_done: { type: "noul", noul: over.nDone ?? 0.97 },
      n_optional_offer: { type: "noul", noul: over.nOptionalOffer ?? 0.05 },
    },
    usage: { input_tokens: 1612, output_tokens: 24 },
  };
}

function read(over: Parameters<typeof body>[0] = {}, screen = "") {
  return readTurn(parseVerdictAnswers(body(over)), screen);
}

// Claude Code's chrome around an agent message, which is what the
// daemon's rendered tail actually looks like.
function claudeScreen(...message: string[]): string {
  return [
    ...message.map((l) => (l === "" ? "" : `⏺ ${l}`)),
    "",
    "╭───────────────╮",
    "│ >                          │",
    "╰───────────────╯",
    "  ? for shortcuts",
  ].join("\n");
}

describe("verdictRequest", () => {
  it("pins the measured model rather than jev-latest", () => {
    // The thresholds in this module were all fitted against this exact
    // model; floating it would move the boundary under them.
    expect(verdictRequest("claude-code", "hello").model).toBe("jev-1.13.0");
    expect(TYPESAFE_MODEL).toBe("jev-1.13.0");
  });

  it("carries the agent's profile id and the screen as named state fields", () => {
    const req = verdictRequest("codex", "one\ntwo");
    expect(req.state).toEqual({ agent_cli: "codex", screen: "one\ntwo" });
  });

  it("asks all seven questions in one request", () => {
    // One request, not seven: they are independent judgements over the
    // same state, so TypeSafe runs them in parallel and the 2s budget
    // buys one round trip rather than seven.
    expect(Object.keys(verdictRequest("claude-code", "x").questions).sort()).toEqual([
      "cause",
      "n_active",
      "n_asks",
      "n_broke",
      "n_done",
      "n_optional_offer",
      "verdict",
    ]);
  });

  it("keeps the v2 wording that separates a closing offer from a question", () => {
    // v1 had neither of these and read "say the word and I'll commit" as
    // a question on 11 of 44 real finished turns. They are the whole
    // difference between v1 and v2, so they are pinned rather than
    // trusted to survive a copy-edit.
    expect(VERDICT_QUESTIONS.verdict.criteria.finished.still_finished_when[0]).toContain(
      "say the word and I'll commit"
    );
    expect(VERDICT_QUESTIONS.verdict.criteria.asking.not_asking).toBe(
      "An offer of optional extra work after the task is already done is finished, not asking."
    );
  });
});

describe("screenTail", () => {
  it("drops the blank rows the grid pads itself out to", () => {
    // contents() renders the whole visible grid, so a six-line turn in a
    // fifty-row terminal comes back with forty-four empty rows after it.
    // A naive tail of that is blank.
    const padded = ["All three tests pass.", ...Array(44).fill("")].join("\n");
    expect(screenTail(padded)).toBe("All three tests pass.");
  });

  it("keeps the LAST rows when the screen is longer than the tail", () => {
    const long = Array.from({ length: 80 }, (_, i) => `line ${i}`).join("\n");
    const tail = screenTail(long).split("\n");
    expect(tail).toHaveLength(SCREEN_TAIL_ROWS);
    expect(tail[tail.length - 1]).toBe("line 79");
    expect(tail[0]).toBe("line 40");
  });

  it("right-trims rows, because a vt100 grid pads them to the full width", () => {
    expect(screenTail("done.        \n")).toBe("done.");
  });
});

describe("parseVerdictAnswers", () => {
  it("reads a well-formed response", () => {
    const parsed = parseVerdictAnswers(body({ verdict: "asking", nAsks: 0.93 }));
    expect(parsed?.verdict).toBe("asking");
    expect(parsed?.verdictConfidence).toBe(0.95);
    expect(parsed?.nAsks).toBe(0.93);
  });

  it("keeps the nouls no rule reads, so a threshold can be re-derived later", () => {
    const parsed = parseVerdictAnswers(body({ nDone: 0.88, nOptionalOffer: 0.91 }));
    expect(parsed?.nDone).toBe(0.88);
    expect(parsed?.nOptionalOffer).toBe(0.91);
  });

  it("refuses a verdict option this build does not know", () => {
    // parseSessionStatus's principle: an unrecognised value must never
    // fall into a branch that acts. Null here means today's answer.
    expect(parseVerdictAnswers(body({ verdict: "stalled" }))).toBeNull();
  });

  it("refuses a response missing a question's answer", () => {
    const partial = body();
    delete (partial.answers as Record<string, unknown>).n_active;
    expect(parseVerdictAnswers(partial)).toBeNull();
  });

  it("refuses a body that is not a response at all", () => {
    expect(parseVerdictAnswers(null)).toBeNull();
    expect(parseVerdictAnswers("upstream connect error")).toBeNull();
    expect(parseVerdictAnswers({ error: { message: "invalid api key" } })).toBeNull();
  });
});

describe("readTurn: the policy", () => {
  it("returns no opinion when there are no answers at all", () => {
    // An error, a timeout, a missing key and an unparseable body all
    // arrive here as null, and all mean the same thing: today's answer.
    expect(readTurn(null, "")).toBeNull();
  });

  it("an offer after finished work stays finished", () => {
    // The v1 regression, and the one this feature must not reintroduce:
    // a rail that stops for an offer of optional extra work is a rail
    // that stops for nothing. Note n_asks and n_optional_offer are both
    // high -- the policy deliberately does not second-guess the choice
    // with the nouls.
    const screen = claudeScreen(
      "All three suites pass and the branch is clean.",
      "",
      "Want me to commit it and open the PR? Say the word."
    );
    const reading = read(
      { verdict: "finished", verdictConfidence: 0.88, nAsks: 0.44, nOptionalOffer: 0.96 },
      screen
    );
    expect(reading).toEqual({ kind: "finished" });
    expect(verdictCompletesTurn({ state: "read", reading })).toBe(true);
    expect(verdictIsAsking({ state: "read", reading })).toBe(false);
  });

  it("a retry countdown under an error line stays working", () => {
    // The spec's second known miss: the verdict reads `failed` at low
    // confidence while the screen is still counting down. The n_active
    // veto runs BEFORE the confidence floor precisely so this never
    // reaches the mapping -- and an agent that is still retrying must
    // not stall its rail.
    const screen = claudeScreen(
      "API Error: Connection error.",
      "Retrying in 39s · attempt 8/10"
    );
    const reading = read(
      {
        verdict: "failed",
        verdictConfidence: 0.62,
        cause: "network",
        causeConfidence: 0.94,
        nActive: 0.91,
        nBroke: 0.78,
      },
      screen
    );
    expect(reading).toEqual({ kind: "working" });
    // Still working means the step must not complete, and it is not a
    // failure the cause table should be asked about either.
    expect(verdictCompletesTurn({ state: "read", reading })).toBe(false);
    expect(refineCause("unknown", { state: "read", reading })).toBe("unknown");
  });

  it("the veto fires exactly at the threshold, not just above it", () => {
    expect(read({ verdict: "finished", nActive: ACTIVE_NOUL_VETO })).toEqual({ kind: "working" });
    expect(read({ verdict: "finished", nActive: ACTIVE_NOUL_VETO - 0.01 })).toEqual({
      kind: "finished",
    });
  });

  it("low confidence returns today's answer", () => {
    // Not "the second-most-likely verdict": below the floor gavin does
    // not act on the model at all.
    expect(read({ verdict: "asking", verdictConfidence: VERDICT_MIN_CONFIDENCE - 0.01 })).toBeNull();
    expect(read({ verdict: "asking", verdictConfidence: VERDICT_MIN_CONFIDENCE })).toEqual({
      kind: "asking",
    });
  });

  it("catches a prose question, which today's rule cannot see at all", () => {
    // 0 of 16 on the real set today. No bell, no menu -- just a sentence.
    const screen = claudeScreen(
      "There are two ways to do this. I can widen the existing request,",
      "or add a new one and gate it.",
      "",
      "Which do you want before I write the migration?"
    );
    const reading = read({ verdict: "asking", verdictConfidence: 0.93, nAsks: 0.97 }, screen);
    expect(verdictIsAsking({ state: "read", reading })).toBe(true);
    expect(verdictCompletesTurn({ state: "read", reading })).toBe(false);
  });

  it("a blocked turn carries the agent's own last line", () => {
    const screen = claudeScreen(
      "I cannot run the suite: node_modules is missing and the install is",
      "blocked by the sandbox."
    );
    const reading = read({ verdict: "blocked", verdictConfidence: 0.91 }, screen);
    expect(reading).toEqual({ kind: "blocked", said: "blocked by the sandbox." });
  });

  it("a failed turn carries the agent's own last line too, for the same reason", () => {
    // The daemon's own failures reach the human as `failureBody`, whose
    // whole value is the quoted sentence -- a dead network and an
    // expired token want opposite responses. A failure the VERDICT read
    // off the screen has no daemon reason to quote, because the daemon
    // called this turn `idle`. The screen's own last line is the only
    // sentence there is, and it is already being read for `blocked`.
    const screen = claudeScreen("API Error: Connection reset by peer.");
    const reading = read(
      { verdict: "failed", verdictConfidence: 0.94, cause: "network", causeConfidence: 0.95 },
      screen
    );
    expect(reading).toEqual({
      kind: "failed",
      cause: "network",
      said: "API Error: Connection reset by peer.",
    });
  });
});

describe("readTurn: the cause gate", () => {
  it("names a confident cause", () => {
    const reading = read({
      verdict: "failed",
      verdictConfidence: 0.96,
      cause: "usage-limit",
      causeConfidence: 0.95,
      nBroke: 0.98,
    });
    expect(reading).toEqual({ kind: "failed", cause: "usage-limit", said: "" });
  });

  it("a low-confidence cause IS unknown, so it can never drive a resume", () => {
    // The verdict is over its own floor -- this really was a failure --
    // but the cause is not sure enough for something that fires while
    // nobody is watching. `unknown` is what autoResumePolicy answers
    // `never` to, so the existing guarantee covers this with no second
    // rule in autoResume.ts.
    const reading = read({
      verdict: "failed",
      verdictConfidence: 0.9,
      cause: "network",
      causeConfidence: CAUSE_MIN_CONFIDENCE - 0.01,
    });
    expect(reading).toEqual({ kind: "failed", cause: "unknown", said: "" });
  });

  it("uses a cause exactly at the resume threshold", () => {
    const reading = read({
      verdict: "failed",
      verdictConfidence: 0.9,
      cause: "network",
      causeConfidence: CAUSE_MIN_CONFIDENCE,
    });
    expect(reading).toEqual({ kind: "failed", cause: "network", said: "" });
  });

  it("reads `none` as unknown rather than inventing one", () => {
    const reading = read({
      verdict: "failed",
      verdictConfidence: 0.8,
      cause: "none",
      causeConfidence: 0.99,
    });
    expect(reading).toEqual({ kind: "failed", cause: "unknown", said: "" });
  });
});

describe("refineCause", () => {
  const failed = { kind: "failed", cause: "auth", said: "" } as const;

  it("leaves a cause the profile's own table matched", () => {
    // The table is ordered, measured and local. Overriding a match with
    // a remote judgement would make gavin depend on the network for a
    // case it already gets right.
    expect(refineCause("outage", failed)).toBe("outage");
    expect(refineCause("suspend", failed)).toBe("suspend");
  });

  it("fills the hole the table left", () => {
    // Every failure of codex, gemini, cursor, opencode and custom, which
    // have no table at all, arrives here as `unknown`.
    expect(refineCause("unknown", failed)).toBe("auth");
  });

  it("leaves unknown alone when there is no verdict, or it is not a failure", () => {
    expect(refineCause("unknown", null)).toBe("unknown");
    expect(refineCause("unknown", { kind: "asking" })).toBe("unknown");
    expect(refineCause("unknown", { kind: "finished" })).toBe("unknown");
  });
});

describe("verdictCompletesTurn", () => {
  const read = (reading: TurnReading | null) => ({ state: "read", reading }) as const;

  it("leaves today's answer alone when no verdict was asked for", () => {
    // The equivalence the whole design rests on: no entry, a failed
    // request and a low-confidence answer behave identically, so turning
    // the feature on cannot make a verdict worse -- and a broken key
    // cannot wedge a rail.
    expect(verdictCompletesTurn(undefined)).toBe(true);
    expect(verdictCompletesTurn(null)).toBe(true);
    expect(verdictCompletesTurn(read(null))).toBe(true);
  });

  it("holds the step while the verdict is still in flight", () => {
    // "Waits for the verdict (or its timeout)". Without this the request
    // and the rail's next step race, and the rail wins every time: the
    // answer lands on a step that has already completed.
    expect(verdictCompletesTurn({ state: "pending" })).toBe(false);
  });

  it("takes back the completion on every reading that is not finished", () => {
    expect(verdictCompletesTurn(read({ kind: "finished" }))).toBe(true);
    expect(verdictCompletesTurn(read({ kind: "asking" }))).toBe(false);
    expect(verdictCompletesTurn(read({ kind: "blocked", said: "no" }))).toBe(false);
    expect(verdictCompletesTurn(read({ kind: "failed", cause: "network", said: "" }))).toBe(false);
    expect(verdictCompletesTurn(read({ kind: "working" }))).toBe(false);
  });
});

describe("verdictIsAsking and verdictStallReason", () => {
  it("never speaks while the verdict is pending", () => {
    // The two surfaces a HUMAN is looking at. An unfinished request must
    // not put a row in the inbox or refuse a follow-up -- both stay on
    // today's answer until there is a real one.
    expect(verdictIsAsking({ state: "pending" })).toBe(false);
    expect(verdictStallReason({ state: "pending" })).toBeNull();
  });

  it("stalls a blocked turn with the agent's own words, and nothing else", () => {
    expect(verdictStallReason({ state: "read", reading: { kind: "blocked", said: "no disk" } })).toBe(
      "the agent stopped without finishing — no disk"
    );
    // `asking` is a WAIT, not a fault: the rail is right to hold and the
    // human is right to be told, which StepAttention already does.
    // Stalling would persist a verdict the next keystroke makes wrong.
    expect(verdictStallReason({ state: "read", reading: { kind: "asking" } })).toBeNull();
    expect(verdictStallReason({ state: "read", reading: { kind: "finished" } })).toBeNull();
    expect(verdictStallReason(null)).toBeNull();
  });
});

describe("agentLastLine", () => {
  it("skips the input box and takes the sentence above it", () => {
    expect(agentLastLine(claudeScreen("The build is red on main."))).toBe(
      "The build is red on main."
    );
  });

  it("strips the glyph the TUI painted in front of the line", () => {
    // server.rs's strip_tui_decoration rule: everything from the first
    // alphanumeric character on.
    expect(agentLastLine("⏺  Nothing left to do.")).toBe("Nothing left to do.");
    expect(agentLastLine("✻ Thinking about it… done.")).toBe("Thinking about it… done.");
  });

  it("returns empty when the tail holds no prose at all", () => {
    expect(agentLastLine("\n╭──╮\n│ > │\n╰──╯\n")).toBe("");
    expect(agentLastLine("")).toBe("");
  });
});

describe("blockedStepReason", () => {
  it("quotes the agent", () => {
    expect(blockedStepReason("the migration file is missing")).toBe(
      "the agent stopped without finishing — the migration file is missing"
    );
  });

  it("says so rather than quoting nothing", () => {
    expect(blockedStepReason("  ")).toBe(
      "the agent stopped without finishing, and gavin could not read its reason off the screen"
    );
  });
});
