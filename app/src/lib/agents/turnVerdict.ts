// A SECOND OPINION on what an agent's quiet turn came to.
//
// Today gavin decides "the turn ended" from two seconds of silence plus
// one substring, and the substring exists for exactly one profile
// (`API Error:`, claude-code). Measured on this repository's own
// transcripts, that rule caught 0 of 16 turns where the agent had asked
// the human a question in PROSE -- no bell, no menu, just a sentence
// ending in a question mark -- and every broken turn of codex, gemini,
// cursor, opencode and custom, which have no failure patterns at all,
// reads as a finished one. The consequences are not cosmetic: a rail's
// agent step completes on the question and walks past it, and the
// follow-up queue files the human's next message as the answer to a
// question it never read.
//
// So one TypeSafe request over the rendered screen tail, at the moment
// a session would otherwise be called idle. The method, the numbers and
// the exact question set are in
// `docs/superpowers/specs/2026-09-21-typesafe-turn-verdict-experiment.md`;
// what matters here is the shape of the contract, and it has three parts
// that every function below is built to keep:
//
//  - **A second opinion, never a replacement.** The daemon's status and
//    its `failure_verdict` are untouched. All anything here can do is
//    REFINE what gavin already concluded, which is why the policy
//    function's "no answer" value is `null` and not a verdict: an error,
//    a timeout, a missing key, a confidence below the floor and a
//    response this build cannot parse all come out as null, and null
//    means "use today's answer". Turning the feature on can make a
//    verdict better or leave it alone. It cannot make one worse.
//
//  - **Policy in code, raw judgments kept.** The thresholds below are
//    measured numbers, not taste, and they live here as named constants
//    so that re-measuring them is an edit to one line. The model's raw
//    answers are carried through on `VerdictAnswers` even where no rule
//    reads them -- `n_done` and `n_optional_offer` drive nothing today --
//    because a threshold nobody can re-derive from stored judgments is a
//    threshold nobody can ever move.
//
//  - **The questions are frozen.** `VERDICT_QUESTIONS` is the v2 set
//    from the experiment record, verbatim, and `TYPESAFE_MODEL` pins
//    `jev-1.13.0` rather than `jev-latest`. Every number in the spec was
//    measured against that pair. Re-wording a criterion or floating the
//    model silently invalidates the thresholds while leaving the code
//    looking exactly as correct as it did before.
//
// Pure. The request never leaves here -- the Tauri host command
// (`app/src-tauri/src/typesafe.rs`) carries it, because the API key must
// never reach the frontend -- and no store is read, so every judgement
// below is arguable in a test rather than observable only on a laptop.

import type { FailureCause } from "$lib/agents/autoResume";

/// The model the thresholds were measured on. PINNED, and the pin is the
/// point: `jev-latest` would move the decision boundary under a policy
/// whose every number was fitted to this one.
export const TYPESAFE_MODEL = "jev-1.13.0";

/// TypeSafe's System One endpoint. Here rather than in the Rust host so
/// that the thing being POSTed and the address it goes to are readable
/// in one file; `typesafe.rs` takes the URL from the request it is
/// handed.
export const TYPESAFE_URL = "https://api.typesafe.ai/v1/systemone";

/// How much of the screen goes with the request.
///
/// Forty rows is the tail the experiment measured on, and both bounds
/// are real. Fewer loses the error banner that a retry countdown has
/// already scrolled up; more starts feeding the model the PREVIOUS
/// turn, which is exactly what the daemon's `SessionScreen::contents`
/// refuses to include scrollback for -- a verdict is about the turn that
/// just ended, and history is what must not condemn it.
export const SCREEN_TAIL_ROWS = 40;

/// The `n_active` veto. At or above this the screen still shows the
/// agent moving -- a spinner, a timer, a retry countdown -- and no
/// verdict about the turn is taken at all.
///
/// It runs BEFORE the confidence floor, and that ordering is the whole
/// reason it exists as a separate rule. The spec's second known miss is
/// a retry countdown under an error line reading as `failed` at low
/// confidence; the veto catches it on a signal that does not depend on
/// the verdict being confident about anything.
export const ACTIVE_NOUL_VETO = 0.7;

