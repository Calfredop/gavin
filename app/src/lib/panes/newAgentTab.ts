// The "New agent tab" split button on a pane's tab row, as data and
// policy: which agents its dropdown offers, and the menu that offers
// them. NewAgentTabButton.svelte is a thin template over this.
//
// The button's face launches the workspace's own agent -- the one a
// card Run or the main agent would start -- so one click is the common
// case. The dropdown is for the other agents set up on this machine.
import type { ContextMenuEntry } from "$lib/core/contextMenu";
import type { AgentProfileInfo } from "$lib/core/settings";
import type { DetectedAgent } from "$lib/agents/agentDetect";

/// What the button and its menu call themselves.
export const NEW_AGENT_TAB_TITLE = "New agent tab";

/// The dropdown's tooltip: the chevron is a second button, so it needs a
/// name of its own that says it picks rather than launches.
export const PICK_AGENT_TITLE = "New agent tab with…";

/// The detail on the workspace default's row.
export const DEFAULT_AGENT_DETAIL = "default";

/// The agents the dropdown offers: every profile this workspace can
/// launch, minus the built-ins whose CLI the PATH sweep did not find.
///
/// - A profile with no command (the bare `custom` slot) has nothing to
///   launch, so it is never offered.
/// - A custom is not in the sweep at all (`detected` covers built-ins
///   only), and its command is the human's own -- it was set up by being
///   written down, so it stays.
/// - `detected` null means the sweep has not answered (or failed): offer
///   everything rather than an empty menu that reads as "nothing set up".
/// - The workspace default is always offered, found or not: it is what
///   the button's face launches, and the menu must agree with the face.
export function agentTabChoices(
  profiles: readonly AgentProfileInfo[],
  detected: readonly DetectedAgent[] | null,
  defaultProfileId: string
): AgentProfileInfo[] {
  const found = detected ? new Map(detected.map((d) => [d.id, d.found])) : null;
  return profiles.filter((p) => {
    if (p.id === defaultProfileId) return true;
    if (!p.command.trim()) return false;
    return found?.get(p.id) !== false;
  });
}

/// The dropdown's entries over the shared context menu layer. The
/// heading names the menu (the chevron says nothing out loud), and the
/// workspace default is ticked and labelled, so the human can see which
/// row the face would have launched.
export function newAgentTabEntries(
  choices: readonly AgentProfileInfo[],
  defaultProfileId: string,
  onPick: (profileId: string) => void
): ContextMenuEntry[] {
  return [
    { heading: NEW_AGENT_TAB_TITLE },
    ...choices.map((p) => ({
      label: p.label,
      active: p.id === defaultProfileId,
      ...(p.id === defaultProfileId ? { detail: DEFAULT_AGENT_DETAIL } : {}),
      onPick: () => onPick(p.id),
    })),
  ];
}
