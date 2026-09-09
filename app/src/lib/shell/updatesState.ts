// The one check gavin makes on its own, and the stores that carry its
// answer.
//
// Module-level and started from `bootstrap`, not from a component
// `$effect` -- the same rule `startScheduler` and `startPauseClock`
// follow. An update surface owned by whichever tab happened to be
// mounted would report an available update only to somebody who had
// already gone looking for one, which is the opposite of the point.
//
// It runs ONCE per bootstrap and then never again on its own. No timer:
// the human chose a quiet check and an explicit install, and a poll that
// repeated all day would be a different thing wearing the same name.
// Everything else here is driven by the button in Settings.

import { writable, get } from "svelte/store";
import * as backend from "$lib/backend";
import { shouldSurfaceCheckError, updateBlockedReason, type AvailableUpdate, type UpdateSettings } from "$lib/shell/updates";

/// What the build says about its own channel. Null before the first read
/// -- which is "not asked yet", not "no channel", and the surface has to
/// be able to tell those apart.
export const updateChannel = writable<UpdateSettings | null>(null);

/// The update the endpoint announced, if any. This is what the sidebar
/// badge and the Settings panel both read.
export const availableUpdate = writable<AvailableUpdate | null>(null);

export const lastCheckedAt = writable<Date | null>(null);

/// The last check's failure, or null. Only ever set from a check the
/// human asked for -- see `shouldSurfaceCheckError`.
export const lastCheckError = writable<string | null>(null);

export const checkingForUpdate = writable(false);

/// Guards supersession the way the rest of this app does: a counter, not
/// an identity comparison. Two checks can be in flight (the launch one
/// and an impatient button press), and the slower one must not overwrite
/// the newer answer when it lands.
let checkToken = 0;

export async function refreshUpdateChannel(): Promise<UpdateSettings | null> {
  try {
    const settings = await backend.updateSettings();
    updateChannel.set(settings);
    return settings;
  } catch {
    // An older host with no such command. Nothing to report and nothing
    // to draw: the panel renders its "not asked yet" state.
    updateChannel.set(null);
    return null;
  }
}

/// Asks the endpoint. `trigger` decides only whether a FAILURE is shown
/// -- the answer itself always lands, so an update found at launch is on
/// screen without anybody pressing anything.
export async function runUpdateCheck(trigger: "launch" | "manual"): Promise<void> {
  const settings = get(updateChannel) ?? (await refreshUpdateChannel());
  if (!settings) return;
  // Nothing to ask when the build has no channel, no key or no endpoint.
  // Skipping here rather than letting the host refuse keeps the launch
  // path from making a request that cannot succeed, and keeps the
  // panel's reason the ONE explanation on screen.
  if (updateBlockedReason(settings)) return;

  const token = ++checkToken;
  checkingForUpdate.set(true);
  if (trigger === "manual") lastCheckError.set(null);
  try {
    const found = await backend.checkForUpdate();
    if (token !== checkToken) return;
    availableUpdate.set(found);
    lastCheckedAt.set(new Date());
    lastCheckError.set(null);
  } catch (e) {
    if (token !== checkToken) return;
    if (shouldSurfaceCheckError(trigger)) {
      lastCheckError.set(String(e instanceof Error ? e.message : e));
    }
  } finally {
    if (token === checkToken) checkingForUpdate.set(false);
  }
}

/// Reads the channel and makes the single launch check.
///
/// Returns a teardown so it can join `bootstrap`'s unlisteners like the
/// other module-level starts, even though it holds no listener today:
/// the shape is the contract, and a later periodic check would otherwise
/// have nowhere to be stopped from. It also bumps the token, so a check
/// still in flight from a previous bootstrap (a frontend reload) cannot
/// write into the new one's stores.
export function startUpdateWatch(): () => void {
  void runUpdateCheck("launch");
  return () => {
    checkToken += 1;
    checkingForUpdate.set(false);
  };
}
