// What gavin may do about a broken agent WITHOUT being asked.
//
// The failure-detection work (v21) made a broken agent visible and gave
// the human one press to resume its conversation. This module is the
// unattended half: a rail started before the laptop closed should still
// be making progress when it opens again. Everything here is pure --
// the timers, the claims and the launches live in autoResumeState.ts --
// because every judgement below is one that has to be arguable in a
// test rather than observed on a laptop lid.
//
// Two rules run through all of it:
//
//  - The trigger is the REASON, not the failure. "Retry when something
//    broke" is the wrong feature: an expired token loops against a wall
//    and a usage limit is a wait for a clock, not for a network.
//  - Unknown never resumes. A cause this build cannot name gets today's
//    behaviour -- a stalled step, a notification and the human's button
//    -- which is not a regression, and is the only safe direction for a
//    default that fires while nobody is watching.

/// The gavin-authored opening of a suspend failure's reason
/// (`SLEPT_REASON_PREFIX`, `crates/daemon/src/server.rs`).
///
/// Every other reason is the AGENT's own sentence and is classified
/// against its profile's `failureCauses`. A suspend has no profile
/// behind it -- the daemon reached that verdict from its own clock, not
/// from anything on screen -- so gavin classifies its own sentence, and
/// the Rust test `the_slept_reason_keeps_the_prefix_the_app_classifies_on`
/// is what stops a copy-edit there from silently making every wake-up
/// failure unclassifiable.
export const SLEPT_REASON_PREFIX = "the machine slept for";

/// Why an agent stopped, as far as gavin can tell.
///
/// - `suspend` -- the machine slept through the conversation. The
///   sturdiest of the lot: it owes nothing to the agent's output.
/// - `network` -- the connection died. A Wi-Fi drop, a VPN flap, a reset
///   mid-stream.
/// - `outage` -- the API answered, badly: a 529, a run of overloads.
///   Externally caused and transient like `network`, but with nothing to
///   observe when it clears.
/// - `usage-limit` -- the account is out of budget until a reset.
/// - `auth` -- the agent wants a login.
/// - `crashed` -- the agent process died. Not a connection failure, and
///   nothing suggests a second run behaves differently.
/// - `unknown` -- nothing in the profile's table matched. Not an error
///   and not "probably a network blip": a cause gavin cannot name.
export type FailureCause =
  | "suspend"
  | "network"
  | "outage"
  | "usage-limit"
  | "auth"
  | "crashed"
  | "unknown";

/// One row of a profile's cause table (`agent_setup.rs`'s
/// `failure_causes`), in the order the profile listed them.
export interface FailureCausePattern {
  pattern: string;
  cause: string;
}

const KNOWN_CAUSES: readonly FailureCause[] = [
  "suspend",
  "network",
  "outage",
  "usage-limit",
  "auth",
  "crashed",
  "unknown",
];

/// What the daemon's failure reason MEANS.
///
/// The suspend prefix first, because it is gavin's own sentence and can
/// never be in a profile's table. Then the profile's rows in order, FIRST
/// MATCH WINS -- Claude Code's expired-token line carries the generic
/// `API Error:` marker as well as `/login`, so an unordered scan would
/// classify an auth failure as a network one and resume into a login
/// prompt. The ordering guarantee lives with the table, in
/// `agent_setup.rs`, and is pinned by a test there.
///
/// A cause string the profile invented that this build does not know
/// reads as `unknown` rather than being passed through, for the same
/// reason `parseSessionStatus` refuses to guess: an unrecognised value
/// must never fall into a branch that acts.
export function classifyFailure(
  reason: string | null | undefined,
  causes: readonly FailureCausePattern[]
): FailureCause {
  const said = reason?.trim();
  if (!said) return "unknown";
  if (said.startsWith(SLEPT_REASON_PREFIX)) return "suspend";
  for (const row of causes) {
    if (row.pattern && said.includes(row.pattern)) {
      return (KNOWN_CAUSES as readonly string[]).includes(row.cause)
        ? (row.cause as FailureCause)
        : "unknown";
    }
  }
  return "unknown";
}

