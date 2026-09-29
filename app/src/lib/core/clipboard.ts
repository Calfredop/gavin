import { writeText, readText } from "@tauri-apps/plugin-clipboard-manager";
import { getTerminal } from "$lib/terminal/terminalRegistry";

/// Whether a terminal stands behind this tab id. A card, file or board
/// tab shares the page -- and the focus -- with terminal tabs but has no
/// terminal, and the clipboard chords must leave its text to the browser.
export function hasTerminal(sessionId: string): boolean {
  return getTerminal(sessionId) !== undefined;
}

/// Whether the session's terminal holds a selection. Synchronous on
/// purpose: on Windows/Linux it decides whether Ctrl+C is a copy or the
/// interrupt, and the keydown has to be claimed (or left to xterm)
/// before the first await. False for a tab with no terminal behind it.
export function terminalHasSelection(sessionId: string): boolean {
  return getTerminal(sessionId)?.hasSelection() ?? false;
}

/// Puts the session's terminal selection on the clipboard. `clear` drops
/// the selection afterwards -- what hands Ctrl+C back to the interrupt on
/// the platforms where one key does both.
export async function copySelection(
  sessionId: string,
  { clear = false }: { clear?: boolean } = {}
): Promise<void> {
  const term = getTerminal(sessionId);
  const selection = term?.getSelection();
  if (!term || !selection) return;
  if (clear) term.clearSelection();
  await writeText(selection);
}

/// Pastes the clipboard's text into the session's terminal through
/// xterm's own `paste()`, which is what a paste event would have done:
/// line breaks become Enter, and a program that asked for bracketed
/// paste gets the text wrapped, so a shell shows a pasted command instead
/// of running it and an agent's prompt takes several lines as one. The
/// raw write this replaced sent every line break straight to the pty.
/// A clipboard holding no text (an image) pastes nothing.
export async function pasteClipboard(sessionId: string): Promise<void> {
  const text = await readText().catch(() => "");
  if (!text) return;
  getTerminal(sessionId)?.paste(text);
}
