// A card's run history, said in words. The pure half of the per-card
// runs panel: what the daemon's rows MEAN, how a chain of resumes reads
// as one piece of work, and what a run cost. The store that fetches and
// the component that renders sit on top of this (runHistoryState.ts,
// RunHistoryModal.svelte).
//
// Two rules run through every string here.
//
// **An unknown is never a zero.** A run whose end nobody watched has no
// duration, not a duration of nothing; a profile whose transcript gavin
// cannot read has no cost, not a cost of zero tokens. Both collapse into
// a number that looks authoritative, which is the one thing a history
// nobody can check must not produce.
//
// **A resume is the same work continuing.** Gavin resumes a card into a
// NEW session carrying the previous run's conversation id, so the daemon
// files it as a new run -- correctly, since it is a new session. Reading
// that back as a second attempt at the card would tell somebody they ran
// it twice when they pressed Resume once.

import { featureBlockedReason, type DaemonCompat } from "$lib/core/daemonCompat";

/// One run of a card. Mirrors `CardRun` in the protocol crate.
export interface CardRun {
  id: number;
  path: string;
  sessionId: string;
  command: string | null;
  conversationId: string | null;
  launchCwd: string | null;
  baseSha: string | null;
  /// Epoch SECONDS, not milliseconds -- the daemon's clock. Everything
  /// here converts at the edge rather than carrying two units around.
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
  outcome: string;
  resumeAttempts: number | null;
}

/// What one run cost. Mirrors `TokenTotals` in `agent_tokens.rs`.
export interface TokenTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  turns: number;
}

/// Mirrors `TokenReport` in `agent_tokens.rs`. `unsupported` is an
/// ordinary state of a profile; `unavailable` is a surprise.
export type TokenReport =
  | { kind: "ready"; totals: TokenTotals; models: string[] }
  | { kind: "unsupported"; reason: string }
  | { kind: "unavailable"; reason: string };

const MINUTE = 60;
const HOUR = 60 * MINUTE;

/// A duration in seconds, at the coarsest honest resolution: "38s",
/// "4m", "1h 12m". Never "0m" -- a run that took nine seconds took nine
/// seconds, and rounding it to nothing is how a panel of quick runs
/// becomes a column of zeroes.
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  if (seconds < MINUTE) return `${Math.max(1, Math.round(seconds))}s`;
  if (seconds < HOUR) return `${Math.floor(seconds / MINUTE)}m`;
  const hours = Math.floor(seconds / HOUR);
  const minutes = Math.floor((seconds % HOUR) / MINUTE);
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

/// A token count, short enough to sit in a row: "812", "41.2k", "1.4M".
/// Thousands separators would be exact and unreadable at four numbers
/// per row; the exact figure belongs in the title attribute.
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1000) return `${Math.round(n)}`;
  if (n < 1_000_000) {
    const k = n / 1000;
    return `${k < 10 ? k.toFixed(1) : Math.round(k)}k`;
  }
  const m = n / 1_000_000;
  return `${m < 10 ? m.toFixed(1) : Math.round(m)}M`;
}

/// How long a run lasted, in seconds -- or null when nobody can say.
///
/// Three cases, and the third is the one that matters: a run that is
/// still going measures against `now`; a run that ended measures against
/// its recorded end; and a run whose end was never observed
/// (`abandoned`) has NO duration. Measuring that one against now would
/// report a run that stopped days ago as a three-day session.
export function runSeconds(run: CardRun, nowSeconds: number): number | null {
  if (run.endedAt !== null) return Math.max(0, run.endedAt - run.startedAt);
  if (run.outcome === "running") return Math.max(0, nowSeconds - run.startedAt);
  return null;
}

