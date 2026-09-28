// Drive Companion encrypted notifications from the desk.
//
// The pure module (`companionNotify.ts`) decides what to notify and what
// to resolve; this module turns that diff into the daemon request. It
// does not fetch signals itself — a caller hands it previous and current
// waiting sets (or a ready-made diff).

import {
  companionNotifyDiff,
  type CompanionNotifyDiff,
  type CompanionWaitingItem,
} from "$lib/agents/companionNotify";
import { featureBlockedReason, type DaemonCompat } from "$lib/core/daemonCompat";

export type CompanionNotifyTargetWire =
  | { type: "session"; sessionId: string }
  | { type: "card"; path: string };

export type CompanionNotifyEventWire =
  | {
      op: "notify";
      id: string;
      kind: string;
      text: string;
      workspaceId: string;
      target: CompanionNotifyTargetWire;
    }
  | { op: "resolve"; id: string };

export function eventsFromDiff(diff: CompanionNotifyDiff): CompanionNotifyEventWire[] {
  const events: CompanionNotifyEventWire[] = [];
  for (const item of diff.notify) {
    events.push(eventFromItem(item));
  }
  for (const id of diff.resolve) {
    events.push({ op: "resolve", id });
  }
  return events;
}

export function eventsFromWaitingSets(
  previous: readonly CompanionWaitingItem[],
  current: readonly CompanionWaitingItem[],
): CompanionNotifyEventWire[] {
  return eventsFromDiff(companionNotifyDiff(previous, current));
}

function eventFromItem(item: CompanionWaitingItem): CompanionNotifyEventWire {
  return {
    op: "notify",
    id: item.id,
    kind: item.kind,
    text: item.text,
    workspaceId: item.workspaceId,
    target:
      item.target.type === "session"
        ? { type: "session", sessionId: item.target.sessionId }
        : { type: "card", path: item.target.path },
  };
}

/// Why the driver must not send, or null when it may.
export function companionNotifyBlocked(compat: DaemonCompat | null): string | null {
  return featureBlockedReason(compat, "companionNotifications");
}
