// The Headroom exception mark: which of a compressed workspace's sessions
// are NOT compressed, and why (spec, "Failures").
//
// A compressed session carries no mark. In a workspace with compression
// on that is every agent tab, and a badge on every one of them would be
// noise; what the human needs to see is the exception. There are three,
// and only three:
//
// - `not-ready`     Headroom was not ready when the session launched, so
//                   it went ahead without it (compression never stops a
//                   launch).
// - `relaunched`    it broke on Headroom, and auto-resume put it back
//                   without Headroom (`headroom-failed`).
// - `not-reaching`  it IS routed through Headroom, and a turn ended with
//                   Headroom having seen none of its requests: the agent
//                   CLI is talking to its model some other way.
//
// Every other reason the daemon gives is not an exception on a tab. An
// agent gavin cannot route (`unsupported-agent`, Cursor) or has no recipe
// for (`no-recipe`) is uncompressed every time, by design, and Settings
// says so beside its row; marking every one of its tabs would be the same
// noise the rule exists to avoid.
//
// Pure: the state lives in headroomMarkState.ts, the asking in
// headroomReachDriver.ts, and the badge in ui/indicators.ts.

import type { SessionStatus } from "$lib/core/notifications";

/// What Headroom has been found to have seen of a compressed session.
/// `unknown` is not stored: an answer that could not be told changes
/// nothing that was known (`withReach`).
export type HeadroomReach = "reached" | "unreached";

/// What the daemon decided about one session as it spawned it, and what
/// was found out later. `uncompressedReason` is the daemon's own word,
/// kept as written: a reason a newer daemon invents reaches here intact,
/// and simply marks nothing.
export interface SessionCompression {
  compressed: boolean;
  uncompressedReason: string | null;
  reach: HeadroomReach | null;
}

/// The three exceptions a tab can be marked with.
export type HeadroomException = "not-ready" | "relaunched" | "not-reaching";

/// The daemon's word for a session's reach, read for this build. A word
/// it does not know is `unknown`, for the reason `parseSessionStatus`
/// refuses to guess: it must never fall into a branch that marks.
export function parseReach(word: unknown): HeadroomReach | "unknown" {
  return word === "reached" || word === "unreached" ? word : "unknown";
}

/// A session's compression, read off what the daemon handed back with it
/// (`session-compression`, a session baseline). Anything that is not a
/// boolean reads as not compressed, and a reason that is not a word as
/// none.
export function sessionCompressionFrom(raw: {
  compressed?: unknown;
  uncompressedReason?: unknown;
  headroomReach?: unknown;
}): SessionCompression {
  const reach = parseReach(raw.headroomReach);
  return {
    compressed: raw.compressed === true,
    uncompressedReason:
      typeof raw.uncompressedReason === "string" && raw.uncompressedReason.trim()
        ? raw.uncompressedReason
        : null,
    reach: reach === "unknown" ? null : reach,
  };
}

/// `current` with an answer about its reach folded in. `unknown` keeps
/// what was known -- Headroom not answering, or restarted, says nothing
/// about a session already found either way -- and a session nothing is
/// known about stays unknown.
export function withReach(
  current: SessionCompression | undefined,
  reach: HeadroomReach | "unknown"
): SessionCompression | undefined {
  if (!current || reach === "unknown" || current.reach === reach) return current;
  return { ...current, reach };
}

/// The mark on a session's tab, or null for none.
///
/// `workspaceCompressed` is the workspace's effective setting as it is
/// NOW. The reason was written when the session launched, while the
/// switch was on; a human who has since turned it off has said
/// uncompressed is what they want, and a mark saying otherwise would be a
/// claim about a setting that no longer holds.
export function headroomException(
  compression: SessionCompression | undefined,
  workspaceCompressed: boolean
): HeadroomException | null {
  if (!compression || !workspaceCompressed) return null;
  if (compression.compressed) return compression.reach === "unreached" ? "not-reaching" : null;
  switch (compression.uncompressedReason) {
    case "not-ready":
      return "not-ready";
    case "headroom-failed":
      return "relaunched";
    default:
      return null;
  }
}

/// Everything that decides whether a turn that just ended is worth asking
/// Headroom about.
export interface ReachCheckInput {
  previousStatus: SessionStatus | undefined;
  status: SessionStatus;
  compression: SessionCompression | undefined;
  /// The session is gavin's work -- bound to a card run or standing
  /// behind a rail step -- rather than a terminal the human opened.
  run: boolean;
  /// A conversation that was REOPENED (resume, review) and has not been
  /// submitted to: what went quiet was the history being painted or the
  /// human pausing mid-sentence, not a turn.
  reopenedPaint: boolean;
  /// Why the daemon cannot be asked, or null when it can
  /// (`featureBlockedReason(compat, "headroomFailures")`).
  blocked: string | null;
}

/// Whether to ask the daemon if this session is reaching Headroom.
///
/// Only when a TURN ended: the session went quiet after working. Only for
/// a compressed session not already found to reach Headroom -- once it
/// has, it has. And only for a run, whose launch handed its agent a
/// prompt, so the first time it goes quiet the model has been asked
/// something: a terminal the human opened goes quiet after painting its
/// welcome screen, and again every time the human pauses mid-sentence,
/// and "Headroom has seen nothing" is true and means nothing at either.
/// A reopened conversation is a run with no prompt: it is passed over the
/// same way, at every quiet, until a line has been submitted to it.
///
/// A session that was not compressed is never asked about: its reason is
/// its mark, and Headroom has nothing of it to have seen.
export function reachCheckDue(input: ReachCheckInput): boolean {
  if (input.blocked) return false;
  if (input.previousStatus !== "working" || input.status !== "idle") return false;
  if (!input.run || input.reopenedPaint) return false;
  const compression = input.compression;
  return compression?.compressed === true && compression.reach !== "reached";
}
