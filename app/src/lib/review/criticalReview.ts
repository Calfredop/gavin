// Critical review: N agents critique finished work side by side, in the
// SAME checkout, and file findings as cards.
//
// Reuses Best-of-N's N × (profile, model) picker shape and the single-
// agent review's filing path (`composeReviewPrompt`). What it deliberately
// does NOT reuse is Best-of-N's worktrees, branches, or pick-a-winner:
// reviewers read one checkout together, and the output is cards, not a
// chosen attempt.
//
// Pure. The dialog and launch live in criticalReviewActions.ts /

import {
  candidateLabel,
  candidatesError as bestOfNCandidatesError,
  seedCandidates,
  type Candidate,
} from "$lib/cards/bestOfN";
import {
  composeReviewPrompt,
  type ReviewPromptOptions,
  type ReviewedCard,
} from "$lib/review/codeReview";

export type { Candidate };
export { seedCandidates, candidateLabel };

/// What a critical review is looking at. A card (one piece of work) or a
/// whole rail (its checkout / branch as one subject). The Review tab's
/// rails-as-subjects card feeds the rail shape; the dialog and launch
/// already accept both.
export type CriticalReviewSubjectKind = "card" | "rail";

export interface CriticalReviewSubject {
  kind: CriticalReviewSubjectKind;
  /// One line the dialog and the prompt both use: "the work done for …"
  /// or "rail “auth”".
  label: string;
  /// Card under review, when the subject is a card. Null for a rail —
  /// findings then stand free (or nest under nothing), the same way a
  /// branch review from the Git tab does.
  card: ReviewedCard | null;
}

/// Why this set of reviewers cannot launch, or null. Same uniqueness
/// rule as Best-of-N, reworded: one reviewer is just "Review with agent".
export function reviewersError(reviewers: readonly Candidate[]): string | null {
  const err = bestOfNCandidatesError(reviewers);
  if (!err) return null;
  if (err.includes("at least two")) {
    return "A critical review needs at least two reviewers — one agent is Review with agent.";
  }
  if (err.includes("same agent and model")) {
    return "Two reviewers are the same agent and model — give one a different profile or model.";
  }
  return err;
}

/// The page the reviewers are tiled on. Named for the subject so the
/// page list stays readable after several runs.
export function criticalReviewPageName(subjectLabel: string): string {
  const collapsed = subjectLabel.split(/\s+/).filter(Boolean).join(" ");
  return collapsed ? `Critical review: ${collapsed}` : "Critical review";
}

/// Earliest non-empty baseSha among a rail's steps, in step order. The
/// rail-as-subject baseline prefers a worktree fork point when one is
/// known; this is the fallback the feat card names.
export function earliestStepBaseSha(
  baseShas: readonly (string | null | undefined)[]
): string | null {
  for (const sha of baseShas) {
    const t = sha?.trim();
    if (t) return t;
  }
  return null;
}

/// Seed the dialog's "compare against" field for a rail subject.
///
/// Order: worktree fork point, else earliest step baseSha, else the
/// ordinary trunk default the single-agent review already uses.
export function seedCriticalReviewBase(options: {
  worktreeForkPoint: string | null | undefined;
  stepBaseShas: readonly (string | null | undefined)[];
  defaultBase: string;
}): string {
  const fork = options.worktreeForkPoint?.trim();
  if (fork) return fork;
  return earliestStepBaseSha(options.stepBaseShas) ?? options.defaultBase;
}

export interface CriticalReviewPromptOptions extends ReviewPromptOptions {
  reviewerLabel: string;
  reviewerTotal: number;
  /// Per-run toggle from the dialog. Default off. The app builds the
  /// rail (findings-rail card); the prompt only says the cards matter
  /// for that when the toggle is on.
  alsoBuildFindingsRail?: boolean;
}

/// Framing on top of the ordinary review prompt: same filing path, plus
/// the facts a parallel shared-checkout reviewer cannot work out alone.
export function reviewerPromptSuffix(
  label: string,
  total: number,
  alsoBuildFindingsRail = false
): string {
  const lines = [
    "",
    `You are one of ${total} reviewers critiquing this work side by side in the ` +
      `same checkout. You are “${label}”. This shell already starts where the ` +
      `work lives — review only; change no files, switch no branches, and do not merge.`,
    "",
    `Begin your tab name with “${label} ” so the panes stay tellable apart.`,
  ];
  if (alsoBuildFindingsRail) {
    lines.push(
      "",
      "File every finding as its own card — those cards are what a findings rail " +
        "will be built from after this run."
    );
  }
  return "\n" + lines.join("\n");
}

/// The instruction every critical-review session is handed. Filing rules
/// come from `composeReviewPrompt` so one board never grows three card
/// shapes for the same kind of finding.
export function composeCriticalReviewPrompt(options: CriticalReviewPromptOptions): string {
  const {
    reviewerLabel,
    reviewerTotal,
    alsoBuildFindingsRail = false,
    ...review
  } = options;
  return (
    composeReviewPrompt(review) +
    reviewerPromptSuffix(reviewerLabel, reviewerTotal, alsoBuildFindingsRail)
  );
}

/// Subject line for a card, matching the single-agent review's wording
/// so the two dialogs do not disagree about what is under review.
export function cardSubjectLabel(title: string): string {
  return `the work done for “${title}”`;
}

export function railSubjectLabel(railName: string): string {
  return `rail “${railName}”`;
}

// ---- Rail step params -------------------------------------------------------
// Flat string params on `builtin:critical-review`. Parsed here so the
// dialog's Candidate shape and the step's launch share one spelling.

/// Lines of `profileId` or `profileId:model`. Blank lines skipped.
/// Empty / whitespace-only input is an empty list — the rail step then
/// seeds from `seedCandidates` at launch, the same pair the dialog opens
/// with.
export function parseReviewersParam(raw: string | null | undefined): Candidate[] {
  const out: Candidate[] = [];
  for (const line of (raw ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const colon = trimmed.indexOf(":");
    if (colon === -1) {
      out.push({ profileId: trimmed, model: "" });
    } else {
      out.push({
        profileId: trimmed.slice(0, colon).trim(),
        model: trimmed.slice(colon + 1).trim(),
      });
    }
  }
  return out;
}

/// The step's auto-build toggle. Default off — only explicit on/yes/true/1.
export function alsoBuildFindingsRailParam(raw: string | null | undefined): boolean {
  const t = (raw ?? "").trim().toLowerCase();
  return t === "on" || t === "yes" || t === "true" || t === "1";
}

/// Whether every reviewer session has finished its turn (or exited).
///
/// Agents stay live at a prompt after the turn, so "idle after working"
/// is done — the same signal `agentTurnEnded` uses for a single agent
/// tool. A session that left the layout entirely also counts: the card
/// asked for complete-then-advance once reviewers exit.
export function critiqueSessionsComplete(input: {
  sessionIds: readonly string[];
  liveSessionIds: ReadonlySet<string>;
  sessionStatuses: ReadonlyMap<string, string>;
  sessionsSeenWorking: ReadonlySet<string>;
}): boolean {
  if (input.sessionIds.length === 0) return false;
  return input.sessionIds.every((id) => {
    if (!input.liveSessionIds.has(id)) return true;
    return (
      input.sessionStatuses.get(id) === "idle" && input.sessionsSeenWorking.has(id)
    );
  });
}
