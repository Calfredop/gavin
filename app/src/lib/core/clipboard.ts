import { get } from "svelte/store";
import { writeText, readText } from "@tauri-apps/plugin-clipboard-manager";
import { layoutState } from "$lib/core/layoutState";
import { getTerminal } from "$lib/terminal/terminalRegistry";
import { writeInput } from "$lib/core/backend";

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

export async function pasteClipboard(): Promise<void> {
  const state = get(layoutState);
  if (!state.focusedSessionId) return;
  const text = await readText();
  if (!text) return;
  await writeInput(state.focusedSessionId, text);
}
