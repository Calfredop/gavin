// What the typing dock sends, and where: the Workstation's `write_input`,
// the command the desk's own terminals type through.
//
// The bytes are terminalInput.ts's and quickReplies.ts's to decide; this
// is the one place they leave the phone, so the seam suites can drive a
// line, a reply and a key exactly as the dock does.
import * as backend from "$lib/core/backend";
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