/// Below this the verdict is not acted on at all: today's answer stands.
///
/// 0.75 was frozen on the synthetic dev split before the test split ran.
/// Under this policy the model never produced a verdict WORSE than
/// today's on the measured set: both remaining misses were low-confidence
/// cases that fell through to today's (equally wrong) answer.
export const VERDICT_MIN_CONFIDENCE = 0.75;

/// Below this a cause is `unknown`, in the full sense `autoResume.ts`
/// gives that word -- including "never resumes".
///
/// Higher than the verdict floor on purpose. A verdict at 0.8 changes
/// what a human is TOLD; a cause changes what gavin does while nobody is
/// watching, because the trigger table turns a cause into an unattended
/// relaunch. The card's rule is the one this encodes: a low-confidence
/// cause IS unknown, and unknown never resumes.
export const CAUSE_MIN_CONFIDENCE = 0.9;

/// What the agent's turn came to. The `verdict` question's options, and
/// the vocabulary the rest of the app is mapped onto.
export type TurnVerdict = "finished" | "asking" | "blocked" | "failed" | "working";

/// The `cause` question's options. Note `none`, which is not a gap in
/// the list but an answer: the turn was not cut off from outside. Every
/// other value is `FailureCause` spelled identically, deliberately --
/// see `causeFrom`.
export type VerdictCause =
  | "suspend"
  | "network"
  | "outage"
  | "usage-limit"
  | "auth"
  | "crashed"
  | "none";

const TURN_VERDICTS: readonly string[] = ["finished", "asking", "blocked", "failed", "working"];
const VERDICT_CAUSES: readonly string[] = [
  "suspend",
  "network",
  "outage",
  "usage-limit",
  "auth",
  "crashed",
  "none",
];

/// The v2 question set from the experiment record, VERBATIM.
///
/// Every sentence here was worded, then measured, then frozen. Two of
/// them carry the whole difference between v1 and v2 and are the ones
/// most likely to look like they could be tightened: `finished`'s
/// `still_finished_when` list and `asking`'s `not_asking` line. v1 had
/// neither and read a closing offer ("say the word and I'll commit") as
/// a question on 11 of 44 real finished turns; with them, 3. A rail that
/// stops for an offer of optional extra work is a rail that stops for
/// nothing, which is the failure mode this feature would otherwise
/// introduce while fixing another.
///
/// `screen` and `agent_cli` are named in every instruction because the
/// question ids are NOT sent to the model -- each question has to carry
/// its own complete meaning.
export const VERDICT_QUESTIONS = {
  verdict: {
    type: "choice",
    instructions:
      "`screen` is the bottom of a terminal running the `agent_cli` AI coding agent, captured at the moment its output went quiet. What has the agent's current turn come to?",
    criteria: {
      finished: {
        meaning: "The agent completed the task it was working on and reported the result.",
        still_finished_when: [
          "the message ends by offering optional extra work: 'want me to also...', 'say the word and I'll commit', 'I can file this as a card'",
          "the agent leaves a manual check, a commit, a push or a merge for the human to do whenever they like",
          "the agent gives notes, caveats or recommendations after reporting the result",
        ],
      },
      asking: {
        meaning:
          "The agent stopped before its task is done and cannot continue until the human answers.",
        examples: [
          "a permission or approval menu on screen",
          "a choice between options the task depends on ('which approach?', 'should I delete it or keep it?')",
          "a design, spec or plan presented for approval before the agent writes the next part ('does that look right?', 'review it before I write the plan')",
          "a request for the human to do something and report back before the agent can go on",
        ],
        not_asking:
          "An offer of optional extra work after the task is already done is finished, not asking.",
      },
      blocked:
        "The agent ended its turn itself without completing the task, and explains in its own words what stopped it (a missing file, a failing build, a denied write, a rule it must follow). It asks the human nothing.",
      failed:
        "The agent's turn was cut off by an error from outside the agent: its own API connection dropping, an API error, an overloaded service, a usage or quota limit, an expired login, or the agent process crashing. The agent never got to report on the task.",
      working:
        "The agent has not stopped: a spinner, a running command, a 'Working' timer or a retry countdown shows it is still active.",
    },
  },
  cause: {
    type: "choice",
    instructions:
      "`screen` is the bottom of a terminal running the `agent_cli` AI coding agent, captured at the moment its output went quiet. If the agent's turn was cut off by an error from outside the agent, what kind of error is shown?",
    criteria: {
      suspend: "The computer went to sleep during the response.",
      network:
        "The connection to the agent's API failed: dropped, reset, refused, DNS failure, stream disconnected, or an empty or malformed response.",
      outage:
        "The API answered with a server-side failure: overloaded, 500/502/503/529, service unavailable.",
      "usage-limit":
        "The account ran out of budget: usage limit, quota exhausted, rate limit reached, or a message saying when the limit resets.",
      auth: "The agent needs a login or credentials: expired token, invalid API key, 401 Unauthorized, or an instruction to log in again.",
      crashed:
        "The agent process itself died: a fatal error, out of memory, an uncaught exception or stack trace, or the terminal is back at a shell prompt.",
      none: "No error from outside the agent cut the turn off.",
    },
  },
  n_asks: {
    type: "noul",
    instructions:
      "`screen` is the bottom of a terminal running the `agent_cli` AI coding agent, captured at the moment its output went quiet. Is the agent waiting for the human to answer a question, pick an option, or approve an action before it continues?",
  },
  n_broke: {
    type: "noul",
    instructions:
      "`screen` is the bottom of a terminal running the `agent_cli` AI coding agent, captured at the moment its output went quiet. Was the agent's turn cut off by an error from outside the agent (its API connection, an API error, an overload, a usage limit, an expired login, or a crash) rather than ended by the agent itself?",
  },
  n_active: {
    type: "noul",
    instructions:
      "`screen` is the bottom of a terminal running the `agent_cli` AI coding agent, captured at the moment its output went quiet. Does the screen show the agent is still active, such as a spinner, a running timer, or a retry countdown?",
  },
  n_done: {
    type: "noul",
    instructions:
      "`screen` is the bottom of a terminal running the `agent_cli` AI coding agent, captured at the moment its output went quiet. Did the agent report that it completed the task it was working on?",
  },
  n_optional_offer: {
    type: "noul",
    instructions:
      "`screen` is the bottom of a terminal running the `agent_cli` AI coding agent, captured at the moment its output went quiet. The agent's last message may end with a question or an offer. Is the task it was given already done, so that any closing question or offer is only about OPTIONAL extra work the human is free to ignore?",
  },
} as const;

