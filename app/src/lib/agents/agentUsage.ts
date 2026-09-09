// What an agent's subscription limits MEAN, once the host has read them.
//
// `agent_usage.rs` does the reading -- credentials, curl, rollout files --
// and hands back percentages and reset instants. Everything a surface
// needs to decide from those lives here, pure, so the panel, the pause
// gate and the sidebar strip all answer the same way about the same
// numbers instead of each rounding and thresholding on their own.
//
// One rule runs through it: **absence is never zero.** A profile with no
// probe, a probe that could not answer and a window at 0% are three
// different states, and only the last one is a bar. Collapsing them is
// how a panel ends up telling somebody they have full quota at the
// moment it has no idea.

/// One limit window. Mirrors `UsageWindow` in `agent_usage.rs`.
export interface UsageWindow {
  /// "five_hour" | "seven_day" | "spend_limit" | "primary" | "secondary".
  id: string;
  label: string;
  /// 0-100, and can exceed 100 for a spend limit. Never clamped upstream,
  /// so never assume it fits.
  usedPercent: number;
  /// Epoch SECONDS, or null when the route did not say. Absolute on
  /// purpose: a duration computed at read time is wrong the moment the
  /// machine sleeps, which is the case this whole feature exists for.
  resetsAt: number | null;
}

/// Mirrors `UsageReport` in `agent_usage.rs`, tag and all.
export type AgentUsageReport =
  | {
      state: "ready";
      windows: UsageWindow[];
      plan: string | null;
      /// When the DATA was true -- for codex that is the rollout event's
      /// own timestamp, which can be hours old. Not when gavin read it.
      observedAt: number;
      cached: boolean;
    }
  | { state: "unsupported" }
  | { state: "unavailable"; reason: string; retryAfter: number | null };

/// How close a window is to its ceiling, in the three bands every surface
/// shares. Bands rather than a raw number because the answer a human
/// wants is "can I start something big", and 71% and 74% are the same
/// answer.
///
/// The 90 boundary is where `warn` becomes `critical` because that is
/// roughly one long agent turn from the wall on a 5-hour window -- close
/// enough that starting a rail is a decision, not a reflex.
export type UsageSeverity = "ok" | "warn" | "critical";

export const WARN_PERCENT = 75;
export const CRITICAL_PERCENT = 90;

export function usageSeverity(usedPercent: number): UsageSeverity {
  if (!Number.isFinite(usedPercent)) return "ok";
  if (usedPercent >= CRITICAL_PERCENT) return "critical";
  if (usedPercent >= WARN_PERCENT) return "warn";
  return "ok";
}

/// The window nearest its ceiling, which is the one that will stop work
/// first. A 5-hour window at 30% next to a weekly at 95% is a weekly
/// problem, and reporting the first window in the list would hide that.
export function worstWindow(report: AgentUsageReport): UsageWindow | null {
  if (report.state !== "ready" || report.windows.length === 0) return null;
  return report.windows.reduce((worst, w) => (w.usedPercent > worst.usedPercent ? w : worst));
}

/// The report's severity, which is its worst window's. A report with no
/// numbers has no severity -- null, not "ok", because "gavin cannot see"
/// must never render in the same colour as "plenty left".
export function reportSeverity(report: AgentUsageReport): UsageSeverity | null {
  const worst = worstWindow(report);
  return worst ? usageSeverity(worst.usedPercent) : null;
}

/// A whole-number percentage for display. Rounded DOWN, so a bar never
/// claims 100% while a window still has room -- the one rounding error
/// that would make the panel disagree with the agent.
export function displayPercent(usedPercent: number): number {
  if (!Number.isFinite(usedPercent) || usedPercent < 0) return 0;
  return Math.floor(usedPercent);
}

/// Bar width, 0-100. Clamped where the percentage is not: a 137% spend
/// limit still draws a full bar, and the number beside it carries the
/// overrun.
export function barPercent(usedPercent: number): number {
  return Math.max(0, Math.min(100, displayPercent(usedPercent)));
}

// ---- Clocks -----------------------------------------------------------------

/// "2h 14m" / "14m" / "under a minute". The unit pair a human reads a
/// wait in; seconds are noise at this scale and days are the weekly
/// window's business.
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "under a minute";
  const total = Math.floor(seconds / 60);
  const days = Math.floor(total / (60 * 24));
  const hours = Math.floor((total % (60 * 24)) / 60);
  const minutes = total % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes > 0) return `${minutes}m`;
  return "under a minute";
}

