// What the update surface says, as a module rather than as a template.
//
// The channel itself is in `app/src-tauri/src/updater.rs`, and its doc
// comment carries the security argument (the key is pinned, the URL is
// not; the webview never gets the plugin's own download/install
// permissions). What is here is the part a human reads: whether this
// build has a channel at all, what an available update is, and the
// sentence somebody has to agree with before gavin replaces itself.
//
// The sentence is the interesting half. Installing an update is not
// "quit and come back" -- it is that, plus a consequence peculiar to
// gavin:
//
//   * The daemon outlives the app. Every terminal, agent and hidden run
//     survives the relaunch, which is the good news and is why the
//     prompt does not read like a data-loss warning.
//   * But the update replaces `gavin-daemon` INSIDE the bundle, and the
//     daemon that is running was exec'd from the old copy. It keeps
//     running the old code until somebody restarts it -- and restarting
//     it ends every session it holds (Settings > Daemon).
//
// So an install with live sessions leaves the human in a specific
// state: new app, old daemon, possibly a compat banner, and the fix for
// that costs them their sessions. That is worth knowing BEFORE the
// click, not after, which is what `installPrompt` exists to say.

import type { ManagedSession } from "$lib/sessionsManager";

/// Mirrors `UpdateSettings` in `updater.rs`.
export interface UpdateSettings {
  currentVersion: string;
  /// The endpoint this install polls. Empty means nothing polls.
  endpoint: string;
  /// What the build shipped with, so "reset" has something to reset to.
  defaultEndpoint: string;
  overridden: boolean;
  /// False when the build carries no `plugins.updater` block.
  enabled: boolean;
  /// False when the block is there but pins no key.
  pinned: boolean;
}

/// Mirrors `AvailableUpdate` in `updater.rs`.
export interface AvailableUpdate {
  version: string;
  currentVersion: string;
  notes: string | null;
  date: string | null;
}

/// Why this build cannot check, or null when it can.
///
/// Three different answers, deliberately not collapsed into one: "no
/// channel in this build", "no key pinned" and "no endpoint set" have
/// different fixes, and a single "updates unavailable" would send
/// somebody looking in the wrong place for all three.
export function updateBlockedReason(settings: UpdateSettings): string | null {
  if (!settings.enabled) {
    return "This build has no update channel — it was built without a plugins.updater block.";
  }
  if (!settings.pinned) {
    return "This build pins no update key, so it could not verify an update even if it found one.";
  }
  if (!settings.endpoint.trim()) {
    return "No update endpoint is set, so nothing is checked. Add one below.";
  }
  return null;
}

/// What the panel says when there is nothing to install: the version,
/// and whether anything has actually been asked yet.
export function upToDateLine(settings: UpdateSettings, checkedAt: Date | null): string {
  const version = `gavin ${settings.currentVersion}`;
  if (!checkedAt) return `${version}.`;
  return `${version} — up to date as of ${checkedAt.toLocaleTimeString()}.`;
}

/// The headline for an available update.
export function availableLine(update: AvailableUpdate): string {
  return `gavin ${update.version} is available. This install is ${update.currentVersion}.`;
}

/// The sessions an install would leave behind on the OLD daemon.
///
/// Deliberately the same rule as `appClose.ts`'s `sessionsToEnd`: an
/// exited row has nothing behind it, unless it left an orphan, which is
/// a process still editing the checkout and is exactly the one that
/// matters. Duplicated as a call rather than re-derived, so the two
/// surfaces cannot drift into disagreeing about what "live" means.
export function liveSessions(sessions: ManagedSession[]): ManagedSession[] {
  return sessions.filter((s) => s.status !== "exited" || s.orphan !== null);
}

export interface UpdatePrompt {
  title: string;
  lines: string[];
  confirmLabel: string;
}

/// The prompt gavin draws before it replaces itself.
///
/// `liveCount` is `liveSessions(...).length`. Zero is not a shorter
/// version of the same prompt -- it is a different situation, and
/// padding it with a warning about sessions nobody has would teach the
/// human to skip the paragraph that matters when they do have some.
export function installPrompt(update: AvailableUpdate, liveCount: number): UpdatePrompt {
  const lines = [
    `gavin ${update.currentVersion} is replaced by ${update.version}. The download is verified against the key this build was signed with before anything is installed.`,
    "The app quits and reopens on its own.",
  ];
  if (liveCount > 0) {
    lines.push(
      liveCount === 1
        ? "One terminal session keeps running through the restart — the daemon holds it, not the window."
        : `${liveCount} terminal sessions keep running through the restart — the daemon holds them, not the window.`
    );
    lines.push(
      "The daemon itself stays on the old version until you restart it in Settings › Daemon, and that restart ends those sessions. Finish what is running first if that matters."
    );
  } else {
    lines.push(
      "The running daemon stays on the old version until you restart it in Settings › Daemon."
    );
  }
  return {
    title: `Install gavin ${update.version}?`,
    lines,
    confirmLabel: `Install ${update.version}`,
  };
}

/// Whether a failed check is worth putting on screen.
///
/// The launch check is silent by design: gavin is not published yet, so
/// the endpoint 404s, and a build with no key pinned cannot verify
/// anything anyway. Neither is news, and a startup banner about it every
/// morning is how a human learns to ignore the surface that will one day
/// carry a real answer. A check the human ASKED for always reports,
/// success or failure -- a button that does nothing visible is worse
/// than an error.
export function shouldSurfaceCheckError(trigger: "launch" | "manual"): boolean {
  return trigger === "manual";
}

/// The endpoint to save, or null to clear the override.
///
/// Typing the build's own default back in is a clear, not an override:
/// otherwise the setting would pin today's URL forever and a later
/// release that moved it would be ignored by every install that had ever
/// visited this field.
export function endpointToSave(typed: string, settings: UpdateSettings): string | null {
  const value = typed.trim();
  if (!value) return null;
  if (value === settings.defaultEndpoint.trim()) return null;
  return value;
}
