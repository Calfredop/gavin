// What one pull request MEANS, once the host has read it.
//
// `pull_request.rs` does the reading -- finding `gh`, running it, parsing
// GitHub's two spellings of a check result -- and hands back a report.
// Everything decided from that report lives here, pure, so the rail
// header's chips and the scheduler's `pr` step answer from one rule
// rather than each thresholding on their own. That is the whole point of
// there being a single poll: a human looking at a green chip row while
// the rail sits waiting is the failure this design exists to prevent.
//
// Two rules run through the file:
//
//   **Absence is never success.** A report that could not be read, a PR
//   that does not exist yet and a PR whose checks have not started are
//   three kinds of "nothing to see", and none of them is a pass. The
//   emptiest-looking one -- a check rollup with no entries -- is the most
//   dangerous, because a repo with no CI produces exactly the same shape
//   as a repo whose CI has not been registered yet (see EMPTY_ROLLUP_GRACE).
//
//   **A failing check is a verdict on the RAIL, not on the step.** It
//   sends the rail backwards over the work that produced it, which is
//   `builtin:until`'s machinery arriving from a different place --
//   see orchestrationLoop.ts, which this module deliberately reuses
//   rather than copies.

import type { IndicatorTone } from "./ui/indicators";

/// One CI check. Mirrors `PrCheck` in `pull_request.rs`.
export interface PrCheck {
  name: string;
  state: PrCheckState;
  /// The run's own page, or "" when the rollup carried none.
  url: string;
}

/// Normalised on the host, so nothing here has to know whether GitHub
/// sent a check run or a commit status.
export type PrCheckState =
  | "success"
  | "failure"
  | "pending"
  | "skipped"
  | "cancelled"
  | "unknown";

/// Mirrors `PrReport` in `pull_request.rs`, tag and all.
export type PrReport =
  | {
      state: "ready";
      number: number;
      url: string;
      title: string;
      /// "OPEN" | "CLOSED" | "MERGED", as GitHub spells it.
      prState: string;
      isDraft: boolean;
      /// "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | "".
      reviewDecision: string;
      /// "MERGEABLE" | "CONFLICTING" | "UNKNOWN".
      mergeable: string;
      /// Epoch seconds, or 0 when GitHub did not say.
      createdAt: number;
      checks: PrCheck[];
      /// Epoch seconds when this was read from GitHub -- not when the
      /// cache served it.
      observedAt: number;
      cached: boolean;
    }
  /// `gh` answered and this branch has no pull request. The state every
  /// branch starts in, and the one a wait step waits THROUGH.
  | { state: "none" }
  /// No `gh` on this machine. Terminal: waiting will not install it.
  | { state: "missing"; reason: string }
  /// There is a `gh` and it could not answer. Retryable.
  | { state: "unavailable"; reason: string };

/// How long after a PR is opened an EMPTY check rollup still counts as
/// "CI has not started", rather than as "this repo runs no CI".
///
/// The two are indistinguishable in the data -- both are `[]` -- and
/// getting it wrong in the generous direction is the worse mistake: a
/// wait step that read the empty rollup GitHub returns in the seconds
/// after `gh pr create` would mark itself done and advance the rail past
/// a CI run that had not started, which is precisely the blindness this
/// card exists to fix.
///
/// Two minutes is comfortably longer than GitHub takes to register a
/// workflow run (seconds) and short enough that a repo with genuinely no
/// CI costs one poll cycle of waiting rather than a stall.
export const EMPTY_ROLLUP_GRACE_SECS = 120;

/// One key per (checkout, branch), matching the host's own cache: two
/// rails bound to the same branch in the same checkout are one pull
/// request and deserve one request. Here rather than in prState.ts
/// because the SCHEDULER has to build it too, and the scheduler is pure.
///
/// NUL as the separator, matching `pr_status`'s own key: it is the one
/// byte neither a path nor a git ref may contain, so no pair of
/// (checkout, branch) can collide with another by spelling.
export function prKey(cwd: string, branch: string): string {
  return `${cwd}\u0000${branch}`;
}

// ---- Reading the checks -----------------------------------------------------

