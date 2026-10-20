// The sidebar Usage row's per-agent badges.
//
// One badge per linked agent (whatever `profilesInUse` lists), wearing that
// agent's letter avatar and coloured by its own usage semaphore — not the
// fleet-worst hourglass the row used to carry alone. The avatar is a
// progressive prefix of the display name so two agents that share a first
// letter (Claude Code, Codex) become Cl and Co rather than a pair of C's.
//
// Pure: StatusBadge and the Svelte row only render what this module decides.

import {
  projectionTooltip,
  worstProjection,
  type UsageProjection,
} from "$lib/agents/usageProjection";
import type { IndicatorTone } from "$lib/ui/indicators";
import { usageProjectionIndicator } from "$lib/ui/indicators";

export interface UsageAgentRef {
  id: string;
  label: string;
}

export interface UsageRowBadge {
  profileId: string;
  /// Collision-resolved letter avatar ("Cl", "Co", …).
  avatar: string;
  label: string;
  tone: IndicatorTone;
  tip: string;
  /// True when any live session attributed to this profile is `working`.
  running: boolean;
}

/// Letters and digits from a label, in order. Spaces and punctuation drop
/// out so "Claude Code" abbreviates the same way as "ClaudeCode".
function letterSource(label: string): string {
  let out = "";
  for (const ch of label) {
    if (/[a-zA-Z0-9]/.test(ch)) out += ch;
  }
  return out;
}

function avatarPrefix(letters: string, length: number): string {
  if (!letters) return "?";
  const n = Math.max(1, Math.min(length, letters.length));
  const raw = letters.slice(0, n);
  return raw[0].toUpperCase() + raw.slice(1);
}

/// One avatar per agent. Starts at one letter and grows colliding ones
/// until the set is unique, or until a name has no more letters to spend
/// (two identical labels stay identical — there is nothing left to add).
export function agentAvatarLabels(agents: readonly UsageAgentRef[]): Record<string, string> {
  const sources = agents.map((a) => {
    const fromLabel = letterSource(a.label);
    const fromId = letterSource(a.id);
    return { id: a.id, letters: fromLabel || fromId || "?" };
  });
  const length = new Map<string, number>();
  for (const s of sources) length.set(s.id, 1);

  let grew = true;
  while (grew) {
    grew = false;
    const byAvatar = new Map<string, string[]>();
    for (const s of sources) {
      const avatar = avatarPrefix(s.letters, length.get(s.id) ?? 1);
      const list = byAvatar.get(avatar) ?? [];
      list.push(s.id);
      byAvatar.set(avatar, list);
    }
    for (const ids of byAvatar.values()) {
      if (ids.length < 2) continue;
      for (const id of ids) {
        const s = sources.find((x) => x.id === id);
        if (!s) continue;
        const cur = length.get(id) ?? 1;
        if (cur < s.letters.length) {
          length.set(id, cur + 1);
          grew = true;
        }
      }
    }
  }

  const out: Record<string, string> = {};
  for (const s of sources) {
    out[s.id] = avatarPrefix(s.letters, length.get(s.id) ?? 1);
  }
  return out;
}

/// Basename of the launch line's first token, lowercased. Paths and a
/// Windows `.exe` drop off so `/usr/local/bin/claude` and `claude.exe`
/// both read as `claude`. Only the argv0 — never the rest of the line —
/// so a prompt that happens to mention another agent cannot re-attribute
/// the session (the trap that kept memoryState off command matching).
export function commandArgv0(command: string): string {
  const token = command.trim().split(/\s+/)[0] ?? "";
  const base = token.split(/[/\\]/).pop() ?? token;
  return base.replace(/\.(exe|cmd|bat)$/i, "").toLowerCase();
}

/// Which profile launched a session, by matching the session's argv0 to
/// a profile's own command argv0 (`claude`, `agent`, `codex`, …). Null
/// when nothing matches — including a bare shell — rather than guessing
/// the workspace default, which is what made Claude's badge pulse while
/// a Cursor session was the one actually working.
export function profileIdForCommand(
  command: string | null | undefined,
  profiles: readonly { id: string; command: string }[]
): string | null {
  if (!command?.trim()) return null;
  const want = commandArgv0(command);
  if (!want) return null;
  for (const p of profiles) {
    if (!p.command.trim()) continue;
    if (commandArgv0(p.command) === want) return p.id;
  }
  return null;
}

/// Profile ids with at least one `working` session. `profileId` must
/// already be the session's own agent (via `profileIdForCommand`); a
/// null id is skipped so an unattributed working session never lights
/// the wrong badge.
export function runningAgentProfiles(
  sessions: readonly { profileId: string | null | undefined; status: string | undefined | null }[]
): Set<string> {
  const out = new Set<string>();
  for (const s of sessions) {
    if (!s.profileId) continue;
    if (s.status === "working") out.add(s.profileId);
  }
  return out;
}

/// The badges the Usage row draws, in the order the agents were handed in.
export function usageRowBadges(input: {
  agents: readonly UsageAgentRef[];
  projections: readonly UsageProjection[];
  runningProfileIds: ReadonlySet<string>;
  nowMs: number;
}): UsageRowBadge[] {
  const avatars = agentAvatarLabels(input.agents);
  return input.agents.map((agent) => {
    const worst = worstProjection(
      input.projections.filter((p) => p.profileId === agent.id)
    );
    const indicator = worst?.band
      ? usageProjectionIndicator(
          worst.band,
          projectionTooltip(worst, agent.label, input.nowMs)
        )
      : null;
    const tip = indicator?.tip ?? agent.label;
    return {
      profileId: agent.id,
      avatar: avatars[agent.id] ?? "?",
      label: agent.label,
      tone: indicator?.tone ?? "neutral",
      tip,
      running: input.runningProfileIds.has(agent.id),
    };
  });
}
