// The frontend's view of the compatibility verdict Rust negotiated with
// the daemon at connect time (session::DaemonCompat, Tasks 1-6b). Purely
// derived/pure functions here -- the store that holds the live value
// lives in layoutState.ts, which is what actually talks to Tauri.
export type DaemonCompat = {
  daemonVersion: number;
  appVersion: number;
  degraded: boolean;
};

/// Null means "show nothing" -- the banner is for the degraded case only,
/// so a matching daemon stays completely silent.
export function compatMessage(c: DaemonCompat | null, runningAgents: number): string | null {
  if (!c || !c.degraded) return null;
  const base = `Running against an older daemon (v${c.daemonVersion}; this app speaks v${c.appVersion}). Some features are unavailable.`;
  if (runningAgents === 0) return base;
  const noun = runningAgents === 1 ? "1 running agent" : `${runningAgents} running agents`;
  return `${base} Restarting it will end ${noun}.`;
}

/// Mirrors protocol::min_version_for for the UI's benefit. Only the
/// versions the UI actually branches on need entries here.
export const FEATURE_MIN_VERSION = {
  orchestration: 10,
  // No component reads this on this branch -- ToolLibraryDialog.svelte
  // arrives with the orchestration merge and will be the first consumer.
  // Recorded now anyway: unlike protocol::min_version_for's exhaustive
  // match, nothing forces this table to be updated, so leaving it as a
  // TODO risks the Tools UI staying enabled against a daemon too old to
  // parse the request -- a raw error on click instead of a disabled
  // control with a tooltip.
  tools: 11,
} as const;

export type Feature = keyof typeof FEATURE_MIN_VERSION;

/// Null when available; otherwise the reason to show as a tooltip.
export function featureBlockedReason(c: DaemonCompat | null, f: Feature): string | null {
  if (!c) return null; // not connected yet — don't pre-emptively grey things out
  const needed = FEATURE_MIN_VERSION[f];
  if (c.daemonVersion >= needed) return null;
  return `Needs daemon v${needed}; the running daemon is v${c.daemonVersion}. Restart the daemon to enable this.`;
}