export interface CheckRollup {
  total: number;
  passed: number;
  failed: number;
  pending: number;
  /// Skipped and cancelled together: neither ran to a verdict, and
  /// neither is a reason to hold a rail. Counted so a chip reading
  /// "2/5" beside three skipped checks is not a mystery.
  ignored: number;
  failing: PrCheck[];
}

/// The tally the chips draw and the verdict reads.
///
/// `unknown` is counted as PENDING, deliberately. It means a state this
/// build could not classify -- a conclusion GitHub added after this
/// version shipped -- and the safe reading of "I do not understand this
/// check" is "do not advance past it yet", never "it passed". The same
/// posture `toolStepOutcome` takes on an unwitnessed exit.
export function checkRollup(checks: readonly PrCheck[]): CheckRollup {
  const rollup: CheckRollup = { total: checks.length, passed: 0, failed: 0, pending: 0, ignored: 0, failing: [] };
  for (const check of checks) {
    if (check.state === "success") rollup.passed++;
    else if (check.state === "failure") {
      rollup.failed++;
      rollup.failing.push(check);
    } else if (check.state === "skipped" || check.state === "cancelled") rollup.ignored++;
    else rollup.pending++;
  }
  return rollup;
}

// ---- What the step was asked to wait for ------------------------------------

/// What a `pr` step waits for. `checks` is CI alone; `approval` also
/// holds until a human approves the PR.
export type PrRequirement = "checks" | "approval";

/// The step's `require` parameter read into a requirement.
///
/// Deliberately loose: the parameter is a free text field a human typed,
/// and "approval", "Checks and approval", "review" and "approved" all
/// plainly mean the same thing. Anything that mentions neither is
/// `checks` -- the narrower wait, so a typo delays nobody.
export function prRequirement(raw: string): PrRequirement {
  const said = raw.trim().toLowerCase();
  return /approv|review/.test(said) ? "approval" : "checks";
}

// ---- The verdict ------------------------------------------------------------

/// What a `pr` step's tick should do.
///
/// `waiting` is the common answer and carries the sentence the chip
/// shows, so a step that sits for forty minutes is never silent about
/// what it is sitting on.
export type PrWaitVerdict =
  | { kind: "waiting"; note: string }
  | { kind: "pass" }
  /// A check failed (or a reviewer asked for changes) and there is budget
  /// left: re-run the step before this one with `note` opening its
  /// prompt. Exactly `builtin:until`'s loop, arriving from GitHub.
  | { kind: "retry"; previousStepId: string; attempt: number; max: number; note: string }
  | { kind: "exhausted"; max: number; note: string }
  /// Nothing about waiting longer will help.
  | { kind: "stuck"; reason: string };

