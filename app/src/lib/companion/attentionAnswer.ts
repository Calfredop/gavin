// The Companion attention answer: what a Device's GetAttention asks for
// (ADR 0005), built where the signals live.
//
// Pure: no stores, no I/O. The desktop's Forward connection hands the
// result of this module back as AttentionResult; unit tests drive it from
// the same inputs the live surfaces already keep filled (the attention
// inbox — which already folds the turn verdict in — open human tests, and
// stopped rails).

import {
  REASON_LABEL,
  type AttentionReason,
  type AttentionRow,
} from "$lib/agents/attentionInbox";
import { humanItemWaiting } from "$lib/decisions/decisions";
import type { HumanItem, PlanFileInfo } from "$lib/core/gavin";
import {
  railStateOf,
  type Orchestration,
  type Rail,
} from "$lib/orchestration/orchestration";

/// Matches `protocol::ATTENTION_API_VERSION`. The shell pins this; the
/// answer only ever grows by optional fields.
export const ATTENTION_API_VERSION = 1;

export type AttentionKind =
  | "waiting"
  | "human-test"
  | "failed"
  | "interrupted"
  | "rail-stopped";

export type AttentionTarget =
  | { kind: "session"; id: string }
  | { kind: "card"; path: string };

export interface AttentionItem {
  id: string;
  workspace: string;
  kind: AttentionKind;
  text: string;
  target: AttentionTarget;
}

export interface AttentionAnswer {
  version: number;
  items: AttentionItem[];
}

/// An open `Human test:` still waiting on the human.
export interface HumanTestWaiting {
  workspaceId: string;
  cardPath: string;
  lineIndex: number;
  text: string;
}

/// An interrupted agent — the inbox skips these on purpose (the status
/// after an interrupt describes the bare shell), so the Companion list
/// has to take them from the interrupted set itself.
export interface InterruptedWaiting {
  workspaceId: string;
  sessionId: string;
  /// Short label for the row; falls back to the session id.
  text?: string;
}

/// A rail that has stopped and wants a look (paused).
export interface StoppedRail {
  workspaceId: string;
  railId: string;
  name: string;
  /// Where tapping lands — a step's session or card when the rail has
  /// one; the shell uses `kind` + `id` together with this.
  target: AttentionTarget;
}

export interface AttentionAnswerInput {
  /// Sessions waiting on the human, from `attentionInbox` (verdict
  /// already folded in).
  inbox: readonly AttentionRow[];
  humanTests?: readonly HumanTestWaiting[];
  interrupted?: readonly InterruptedWaiting[];
  stoppedRails?: readonly StoppedRail[];
}

/// Build the attention answer the Device's GetAttention receives when
/// the desktop is ready.
export function buildAttentionAnswer(input: AttentionAnswerInput): AttentionAnswer {
  const items: AttentionItem[] = [];
  const seen = new Set<string>();

  for (const row of input.inbox) {
    const item = fromInboxRow(row);
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    items.push(item);
  }

  for (const test of input.humanTests ?? []) {
    const id = `human-test:${test.cardPath}:${test.lineIndex}`;
    if (seen.has(id)) continue;
    seen.add(id);
    items.push({
      id,
      workspace: test.workspaceId,
      kind: "human-test",
      text: test.text,
      target: { kind: "card", path: test.cardPath },
    });
  }

  for (const row of input.interrupted ?? []) {
    const id = `interrupted:${row.sessionId}`;
    if (seen.has(id)) continue;
    seen.add(id);
    items.push({
      id,
      workspace: row.workspaceId,
      kind: "interrupted",
      text: row.text?.trim() || row.sessionId,
      target: { kind: "session", id: row.sessionId },
    });
  }

  for (const rail of input.stoppedRails ?? []) {
    const id = `rail-stopped:${rail.railId}`;
    if (seen.has(id)) continue;
    seen.add(id);
    items.push({
      id,
      workspace: rail.workspaceId,
      kind: "rail-stopped",
      text: rail.name.trim() || rail.railId,
      target: rail.target,
    });
  }

  return { version: ATTENTION_API_VERSION, items };
}

/// Open human tests on a card, for the attention answer.
export function humanTestsOnPlan(
  workspaceId: string,
  plan: PlanFileInfo
): HumanTestWaiting[] {
  const items = plan.humanItems ?? [];
  return items
    .filter((item): item is HumanItem => item.kind === "test" && humanItemWaiting(item))
    .map((item) => ({
      workspaceId,
      cardPath: plan.path,
      lineIndex: item.lineIndex,
      text: item.text,
    }));
}

/// Every paused rail in an orchestration — the "rail stopped" kind.
///
/// `targetFor` picks where the phone should land for that rail (a step's
/// session or card). Rails without a target are skipped: the wire only
/// carries a session or a card.
export function stoppedRailsIn(
  workspaceId: string,
  orch: Orchestration | null | undefined,
  targetFor: (rail: Rail) => AttentionTarget | null
): StoppedRail[] {
  if (!orch) return [];
  const out: StoppedRail[] = [];
  for (const rail of orch.rails) {
    if (railStateOf(orch, rail.id) !== "paused") continue;
    const target = targetFor(rail);
    if (!target) continue;
    out.push({
      workspaceId,
      railId: rail.id,
      name: rail.name,
      target,
    });
  }
  return out;
}

function fromInboxRow(row: AttentionRow): AttentionItem {
  const kind = kindForReason(row.reason);
  const id = `${kind}:${row.sessionId}`;
  const text =
    row.cardTitle?.trim() ||
    row.failureReason?.trim() ||
    `${row.tabName} — ${REASON_LABEL[row.reason]}`;
  return {
    id,
    workspace: row.workspaceId,
    kind,
    text,
    target: row.cardPath
      ? { kind: "card", path: row.cardPath }
      : { kind: "session", id: row.sessionId },
  };
}

function kindForReason(reason: AttentionReason): AttentionKind {
  if (reason === "failed") return "failed";
  return "waiting";
}
