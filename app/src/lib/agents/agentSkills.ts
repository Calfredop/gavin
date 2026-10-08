/// The agent skills row's pure model -- the skills gavin recommends to the
/// agent, Matt Pocock's. The evidence comes from Rust
/// (`app/src-tauri/src/agent_skills.rs`, driven by
/// `docs/superpowers/specs/2026-10-05-mattpocock-skills-install-matrix.md`);
/// what this module owns is what the two surfaces DO with it -- which
/// LED, which controls, and when the setup step counts as finished.
///
/// Generic names on purpose: the product is named in the copy below, and
/// the next swap should not have to rename the world.

/// The product, as every surface names it.
export const AGENT_SKILLS_NAME = "Matt Pocock's skills";

/// What gavin can say about the skills for one workspace.
///
/// `asserted` is not a second flavour of `verified`: it is the human's
/// word where gavin could not check (a custom agent), and both surfaces
/// must render it differently or the LED stops meaning anything.
/// `unavailable` carries a reason for the same purpose -- a control that
/// cannot explain itself is worse than no control.
export type AgentSkillsState = "verified" | "asserted" | "absent" | "unavailable";

export interface AgentSkillsStatus {
  state: AgentSkillsState;
  /// One sentence for the row; for `unavailable`, the reason gavin cannot
  /// check this profile.
  detail: string;
  /// The install command. Exactly what gavin runs where `installable`;
  /// for a custom agent, the interactive command to run yourself, which
  /// asks which agent to install for -- gavin does not know its name.
  command: string;
  /// Whether gavin may run `command` itself: every known profile, through
  /// Claude Code's plugin or the skills CLI.
  installable: boolean;
  /// The detector's or installer's raw output, for the drawer.
  output: string;
}

/// The human's word, stored machine-locally per workspace root.
/// `undefined` means they have not said anything yet -- which is NOT the
/// same as "not now", and collapsing the two is what would make a
/// declined step start nagging again.
export type AgentSkillsMark = "installed" | "skipped";

/// A status object for a workspace with no root bound yet. Every surface
/// needs something to render before the first round trip lands, and a
/// fabricated `absent` would offer an Install button for a directory that
/// does not exist.
export const UNKNOWN_STATUS: AgentSkillsStatus = {
  state: "unavailable",
  detail: `Bind a root folder to check for ${AGENT_SKILLS_NAME}.`,
  command: "",
  installable: false,
  output: "",
};

/// The wizard step is finished when a check found the skills, when the
/// human said they are installed, or when they said "not now". The third
/// route is the point -- without it, declining once leaves the Home
/// banner nagging for ever.
///
/// `unavailable` on its own is deliberately NOT done. gavin failing to
/// check is not the human deciding, and treating it as one would quietly
/// finish the step for every custom-agent workspace -- or one whose
/// `claude` is not on PATH -- before its owner had seen the explainer.
export function agentSkillsDone(
  status: AgentSkillsStatus | undefined,
  mark: AgentSkillsMark | undefined
): boolean {
  if (mark) return true;
  return status?.state === "verified" || status?.state === "asserted";
}

/// How the LED reads. `verified` and `asserted` are both "on" -- the
/// skills are believed present either way -- but they are separate
/// values, never a boolean, so no caller can render them identically by
/// accident.
export type AgentSkillsLed = "on" | "claimed" | "off" | "unknown";

export function agentSkillsLed(state: AgentSkillsState): AgentSkillsLed {
  switch (state) {
    case "verified":
      return "on";
    case "asserted":
      return "claimed";
    case "absent":
      return "off";
    default:
      return "unknown";
  }
}

/// The Install button shows ONLY when the skills are absent. A profile
/// gavin cannot check (`unavailable`) is not absent -- offering to install
/// where gavin cannot even look would be a button whose result nobody
/// could read.
export function showsInstallButton(status: AgentSkillsStatus): boolean {
  return status.state === "absent" && status.installable;
}

/// Where gavin cannot run the install, the human needs the exact thing to
/// run. Shown for `absent` and `unavailable` alike: `unavailable` means
/// gavin cannot CHECK, which is no reason to withhold the instructions.
export function showsCopyCommand(status: AgentSkillsStatus): boolean {
  if (status.state === "verified" || status.state === "asserted") return false;
  return !status.installable && status.command.length > 0;
}

/// Whether to offer "I've installed it". Only where gavin has no detector
/// -- a custom agent. For a known agent the evidence is machine-true (the
/// plugin list answers for this machine, the skill files travel with the
/// repo), so the human's word could only paper over a check that says
/// otherwise; the Rust side ignores it there for the same reason. And
/// never once they have already said it: the row shows their claim.
export function showsAssertButton(
  status: AgentSkillsStatus,
  mark: AgentSkillsMark | undefined
): boolean {
  if (status.installable || status.state === "verified") return false;
  return mark !== "installed";
}

/// The caveat both surfaces carry. Skills are read into an agent's
/// context when its session starts, so a terminal that was already open
/// when the install ran does not have them.
export const RESTART_NOTE =
  "Sessions already running do not pick this up — only ones started after it.";

/// One line naming the state for a row heading. Kept beside the LED so
/// the two cannot drift apart into a green light labelled "not found".
export function agentSkillsLabel(state: AgentSkillsState): string {
  switch (state) {
    case "verified":
      return AGENT_SKILLS_NAME;
    case "asserted":
      return `${AGENT_SKILLS_NAME} (your word)`;
    case "absent":
      return `${AGENT_SKILLS_NAME} — not installed`;
    default:
      return `${AGENT_SKILLS_NAME} — not checked`;
  }
}

/// The one-time note Settings → Agent shows where this machine recorded an
/// answer about the plugin gavin used to recommend. It names that plugin,
/// because the reader knows it by that name; and it leaves it alone,
/// because the install is the human's own.
export const FAREWELL_NOTE =
  "gavin now recommends Matt Pocock's skills instead of Superpowers. Superpowers is yours to keep or remove — gavin no longer checks for it or installs it.";
