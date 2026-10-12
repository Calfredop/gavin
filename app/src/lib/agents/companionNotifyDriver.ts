// Drive Companion encrypted notifications from the desk.
//
// The desk decides what to notify: whatever newly waits on the human in
// the attention answer a Device's `GetAttention` is answered from
// (`attentionAnswer.ts`), under that answer's ids. One set of ids is what
// lets the phone clear a notification once its Workstation answers
// without the item, whether or not the resolve push arrived. The diff is
// `companionNotify.ts`'s; this module turns it into the daemon request,
// which seals each event for every Device that handed this Workstation a
// send permission and posts it to the Push gateway.
//
// Pure. `notifyDevices.ts` runs it, in the window holding the app's
// duties, as the attention answer is published.

import { companionNotifyDiff } from "$lib/agents/companionNotify";
import type { AttentionItem } from "$lib/companion/attentionAnswer";
import { featureBlockedReason, type DaemonCompat } from "$lib/core/daemonCompat";
import type { DeviceList } from "$lib/core/remoteAccess";

/// `protocol::CompanionNotifyTarget`: the variant is the tag, the field
/// keeps its snake_case name (`rename_all` renames variants only).
export type CompanionNotifyTargetWire =
  | { type: "session"; session_id: string }
  | { type: "card"; path: string };

/// `protocol::CompanionNotifyEvent`, spelled as the daemon reads it.
export type CompanionNotifyEventWire =
  | {
      op: "notify";
      id: string;
      kind: string;
      text: string;
      workspace_id: string;
      target: CompanionNotifyTargetWire;
    }
  | { op: "resolve"; id: string };

/// What to push, given the answer before and the answer now. With no
/// answer before -- this window's first, at launch or on taking the
/// duties over -- nothing: what already waited when the desk opened was
/// notified by the desk that saw it start, or is on the phone's inbox,
/// and a launch must not notify all of it again.
export function eventsFromAttention(
  previous: readonly AttentionItem[] | null,
  current: readonly AttentionItem[],
): CompanionNotifyEventWire[] {
  if (previous === null) return [];
  const diff = companionNotifyDiff(previous, current);
  return [
    ...diff.notify.map(eventFromItem),
    ...diff.resolve.map((id): CompanionNotifyEventWire => ({ op: "resolve", id })),
  ];
}

function eventFromItem(item: AttentionItem): CompanionNotifyEventWire {
  return {
    op: "notify",
    id: item.id,
    kind: item.kind,
    text: item.text,
    workspace_id: item.workspace,
    target:
      item.target.kind === "session"
        ? { type: "session", session_id: item.target.id }
        : { type: "card", path: item.target.path },
  };
}

/// Whether there is anybody to notify: remote access on, and a Push
/// gateway to post to. Without a gateway the daemon refuses the request,
/// and asking on every inbox change would only be refused every time.
export function notifyWanted(list: DeviceList | null): boolean {
  return Boolean(list?.remoteAccessEnabled && list.pushGatewayUrl);
}

/// Why the driver must not send, or null when it may.
export function companionNotifyBlocked(compat: DaemonCompat | null): string | null {
  return featureBlockedReason(compat, "companionNotifications");
}
