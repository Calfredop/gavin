// When a launch's resolved agent is over its usage-probe threshold, walk
// an ordered fallback chain instead of pausing — without rewriting the
// workspace's active agent. The workspace's own agent is tried first
// after the resolved one, so a card the complexity table still points at
// a spent CLI can run on the agent this workspace actually uses, even
// when nobody configured a chain.
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
// "Declined" is the set the human answered "Don't ask again" for: it is
// never offered for arming in that workspace, so the chain walks past it.

import type { AgentUsageReport } from "$lib/agents/agentUsage";
import { usageBlock, usageForLaunchGate } from "$lib/agents/agentUsage";

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

/// Shipped fallback threshold: leave a tenth of the window rather than
/// walking only when the pause's 95% fires. A missing or unusable stored
/// value reads as this, so an upgrade without the map keeps a margin.
export const DEFAULT_FALLBACK_THRESHOLD = 90;

export type FallbackThresholds = Record<string, number>;

/// The percent at which this profile is spent for a NEW launch.
/// Resume uses the pause cycle's `limitPercent`, not this.
export function fallbackThresholdFor(
  profileId: string,
  stored: FallbackThresholds | null | undefined
): number {
  const n = stored?.[profileId];
  if (typeof n === "number" && Number.isFinite(n) && n >= 1 && n <= 100) return n;
  return DEFAULT_FALLBACK_THRESHOLD;
}

/// Clamp a field the human just typed. Out-of-range becomes the default
/// rather than 0 or 101, which `fallbackThresholdFor` would ignore.
export function sanitizeFallbackThreshold(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_FALLBACK_THRESHOLD;
  return Math.min(100, Math.max(1, Math.round(n)));
}

/// An agent with no probe, a failed probe, or limits disabled is never
/// limit-spent — same posture `usageBlock` takes for "gavin cannot see".
export function agentLimitSpent(
  usage: AgentUsageReport | undefined,
  limitEnabled: boolean,
  limitPercent: number,
  profileId?: string | null
): boolean {
  if (!limitEnabled) return false;
  if (!usage) return false;
  return usageBlock(usageForLaunchGate(profileId, usage), limitPercent).blocked;
}

export type FallbackDecision =
  | { kind: "use"; profileId: string; viaFallback: boolean }
  | { kind: "arm"; profileId: string }
  | { kind: "pause"; why: "usage-limit" | "cycle" };

export interface LaunchDecisionInput {
  resolvedProfileId: string;
  /// The workspace's own agent. Tried after the resolved agent is spent
  /// and before the configured chain, so a card attributed to a spent CLI
  /// (the complexity table) still launches on the agent this workspace
  /// actually runs. Ignored when it is the resolved agent or on resume.
  workspaceProfileId?: string | null;
  chain: readonly string[];
  usageByProfile: Record<string, AgentUsageReport | undefined>;
  armed: ReadonlySet<string> | ((id: string) => boolean);
  /// Unarmed agents the human said not to ask about again in this
  /// workspace. The walk skips them rather than stalling on a setup
  /// wizard nobody will be shown. An armed one is still used.
  declined?: ReadonlySet<string>;
  limitEnabled: boolean;
  /// Pause-cycle percent. New launches ignore this in favour of each
  /// profile's `fallbackThresholds`; resume uses this so the leftover
  /// margin stays available for a conversation already in flight.
  limitPercent: number;
  fallbackThresholds?: FallbackThresholds | null;
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

  const percentFor = (id: string) =>
    input.resume
      ? input.limitPercent
      : fallbackThresholdFor(id, input.fallbackThresholds);
  const spent = (id: string) =>
    agentLimitSpent(input.usageByProfile[id], input.limitEnabled, percentFor(id), id);
  const primary = (input.resolvedProfileId ?? "").trim();

  if (input.resume) {
    if (spent(primary)) return { kind: "pause", why: "usage-limit" };
    return { kind: "use", profileId: primary, viaFallback: false };
  }

  if (!spent(primary)) {
    return { kind: "use", profileId: primary, viaFallback: false };
  }

  const workspace = (input.workspaceProfileId ?? "").trim();
  for (const id of sanitizeChain([workspace, ...input.chain])) {
    if (id === primary) continue;
    if (spent(id)) continue;
    // The workspace's own agent is armed by init / agent-change, not by
    // the fallback-arming list. Asking to set it up again would block the
    // one hop this field exists to make.
    if (id !== workspace && !isArmed(input.armed, id)) {
      if (input.declined?.has(id)) continue;
      return { kind: "arm", profileId: id };
    }
    return { kind: "use", profileId: id, viaFallback: true };
  }

  return { kind: "pause", why: "usage-limit" };
}

/// Agents this workspace still needs setup-only arming for: every chain
/// entry and every complexity-table profile, except the workspace's own
/// active profile (armed by init / agent-change) and any the human said
/// not to ask about again.
export function agentsOwedArming(input: {
  chain: readonly string[];
  complexityProfiles: readonly string[];
  armed: ReadonlySet<string>;
  declined?: ReadonlySet<string>;
  workspaceProfileId: string;
}): string[] {
  const skip = input.workspaceProfileId.trim();
  return sanitizeChain([...input.chain, ...input.complexityProfiles]).filter(
    (id) => id !== skip && !input.armed.has(id) && !input.declined?.has(id)
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
    : "work is paused: no remaining agent is under its usage limit";
}
