import { get } from "svelte/store";
import { writeText, readText } from "@tauri-apps/plugin-clipboard-manager";
import { layoutState } from "$lib/layoutState";
import { getTerminal } from "$lib/terminalRegistry";
import { writeInput } from "$lib/backend";

export async function copySelection(): Promise<void> {
  const state = get(layoutState);
  if (!state.focusedSessionId) return;
  const term = getTerminal(state.focusedSessionId);
  const selection = term?.getSelection();
  if (!selection) return;
  await writeText(selection);
}

export async function pasteClipboard(): Promise<void> {
  const state = get(layoutState);
  if (!state.focusedSessionId) return;
  const text = await readText();
  if (!text) return;
  await writeInput(state.focusedSessionId, text);
}
