// What a Device does not get to ask a Workstation (spec "The shared
// protocol crate", ADR 0003).
//
// The authority is the Remote role command table, which the daemon
// enforces and which lands in the protocol crate with the forwarding work
// (companion-12). Until a bundle can read that table, the two lists here
// stand in for the part of it this bundle has to act on, and they must be
// reconciled with it when it arrives -- a name missing from here is a
// command the Workstation refuses later instead of the bundle refusing
// it now, never one that gets through.

/// The commands that save the desktop's pages and tabs. The Companion
/// keeps its own view state on the Device (viewState.ts), so none of
/// these ever leaves it: the shim refuses them before the channel.
export const LAYOUT_SAVING_COMMANDS = [
  "set_workspaces_state",
  "set_file_tabs",
  "set_board_tabs",
  "set_card_tabs",
] as const;

/// The rest of what the Remote role is refused, as far as the spec names
/// it: Trust, window management, the updater, opening things externally
/// ON THE DESK, and what means nothing away from it. The bundle has no
/// reason to send these and the shim does not police them; the Demo
/// Workstation refuses them, as the daemon will, so a surface that tries
/// one finds out in the demo.
export const DESK_ONLY_COMMANDS = [
  // Trust: pairing, revoking, the remote-access settings -- and reading
  // them, which is how the desktop's bootstrap learns the switch.
  "begin_pairing",
  "confirm_pairing",
  "reject_pairing",
  "list_devices",
  "get_relay_state",
  "get_direct_state",
  "revoke_device",
  "revoke_all_devices",
  "set_remote_access",
  "set_direct_access",
  "set_require_local_token",
  // Where the desk posts notifications, and what it posts: the desk
  // decides, from the window holding the app's duties.
  "set_push_gateway_url",
  "push_companion_notify",
  // Window management.
  "open_workspace_window",
  "claim_workspace_window",
  "close_workspace_window",
  "close_all_workspace_windows",
  "focus_workspace_window",
  "hide_to_menu_bar",
  // The desk's own Mac: keep-running mode holds it awake for a phone,
  // and no phone decides that.
  "set_sleep_hold",
  // Telling the daemon which workspaces have compression on. A Device
  // moves the switch itself like any other workspace setting
  // (`set_workspace_settings`); it is the desk that resolves every
  // workspace against the app-wide default and tells the daemon, from
  // the window holding the app's duties -- which a Device never is.
  "set_headroom_workspaces",
  // The updater.
  "check_for_update",
  "install_update",
  "set_update_endpoint",
  // Opening things externally on the desk.
  "open_path_externally",
  "reveal_path_externally",
  // The desk's own view of an agent's browser, streamed at the desk's
  // size to the desk window that asked. A phone's view is a stream the
  // desk opens for it (`watch_browser_for_device`, state/browser.ts).
  "watch_browser",
  "unwatch_browser",
  // A desk window's answer to a Device's "Commit via agent". The Device
  // asks (`agent_commit_for_device`); only a desk window has an answer.
  "answer_agent_commit_request",
] as const;

const LAYOUT_SAVING: ReadonlySet<string> = new Set(LAYOUT_SAVING_COMMANDS);
const DESK_ONLY: ReadonlySet<string> = new Set(DESK_ONLY_COMMANDS);

/// Why the bundle will not send a command, or null when it will.
export function refusedOnDevice(cmd: string): string | null {
  if (LAYOUT_SAVING.has(cmd)) {
    return `"${cmd}" saves the desktop's layout, and the Companion keeps its own view state`;
  }
  // `plugin:<name>|<command>` is how a Tauri plugin's JS reaches its
  // native half. Those modules import the same core `invoke`, which here
  // is the shim, so without this a desktop module that raises a
  // notification or reads the clipboard would send that to the desk.
  if (cmd.startsWith("plugin:")) {
    return `"${cmd}" is a desktop plugin's command, and a Device's own capabilities belong to the shell`;
  }
  return null;
}

/// Why a Workstation refuses a command to the Remote role, or null.
export function refusedToRemoteRole(cmd: string): string | null {
  if (LAYOUT_SAVING.has(cmd) || DESK_ONLY.has(cmd)) return `"${cmd}" is refused to the Remote role`;
  return null;
}
