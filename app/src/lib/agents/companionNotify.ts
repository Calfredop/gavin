// What the Companion should be told about: the desk decides, the daemon
// encrypts, the phone decrypts. This module is only the deciding half —
// the attention-inbox triggers, a rail stopping, and "resolved" when an
// item leaves the waiting set (spec "Notifications"; security 06 §5.6).
//
// It does not send anything. A sibling driver will hand the diff to the
// daemon; the daemon seals each payload with that Device's notification
// key and posts it to the Push gateway.

/// Why the Companion should interrupt. Matches the attention-request
/// kinds the shell will merge (ticket 14), plus rail stops.
export type CompanionNotifyKind =
  | "asking"
  | "human-test"
  | "failed"
  | "interrupted"
  | "rail-stopped";

/// Where a tap should land. The attention request's target shape.
export type CompanionNotifyTarget =
  | { type: "session"; sessionId: string }
  | { type: "card"; path: string };

/// One waiting item, ready to seal into a push (or a "resolved" push
/// once it leaves the set).
export interface CompanionWaitingItem {
  id: string;
  workspaceId: string;
  kind: CompanionNotifyKind;
  /// Lock-screen text. Readable by design (story 28).
  text: string;
  target: CompanionNotifyTarget;
}

export interface CompanionNotifyDiff<T = CompanionWaitingItem> {
  /// Newly waiting, or the same id with different text/kind — push these.
  notify: T[];
  /// Were waiting and are gone — push "resolved" for each id.
  resolve: string[];
}

/// The attention-inbox reasons that become Companion notifies. Rail marks
/// like `turn-ended` / `stale` / `decoy-edit` stay on the desk inbox; the
/// phone is for the ones a human has to act on away from the keyboard.
const ATTENTION_NOTIFY_REASONS = new Set(["asking", "failed", "blocked"]);

export interface AttentionSignal {
  sessionId: string;
  workspaceId: string;
  reason: string;
  cardTitle: string | null;
  failureReason: string | null;
}

export interface HumanTestSignal {
  id: string;
  workspaceId: string;
  cardPath: string;
  text: string;
}

export interface RailStopSignal {
  railId: string;
  workspaceId: string;
  text: string;
  cardPath: string;
}

export interface CompanionNotifySignals {
  attention: readonly AttentionSignal[];
  humanTests: readonly HumanTestSignal[];
  railStops: readonly RailStopSignal[];
}

/// Diff the previous waiting set against the current one. Any item with an
/// id, a kind and a text: the live driver diffs the attention answer's
/// items (`companionNotifyDriver.ts`).
export function companionNotifyDiff<T extends { id: string; kind: string; text: string } = CompanionWaitingItem>(
  previous: readonly T[],
  current: readonly T[],
): CompanionNotifyDiff<T> {
  const prevById = new Map(previous.map((item) => [item.id, item]));
  const currById = new Map(current.map((item) => [item.id, item]));

  const notify: T[] = [];
  for (const item of current) {
    const was = prevById.get(item.id);
    if (!was || was.kind !== item.kind || was.text !== item.text) {
      notify.push(item);
    }
  }

  const resolve: string[] = [];
  for (const item of previous) {
    if (!currById.has(item.id)) resolve.push(item.id);
  }

  return { notify, resolve };
}

/// Build the current waiting set from the desk's live signals.
export function companionWaitingFromSignals(
  signals: CompanionNotifySignals,
): CompanionWaitingItem[] {
  const items: CompanionWaitingItem[] = [];

  for (const row of signals.attention) {
    if (!ATTENTION_NOTIFY_REASONS.has(row.reason)) continue;
    const kind: CompanionNotifyKind =
      row.reason === "asking" ? "asking" : row.reason === "failed" ? "failed" : "interrupted";
    items.push({
      id: `session:${row.sessionId}`,
      workspaceId: row.workspaceId,
      kind,
      text: attentionText(row),
      target: { type: "session", sessionId: row.sessionId },
    });
  }

  for (const test of signals.humanTests) {
    items.push({
      id: `human-test:${test.id}`,
      workspaceId: test.workspaceId,
      kind: "human-test",
      text: test.text,
      target: { type: "card", path: test.cardPath },
    });
  }

  for (const stop of signals.railStops) {
    items.push({
      id: `rail:${stop.railId}`,
      workspaceId: stop.workspaceId,
      kind: "rail-stopped",
      text: stop.text,
      target: { type: "card", path: stop.cardPath },
    });
  }

  return items;
}

function attentionText(row: AttentionSignal): string {
  if (row.reason === "asking") {
    return row.cardTitle ? `${row.cardTitle}: needs your input` : "needs your input";
  }
  if (row.reason === "failed") {
    return row.failureReason ?? (row.cardTitle ? `${row.cardTitle}: failed` : "failed");
  }
  // interrupted / blocked
  if (row.cardTitle && row.failureReason) return `${row.cardTitle}: ${row.failureReason}`;
  if (row.failureReason) return row.failureReason;
  if (row.cardTitle) return `${row.cardTitle}: stopped`;
  return "stopped";
}
