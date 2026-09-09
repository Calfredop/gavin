/// The Superpowers row's pure model. The evidence comes from Rust
/// (`app/src-tauri/src/superpowers.rs`, driven by
/// `docs/superpowers/specs/2026-09-01-superpowers-install-matrix.md`);
/// what this module owns is what the two surfaces DO with it -- which
/// LED, which controls, and when the setup step counts as finished.

/// What gavin can say about Superpowers for one workspace.
///
/// `asserted` is not a second flavour of `verified`: it is the human's
/// word where gavin could not check, and both surfaces must render it
/// differently or the LED stops meaning anything. `unavailable` carries a
/// reason for the same purpose -- a control that cannot explain itself is
/// worse than no control.
export type SuperpowersState = "verified" | "asserted" | "absent" | "unavailable";

export interface SuperpowersStatus {
  state: SuperpowersState;
  /// One sentence for the row; for `unavailable`, the reason gavin cannot
  /// check this profile.
  detail: string;
  /// The install command, or -- where gavin cannot run one -- the
  /// instruction to paste into the agent itself. Empty only for `custom`.
  command: string;
  /// Whether gavin may run `command` itself. False for every profile but
  /// Claude Code, including Gemini, which has a working CLI command whose
  /// confirmation prompt is not gavin's to answer.
  installable: boolean;
  /// The detector's or installer's raw output, for the drawer.
  output: string;
}

/// The human's word, stored machine-locally per workspace root.
/// `undefined` means they have not said anything yet -- which is NOT the
/// same as "not now", and collapsing the two is what would make a
/// declined step start nagging again.
export type SuperpowersMark = "installed" | "skipped";

/// A status object for a workspace with no root bound yet. Every surface
/// needs something to render before the first round trip lands, and a
/// fabricated `absent` would offer an Install button for a directory that
/// does not exist.
export const UNKNOWN_STATUS: SuperpowersStatus = {
  state: "unavailable",
  detail: "Bind a root folder to check for Superpowers.",
  command: "",
  installable: false,
  output: "",
};

/// S6: the wizard step is finished when a check found the plugin, when
/// the human said it is installed, or when they said "not now". The third
/// route is the point -- without it, declining once leaves the Home
/// banner nagging for ever.
///
/// `unavailable` on its own is deliberately NOT done. gavin failing to
/// check is not the human deciding, and treating it as one would quietly
/// finish the step for every Cursor and Codex workspace before its owner
/// had seen the explainer.
export function superpowersDone(
  status: SuperpowersStatus | undefined,
  mark: SuperpowersMark | undefined
): boolean {
  if (mark) return true;
  return status?.state === "verified" || status?.state === "asserted";
}

/// How the LED reads. `verified` and `asserted` are both "on" -- the
/// plugin is believed present either way -- but they are separate values,
/// never a boolean, so no caller can render them identically by accident.
export type SuperpowersLed = "on" | "claimed" | "off" | "unknown";

export function superpowersLed(state: SuperpowersState): SuperpowersLed {
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

/// The Settings row's rule, straight from the card: the Install button
/// shows ONLY when the plugin is absent. A profile gavin cannot check
/// (`unavailable`) is not absent -- offering to install into an agent
/// gavin cannot drive would be a button that can only fail.
export function showsInstallButton(status: SuperpowersStatus): boolean {
  return status.state === "absent" && status.installable;
}

/// Where gavin cannot run the install, the human needs the exact thing to
/// paste. Shown for `absent` and `unavailable` alike: `unavailable` means
/// gavin cannot CHECK, which is no reason to withhold the instructions.
export function showsCopyCommand(status: SuperpowersStatus): boolean {
  if (status.state === "verified" || status.state === "asserted") return false;
  return !status.installable && status.command.length > 0;
}

/// Whether to offer "I've installed it". Only where there is something
/// for it to add: once a check has found the plugin, the human's word
/// would tell gavin nothing it does not already know, and once they have
/// already said it, the row shows their claim instead.
export function showsAssertButton(
  status: SuperpowersStatus,
  mark: SuperpowersMark | undefined
): boolean {
  if (status.state === "verified") return false;
  return mark !== "installed";
}

/// The caveat both surfaces carry. A plugin is read into an agent's
/// context when its session starts, so a terminal that was already open
/// when the install ran does not have it.
export const RESTART_NOTE =
  "Sessions already running do not pick this up — only ones started after it.";

/// One line naming the state for a row heading. Kept beside the LED so
/// the two cannot drift apart into a green light labelled "not found".
export function superpowersLabel(state: SuperpowersState): string {
  switch (state) {
    case "verified":
      return "Superpowers plugin";
    case "asserted":
      return "Superpowers plugin (your word)";
    case "absent":
      return "Superpowers plugin — not installed";
    default:
      return "Superpowers plugin — not checked";
  }
}
