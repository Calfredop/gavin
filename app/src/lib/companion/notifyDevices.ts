// Runs `companionNotifyDriver.ts` as the attention answer is published.
//
// Every window keeps the answer before, so a window that takes the app's
// duties over has one to diff against; only the window holding them asks
// the daemon -- every window publishes the same answer, and two would
// notify the phone twice.
//
// A change is acted on once the answer has held still for `SETTLE_MS`: an
// agent that is waiting for a moment and then working again, or a card
// rewritten twice in a row, is one notification or none, never a
// notification and its resolve a breath apart.
import { get } from "svelte/store";
import * as backend from "$lib/core/backend";
import { daemonCompat } from "$lib/core/layoutState";
import { deviceList } from "$lib/core/devicesState";
import { holdsAppDutiesNow } from "$lib/shell/appDuty";
import type { AttentionItem } from "$lib/companion/attentionAnswer";
import {
  companionNotifyBlocked,
  eventsFromAttention,
  notifyWanted,
} from "$lib/agents/companionNotifyDriver";

export const SETTLE_MS = 3_000;

/// What the last settled answer was; null until the first one settles.
let previous: AttentionItem[] | null = null;
let latest: AttentionItem[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

/// The attention answer changed to `items`.
export function notifyDevicesOf(items: readonly AttentionItem[]): void {
  latest = [...items];
  if (timer !== null) clearTimeout(timer);
  timer = setTimeout(settle, SETTLE_MS);
}

function settle(): void {
  timer = null;
  const events = eventsFromAttention(previous, latest);
  previous = latest;
  if (events.length === 0 || !holdsAppDutiesNow()) return;
  if (companionNotifyBlocked(get(daemonCompat)) !== null || !notifyWanted(get(deviceList))) return;
  void backend.pushCompanionNotify(events).catch((e) => {
    // A notification missed is not worth a dialog: the phone's inbox is
    // right whenever it is opened.
    console.warn(`[companion-notify] ${e instanceof Error ? e.message : String(e)}`);
  });
}

/// Test helper: forget the answer before, and anything waiting to settle.
export function resetNotifyDevices(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  previous = null;
  latest = [];
}
