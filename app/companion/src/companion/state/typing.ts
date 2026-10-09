// What the typing dock sends, and where: the Workstation's `write_input`,
// the command the desk's own terminals type through.
//
// The bytes are terminalInput.ts's and quickReplies.ts's to decide; this
// is the one place they leave the phone, so the seam suites can drive a
// line, a reply and a key exactly as the dock does.
import * as backend from "$lib/core/backend";
import { askConfirm } from "$lib/core/dialog";
import { busyQuestion, ownerRefusalFrom } from "$lib/core/sessionOwnership";
import { noteRefusal, takeOver } from "$lib/core/sessionOwnershipState";
import { replyBytes, type QuickReply } from "$companion/surfaces/quickReplies";
import { composeBytes, keyBytes, typedThrough, type InputModes, type KeyId } from "$companion/surfaces/terminalInput";

function send(sessionId: string, bytes: string): Promise<void> {
  if (bytes === "") return Promise.resolve();
  return backend.writeInput(sessionId, bytes);
}

/// The compose field's line: the text as a paste, then Enter.
export function sendLine(sessionId: string, text: string, modes: InputModes): Promise<void> {
  return send(sessionId, composeBytes(text, modes));
}

export function sendReply(sessionId: string, reply: QuickReply, modes: InputModes): Promise<void> {
  return send(sessionId, replyBytes(reply.send, modes));
}

export function sendKey(sessionId: string, key: KeyId, modes: InputModes): Promise<void> {
  return send(sessionId, keyBytes(key, modes));
}

/// A character from the dock's symbols, through the Ctrl latch. Says at
/// once whether the latch is still armed, so the dock can redraw it
/// without waiting on the Workstation.
export function sendTyped(
  sessionId: string,
  text: string,
  ctrlArmed: boolean
): { ctrlArmed: boolean; sent: Promise<void> } {
  const typed = typedThrough(text, ctrlArmed);
  return { ctrlArmed: typed.ctrlArmed, sent: send(sessionId, typed.bytes) };
}

/// What became of something the dock tried to send (v68): it went, or it
/// did not and here is what to say -- `null` when the human chose not to
/// take the session, which needs no saying.
export type Sent = { sent: true } | { sent: false; notice: string | null };

/// Sends through `send`, held to the session's owner (v68). Another Device
/// owning the session is said, and the lock drawn; whoever is typing in it
/// right now is asked about, and on a yes the session is taken over and the
/// same bytes sent again -- so the line the human wrote is never lost to
/// the question. Any other failure is the caller's, as before.
export async function sendAsOwner(sessionId: string, send: () => Promise<void>): Promise<Sent> {
  try {
    await send();
    return { sent: true };
  } catch (e) {
    const refusal = ownerRefusalFrom(e);
    if (!refusal) throw e;
    if (refusal.kind !== "busy") return { sent: false, notice: noteRefusal(refusal) };
    const yes = await askConfirm({
      title: busyQuestion(refusal),
      lines: ["What you wrote is sent once the session is yours."],
      confirmLabel: "Take over",
      danger: true,
    });
    if (!yes) return { sent: false, notice: null };
    const taken = await takeOver(sessionId, true);
    if (taken !== null) return { sent: false, notice: taken };
    await send();
    return { sent: true };
  }
}