/// What became of this run, in a sentence. Every branch names something
/// observed: the vocabulary has no "failed" because the daemon does not
/// know that -- it knows an exit code.
export function outcomeSentence(run: CardRun): string {
  switch (run.outcome) {
    case "running":
      return "Still running.";
    case "exited":
      if (run.exitCode === null) return "The session ended.";
      return run.exitCode === 0
        ? "The session ended cleanly."
        : `The session ended with exit code ${run.exitCode}.`;
    case "replaced":
      return "A later run took over this card.";
    case "unlinked":
      return "The card was unbound from this session, which may have carried on running.";
    case "abandoned":
      return "Gavin stopped watching this run — the daemon restarted, or nothing was attached when it ended. Its end was not recorded.";
    default:
      return "Gavin has no record of how this run ended.";
  }
}

/// The short word a badge carries. Deliberately not the same strings as
/// the daemon's `outcome`: "replaced" is jargon for a state the human
/// experienced as pressing Re-launch.
export function outcomeLabel(run: CardRun): string {
  switch (run.outcome) {
    case "running":
      return "Running";
    case "exited":
      return run.exitCode === null || run.exitCode === 0 ? "Finished" : `Exit ${run.exitCode}`;
    case "replaced":
      return "Superseded";
    case "unlinked":
      return "Unbound";
    case "abandoned":
      return "Unwatched";
    default:
      return "Unknown";
  }
}

/// The agent behind a run, off the command it was launched with:
/// "claude", "codex". Null when no command was recorded -- and null
/// rather than a guess, because the profile a run used is not
/// recoverable from anything else on the row.
export function agentLabel(run: CardRun): string | null {
  const command = run.command?.trim();
  if (!command) return null;
  const first = command.split(/\s+/)[0] ?? "";
  const base = first.split("/").pop() ?? first;
  return base || null;
}

export interface RunRow {
  run: CardRun;
  /// 1-based, oldest first, and SHARED by every session in one resume
  /// chain: pressing Resume does not start a second run of the card.
  number: number;
  /// Which session this is within its chain, 1-based. 1 for a run
  /// nobody resumed, so a row only ever says "resume 2" when there
  /// genuinely was one.
  attempt: number;
  /// True when this row continues the conversation of the run before
  /// it.
  resumed: boolean;
  label: string;
  outcome: string;
  outcomeText: string;
  agent: string | null;
  /// Seconds, or null when the run's end was never observed.
  seconds: number | null;
  duration: string | null;
}

/// Shape the daemon's rows into what the panel renders, NEWEST FIRST.
///
/// `runs` arrives newest first (the daemon orders by row id descending)
/// and comes back in that order; the chain walk runs oldest-first
/// underneath, because a chain is defined by what came BEFORE a run.
///
/// Two runs are one chain when they share a conversation id AND are
/// adjacent in time. Adjacency is the part that is easy to drop and
/// wrong to drop: a conversation resumed, superseded by fresh work, then
/// resumed again is two pieces of work, and merging them on the id alone
/// would file the newer one under the older one's number.
export function runRows(runs: CardRun[], nowSeconds: number): RunRow[] {
  const oldestFirst = [...runs].reverse();
  const rows: RunRow[] = [];
  let number = 0;
  let attempt = 0;
  let previousConversation: string | null = null;

  for (const run of oldestFirst) {
    const conversation = run.conversationId ?? null;
    const resumed = conversation !== null && conversation === previousConversation;
    if (resumed) {
      attempt += 1;
    } else {
      number += 1;
      attempt = 1;
    }
    previousConversation = conversation;

    const seconds = runSeconds(run, nowSeconds);
    rows.push({
      run,
      number,
      attempt,
      resumed,
      label: resumed ? `Run ${number} · resume ${attempt - 1}` : `Run ${number}`,
      outcome: outcomeLabel(run),
      outcomeText: outcomeSentence(run),
      agent: agentLabel(run),
      seconds,
      duration: seconds === null ? null : formatDuration(seconds),
    });
  }
  return rows.reverse();
}

