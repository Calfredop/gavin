import { get } from "svelte/store";
import { writeText, readText } from "@tauri-apps/plugin-clipboard-manager";
import { layoutState } from "./layoutState";
import { getTerminal } from "./terminalRegistry";
import { writeInput } from "./backend";

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
