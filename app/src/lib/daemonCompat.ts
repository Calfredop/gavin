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
  // wrong costs work. See `restartStopsAgentsLine`.
  interruptedRuns: 20,
  // Orphan detection: whether the daemon PROBES the process a killed
  // session named, rather than inferring from its epoch that it must be
  // gone. Half of it is a request type `min_version_for` does gate
  // (EndOrphan); this entry exists for the other half, and it gates
  // something sharper than a disabled button.
  //
  // `SessionSummary.orphan` is absent from a v23 daemon because that
  // daemon never looked -- not because nothing survived. Reading the
  // absence as "no orphan" would let the app assert a clean stop nobody
  // measured, next to a Resume button, which is exactly how a second
  // agent ends up in a checkout that already has one. Every consumer
  // goes through `orphanDetectionAvailable` in orphan.ts, which turns
  // this number into "did anyone check".
  orphanDetection: 24,
  // The task manager's two figure columns. `SessionProcesses` is a new
  // request TYPE, so min_version_for is the real gate and nothing is
  // silently dropped -- this entry exists because the panel still has to
  // say WHY the columns are empty. Blank cells against an older daemon
  // would read as "this session is using nothing", which is a
  // measurement nobody took. The list itself needs no gate: ListSessions
  // has been in the protocol since v1, so jumping and killing work all
  // the way down.
  sessionMetrics: 25,
  // Conversation resume. v21 widened SetStepRun and LinkCardSession with
  // `conversation_id` and `launch_cwd` -- the agent CLI's own id for the
  // conversation a run IS, and the directory it was launched in. A v20
  // daemon parses both requests perfectly well and drops both fields on
  // the floor, so `min_version_for` (which gates request TYPES) is
  // structurally blind to it and this entry is the only gate there is.
  //
  // Its consumer is the LAUNCH, not a disabled control: against an older
  // daemon gavin does not mint a conversation id at all
  // (`conversationIdForLaunch`), because an id that cannot be persisted
  // is an id no Resume can ever use -- and the card detail modal's
  // Resume copy, which promises the same conversation back, would be
  // promising something the daemon threw away.
  conversationResume: 21,
  // Failure detection. Unlike the entry above this half IS a new request
  // type (`SetFailurePatterns`), so the wire gate catches it and
  // `armFailureDetection` swallows the refusal -- a quiet agent then
  // reads as idle exactly as it did before v21. The entry exists for the
  // COPY: the card detail modal and the sidebar recap both name a
  // failure as a thing gavin can see, and on an older daemon it cannot.
  failureDetection: 21,
  // Unattended auto-resume. v22 widened three EXISTING requests --
  // `SetOrchestration` with a rail's `autoResume`, `SetStepRun` and
  // `LinkCardSession` with the run's `resumeAttempts` -- so
  // `min_version_for` (which gates request TYPES) is structurally blind
  // to all three, and this entry is the only gate there is.
  //
  // What a v21 daemon would do with them is the reason it must be a hard
  // gate rather than a warning. It parses each request perfectly well and
  // drops the new field on the floor: the rail's opt-in vanishes, and --
  // far worse -- the BUDGET vanishes with it. Every resume would then
  // read `resumeAttempts` back as absent, which means "never resumed",
  // which means resume again: an unbounded loop wearing the costume of a
  // limit. So both consent surfaces (the rail header's toggle and the
  // workspace setting for card runs) are disabled with the reason, and
  // the driver itself refuses to arm.
  autoResume: 22,
  // The per-run Changes view. v26 widened `LinkCardSession` with
  // `base_sha` -- the commit a run's checkout was on when the agent
  // started -- so `min_version_for` (which gates request TYPES) is
  // structurally blind to it, and this entry is the only gate there is.
  //
  // A v25 daemon parses the launch perfectly well and drops the sha,
  // which is the worst shape a missing field can take here: the button
  // would still be there, and it would diff against nothing. So the
  // consumer is the LAUNCH -- `baseShaForLaunch` does not ask git for a
  // sha it knows cannot be persisted -- and both surfaces read the
  // absence back as "no baseline was recorded", with this reason
  // attached, rather than as a run that changed nothing.
  runChanges: 26,
  // A card's run history. v27 added `Request::CardRuns`, a new request
  // TYPE, so `min_version_for` already refuses it against an older
  // daemon and nothing can be silently dropped -- this entry is not
  // guarding a widened payload.
  //
  // It earns its place for the sentence instead. An older daemon keeps
  // no history at all: `card_sessions` is upserted, so every run but the
  // last was overwritten the moment the next one launched. Without the
  // gate the panel would open, ask, take the version error and have to
  // render it -- or worse, catch it and show an empty list, which reads
  // as "this card has never been run" about a card the human watched an
  // agent work.
  runHistory: 27,
} as const;

export type Feature = keyof typeof FEATURE_MIN_VERSION;

/// The one sentence in a restart confirmation whose truth depends on
/// which daemon is about to be restarted.
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
///
/// Exported on its own because two surfaces now offer the restart and
/// they do not ask with the same list: Settings asks about the daemon in
/// the abstract, the task manager asks about the sessions it is showing.
/// Sharing the sentence rather than the array is what keeps the version
/// warning from being written twice and drifting.
export function restartStopsAgentsLine(c: DaemonCompat | null): string {
  return c !== null && c.daemonVersion < FEATURE_MIN_VERSION.interruptedRuns
    ? `Any agent that is running right now is stopped — and this daemon (v${c.daemonVersion}) will RE-RUN its command from the beginning, in a checkout that already carries its edits. Restart it only if you are willing to have that work repeated.`
    : "Any agent that is running right now is stopped, and not restarted — its card, rail step or commit run is marked interrupted so you can resume it.";
}

/// What the Settings panel's Restart-daemon confirmation says will
/// happen.
export function restartConfirmLines(c: DaemonCompat | null): string[] {
  return [
    "Every terminal session restarts as a fresh shell at its current folder.",
    restartStopsAgentsLine(c),
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
