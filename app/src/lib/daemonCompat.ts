// The frontend's view of the compatibility verdict Rust negotiated with
// the daemon at connect time (session::DaemonCompat). Purely derived/pure
// functions here -- the store that holds the live value lives in
// layoutState.ts, which is what actually talks to Tauri.
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
  // A version ABOVE orchestration, which is the whole reason this entry
  // earns its keep: a v10 daemon runs rails happily and has no `tool_id`
  // column, so it accepts a tool step and stores one with neither a card
  // nor a tool -- an untitled chip, and a plan a newer daemon then
  // refuses outright. Read by the Orchestration tab, which greys out
  // every surface that can place a tool.
  tools: 11,
  // The archive (plans/archive/). A v12 daemon cannot parse
  // ArchiveCard/UnarchiveCard at all, so the toggle and both actions are
  // disabled with the reason rather than failing on click.
  archive: 13,
  // `[agent] model`. A v13 daemon parses SetRootConfigField perfectly
  // well and then refuses the key -- its allow-list has no `model` --
  // so nothing on the wire gate catches this. The row is disabled with
  // the reason rather than failing on blur.
  agentModel: 14,
  // Groups: a stage's `mode` and `name`. A v14 daemon has neither column
  // on orch_stages, so it accepts a sequential group, drops both fields
  // and hands the stage back parallel -- the group silently runs its
  // members all at once in one checkout. `mode` widens an EXISTING
  // request, so min_version_for is structurally blind to it and this
  // entry is the only gate there is. Every surface that can form or
  // change a group reads it through featureBlockedReason.
  groups: 15,
  // A rail's `branch` (spec O15). A v15 daemon has no `branch` column on
  // orch_rails, so it accepts the binding, drops the field and hands the
  // rail back unbound -- the human's choice vanishes with no error, and
  // the rail then runs its steps on whatever happens to be checked out.
  // Like `groups`, this widens an EXISTING request (SetOrchestration),
  // which min_version_for gates by TYPE and so cannot see; this entry is
  // the only gate there is, and the bind dialog's Branch section is the
  // one surface that can form the payload.
  railBranch: 16,
  // The root config's top-level `prd` (the pickable PRD path). A v16
  // daemon's SetRootConfigField allow-list has no `prd`, so it refuses
  // the key -- loudly, unlike `groups` and `railBranch` above. It is
  // gated anyway because refusing the WRITE is only half of it: a v16
  // daemon also keeps resolving `read_prd` and `has_prd` against the
  // hard-coded path, so a pick that somehow landed would leave the board
  // and the MCP tool reading a different file from the tab. Both
  // surfaces that can produce the payload -- the PRD tab's picker and
  // the Settings row -- read it through featureBlockedReason.
  prdPath: 17,
} as const;

export type Feature = keyof typeof FEATURE_MIN_VERSION;

/// Null when available; otherwise the reason to show as a tooltip.
export function featureBlockedReason(c: DaemonCompat | null, f: Feature): string | null {
  if (!c) return null; // not connected yet — don't pre-emptively grey things out
  const needed = FEATURE_MIN_VERSION[f];
  if (c.daemonVersion >= needed) return null;
  return `Needs daemon v${needed}; the running daemon is v${c.daemonVersion}. Restart the daemon to enable this.`;
}