export function prWaitVerdict(input: {
  report: PrReport | undefined;
  requirement: PrRequirement;
  /// `StepRun.resumeAttempts` -- loop retries already spent.
  attempts: number | null | undefined;
  max: number;
  /// The step this loop re-runs, or null when the wait step is first on
  /// its rail (in which case a failure has nothing to send it back to).
  previousStepId: string | null;
  /// Epoch seconds. Only the empty-rollup grace period reads it.
  now: number;
}): PrWaitVerdict {
  const { report } = input;
  // No report at all is the cold start: the poll has not answered yet.
  // Waiting, never passing -- the same rule launchBlocker follows about
  // an unloaded tool library.
  if (!report) return { kind: "waiting", note: "asking GitHub about this branch" };
  if (report.state === "missing") return { kind: "stuck", reason: report.reason };
  // NOT a stall. A wait step's whole job is to be patient, and gh's
  // failures here are overwhelmingly transient -- a sleeping laptop, a
  // dropped VPN, a rate limit that clears in a minute. Stalling on one
  // would pause the rail (rule 5) and need a human to press Resume for
  // something that fixed itself. The reason rides the chip instead, so a
  // wait that is genuinely broken -- an expired `gh auth` -- is visible
  // rather than silent. `missing` above is the case that never fixes
  // itself, and that one does stall.
  if (report.state === "unavailable") return { kind: "waiting", note: report.reason };
  if (report.state === "none") return { kind: "waiting", note: "no pull request for this branch yet" };

  // A merged PR is the end of the story, however its checks finished:
  // the human merged it, which is the one action this feature leaves to
  // them, and holding the rail behind a check on merged code helps
  // nobody.
  if (report.prState === "MERGED") return { kind: "pass" };
  if (report.prState === "CLOSED") {
    return { kind: "stuck", reason: `pull request #${report.number} was closed without merging` };
  }

  const rollup = checkRollup(report.checks);
  const loop = (note: string): PrWaitVerdict => {
    if (!input.previousStepId) {
      return {
        kind: "stuck",
        reason: `${note} — and nothing runs before this step, so there is nothing to send the rail back to`,
      };
    }
    const used = Math.max(0, input.attempts ?? 0);
    if (used >= input.max) return { kind: "exhausted", max: input.max, note };
    return {
      kind: "retry",
      previousStepId: input.previousStepId,
      attempt: used + 1,
      max: input.max,
      note,
    };
  };

  // Checks first, and a FAILURE beats anything still pending: a build
  // that has already broken is not made truer by the other nine finishing,
  // and the sooner the rail goes back over the work the sooner it is
  // fixed. gh's own `--fail-fast` takes the same view.
  if (rollup.failed > 0) return loop(failingChecksNote(report));
  if (rollup.pending > 0) {
    return { kind: "waiting", note: pendingNote(rollup) };
  }
  // Nothing failed, nothing pending -- and possibly nothing at all. See
  // EMPTY_ROLLUP_GRACE_SECS: an empty rollup on a brand-new PR is CI that
  // has not registered yet, not a repo without CI.
  if (rollup.total === 0 && report.createdAt > 0 && input.now - report.createdAt < EMPTY_ROLLUP_GRACE_SECS) {
    return { kind: "waiting", note: "waiting for GitHub to report this PR's checks" };
  }

  if (input.requirement === "approval") {
    // A reviewer asking for changes is a failing check by another name,
    // and it is the one a re-run has the best chance with: the review
    // comments say exactly what to fix.
    if (report.reviewDecision === "CHANGES_REQUESTED") {
      return loop(`a reviewer requested changes on pull request #${report.number} — ${report.url}`);
    }
    if (report.reviewDecision !== "APPROVED") {
      // A DRAFT cannot be approved at all, so say that rather than
      // "waiting for a review" about a PR nobody has been asked to read.
      return {
        kind: "waiting",
        note: report.isDraft
          ? `pull request #${report.number} is still a draft`
          : `waiting for approval on pull request #${report.number}`,
      };
    }
  }
  return { kind: "pass" };
}

/// What a waiting step says while checks are still running.
function pendingNote(rollup: CheckRollup): string {
  const done = rollup.passed + rollup.ignored;
  return `${rollup.pending} of ${rollup.total} checks still running (${done} finished)`;
}

/// What opens the retried agent's prompt, and what the exhausted stall
/// says. The checks' own names and links -- an agent told only "CI
/// failed" writes a report instead of a fix, which is exactly the
/// reasoning behind `retryPromptPrefix`.
///
/// Capped, because a monorepo can fail forty checks at once and a prompt
/// that opens with forty URLs buries the instruction after it.
export function failingChecksNote(report: PrReport, limit = 10): string {
  if (report.state !== "ready") return "";
  const failing = checkRollup(report.checks).failing;
  if (failing.length === 0) return "";
  const shown = failing.slice(0, limit);
  const lines = shown.map((check) => (check.url ? `- ${check.name} — ${check.url}` : `- ${check.name}`));
  const more = failing.length > shown.length ? `\n- …and ${failing.length - shown.length} more` : "";
  const plural = failing.length === 1 ? "check is" : "checks are";
  return `${failing.length} ${plural} failing on pull request #${report.number}:\n${lines.join("\n")}${more}`;
}

/// The stall reason a spent budget leaves behind. Mirrors
/// `exhaustedReason` in orchestrationLoop.ts -- same sentence shape, so
/// the two loops read alike on a chip -- but sourced from GitHub rather
/// than from a log file.
export function prExhaustedReason(max: number, note: string): string {
  const tries = `${max} ${max === 1 ? "retry" : "retries"}`;
  const said = note ? ` — ${note.split("\n")[0]}` : "";
  return `the pull request still was not ready after ${tries}${said}`;
}

