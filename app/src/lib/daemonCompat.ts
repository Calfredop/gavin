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

/// What a "Restart daemon" press actually achieved, said in one line.
///
/// The CTA's silent failure mode, and the reason it reads as a dead
/// button: a restart re-spawns the `gavin-daemon` binary sitting beside
/// the app (session.rs `resolve_daemon_binary_path`), so when THAT binary
/// is itself the stale one -- an app rebuilt past a protocol bump while
/// the daemon binary was not -- the daemon comes back at exactly the
/// version it left at, `compatMessage` re-renders identical text, and the
/// press looks like nothing happened at all. It did happen; it just could
/// never help. Naming that outcome is the difference between a broken
/// button and an honest one.
///
/// Null means "nothing to add": the restart cleared the degradation, so
/// the banner is on its way out and a note under it would only flash.
export function restartOutcome(beforeVersion: number | null, after: DaemonCompat | null): string | null {
  if (!after || !after.degraded) return null;
  if (beforeVersion !== null && after.daemonVersion === beforeVersion) {
    return (
      `The daemon restarted and came back at v${after.daemonVersion} — the same version. ` +
      `The gavin-daemon binary beside the app is that version too, so restarting cannot lift it: ` +
      `rebuild or update gavin-daemon first, then restart it again.`
    );
  }
  const from = beforeVersion === null ? "" : ` (it was v${beforeVersion})`;
  return `The daemon restarted at v${after.daemonVersion}${from}, still older than this app's v${after.appVersion}.`;
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
  // Card attachments. Two separate holes, and only one of them is loud:
  // a v18 daemon's set_plan_field allow-list has no `attachments`, so
  // that write fails with a message -- but `CreatePlan` merely GAINED a
  // field, which a v18 daemon parses fine and drops on the floor. The
  // card would be filed looking exactly as asked for and carry none of
  // the human's attachments, and nothing on the wire would say so.
  // min_version_for gates request TYPES, not payloads, so this entry is
  // the only gate there is; every surface that can produce the payload
  // -- the card detail modal's Attachments section and the ⌘N composer's
  // -- reads it through featureBlockedReason.
  attachments: 19,
  // Interrupted runs. Not a request at all -- v20 changed what RECOVERY
  // does (a killed agent comes back as a bare shell, marked
  // `interrupted`, instead of having its whole prompt re-run) and added
  // the `SessionInterrupted` push that says so. `min_version_for` gates
  // request types and cannot see either half, and no UI surface produces
  // a payload to gate.
  //
  // It earns an entry anyway because one piece of COPY asserts the new
  // behaviour: the Restart-daemon confirmation tells the human their
  // agents will be stopped and not restarted. On a v19 daemon that is
  // the opposite of what happens, and it is the one screen where being
  // wrong costs work. See `restartConfirmLines`.
  interruptedRuns: 20,
} as const;

export type Feature = keyof typeof FEATURE_MIN_VERSION;

/// What the Restart-daemon confirmation says will happen, which depends
/// on which daemon is about to be restarted.
///
/// On v20+ a running agent is stopped and NOT restarted: its command
/// carries the whole prompt, so re-running it would be a second
/// from-scratch attempt rather than a recovery. The card, rail step or
/// commit run bound to it is marked interrupted and offers Resume.
///
/// On an older daemon every command is re-run on the way back up, which
/// is the failure this warning exists to describe -- so the copy has to
/// say that instead. A confirmation that promises the safe behaviour and
/// then delivers the destructive one is worse than no confirmation.
export function restartConfirmLines(c: DaemonCompat | null): string[] {
  const stopped =
    c !== null && c.daemonVersion < FEATURE_MIN_VERSION.interruptedRuns
      ? `Any agent that is running right now is stopped — and this daemon (v${c.daemonVersion}) will RE-RUN its command from the beginning, in a checkout that already carries its edits. Restart it only if you are willing to have that work repeated.`
      : "Any agent that is running right now is stopped, and not restarted — its card, rail step or commit run is marked interrupted so you can resume it.";
  return [
    "Every terminal session restarts as a fresh shell at its current folder.",
    stopped,
    "Scrollback in open terminals is lost.",
    "The window stays open — plans, boards and git keep working.",
  ];
}

/// Null when available; otherwise the reason to show as a tooltip.
export function featureBlockedReason(c: DaemonCompat | null, f: Feature): string | null {
  if (!c) return null; // not connected yet — don't pre-emptively grey things out
  const needed = FEATURE_MIN_VERSION[f];
  if (c.daemonVersion >= needed) return null;
  return `Needs daemon v${needed}; the running daemon is v${c.daemonVersion}. Restart the daemon to enable this.`;
}