/// The body of the one request, exactly as it goes on the wire.
export interface VerdictRequest {
  model: string;
  state: { agent_cli: string; screen: string };
  questions: typeof VERDICT_QUESTIONS;
}

/// One request, seven questions.
///
/// All seven ride together because they are independent judgements over
/// the SAME state: TypeSafe answers them in parallel and none can see
/// another's answer, so splitting them would buy nothing and cost seven
/// round trips against a 2s budget. Measured at ~1.4-1.8k input tokens,
/// ~0.7s p50, about $0.00007.
export function verdictRequest(agentCli: string, screen: string): VerdictRequest {
  return {
    model: TYPESAFE_MODEL,
    state: { agent_cli: agentCli, screen: screenTail(screen) },
    questions: VERDICT_QUESTIONS,
  };
}

/// The last `rows` rows of a rendered screen, with the blank rows the
/// grid pads itself out to dropped first.
///
/// The drop matters more than the cut. `SessionScreen::contents()`
/// renders every row of the visible grid, and an agent that has just
/// printed six lines into a fifty-row terminal returns forty-four empty
/// ones -- so a naive tail is blank, and the model is asked to judge a
/// turn it was shown nothing of.
export function screenTail(contents: string, rows: number = SCREEN_TAIL_ROWS): string {
  const lines = contents.split("\n").map((l) => l.replace(/\s+$/, ""));
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.slice(Math.max(0, lines.length - rows)).join("\n");
}

/// Everything the model answered, normalised. Kept whole even where no
/// rule below reads it -- see the header's second contract.
export interface VerdictAnswers {
  verdict: TurnVerdict;
  /// The `verdict` Choice's own confidence: how concentrated its
  /// distribution is, NOT a claim about the workflow being right.
  verdictConfidence: number;
  cause: VerdictCause;
  causeConfidence: number;
  nAsks: number;
  nBroke: number;
  nActive: number;
  nDone: number;
  nOptionalOffer: number;
}