/// What gavin is allowed to do about a cause, and on what signal.
///
/// `hold` and `never` both mean "no automatic resume", and they are two
/// values rather than one because they are two different things to tell
/// a human. A usage limit will pass; an expired token will not pass
/// until somebody does something.
export type AutoResumePolicy =
  | { kind: "resume"; on: "wake" | "reachable" | "backoff" }
  | { kind: "hold"; why: string }
  | { kind: "never"; why: string };

/// The trigger table, per cause. Never a bare timer: a timer that fires
/// while the network is still down spends the one attempt on nothing.
///
/// - `suspend` -- the wake gap detector IS the event; it has already
///   fired by the time this is read.
/// - `network` -- wait for reachability to come back.
/// - `outage` -- only observable by trying, so a bounded backoff and
///   nothing else.
/// - `usage-limit` -- the wait is until a RESET, not until the network
///   returns, and the boundary is a clock gavin cannot read. Holding is
///   what "do not hammer the boundary" means when you do not know where
///   the boundary is; parsing the reset time out of the agent's line
///   needs a measured sample nobody has taken yet.
/// - `auth` -- resuming loops against a wall.
/// - `crashed` -- not a connection failure. Nothing suggests a second
///   run behaves differently, and the transcript may be why it died.
/// - `unknown` -- see the header. Never.
export function autoResumePolicy(cause: FailureCause): AutoResumePolicy {
  switch (cause) {
    case "suspend":
      return { kind: "resume", on: "wake" };
    case "network":
      return { kind: "resume", on: "reachable" };
    case "outage":
      return { kind: "resume", on: "backoff" };
    case "usage-limit":
      // Still a hold, and now a WATCHED one. When the profile has a usage
      // probe (`agent_setup.rs`'s `usage_probe`) gavin can read the reset
      // instant off the account rather than guessing it off the agent's
      // line, and `pauseFor` holds every start until it passes -- so the
      // rail resumes on its own the moment the window reopens.
      //
      // The hold stays because the resume is not this module's to fire:
      // a run whose agent already died at the limit is picked up by the
      // pause gate in `fire`, which defers instead of spending the one
      // attempt against a wall. What was true when this was written --
      // "the boundary is a clock gavin cannot read" -- is no longer true
      // for `claude-code` and `codex`, and is still true for the rest.
      return {
        kind: "hold",
        why: "the usage limit has to reset before another attempt can get anywhere",
      };
    case "auth":
      return { kind: "never", why: "the agent is asking for a login, which only you can give it" };
    case "crashed":
      return { kind: "never", why: "the agent process died, which a second run would not change" };
    case "unknown":
      return { kind: "never", why: "gavin cannot tell what broke, so it will not guess" };
  }
}

/// At most ONE automatic resume per run. No exponential ladder and no
/// second wind: if the resume itself fails, the run stalls and stops.
///
/// The budget is persisted on the run row (`StepRun.resumeAttempts`,
/// `CardSession.resumeAttempts`) rather than counted here, because an app
/// reload and a daemon restart are precisely the conditions this feature
/// runs under -- an in-memory counter is an unbounded loop wearing the
/// costume of a limit.
export const MAX_AUTO_RESUME_ATTEMPTS = 1;

/// How long to wait before firing, per trigger.
///
/// `wake` and `reachable` are short because the signal they wait on has
/// already arrived; the delay is only the stagger's floor. `backoff` is
/// the one cause with nothing to observe, so trying is the only way to
/// find out and the wait has to be long enough to be worth something.
const BASE_DELAY_MS: Record<"wake" | "reachable" | "backoff", number> = {
  wake: 3_000,
  reachable: 3_000,
  backoff: 60_000,
};

export function resumeDelayMs(on: "wake" | "reachable" | "backoff"): number {
  return BASE_DELAY_MS[on];
}