/// "resets in 2h 14m", or null when the route gave no reset instant.
///
/// A window whose reset has PASSED reads as "resetting now" rather than
/// as a negative duration: the host drops expired windows, so seeing one
/// here means the clock crossed while the panel was open, and the honest
/// thing to say is that the number is about to change.
export function formatResetsIn(
  resetsAt: number | null | undefined,
  nowMs: number
): string | null {
  if (resetsAt == null || !Number.isFinite(resetsAt)) return null;
  const seconds = resetsAt - Math.floor(nowMs / 1000);
  if (seconds <= 0) return "resetting now";
  return `resets in ${formatDuration(seconds)}`;
}

/// How old the reading is, for a route that reports last-seen rather than
/// live. Null under a minute -- a fresh number needs no caveat, and
/// stamping "0m ago" on everything trains people to ignore the stamp.
///
/// This is what keeps the codex route honest: its numbers come from the
/// last turn codex actually took, which may have been this morning.
export function formatObservedAge(observedAt: number, nowMs: number): string | null {
  const seconds = Math.floor(nowMs / 1000) - observedAt;
  if (!Number.isFinite(seconds) || seconds < 60) return null;
  return `${formatDuration(seconds)} ago`;
}

/// One line for a compact surface: the worst window, its percentage and
/// its reset. Null when there is nothing true to say, so a caller can
/// omit the row rather than print a placeholder.
export function usageSummary(report: AgentUsageReport, nowMs: number): string | null {
  const worst = worstWindow(report);
  if (!worst) return null;
  const resets = formatResetsIn(worst.resetsAt, nowMs);
  const head = `${worst.label} ${displayPercent(worst.usedPercent)}%`;
  return resets ? `${head}, ${resets}` : head;
}

/// What to say instead of bars. Null when the report HAS bars -- the
/// caller renders those and this stays out of the way.
export function unavailableReason(
  report: AgentUsageReport,
  profileLabel: string,
  nowMs: number
): string | null {
  if (report.state === "ready") return null;
  if (report.state === "unsupported") {
    return `${profileLabel} does not publish its limits anywhere gavin can read.`;
  }
  const retry = formatResetsIn(report.retryAfter, nowMs);
  // The retry clock reads as "retrying in", not "resets in": nothing has
  // reset, gavin has simply parked itself.
  const when = retry?.replace("resets in", "trying again in");
  return when ? `${report.reason} — ${when}.` : `${report.reason}.`;
}

// ---- The gate's view --------------------------------------------------------

/// Whether these limits are exhausted enough that gavin should not start
/// new work, and when that changes.
///
/// `atOrAbove` is the threshold the workspace chose. Deliberately a
/// parameter rather than `CRITICAL_PERCENT`: the display bands and the
/// pause boundary answer different questions, and tying them together
/// would mean recolouring a bar every time somebody moved their pause
/// threshold.
///
/// `until` is the worst BLOCKING window's reset -- the instant work could
/// resume -- and null when no window that blocks says when it clears,
/// which is a hold with no clock and must be reported as such rather than
/// as a resume that never fires.
export interface UsageBlock {
  blocked: boolean;
  /// The window that caused it, for the sentence explaining the hold.
  window: UsageWindow | null;
  until: number | null;
}

export function usageBlock(
  report: AgentUsageReport,
  atOrAbove: number
): UsageBlock {
  if (report.state !== "ready") {
    // A probe that could not answer must never block work. Gavin not
    // knowing is not evidence of a limit, and a failed read that pauses
    // a rail turns a network blip into a stopped workspace.
    return { blocked: false, window: null, until: null };
  }
  const blocking = report.windows.filter((w) => w.usedPercent >= atOrAbove);
  if (blocking.length === 0) return { blocked: false, window: null, until: null };
  const window = blocking.reduce((worst, w) => (w.usedPercent > worst.usedPercent ? w : worst));
  // The LAST reset among blocking windows: clearing the 5-hour window
  // while the weekly is still over means work still cannot start, so the
  // resume instant is the later of the two.
  const resets = blocking.map((w) => w.resetsAt).filter((t): t is number => t != null);
  const until = resets.length === blocking.length ? Math.max(...resets) : null;
  return { blocked: true, window, until };
}