function choiceOf(
  answers: Record<string, unknown>,
  id: string,
  allowed: readonly string[]
): { choice: string; confidence: number } | null {
  const a = answers[id];
  if (!a || typeof a !== "object") return null;
  const rec = a as Record<string, unknown>;
  const choice = rec.choice;
  const confidence = rec.confidence;
  if (typeof choice !== "string" || !allowed.includes(choice)) return null;
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) return null;
  return { choice, confidence };
}

function noulOf(answers: Record<string, unknown>, id: string): number | null {
  const a = answers[id];
  if (!a || typeof a !== "object") return null;
  const n = (a as Record<string, unknown>).noul;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/// The response, or null if it is not one this build can read.
///
/// Every field is required and every unrecognised option value is a
/// refusal, on `parseSessionStatus`'s principle: a value this build does
/// not understand must never fall into a branch that acts. Null here is
/// the same null the policy returns -- today's answer -- so a TypeSafe
/// deployment that adds a verdict option degrades to the behaviour gavin
/// had before any of this existed, rather than to a guess.
export function parseVerdictAnswers(body: unknown): VerdictAnswers | null {
  if (!body || typeof body !== "object") return null;
  const answers = (body as Record<string, unknown>).answers;
  if (!answers || typeof answers !== "object") return null;
  const rec = answers as Record<string, unknown>;

  const verdict = choiceOf(rec, "verdict", TURN_VERDICTS);
  const cause = choiceOf(rec, "cause", VERDICT_CAUSES);
  if (!verdict || !cause) return null;

  const nAsks = noulOf(rec, "n_asks");
  const nBroke = noulOf(rec, "n_broke");
  const nActive = noulOf(rec, "n_active");
  const nDone = noulOf(rec, "n_done");
  const nOptionalOffer = noulOf(rec, "n_optional_offer");
  if (
    nAsks === null ||
    nBroke === null ||
    nActive === null ||
    nDone === null ||
    nOptionalOffer === null
  ) {
    return null;
  }

  return {
    verdict: verdict.choice as TurnVerdict,
    verdictConfidence: verdict.confidence,
    cause: cause.choice as VerdictCause,
    causeConfidence: cause.confidence,
    nAsks,
    nBroke,
    nActive,
    nDone,
    nOptionalOffer,
  };
}

/// What the app should do differently, in the app's own vocabulary.
///
/// Five readings, and each one names the surface it changes:
///
/// - `finished` -- agrees with today. Worth returning rather than
///   collapsing into null, because "the model looked and agreed" and
///   "the model never answered" are different things to put in a log.
/// - `working` -- the turn is not over. An agent tool step must not
///   complete (`agentTurnEnded`), which is the one reading that stops a
///   rail walking past an agent mid-retry.
/// - `asking` -- a question with no bell behind it. `StepAttention`
///   `asking`, an attention-inbox row, and a follow-up the compose box
///   refuses to file as its answer.
/// - `blocked` -- the agent gave up and said why. A stall carrying its
///   own sentence, because that sentence is the part a human acts on.
/// - `failed` -- cut off from outside. `cause` is already through the
///   confidence gate: it is `unknown` unless the model was sure enough
///   for an unattended relaunch to hang off it.
export type TurnReading =
  | { kind: "finished" }
  | { kind: "working" }
  | { kind: "asking" }
  | { kind: "blocked"; said: string }
  /// `said` for the same reason `blocked` carries one, and it is worth
  /// stating because the daemon's own failures do not need it: those
  /// arrive with the agent's sentence attached (`failureReasonById`),
  /// and every surface that reports one quotes it. A failure the
  /// VERDICT read off the screen has no such sentence -- the daemon
  /// called this turn `idle` and cleared the reason with it -- so the
  /// screen's own last line is the only thing there is to quote, and
  /// `failureBody` is useless without it.
  | { kind: "failed"; cause: FailureCause; said: string };

/// The `cause` question's answer as a `FailureCause`, through the
/// confidence gate.
///
/// `none` and anything under `CAUSE_MIN_CONFIDENCE` become `unknown`,
/// which `autoResumePolicy` answers with `never`. That is the card's
/// rule stated once, in the one place it can be enforced: a
/// low-confidence cause IS unknown, so the existing "unknown never
/// resumes" guarantee covers this feature without a second rule anywhere
/// in autoResume.ts.
///
/// Every other option is spelled exactly as `FailureCause` spells it,
/// which is not a coincidence -- the question set was worded against
/// gavin's existing vocabulary so that this mapping is an identity and
/// cannot drift into a translation table nobody maintains.
function causeFrom(answers: VerdictAnswers): FailureCause {
  if (answers.cause === "none") return "unknown";
  if (answers.causeConfidence < CAUSE_MIN_CONFIDENCE) return "unknown";
  return answers.cause;
}

/// The policy. Four rules, in this order, and the order is load-bearing.
///
/// Null means "no opinion": use today's answer, unchanged. Callers must
/// treat null and a failed request identically -- that equivalence is
/// what makes the feature unable to regress a verdict.
export function readTurn(answers: VerdictAnswers | null, screen: string): TurnReading | null {
  if (!answers) return null;
  // 1. The veto, before anything reads a confidence. A screen that still
  //    shows the agent moving is not a turn that ended, however sure the
  //    model is about what it would have come to.
  if (answers.nActive >= ACTIVE_NOUL_VETO) return { kind: "working" };
  // 2. The floor. Deliberately not a shrug about which verdict is
  //    second-most-likely: below it gavin does not act on the model at
  //    all.
  if (answers.verdictConfidence < VERDICT_MIN_CONFIDENCE) return null;
  // 3. The mapping.
  switch (answers.verdict) {
    case "working":
      return { kind: "working" };
    case "finished":
      return { kind: "finished" };
    case "asking":
      return { kind: "asking" };
    case "blocked":
      return { kind: "blocked", said: agentLastLine(screen) };
    case "failed":
      // 4. The cause, through its own higher gate (`causeFrom`).
      return { kind: "failed", cause: causeFrom(answers), said: agentLastLine(screen) };
  }
}

/// The composer: the line holding the agent's input caret, optionally
/// inside its box's left edge.
///
/// Recognising it is what makes `agentLastLine` work at all, because
/// every one of these TUIs prints a FOOTER under the box -- "? for
/// shortcuts", "esc to interrupt", a context percentage. Those lines are
/// the last prose-shaped rows on screen and none of them is the agent
/// speaking, so a search that merely runs up from the bottom quotes the
/// keyboard hint back at the human as the reason their step stalled.
const COMPOSER_LINE = /^[│|]?\s*[>❯](\s|$)/;

/// Whether a line is the agent's prose rather than its TUI's furniture.
function isChrome(line: string): boolean {
  const t = line.trim();
  if (t === "") return true;
  // A row with no letter or digit anywhere in it is a rule, a border or
  // a spinner frame, never a sentence.
  if (!/[\p{L}\p{N}]/u.test(t)) return true;
  if (COMPOSER_LINE.test(t)) return true;
  return false;
}

/// The agent's own last sentence on this screen, stripped of the glyph
/// its TUI painted in front of it.
///
/// Searched UPWARD FROM THE COMPOSER rather than from the bottom of the
/// screen -- see `COMPOSER_LINE`. Below the box is the TUI's own footer;
/// above it is the conversation, and the last thing the agent said is the
/// last prose row up there.
///
/// The stripping is the rule the daemon applies to a matched failure line
/// (`server.rs`'s `strip_tui_decoration`): everything from the first
/// alphanumeric character on. Claude Code prefixes its lines with
/// `⏺ ` and `✻ `, codex and gemini with their own marks, and a
/// reason that opens with a bullet reads as a rendering artefact in every
/// surface that shows it.
///
/// Empty when the tail holds no prose at all, and the caller must handle
/// that rather than showing an empty quotation -- `blockedStepReason`
/// does. A screen with a composer but nothing above it is empty rather
/// than falling back to the footer: "gavin could not read the reason" is
/// true, and "? for shortcuts" is not a reason.
export function agentLastLine(screen: string): string {
  const lines = screen.split("\n");
  let from = lines.length - 1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (COMPOSER_LINE.test(lines[i].trim())) {
      from = i - 1;
      break;
    }
  }
  for (let i = from; i >= 0; i--) {
    const line = lines[i];
    if (isChrome(line)) continue;
    const trimmed = line.trim();
    const m = trimmed.match(/[\p{L}\p{N}]/u);
    return trimmed.slice(m?.index ?? 0).trim();
  }
  return "";
}