/// Everything the decision below reads. Assembled by the caller from the
/// run row, the board and the layout, and deliberately flat: a decision
/// that takes stores cannot be tested, and this one is the whole feature.
export interface AutoResumeInput {
  /// Whether the human opted THIS run's owner in, in advance: the rail's
  /// `autoResume`, or the workspace's setting for a standalone card run.
  /// The standing objection to auto-resume is that a rail resuming itself
  /// six hours after the human walked away made a decision that was
  /// theirs; consent given in advance is what dissolves it.
  consented: boolean;
  /// The daemon's reason, verbatim.
  reason: string | null;
  /// The failing profile's cause table.
  causes: readonly FailureCausePattern[];
  /// What the TypeSafe turn verdict made of the same screen, already
  /// through its own confidence gate (`refineCause` in turnVerdict.ts).
  ///
  /// Used ONLY where the table above said `unknown`, which is every
  /// failure of codex, gemini, cursor, opencode and custom -- they have
  /// no table at all, so today every broken turn of theirs is a cause
  /// gavin cannot name, and `unknown` never resumes. The table wins
  /// wherever it matched: it is ordered, measured and local, and a
  /// remote judgement must not override a local one that is already
  /// right.
  ///
  /// Passed as a plain `FailureCause` rather than as the verdict, on
  /// purpose: this module knows nothing about TypeSafe, and a
  /// low-confidence cause has ALREADY become `unknown` by the time it
  /// gets here -- so "unknown never resumes" covers the whole feature
  /// without a second rule anywhere in this file. Absent reads as
  /// `unknown`, which is the pre-verdict behaviour exactly.
  verdictCause?: FailureCause;
  /// What the session was doing immediately BEFORE it failed. A session
  /// that was `waiting_for_input` was asking a human a question, and it
  /// still is -- resuming answers it by walking away.
  previousStatus: string | undefined;
  /// `StepRun.resumeAttempts` / `CardSession.resumeAttempts`; absent
  /// reads as zero.
  attempts: number | null | undefined;
  /// The conversation id gavin minted at launch. Without one there is
  /// nothing to resume: a relaunch would be a from-scratch second
  /// attempt, which is the bug this whole family of cards exists to
  /// prevent, and gavin auto-resumes exactly the runs it launched and
  /// holds a conversation id for.
  conversationId: string | null | undefined;
  /// Whether the work this run was doing is ALREADY FINISHED -- the card
  /// reached the done column. An agent can complete its edits and die
  /// before reporting them, and re-running finished work is the failure
  /// mode this family of cards exists to stop.
  workFinished: boolean;
  /// Non-null when this session cannot be resumed for a reason the
  /// caller knows and this module does not: a sibling in the same
  /// parallel stage also failed, a daemon too old to persist the budget,
  /// a claim already held. Reported as-is so the audit trail can say it.
  blocked?: string | null;
}

export type AutoResumeDecision =
  | { kind: "resume"; cause: FailureCause; on: "wake" | "reachable" | "backoff"; delayMs: number }
  | { kind: "skip"; cause: FailureCause; why: string };

/// The whole gate, in the order that gives the most useful answer.
///
/// Consent is checked first because a workspace that never opted in
/// should not have gavin computing verdicts about its rails at all, and
/// `workFinished` comes before the cause because a finished run is not a
/// failure to recover from whatever killed the process -- it is work to
/// file, and the caller does that instead.
export function autoResumeDecision(input: AutoResumeInput): AutoResumeDecision {
  const matched = classifyFailure(input.reason, input.causes);
  // The table first, the verdict only in the hole it left. See
  // `verdictCause` on the input for why that order is not negotiable.
  const cause = matched === "unknown" ? (input.verdictCause ?? "unknown") : matched;
  const skip = (why: string): AutoResumeDecision => ({ kind: "skip", cause, why });

  if (!input.consented) return skip("auto-resume is off here");
  if (input.blocked) return skip(input.blocked);
  if (input.workFinished) return skip("the work was already finished when the agent stopped");
  if (input.previousStatus === "waiting_for_input") {
    return skip("the agent was waiting on an answer from you, and still is");
  }
  if (!input.conversationId?.trim()) {
    return skip("this run has no conversation to reopen, so resuming would start it over");
  }
  if ((input.attempts ?? 0) >= MAX_AUTO_RESUME_ATTEMPTS) {
    return skip("gavin already resumed this run once");
  }

  const policy = autoResumePolicy(cause);
  if (policy.kind !== "resume") return skip(policy.why);
  return { kind: "resume", cause, on: policy.on, delayMs: resumeDelayMs(policy.on) };
}

// ---- The herd ---------------------------------------------------------------

