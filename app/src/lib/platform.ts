import { platform } from "@tauri-apps/plugin-os";
import { readonly, writable, type Readable } from "svelte/store";

// Keydown handlers cannot await, so the platform is resolved once at
// bootstrap and read synchronously afterwards. Until initPlatform
// resolves this reads false -- a few milliseconds at startup where a
// Ctrl chord would match instead of a Cmd one, never a crash.
let cachedIsMac = false;
// Components render before initPlatform resolves (the title bar paints
// on first frame), so the flag is also a store: a $derived reading
// isMacSync() alone would keep a "Ctrl+T" label on macOS forever.
const isMacStore = writable(false);
export const isMac: Readable<boolean> = readonly(isMacStore);

export async function isMacOS(): Promise<boolean> {
  return (await platform()) === "macos";
}

export async function initPlatform(): Promise<void> {
  cachedIsMac = await isMacOS();
  isMacStore.set(cachedIsMac);
}

export function isMacSync(): boolean {
  return cachedIsMac;
}

/// "⌘" for shortcut purposes: Command on macOS, Control everywhere else.
export function cmdHeld(e: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return cachedIsMac ? e.metaKey : e.ctrlKey;
}
