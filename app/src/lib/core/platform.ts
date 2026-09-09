import { platform } from "@tauri-apps/plugin-os";

// plugin-os's platform() is a synchronous global read (it returns
// window.__TAURI_OS_PLUGIN_INTERNALS__.platform), so this needs no
// bootstrap step: the first keydown and the first paint's tooltips can
// both just ask. Cached because the answer cannot change; guarded
// because the global is absent outside a Tauri window (unit tests, a
// plain browser preview), where "not macOS" is the safe answer -- and
// deliberately NOT cached in that case, so a later call inside a real
// window still gets the true answer.
let cached: boolean | null = null;

export function isMacSync(): boolean {
  if (cached === null) {
    try {
      cached = platform() === "macos";
    } catch {
      return false;
    }
  }
  return cached;
}

export async function isMacOS(): Promise<boolean> {
  return isMacSync();
}

/// "⌘" for shortcut purposes: Command on macOS, Control everywhere else.
export function cmdHeld(e: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return isMacSync() ? e.metaKey : e.ctrlKey;
}