/// The spread a stagger spans, on top of each resume's base delay.
///
/// N agents hitting the API the instant a flaky network returns is the
/// most reliable way to spend every retry budget at the one moment least
/// likely to succeed. One interruption fails a whole parallel stage at
/// once, and a laptop opening at home fails every rail in the workspace
/// at once, so the herd is real and it is not confined to one rail.
export const STAGGER_SPREAD_MS = 20_000;

/// Delays for `count` resumes armed in the same instant: each one's own
/// base delay, plus an increasing slot, plus jitter inside that slot.
///
/// Position order is arbitrary but STABLE, which is all a stagger needs
/// -- there is no order inside a parallel stage to sequence by, and
/// inventing one would imply a dependency the human did not write. The
/// jitter is what stops N gavins on N machines (or N rails on one)
/// landing on the same second.
///
/// `rand` is injected so the spread is testable; it must return
/// [0, 1).
export function staggerDelays(
  baseDelays: readonly number[],
  rand: () => number = Math.random
): number[] {
  const count = baseDelays.length;
  if (count <= 1) return [...baseDelays];
  const slot = STAGGER_SPREAD_MS / count;
  return baseDelays.map((base, i) => Math.round(base + i * slot + rand() * slot));
}

/// How soon after a resume a second failure counts as "the network is
/// not actually back" rather than as a second independent failure.
///
/// Reachability is a gate, not a guarantee: `navigator.onLine` says a
/// route exists, never that the API is up. An agent that breaks again
/// within seconds of being resumed is evidence about the WAVE, not about
/// that one run -- so it cancels the rest of the wave instead of letting
/// every sibling spend its single attempt on the same dead network.
export const WAVE_ABORT_WINDOW_MS = 30_000;

export function isImmediateRefailure(resumedAt: number, failedAt: number): boolean {
  return failedAt - resumedAt <= WAVE_ABORT_WINDOW_MS;
}

// ---- The audit trail --------------------------------------------------------

/// What a run records about an automatic resume, so a rail that is green
/// now can still say it was not green all along. Coming back to finished
/// work, you need to be able to find out that it broke at 09:14 and was
/// resumed at 14:22 -- a resume that leaves no trace is indistinguishable
/// from a step that never failed.
export interface ResumeRecord {
  cause: FailureCause;
  /// The agent's own sentence, as the daemon reported it.
  reason: string;
  failedAt: number;
  resumedAt: number;
}

const CLOCK = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });

/// One line, in the same voice as `failedStepReason`: what broke, when,
/// and when gavin picked it back up.
export function resumeTrailLine(record: ResumeRecord): string {
  const broke = CLOCK.format(new Date(record.failedAt));
  const back = CLOCK.format(new Date(record.resumedAt));
  const said = record.reason.trim();
  const tail = said ? ` — ${said}` : "";
  return `resumed automatically at ${back} after stopping at ${broke}${tail}`;
}

/// The same fact for the notification tray, where the body has to stand
/// alone and be short enough to survive the OS truncating it.
export function resumeNotificationBody(label: string, record: ResumeRecord): string {
  return `${label} broke and was resumed automatically — ${record.reason.trim()}`;
}

/// The one line a surface shows about a run gavin put back by itself,
/// or null when it never did.
///
/// Two sources, and the fallback is the load-bearing one. `record` is
/// the detail -- when it broke, when it came back, in the agent's own
/// words -- and it lives in memory, so it is gone after a reload.
/// `attempts` is the count persisted on the run row, which is not gone,
/// and it is what lets a rail that is green NOW still say it was not
/// green all along. Losing the times is a smaller loss than losing the
/// fact.
export function resumeNoteFor(
  record: ResumeRecord | undefined,
  attempts: number | null | undefined
): string | null {
  if (record) return resumeTrailLine(record);
  const count = attempts ?? 0;
  if (count <= 0) return null;
  return count === 1
    ? "gavin resumed this run automatically once, after its agent broke"
    : `gavin resumed this run automatically ${count} times, after its agent broke`;
}

/// What the human is told when gavin decided NOT to resume something it
/// could have. Silence here is the failure mode: a rail that stalled for
/// a reason nobody stated looks identical to one gavin forgot about.
export function resumeSkippedBody(label: string, why: string): string {
  return `${label} stopped and was not resumed — ${why}`;
}