/// The stall reason for a step whose agent gave UP.
///
/// A third sentence beside `failedStepReason` and
/// `INTERRUPTED_STEP_REASON`, for the third distinct fact. Nothing broke
/// and nothing was killed: the agent ended its own turn without doing the
/// work and said why, so the recovery is to read what it said and decide
/// -- not to resume, which would walk it into the same wall.
export function blockedStepReason(said: string): string {
  const trimmed = said.trim();
  return trimmed
    ? `the agent stopped without finishing — ${trimmed}`
    : "the agent stopped without finishing, and gavin could not read its reason off the screen";
}

/// Where one session's verdict has got to.
///
/// `pending` is the state that makes the card's "waits for the verdict
/// (or its timeout)" expressible at all. A pure function cannot wait, and
/// nothing here should: the DRIVER marks a session pending the instant it
/// goes quiet and resolves it when the answer or the 2s budget arrives,
/// and the consumers below read "pending" as "not yet" rather than as
/// "no". Without it, the request and the rail's next step would race, and
/// the rail would win every time -- the verdict would land on a step that
/// had already completed.
///
/// `read` with a null `reading` is the ordinary fallback: the request
/// failed, timed out, was refused, or came back under the confidence
/// floor. It says today's answer, which is what absence says too -- and
/// that equivalence is deliberate, because it is what stops a broken key
/// or a dead network from wedging every rail in the app.
export type TurnVerdictEntry = { state: "pending" } | { state: "read"; reading: TurnReading | null };

