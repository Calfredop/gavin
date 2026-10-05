// Settings on a phone: the Workstation's own, and each workspace's.
//
// Not the desk's two panels (`GlobalSettingsView`, `SettingsHubView`),
// deliberately. Beside the settings, each carries sections that are the
// desk's alone -- Updates, Daemon and Remote access, which call commands
// the Remote role is refused the moment they draw; the sidebar and hub-tab
// rows, which are the desk's layout; the agent-change wizard, which moves
// files and re-runs setup -- and a navigator beside the body that a phone
// has no room for. What the phone draws is the rest, through the SAME
// stores, writers and option lists those panels use, so a setting cannot
// mean one thing at the desk and another here. This module holds only
// what the phone says or decides differently.
import type { PauseCycle } from "$lib/agents/agentPause";
import type { AgentConfig } from "$lib/core/gavin";
import type { AgentProfileInfo, ResolvedAgent } from "$lib/core/settings";
import type { Workspace } from "$lib/core/workspace";

/// What a workspace that keeps no pause of its own follows, in words.
export function inheritedPauseLine(app: PauseCycle | null): string {
  return app?.enabled
    ? `Following the app-wide cycle: ${app.pauseMinutes} minutes every ${app.periodMinutes} minutes.`
    : "Following the app-wide setting, which is off. The Workstation's settings change it for every workspace.";
}

/// Where a workspace works, in one line: a folder, a folder on another
/// machine, or none.
export function folderLine(ws: Pick<Workspace, "rootPath" | "ssh">): string {
  const root = ws.rootPath?.trim();
  if (!root) return "No folder";
  return ws.ssh?.host ? `${ws.ssh.host}: ${root}` : root;
}

/// A workspace's agent as its model and effort pickers need it: what the
/// workspace set of its OWN, what it inherits, and whether gavin has a
/// flag to reach the agent with at all.
///
/// "Own" is read off the workspace's `[agent]` block, never off the
/// resolved agent -- that one has already fallen back to the app-wide
/// default, and a picker must tell "inheriting" from "chose the same
/// value" (the desk's panel draws the same distinction).
export interface WorkspaceAgentView {
  profileLabel: string;
  modelFlag: string;
  models: string[];
  ownModel: string;
  inheritedModel: string;
  effortFlag: string;
  efforts: string[];
  ownEffort: string;
  inheritedEffort: string;
}

export function workspaceAgentView(input: {
  resolved: Pick<ResolvedAgent, "profileId" | "modelFlag" | "effortFlag">;
  own: AgentConfig | null | undefined;
  profiles: AgentProfileInfo[];
  modelDefaults: Record<string, string>;
  effortDefaults: Record<string, string> | undefined;
}): WorkspaceAgentView {
  const id = input.resolved.profileId;
  const profile = input.profiles.find((p) => p.id === id);
  return {
    profileLabel: profile?.label ?? id,
    modelFlag: input.resolved.modelFlag,
    models: profile?.models ?? [],
    ownModel: input.own?.model ?? "",
    inheritedModel: input.modelDefaults[id] ?? "",
    effortFlag: input.resolved.effortFlag,
    efforts: profile?.efforts ?? [],
    ownEffort: input.own?.effort ?? "",
    inheritedEffort: input.effortDefaults?.[id] ?? "",
  };
}
