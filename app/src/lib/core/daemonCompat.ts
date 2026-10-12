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
  // Queued follow-ups. All four requests are new TYPES, so the wire gate
  // in `min_version_for` genuinely stops every one of them -- nothing is
  // silently stored or silently dropped, and against a v25 daemon the
  // app behaves exactly as it did before the feature existed.
  //
  // The entry exists because refusing to send is not the same as saying
  // why. The failure this gates is a compose box that accepts a
  // follow-up, reports nothing, and never delivers it -- and the human
  // wrote it precisely because they were about to walk away, so the
  // silence would last until they came back to an agent that never got
  // the message. Every surface that can queue (the terminal pane's queue
  // strip, and "Send to workspace agent" when the agent is busy) reads
  // this through `featureBlockedReason`.
  queuedFollowUps: 29,
  // Standalone tool runs. All three requests are new TYPES, so the wire
  // gate in min_version_for genuinely stops them -- nothing is silently
  // stored or dropped. The entry exists because a Run button that
  // launches a session and then reports nothing about it is worse than
  // one that is dark: the whole promise of the Tools tab is that a
  // failure nobody watched is still on the row afterwards, and against a
  // v29 daemon there is nowhere to keep it. The tab greys Run and says
  // this instead.
  toolRuns: 30,
  // A tool's own working directory. The OTHER half of v30, and the half
  // min_version_for is structurally blind to: `cwd` widens `SaveTool`'s
  // ToolDef, which the wire gate sorts by request TYPE. A v29 daemon
  // takes the save, drops the directory and hands the tool back rooted
  // wherever the launcher stood -- the human's choice gone with no
  // error, which is exactly the `groups`/`railBranch` failure again.
  // The library dialog's working-directory field is the one surface
  // that can produce the payload, and it reads this through
  // featureBlockedReason.
  toolCwd: 30,
  // A tool's own icon, and the third widening of `SaveTool`'s ToolDef --
  // after `cwd` above, and on exactly the same blind spot:
  // min_version_for sorts by request TYPE, so a v32 daemon takes the
  // save, drops the name and hands the tool back wearing its kind's
  // glyph. The human picked a rocket, the tool comes back a terminal,
  // and nothing on the wire said no.
  //
  // Which makes it the `groups`/`railBranch`/`toolCwd` failure again,
  // with one difference worth naming: an icon is PURELY cosmetic, so
  // there is no second symptom to notice later -- a dropped working
  // directory eventually runs something in the wrong place, a dropped
  // icon just quietly never appears. The picker in the library dialog is
  // the one surface that can produce the payload, and it is disabled
  // with this reason rather than offering a choice that goes nowhere.
  toolIcon: 33,
  // A card's `complexity:`. Two holes, and they fail differently -- the
  // same split `attachments` has, and the silent half is again the worse
  // one. A v30 daemon's set_plan_field allow-list has no `complexity`,
  // so that write fails with a message; but `CreatePlan` merely GAINED a
  // field, which a v30 daemon parses fine and drops on the floor. The
  // card would be filed looking exactly as asked for, carry no level,
  // and run at whatever the workspace's default agent is -- which is
  // indistinguishable from a card nobody rated. min_version_for gates
  // request TYPES, not payloads, so this entry is the only gate there
  // is; both surfaces that can produce the payload (the card detail
  // modal's Complexity row and the ⌘N composer's) read it through
  // featureBlockedReason.
  complexity: 31,
  // The root config's `[agent] model_flag`. A v30 daemon's
  // SetRootConfigField allow-list has no `model_flag`, so it refuses the
  // key -- loudly, like `prdPath` and unlike `groups`. It is gated
  // anyway because refusing the write is only half of it: a v30 daemon
  // also does not PARSE the key, so a flag somehow already in
  // config.toml would never reach `AgentConfig.modelFlag` and the model
  // gavin composed would silently go nowhere. The Settings panel's Model
  // flag row is the one surface that can produce the payload.
  agentModelFlag: 31,
  // A card's own `agent:` and `model:`. Two holes again, and this time
  // BOTH matter -- the write and the read.
  //
  // The write is the loud half: a v31 daemon's set_plan_field allow-list
  // has neither key, so the change fails with a message. The read is the
  // silent one, and it is why the gate cannot just be a try/catch on the
  // write: a v31 daemon never PARSES either line, so `PlanFileInfo`
  // comes back with both absent and a card that already carries an
  // override reads as carrying none. Nothing is broken on screen; the
  // card simply runs at the workspace's default agent, which is
  // indistinguishable from a card nobody overrode.
  //
  // min_version_for gates request TYPES, and this change adds no
  // variant -- only two allowed key names and two serde(default) fields
  // -- so it is structurally blind to all of it. This entry is the only
  // gate there is; the card detail modal and the Plans tab strip both
  // read it through featureBlockedReason.
  cardAgent: 32,
  // Client identity on the daemon socket (phase 1 of the remote-access
  // design). `Request::Hello` is a new request TYPE, so `min_version_for`
  // is the real wire gate -- against an older daemon the app never sends
  // Hello, `app_handshake` skips it, and the app connects as `local` with
  // today's full reach. Nothing is silently dropped: Hello carries no
  // field an older daemon would parse-and-discard.
  //
  // The entry exists for the COPY, as `sessionMetrics` and `runHistory`
  // do: the Settings "Remote access" surface -- the Require-a-token
  // switch, and the pairing/device controls phases 2+ add -- reads it
  // through featureBlockedReason, so against an older daemon it is greyed
  // with the version it needs rather than offering a control the daemon
  // cannot honour.
  clientIdentity: 35,
  // What DELETING a card actually takes with it. Not a request type and
  // not a widened payload -- v34 changed what `DeleteCardFile` DOES, so
  // `min_version_for` is blind to it in principle and this entry is the
  // only gate there is.
  //
  // A v33 daemon deletes the file, clears the session bindings, and
  // leaves the rest: the run history stays keyed to a path nothing can
  // open, and every rail step aimed at the card stays on its rail as a
  // chip reading "card file is missing" that no restore can fix, because
  // the file is gone for good.
  //
  // Its consumer is the delete confirmation's COPY rather than a
  // disabled button, and deliberately so: the delete still does the
  // thing the human asked for, so greying it out would refuse the whole
  // action over the half that degrades. What must not happen is a prompt
  // that promises to take the rail steps along against a daemon that
  // will not -- an archive purge is the one screen where being wrong
  // cannot be undone.
  cardPurge: 34,
  // A rail's own `trigger` -- the condition that arms it without a human
  // pressing Start. `Rail.branch` at v16 all over again, and the failure
  // is the same shape: `trigger` widens SetOrchestration, a request that
  // has existed since v10, so `min_version_for` (which gates request
  // TYPES) is structurally blind to it. A v35 daemon takes the write,
  // drops the field and hands the rail back with no trigger at all.
  //
  // 36 rather than the 35 this was written against: `clientIdentity`
  // above took 35 on another branch and the two landed in one merge, so
  // a daemon reporting 35 may well be one that has `Hello` and no
  // `trigger`. Gating at 35 would aim this exact silent drop at it.
  //
  // Which is the worse half of it. The human picks "after every other
  // rail", the picker snaps back to "starts by hand", and nothing on the
  // wire says no -- so the rail they set up to run itself sits idle
  // through the night. The bind dialog's Trigger panel is the one
  // surface that can produce the payload, and it is disabled with this
  // reason rather than offering a choice that goes nowhere.
  railTrigger: 36,
  // The rendered screen as TEXT (`Request::SessionScreen`, v39), which
  // the TypeSafe turn verdict is judged on. A new request TYPE, so
  // `min_version_for` already refuses it against an older daemon and
  // nothing can be silently dropped -- this entry is not guarding a
  // widened payload.
  //
  // It earns its place because refusing to SEND decides nothing about
  // what to do INSTEAD, and here the wrong answer is available and
  // plausible: a driver that asked for a screen, took the version error
  // and judged the turn on the empty string it was left holding would
  // be passing a confident verdict on a blank terminal -- and a blank
  // terminal reads as a finished turn. So the consumer skips the
  // request outright and keeps today's answer, which is exactly what
  // every other fallback in this feature does (`turnVerdictSkip` in
  // turnVerdictState.ts), and the Settings toggle reads the same entry
  // through `featureBlockedReason` so the switch says why it is dark
  // rather than silently doing nothing.
  turnVerdict: 39,
  // Card runs on an ssh workspace: the three workspace-file requests the
  // desktop sends the HOST's daemon to read the card, classify its
  // attachments and write the agent-integration files there
  // (`2026-09-22-ssh-card-runs-design.md`). Checked against the host
  // daemon's version (`sshRunBlocked` in sshWorkspace.ts), never the
  // local one's: the local verdict says nothing about the machine the
  // run happens on. The consumer is the Run pill on an ssh workspace's
  // board, and the launch seam behind it.
  sshCardRuns: 40,
  // The Git tab and Files tree on an ssh workspace: the host daemon's
  // v41 `RunGit` and `ListWorkspaceDir`
  // (`2026-09-22-ssh-git-files-design.md`). Checked against the HOST
  // daemon's version (`sshTabBlocked` in sshWorkspace.ts); the consumers
  // are the two hub views, which show the notice until the host is new
  // enough.
  sshGitFiles: 41,
  // Human items: the `Decision:` / `Human test:` lines a card carries,
  // and the two writes behind them (v42). Both requests are new TYPES,
  // so `min_version_for` genuinely refuses `FileHumanItem` and
  // `ResolveHumanItem` against an older daemon and no write can be
  // silently dropped.
  //
  // The entry is for the READ, which nothing on the wire guards at all.
  // `PlanFileInfo.human_items` is `Option<Vec<HumanItem>>`, and a v41
  // daemon sends no such field -- not because the cards ask nothing, but
  // because it never PARSED the lines. Reading that absence as an empty
  // list would have the Decisions tab report "nothing is waiting on you"
  // for a workspace with a dozen open decisions in it, which is the one
  // wrong answer this tab must never give: the human would go away
  // satisfied.
  //
  // So the consumers are the answer controls (DecisionsHubView ->
  // DecisionsItemRow for decisions, ReviewHubView -> DecisionsItemRow
  // for human tests), which is also why the gate is on the ITEMS and
  // not the tab: waiting sessions, rail review gates and unreviewed
  // cards are all readable from an older daemon, so the tab still lists
  // them and says why the items are missing rather than drawing an empty
  // list that looks like good news.
  humanItems: 42,
  // Remote access, phase 2: pairing a phone, the device list, revocation,
  // and the remote-access switch (`docs/security/05-remote-access.md` §3,
  // §7 "Phase 2 additions"). Seven new request TYPES, so `min_version_for`
  // already refuses every one of them against a v41 daemon and nothing can
  // be silently dropped -- this entry is not guarding a widened payload.
  //
  // It earns its place for the reason `turnVerdict` and `sessionMetrics`
  // earn theirs: refusing to SEND decides nothing about what to show
  // instead. A Remote access section that simply is not there against an
  // older daemon reads as "gavin cannot do this", when the truth is
  // "gavin has not been restarted" -- and this is the panel that promises
  // a revocation reaches a phone at 02:00, which is not a promise anyone
  // should have to guess at. Greyed, with the version it needs, is the
  // only honest state.
  //
  // Its consumers have landed, so this is not a dead gate (CLAUDE.md):
  // `remoteAccess.ts`'s `remoteAccessBlocked` reads it, and the Settings
  // section greys the toggle, the relay URL row, "Pair a device", the
  // device list and both Revoke controls behind that one verdict.
  remoteAccess: 42,
  // What finishes those two tabs on an ssh workspace: the host daemon's
  // v42 streaming git (`RunGitStreaming`/`CancelGitOp`, the fetch, pull
  // and push the desktop kept), its worktree watch
  // (`WatchGitWorktree`), and the Files tree's three mutations
  // (`Create`/`Rename`/`TrashWorkspacePath`)
  // (`2026-09-23-ssh-git-sync-and-conflicts-design.md`). Checked against
  // the HOST daemon's version, like the two entries above it
  // (`sshSyncBlocked` in sshWorkspace.ts).
  //
  // Conflicts and `.gitignore` are deliberately NOT here: they route
  // through the v40 file requests, so they work on a v41 host and sit
  // behind `sshGitFiles` with the rest of the tab.
  sshGitSync: 42,
  // Companion encrypted notifications (v44): the desk's notify/resolve
  // batch, the Push gateway URL, and the Device's send permission.
  // Three new TYPES, so `min_version_for` already refuses them against
  // an older daemon. The consumer is the companion-notify driver that
  // posts the desk's waiting-set diff; against an older daemon it stays
  // quiet rather than throwing on every inbox change.
  //
  // 49, not the 44 they shipped at: before the Device wire was
  // renumbered to 51..55, a daemon built on its branch answered 45..48
  // without knowing any of the three. Gated at 44, the driver would send
  // to one and be refused on every inbox change. A main-built v44..48
  // daemon, which does know them, is told it is too old -- the cheap
  // direction to be wrong in, and a rebuild and restart fix it.
  companionNotifications: 49,
  // A rail trigger's `at` -- the epoch-seconds instant an `at-time`
  // schedule waits for (v45). Widens SetOrchestration the same way
  // `trigger` itself did at v36, so `min_version_for` is structurally
  // blind to it. A v44 daemon takes the write, drops the field and
  // hands the rail back with kind `at-time` and no time -- a condition
  // that never fires, and that the chip then draws as broken.
  //
  // The bind dialog's Trigger panel already gates the WHOLE panel on
  // `railTrigger` (36); this entry gates only the datetime choice and
  // its picker, so a v36–v44 daemon still offers the standing triggers
  // and refuses the one payload it cannot store. See FEATURE_MIN_VERSION
  // discipline in CLAUDE.md: the entry alone is a dead gate without a
  // featureBlockedReason consumer on every surface that can produce it.
  railSchedule: 45,
  // The daemon runs Headroom (v46): its status, Check again and Locate…,
  // and the Install that also serves as Update. Five new request TYPES,
  // so `min_version_for` already refuses every one of them against an
  // older daemon and nothing can be silently dropped -- this entry is not
  // guarding a widened payload.
  //
  // It earns its place for `remoteAccess`'s reason: refusing to SEND
  // decides nothing about what to show instead. Asked of a v45 daemon,
  // the status comes back as a wire error, and a section that drew that
  // as "Absent" would offer an Install the daemon cannot run; one that
  // drew nothing would read as "gavin has no Headroom" when the truth is
  // "the daemon has not been restarted".
  //
  // Its consumer is the one reader, `readHeadroom` in headroomState.ts,
  // which settles on the reason instead of asking. Every surface draws
  // from that reading -- Settings' Headroom section, the workspace
  // switch and the wizard's step -- so the gate reaches all three, and
  // the wizard's step is settled rather than pending forever.
  headroomSetup: 46,
  // Compressed sessions (`2026-09-28-headroom-design.md`). v47 is two
  // changes, and this entry is the only gate either of them has in the
  // app.
  //
  // `CreateSession` was WIDENED with `profileId`, the agent profile
  // doing the launching, which is what makes a session a candidate for
  // compression. `min_version_for` gates request TYPES and this request
  // has been v1 since v1, so it is structurally blind to the field: a
  // v46 daemon parses the launch, drops the profile and starts the
  // agent uncompressed, with nothing anywhere to say why.
  //
  // Its consumer is the LAUNCH, like `conversationResume` and
  // `runChanges` and unlike a disabled control: against an older daemon
  // gavin names no profile at all (`profileIdForLaunch` in
  // layoutState.ts), and the agent launches exactly as it did before
  // there was anything to decide. A launch is never refused over it --
  // compression must not be able to stop a rail. Every surface that
  // launches an agent goes through that one function
  // (compressedLaunchSurfaces.test.ts holds the list), and the host
  // withholds the field besides (`profile_for_daemon` in session.rs).
  //
  // `SetHeadroomWorkspaces`, the daemon's copy of the switch, is a new
  // TYPE, so the wire gate stops it. It reads this entry for the reason
  // `companionNotifications` is read: a driver that sent it to an older
  // daemon would take a version error on every settings change
  // (`compressionSwitchBlocked` in compressionDriver.ts).
  compressedLaunch: 47,
  // The custom agent's API family (v48), which is what lets Headroom
  // compress a custom agent at all: gavin knows nothing of the binary,
  // and the family names the one variable that routes it. It WIDENS
  // `CreateSession` a second time, with `apiFamily`, so `min_version_for`
  // is as blind to it as to `compressedLaunch`'s profile: a v47 daemon
  // reads the profile, drops the family and launches the agent
  // uncompressed as `no-recipe`.
  //
  // No launch surface sends it. The host reads the family from the
  // custom agent's own settings and attaches it to a launch of the
  // custom profile, and withholds it from an older daemon besides
  // (`api_family_for_daemon` in session.rs). So its consumer is the one
  // surface that produces the value: the API family picker in Settings
  // → Agents → Customs, disabled with this reason rather than offering a
  // choice the running daemon would drop.
  customApiFamily: 48,
  // Savings (v49): `HeadroomSavings`, every card run's snapshot since a
  // moment, which the hub sums into each agent's limit window. A new
  // request TYPE, so `min_version_for` already refuses it against an
  // older daemon and nothing can be silently dropped. The entry is read
  // for `companionNotifications`' reason: the hub asks on a timer, and a
  // loader that sent it to a v48 daemon would take a version error on
  // every tick. Its consumer is that loader (`loadHeadroomSavings` in
  // headroomSavingsState.ts), which does not ask and leaves the hub's
  // rows as they were -- an older daemon took no snapshots to sum.
  //
  // The snapshot's other half, `CardRun` widened with the saved tokens
  // and the request count, is a REPLY and needs no entry: an older
  // daemon's run has no snapshot, and absent is what the run history
  // reads as "nothing new to show".
  headroomSavings: 49,
  // Honest failures (v50), two changes and one gate.
  //
  // `CreateSession` was WIDENED a third time, with `withoutHeadroom`:
  // auto-resume's relaunch of a session that broke on Headroom, which
  // must go around it whatever Headroom looks like. `min_version_for`
  // cannot see a field, and a v49 daemon would drop this one and decide
  // the relaunch against the proxy the session just broke on -- spending
  // the one automatic attempt on it, fleet-wide. Its consumer is the
  // surface that produces it, auto-resume's decision
  // (`withoutHeadroomBlocked` in autoResume.ts, read by
  // autoResumeState.ts), which declines a `headroom` failure with this
  // reason rather than sending it; the host withholds the field besides
  // (`without_headroom_for_daemon` in session.rs).
  //
  // `HeadroomReach` is a new request TYPE, so the wire gate stops it;
  // the entry is read for `headroomSavings`' reason: the driver asks at
  // the end of every compressed turn, and asking a v49 daemon would be a
  // version error each time (`reachCheckBlocked` in
  // headroomReachDriver.ts).
  headroomFailures: 50,
  // The Relay's admission token (`companion-10`). v52 widened
  // `SetRemoteAccess` with `relay_admission`, and `min_version_for`
  // cannot see a field: an older daemon parses the request, stores the
  // switch and the URL, and drops the token on the floor. The field
  // would take a token and keep nothing, and the human would find out
  // when a Device that scanned the QR was refused by the Relay.
  //
  // Not a dead gate (CLAUDE.md): `remoteAccess.ts`'s
  // `relayAdmissionBlocked` reads it, and the Settings section greys the
  // admission field and its Clear button behind it, on top of the
  // section's own `remoteAccess` gate.
  //
  // The switch and the Relay URL are NOT behind it. An older daemon
  // stores both exactly as it always did, and what it does not do --
  // dial -- is not something a gate on a field can say; the section's
  // copy is where that lives.
  relayAdmission: 52,
  // The daemon DIALS (`companion-10`). Not a request type and not a
  // widened payload: v52 changed what the daemon does with a setting it
  // already stored, so `min_version_for` is blind to it in principle,
  // like `cardCleanup` above. An older daemon takes the switch and the
  // Relay URL exactly as a v52 one does and then dials nothing.
  //
  // Consumers, both in `remoteAccess.ts`: `transportNote`, which stops
  // the section telling the human that the daemon is connected to a
  // Relay it has never dialled; and `pairingUnavailable`, which greys
  // Pair a device rather than drawing a QR no Device can use.
  //
  // The same number as `relayAdmission` and a separate entry, because
  // they are separate promises: one is about a field being kept, the
  // other about a socket being opened, and the next bump may move one
  // without the other.
  relayDial: 52,
  // Agent effort (v56, `2026-09-30-agent-effort-design.md`). The daemon
  // half is `cardAgent`'s shape again: `[agent] effort`/`effort_flag`
  // and a card's `effort:` line widen EXISTING requests and replies, so
  // `min_version_for` is blind to them. A v55 daemon refuses the three
  // writes loudly and, worse, never PARSES the lines -- a card that
  // carries `effort: max` reads back as carrying none and runs at the
  // agent's own default with nothing on screen to say so.
  //
  // Consumers: the workspace Settings tab's Effort and Effort flag rows,
  // and the card's Effort picker (CardAgentControls, in the card detail
  // modal and the Plans tab strip). The app-wide defaults, the custom
  // agent's flag and both complexity tables live in config.json and
  // work against any daemon, so they are not behind it.
  agentEffort: 56,
  // Adopted-memory retrieval (v60, `feat-vectorized-memory.md`). Three
  // new TYPES, so `min_version_for` is the wire gate and nothing can be
  // silently dropped. The entry is `headroomSetup`'s: a Memory step that
  // asked an older daemon would draw the wire error as a missing model
  // and offer a download the daemon cannot run.
  //
  // Its consumer is `readMemoryIndex` in memoryIndexState.ts, which
  // settles on the reason instead of asking -- so the wizard's step, the
  // Home count and the open-time backfill all stand down -- and the
  // index sync after Adopt, which skips the ask.
  memoryIndex: 60,
  // Where the daemon's dial stands (`companion-32`): `GetRelayState` and
  // the `RelayStateChanged` push are v61 request/response TYPES an older
  // daemon answers `Unsupported`.
  //
  // Consumer: `remoteAccess.ts`'s `relayStateBlocked`, which the Settings
  // section reads before it asks and before it draws the badge beside the
  // Relay URL, and which `pairingUnavailable` reads so that an older
  // daemon's silence is not taken for a Relay that failed.
  relayState: 61,
  // The direct listener (v69, ADR 0009): `SetDirectAccess` and
  // `GetDirectState` are new request TYPES an older daemon answers
  // `Unsupported`, and `Devices.directAccessEnabled` is a widened reply it
  // never sends -- which would read as "off" for a daemon that has no
  // switch to be off.
  //
  // Consumer: `remoteAccess.ts`'s `directAccessBlocked`, which the
  // Settings section reads before it draws or sends the Direct connection
  // switch and before it asks where the listener stands, and which
  // `pairingUnavailable` reads before it lets a listener stand in for the
  // Relay.
  directAccess: 69,
  // A refused Device on its row (`companion-34`): `DeviceInfo.lastRefusal`
  // and the `DeviceRefusalChanged` push are v62. An older daemon sends
  // neither, and a row with no refusal reads as "nothing was refused" --
  // which is a claim an older daemon cannot back.
  //
  // Consumer: `devicesPanel.ts`'s `refusalsBlocked`, which the Devices
  // panel reads to say so under the list rather than leave the silence to
  // be taken for a clean record.
  deviceRefusals: 62,
  // Where each Device is and what it is doing (`companion-16`):
  // `DeviceInfo.presence` and the `DevicePresenceChanged` push are v63. An
  // older daemon sends neither, so a row with no presence line reads as a
  // Device doing nothing -- which that daemon cannot say -- and no session
  // a Device starts is placed at the desk.
  //
  // Consumer: `devicesPanel.ts`'s `presenceBlocked`, which the Devices panel
  // reads to say so under the list.
  devicePresence: 63,
  // A browser per agent session (`playwright-browser-broker`): the
  // `PlaywrightEndpoint`, `WatchBrowser` and `ListBrowsers` request TYPES
  // and the `BrowserChanged` push are v65. An older daemon has no browser
  // to show, so an empty pane or a missing chip would read as an agent
  // that never opened one.
  //
  // Consumer: the live pane and the tab's browser chip
  // (`playwright-live-pane.md`), which say why there is no view instead.
  playwrightBrowser: 65,
  // Companion notifications reaching a phone (v67): a Device hands this
  // Workstation its send permission (`SetThisDeviceSendPermission`, a new
  // TYPE the shell sends and nothing here does), and two replies widen --
  // `Devices.pushGatewayUrl` and `DeviceInfo.notifies`. An older daemon
  // sends neither, so its empty field and its rows with no "notifies"
  // would be claims it cannot back; and no phone can hand it a
  // permission, so a gateway set there notifies nobody.
  //
  // Consumers: `remoteAccess.ts`'s `pushGatewayBlocked`, which the
  // Settings section's Push gateway field reads before it draws or saves,
  // and which the Devices panel reads before it draws the word.
  pushGateway: 67,
  // Session ownership (v68, ADR 0008): `SetSessionOwner` and
  // `ListSessionOwners` are new TYPES and `SessionOwnerChanged` a push. An
  // older daemon locks nothing -- two Devices and the desk type into one
  // session together, as before -- so a surface that would draw the lock or
  // offer Take over / Hand over has to say ownership is missing rather than
  // show a session as free that nobody is guarding.
  //
  // Consumers: `sessionOwnershipState.ts`'s `ownershipBlocked`, which the
  // Devices panel reads to say so under the list, and which the Companion's
  // terminal reads for its lock bar and its Hand over button.
  sessionOwnership: 68,
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