// ---- The chips --------------------------------------------------------------

/// One read-only fact about the PR, for the rail header. Read-only is the
/// point: nothing on this row acts, because merging is the human's.
export interface PrChip {
  /// Stable across polls, so Svelte keys on it rather than re-creating
  /// the row every minute.
  key: string;
  label: string;
  tone: IndicatorTone;
  tip: string;
  /// The page this chip is about, or null. The header opens it.
  href: string | null;
}

/// The chip row for a branch-bound rail, or [] when there is nothing to
/// say. Never a row of blanks: a rail whose branch has no PR shows
/// nothing at all, because "no PR" is the resting state of most branches
/// and a permanent grey chip saying so is noise on every rail.
export function prChips(report: PrReport | undefined, now: number): PrChip[] {
  if (!report || report.state === "none") return [];
  if (report.state === "missing") {
    return [{ key: "gh", label: "no gh", tone: "neutral", tip: report.reason, href: null }];
  }
  if (report.state === "unavailable") {
    return [{ key: "gh", label: "PR unknown", tone: "warning", tip: report.reason, href: null }];
  }

  const chips: PrChip[] = [];
  const merged = report.prState === "MERGED";
  const closed = report.prState === "CLOSED";
  chips.push({
    key: "pr",
    label: `#${report.number}${report.isDraft ? " draft" : ""}`,
    tone: merged ? "success" : closed ? "danger" : "accent",
    tip: `${report.title || "pull request"}${merged ? " — merged" : closed ? " — closed" : ""}\n${observedTip(report.observedAt, now)}`,
    href: report.url || null,
  });

  const rollup = checkRollup(report.checks);
  if (rollup.total > 0) {
    // Failures lead the label. "3/5" with two red checks underneath it
    // reads as progress; "2 failing" does not.
    const label =
      rollup.failed > 0
        ? `${rollup.failed} failing`
        : rollup.pending > 0
          ? `${rollup.passed}/${rollup.total} checks`
          : `${rollup.total} checks passed`;
    chips.push({
      key: "checks",
      label,
      tone: rollup.failed > 0 ? "danger" : rollup.pending > 0 ? "accent" : "success",
      tip:
        rollup.failing.length > 0
          ? rollup.failing.map((c) => c.name).join(", ")
          : `${rollup.passed} passed, ${rollup.pending} running, ${rollup.ignored} skipped`,
      href: rollup.failing[0]?.url || report.url || null,
    });
  }

  const review = reviewChip(report.reviewDecision);
  if (review) chips.push(review);
  // Only when it is a problem. "MERGEABLE" and "UNKNOWN" are both
  // "nothing to do about it", and UNKNOWN is GitHub's ordinary answer
  // while it recomputes -- a chip for either would cry wolf.
  if (report.mergeable === "CONFLICTING" && !merged) {
    chips.push({
      key: "conflict",
      label: "conflicts",
      tone: "danger",
      tip: "the pull request conflicts with its base branch",
      href: report.url || null,
    });
  }
  return chips;
}

function reviewChip(decision: string): PrChip | null {
  if (decision === "APPROVED") {
    return { key: "review", label: "approved", tone: "success", tip: "the pull request is approved", href: null };
  }
  if (decision === "CHANGES_REQUESTED") {
    return {
      key: "review",
      label: "changes requested",
      tone: "warning",
      tip: "a reviewer asked for changes",
      href: null,
    };
  }
  if (decision === "REVIEW_REQUIRED") {
    return {
      key: "review",
      label: "review required",
      tone: "warning",
      tip: "the pull request cannot merge until somebody reviews it",
      href: null,
    };
  }
  // "" -- this repo asks for no review. Nothing to say.
  return null;
}

/// How old the reading is, in the terms the rest of the app uses. A
/// number rather than "just now" past the first minute, because the
/// question a human asks a stale chip is "how stale".
export function observedTip(observedAt: number, now: number): string {
  const age = Math.max(0, now - observedAt);
  if (age < 90) return "checked just now";
  const minutes = Math.round(age / 60);
  if (minutes < 60) return `checked ${minutes}m ago`;
  return `checked ${Math.round(minutes / 60)}h ago`;
}
