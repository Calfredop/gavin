// The frontend half of `confirm_gate.rs`.
//
// Four commands destroy something the human cannot undo from inside
// gavin, and each one's "are you sure" is drawn here in the page. That
// made the confirmation a convention every call site repeated rather
// than a precondition anything enforced: a new route to
// `delete_card_file` that forgot to ask would work, and no suite would
// notice (AS-05/R5). The host now requires a token it minted for the
// exact target, so a call site that does not ask gets a refusal saying
// so.
//
// Two entry points, because gavin's prompts come in two shapes:
//
// - `confirmDestructive` draws the prompt itself through dialog.ts. It
//   is the one to reach for: there is no way to get a token out of it
//   without a prompt having been on screen.
// - `grantForAnsweredPrompt` is for a surface that mounts its own
//   `ConfirmPrompt` -- because it needs a picker, a typed name, or a
//   second action `askConfirm` cannot express. Call it from the confirm
//   choice's handler and nowhere else.
//
// Neither stops a script that already runs in the page: it can call the
// same two commands and never draw anything. The host's own doc comment
// says so at length, and docs/security records it as the part of AS-05
// that a host-drawn dialog would be needed to close.

import { invoke } from "@tauri-apps/api/core";
import { askConfirm, type ConfirmOptions } from "./dialog";

/// Exactly `confirm_gate.rs`'s `GATED_ACTIONS`, and spelled with each
/// command's own registered name -- the host compares the two strings.
export type GatedAction =
  | "delete_card_file"
  | "remove_gavin_footprint"
  | "restart_daemon"
  | "trash_entry";

/// `restart_daemon` takes no path. There is one daemon, so its prompt
/// names one subject and this is it (`confirm_gate::DAEMON_SUBJECT`).
export const DAEMON_SUBJECT = "";

/// A token the host will refuse. Returned instead of throwing when the
/// mint fails, so the refusal surfaces where every other failure of the
/// action does -- the call site's own "Couldn't delete X: …" banner,
/// carrying the host's reason -- rather than as an unhandled rejection
/// in a click handler.
const NO_GRANT = "";

async function open(action: GatedAction, subjects: string[]): Promise<number | null> {
  return invoke<number>("open_confirmation", { action, subjects }).catch(() => null);
}

/// `== null` rather than `=== null`: a host that answered with nothing
/// at all (an older build without these commands, a mocked invoke) has
/// no prompt to settle either, and asking it to settle `undefined` would
/// be a second failed round trip on the way to the same answer.
async function settle(promptId: number | null, confirmed: boolean): Promise<string | null> {
  if (promptId == null) return null;
  return invoke<string | null>("answer_confirmation", { promptId, confirmed }).catch(() => null);
}

/// Asks, and returns the token the matching command needs. Null is the
/// human saying no -- the same answer `askConfirm` gives, so a call site
/// keeps the `if (!…) return;` it already had.
export async function confirmDestructive(
  action: GatedAction,
  subjects: string[],
  prompt: ConfirmOptions
): Promise<string | null> {
  const promptId = await open(action, subjects);
  let confirmed = false;
  try {
    confirmed = await askConfirm(prompt);
  } finally {
    // Settled either way: a cancelled prompt has to leave the host's
    // record closed, or a dismissed dialog would sit in its map until
    // the TTL swept it.
    if (!confirmed) void settle(promptId, false);
  }
  if (!confirmed) return null;
  return (await settle(promptId, true)) ?? NO_GRANT;
}

/// The token for a prompt this surface drew and has just had answered
/// yes. Never returns null: a mint that fails yields a token the command
/// rejects, so the failure is reported by the action's own error path
/// with the host's reason rather than swallowed as a silent no-op.
export async function grantForAnsweredPrompt(
  action: GatedAction,
  subjects: string[]
): Promise<string> {
  const promptId = await open(action, subjects);
  return (await settle(promptId, true)) ?? NO_GRANT;
}