/// The reading an entry settled on, or null while it is pending or has
/// no opinion.
export function readingOf(entry: TurnVerdictEntry | null | undefined): TurnReading | null {
  return entry?.state === "read" ? entry.reading : null;
}

/// Consumer (2): what `classifyFailure` should have said.
///
/// The profile's table WINS wherever it matched. It is ordered, measured
/// and local, and overriding a matched pattern with a remote judgement
/// would make gavin's behaviour depend on a network call for a case it
/// already gets right -- exactly the "replacement" this design refuses to
/// be. The verdict only fills the hole: `unknown`, which is every failure
/// of every profile that has no table at all.
export function refineCause(
  today: FailureCause,
  entry: TurnVerdictEntry | TurnReading | null | undefined
): FailureCause {
  if (today !== "unknown") return today;
  const reading = entry && "state" in entry ? readingOf(entry) : (entry ?? null);
  return reading?.kind === "failed" ? reading.cause : today;
}

/// Consumer (1): whether an agent tool step may complete on this turn.
///
/// Today's answer is "yes, it went idle after working". Three readings
/// take that back -- `asking`, `blocked` and `failed` are turns that
/// ended with the work undone, and `working` is not an ending at all --
/// while `finished`, a null reading and no entry at all leave it exactly
/// as it was. A PENDING entry holds the step for the length of the
/// budget, which is the whole of "waits for the verdict".
export function verdictCompletesTurn(entry: TurnVerdictEntry | null | undefined): boolean {
  if (!entry) return true;
  if (entry.state === "pending") return false;
  return entry.reading === null || entry.reading.kind === "finished";
}

/// Consumer (3) and (4): whether this turn is a question with a human on
/// the other end.
///
/// One predicate for both surfaces on purpose. The attention inbox
/// listing a session as waiting and the compose box refusing to file a
/// follow-up as its answer are one fact asked twice, and the app has
/// exactly one word for it.
///
/// Pending is NOT asking. An unfinished request must never put a row in
/// front of somebody or refuse their follow-up -- the two surfaces a
/// human is looking at are the two that have to stay on today's answer
/// until there is a real one.
export function verdictIsAsking(entry: TurnVerdictEntry | null | undefined): boolean {
  return readingOf(entry)?.kind === "asking";
}

/// The stall a `blocked` or `failed` verdict turns a running step into,
/// or null when the turn needs no stall.
///
/// Null for `finished`, `working`, `asking` and every non-reading:
/// `asking` is a WAIT, not a fault -- the rail is right to hold and the
/// human is right to be told, which is what `StepAttention` `asking`
/// already does -- and stalling it would persist a verdict that the next
/// keystroke makes wrong.
export function verdictStallReason(entry: TurnVerdictEntry | null | undefined): string | null {
  const reading = readingOf(entry);
  if (reading?.kind === "blocked") return blockedStepReason(reading.said);
  return null;
}
