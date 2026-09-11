import { platform } from "@tauri-apps/plugin-os";

/// The three operating systems gavin ships for. Anything else -- and a
/// window where the question cannot be asked at all -- is `null`, never
/// a fourth member: every caller's next move is to decide what to do
/// about a platform it knows, and "some other platform" is not one.
export type AppPlatform = "macos" | "linux" | "windows";

// plugin-os's platform() is a synchronous global read (it returns
// window.__TAURI_OS_PLUGIN_INTERNALS__.platform), so this needs no
// bootstrap step: the first keydown and the first paint's tooltips can
// both just ask. Cached because the answer cannot change; guarded
// because the global is absent outside a Tauri window (unit tests, a
// plain browser preview), where "not macOS" is the safe answer -- and
// deliberately NOT cached in that case, so a later call inside a real
// window still gets the true answer.
//
// `undefined` is "not asked yet" and `null` is "asked, and it is not one
// of the three". They have to be distinct: null is a real answer worth
// caching, while undefined is the state that makes the call happen.
let cached: AppPlatform | null | undefined = undefined;

function resolve(): AppPlatform | null {
  if (cached !== undefined) return cached;
  let raw: string;
  try {
    raw = platform();
  } catch {
    // Not cached: outside a Tauri window today does not mean outside one
    // for the life of the module.
    return null;
  }
  cached = raw === "macos" || raw === "linux" || raw === "windows" ? raw : null;
  return cached;
}

/// Which of the three gavin is running on, or null when it cannot be
/// told. Null is deliberately the answer that gates NOTHING: a feature
/// that refuses on an unknown platform would refuse in every unit test
/// and in every browser preview, which is the one place a wrong refusal
/// is invisible until it ships.
export function currentPlatform(): AppPlatform | null {
  return resolve();
}

export function isMacSync(): boolean {
  return resolve() === "macos";
}

export async function isMacOS(): Promise<boolean> {
  return isMacSync();
}

/// "⌘" for shortcut purposes: Command on macOS, Control everywhere else.
export function cmdHeld(e: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return isMacSync() ? e.metaKey : e.ctrlKey;
}