/// The one line the card modal's Runs row carries: "3 runs · 1h 12m".
///
/// The time is a sum of the runs that CAN be measured, and the count
/// says how many those are when some cannot -- "3 runs · 1h 12m over 2".
/// Silently summing the measurable ones and presenting the total as the
/// card's would under-report by exactly the runs nobody watched.
export function historySummary(runs: CardRun[], nowSeconds: number): string {
  if (runs.length === 0) return "No runs yet";
  const rows = runRows(runs, nowSeconds);
  const measured = rows.filter((r) => r.seconds !== null);
  const total = measured.reduce((sum, r) => sum + (r.seconds ?? 0), 0);
  const chains = rows.length === 0 ? 0 : Math.max(...rows.map((r) => r.number));
  const parts = [`${chains} run${chains === 1 ? "" : "s"}`];
  if (rows.length > chains) parts.push(`${rows.length} sessions`);
  if (measured.length > 0) {
    parts.push(
      measured.length === rows.length
        ? formatDuration(total)
        : `${formatDuration(total)} over ${measured.length}`
    );
  }
  return parts.join(" · ");
}

/// Why the run history cannot be shown, or null when it can.
///
/// The daemon-version case says what it says on purpose: an older daemon
/// kept no history at all, because `card_sessions` is upserted and every
/// run but the last was overwritten. "There is no history" is true of
/// the daemon, not of the card, and the panel must not let the human
/// read it the other way.
export function historyBlockedReason(compat: DaemonCompat | null): string | null {
  const blocked = featureBlockedReason(compat, "runHistory");
  if (!blocked) return null;
  return `Gavin only started keeping a card's run history in daemon v27. ${blocked}`;
}

/// The one line a loaded token report reduces to: "412k tokens · 14
/// turns". Null when the report is not a reading -- the reason goes
/// through `tokenProblem` instead, so a panel never renders a cost and
/// an excuse in the same slot.
export function tokenSummary(report: TokenReport | null): string | null {
  if (!report || report.kind !== "ready") return null;
  const parts = [`${formatTokens(report.totals.totalTokens)} tokens`];
  if (report.totals.turns > 0) {
    parts.push(`${report.totals.turns} turn${report.totals.turns === 1 ? "" : "s"}`);
  }
  return parts.join(" · ");
}

/// Thousands-grouped, in the app's own language rather than the
/// machine's. `toLocaleString()` with no argument reads the OS locale,
/// which on an Italian machine renders 402000 as "402.000" -- a decimal
/// point to every English reader of the sentence it is embedded in, and
/// a suite that passes or fails depending on whose laptop runs it.
function grouped(n: number): string {
  return n.toLocaleString("en-US");
}

/// The breakdown behind that line, for a title attribute: exact figures,
/// because the summary above is deliberately rounded.
export function tokenBreakdown(report: TokenReport | null): string | null {
  if (!report || report.kind !== "ready") return null;
  const t = report.totals;
  const rows = [
    `Input ${grouped(t.inputTokens)}`,
    `Output ${grouped(t.outputTokens)}`,
    `Cache read ${grouped(t.cacheReadTokens)}`,
    `Cache write ${grouped(t.cacheWriteTokens)}`,
  ];
  if (report.models.length > 0) rows.push(report.models.join(", "));
  return rows.join(" · ");
}

/// Why this run has no cost to show, or null when it does. Kept separate
/// from `tokenSummary` for the same reason `changesProblem` is separate
/// from `changesSummary`: these are sentences, not numbers, and a slot
/// that renders either will eventually render "0 tokens" for one of
/// them.
export function tokenProblem(report: TokenReport | null): string | null {
  if (!report) return null;
  return report.kind === "ready" ? null : report.reason;
}

/// What the whole card cost, summed over the runs whose transcripts were
/// readable -- and how many those were, whenever it is not all of them.
/// Null when nothing could be read at all: a total of zero over zero
/// runs is not a fact about the card.
export function totalCost(reports: Array<TokenReport | null>): string | null {
  const ready = reports.filter(
    (r): r is Extract<TokenReport, { kind: "ready" }> => r?.kind === "ready"
  );
  if (ready.length === 0) return null;
  const total = ready.reduce((sum, r) => sum + r.totals.totalTokens, 0);
  const label = `${formatTokens(total)} tokens`;
  return ready.length === reports.length
    ? label
    : `${label} over ${ready.length} of ${reports.length} runs`;
}
