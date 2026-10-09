// Publish the Companion attention snapshot to the host so a Device's
// GetAttention is answered from where the signals live (ADR 0005).
//
// Fire-and-forget: a failed publish leaves the previous snapshot in
// place, which is better than clearing it on a transient invoke error.
//
// Each change is also what the desk notifies Devices of
// (`notifyDevices.ts`): the same items, under the same ids.

import { setCompanionAttention } from "$lib/core/backend";
import { notifyDevicesOf } from "$lib/companion/notifyDevices";
import {
  buildAttentionAnswer,
  type AttentionAnswerInput,
} from "$lib/companion/attentionAnswer";

let lastJson = "";

/// Rebuild the answer and push it to the host when it changed.
export function publishCompanionAttention(input: AttentionAnswerInput): void {
  const answer = buildAttentionAnswer(input);
  const json = JSON.stringify(answer.items);
  if (json === lastJson) return;
  lastJson = json;
  notifyDevicesOf(answer.items);
  void setCompanionAttention(answer.items).catch(() => {
    // Leave lastJson as the attempted value so a flapping error does not
    // spam retries; the next real change will republish.
  });
}

/// Test helper: clear the dedupe so the next publish always writes.
export function resetCompanionAttentionPublish(): void {
  lastJson = "";
}
