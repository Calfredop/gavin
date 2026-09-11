// When a launch's resolved agent is over its usage-probe threshold, walk
// an ordered fallback chain instead of pausing — without rewriting the
// workspace's active agent.
//
// Cycle pause is a hard hold on every new start. Limit pause is replaced
// by the chain when any later agent is under threshold. Resume of an
// existing conversation never walks: a Claude transcript cannot continue
// on Codex.
//
// Inheritance matches `agent_pause`: a workspace's absent chain means
// inherit the app-wide one; an empty array is an explicit "no fallback"
// override. "Armed" is a set the workspace records after setup-only
// Integration/Superpowers for that profile — the workspace's own active
// profile is treated as armed by the init/switch wizard, not this list.

import type { AgentUsageReport } from "$lib/agents/agentUsage";
import { usageBlock } from "$lib/agents/agentUsage";

/// Ordered profile ids. Empty means no fallback (pause-only).
export type FallbackChain = string[];

/// Drop blanks and duplicates, keep first-seen order.
export function sanitizeChain(ids: readonly string[] | null | undefined): FallbackChain {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of ids ?? []) {
    const id = raw.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/// Workspace override if present (including empty), else the app chain.
export function effectiveFallbackChain(
  workspaceChain: FallbackChain | null | undefined,
  appChain: FallbackChain | null | undefined
): FallbackChain {
  if (workspaceChain != null) return sanitizeChain(workspaceChain);
  return sanitizeChain(appChain);
}

/// Profile ids in `after` that were not in `before`. Used to open arming
/// only for agents just added to a workspace chain, not for a reorder.
export function newlyAddedToChain(before: readonly string[], after: readonly string[]): string[] {
  const have = new Set(sanitizeChain(before));
  return sanitizeChain(after).filter((id) => !have.has(id));
}

/// An agent with no probe, a failed probe, or limits disabled is never
/// limit-spent — same posture `usageBlock` takes for "gavin cannot see".
export function agentLimitSpent(
  usage: AgentUsageReport | undefined,
  limitEnabled: boolean,
  limitPercent: number
): boolean {
  if (!limitEnabled) return false;
  if (!usage) return false;
  return usageBlock(usage, limitPercent).blocked;
}

export type FallbackDecision =
  | { kind: "use"; profileId: string; viaFallback: boolean }
  | { kind: "arm"; profileId: string }
  | { kind: "pause"; why: "usage-limit" | "cycle" };

export interface LaunchDecisionInput {
  resolvedProfileId: string;
  chain: readonly string[];
  usageByProfile: Record<string, AgentUsageReport | undefined>;
  armed: ReadonlySet<string> | ((id: string) => boolean);
  limitEnabled: boolean;
  limitPercent: number;
  cyclePaused: boolean;
  /// Reopening the same conversation. The chain does not apply.
  resume: boolean;
}

function isArmed(
  armed: LaunchDecisionInput["armed"],
  id: string
): boolean {
  return typeof armed === "function" ? armed(id) : armed.has(id);
}

/// Which agent a NEW launch should use, or why it must wait.
export function decideLaunch(input: LaunchDecisionInput): FallbackDecision {
  if (input.cyclePaused) return { kind: "pause", why: "cycle" };

  const spent = (id: string) =>
    agentLimitSpent(input.usageByProfile[id], input.limitEnabled, input.limitPercent);
  const primary = (input.resolvedProfileId ?? "").trim();

  if (input.resume) {
    if (spent(primary)) return { kind: "pause", why: "usage-limit" };
    return { kind: "use", profileId: primary, viaFallback: false };
  }

  if (!spent(primary)) {
    return { kind: "use", profileId: primary, viaFallback: false };
  }

  for (const id of sanitizeChain(input.chain)) {
    if (id === primary) continue;
    if (spent(id)) continue;
    if (!isArmed(input.armed, id)) return { kind: "arm", profileId: id };
    return { kind: "use", profileId: id, viaFallback: true };
  }

  return { kind: "pause", why: "usage-limit" };
}

/// Agents this workspace still needs setup-only arming for: every chain
/// entry and every complexity-table profile, except the workspace's own
/// active profile (armed by init / agent-change).
export function agentsOwedArming(input: {
  chain: readonly string[];
  complexityProfiles: readonly string[];
  armed: ReadonlySet<string>;
  workspaceProfileId: string;
}): string[] {
  const skip = input.workspaceProfileId.trim();
  return sanitizeChain([...input.chain, ...input.complexityProfiles]).filter(
    (id) => id !== skip && !input.armed.has(id)
  );
}

/// Sentence for a hold the chain produced. Null while the launch may go.
export function fallbackBlockedReason(decision: FallbackDecision): string | null {
  if (decision.kind === "use") return null;
  if (decision.kind === "arm") {
    return `work is waiting: ${decision.profileId} is next in the fallback chain and is not set up in this workspace yet`;
  }
  return decision.why === "cycle"
    ? null
    : "work is paused: every agent in the fallback chain is at its usage limit";
}
