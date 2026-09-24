use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::{BufRead, Read, Write};

pub mod transport;

/// Cap on a single protocol line, so a client that never sends a newline
/// can't grow the daemon's read buffer unbounded. `pub` so gavin-mcp's
/// stdin reader (SC-10) can enforce the exact same cap instead of
/// carrying its own copy of the number.
pub const MAX_LINE_BYTES: u64 = 1024 * 1024;

/// Bumped on ANY wire-breaking change. The daemon reports it via
/// Request::GetProtocolVersion; the app (at bootstrap) and gavin-mcp (at
/// connect) probe it and turn mismatches -- including the
/// connection-close an older daemon produces when it can't parse the
/// probe at all -- into actionable "restart the daemon" errors instead of
/// mysteries (see the 2026-08-07 stale-daemon incident).
///
/// v42 adds `FileHumanItem` and `ResolveHumanItem`: the two writes behind
/// the Decisions tab, where a card's checklist carries the questions and
/// the hands-on checks that are the human's to settle
/// (`tb-developed-feat-decisions-tab.md`). Two new TYPES, gated by
/// `min_version_for`, so an older daemon never receives either.
///
/// The same version also widens `PlanFileInfo` with `human_items`, the
/// parsed reading of those checklist lines, and THAT half is the one a
/// version match cannot see. It is `Option<Vec<_>>` rather than the
/// `serde(default)` `Vec` `attachments` uses, and deliberately: the tree
/// crosses the Tauri host, which deserializes and re-serializes it, so a
/// defaulted `Vec` would turn "this daemon never looked" into "this card
/// has nothing waiting" on the way through -- the `orphan` reading at
/// v24, one layer further out. `None` survives that round trip as `null`,
/// which is what lets the tab say "unknown" instead of inventing an empty
/// list. The app's `FEATURE_MIN_VERSION` entry and its
/// `featureBlockedReason` consumer belong with the tab itself
/// (`decisions-tab-view.md`); an entry landed here, with nothing reading
/// it, would be a dead gate.
///
/// v41 adds `RunGit` and `ListWorkspaceDir`: the Git tab's git subcommands
/// and the Files tree's directory listing, run on a daemon on another
/// machine (`2026-09-22-ssh-git-files-design.md`). Two new TYPES, gated by
/// `min_version_for`; the app mirrors them as
/// FEATURE_MIN_VERSION.sshGitFiles against the HOST's version.
///
/// v40 adds `ReadWorkspaceFile`, `WriteWorkspaceFile` and
/// `StatWorkspacePaths`: the file access a desktop needs from a daemon on
/// another machine to compose a card's prompt there and to write the
/// agent-integration files where the agent runs
/// (`2026-09-22-ssh-card-runs-design.md`). Three new TYPES, gated by
/// `min_version_for`; the app mirrors them as
/// FEATURE_MIN_VERSION.sshCardRuns, checked against the HOST daemon's
/// version, never the local one's.
///
/// v39 added `Request::SessionScreen`: "what does this session's screen
/// say right now", answered as PLAIN TEXT from the same per-session
/// terminal parser `Snapshot` repaints from (`SessionScreen::contents`).
///
/// `Snapshot` already reaches that model and cannot serve this: it
/// answers in ESCAPE SEQUENCES aimed at a terminal, and it writes them
/// to the session's attached writer rather than replying to the caller
/// -- it exists to repaint a reconnected xterm. A reader that wants the
/// TEXT of a turn that has just gone quiet has nowhere to get it, and
/// the sessions that need it most are precisely the ones with no
/// terminal attached: a rail step in a background pane, a card run
/// nobody is looking at.
///
/// Visible rows only, never the scrollback, for the reason
/// `SessionScreen::contents` already gives: a verdict is about the turn
/// that just ended, and history is what must not condemn it.
///
/// A new request TYPE, so `min_version_for` gates it and an older daemon
/// never receives it. `daemonCompat.ts` owes a `turnVerdict: 39` entry
/// all the same, and for a sharper reason than "say why the button is
/// grey": refusing to SEND decides nothing about what to do instead. An
/// app that asked for a screen, got a version error and then judged the
/// turn on the empty string would be inventing a verdict out of a
/// failed read. The entry's consumer skips the verdict outright and
/// keeps today's answer.
///
/// v38 widens `NameSession` with `agent_conversation_id`: an agent whose
/// CLI mints its OWN conversation id (codex, gemini, opencode -- unlike
/// Claude Code, which gavin mints one for at launch) self-reports it once
/// it exists, and the daemon stores it in the reporting session's
/// `card_sessions.conversation_id`, exactly where a minted id already
/// lives, so resume treats the two sources alike. `serde(default)` on an
/// EXISTING request, which `min_version_for` gates by TYPE and therefore
/// cannot see -- but no `FEATURE_MIN_VERSION` / `featureBlockedReason` UI
/// gate is owed here the way `railTrigger` needed one at v36: this field
/// is only ever produced by `gavin-mcp`, which already fails closed on
/// ANY protocol mismatch (stricter than the app's own compat window), so
/// there is no daemon/gavin-mcp version pairing where it gets silently
/// dropped rather than the whole tool refusing outright.
///
/// v37 lets an AGENT author this workspace's tools: `SaveToolByRoot`,
/// `DeleteToolByRoot` and the `ToolsChanged` push. Two new request
/// TYPES, so `min_version_for` is the whole wire gate and no
/// daemonCompat.ts mirror is owed -- the app never sends either one, it
/// writes tools for a workspace whose id it already has.
///
/// The `ByRoot` pair exists so the DAEMON, not the caller, decides the
/// scope. `SaveTool` takes the scope from the payload, and an agent
/// handed that request could store a tool global to the machine or
/// rewrite one -- so the agent role is refused it (`agent_allows`) and
/// gets these instead, which resolve the root to one watched workspace
/// and stamp that workspace's id over whatever arrived. A built-in id,
/// a global tool and another workspace's tool are all refused rather
/// than silently re-scoped.
///
/// `ToolsChanged` is the push half, and it is the point in the same way
/// `set_rail_run_by_root`'s is: the tool library had no push because
/// every write originated in the app that already held the state, and
/// that stopped being true the moment an agent could write one. Without
/// it the Tools tab shows a library that is missing the tool the agent
/// just made until something else happens to refetch.
///
/// v36 widened `Rail` with `trigger` (a rail's own start condition).
/// `serde(default)` on an EXISTING request, which `min_version_for` gates
/// by TYPE and therefore cannot see -- so FEATURE_MIN_VERSION.railTrigger
/// is the gate that matters, and the bind dialog's Trigger panel is its
/// consumer.
///
/// It is 36 and not 35 because this and `Hello` below were written on
/// separate branches that each took 35, and landed in one merge. Letting
/// them share the number would have been a lie the app acts on: a daemon
/// built from the `Hello` side alone reports 35 and has no `trigger`, so
/// a client gating `railTrigger` at 35 would send it one -- and a v35
/// daemon takes the `SetOrchestration`, drops the field and hands the
/// rail back with no trigger, silently, which is the failure this
/// codebase keeps re-learning. A version number is a claim about a
/// capability SET; two disjoint sets cannot share one.
///
/// v35 gave a client an identity on the local socket: `Request::Hello` +
/// `Response::HelloAck`/`Forbidden`. A new request TYPE, so
/// `min_version_for` gates it and a pre-v35 daemon answers Unsupported --
/// every client reads "no identity yet" and nothing is dropped silently.
///
/// v34 makes `DeleteCardFile` mean it. A card's path is its identity in
/// both local databases, and deleting the file only ever cleared the
/// session bindings: the run history stayed keyed to a path nothing can
/// open, and every rail step aimed at the card stayed on the rail as a
/// chip reading "card file is missing" that no restore can ever fix.
/// The daemon now removes both, drops a stage its last step left empty,
/// and pushes `OrchestrationChanged` to every workspace whose rails
/// changed -- the same courtesy `archive_card`'s re-key already paid.
///
/// No new Request variant and no widened payload: this is a change to
/// what an existing request DOES, which `min_version_for` (a gate on
/// request TYPES) cannot see at all. A v33 daemon deletes the file and
/// leaves the rows, which is not a failure the human can spot from the
/// board -- so the gate that matters is the app's
/// FEATURE_MIN_VERSION.cardPurge, and its consumer is the delete
/// confirmation's COPY. A prompt that promises to take the rail steps
/// with the card, against a daemon that will not, is the one screen
/// where being wrong is unrecoverable.
///
/// v33 lets a tool carry its OWN icon. `ToolDef` gains `icon`, a name
/// from the app's icon library, and a tool that has one draws that glyph
/// wherever tools are listed -- the drawer, the library dialog, the Tools
/// tab and the rail's step chip -- in place of the one its KIND imposes.
/// Six `command` tools on one rail are six identical terminals today, and
/// at chip size the name is truncated to a few characters, so the glyph
/// is the only thing left that could tell them apart and it is the one
/// thing they all share.
///
/// A NAME, never an image, and kept raw at this layer for the reason
/// `agent` and `model` are: the library is a curated list of lucide names
/// in the app (`ui/iconLibrary.ts`), and the daemon has nothing to
/// validate one against. A rule it invented would refuse a name a newer
/// app knows -- and the app already falls back to the kind's glyph for a
/// name it cannot resolve, which is the honest reading of one it has
/// never heard of.
///
/// No new Request variant: `icon` widens SaveTool's `ToolDef` exactly as
/// `cwd` did at v30, and `min_version_for` gates by request TYPE. A v32
/// daemon takes the save, drops the icon and hands the tool back wearing
/// its kind's glyph -- the human's choice gone with no error -- so
/// `daemonCompat.ts` owes a `toolIcon: 33` entry, and the library
/// dialog's picker is the one surface that can produce the payload.
///
/// v32 lets ONE card say which agent and which model runs it, overriding
/// both the complexity table and the workspace's own `[agent]` block.
/// `PlanFileInfo` gains `agent` and `model`, and `SetPlanFrontmatterField`
/// takes the two new key names.
///
/// The pair is the card's own statement and is read whole rather than
/// merged half-by-half with the level's: a model name from one CLI in
/// another's argv is garbage, so "this card's agent" replaces "this
/// level's agent" outright. Either half alone is meaningful -- an
/// `agent:` with no `model:` runs that binary at its own default, a
/// `model:` with no `agent:` runs the workspace's binary at that model --
/// which is the same shape the complexity table's rows already have.
///
/// Kept RAW at this layer, unlike `complexity`. The five levels are an
/// enum the daemon owns, so it can refuse a misspelling; the profile
/// table lives in the Tauri host (`agent_setup.rs`) and the model names
/// belong to whichever CLI is installed, so the daemon has nothing to
/// validate either value against. A value it invented a rule for would
/// refuse writes the app knows are fine.
///
/// No new Request variant: `SetPlanFrontmatterField` merely gains two
/// allowed KEYS, and `PlanFileInfo` gains two `serde(default)` fields, so
/// `min_version_for` -- which gates by request type -- is structurally
/// blind to the whole change. The gate that matters is the app's
/// `FEATURE_MIN_VERSION.cardAgent`, and it has to cover BOTH directions:
/// a v31 daemon refuses the two writes loudly, but it also never PARSES
/// the two lines, so a card that already carries an override reads back
/// as carrying none and runs at the workspace's default with nothing on
/// screen to say so.
///
/// v31 taught a card how HARD it is, and taught the root config the flag
/// that puts a model on a hand-written agent command. Two halves of one
/// question -- which binary, at which model tier, executes this card:
///
/// - `PlanFileInfo.complexity` carries the card's `complexity:` line, one
///   of five ascending levels, and `SetPlanFrontmatterField` and
///   `CreatePlan` are how it is written. The app maps a level to an agent
///   profile and a model, so a trivial card need not spend the model a
///   gnarly one needs.
/// - `AgentConfig.model_flag` is the argv that carries that model for a
///   profile gavin has no verified flag for -- the `custom` profile is
///   the user's own binary, and until now its model control could not be
///   offered at all. `SetRootConfigField` accepts the seventh key name.
///
/// Not one new Request variant between them: all three widen EXISTING
/// requests, which `min_version_for` gates by TYPE and is therefore
/// structurally blind to. So the gates that matter are the app's
/// FEATURE_MIN_VERSION.complexity and .agentModelFlag. The two halves
/// fail differently and both need saying: a v30 daemon refuses the
/// `SetPlanFrontmatterField` and `SetRootConfigField` keys loudly, but
/// drops `CreatePlan`'s `complexity` silently -- the card would be filed
/// looking exactly as asked for and run at whatever the workspace's
/// default agent is.
///
/// v30 gave a TOOL a run of its own. Until now a library tool was
/// reachable only as a step on an orchestration rail, so "commit the
/// dirty tree" meant building a rail and binding it to a checkout; the
/// Tools hub tab runs one directly, and these three requests are how the
/// run is remembered. `ToolRun` mirrors `CardRun`, and `StartToolRun`,
/// `SetToolRunOutcome` and `ToolRuns` open it, close it and read the
/// last one back. Tracked in the daemon rather than in the app so a
/// failure nobody watched is still visible after a restart -- which is
/// the whole reason a run record exists at all.
///
/// Three new request TYPES, which `min_version_for` gates on its own.
/// The half it CANNOT see rides along in the same version: `SaveTool`'s
/// `ToolDef` gains `cwd`, a tool's own working directory, and that
/// widens an EXISTING request. A v29 daemon accepts the save, drops the
/// field and hands the tool back rooted wherever the caller happens to
/// be -- so `daemonCompat.ts` owes `toolRuns: 30` AND `toolCwd: 30`,
/// with the working-directory field disabled by the second one rather
/// than accepting a value the daemon will silently discard.
///
/// v29 added the follow-up queue: `Request::QueueInput`,
/// `ListQueuedInputs`, `SetQueuedInputs` and `SendQueuedInput`, answered
/// with `Response::QueuedInputs` and pushed as
/// `Response::QueuedInputsChanged`. A message the human writes for a busy
/// agent, held by the DAEMON until that session goes idle, rather than
/// bracket-pasted into the middle of its turn.
///
/// Four new request TYPES and no widened payload anywhere, which is the
/// whole reason the shape is four rather than one: `min_version_for`
/// gates by type, so against an older daemon not one byte of this
/// reaches the wire. `daemonCompat.ts` still owes a
/// `queuedFollowUps: 29` entry, because a gate that only stops the send
/// leaves the human looking at a compose box that accepts a message and
/// silently never delivers it -- the surfaces have to say why instead.
///
/// v28 added `Request::SetRailRunByRoot`: `SetRailRun` addressed by root
/// path, so gavin-mcp's `gavin_start_rail` can arm a rail the way the
/// human's Start button does. The plain request names no workspace, so
/// the daemon cannot push the row it just wrote -- an agent arming a
/// rail over the socket left the app showing it idle until some later
/// read. Resolving the root fixes both halves: the write is refused for
/// a workspace gavin does not have open, and the app watching it is told
/// at once.
///
/// A new request TYPE, so `min_version_for` is the whole gate and no
/// `FEATURE_MIN_VERSION` entry is owed: the app never sends it (it has a
/// workspace id already) and gavin-mcp fails closed on skew.
///
/// v27 gave a card a RUN HISTORY: a `CardRun` per session it was ever
/// bound to, and `Request::CardRuns` to read them back. The daemon
/// already knew every run -- it just kept exactly one, because
/// `card_sessions` is upserted by `(workspace_id, path)` and the next
/// launch overwrote the last. The rows are opened and closed by the
/// daemon itself, off the `LinkCardSession`/`UnlinkCardSession` it
/// already receives and the session exit it already reports, so nothing
/// new is asked of a caller.
///
/// A new request TYPE, so `min_version_for` is the real gate; the app
/// mirrors it as FEATURE_MIN_VERSION.runHistory only so the panel can
/// say WHY it is empty, which is a different sentence from "this card
/// has never been run".
///
/// v26 gave a card run a BASELINE: `CardSession.base_sha`, the commit its
/// checkout sat on the instant the agent was launched, carried on the
/// widened `Request::LinkCardSession`. It is what makes "what did this
/// run change" answerable at all -- the sha cannot be recovered
/// afterwards, because moving HEAD and dirtying the tree is the first
/// thing an agent does -- and it is what "discard this run" resets to.
///
/// A widening of an EXISTING request, so `min_version_for` gates it by
/// TYPE and is structurally blind to it: a v25 daemon parses the launch
/// perfectly well and drops the sha, which would leave a Changes button
/// diffing against nothing. The gate that matters is the app's
/// FEATURE_MIN_VERSION.runChanges, whose consumer is the LAUNCH --
/// `baseShaForLaunch` does not even ask git for a sha it knows cannot be
/// persisted.
///
/// v25 added `Request::SessionProcesses`: one sample of what each live
/// session is costing, as a cumulative CPU counter, a resident-memory
/// total and the instant they were read. A new request variant, so
/// `min_version_for` gates it by type and nothing is silently dropped;
/// `daemonCompat.ts` mirrors it anyway, because the task manager has to
/// explain two empty columns rather than render them blank. Deliberately
/// NOT a widening of `SessionSummary`, which the gate cannot see.
///
/// v24 taught recovery to PROBE instead of infer. The daemon records the
/// pid and start time of every process it spawns, and on recovery asks
/// the OS whether a previous lifetime's process is still alive -- because
/// killing a daemon reaches its children only as a SIGHUP, and one that
/// ignores SIGHUP survives, reparented to init. A survivor travels as
/// `SessionSummary.orphan` and the `SessionOrphaned` push, and
/// `Request::EndOrphan` is how the human ends it.
///
/// `EndOrphan` is a new Request variant, so `min_version_for` gates it by
/// type. The REPORTING half is invisible to that gate -- it widens what
/// is said about a session -- and it is worse than the usual silent-drop
/// case: `orphan: None` from a v23 daemon does not mean "no orphan", it
/// means the daemon never looked. Only the app's
/// FEATURE_MIN_VERSION.orphanDetection can tell those apart, which is why
/// the interrupted copy softens below v24 instead of asserting the
/// process is gone.
///
/// v23 added `Request::ClaimCardForSession`: an agent telling the daemon
/// it is working the card it just wrote, so a card the workspace agent
/// picked up on the Home tab stops looking startable on the board. A new
/// request variant, so `min_version_for` gates it by type and an older
/// daemon simply never receives it -- and no `daemonCompat.ts` entry is
/// owed, because gavin-mcp is the only sender and a claim that never
/// happens leaves exactly the unbound card every daemon before 23 produced.
/// v22 gave an interrupted run a way back on its own. v21 could tell a
/// broken agent from a finished one and hand the human a Resume button;
/// this version lets a rail the human walked away from take that press
/// itself, and the three fields it adds are what make that bounded and
/// consented rather than a loop. `Rail.auto_resume` is the per-rail
/// opt-in, defaulting OFF -- a rail resuming itself six hours later has
/// made a decision that was the human's unless they made it in advance.
/// `StepRun.resume_attempts` and `CardSession.resume_attempts` are the
/// BUDGET, and they are persisted rather than counted in memory because
/// an app reload and a daemon restart are precisely the conditions this
/// runs under: an in-memory counter is an unbounded loop wearing the
/// costume of a limit. All three widen EXISTING requests
/// (`SetOrchestration`, `SetStepRun`, `LinkCardSession`), which
/// `min_version_for` gates by TYPE and therefore cannot see, so the gate
/// that matters is the app's FEATURE_MIN_VERSION.autoResume.
///
/// v21 taught gavin what a FAILED agent is. An agent session's `idle` is
/// only two quiet seconds (`HEURISTIC_QUIET_PERIOD`), so an agent whose
/// API connection died and one that finished its turn were byte-identical
/// -- and the rail advanced on both. Three parts: `SessionStatus` gained
/// `failed`, carried as the same plain status string; the new
/// `SetFailurePatterns` request hands the daemon the agent profile's own
/// error text so the daemon can read the RENDERED screen rather than
/// guess from silence; and `SessionFailed` pushes the reason, which
/// `SessionSummary.failure_reason` re-baselines on Attach. The run
/// records (`StepRun`, `CardSession`) also gained `conversation_id` and
/// `launch_cwd`, so a failed agent can be resumed as the conversation it
/// was rather than reconstructed from a written account -- those two
/// widen EXISTING requests, which `min_version_for` gates by TYPE and
/// therefore cannot see, so the gate that matters is the app's
/// FEATURE_MIN_VERSION.conversationResume.
///
/// v20 gave recovery an epoch. The daemon stamps every registry row with
/// the lifetime that created it, so a row it INHERITED is provably one no
/// process is hosting any more -- and an inherited row that carried a
/// command comes back as a bare shell rather than a second run of the
/// whole prompt. The fact travels as `SessionSummary.interrupted` and the
/// `SessionInterrupted` push. Neither is a Request, so `min_version_for`
/// is untouched; `interrupted` is `serde(default)` so a v19 daemon's
/// `SessionList` still parses here, and false is the right reading of it
/// -- a v19 daemon genuinely does not know, and never marks one.
///
/// v19 taught cards an `attachments:` line: `PlanFileInfo` carries the
/// parsed list, `SetPlanFrontmatterField` accepts the key, and
/// `CreatePlan` carries the line to write. None of that is a new Request
/// variant -- both widen EXISTING requests, which `min_version_for`
/// gates by TYPE and therefore cannot see -- so the gate that matters is
/// the app's FEATURE_MIN_VERSION.attachments. A v18 daemon refuses the
/// `SetPlanFrontmatterField` key loudly but drops `CreatePlan`'s field
/// silently, which is the worse half: the card would be filed with the
/// human's attachments quietly missing.
///
/// v18 added `Request::Snapshot`: "send me this session's screen again",
/// answered from the daemon's per-session terminal parser. A new request
/// variant, so `min_version_for` gates it by type and an older daemon
/// simply never receives it.
///
/// v17 taught the root config a top-level `prd` key: `SetRootConfigField`
/// accepts a sixth key name and `GavinContext` carries `prd`. Neither is a
/// new Request variant -- the key widens an EXISTING request, which
/// `min_version_for` gates by TYPE and therefore cannot see -- so the gate
/// that matters is the app's FEATURE_MIN_VERSION.prdPath. A v16 daemon
/// refuses the key outright rather than dropping it, but it also keeps
/// reading the PRD from the hard-coded path, so the picker must stay dark
/// until the daemon is the one resolving it.
///
/// v15 widened `Stage` with `mode` and `name` (grouping spec G1). Both are
/// `serde(default)`, so no Request variant changed and `min_version_for`
/// is untouched -- the gate that matters is the app's
/// FEATURE_MIN_VERSION.groups, because a v14 daemon parses the request
/// fine and then drops both fields on the floor.
pub const PROTOCOL_VERSION: u32 = 42;

/// The oldest daemon this client can still talk to. Bumped ONLY when a
/// change breaks the wire for an older peer -- adding a Request variant
/// does not, because clients gate on `min_version_for`.
///
/// 5 is derived, not chosen: v4 -> v5 added `card_sessions` to
/// Response::Board with no serde default, so a v4 daemon's reply cannot
/// be parsed by a v5+ client. See the design doc's audit.
pub const MIN_COMPATIBLE_VERSION: u32 = 5;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum Request {
    CreateSession {
        workspace_path: String,
        cwd: String,
        command: Option<String>,
    },
    ListSessions,
    /// What every live session is costing right now: one sample of the
    /// process in each session's PTY, plus everything that process
    /// started.
    ///
    /// Separate from `ListSessions` rather than folded into it, for two
    /// reasons. It is answered by walking the process table, which is
    /// work `ListSessions` is asked to do on every workspace resolve and
    /// every baseline read; and it is a POLL -- the caller asks again
    /// while a task manager is open, and stops asking when it closes,
    /// which a request bundled into session listing could not express.
    SessionProcesses,
    /// Ends the surviving process recorded on this session, if it is
    /// still the process that was recorded.
    ///
    /// Named for the session rather than taking a pid, deliberately: a
    /// request that carried a pid would let any client turn the daemon
    /// into a way to signal arbitrary processes. The daemon looks up what
    /// IT recorded, re-probes the identity, and signals only that.
    EndOrphan { id: String },
    WriteInput {
        id: String,
        data: String,
    },
    /// Holds `text` for this session and delivers it the next time the
    /// session goes idle -- the non-interrupting counterpart to
    /// `WriteInput`, which types over whatever turn is in progress.
    ///
    /// The queue lives in the daemon rather than the app for the reason
    /// every PTY does: the human queues a follow-up precisely because
    /// the agent will be busy for a while, and an app they close in the
    /// meantime must not take the message with it.
    ///
    /// `text` is the message, plain. The escape sequences that make it
    /// arrive as one paste are added at DELIVERY, because this same
    /// string is what the tab shows the human back, and a list of
    /// bracketed-paste envelopes is not a list of messages.
    QueueInput {
        id: String,
        text: String,
    },
    /// Every session's pending queue, in delivery order.
    ///
    /// Global rather than per-session, and it exists at all, because
    /// `QueuedInputsChanged` is routed to a session's attached writer
    /// like `StatusChanged` is: a frontend that reloaded has already
    /// missed every push the daemon sent. A push-fed map with no
    /// read-back is the `gitStatusById` bug, and this is the read-back.
    ListQueuedInputs,
    /// The queue this session should have from now on, named by id and
    /// in order. Anything omitted is dropped.
    ///
    /// One writer for reorder, cancel and clear, rather than three
    /// requests: all three are the human saying what the queue should
    /// be, and expressing them as one whole-list write is what makes a
    /// drag that lands while a delivery fires resolve to a queue that
    /// existed rather than to a merge of two half-applied edits.
    SetQueuedInputs {
        id: String,
        queued_ids: Vec<String>,
    },
    /// Deliver one queued message NOW, whatever the session's status --
    /// the human's override for an agent they have decided not to wait
    /// for.
    ///
    /// Names the message rather than meaning "the head", so that sending
    /// the third item is one request instead of a reorder racing a send.
    /// Refused for an id this session's queue does not hold.
    SendQueuedInput {
        id: String,
        queued_id: String,
    },
    ResizeSession {
        id: String,
        cols: u16,
        rows: u16,
    },
    KillSession {
        id: String,
    },
    Attach {
        id: String,
    },
    /// "Send me this session's screen again." Rides the streaming
    /// connection and is answered with a `Response::Output` carrying a byte
    /// stream that reproduces the screen from scratch.
    ///
    /// Distinct from `Attach`, which also restores the screen, because
    /// `Attach` re-sends the `CwdChanged` / `StatusChanged` /
    /// `SessionRestored` baselines with it -- and a `waiting_for_input`
    /// baseline notifies unconditionally on the app side. A frontend that
    /// reloaded and wants its terminals repainted must not fire an OS
    /// notification for every session that happens to be waiting on the
    /// human.
    Snapshot {
        id: String,
    },
    /// This session's screen as PLAIN TEXT -- the visible grid, one line
    /// per row, no escape sequences. Answered with
    /// `Response::SessionScreen`.
    ///
    /// The read half of the same model `Snapshot` repaints from, and a
    /// separate request rather than a flag on it because the two answer
    /// different questions to different audiences: `Snapshot` writes
    /// bytes to whatever terminal is ATTACHED, so it cannot serve a
    /// caller that wants the text and has no terminal -- which is every
    /// caller this variant exists for.
    ///
    /// No scrollback, because `SessionScreen::contents` has none to
    /// give and that is deliberate: this is read to judge the turn that
    /// just ended, and the previous one must not condemn it.
    SessionScreen {
        id: String,
    },
    /// The text this session's agent prints when it has STOPPED because
    /// something broke, as opposed to because it finished. Matched
    /// against the daemon's rendered screen model, not the raw byte
    /// stream: an error banner is plain text painted by a TUI, so a raw
    /// substring match would straddle cursor moves and redraws.
    ///
    /// Per SESSION, and supplied by the caller, because the patterns
    /// belong to the agent PROFILE (`agent_setup.rs`'s `AGENT_PROFILES`)
    /// and the daemon hosts whatever it is told to. A daemon that is
    /// never sent any has no failure detection at all -- which is the
    /// honest reading of a profile whose error text nobody has verified,
    /// and never "nothing failed".
    SetFailurePatterns {
        id: String,
        patterns: Vec<String>,
    },
    GetBoard {
        workspace_id: String,
    },
    SetBoard {
        workspace_id: String,
        columns: Vec<Column>,
        labels: Vec<Label>,
    },
    DeleteBoard {
        workspace_id: String,
    },
    /// Sent on the STREAMING connection (intercepted in handle_connection
    /// like Attach, since the daemon captures that connection's writer for
    /// pushes). No reply -- the initial scan arrives as the first
    /// GavinTreeChanged push. Idempotent: re-watching replaces the watcher.
    WatchGavinRoot {
        workspace_id: String,
        root_path: String,
    },
    UnwatchGavinRoot {
        workspace_id: String,
    },
    GetGavinTree {
        workspace_id: String,
    },
    InitGavinRoot {
        root_path: String,
        workspace_name: String,
    },
    CreateGavinContext {
        parent_folder: String,
    },
    /// Scaffolds `.gavin` in a folder OUTSIDE the workspace root and
    /// registers it in `.gavin-root/config.toml`'s `extra_contexts` so
    /// scans include it. Folders under the root are refused -- they are
    /// scanned natively and must go through CreateGavinContext.
    AddExternalGavinContext {
        root_path: String,
        folder: String,
    },
    /// Unregisters an outside folder from `extra_contexts`. The folder's
    /// files are left untouched -- this only stops listing it.
    RemoveExternalGavinContext {
        root_path: String,
        folder: String,
    },
    /// Writes one frontmatter field of a plan file. The daemon enforces an
    /// allow-list (status, priority) -- this must never become an
    /// arbitrary-line writer.
    SetPlanFrontmatterField {
        path: String,
        key: String,
        value: String,
    },
    /// Writes one key of `.gavin-root/config.toml`. Allow-listed to
    /// profile/file/command/mcp_file/mcp_format inside the `[agent]`
    /// table, plus the top-level `prd` -- like SetPlanFrontmatterField
    /// this must never become an arbitrary-key writer into a file the
    /// user hand-edits. `prd` sits OUTSIDE `[agent]` on purpose: the lead
    /// document belongs to the workspace, not to whichever CLI is
    /// configured to work on it.
    SetRootConfigField {
        root_path: String,
        key: String,
        value: String,
    },
    /// Stateless scan -- no watch required (gavin-mcp's gavin_get_tree).
    ScanGavinRoot {
        root_path: String,
    },
    ReadPrd {
        root_path: String,
    },
    /// A file under a watched root, for a desktop driving this daemon from
    /// another machine (ssh workspaces, v39,
    /// `2026-09-22-ssh-card-runs-design.md`): the card a run is composed
    /// from, the MCP config and instructions file agent integration merges
    /// into. `path` is absolute or root-relative; anything that resolves
    /// outside the root and its `extra_contexts` is refused. Capped at
    /// `MAX_WORKSPACE_FILE_BYTES`, like the viewer.
    ReadWorkspaceFile {
        root_path: String,
        path: String,
    },
    /// The write half: the files agent integration produces, on the
    /// machine the agent runs on. Parents are created; the same
    /// confinement as the read.
    WriteWorkspaceFile {
        root_path: String,
        path: String,
        content: String,
    },
    /// Where a card's attachments resolve on this machine, and whether
    /// they exist -- the attachment classification the desktop's own
    /// `attachment_status` does for a local root, answered here for a
    /// remote one. Reports `outside` rather than refusing it: that is
    /// what the classification means.
    StatWorkspacePaths {
        root_path: String,
        paths: Vec<String>,
    },
    /// Runs a git subcommand in a cwd confined to a watched root, for the
    /// Git tab of a workspace on another machine (v40,
    /// `2026-09-22-ssh-git-files-design.md`). `args` is an argv the
    /// desktop built, handed to `git` and to nothing else -- never a
    /// shell -- so this is the app's existing local `run_git` reach, not
    /// a new one. `stdin` is a commit message or a patch (text). The
    /// desktop keeps the streaming network ops (fetch/pull/push) to
    /// itself; this is the synchronous run layer.
    RunGit {
        root_path: String,
        cwd: String,
        args: Vec<String>,
        stdin: Option<String>,
    },
    /// Lists a directory under a watched root, for the Files tree of a
    /// workspace on another machine (v40). `path` is absolute or
    /// root-relative; a symlink is refused rather than followed, as the
    /// desktop's own `list_directory` refuses one.
    ListWorkspaceDir {
        root_path: String,
        path: String,
    },
    /// Canonical plan authoring for agents. Validated daemon-side; never
    /// overwrites.
    CreatePlan {
        context_folder: String,
        file_name: String,
        title: String,
        status: Option<String>,
        priority: Option<String>,
        body: Option<String>,
        #[serde(default)]
        kind: Option<String>,
        #[serde(default)]
        parent: Option<String>,
        /// The `attachments:` line to write, comma-separated exactly as
        /// it lands in the frontmatter -- one string rather than a list
        /// so the daemon writes the line it was handed instead of
        /// re-deriving a format the flat `key: value` parser then has to
        /// agree with. None writes no line at all.
        #[serde(default)]
        attachments: Option<String>,
        /// The `complexity:` line to write -- one of the five level
        /// names -- or None for a card that gets no such line. Refused
        /// rather than defaulted when it names no level: a card filed
        /// with a misspelled complexity would run the workspace's
        /// default agent while looking as though it had been placed.
        #[serde(default)]
        complexity: Option<String>,
    },
    /// The SQLite board of the WATCHED workspace whose root matches.
    GetBoardByRoot {
        root_path: String,
    },
    /// An agent session declaring that it is working the card it just
    /// wrote -- the MCP's counterpart to the app's `LinkCardSession`,
    /// which the app can send because it knows the workspace id and an
    /// agent never does. Root -> watcher -> workspace, per
    /// GetBoardByRoot; `cwd` and `command` come off the session record,
    /// for the same reason.
    ///
    /// The daemon decides whether the claim stands, from the status the
    /// card now carries on disk: a binding means "a session is working
    /// this card", so only the In Progress column earns one. Sent after
    /// every `gavin_create_plan` and every `gavin_set_plan_field` status
    /// write, and a no-op for all the rest.
    ClaimCardForSession {
        root_path: String,
        path: String,
        session_id: String,
    },
    /// Creates a session and pushes AgentSessionSpawned on the watching
    /// app connection (D19: spawning requires the workspace to be open).
    SpawnAgentSession {
        root_path: String,
        cwd: String,
        command: String,
    },
    /// Deletes a context md file (guarded to `.gavin*/plans|docs|specs/`
    /// paths) and its card_sessions bindings in every workspace. A bound
    /// live agent session is NOT killed -- it stays visible on the
    /// Agents page.
    DeleteCardFile {
        path: String,
    },
    /// Moves a card file into its context's `plans/archive/`, taking its
    /// nested children with it. Deliberately separate from a status
    /// write: archiving is a filing decision the human makes, not
    /// something a status can trigger behind their back.
    ArchiveCard {
        path: String,
    },
    /// The inverse: takes a card back out of `plans/archive/` and files
    /// it where its status says it belongs (`plans/` or `plans/done/`).
    UnarchiveCard {
        path: String,
    },
    /// Rewrites exactly one checklist line's checkbox; expected_text
    /// must still match or the daemon refuses (concurrent agent edit).
    SetChecklistItem {
        path: String,
        line_index: u32,
        expected_text: String,
        checked: bool,
    },
    /// Promotes a plan's checklist item into a nested task card and
    /// rewrites the item line into a link to it.
    PromoteChecklistItem {
        plan_path: String,
        item: String,
    },
    /// Appends a `Decision:` or `Human test:` checklist line to a card --
    /// an agent saying, in the card itself, that it cannot go further
    /// without the human (v42). The card's checklist is where it lands
    /// because that is where the answer has to be readable from later:
    /// the next agent to pick the card up reads the answer beside the
    /// question, with no second store to consult.
    ///
    /// `options` is the shortlist a decision offers, written as the
    /// item's indented `Options:` line. Empty for a test, and empty for
    /// a decision that is genuinely open-ended.
    ///
    /// Re-filing an identical TEST whose last result was a failure
    /// re-arms it (an appended `Ready for re-test (date)`) rather than
    /// appending a second copy: an agent that fixed what the human found
    /// broken is asking for the same check again, not for a second one,
    /// and a card that accumulated a line per attempt would bury the
    /// history it is supposed to show.
    FileHumanItem {
        path: String,
        kind: HumanItemKind,
        text: String,
        #[serde(default)]
        options: Vec<String>,
    },
    /// Writes the human's answer under a `Decision:`/`Human test:` item
    /// and ticks it (v42). `expected_text` is the item line's raw
    /// remainder, guarded exactly as `SetChecklistItem` guards it: a
    /// mismatch means an agent rewrote the card under the tab, and the
    /// write is refused rather than aimed at whatever now sits there.
    ///
    /// There is no `line_index` beside it, unlike `SetChecklistItem`:
    /// the tab's rows come from a tree snapshot that a card edit can
    /// have moved since, so an index would be the stale half of the
    /// pair. Two items with identical text are refused as ambiguous
    /// instead -- `promote_checklist_item`'s posture, and the same
    /// reason.
    ResolveHumanItem {
        path: String,
        expected_text: String,
        outcome: HumanItemOutcome,
    },
    /// Upserts a card file's live session binding (by workspace + path).
    LinkCardSession {
        workspace_id: String,
        path: String,
        session_id: String,
        cwd: String,
        command: Option<String>,
        /// The agent CLI's OWN id for the conversation this run is, minted
        /// by gavin at launch (`--session-id <uuid>` and its per-profile
        /// equivalents). What makes a failed run resumable as the
        /// conversation it was rather than reconstructed from a written
        /// account. `serde(default)` so a caller that predates v21 -- or a
        /// profile with no verified argv -- still links a run.
        #[serde(default)]
        conversation_id: Option<String>,
        /// The directory the agent was LAUNCHED in, which is not `cwd`:
        /// `cwd` follows the session's OSC 7 reports and drifts the moment
        /// the agent `cd`s (a repo root, then a worktree). A resume has to
        /// run where the work is, so the launch directory is recorded
        /// separately and never rewritten.
        #[serde(default)]
        launch_cwd: Option<String>,
        /// See `CardSession::resume_attempts`. Unlike `SetStepRun`'s, this
        /// one OVERWRITES: a card binding is written whole by every call
        /// site (the row is one upsert of the run as it now stands), so
        /// None here means zero rather than "leave it alone".
        #[serde(default)]
        resume_attempts: Option<u32>,
        /// See `CardSession::base_sha` -- the commit this run started on
        /// (v26). `serde(default)` so a pre-v26 caller still links a run,
        /// and None from a caller that HAS one means the same thing it
        /// means on the record: this run has no baseline.
        #[serde(default)]
        base_sha: Option<String>,
    },
    UnlinkCardSession {
        workspace_id: String,
        path: String,
    },
    /// Every run this card has had, newest first (v27). Never an error
    /// for an unknown workspace or an unrun card -- an empty list, which
    /// is the honest answer for a card nobody has launched.
    CardRuns {
        workspace_id: String,
        path: String,
    },
    /// Opens a run for a tool launched STANDALONE from the Tools tab
    /// (v30). The rail's own steps do not come through here: a step
    /// already has a `StepRun`, and filing a second record for it would
    /// double-count the same work on two surfaces.
    ///
    /// The daemon closes the row itself when the session exits, which is
    /// what makes a `command` or `script` tool's verdict free -- the
    /// caller never has to be watching. An `agent` tool's session does
    /// not exit when its turn ends, so that one is closed by
    /// `SetToolRunOutcome` instead.
    StartToolRun {
        workspace_id: String,
        tool_id: String,
        session_id: String,
        command: Option<String>,
        /// Where the session was launched -- the tool's own `cwd`
        /// resolved against the workspace root. Recorded because a tool
        /// may deliberately run somewhere other than the root, and a run
        /// row that did not say where is not evidence of anything.
        launch_cwd: Option<String>,
        /// The agent CLI's own id for this run's conversation, for an
        /// `agent` tool. None for every other kind: a shell has no
        /// conversation.
        conversation_id: Option<String>,
    },
    /// Closes the open run of `session_id` with a verdict the DAEMON
    /// cannot reach on its own (v30). Only ever an `agent` tool: its
    /// session is still alive when its turn ends, so nothing the daemon
    /// watches would ever close the row.
    ///
    /// Keyed on the session rather than the run id, exactly as
    /// `finish_runs_for_session` is: the caller watching an agent go
    /// quiet knows which session that was and has no reason to have kept
    /// a row id. A row that is no longer `running` is left alone, so a
    /// later exit can never overwrite a verdict already recorded.
    SetToolRunOutcome {
        session_id: String,
        /// running | passed | failed | abandoned.
        outcome: String,
        exit_code: Option<i32>,
    },
    /// The LAST run of each of this workspace's tools (v30) -- not the
    /// whole history. The Tools tab shows one chip per row and nothing
    /// else, so answering with every run ever would hand the app a list
    /// it throws all but the head of away, and grow without bound.
    /// Never an error for an unknown workspace: an empty list.
    ToolRuns {
        workspace_id: String,
    },
    /// The workspace's orchestration plan plus its run state. Never an
    /// error for an unknown workspace -- an empty Orchestration.
    GetOrchestration {
        workspace_id: String,
    },
    /// Replaces the whole plan (spec O11). Run state survives for step
    /// and rail ids that are still present. Refused when it would delete
    /// a step whose StepRun is `running`.
    SetOrchestration {
        workspace_id: String,
        rails: Vec<Rail>,
        #[serde(default)]
        conflict_notes: Vec<ConflictNote>,
    },
    SetRailRun {
        rail_id: String,
        state: String,
        current_stage_id: Option<String>,
    },
    SetStepRun {
        step_id: String,
        state: String,
        session_id: Option<String>,
        reason: Option<String>,
        /// See `LinkCardSession::conversation_id`. On the RUN rather than
        /// the session deliberately: the session that failed is closed or
        /// replaced long before the human decides what to do about it, and
        /// the conversation has to outlive it.
        #[serde(default)]
        conversation_id: Option<String>,
        /// See `LinkCardSession::launch_cwd`.
        #[serde(default)]
        launch_cwd: Option<String>,
        /// See `StepRun::resume_attempts`. None LEAVES the stored count
        /// alone, the same way `conversation_id` does, so the dozen
        /// transitions that have nothing to say about the budget do not
        /// have to carry it. A launch writes 0 explicitly, because a new
        /// conversation is a new run and its budget is fresh.
        #[serde(default)]
        resume_attempts: Option<u32>,
    },
    /// Paths with uncommitted changes in `cwd`, capped at `limit` --
    /// evidence for the reorganize skill (spec §8.1), never used by the
    /// app's own conflict detection.
    /// The orchestration of the WATCHED workspace whose root matches --
    /// same resolution as GetBoardByRoot.
    GetOrchestrationByRoot {
        root_path: String,
    },
    SetOrchestrationByRoot {
        root_path: String,
        rails: Vec<Rail>,
        #[serde(default)]
        conflict_notes: Vec<ConflictNote>,
    },
    /// `SetRailRun` addressed by ROOT -- the only way to arm a rail from
    /// outside the app (v28), and it does one thing the plain request
    /// cannot: the root resolves to a workspace id, so the write is
    /// PUSHED to the app watching that workspace instead of sitting in
    /// SQLite until the next read. An unwatched root is refused, like
    /// every other ByRoot request.
    SetRailRunByRoot {
        root_path: String,
        rail_id: String,
        state: String,
        current_stage_id: Option<String>,
    },
    /// This workspace's tools PLUS every global one (tools spec §2).
    /// Never an error for an unknown workspace -- an empty list.
    GetTools {
        workspace_id: String,
    },
    /// Upsert by id. `workspace_id: None` stores the tool global to this
    /// machine; re-saving with the other value is how a tool changes scope.
    SaveTool {
        tool: ToolDef,
    },
    DeleteTool {
        id: String,
    },
    /// Root -> watcher -> workspace, per GetBoardByRoot. For the MCP
    /// server, which knows a root path and nothing else.
    GetToolsByRoot {
        root_path: String,
    },
    /// Upsert a tool INTO the workspace at `root_path` -- gavin-mcp's
    /// `gavin_save_tool`, and nothing else.
    ///
    /// Not `SaveTool` with a `workspace_id` filled in, and the
    /// difference is the whole reason this variant exists: there the
    /// SCOPE is the caller's to name, and an agent that could name it
    /// could store a tool global to every workspace on the machine, or
    /// re-scope an existing global one by re-saving it. Here the daemon
    /// resolves the root to one watched workspace and stamps THAT id
    /// over whatever the payload carried, so the only tool an agent can
    /// write is one of its own workspace's.
    ///
    /// `tool.workspace_id` is therefore ignored, and `tool.position` is
    /// the caller's (the app's rule: a new tool lands at the end).
    SaveToolByRoot {
        root_path: String,
        tool: ToolDef,
    },
    /// Delete one of the workspace-at-`root_path`'s OWN tools. A
    /// `builtin:` id, a GLOBAL tool and another workspace's tool are all
    /// refused by name rather than silently doing nothing: the agent
    /// that asked is entitled to know which of the three it hit.
    DeleteToolByRoot {
        root_path: String,
        id: String,
    },
    /// This workspace's group templates PLUS every global one, per
    /// GetTools. Never an error for an unknown workspace -- an empty list.
    GetGroupTemplates {
        workspace_id: String,
    },
    /// Upsert by id. `workspace_id: None` stores it global to this
    /// machine; re-saving with the other value is how a template changes
    /// scope.
    SaveGroupTemplate {
        template: GroupTemplate,
    },
    DeleteGroupTemplate {
        id: String,
    },
    GitDirtyPaths {
        cwd: String,
        limit: u32,
    },
    /// An agent naming its own tab (gavin-mcp's `gavin_name_session`).
    /// Routed by SESSION, not by root: an orchestration agent runs in a
    /// rail's worktree, which matches no watcher, and the app displaying
    /// a tab is by definition the connection attached to it. The daemon
    /// holds no session names of its own -- they live in the app's
    /// config -- so this only pushes `SessionNamed` on that connection.
    NameSession {
        session_id: String,
        name: String,
        /// The agent CLI's OWN native session/conversation id (v38),
        /// self-reported once the agent knows it -- codex, gemini and
        /// opencode each mint their own and cannot be handed one at
        /// launch the way Claude Code is (`session_id_args`). NEVER the
        /// same thing as `session_id` above, which is *gavin's* tab/PTY
        /// session from `GAVIN_SESSION_ID`; keep the two spelled
        /// differently everywhere (MCP param, this field, code comments)
        /// so they are never confused. `serde(default)`: only ever
        /// produced by `gavin-mcp`, see `PROTOCOL_VERSION`'s v38 note.
        #[serde(default)]
        agent_conversation_id: Option<String>,
    },
    /// The first request on a Unix-socket connection, establishing the
    /// client's identity for the connection's whole life
    /// (`sec-fix-client-identity.md`, remote-access design §4). Optional
    /// and, if sent, must be first; a second `Hello` on one connection is
    /// refused. Sending anything else first leaves the connection `local`,
    /// which is what keeps every pre-v35 client working unchanged.
    ///
    /// `auth` decides the role: the daemon token yields `app`, a session
    /// token yields `agent` scoped to that session, nothing yields
    /// `local`. `nonce` is the client's random challenge; the daemon
    /// answers `HelloAck.server_proof` = HMAC(daemon_token, nonce), which
    /// lets the app tell the real daemon from a socket squatter (DP-06)
    /// without the token ever crossing back in the clear. `client` is
    /// advisory -- it names the binary for the Sessions manager; the role
    /// never comes from it.
    Hello {
        client: String,
        protocol_version: u32,
        auth: HelloAuth,
        nonce: String,
    },
    GetProtocolVersion,
    /// Asks the daemon to exit cleanly. Added in v12 so the app can stop
    /// a daemon it owns without `pkill`, which cannot distinguish this
    /// install's daemon from another's.
    Shutdown,
    /// Catch-all for a request from a NEWER client. Deserialize-only:
    /// never constructed or sent by us. Exists so an unrecognised
    /// `type` tag is a value rather than a parse error -- read_message
    /// propagates parse errors with `?`, which drops the whole
    /// connection and every push riding on it.
    #[serde(other)]
    Unknown,
}

/// What a `Hello` presents to claim a role. Tagged by `kind` so it reads
/// on the wire as `{"kind":"session-token","token":"…"}`, exactly the
/// shape the remote-access design §7 sketches.
///
/// `None` is a first-class variant, not an absent field: a connection may
/// legitimately introduce itself as nobody in particular (a hand-started
/// Claude Code in a terminal) and still get the `local` role, and making
/// that explicit keeps the daemon's `authorize` from having to treat "no
/// auth" and "unparseable auth" alike.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum HelloAuth {
    /// No credential; the connection becomes `local`.
    None,
    /// The daemon token from `daemon.token`; the connection becomes `app`.
    DaemonToken { token: String },
    /// A session token minted at `CreateSession`; the connection becomes
    /// `agent`, scoped to the session the token was minted for.
    SessionToken { token: String },
}

/// The protocol version that introduced `req`'s variant.
///
/// Deliberately an exhaustive match with no `_` arm: adding a Request
/// variant must not compile until its version is recorded here, because
/// a missing entry would let the app send it to a daemon too old to
/// parse it -- which closes the connection outright.
pub fn min_version_for(req: &Request) -> u32 {
    match req {
        Request::Attach { .. }
        | Request::CreateGavinContext { .. }
        | Request::CreatePlan { .. }
        | Request::CreateSession { .. }
        | Request::DeleteBoard { .. }
        | Request::GetBoard { .. }
        | Request::GetBoardByRoot { .. }
        | Request::GetGavinTree { .. }
        | Request::GetProtocolVersion
        | Request::InitGavinRoot { .. }
        | Request::KillSession { .. }
        | Request::ListSessions
        | Request::ReadPrd { .. }
        | Request::ResizeSession { .. }
        | Request::ScanGavinRoot { .. }
        | Request::SetBoard { .. }
        | Request::SetPlanFrontmatterField { .. }
        | Request::SpawnAgentSession { .. }
        | Request::UnwatchGavinRoot { .. }
        | Request::WatchGavinRoot { .. }
        | Request::WriteInput { .. } => 1,

        Request::PromoteChecklistItem { .. } | Request::SetChecklistItem { .. } => 4,

        Request::LinkCardSession { .. } | Request::UnlinkCardSession { .. } => 5,

        // A card's run history. A new request TYPE, so this match is the
        // real gate: against an older daemon it never reaches the wire,
        // and there would be nothing to read anyway -- no daemon before
        // 27 kept a run once the next one replaced it. The app mirrors it
        // as `runHistory` for one reason only, and it is not a silent
        // drop: an empty panel has to say "this daemon does not keep run
        // history" rather than "this card has never been run".
        Request::CardRuns { .. } => 27,

        // Arming a rail from gavin-mcp (`gavin_start_rail`). A new request
        // TYPE, so this match is the whole gate and no daemonCompat.ts
        // mirror is owed: the app never sends it -- it writes run state
        // for a workspace whose id it already has -- and against an older
        // daemon it never reaches the wire, which leaves the agent with a
        // refusal naming the version rather than a rail armed with no
        // push behind it.
        Request::SetRailRunByRoot { .. } => 28,

        // Standalone tool runs (v30). Three new request TYPES, so this
        // match really does stop all three against an older daemon --
        // nothing is silently stored where it will never be read back.
        //
        // It is NOT the whole gate for v30 though, and that is the part
        // worth writing down: the same version widens `SaveTool`'s
        // ToolDef with `cwd`, which this match sorts by TYPE and cannot
        // see. A v29 daemon takes that save, drops the directory and
        // stores a tool that will run wherever the launcher stood. The
        // app's FEATURE_MIN_VERSION carries both halves -- `toolRuns`
        // so the tab can say why Run is dark, and `toolCwd` so the
        // dialog's field is disabled rather than accepting a value the
        // daemon throws away. v33 widened the same payload again with
        // `icon`, which this match is blind to for the same reason and
        // which `toolIcon` gates for the same reason.
        Request::SetToolRunOutcome { .. }
        | Request::StartToolRun { .. }
        | Request::ToolRuns { .. } => 30,

        Request::DeleteCardFile { .. } => 6,

        Request::SetRootConfigField { .. } => 7,

        Request::AddExternalGavinContext { .. } | Request::RemoveExternalGavinContext { .. } => 8,

        // 374eb7d bumped v9 and v10 together; attributed to 10, the
        // conservative direction (never sent to a v9 daemon).
        Request::GetOrchestration { .. }
        | Request::GetOrchestrationByRoot { .. }
        | Request::GitDirtyPaths { .. }
        | Request::NameSession { .. }
        | Request::SetOrchestration { .. }
        | Request::SetOrchestrationByRoot { .. }
        | Request::SetRailRun { .. }
        | Request::SetStepRun { .. } => 10,

        // The tool library, from the orchestration merge. This arm was
        // added when that work landed: v11 had been reserved for it while
        // it was still an uncommitted merge, and this match refused to
        // compile until the four variants were recorded here -- which is
        // exactly what the reservation was for.
        //
        // The frontend keeps a mirror of this table in
        // app/src/lib/daemonCompat.ts (FEATURE_MIN_VERSION, `tools: 11`).
        // Nothing forces that one to stay in sync the way this match is
        // forced to, so a new gated feature owes an entry there by hand.
        Request::DeleteTool { .. }
        | Request::GetTools { .. }
        | Request::GetToolsByRoot { .. }
        | Request::SaveTool { .. } => 11,

        // An agent authoring its own workspace's tools (gavin-mcp's
        // `gavin_save_tool` / `gavin_delete_tool`). Two new request
        // TYPES, so this match is the whole gate and no daemonCompat.ts
        // mirror is owed -- the app never sends either, it writes tools
        // for a workspace whose id it already has, exactly as it does
        // for `SetRailRunByRoot` at 28.
        //
        // Nothing here is the guard, and that is worth saying in the
        // one place a reader might look for it: the scope rule
        // ("workspace tools only, never gavin's own") is enforced in
        // `save_tool_by_root`/`delete_tool_by_root`, which stamp the
        // watched workspace's id over the payload and refuse a
        // `builtin:` id, a global row and another workspace's row. A
        // version gate only decides whether the request reaches the
        // wire at all.
        Request::DeleteToolByRoot { .. } | Request::SaveToolByRoot { .. } => 37,

        // Workspace files for a desktop on another machine (v40, the ssh
        // card-runs design). New TYPES, so this is the real wire gate: a
        // v39 host daemon answers `Unsupported`, the app refuses locally
        // through `gate_request`, and FEATURE_MIN_VERSION.sshCardRuns is
        // how the Run pill on an ssh workspace's board says which
        // version the HOST needs.
        Request::ReadWorkspaceFile { .. }
        | Request::WriteWorkspaceFile { .. }
        | Request::StatWorkspacePaths { .. } => 40,

        // The Git tab and Files tree over ssh (v41, the ssh git/files
        // design). New TYPES, so this is the real wire gate; the app
        // mirrors them as FEATURE_MIN_VERSION.sshGitFiles, checked
        // against the HOST daemon's version.
        Request::RunGit { .. } | Request::ListWorkspaceDir { .. } => 41,

        // The Decisions tab's two writes (v42). New TYPES, so this match
        // is the real wire gate for them -- but it is only half of v42,
        // and the other half is the one that bites: the same version
        // widens `PlanFileInfo` with `human_items`, which this match
        // sorts by TYPE and cannot see. An older daemon serves a tree
        // with no items at all, which is "unknown" and not "none" --
        // hence the `Option` on the field, and hence the
        // FEATURE_MIN_VERSION entry the TAB owes, beside the
        // `featureBlockedReason` that reads it. There is none here on
        // purpose: an entry with no consumer is a dead gate.
        Request::FileHumanItem { .. } | Request::ResolveHumanItem { .. } => 42,

        Request::Shutdown => 12,

        // Client identity on the local socket (phase 1 of the
        // remote-access design). A new request TYPE, so this match is the
        // real wire gate: a daemon older than 35 answers `Unsupported`
        // from the `#[serde(other)]` arm and every client reads that as
        // "this daemon has no identity yet" -- the app continues as
        // `local`, gavin-mcp continues untokened, and nothing is silently
        // dropped because `Hello` carries no field an older daemon would
        // parse-and-discard. The app still mirrors it as
        // FEATURE_MIN_VERSION.clientIdentity so the Settings surface can
        // say WHY it is greyed, per CLAUDE.md.
        Request::Hello { .. } => 35,

        // The archive (`plans/archive/`). v13 also widened PlanFileInfo
        // with `modified_at`, which the archive grid orders by -- that
        // one is `serde(default)`, so it costs an older DAEMON nothing;
        // these two variants are what a v12 daemon genuinely cannot
        // serve, and daemonCompat.ts gates the UI on `archive: 13`.
        Request::ArchiveCard { .. } | Request::UnarchiveCard { .. } => 13,

        // Group templates. v15 also widened Stage with `mode` and
        // `name`, which are serde-defaulted and therefore invisible to
        // this match -- daemonCompat.ts gates the UI on `groups: 15` for
        // exactly that reason. These three are what a v14 daemon
        // genuinely cannot serve.
        Request::DeleteGroupTemplate { .. }
        | Request::GetGroupTemplates { .. }
        | Request::SaveGroupTemplate { .. } => 15,

        // Repainting a reconnected terminal from the daemon's screen model.
        // A new request TYPE, which is the case this match actually gates,
        // so it needs no daemonCompat.ts mirror: a daemon older than 18 has
        // no screen model to ask, the request never reaches the wire, and
        // the frontend just leaves the terminal as it found it -- which is
        // what it did before any of this existed.
        Request::Snapshot { .. } => 18,

        // The rendered screen as text (v39), for the TypeSafe turn
        // verdict. A new request TYPE, so this match is the real wire
        // gate: a daemon older than 39 has no such request and the app
        // never sends it.
        //
        // It is NOT the whole gate, and the other half is the one that
        // matters. Refusing to send leaves the CALLER holding a version
        // error where it expected a screen, and a verdict judged on the
        // empty string is a worse answer than no verdict at all. So
        // daemonCompat.ts carries `turnVerdict: 39` and its consumer
        // skips the request entirely, keeping today's answer -- which is
        // exactly what the whole feature promises to fall back to.
        Request::SessionScreen { .. } => 39,

        // One sample of what every session costs. A new request TYPE, so
        // this match is the whole gate -- there is no widened payload
        // riding along, which is exactly why the command line and the
        // figures travel in `SessionProcess` rather than being added to
        // `SessionSummary`. daemonCompat.ts still carries a mirror, not
        // to catch a silent drop but because the task manager has to say
        // WHY its two columns are empty rather than showing them blank.
        Request::SessionProcesses => 25,

        // The follow-up queue. Four new request TYPES and nothing
        // widened, so this match really is the whole WIRE gate: against
        // a v25 daemon none of them is ever sent, no message is silently
        // stored somewhere it will never be delivered from, and the app
        // behaves exactly as it did before the feature existed.
        //
        // daemonCompat.ts still carries `queuedFollowUps: 29`, for the
        // reason `SessionProcesses` carries a mirror: refusing to send
        // is not the same as telling the human why. A compose box that
        // takes a follow-up and drops it is worse than one that is
        // greyed out with the daemon version in the tooltip.
        Request::ListQueuedInputs
        | Request::QueueInput { .. }
        | Request::SendQueuedInput { .. }
        | Request::SetQueuedInputs { .. } => 29,

        // Ending a surviving orphan. A new request TYPE, so this match
        // does gate it -- but it is only half the feature: the REPORTING
        // side widens SessionSummary and adds a push, neither of which
        // this match can see. daemonCompat.ts owes the other half an
        // `orphanDetection: 24` entry, and for a sharper reason than
        // usual: absence of an orphan from an older daemon is unknown,
        // not negative.
        Request::EndOrphan { .. } => 24,

        // An agent claiming the card it just put In Progress. A new
        // request TYPE, so this match is the whole gate and no
        // daemonCompat.ts mirror is owed: the app never sends it (only
        // gavin-mcp does), and against an older daemon it simply never
        // reaches the wire -- leaving the card unbound, which is exactly
        // what every daemon before 23 did anyway.
        Request::ClaimCardForSession { .. } => 23,
        // Failure detection (v21). A new request TYPE, so this match is
        // the whole gate: a daemon older than 21 never receives the
        // patterns, matches nothing, and calls a quiet agent idle exactly
        // as it did before. The app's FEATURE_MIN_VERSION.conversationResume
        // covers the OTHER half of v21 -- the widened SetStepRun /
        // LinkCardSession payloads, which this match structurally cannot
        // see.
        Request::SetFailurePatterns { .. } => 21,

        // Never sent -- it only exists to absorb a newer peer's request.
        // u32::MAX keeps it un-sendable if it ever reaches a send path.
        Request::Unknown => u32::MAX,
    }
}

/// Where a daemon's advertised version falls relative to a client's own
/// `PROTOCOL_VERSION` and `MIN_COMPATIBLE_VERSION`.
///
/// The band arithmetic lives here, in the crate both clients already
/// depend on, rather than in either of them: the app (`classify` in
/// `app/src-tauri/src/session.rs`) and `gavin-mcp`
/// (`SocketTransport::connect`) have to sort the SAME daemon into the
/// same band or the two answer differently about one process -- which is
/// exactly the split this was hoisted to close. Wording stays with each
/// client, because the recovery differs: the app tells the user to update
/// the app, `gavin-mcp` cannot.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VersionBand {
    /// The daemon speaks a protocol newer than this client knows. A hard
    /// error for both clients: an unreleased protocol cannot be guessed at.
    DaemonNewer,
    /// The daemon predates the oldest request shape this client still
    /// knows how to send (`floor`, i.e. `MIN_COMPATIBLE_VERSION`).
    DaemonTooOld,
    /// Inside the window. `degraded` is true when the daemon is behind the
    /// client but still usable with the newer requests gated off.
    Usable { degraded: bool },
}

/// Sorts `daemon` into its band relative to `client` and `floor`. Pure, so
/// the bands are testable without a daemon.
pub fn version_band(daemon: u32, client: u32, floor: u32) -> VersionBand {
    if daemon > client {
        return VersionBand::DaemonNewer;
    }
    if daemon < floor {
        return VersionBand::DaemonTooOld;
    }
    VersionBand::Usable { degraded: daemon < client }
}

/// A request the running daemon predates. Returned instead of a formatted
/// string so each client can say what IT wants done about it while both
/// report the same two numbers -- and so `gavin-mcp` can carry it as a
/// typed error and name the tool the agent actually called (see
/// `name_the_tool` in `crates/gavin-mcp/src/main.rs`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GatedRequest {
    /// The protocol version that introduced the request's variant.
    pub needed: u32,
    /// What the daemon on the current connection actually advertised.
    pub daemon: u32,
}

impl std::fmt::Display for GatedRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "needs gavin daemon protocol v{}, but the running daemon is v{}",
            self.needed, self.daemon
        )
    }
}

impl std::error::Error for GatedRequest {}

/// The gate every client puts in front of its own send path: a request the
/// daemon predates must produce ZERO bytes on the wire. Not error handling
/// after the fact -- an older daemon cannot PARSE a request it predates,
/// and `read_message` propagates that parse error with `?`, dropping the
/// connection and everything riding on it.
pub fn gate_request(req: &Request, daemon_version: u32) -> Result<(), GatedRequest> {
    let needed = min_version_for(req);
    if needed > daemon_version {
        return Err(GatedRequest { needed, daemon: daemon_version });
    }
    Ok(())
}

/// The identity primitives phase 1 needs, kept in `protocol` because all
/// three processes touch them: the daemon mints and checks, the app reads
/// the token file and verifies the proof, gavin-mcp reads its session
/// token from the environment. One home means the HMAC construction and
/// the hashing can never drift between minting and checking.
///
/// A 32-byte value, hex-encoded, read from the OS CSPRNG. A failure to
/// read it is fatal to the caller, because a predictable token is worse
/// than none -- which is why neither arm below carries a fallback.
///
/// Unix reads `/dev/urandom` directly rather than through a crate, which
/// is what keeps this dependency-light. Windows has no such file, and
/// opening it is where a daemon on that OS died: `mint_daemon_token` is
/// the first thing `run_server` does, so the whole daemon failed to
/// start with `os error 3` before it ever reached the pipe.
#[cfg(not(windows))]
pub fn random_hex(n_bytes: usize) -> std::io::Result<String> {
    let mut buf = vec![0u8; n_bytes];
    let mut f = std::fs::File::open("/dev/urandom")?;
    f.read_exact(&mut buf)?;
    Ok(hex_encode(&buf))
}

/// `ProcessPrng` rather than `BCryptGenRandom`: it is the documented
/// user-mode entry point to the same system CSPRNG, and it needs neither
/// an algorithm handle nor the open/close dance around one. It is
/// documented to always return TRUE; the check is here regardless,
/// because the failure it would hide is a token of zeroes.
#[cfg(windows)]
pub fn random_hex(n_bytes: usize) -> std::io::Result<String> {
    use windows::Win32::Security::Cryptography::ProcessPrng;
    let mut buf = vec![0u8; n_bytes];
    // SAFETY: ProcessPrng only writes into the slice it is handed, and
    // the slice outlives the call.
    if !unsafe { ProcessPrng(&mut buf) }.as_bool() {
        return Err(std::io::Error::last_os_error());
    }
    Ok(hex_encode(&buf))
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

/// SHA-256 of a token, hex-encoded. The registry stores this, never the
/// session token itself, so a copy of `registry.sqlite` yields no token
/// that could be presented in a `Hello`.
pub fn hash_token_hex(token: &str) -> String {
    let mut h = Sha256::new();
    h.update(token.as_bytes());
    hex_encode(&h.finalize())
}

/// HMAC-SHA256(key, msg), hex-encoded. Written out by hand (the two-pass
/// ipad/opad construction) rather than pulling the `hmac` crate: SHA-256
/// is already here for `hash_token_hex`, and one fewer dependency on the
/// wire-identity path is worth the six lines.
fn hmac_sha256_hex(key: &[u8], msg: &[u8]) -> String {
    const BLOCK: usize = 64;
    let mut k = [0u8; BLOCK];
    if key.len() > BLOCK {
        let mut h = Sha256::new();
        h.update(key);
        let d = h.finalize();
        k[..d.len()].copy_from_slice(&d);
    } else {
        k[..key.len()].copy_from_slice(key);
    }
    let mut ipad = [0x36u8; BLOCK];
    let mut opad = [0x5cu8; BLOCK];
    for i in 0..BLOCK {
        ipad[i] ^= k[i];
        opad[i] ^= k[i];
    }
    let mut inner = Sha256::new();
    inner.update(ipad);
    inner.update(msg);
    let inner = inner.finalize();
    let mut outer = Sha256::new();
    outer.update(opad);
    outer.update(inner);
    hex_encode(&outer.finalize())
}

/// The daemon's answer to a `Hello` nonce: HMAC(daemon token, nonce). The
/// app computes the same from the token file and compares, which proves
/// the peer holds the token without the token itself crossing back (DP-06).
pub fn server_proof(daemon_token: &str, nonce: &str) -> String {
    hmac_sha256_hex(daemon_token.as_bytes(), nonce.as_bytes())
}

/// Where the daemon writes its per-start token, `0600`, beside the socket.
pub fn daemon_token_path() -> anyhow::Result<PathBuf> {
    Ok(app_support_dir()?.join(profile_file_name("daemon", "token", BuildProfile::current())))
}

/// The marker the daemon reads to decide whether an untokened local
/// connection keeps full reach. Absent (the default) means it does, so
/// nothing breaks the day phase 1 lands; present means an untokened local
/// connection is refused the privileged, process-starting requests
/// (remote-access design §11 Q1). A file rather than a protocol field so
/// the daemon can honour a live toggle with no restart and no new request.
pub fn require_local_token_path() -> anyhow::Result<PathBuf> {
    Ok(app_support_dir()?.join("require_local_token"))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum Response {
    SessionCreated { id: String },
    SessionList { sessions: Vec<SessionSummary> },
    Output { id: String, data: String },
    SessionExited { id: String, exit_code: i32 },
    CwdChanged { id: String, cwd: String },
    StatusChanged { id: String, status: String },
    GitStatusChanged { id: String, status: Option<GitStatus> },
    SessionRestored { id: String },
    /// The answer to `Request::SessionScreen`: the session's visible grid
    /// rendered as plain text.
    ///
    /// Carries the `id` back rather than relying on the caller to
    /// remember what it asked about -- every other id-addressed response
    /// here does, and a screen attributed to the wrong session is a
    /// verdict passed on the wrong agent.
    ///
    /// An empty string is a real answer: a session that has never had a
    /// pump has produced nothing to render. The daemon answers `Error`
    /// for a session it does not know, so absence and emptiness stay
    /// distinguishable.
    SessionScreen { id: String, contents: String },
    /// The stronger half of `SessionRestored`: this session came back
    /// from a previous daemon lifetime AND the command it was launched
    /// with was not re-run, so the tab holds a bare shell rather than the
    /// agent that was working. Sent alongside `SessionRestored` on
    /// Attach, never instead of it -- a plain terminal session is only
    /// ever restored, and every surface that already reads `restored`
    /// keeps working untouched.
    SessionInterrupted { id: String },
    /// The stronger half of `SessionInterrupted`, and the one that costs
    /// the human work: this session's agent was NOT stopped by the daemon
    /// dying. It is still running, reparented to init, editing the same
    /// checkout with nothing in front of it. Sent on Attach after
    /// `SessionInterrupted`, never instead of it -- the run really was
    /// interrupted as far as gavin is concerned, and this only adds what
    /// the probe found.
    ///
    /// Re-sent on every Attach, like `SessionInterrupted` and unlike
    /// `SessionRestored`: the process does not stop surviving because the
    /// frontend reloaded.
    SessionOrphaned { id: String, orphan: OrphanProcess },
    /// The outcome of `EndOrphan`. `ended` is false when the process was
    /// signalled and had not exited by the time the daemon gave up
    /// waiting -- a process that ignores SIGTERM is exactly the kind that
    /// ignored SIGHUP to get here -- and the orphan stays recorded so the
    /// app keeps showing it. False is also what an already-gone or
    /// never-recorded orphan gets, which is why `still_running` rides
    /// along: it separates "it refused" from "there was nothing to end".
    OrphanEnded { id: String, ended: bool, still_running: bool },
    /// One `SessionProcesses` sample. A session whose pid the daemon
    /// never recorded, or whose process is gone, is present with
    /// `process_count: 0` rather than absent: "measured, nothing there"
    /// and "not in the list" are different answers, and only the first
    /// lets a task manager say a row is idle instead of dropping it.
    SessionProcessList { processes: Vec<SessionProcess> },
    /// This session's agent stopped because something BROKE, not because
    /// its turn ended -- the daemon either matched the profile's own
    /// error text on the rendered screen, or watched the machine sleep
    /// through the conversation this session was mid-way through.
    ///
    /// Sent alongside `StatusChanged { status: "failed" }`, never instead
    /// of it, for the same reason `SessionInterrupted` rides beside
    /// `SessionRestored`: every surface that already reads a status keeps
    /// working, and only the ones that want the REASON have to learn a
    /// new message. The reason is the part downstream work needs -- an
    /// auto-resume that cannot tell a dead network from an expired token
    /// would retry into both.
    SessionFailed { id: String, reason: String },
    /// Pending follow-ups, in delivery order. The answer to
    /// `ListQueuedInputs` (every session's) and to each of the three
    /// writers (that session's, as it stands after the write).
    ///
    /// One variant for both because every entry names its own session:
    /// a client that asked about one session can read the reply the same
    /// way it reads the global one, and a writer that answers with the
    /// resulting queue means no caller has to wait for the push to learn
    /// what its own request did.
    QueuedInputs { queued: Vec<QueuedInput> },
    /// Push: this session's queue changed -- the human added, reordered
    /// or cancelled something, or the daemon delivered the head because
    /// the session went idle. Carries the whole queue rather than a
    /// delta, so a client that missed one can never drift.
    ///
    /// Routed to the session's attached writer, exactly like
    /// `StatusChanged`, and re-sent on `Attach` for the same reason
    /// `CwdChanged` is: a frontend reload has to get its baseline back.
    QueuedInputsChanged { id: String, queued: Vec<QueuedInput> },
    Board { columns: Vec<Column>, labels: Vec<Label>, card_sessions: Vec<CardSession> },
    CardRuns { runs: Vec<CardRun> },
    ToolRuns { runs: Vec<ToolRun> },
    DirtyPaths { paths: Vec<String>, truncated: bool },
    Orchestration {
        rails: Vec<Rail>,
        conflict_notes: Vec<ConflictNote>,
        rail_runs: Vec<RailRun>,
        step_runs: Vec<StepRun>,
    },
    Tools { tools: Vec<ToolDef> },
    /// Push: this workspace's tool library changed under the app's feet
    /// -- an agent authored, edited or deleted a tool over gavin-mcp.
    /// Carries the whole library (this workspace's rows plus every
    /// global one, exactly what `GetTools` answers), never a delta, so a
    /// client that missed one cannot drift.
    ///
    /// It exists for the reason `OrchestrationChanged` does: until v37
    /// every tool write originated in the app that already held the
    /// state, so a push would have told it what it just did. An agent
    /// writing one changes that, and without this the Tools tab keeps
    /// drawing a library missing the tool the agent made -- `fetchTools`
    /// is a load-once, so nothing would refetch until the whole
    /// workspace reloaded.
    ToolsChanged { workspace_id: String, tools: Vec<ToolDef> },
    GroupTemplates { templates: Vec<GroupTemplate> },
    GavinTreeSnapshot { workspace_id: String, tree: GavinTree },
    GavinTreeChanged { workspace_id: String, tree: GavinTree },
    /// Pushed on the watching connection after any SetOrchestration, so
    /// an agent's rewrite lands in the open tab without a poll. Run-state
    /// writes deliberately do NOT push: they always originate in the app
    /// that already holds the state.
    OrchestrationChanged { workspace_id: String, orchestration: Orchestration },
    GavinTreeScanned { tree: GavinTree },
    PrdContent { content: String },
    /// `ReadWorkspaceFile`'s answer: `content` is None when there is no
    /// such file, `truncated` when it was cut at the cap.
    WorkspaceFile { content: Option<String>, truncated: bool },
    /// `StatWorkspacePaths`'s answer, one per path asked, in order.
    WorkspacePathStats { stats: Vec<WorkspacePathStat> },
    /// `RunGit`'s answer: the git process's stdout bytes, its stderr, and
    /// its exit code -- the same three the desktop's local `run_git`
    /// produces, so the Git tab's parsing does not care which ran it.
    GitRun { stdout: Vec<u8>, stderr: String, code: i32 },
    /// `ListWorkspaceDir`'s answer, name-sorted like the local listing.
    WorkspaceDir { entries: Vec<WorkspaceDirEntry> },
    PlanCreated { path: String },
    AgentSessionSpawned { workspace_id: String, session_id: String, cwd: String, command: String },
    /// Push: an agent renamed its own tab. The app applies it through the
    /// very same path a human rename takes.
    SessionNamed { session_id: String, name: String },
    ProtocolVersion { version: u32 },
    TaskPromoted { path: String },
    /// A `FileHumanItem` that landed. `rearmed` says which of the two
    /// things happened: a new marker line appended, or an existing
    /// failed test armed again with a `Ready for re-test (date)`.
    ///
    /// Worth a reply of its own rather than a bare `Ok` because the
    /// filer acts on it -- an agent told "re-armed" knows the human
    /// already failed this check once and that the card carries their
    /// note about why.
    HumanItemFiled { rearmed: bool },
    /// A frontmatter write, answered with the card's path AFTERWARDS: a
    /// status write can archive the file into `plans/done/` (or bring it
    /// back), and callers hold that path as the card's identity.
    PlanFieldSet { path: String },
    /// An archive or un-archive, answered with the card's path
    /// AFTERWARDS -- same contract as PlanFieldSet, for the same reason:
    /// the path is the card's identity everywhere that holds one.
    CardMoved { path: String },
    Ok,
    Error { message: String },
    /// Sent instead of dropping the connection when a request's `type`
    /// is unrecognised. `min_version` is advisory: this daemon cannot
    /// know which version introduced a variant it has never heard of,
    /// so it reports its own version as the ceiling it can serve.
    Unsupported { request_type: String, min_version: u32 },
    /// The reply to a `Hello` the daemon accepted. `role` is what the
    /// daemon decided this connection is (`app`, `local`, `agent`),
    /// which the client cannot override. `session_id` is set for an
    /// `agent` -- the session its token was minted for -- so gavin-mcp
    /// can confirm the daemon bound it to the tab it is running in.
    /// `server_proof` is HMAC(daemon_token, the client's Hello nonce),
    /// present only when the connection proved knowledge of the daemon
    /// token is worth checking (`app`): the app verifies it to know it
    /// reached the real daemon rather than a squatter (DP-06).
    ///
    /// `workspace_root` is the session's owning workspace for an `agent`
    /// (the path `CreateSession` recorded as `workspace_path`). gavin-mcp
    /// prefers it over walking up from cwd, because a rail worktree
    /// carries a tracked decoy `.gavin-root`. `serde(default)`: an older
    /// daemon sends nothing, and that means "fall back to the walk" --
    /// the field must never become one a tool requires, because a response
    /// field is invisible to `min_version_for`.
    HelloAck {
        role: String,
        daemon_version: u32,
        session_id: Option<String>,
        server_proof: Option<String>,
        #[serde(default)]
        workspace_root: Option<String>,
    },
    /// A request refused by `authorize` because the connection's role may
    /// not make it. Only ever sent to a connection that sent a `Hello` or
    /// completed a remote handshake -- a client that by construction knows
    /// this variant -- so an old client never meets a `Response` shape it
    /// cannot parse.
    Forbidden { request_type: String, role: String },
}

/// A session's git status, deduped daemon-side by repo root (many sessions
/// in the same repo share one of these). Crosses directly through to the
/// frontend via the Tauri event `session.rs`'s relay emits, unlike
/// `SessionSummary` below (which is only ever consumed Rust-side and
/// reconciled into other frontend-facing shapes) -- so unlike
/// `SessionSummary`, this needs camelCase field names to match the
/// frontend's own TypeScript naming, verified by the roundtrip test below
/// rather than assumed.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub repo_root: String,
    pub branch: String,
    pub dirty: bool,
    pub ahead: u32,
    pub behind: u32,
    pub has_upstream: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SessionSummary {
    pub id: String,
    pub workspace_path: String,
    pub cwd: String,
    pub status: String,
    pub restored: bool,
    /// This session's process was killed underneath the app and what is
    /// here now is a bare shell in the same cwd -- NOT the run that was
    /// started (see `SessionManager::recover`). `restored` says a
    /// previous lifetime's row came back; this says the command that row
    /// carried was deliberately not re-run, so nothing is executing the
    /// task any more.
    ///
    /// `serde(default)` because a v19 daemon does not send it, and false
    /// is the honest reading there: it never marks one.
    #[serde(default)]
    pub interrupted: bool,
    /// Why this session is `failed`, in one sentence, or None. Persisted
    /// with the status so Attach can re-baseline it: the reason arrives
    /// as a push, and a frontend reload that lost it would leave a red
    /// session with nothing to say for itself.
    ///
    /// `serde(default)` because a v20 daemon does not send it.
    #[serde(default)]
    pub failure_reason: Option<String>,
    /// A process from a previous daemon lifetime that this session's
    /// command was launched as, which the daemon probed and found STILL
    /// RUNNING -- reparented to init, with no tab in front of it and
    /// still in the checkout. `interrupted` says gavin stopped hosting
    /// the run; this says the run did not stop.
    ///
    /// `serde(default)` for the wire, but None is NOT self-describing
    /// here, unlike `interrupted`: from a v21 daemon it means "probed,
    /// nothing survived", and from a v20 one it means "never probed".
    /// Only the client's version check separates those, and a client
    /// that reads None as "no orphan" against an older daemon is
    /// asserting something nobody measured.
    #[serde(default)]
    pub orphan: Option<OrphanProcess>,
}

/// A surviving process, as much of it as the app needs to talk about it.
///
/// The pid and the command, and deliberately not the start time the
/// daemon matches on: that is an identity token for the reuse guard, and
/// a client that held it might be tempted to act on the pid itself. Every
/// action goes back through `EndOrphan`, which re-probes -- so the app
/// never needs, and never gets, enough to signal a process directly.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct OrphanProcess {
    pub pid: u32,
    /// The command line the session was launched with, so a confirmation
    /// can name what it is about to kill rather than showing a bare
    /// number. `None` for a session that never carried one.
    pub command: Option<String>,
}

/// One session's cost, as one sample.
///
/// CPU is a cumulative COUNTER and an instant, never a percentage. A rate
/// needs two readings and the interval between them, and the only honest
/// interval is the one the poller actually observed -- so the daemon
/// reports what it read and when, and the client divides. A daemon that
/// computed the percentage itself would have to keep a baseline per
/// caller, and two clients polling at different periods would each
/// corrupt the other's.
///
/// Both figures cover the process in the PTY *and everything it started*.
/// `sh -c` execs the agent in place, so the root pid IS the agent -- but
/// an agent's real cost is the language server, the MCP servers and the
/// build it spawned, and a row reporting 0.2% for a session pinning four
/// cores would be worse than a row reporting nothing.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SessionProcess {
    pub session_id: String,
    /// The command line this session was launched with, or `None` for a
    /// plain shell. Carried here rather than added to `SessionSummary`
    /// on purpose: widening that struct is invisible to
    /// `min_version_for`, and this whole payload rides behind a request
    /// type the gate can actually see.
    pub command: Option<String>,
    /// The pid in the PTY now, or `None` when the daemon has no verified
    /// identity for it -- a row written before the pid was recorded, or
    /// one whose process has gone.
    pub pid: Option<u32>,
    /// Resident memory of the whole tree, in bytes. 0 when nothing was
    /// measured.
    pub rss_bytes: u64,
    /// User + system CPU time consumed by the whole tree since each
    /// process started, in microseconds. 0 when nothing was measured.
    ///
    /// Monotonic per process but NOT per tree: a child exiting between
    /// two samples takes its share of the total with it, so the
    /// difference between two of these can be negative. A client turning
    /// them into a rate has to floor at zero rather than trust the
    /// subtraction.
    pub cpu_time_us: u64,
    /// How many processes the two figures cover. 0 says the sample found
    /// nothing, which is what separates a genuinely idle session from one
    /// whose process the daemon cannot see.
    pub process_count: u32,
    /// The daemon's clock when the sample was taken, in microseconds
    /// since the epoch -- the denominator for any rate computed from two
    /// of these. The daemon's, not the client's, so a rate is not
    /// distorted by however long the reply spent in transit.
    pub sampled_at_us: i64,
}

/// One follow-up waiting for a session to finish its turn.
///
/// Crosses straight through to the frontend the way `GitStatus` does
/// rather than being reconciled Rust-side, so the field names are
/// camelCase and the roundtrip test below is what holds them there.
///
/// There is no `position` field: the Vec's order IS the delivery order,
/// on the wire and in `SetQueuedInputs`. A number that has to agree with
/// an array index is a second source of truth for one fact, and the one
/// that goes stale is always the number.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QueuedInput {
    /// Stable for the life of the entry -- what `SetQueuedInputs` and
    /// `SendQueuedInput` name, so a drag or a send survives the queue
    /// shifting underneath it when a delivery fires mid-gesture.
    pub id: String,
    pub session_id: String,
    /// The message as the human wrote it. No paste envelope, no trailing
    /// CR: those belong to delivery, and this string is also what the
    /// tab renders.
    pub text: String,
    /// When it was queued, in microseconds since the epoch, by the
    /// daemon's clock. For showing the human how long something has been
    /// waiting -- never for ordering, which is the list's job.
    pub created_at_us: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Priority {
    None,
    Low,
    Medium,
    High,
    Urgent,
}

impl Priority {
    pub fn as_str(&self) -> &'static str {
        match self {
            Priority::None => "none",
            Priority::Low => "low",
            Priority::Medium => "medium",
            Priority::High => "high",
            Priority::Urgent => "urgent",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s {
            "low" => Priority::Low,
            "medium" => Priority::Medium,
            "high" => Priority::High,
            "urgent" => Priority::Urgent,
            _ => Priority::None,
        }
    }
}

/// How hard the work on a card is, on five ascending steps.
///
/// Deliberately NOT modelled on `Priority`, which has a `None` variant
/// standing for "nobody said". Complexity has no such level: an unset
/// card is `Option::None` at the field, so "nobody said" and "this is
/// trivial" stay two different answers. A card that says nothing runs
/// the workspace's own agent, which is the behaviour every card had
/// before this field existed.
///
/// The scale is about DIFFICULTY, not size -- how much reasoning the work
/// needs, not how many files it touches -- because that is the question
/// the app then answers with a model tier.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum Complexity {
    Trivial,
    Simple,
    Moderate,
    Complex,
    Intricate,
}

impl Complexity {
    pub fn as_str(&self) -> &'static str {
        match self {
            Complexity::Trivial => "trivial",
            Complexity::Simple => "simple",
            Complexity::Moderate => "moderate",
            Complexity::Complex => "complex",
            Complexity::Intricate => "intricate",
        }
    }

    /// The five levels in ascending order. The one place the ORDER is
    /// written down, so a picker, a settings table and a test cannot
    /// disagree about which end is which.
    pub const ALL: [Complexity; 5] = [
        Complexity::Trivial,
        Complexity::Simple,
        Complexity::Moderate,
        Complexity::Complex,
        Complexity::Intricate,
    ];

    /// Parses one written level, or None. Returns an Option rather than
    /// falling back to a level the way `Priority::from_str` does: a
    /// misspelled complexity must degrade to "unset" and a parse
    /// warning, never to a level that silently picks somebody an agent.
    pub fn parse(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "trivial" => Some(Complexity::Trivial),
            "simple" => Some(Complexity::Simple),
            "moderate" => Some(Complexity::Moderate),
            "complex" => Some(Complexity::Complex),
            "intricate" => Some(Complexity::Intricate),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Label {
    pub id: String,
    pub name: String,
    pub color: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Column {
    pub id: String,
    pub name: String,
    pub position: i64,
}

/// A card file's live agent-session binding (card-model spec §3).
/// Runtime state only -- never written into the card file.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CardSession {
    pub path: String,
    pub session_id: String,
    pub cwd: String,
    pub command: Option<String>,
    /// The agent CLI's own conversation id for this run (see
    /// `Request::LinkCardSession::conversation_id`).
    #[serde(default)]
    pub conversation_id: Option<String>,
    /// The directory this run was LAUNCHED in (see
    /// `Request::LinkCardSession::launch_cwd`). `cwd` above follows OSC 7
    /// and drifts; this one does not.
    #[serde(default)]
    pub launch_cwd: Option<String>,
    /// How many times gavin resumed this card's run by itself (v22). The
    /// card-run half of `StepRun::resume_attempts`, persisted for the
    /// same reason: the budget has to outlive the reload.
    #[serde(default)]
    pub resume_attempts: Option<u32>,
    /// The commit this run's checkout was on when the agent started
    /// (v26) -- the baseline the "Changes" view diffs against and the
    /// commit "discard this run" resets to.
    ///
    /// Recorded at launch because it is unrecoverable later: an agent's
    /// first minutes move HEAD and dirty the tree, and no amount of
    /// looking afterwards says where it began. None is the honest answer
    /// for a run launched outside a repository, on an unborn HEAD, or
    /// against a daemon too old to store it -- and every surface reads
    /// None as "no baseline", never as "no changes".
    #[serde(default)]
    pub base_sha: Option<String>,
}

/// One run of a card: the whole life of ONE session that was bound to
/// it (v27). `card_sessions` keeps the live binding and nothing else --
/// it is upserted by `(workspace_id, path)`, so every previous run was
/// overwritten by the next launch. This is that history, kept.
///
/// A run is a SESSION, not a conversation. A session id always exists,
/// it is what the daemon already thinks in, and it is what a human can
/// jump to. A *resume* launches a new session carrying the previous
/// run's `conversation_id`, so consecutive rows sharing one are a chain
/// the reader can present as such -- a judgement the daemon deliberately
/// does not make, because it would have to guess where a chain ends.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CardRun {
    /// Row id, ascending with time. The tiebreaker for two runs opened
    /// in the same second, which a relaunch genuinely can be.
    pub id: i64,
    pub path: String,
    pub session_id: String,
    pub command: Option<String>,
    /// The agent CLI's own id for this run's conversation, when the
    /// profile has one. Both the key the token totals are read by (the
    /// CLI names its own log after it) and what makes two rows a resume
    /// chain.
    pub conversation_id: Option<String>,
    pub launch_cwd: Option<String>,
    /// The commit this run started on -- `CardSession::base_sha`, kept
    /// per run so the Changes view can be offered for a PAST run and not
    /// only the live one.
    pub base_sha: Option<String>,
    /// Wall-clock epoch seconds. The registry cannot supply these: its
    /// `started_at_us` is a process start time used as a pid-reuse
    /// guard, not a clock anyone can subtract.
    pub started_at: i64,
    /// None while the run is open, and ALSO for a run the daemon never
    /// saw end (`outcome` says which). Never a stand-in for "now".
    pub ended_at: Option<i64>,
    /// The session's exit code, when the daemon watched it exit.
    pub exit_code: Option<i32>,
    /// How the run ended, and never absent:
    ///
    ///  - `running`   -- open, and this daemon is hosting it
    ///  - `exited`    -- the session ended; `exit_code` says how
    ///  - `replaced`  -- a newer run took the card's binding
    ///  - `unlinked`  -- the binding was removed (unlink, delete, archive)
    ///  - `abandoned` -- it ended and nobody was watching: the daemon
    ///    that opened the row went away, or the session ended with
    ///    nothing attached to notice. `ended_at` stays None rather than
    ///    being back-filled with the time somebody LOOKED, which is a
    ///    different fact from the time it stopped.
    pub outcome: String,
    /// Unattended auto-resumes WITHIN this session, as of its last link
    /// (see `CardSession::resume_attempts`). Not the number of times the
    /// run was resumed INTO a new session -- that is the chain above.
    pub resume_attempts: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Board {
    pub columns: Vec<Column>,
    pub labels: Vec<Label>,
    #[serde(default)]
    pub card_sessions: Vec<CardSession>,
}

/// One orchestration rail: an ordered column of stages over the board's
/// cards. `worktree_path` is the cwd its steps' sessions get; `page_id`
/// is the workspace page they land on. Both optional -- a rail is a name
/// until it is bound (orchestration spec O5).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Rail {
    pub id: String,
    pub name: String,
    pub position: i64,
    pub worktree_path: Option<String>,
    /// WHICH BRANCH the rail's checkout sits on (spec O15). Orthogonal
    /// to `worktree_path`, which says which checkout: a rail with a
    /// branch and no worktree runs on that branch in the ROOT checkout,
    /// which is the whole point -- branches without a folder each.
    /// None means "whatever is checked out", the behaviour that predates
    /// this field, so it is defaulted rather than required.
    #[serde(default)]
    pub branch: Option<String>,
    /// Whether this rail may resume its OWN interrupted steps, without
    /// being asked (v22). None and false both mean no, which is the
    /// behaviour that predates the field and the only safe default: an
    /// automatic resume is a decision the human has to have made in
    /// advance, for this rail, or it is a decision gavin took for them.
    #[serde(default)]
    pub auto_resume: Option<bool>,
    /// What arms this rail without a human pressing Start (v35). None is
    /// "nothing does", which is the behaviour that predates the field and
    /// the only safe default -- a rail that starts itself on a condition
    /// nobody wrote down is a decision gavin took for the human.
    #[serde(default)]
    pub trigger: Option<RailTrigger>,
    pub page_id: Option<String>,
    pub stages: Vec<Stage>,
}

/// A rail's own start condition: what has to be true for gavin to arm it
/// without being asked.
///
/// `kind` is a String rather than an enum for the same reason `StageMode`
/// is: the daemon only stores and returns it, so widening the vocabulary
/// must not become a wire break. The app decides what each kind MEANS,
/// and refuses to fire on one it does not recognise -- never firing is
/// the safe reading of an unknown condition, and the opposite would arm a
/// rail on a rule nobody in this process can state.
///
/// `rail` is the rail a `rail-done` trigger waits for, by NAME rather
/// than by id, because that is what the human types and what
/// `gavin_get_orchestration` shows an agent -- the same choice
/// `builtin:start-rail`'s `rail` parameter makes, and resolved by the
/// same case- and space-insensitive match.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RailTrigger {
    pub kind: String,
    #[serde(default)]
    pub rail: Option<String>,
}

/// How a stage's steps run: "sequence" (one at a time, in position
/// order) or "parallel" (all at once, in the same checkout). A String
/// rather than an enum for the same reason ToolKind is: the daemon only
/// stores and returns it, and widening the vocabulary must not become a
/// wire break.
pub type StageMode = String;

/// Serde's own String default is "", which reads as NEITHER mode. Every
/// stage written before groups existed omits the field, and it must come
/// back as the discipline it actually ran under.
pub fn default_stage_mode() -> StageMode {
    "parallel".into()
}

/// Stages run one after another. A `parallel` stage's steps run at the
/// same time in the SAME checkout, since they share the rail's worktree;
/// a `sequence` stage's run one at a time (grouping spec G4). A stage
/// holding two or more steps is what the app calls a GROUP.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Stage {
    pub id: String,
    pub position: i64,
    #[serde(default = "default_stage_mode")]
    pub mode: StageMode,
    /// The group's name. None renders as the positional label.
    #[serde(default)]
    pub name: Option<String>,
    pub steps: Vec<Step>,
}

/// A step is a REFERENCE to a card file (spec O2) -- title, prompt,
/// status and checklist all stay in the card -- OR to a tool (tools spec
/// T1), in which case `tool_id` is set and `card_path` is `""`. Never
/// both: `card_path` stays a non-optional String so the running-step
/// guard's message and the NOT NULL column both survive untouched, and
/// an absolute card path can never be empty.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    pub id: String,
    pub position: i64,
    /// Defaulted so an agent writing a TOOL step can omit it entirely
    /// rather than having to spell `"cardPath": ""`. The daemon still
    /// refuses a step that is neither a card nor a tool.
    #[serde(default)]
    pub card_path: String,
    /// Set for a tool step; None for a card step.
    #[serde(default)]
    pub tool_id: Option<String>,
    /// Per-step parameter OVERRIDES only. A parameter the human never
    /// touched is absent here and resolves to the tool's own default.
    #[serde(default)]
    pub tool_params: HashMap<String, String>,
}

/// What a tool RUNS AS (tools spec T2). A String rather than an enum for
/// the same reason RailRun::state is: the daemon only stores and returns
/// it, and widening the vocabulary must not become a wire break.
/// agent | command | script
pub type ToolKind = String;

/// One parameter of a tool, substituted into its body as `{{name}}`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToolParam {
    pub name: String,
    pub label: String,
    pub default: String,
}

/// A reusable unit of work droppable onto a rail. `workspace_id` is the
/// SCOPE: Some(id) is that workspace's own, None is global to this
/// machine (tools spec T4). Built-in tools never reach the daemon --
/// they are constants in the app.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToolDef {
    pub id: String,
    pub workspace_id: Option<String>,
    pub name: String,
    pub description: String,
    pub kind: ToolKind,
    pub body: String,
    pub params: Vec<ToolParam>,
    pub position: i64,
    /// Where this tool RUNS when it is launched standalone from the
    /// Tools tab (v30): relative resolves against the workspace root,
    /// absolute is taken as written, None is the root itself.
    ///
    /// A rail step ignores it, and that is a rule rather than an
    /// oversight (tools spec T6/T11): a step runs in `worktree_path ??
    /// root_path` because rail conflict detection is computed off THAT
    /// checkout, so a step that quietly jumped out of its worktree would
    /// let two rails collide with nothing left to warn about.
    ///
    /// `serde(default)` because every tool authored before v30 has none,
    /// and "no directory of its own" is exactly what those tools mean.
    #[serde(default)]
    pub cwd: Option<String>,
    /// The glyph this tool draws wherever tools are listed (v33): a NAME
    /// from the app's own icon library, never an image. None means
    /// "whatever this tool's KIND draws", which is what every tool
    /// authored before v33 means and what a tool nobody picked an icon
    /// for still means.
    ///
    /// Raw here, like `kind`: the library is a curated list of lucide
    /// names in the app, so the daemon has nothing to validate a name
    /// against and a rule it invented would refuse one a newer app
    /// knows. The app falls back to the kind's glyph for a name it
    /// cannot resolve, which is the honest reading of one it has never
    /// heard of.
    #[serde(default)]
    pub icon: Option<String>,
}

/// One standalone run of a library tool, launched from the Tools hub tab
/// (v30). Deliberately shaped like `CardRun`: it answers the same
/// questions about the same thing -- one session, opened and closed by
/// the daemon -- and a second vocabulary for "how did that end" is a
/// second set of words the reader would have to learn.
///
/// What it does NOT carry is the rail's half of a `StepRun`. A tool run
/// has no stage to advance, no retry budget and nothing to send
/// backwards: it is one session, and the record exists so a failure
/// nobody was watching is still on the row after a restart.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToolRun {
    /// Row id, ascending with time. The tiebreaker for two runs of one
    /// tool opened in the same second, and what "the last run" is picked
    /// by -- `started_at` has one-second resolution and cannot order
    /// them.
    pub id: i64,
    pub tool_id: String,
    pub session_id: String,
    pub command: Option<String>,
    /// Where the session was launched: the tool's own `cwd` resolved
    /// against the workspace root. A run row that did not say where it
    /// ran would be evidence of nothing, now that a tool can carry a
    /// directory of its own.
    pub launch_cwd: Option<String>,
    /// The agent CLI's own id for this run's conversation. None for
    /// every kind but `agent`: a shell has no conversation.
    pub conversation_id: Option<String>,
    /// Wall-clock epoch seconds, like `CardRun`'s: the registry's own
    /// `started_at_us` is a process start time kept as a pid-reuse
    /// guard, not a clock anyone can subtract.
    pub started_at: i64,
    /// None while the run is open, and ALSO for a run whose end the
    /// daemon never saw (`outcome` says which). Never a stand-in for now.
    pub ended_at: Option<i64>,
    /// The session's exit code, when the daemon watched it exit. None
    /// for an `agent` tool, whose verdict is its turn ending rather than
    /// its process stopping.
    pub exit_code: Option<i32>,
    /// How the run ended, and never absent:
    ///
    ///  - `running`   -- open, and this daemon is hosting it
    ///  - `passed`    -- it did what it was asked: a shell exited 0, or
    ///    an agent's turn ended without failure detection firing
    ///  - `failed`    -- a non-zero exit, or a broken agent
    ///  - `abandoned` -- it ended and nobody was watching: the daemon
    ///    that opened the row went away, or the session ended with
    ///    nothing attached to notice. `ended_at` stays None rather than
    ///    being back-filled with the time somebody LOOKED, which is a
    ///    different fact from the time it stopped.
    ///
    /// `passed`/`failed` where `CardRun` says `exited`, deliberately: a
    /// card run's verdict is the board, so the daemon only reports that
    /// the session stopped. A tool run's whole point IS the verdict, and
    /// "exited with code 1" is the evidence for it rather than a
    /// substitute for saying it.
    pub outcome: String,
}

/// One member of a group template: a tool and the overrides it carries.
/// Deliberately NOT a Step -- step ids are run-state keys and must be
/// minted fresh at every placement, and a card path has no meaning in a
/// template (grouping spec G7).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GroupTemplateStep {
    pub tool_id: String,
    #[serde(default)]
    pub tool_params: HashMap<String, String>,
}

/// A reusable group droppable onto a rail -- merge + push, commit +
/// test. `workspace_id` is the SCOPE, exactly as it is for a ToolDef:
/// Some(id) is that workspace's own, None is global to this machine
/// (grouping spec G8). There are no built-in templates.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GroupTemplate {
    pub id: String,
    pub workspace_id: Option<String>,
    pub name: String,
    pub description: String,
    pub mode: StageMode,
    pub steps: Vec<GroupTemplateStep>,
    pub position: i64,
}

/// The agent's own judgement about a set of steps, rendered beside the
/// computed conflicts. Written only through SetOrchestration.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConflictNote {
    pub id: String,
    pub step_ids: Vec<String>,
    pub note: String,
}

/// Machine-local runtime bookkeeping; the agent never writes these.
/// A rail with no row is "idle"; a step with no row is "pending".
///
/// `state` is a String, not an enum, deliberately: the daemon only
/// stores and compares it, and a widened vocabulary must not become a
/// wire break.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RailRun {
    pub rail_id: String,
    /// idle | running | paused
    pub state: String,
    pub current_stage_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StepRun {
    pub step_id: String,
    /// pending | running | done | skipped | stalled
    ///
    /// Opaque here on purpose -- the app owns this vocabulary and the
    /// daemon only stores it, which is why `skipped` ("the human sent the
    /// rail past this step") could join without a protocol bump. Anything
    /// that has to reason about it must ask the app.
    pub state: String,
    pub session_id: Option<String>,
    /// Human-readable stall cause; None otherwise.
    pub reason: Option<String>,
    /// The agent CLI's own conversation id for this run (see
    /// `Request::LinkCardSession::conversation_id`), so a stalled step can
    /// be resumed as the conversation it was.
    #[serde(default)]
    pub conversation_id: Option<String>,
    /// The directory this run was LAUNCHED in (see
    /// `Request::LinkCardSession::launch_cwd`).
    #[serde(default)]
    pub launch_cwd: Option<String>,
    /// How many times gavin has resumed this run BY ITSELF (v22). The
    /// budget for unattended recovery, and it lives on the row rather
    /// than in the app's memory for one reason: an app reload and a
    /// daemon restart are exactly the conditions auto-resume runs under,
    /// so a counter that resets on either is not a limit at all.
    ///
    /// None reads as zero. A manual Resume does not spend it -- the human
    /// pressing a button as often as they like is not the thing this
    /// bounds.
    #[serde(default)]
    pub resume_attempts: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Orchestration {
    pub rails: Vec<Rail>,
    pub conflict_notes: Vec<ConflictNote>,
    pub rail_runs: Vec<RailRun>,
    pub step_runs: Vec<StepRun>,
}

/// What a card file IS (card-model spec §1): a reminder, a single agent
/// task (body = the prompt), or a multi-task plan. Absent/unknown kind
/// parses as Plan so pre-kind files stay valid.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum CardKind {
    Note,
    Task,
    Plan,
}

/// What a `Decision:` / `Human test:` checklist line is asking of the
/// human: a call to make, or a check to run by hand.
///
/// Two and not three: "decision" covers every question whose answer is
/// words, and "test" every one whose answer is pass or fail. The
/// distinction is load-bearing because only a test can FAIL -- and a
/// failed test goes back to the agent while an unanswered decision waits
/// on the human, which is the difference the tab's waiting count turns
/// on.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum HumanItemKind {
    Decision,
    Test,
}

/// Where a human item stands, read off the last `Answer (date):` /
/// `Result (date):` / `Ready for re-test (date)` line under it.
///
/// Distinct from the checkbox, which is not enough on its own: a failed
/// test is unticked and so is one nobody has looked at yet, and the tab
/// has to tell "waiting on you" from "back with the agent". `Open` is
/// also what a re-armed test reads as, which is the whole point of
/// re-arming it.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum HumanItemState {
    Open,
    Answered,
    Passed,
    Failed,
}

/// What the human chose, on the way back down the wire.
///
/// `Fail` and `FailAndClose` carry the same note and differ only in the
/// checkbox: a plain fail leaves the item open so the agent sees it
/// still owes the work, and fail-and-close is the human overruling that
/// -- the check failed and is not going to be re-run. Keeping them as
/// two outcomes rather than a `close: bool` flag is what makes the
/// second one a deliberate act at every call site.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum HumanItemOutcome {
    Answer { text: String },
    Pass,
    Fail { note: String },
    FailAndClose { note: String },
}

/// One `Decision:` / `Human test:` checklist line, parsed.
///
/// Crosses to the frontend, so camelCase like `PlanFileInfo`, verified by
/// a shape test below.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HumanItem {
    pub kind: HumanItemKind,
    /// The question or the check, with the marker stripped: the
    /// `Which serializer?` of `Decision: Which serializer?`.
    pub text: String,
    /// The checkbox. Not the same question as `state`: a fail-and-close
    /// is ticked and failed, a plain fail is unticked and failed, and a
    /// human who ticked the box by hand in an editor is done with it
    /// whatever the lines underneath say.
    pub done: bool,
    /// The item's indented `Options:` line, split into its choices.
    /// Empty when there is no such line -- an open-ended question, or a
    /// test, which never has one.
    pub options: Vec<String>,
    /// The last `Answer (date): …` / `Result (date): …` / `Ready for
    /// re-test (date)` line under the item, verbatim and un-indented, or
    /// None for an item nobody has touched. Kept raw because the tab
    /// SHOWS it: the date and the note are the record, and re-deriving
    /// them from `state` would throw away the half a person reads.
    pub latest: Option<String>,
    pub state: HumanItemState,
    /// The line's raw remainder -- marker included, the `Decision: Which
    /// serializer?` -- which is what `ResolveHumanItem` and
    /// `SetChecklistItem` both guard on. Distinct from `text`, which has
    /// the marker stripped for display.
    pub line_text: String,
    /// Where the line sits in the file, counting from zero. A stable key
    /// for a tab row within one snapshot; NOT a write guard -- the card
    /// can have moved under it, which is why `ResolveHumanItem` matches
    /// on `line_text` instead.
    pub line_index: u32,
}

/// One card file inside a `.gavin*/plans/` folder, with its frontmatter
/// parsed (kind/title/status/priority/order/parent/labels) and its body
/// checklist counted. `parse_warning` covers an unterminated frontmatter
/// block or an unrecognized field value -- the card still appears, never
/// silently dropped (spec §4). Crosses to the frontend, so camelCase
/// like GitStatus, verified by a shape test below.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlanFileInfo {
    pub path: String,
    pub file_name: String,
    pub title: String,
    pub status: Option<String>,
    pub priority: Option<Priority>,
    pub order: Option<i64>,
    pub kind: CardKind,
    pub parent: Option<String>,
    pub labels: Vec<String>,
    pub checklist_done: u32,
    pub checklist_total: u32,
    pub parse_warning: bool,
    /// The card file's mtime, as whole seconds since the unix epoch, or
    /// None when the file could not be stat'd. The archive grid is
    /// ordered by it -- for an archived card it is effectively "when it
    /// was archived", since the move rewrites the mtime.
    ///
    /// `serde(default)` so an older daemon's tree still parses: the field
    /// simply reads None and the grid falls back to path order.
    #[serde(default)]
    pub modified_at: Option<i64>,
    /// The card's `attachments:` line, split on commas and trimmed --
    /// files the card points an agent at. Kept RAW, exactly as written:
    /// a path that no longer resolves has to reach the UI as a broken
    /// chip and block the run, and a value filtered out here would
    /// instead vanish silently and let the agent start blind.
    ///
    /// Parsed on any card kind (a note is a fine place to park a
    /// reference); only task and plan cards put it in a prompt.
    /// `serde(default)` so an older daemon's tree still parses.
    #[serde(default)]
    pub attachments: Vec<String>,
    /// The card's `complexity:` line -- how hard the work is, on five
    /// ascending steps -- or None where the card says nothing. The app
    /// turns a level into the agent profile and model that executes the
    /// card, so None is load-bearing: it means "run the workspace's own
    /// agent", which is what every card did before this field existed.
    ///
    /// Parsed on any card kind, like `attachments`: a note is a fine
    /// place to record that something is going to be gnarly, even though
    /// nothing will ever run it. An unparseable value is a
    /// `parse_warning` and None, never a guessed level -- see
    /// `Complexity::parse`.
    ///
    /// `serde(default)` so an older daemon's tree still parses.
    #[serde(default)]
    pub complexity: Option<Complexity>,
    /// The card's `agent:` line -- the agent profile THIS card runs on,
    /// whatever the complexity table or the workspace's own `[agent]`
    /// block would otherwise pick -- or None where the card says nothing.
    ///
    /// Kept RAW, like `attachments` and unlike `complexity`: the profile
    /// table lives in the Tauri host, so the daemon has nothing to check
    /// a name against and inventing a rule here would refuse writes the
    /// app knows are fine. A name the app cannot resolve reads back as
    /// itself on the card, which is what makes a typo visible instead of
    /// silent.
    ///
    /// Parsed on any card kind, like `complexity`, and `serde(default)`
    /// so an older daemon's tree still parses.
    #[serde(default)]
    pub agent: Option<String>,
    /// The card's `model:` line -- the model that agent launches with.
    /// Independent of `agent` above: on its own it means "this
    /// workspace's own agent, at this model", which is the commonest
    /// override of the two.
    ///
    /// Raw for a sharper version of `agent`'s reason: the names belong to
    /// whichever CLI is installed, and gavin's own per-profile lists are
    /// a convenience for the picker rather than a closed set.
    ///
    /// `serde(default)` so an older daemon's tree still parses.
    #[serde(default)]
    pub model: Option<String>,
    /// The card's `Decision:` / `Human test:` checklist lines, parsed
    /// (v42) -- everything on this card that is waiting on a person.
    ///
    /// `Option<Vec<_>>`, not the `serde(default)` `Vec` the fields above
    /// use, and the difference is the whole point. This tree is read by
    /// the daemon, deserialized by the Tauri host and re-serialized to
    /// the frontend, so a defaulted `Vec` would reach the tab as an
    /// empty list whether the daemon parsed nothing or never looked --
    /// and the tab would report "nothing waiting on you" for a workspace
    /// whose daemon simply predates the feature. `None` survives the
    /// round trip as `null`, which is the honest "unknown"; `Some(vec![])`
    /// is a daemon that looked and found none.
    #[serde(default)]
    pub human_items: Option<Vec<HumanItem>>,
}

/// A markdown file in a context's docs/ or specs/ listing. `rel_path` is
/// relative to that subfolder (listings are recursive).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MdFileInfo {
    pub path: String,
    pub rel_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum GavinContextKind {
    Root,
    Context,
}

/// Where the PRD lives when the root config says nothing -- the path
/// `init_gavin_root` scaffolds, and therefore the answer for every
/// workspace gavin created itself. A workspace that already had a PRD of
/// its own points `prd` at it instead.
pub const DEFAULT_PRD_PATH: &str = ".gavin-root/PRD.md";

/// The root config's `prd`, if it names a path gavin will actually use:
/// relative to the workspace root, no `..`, no absolute prefix. Mirrors
/// agent_setup's `usable_mcp_path` -- a subpath IS allowed, unlike the
/// agent instructions file, because an existing project's PRD is usually
/// under `docs/`.
///
/// Lives here rather than in either consumer because BOTH the daemon
/// (which resolves the path for `read_prd` and `has_prd`) and the Tauri
/// host (which names it in every file it writes for an agent) have to
/// agree on it; a copy in each is a copy that can drift.
pub fn usable_prd_path(value: &str) -> Option<String> {
    let trimmed = value.trim();
    let path = std::path::Path::new(trimmed);
    if trimmed.is_empty() || path.is_absolute() {
        return None;
    }
    // Rejects `..` anywhere, and the Windows prefixes/root-dir components
    // an absolute check on a foreign separator would miss.
    if !path.components().all(|c| matches!(c, std::path::Component::Normal(_))) {
        return None;
    }
    Some(trimmed.to_string())
}

/// One `attachments:` entry, if it names a path gavin will actually
/// resolve. Mirrors `usable_prd_path` with one deliberate difference: an
/// ABSOLUTE path is kept as-is rather than refused. An attachment is a
/// reference to a file the human picked, and the useful ones are
/// routinely outside the repo -- a screenshot in ~/Desktop, a spec on a
/// shared volume -- so refusing absolutes would refuse the common case.
///
/// A relative path stays relative here; resolving it is the caller's
/// job, and it always resolves against the WORKSPACE ROOT rather than a
/// session's cwd, so the same card hands every session -- worktree or
/// not -- the same bytes.
///
/// `..` is still refused, absolute or not: gavin resolves these paths on
/// the human's behalf and then hands them to an agent, and a traversal
/// that reads as a tidy relative path is exactly the value nobody
/// re-reads. Someone who genuinely means a file two directories up can
/// say so with an absolute path.
///
/// Lives here, beside `usable_prd_path`, because both clients need the
/// same answer: the Tauri host stats these paths and the daemon parses
/// them out of the frontmatter.
/// Reads over `ReadWorkspaceFile` are cut here, the viewer's own cap.
pub const MAX_WORKSPACE_FILE_BYTES: usize = 1024 * 1024;

/// One entry of a `ListWorkspaceDir` reply -- the fields the file tree
/// reads (`DirEntryInfo` on the desktop), in the same camelCase shape.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDirEntry {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    pub symlink: bool,
}

/// One attachment as it resolves on the daemon's machine (v39). The same
/// facts the desktop's `attachment_status` establishes for a local root,
/// in the same vocabulary: `location` is `root`, `extraContext`, `outside`
/// or `refused`, and a refused entry carries its reason and no path.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacePathStat {
    pub path: String,
    pub absolute_path: Option<String>,
    /// A FILE exists there -- a directory does not count, since an
    /// attachment names something to read.
    pub exists: bool,
    /// A directory is there instead. Answers the one question a caller
    /// asks about a root rather than a file: whether it is one.
    pub is_dir: bool,
    pub size_bytes: Option<u64>,
    pub location: String,
    pub refused_reason: Option<String>,
}

pub fn usable_attachment_path(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    let path = std::path::Path::new(trimmed);
    if path.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return None;
    }
    Some(trimmed.to_string())
}

/// The root context's `[agent]` block from `.gavin-root/config.toml`.
/// Every field optional: a config.toml predating workspace settings
/// parses cleanly with all of them `None`, and the profile defaults apply.
/// Only ever populated for the root context -- `.gavin` sub-contexts have
/// no agent block.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfig {
    pub profile: Option<String>,
    pub file: Option<String>,
    pub command: Option<String>,
    /// Where THIS workspace's agent reads MCP config, for the `custom`
    /// profile -- the five stock profiles carry a verified path in the
    /// table instead. Relative to the root. `default` keeps an older
    /// daemon's tree parseable, exactly as `outside` does below.
    #[serde(default)]
    pub mcp_file: Option<String>,
    /// Which dialect that file is written in; one of the `McpFormat`
    /// names. Absent means the `mcpServers.<key>` JSON shape, which three
    /// of the five CLIs use.
    #[serde(default)]
    pub mcp_format: Option<String>,
    /// The model this workspace's agent launches with, composed onto the
    /// command as `<model_flag> <model>`. Absent means "inherit the
    /// app-wide default for this profile" -- the first key in this block
    /// with a fallback underneath it, which is also why it is the only
    /// one `set_root_config_field` can clear. `default` keeps an older
    /// daemon's tree parseable, exactly as `mcp_file` does above.
    #[serde(default)]
    pub model: Option<String>,
    /// The argv that carries `model` into this workspace's agent, e.g.
    /// `--model`. Absent means "use the profile table's flag", which is
    /// the right answer for the five stock profiles: their flags are
    /// verified in Rust and a hand-typed one here could only be wrong.
    ///
    /// It exists for the sixth profile. `custom` is the user's own
    /// binary, so the table has no flag for it and could never have one
    /// -- which until now meant a custom agent had no model control at
    /// all, and the only way to pin a model was to bake it into
    /// `command` where nothing could read it back. Naming the flag is
    /// what turns a hand-written command into an agent gavin can vary
    /// the model of, which is the whole of the complexity table.
    ///
    /// Clearable, like `model` -- an absent key reads as "gavin decides"
    /// where `model_flag = ""` would read as a deliberate refusal.
    /// `default` keeps an older daemon's tree parseable, exactly as
    /// `model` does above.
    #[serde(default)]
    pub model_flag: Option<String>,
}

/// A folder that contains a `.gavin-root/` (kind Root, only ever directly
/// under the workspace root) or `.gavin/` (kind Context) directory.
/// `folder_path` is the CONTAINING folder, not the marker directory.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GavinContext {
    pub folder_path: String,
    pub kind: GavinContextKind,
    pub name: String,
    pub plans: Vec<PlanFileInfo>,
    pub docs: Vec<MdFileInfo>,
    pub specs: Vec<MdFileInfo>,
    pub has_prd: bool,
    pub config_warning: bool,
    pub agent: Option<AgentConfig>,
    /// The root config's top-level `prd`, when it names a usable relative
    /// path. Only ever populated for the root context. `None` means the
    /// workspace has never chosen one and `DEFAULT_PRD_PATH` applies --
    /// which is also what an older daemon's tree looks like, so the
    /// fallback covers both cases with the same branch.
    #[serde(default)]
    pub prd: Option<String>,
    /// True for contexts living outside the workspace root, pulled in via
    /// `extra_contexts` in the root config. Default keeps old daemons'
    /// trees parseable.
    #[serde(default)]
    pub outside: bool,
}

/// The full scanned picture of one workspace's bound root. Never
/// persisted -- re-derived from disk on every scan (the git-status
/// posture). PartialEq is load-bearing: the watcher change-gates pushes
/// by comparing whole trees.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GavinTree {
    pub root_path: String,
    pub root_missing: bool,
    pub contexts: Vec<GavinContext>,
}

pub fn write_message<W: Write, T: Serialize>(writer: &mut W, msg: &T) -> anyhow::Result<()> {
    let line = serde_json::to_string(msg)?;
    writer.write_all(line.as_bytes())?;
    writer.write_all(b"\n")?;
    writer.flush()?;
    Ok(())
}

pub fn read_message<R: BufRead, T: for<'de> Deserialize<'de>>(
    reader: &mut R,
) -> anyhow::Result<Option<T>> {
    let mut line = String::new();
    let bytes_read = reader.by_ref().take(MAX_LINE_BYTES).read_line(&mut line)?;
    if bytes_read == 0 {
        return Ok(None);
    }
    if !line.ends_with('\n') && (bytes_read as u64) >= MAX_LINE_BYTES {
        anyhow::bail!("protocol line exceeded {MAX_LINE_BYTES} bytes without a newline");
    }
    let msg = serde_json::from_str(line.trim_end())?;
    Ok(Some(msg))
}

use std::ffi::OsString;
use std::path::{Path, PathBuf};

/// The longest path `bind(2)` will accept for a Unix socket, in bytes.
///
/// `sockaddr_un::sun_path` is a fixed 104-byte array on macOS and 108 on
/// Linux, one of which must be the terminating NUL -- so 103 is the
/// figure that holds on both. It is not a limit anything reports well:
/// the kernel answers a long path with EINVAL on macOS and
/// ENAMETOOLONG on Linux, neither of which mentions a length, which is
/// why `socket_path` checks it here instead of letting the daemon die
/// on an opaque bind failure. `crates/daemon/tests/shutdown.rs` builds
/// its fake $HOME under /tmp for exactly this reason.
///
/// Unix only, and `socket_path` applies it only there: the Windows
/// endpoint is a pipe NAME derived from this path by hashing, so its
/// length is fixed however long the path is, and refusing a perfectly
/// good `%LOCALAPPDATA%` for being 110 characters would be a limit
/// invented out of nothing.
pub const SUN_PATH_MAX: usize = 103;

/// Which OS's rule for where an application keeps its own state.
///
/// Named rather than a `bool`, because there are three answers now and
/// "not macOS" stopped being one of them the moment Windows arrived:
/// a two-valued flag would have quietly filed Windows under XDG and put
/// the databases in `C:\Users\x\.local\share`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostOs {
    MacOs,
    Windows,
    /// Linux and every other unix: the XDG base directory spec.
    Xdg,
}

impl HostOs {
    /// What this build is running on.
    pub const fn current() -> HostOs {
        if cfg!(target_os = "macos") {
            HostOs::MacOs
        } else if cfg!(windows) {
            HostOs::Windows
        } else {
            HostOs::Xdg
        }
    }
}

/// Which build of gavin a process belongs to.
///
/// A compile-time fact, and deliberately not an environment variable. An
/// override would be inherited by every PTY the daemon opens, so every
/// `gavin-mcp` in those tabs and any app launched from one would land
/// back on the wrong daemon unless the launcher stripped it -- the catch
/// `.gavin-root/plans/issue-stable-and-dev-apps-share-one-state-dir.md`
/// raised against that route. Nothing here can be inherited, so nothing
/// has to be stripped.
///
/// It is also self-consistent for free: the dev tree is built debug by
/// `tauri dev`, a release install and the stable worktree's
/// `target/release` are built release, and the app, the daemon and
/// gavin-mcp are each resolved as siblings of one another
/// (`resolve_daemon_binary_path`, `resolve_mcp_binary_path`) -- so a
/// build's three binaries agree on this answer by construction.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BuildProfile {
    Dev,
    Release,
}

impl BuildProfile {
    /// What this build is.
    pub const fn current() -> BuildProfile {
        if cfg!(debug_assertions) {
            BuildProfile::Dev
        } else {
            BuildProfile::Release
        }
    }

    /// What a per-daemon file name carries. EMPTY for `Release`, and that
    /// is load-bearing: it is what keeps an installed gavin's paths
    /// byte-identical to the ones it has been using, so this change needs
    /// no migration and the installed app does not notice it landed.
    pub const fn suffix(self) -> &'static str {
        match self {
            BuildProfile::Dev => "-dev",
            BuildProfile::Release => "",
        }
    }
}

/// The name of a file that belongs to ONE RUNNING DAEMON.
///
/// The state DIRECTORY is shared and stays shared -- one board, one set
/// of rails, one workspace list, one `config.json`, because those are the
/// work and both builds have to find all of it. What cannot be shared is
/// anything naming a live daemon: the endpoint, the token that
/// authenticates to it, its log, and the registry of the PTYs it owns.
/// See
/// `docs/superpowers/specs/2026-09-11-per-build-daemon-isolation-design.md`.
///
/// The suffix goes before the extension so the last path segment still
/// ends in `.sock` / `.sqlite`, which is what `pipe_name_for_path` turns
/// into a readable tag and what anyone reading the directory expects.
pub fn profile_file_name(stem: &str, extension: &str, profile: BuildProfile) -> String {
    format!("{stem}{}.{extension}", profile.suffix())
}

/// Where gavin keeps its socket and its three SQLite stores.
///
/// Per-OS on purpose, and macOS deliberately does NOT consult XDG:
/// every existing install already has its registry, kanban and
/// orchestration databases under `~/Library/Application Support/gavin`,
/// and a developer with `XDG_DATA_HOME` exported for some unrelated tool
/// must not silently start a second, empty daemon beside the one holding
/// their work. Linux (and any other unix) follows the XDG base
/// directory spec: `$XDG_DATA_HOME/gavin`, defaulting to
/// `~/.local/share/gavin`.
///
/// On Windows the answer, `%LOCALAPPDATA%\gavin`, is one letter's case
/// away from `%LOCALAPPDATA%\Gavin`, which is what Tauri's NSIS template
/// would install the app into -- the same folder, on a case-insensitive
/// filesystem, and an uninstall then sits beside the databases.
/// `app/src-tauri/nsis/hooks.nsh` moves the installer to
/// `%LOCALAPPDATA%\Programs\Gavin` and refuses this directory, and it
/// spells this path out by hand because it has no way to ask this
/// function. Moving this directory means moving that file: the two must
/// never converge again.
///
/// Fallible rather than panicking. `HOME` is missing in a launchd job,
/// a systemd unit without `User=`, and a container that never set it;
/// the old `expect` turned that into a daemon that aborts before it
/// prints anything and an app whose only symptom is "daemon did not
/// become reachable". An Err travels up through `bootstrap` instead and
/// reaches the human as the connection banner, naming the variable.
pub fn app_support_dir() -> anyhow::Result<PathBuf> {
    resolve_app_support_dir(
        std::env::var_os("HOME"),
        std::env::var_os("XDG_DATA_HOME"),
        std::env::var_os("LOCALAPPDATA"),
        std::env::var_os("USERPROFILE"),
        HostOs::current(),
    )
}

/// The decision behind `app_support_dir`, with the environment passed in.
///
/// Split out so the per-OS rule can be tested at every interesting
/// value without `set_var`: the suite runs multi-threaded, the daemon
/// tests spawn real processes that read `HOME`, and mutating the
/// process environment under that is how a green suite starts failing
/// only on someone else's machine.
pub fn resolve_app_support_dir(
    home: Option<OsString>,
    xdg_data_home: Option<OsString>,
    local_app_data: Option<OsString>,
    user_profile: Option<OsString>,
    os: HostOs,
) -> anyhow::Result<PathBuf> {
    let home = home.filter(|h| !h.is_empty());
    if os == HostOs::MacOs {
        let home = home.ok_or_else(|| {
            anyhow::anyhow!("HOME is not set, so gavin cannot find ~/Library/Application Support")
        })?;
        return Ok(PathBuf::from(home).join("Library").join("Application Support").join("gavin"));
    }
    // Windows, and deliberately NOT consulting XDG either: the same
    // reasoning as macOS. `%LOCALAPPDATA%` is per-user, is not roamed
    // (these are a socket and three SQLite files -- nothing that should
    // follow a profile onto another machine mid-write), and is where
    // every other desktop app of this shape keeps the same thing.
    // `%USERPROFILE%\AppData\Local` is the documented default the
    // variable holds, so it is the fallback rather than a guess.
    if os == HostOs::Windows {
        if let Some(local) = local_app_data.filter(|l| !l.is_empty()) {
            return Ok(PathBuf::from(local).join("gavin"));
        }
        let profile = user_profile
            .filter(|p| !p.is_empty())
            .or(home)
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "neither LOCALAPPDATA nor USERPROFILE is set, so gavin has nowhere to keep its socket and databases"
                )
            })?;
        return Ok(PathBuf::from(profile).join("AppData").join("Local").join("gavin"));
    }
    // "If $XDG_DATA_HOME is either not set or empty, a default equal to
    // $HOME/.local/share should be used" -- and the spec also says a
    // relative value is invalid and must be ignored, which matters here
    // because a relative data dir would put the socket somewhere that
    // moves with the daemon's cwd.
    let xdg = xdg_data_home
        .filter(|x| !x.is_empty())
        .map(PathBuf::from)
        .filter(|x| xdg_path_is_absolute(x));
    if let Some(xdg) = xdg {
        return Ok(xdg.join("gavin"));
    }
    let home = home.ok_or_else(|| {
        anyhow::anyhow!("neither XDG_DATA_HOME nor HOME is set, so gavin has nowhere to keep its socket and databases")
    })?;
    Ok(PathBuf::from(home).join(".local").join("share").join("gavin"))
}

/// Whether an `XDG_DATA_HOME` value is absolute *by the spec's rule*,
/// which is POSIX's: a leading `/`.
///
/// Deliberately not `Path::is_absolute`. That answers for the OS running
/// this process, not the `HostOs` being asked about, and on Windows it
/// is false for `/data/gavin-home` because an absolute Windows path
/// needs a drive prefix. `resolve_app_support_dir` takes its OS as an
/// argument precisely so that the answer does not depend on who is
/// asking -- the doc comment there says so -- and a host-dependent
/// check reintroduced the dependency at the one place that reads a
/// path. The XDG branch is unreachable on Windows in production, the
/// Windows branch having returned already, so the only thing this ever
/// broke was the suite: three tests stating the Linux rule got the
/// `HOME` fallback instead of the data home and had been red on every
/// Windows run since the port.
fn xdg_path_is_absolute(path: &Path) -> bool {
    path.as_os_str().as_encoded_bytes().first() == Some(&b'/')
}

/// Every path gavin puts on the wire or into the UI uses forward
/// slashes.
///
/// The whole Windows path story, in one rule. Around forty frontend
/// modules take a path apart with `split("/")` or `lastIndexOf("/")` --
/// card paths, worktree paths, `.gavin*` relPaths, git status entries,
/// the file tree -- and rewriting each of them to accept either
/// separator would be forty chances to miss one. Windows accepts forward
/// slashes in every API gavin calls (and git prints them already), so
/// normalising once at the boundary costs one function and leaves those
/// forty correct.
///
/// **Only on Windows.** A backslash is a legal character in a unix file
/// name, and a file called `a\b` must not silently become the directory
/// `a/b`.
pub fn wire_path(path: &Path) -> String {
    normalize_separators(&path.to_string_lossy(), cfg!(windows))
}

/// `wire_path` for a path that is already a string.
pub fn wire_path_str(path: &str) -> String {
    normalize_separators(path, cfg!(windows))
}

/// The rule with the platform passed in, so it can be tested where the
/// suite runs.
pub fn normalize_separators(path: &str, windows: bool) -> String {
    if windows {
        path.replace('\\', "/")
    } else {
        path.to_string()
    }
}

/// `std::fs::canonicalize`, with the answer in the shape the rest of
/// gavin compares against.
///
/// Windows canonicalisation returns a VERBATIM path -- `\\?\C:\Users\x`,
/// or `\\?\UNC\server\share` for a network path. That prefix is not
/// cosmetic: it turns off path parsing in the OS, it is not what the
/// human's picker handed in, and every containment check gavin makes is
/// `starts_with` against a stored root. Mix one verbatim path with one
/// plain one and the file viewer refuses every file in the workspace.
/// So it is stripped here, once, rather than guarded against at each of
/// the eight call sites.
pub fn canonical_path(path: &Path) -> std::io::Result<PathBuf> {
    let canonical = std::fs::canonicalize(path)?;
    if !cfg!(windows) {
        return Ok(canonical);
    }
    Ok(PathBuf::from(strip_verbatim_prefix(&canonical.to_string_lossy())))
}

/// `\\?\C:\x` into `C:/x`, and `\\?\UNC\server\share` into
/// `//server/share`. Anything else is only separator-normalised.
///
/// A verbatim prefix in front of anything OTHER than a drive letter is
/// left alone: `\\?\Volume{...}` names a volume with no drive, and
/// removing its prefix would produce a path that resolves to something
/// else entirely rather than a tidier spelling of the same thing.
pub fn strip_verbatim_prefix(path: &str) -> String {
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        return format!("//{}", normalize_separators(rest, true));
    }
    if let Some(rest) = path.strip_prefix(r"\\?\") {
        let b = rest.as_bytes();
        let is_drive = b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':';
        if is_drive {
            return normalize_separators(rest, true);
        }
    }
    normalize_separators(path, true)
}

pub fn socket_path() -> anyhow::Result<PathBuf> {
    let path =
        app_support_dir()?.join(profile_file_name("daemon", "sock", BuildProfile::current()));
    // The name outlives the mechanism on purpose: on Windows this path
    // is never bound, it is hashed into a pipe name
    // (`transport::pipe_name_for_path`), so keeping one spelling of "the
    // endpoint" means every process still derives it the same way and
    // every test still gets its own from a tempdir.
    #[cfg(unix)]
    check_sun_path(&path)?;
    Ok(path)
}

/// Rejects a socket path the kernel would refuse, while there is still
/// something useful to say about it.
#[cfg_attr(not(unix), allow(dead_code))]
fn check_sun_path(path: &Path) -> anyhow::Result<()> {
    let len = path.as_os_str().as_encoded_bytes().len();
    if len > SUN_PATH_MAX {
        anyhow::bail!(
            "the daemon socket path is {len} bytes ({}), over the {SUN_PATH_MAX}-byte limit a unix socket address can hold -- point XDG_DATA_HOME at a shorter directory",
            path.display()
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    /// The band both clients sort a daemon into. Hoisted here from the
    /// app when gavin-mcp was brought into the same window, so a drift
    /// between the two -- an off-by-one on the floor, a forgotten
    /// `degraded` -- is not even expressible.
    #[test]
    fn the_three_bands_split_where_the_window_does() {
        assert_eq!(version_band(12, 12, 5), VersionBand::Usable { degraded: false });
        assert_eq!(version_band(9, 12, 5), VersionBand::Usable { degraded: true });
        // The floor is INSIDE the window; one below it is not.
        assert_eq!(version_band(5, 12, 5), VersionBand::Usable { degraded: true });
        assert_eq!(version_band(4, 12, 5), VersionBand::DaemonTooOld);
        assert_eq!(version_band(13, 12, 5), VersionBand::DaemonNewer);
    }

    /// Sweeps the gate against `min_version_for` over every daemon version
    /// in the real window: the predicate and the table must never disagree,
    /// for either client.
    /// v40: the three workspace-file requests the desktop sends for an
    /// ssh workspace (`2026-09-22-ssh-card-runs-design.md`) -- the card a
    /// run is composed from, the files agent integration writes, the
    /// attachments it classifies. New TYPES, so this match is the real
    /// wire gate: against a v39 host daemon the app refuses locally, and
    /// the Run pill names the version the host needs.
    #[test]
    fn workspace_file_requests_are_gated_at_40() {
        let read = Request::ReadWorkspaceFile { root_path: "/r".into(), path: "a.md".into() };
        let write = Request::WriteWorkspaceFile {
            root_path: "/r".into(),
            path: "a.md".into(),
            content: "x".into(),
        };
        let stat = Request::StatWorkspacePaths { root_path: "/r".into(), paths: vec!["a.md".into()] };
        for req in [&read, &write, &stat] {
            assert_eq!(min_version_for(req), 40);
            assert!(gate_request(req, 39).is_err());
            assert!(gate_request(req, 40).is_ok());
        }
    }

    /// v41: the Git tab and Files tree over ssh -- `RunGit` runs a git
    /// subcommand in a confined cwd on the host, `ListWorkspaceDir` lists
    /// a directory there. New TYPES, so this is the wire gate: a v40 host
    /// daemon answers `Unsupported`, the app refuses locally, and the tab
    /// says which version the host needs (`FEATURE_MIN_VERSION.sshGitFiles`).
    #[test]
    fn git_and_dir_requests_are_gated_at_41() {
        let run = Request::RunGit {
            root_path: "/r".into(),
            cwd: "/r".into(),
            args: vec!["status".into()],
            stdin: None,
        };
        let list = Request::ListWorkspaceDir { root_path: "/r".into(), path: "/r".into() };
        for req in [&run, &list] {
            assert_eq!(min_version_for(req), 41);
            assert!(gate_request(req, 40).is_err());
            assert!(gate_request(req, 41).is_ok());
        }
    }

    /// v42: the Decisions tab's two writes. New TYPES, so this match is
    /// the wire gate for them -- a v41 daemon never receives either.
    #[test]
    fn human_item_requests_are_gated_at_42() {
        assert_eq!(PROTOCOL_VERSION, 42);
        let file = Request::FileHumanItem {
            path: "/r/.gavin-root/plans/a.md".into(),
            kind: HumanItemKind::Test,
            text: "install on the other machine".into(),
            options: vec![],
        };
        let resolve = Request::ResolveHumanItem {
            path: "/r/.gavin-root/plans/a.md".into(),
            expected_text: "Human test: install on the other machine".into(),
            outcome: HumanItemOutcome::Fail { note: "the installer hung".into() },
        };
        for req in [&file, &resolve] {
            assert_eq!(min_version_for(req), 42);
            assert!(gate_request(req, 41).is_err());
            assert!(gate_request(req, 42).is_ok());
        }
    }

    /// The four outcomes are a tagged union on the wire, and the tag
    /// values are what the app's `backend.ts` wrapper types: a rename
    /// here is a silent break there, so they are pinned.
    #[test]
    fn human_item_outcomes_serialize_to_the_shape_the_app_sends() {
        let shape = |o: HumanItemOutcome| serde_json::to_value(o).unwrap();
        assert_eq!(
            shape(HumanItemOutcome::Answer { text: "serde".into() }),
            serde_json::json!({ "kind": "answer", "text": "serde" })
        );
        assert_eq!(shape(HumanItemOutcome::Pass), serde_json::json!({ "kind": "pass" }));
        assert_eq!(
            shape(HumanItemOutcome::Fail { note: "crashed".into() }),
            serde_json::json!({ "kind": "fail", "note": "crashed" })
        );
        assert_eq!(
            shape(HumanItemOutcome::FailAndClose { note: "not worth it".into() }),
            serde_json::json!({ "kind": "failAndClose", "note": "not worth it" })
        );
    }

    /// Both requests survive the line protocol whole -- a decision's
    /// options and a fail note are free text a human wrote, and the
    /// daemon has to receive them as written.
    #[test]
    fn human_item_requests_roundtrip_through_json_line() {
        let mut buf = Vec::new();
        write_message(&mut buf, &Request::FileHumanItem {
            path: "/r/.gavin-root/plans/a.md".to_string(),
            kind: HumanItemKind::Decision,
            text: "Which serializer?".to_string(),
            options: vec!["serde".to_string(), "by hand (no dep)".to_string()],
        })
        .unwrap();
        write_message(&mut buf, &Request::ResolveHumanItem {
            path: "/r/.gavin-root/plans/a.md".to_string(),
            expected_text: "Decision: Which serializer?".to_string(),
            outcome: HumanItemOutcome::Answer { text: "serde — one dep, already in".to_string() },
        })
        .unwrap();
        write_message(&mut buf, &Response::HumanItemFiled { rearmed: true }).unwrap();
        let mut cursor = Cursor::new(buf);
        match read_message::<_, Request>(&mut cursor).unwrap().unwrap() {
            Request::FileHumanItem { path, kind, text, options } => {
                assert_eq!(path, "/r/.gavin-root/plans/a.md");
                assert_eq!(kind, HumanItemKind::Decision);
                assert_eq!(text, "Which serializer?");
                assert_eq!(options, vec!["serde", "by hand (no dep)"]);
            }
            other => panic!("wrong variant: {other:?}"),
        }
        match read_message::<_, Request>(&mut cursor).unwrap().unwrap() {
            Request::ResolveHumanItem { expected_text, outcome, .. } => {
                assert_eq!(expected_text, "Decision: Which serializer?");
                assert_eq!(
                    outcome,
                    HumanItemOutcome::Answer { text: "serde — one dep, already in".to_string() }
                );
            }
            other => panic!("wrong variant: {other:?}"),
        }
        match read_message::<_, Response>(&mut cursor).unwrap().unwrap() {
            Response::HumanItemFiled { rearmed } => assert!(rearmed),
            other => panic!("wrong variant: {other:?}"),
        }
        // `options` is serde(default): a caller that omits it entirely --
        // gavin-mcp filing a test, which never has any -- still parses.
        let parsed: Request = serde_json::from_str(
            r#"{"type":"FileHumanItem","path":"/p/a.md","kind":"test","text":"check the installer"}"#,
        )
        .unwrap();
        match parsed {
            Request::FileHumanItem { kind, options, .. } => {
                assert_eq!(kind, HumanItemKind::Test);
                assert!(options.is_empty());
            }
            other => panic!("wrong variant: {other:?}"),
        }
    }

    /// The reason `human_items` is an `Option<Vec<_>>` and not the
    /// `serde(default)` `Vec` every other added field on `PlanFileInfo`
    /// is. The tree crosses the Tauri host, which deserializes and
    /// re-serializes it; a defaulted Vec would make an older daemon's
    /// silence indistinguishable from a card with nothing waiting, and
    /// the tab would report "nothing needs you" for a whole workspace.
    #[test]
    fn a_pre_v42_daemons_card_reads_back_as_unknown_not_as_no_items() {
        let older: PlanFileInfo = serde_json::from_value(serde_json::json!({
            "path": "/p/a.md",
            "fileName": "a.md",
            "title": "a",
            "status": null,
            "priority": null,
            "order": null,
            "kind": "plan",
            "parent": null,
            "labels": [],
            "checklistDone": 0,
            "checklistTotal": 0,
            "parseWarning": false
        }))
        .unwrap();
        assert_eq!(older.human_items, None);
        // And it stays None through the round trip the host performs.
        let relayed: PlanFileInfo =
            serde_json::from_value(serde_json::to_value(&older).unwrap()).unwrap();
        assert_eq!(relayed.human_items, None);
        assert_eq!(
            serde_json::to_value(&older).unwrap().get("humanItems"),
            Some(&serde_json::Value::Null)
        );
    }

    #[test]
    fn the_gate_admits_exactly_what_the_table_says_it_should() {
        for daemon in MIN_COMPATIBLE_VERSION..=PROTOCOL_VERSION {
            for req in one_of_every_request_variant() {
                let needed = min_version_for(&req);
                let verdict = gate_request(&req, daemon);
                assert_eq!(
                    verdict.is_ok(),
                    needed <= daemon,
                    "{req:?} needs v{needed}; a v{daemon} daemon should {} it, got {verdict:?}",
                    if needed <= daemon { "accept" } else { "refuse" }
                );
                if let Err(gated) = verdict {
                    // Both numbers, because a message with only one of them
                    // leaves the reader unable to tell what to do about it.
                    assert_eq!(gated.needed, needed);
                    assert_eq!(gated.daemon, daemon);
                    let text = gated.to_string();
                    assert!(text.contains(&format!("v{needed}")), "{text}");
                    assert!(text.contains(&format!("v{daemon}")), "{text}");
                }
            }
        }
    }

    /// `Unknown` is never sent, and `u32::MAX` is what keeps it that way if
    /// it ever reaches a send path.
    #[test]
    fn the_unknown_variant_is_refused_by_every_daemon() {
        assert!(gate_request(&Request::Unknown, u32::MAX - 1).is_err());
    }

    /// The hand-rolled HMAC has to match a real one, or `server_proof`
    /// proves nothing. RFC 4231 test case 1: key = 0x0b × 20, data =
    /// "Hi There".
    #[test]
    fn hmac_sha256_matches_the_rfc_4231_vector() {
        let key = [0x0bu8; 20];
        assert_eq!(
            hmac_sha256_hex(&key, b"Hi There"),
            "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7"
        );
    }

    /// A key longer than the 64-byte block is hashed first (RFC 4231
    /// test case 6), which is the branch a 64-hex-char daemon token
    /// actually exercises.
    #[test]
    fn hmac_sha256_handles_an_over_block_key() {
        let key = [0xaau8; 131];
        assert_eq!(
            hmac_sha256_hex(&key, b"Test Using Larger Than Block-Size Key - Hash Key First"),
            "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54"
        );
    }

    /// The proof binds to the nonce: the same token over two nonces
    /// gives two proofs, so a captured proof can't be replayed onto a
    /// fresh connection.
    #[test]
    fn server_proof_is_deterministic_and_nonce_bound() {
        assert_eq!(server_proof("tok", "n1"), server_proof("tok", "n1"));
        assert_ne!(server_proof("tok", "n1"), server_proof("tok", "n2"));
        assert_ne!(server_proof("tokA", "n1"), server_proof("tokB", "n1"));
    }

    /// A hashed token is not the token, and equal tokens hash equal.
    #[test]
    fn hash_token_is_stable_and_hides_the_token() {
        let t = "s3cr3t-session-token";
        assert_eq!(hash_token_hex(t), hash_token_hex(t));
        assert_ne!(hash_token_hex(t), t);
        assert_eq!(hash_token_hex(t).len(), 64);
    }

    /// The auth block reads on the wire exactly as the design sketch says.
    #[test]
    fn hello_auth_serializes_as_kebab_tagged() {
        let v = serde_json::to_value(HelloAuth::SessionToken { token: "x".into() }).unwrap();
        assert_eq!(v, serde_json::json!({"kind": "session-token", "token": "x"}));
        let n = serde_json::to_value(HelloAuth::None).unwrap();
        assert_eq!(n, serde_json::json!({"kind": "none"}));
    }

    /// An older daemon's HelloAck has no `workspace_root`; a newer client
    /// must still parse it and treat the absence as "fall back to the
    /// cwd walk". The field must never become one a tool requires.
    #[test]
    fn hello_ack_without_workspace_root_still_deserializes() {
        let line = r#"{"type":"HelloAck","role":"agent","daemon_version":35,"session_id":"s1","server_proof":null}"#;
        let parsed: Response = serde_json::from_str(line).unwrap();
        match parsed {
            Response::HelloAck { workspace_root, session_id, .. } => {
                assert_eq!(workspace_root, None);
                assert_eq!(session_id.as_deref(), Some("s1"));
            }
            other => panic!("expected HelloAck, got {other:?}"),
        }
    }

    #[test]
    fn request_roundtrips_through_json_line() {
        let mut buf = Vec::new();
        let req = Request::CreateSession {
            workspace_path: "/tmp/ws".to_string(),
            cwd: "/tmp/ws".to_string(),
            command: None,
        };
        write_message(&mut buf, &req).unwrap();

        let mut cursor = Cursor::new(buf);
        let decoded: Request = read_message(&mut cursor).unwrap().unwrap();

        match decoded {
            Request::CreateSession { workspace_path, cwd, command } => {
                assert_eq!(workspace_path, "/tmp/ws");
                assert_eq!(cwd, "/tmp/ws");
                assert_eq!(command, None);
            }
            other => panic!("wrong variant: {other:?}"),
        }
    }

    #[test]
    fn response_roundtrips_through_json_line() {
        let mut buf = Vec::new();
        let resp = Response::Output {
            id: "s1".to_string(),
            data: "hello\n".to_string(),
        };
        write_message(&mut buf, &resp).unwrap();

        let mut cursor = Cursor::new(buf);
        let decoded: Response = read_message(&mut cursor).unwrap().unwrap();

        match decoded {
            Response::Output { id, data } => {
                assert_eq!(id, "s1");
                assert_eq!(data, "hello\n");
            }
            other => panic!("wrong variant: {other:?}"),
        }
    }

    #[test]
    fn read_message_returns_none_at_eof() {
        let mut cursor = Cursor::new(Vec::<u8>::new());
        let decoded: Option<Request> = read_message(&mut cursor).unwrap();
        assert!(decoded.is_none());
    }

    #[test]
    fn two_messages_on_same_stream_read_independently() {
        let mut buf = Vec::new();
        write_message(&mut buf, &Request::ListSessions).unwrap();
        write_message(&mut buf, &Request::KillSession { id: "s1".to_string() }).unwrap();

        let mut cursor = Cursor::new(buf);
        let first: Request = read_message(&mut cursor).unwrap().unwrap();
        let second: Request = read_message(&mut cursor).unwrap().unwrap();

        assert!(matches!(first, Request::ListSessions));
        assert!(matches!(second, Request::KillSession { .. }));
    }

    #[test]
    fn cwd_changed_response_roundtrips_through_json_line() {
        let mut buf = Vec::new();
        let resp = Response::CwdChanged {
            id: "s1".to_string(),
            cwd: "/Users/alice/project".to_string(),
        };
        write_message(&mut buf, &resp).unwrap();

        let mut cursor = Cursor::new(buf);
        let decoded: Response = read_message(&mut cursor).unwrap().unwrap();

        match decoded {
            Response::CwdChanged { id, cwd } => {
                assert_eq!(id, "s1");
                assert_eq!(cwd, "/Users/alice/project");
            }
            other => panic!("wrong variant: {other:?}"),
        }
    }

    #[test]
    fn status_changed_response_roundtrips_through_json_line() {
        let mut buf = Vec::new();
        let resp = Response::StatusChanged {
            id: "s1".to_string(),
            status: "working".to_string(),
        };
        write_message(&mut buf, &resp).unwrap();

        let mut cursor = Cursor::new(buf);
        let decoded: Response = read_message(&mut cursor).unwrap().unwrap();

        match decoded {
            Response::StatusChanged { id, status } => {
                assert_eq!(id, "s1");
                assert_eq!(status, "working");
            }
            other => panic!("wrong variant: {other:?}"),
        }
    }

    #[test]
    fn git_status_serializes_to_the_camel_case_shape_the_frontend_expects() {
        let status = GitStatus {
            repo_root: "/Users/alice/project".to_string(),
            branch: "main".to_string(),
            dirty: true,
            ahead: 2,
            behind: 0,
            has_upstream: true,
        };
        let json = serde_json::to_value(&status).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "repoRoot": "/Users/alice/project",
                "branch": "main",
                "dirty": true,
                "ahead": 2,
                "behind": 0,
                "hasUpstream": true
            })
        );
    }

    #[test]
    fn git_status_changed_response_roundtrips_through_json_line() {
        let mut buf = Vec::new();
        let resp = Response::GitStatusChanged {
            id: "s1".to_string(),
            status: Some(GitStatus {
                repo_root: "/tmp/repo".to_string(),
                branch: "main".to_string(),
                dirty: false,
                ahead: 0,
                behind: 0,
                has_upstream: false,
            }),
        };
        write_message(&mut buf, &resp).unwrap();

        let mut cursor = Cursor::new(buf);
        let decoded: Response = read_message(&mut cursor).unwrap().unwrap();

        match decoded {
            Response::GitStatusChanged { id, status } => {
                assert_eq!(id, "s1");
                let status = status.unwrap();
                assert_eq!(status.repo_root, "/tmp/repo");
                assert_eq!(status.branch, "main");
                assert_eq!(status.dirty, false);
            }
            other => panic!("wrong variant: {other:?}"),
        }
    }

    #[test]
    fn session_restored_response_roundtrips_through_json_line() {
        let mut buf = Vec::new();
        let resp = Response::SessionRestored { id: "s1".to_string() };
        write_message(&mut buf, &resp).unwrap();

        let mut cursor = Cursor::new(buf);
        let decoded: Response = read_message(&mut cursor).unwrap().unwrap();

        match decoded {
            Response::SessionRestored { id } => {
                assert_eq!(id, "s1");
            }
            other => panic!("wrong variant: {other:?}"),
        }
    }

    #[test]
    fn git_status_changed_response_roundtrips_with_none_status() {
        let mut buf = Vec::new();
        let resp = Response::GitStatusChanged { id: "s1".to_string(), status: None };
        write_message(&mut buf, &resp).unwrap();

        let mut cursor = Cursor::new(buf);
        let decoded: Response = read_message(&mut cursor).unwrap().unwrap();

        match decoded {
            Response::GitStatusChanged { id, status } => {
                assert_eq!(id, "s1");
                assert_eq!(status, None);
            }
            other => panic!("wrong variant: {other:?}"),
        }
    }

    #[test]
    fn get_board_request_roundtrips_through_json_line() {
        let mut buf = Vec::new();
        let req = Request::GetBoard { workspace_id: "ws-1".to_string() };
        write_message(&mut buf, &req).unwrap();

        let mut cursor = Cursor::new(buf);
        let decoded: Request = read_message(&mut cursor).unwrap().unwrap();

        match decoded {
            Request::GetBoard { workspace_id } => assert_eq!(workspace_id, "ws-1"),
            other => panic!("wrong variant: {other:?}"),
        }
    }

    #[test]
    fn set_board_request_roundtrips_through_json_line() {
        let mut buf = Vec::new();
        let req = Request::SetBoard {
            workspace_id: "ws-1".to_string(),
            columns: vec![Column {
                id: "col-1".to_string(),
                name: "To Do".to_string(),
                position: 0,
            }],
            labels: vec![Label {
                id: "label-1".to_string(),
                name: "urgent".to_string(),
                color: "#ff0000".to_string(),
            }],
        };
        write_message(&mut buf, &req).unwrap();

        let mut cursor = Cursor::new(buf);
        let decoded: Request = read_message(&mut cursor).unwrap().unwrap();

        match decoded {
            Request::SetBoard { workspace_id, columns, labels } => {
                assert_eq!(workspace_id, "ws-1");
                assert_eq!(columns.len(), 1);
                assert_eq!(columns[0].name, "To Do");
                assert_eq!(labels.len(), 1);
            }
            other => panic!("wrong variant: {other:?}"),
        }
    }

    #[test]
    fn delete_board_request_roundtrips_through_json_line() {
        let mut buf = Vec::new();
        let req = Request::DeleteBoard { workspace_id: "ws-1".to_string() };
        write_message(&mut buf, &req).unwrap();

        let mut cursor = Cursor::new(buf);
        let decoded: Request = read_message(&mut cursor).unwrap().unwrap();

        match decoded {
            Request::DeleteBoard { workspace_id } => assert_eq!(workspace_id, "ws-1"),
            other => panic!("wrong variant: {other:?}"),
        }
    }

    #[test]
    fn board_response_roundtrips_through_json_line() {
        let mut buf = Vec::new();
        let resp = Response::Board {
            columns: vec![Column {
                id: "col-1".to_string(),
                name: "Done".to_string(),
                position: 0,
            }],
            labels: vec![],
            card_sessions: vec![],
        };
        write_message(&mut buf, &resp).unwrap();

        let mut cursor = Cursor::new(buf);
        let decoded: Response = read_message(&mut cursor).unwrap().unwrap();

        match decoded {
            Response::Board { columns, labels, card_sessions: _ } => {
                assert_eq!(columns.len(), 1);
                assert_eq!(columns[0].name, "Done");
                assert_eq!(labels.len(), 0);
            }
            other => panic!("wrong variant: {other:?}"),
        }
    }

    #[test]
    fn card_kind_serializes_to_lowercase_strings() {
        assert_eq!(serde_json::to_value(CardKind::Note).unwrap(), serde_json::json!("note"));
        assert_eq!(serde_json::to_value(CardKind::Task).unwrap(), serde_json::json!("task"));
        assert_eq!(serde_json::to_value(CardKind::Plan).unwrap(), serde_json::json!("plan"));
    }

    #[test]
    fn priority_serializes_to_lowercase_strings() {
        assert_eq!(serde_json::to_value(Priority::None).unwrap(), serde_json::json!("none"));
        assert_eq!(serde_json::to_value(Priority::Low).unwrap(), serde_json::json!("low"));
        assert_eq!(serde_json::to_value(Priority::Medium).unwrap(), serde_json::json!("medium"));
        assert_eq!(serde_json::to_value(Priority::High).unwrap(), serde_json::json!("high"));
        assert_eq!(serde_json::to_value(Priority::Urgent).unwrap(), serde_json::json!("urgent"));
    }

    #[test]
    fn priority_as_str_and_from_str_round_trip_every_variant() {
        for p in [Priority::None, Priority::Low, Priority::Medium, Priority::High, Priority::Urgent] {
            assert_eq!(Priority::from_str(p.as_str()), p);
        }
    }

    #[test]
    fn priority_from_str_defaults_to_none_for_an_unrecognized_value() {
        assert_eq!(Priority::from_str("not-a-real-priority"), Priority::None);
    }

    /// The opposite posture to `Priority::from_str` above, and the
    /// difference is the point: an unreadable priority is cosmetic, an
    /// unreadable complexity would pick somebody an agent.
    #[test]
    fn complexity_parse_refuses_an_unrecognized_value_rather_than_guessing() {
        assert_eq!(Complexity::parse("not-a-real-level"), None);
        assert_eq!(Complexity::parse(""), None);
        assert_eq!(Complexity::parse("  Complex  "), Some(Complexity::Complex));
        assert_eq!(Complexity::parse("INTRICATE"), Some(Complexity::Intricate));
    }

    /// `ALL` is what every picker and settings table iterates, so it has
    /// to be the whole enum in ascending order -- a level missing here is
    /// a level nothing can ever be set to.
    #[test]
    fn every_complexity_level_round_trips_through_its_written_name() {
        assert_eq!(Complexity::ALL.len(), 5);
        for level in Complexity::ALL {
            assert_eq!(Complexity::parse(level.as_str()), Some(level));
        }
        assert_eq!(
            Complexity::ALL.map(|c| c.as_str()),
            ["trivial", "simple", "moderate", "complex", "intricate"]
        );
    }

    fn sample_tree() -> GavinTree {
        GavinTree {
            root_path: "/tmp/ws".to_string(),
            root_missing: false,
            contexts: vec![GavinContext {
                folder_path: "/tmp/ws".to_string(),
                kind: GavinContextKind::Root,
                name: "ws".to_string(),
                plans: vec![PlanFileInfo {
                    path: "/tmp/ws/.gavin-root/plans/a.md".to_string(),
                    file_name: "a.md".to_string(),
                    title: "a".to_string(),
                    status: Some("To Do".to_string()),
                    priority: Some(Priority::High),
                    order: None,
                    kind: CardKind::Plan,
                    parent: None,
                    labels: vec![],
                    checklist_done: 0,
                    checklist_total: 0,
                    parse_warning: false,
                    modified_at: None,
                    attachments: vec!["docs/spec.md".to_string()],
                    complexity: Some(Complexity::Moderate),
                    agent: Some("codex".to_string()),
                    model: Some("gpt-5.1".to_string()),
                    human_items: Some(vec![HumanItem {
                        kind: HumanItemKind::Decision,
                        text: "Which serializer?".to_string(),
                        done: false,
                        options: vec!["serde".to_string(), "by hand".to_string()],
                        latest: None,
                        state: HumanItemState::Open,
                        line_text: "Decision: Which serializer?".to_string(),
                        line_index: 7,
                    }]),
                }],
                docs: vec![MdFileInfo {
                    path: "/tmp/ws/.gavin-root/docs/notes.md".to_string(),
                    rel_path: "notes.md".to_string(),
                }],
                specs: vec![],
                has_prd: true,
                outside: false,
                config_warning: false,
                agent: None,
                prd: None,
            }],
        }
    }

    #[test]
    fn gavin_tree_serializes_to_the_camel_case_shape_the_frontend_expects() {
        let json = serde_json::to_value(sample_tree()).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "rootPath": "/tmp/ws",
                "rootMissing": false,
                "contexts": [{
                    "folderPath": "/tmp/ws",
                    "kind": "root",
                    "name": "ws",
                    "plans": [{
                        "path": "/tmp/ws/.gavin-root/plans/a.md",
                        "fileName": "a.md",
                        "title": "a",
                        "status": "To Do",
                        "priority": "high",
                        "order": null,
                        "kind": "plan",
                        "parent": null,
                        "labels": [],
                        "checklistDone": 0,
                        "checklistTotal": 0,
                        "parseWarning": false,
                        "modifiedAt": null,
                        "attachments": ["docs/spec.md"],
                        "complexity": "moderate",
                        "agent": "codex",
                        "model": "gpt-5.1",
                        "humanItems": [{
                            "kind": "decision",
                            "text": "Which serializer?",
                            "done": false,
                            "options": ["serde", "by hand"],
                            "latest": null,
                            "state": "open",
                            "lineText": "Decision: Which serializer?",
                            "lineIndex": 7
                        }]
                    }],
                    "docs": [{ "path": "/tmp/ws/.gavin-root/docs/notes.md", "relPath": "notes.md" }],
                    "specs": [],
                    "hasPrd": true,
                    "configWarning": false,
                    "agent": null,
                    "outside": false,
                    "prd": null
                }]
            })
        );
    }

    #[test]
    fn usable_attachment_path_keeps_absolutes_and_refuses_traversal() {
        // Relative stays relative -- resolving it against the workspace
        // root is the caller's job, not this function's.
        assert_eq!(usable_attachment_path("docs/spec.md"), Some("docs/spec.md".to_string()));
        assert_eq!(usable_attachment_path("  README.md  "), Some("README.md".to_string()));
        // Absolute is kept as-is: the useful attachments are routinely
        // outside the repo, which is the whole difference from
        // usable_prd_path.
        assert_eq!(
            usable_attachment_path("/Users/x/Desktop/shot.png"),
            Some("/Users/x/Desktop/shot.png".to_string())
        );
        // Junk.
        assert_eq!(usable_attachment_path(""), None);
        assert_eq!(usable_attachment_path("   "), None);
        assert_eq!(usable_attachment_path("../outside/spec.md"), None);
        assert_eq!(usable_attachment_path("docs/../../spec.md"), None);
        assert_eq!(usable_attachment_path("/Users/x/../../etc/passwd"), None);
        // `.` is harmless here, unlike in usable_prd_path: nothing
        // compares these strings for equality, so "./a.md" resolving to
        // the same file as "a.md" costs nothing.
        assert_eq!(usable_attachment_path("./a.md"), Some("./a.md".to_string()));
    }

    #[test]
    fn usable_prd_path_accepts_a_subpath_and_refuses_an_escape() {
        // A subpath is the whole point: an existing project's PRD is
        // usually `docs/PRD.md`, not something gavin scaffolded.
        assert_eq!(usable_prd_path("docs/PRD.md"), Some("docs/PRD.md".to_string()));
        assert_eq!(usable_prd_path("  PRD.md  "), Some("PRD.md".to_string()));
        assert_eq!(usable_prd_path(DEFAULT_PRD_PATH), Some(DEFAULT_PRD_PATH.to_string()));

        assert_eq!(usable_prd_path(""), None);
        assert_eq!(usable_prd_path("   "), None);
        assert_eq!(usable_prd_path("/etc/passwd"), None);
        assert_eq!(usable_prd_path("../outside/PRD.md"), None);
        assert_eq!(usable_prd_path("docs/../../PRD.md"), None);
        // Not an escape, but refused all the same: the components check
        // takes only Normal, and nothing that produces this value (the
        // picker resolves against the root) can emit a `.` segment.
        assert_eq!(usable_prd_path("./PRD.md"), None);
    }

    #[test]
    fn watch_gavin_root_request_roundtrips_through_json_line() {
        let mut buf = Vec::new();
        let req = Request::WatchGavinRoot {
            workspace_id: "ws-1".to_string(),
            root_path: "/tmp/ws".to_string(),
        };
        write_message(&mut buf, &req).unwrap();
        let mut cursor = Cursor::new(buf);
        let decoded: Request = read_message(&mut cursor).unwrap().unwrap();
        match decoded {
            Request::WatchGavinRoot { workspace_id, root_path } => {
                assert_eq!(workspace_id, "ws-1");
                assert_eq!(root_path, "/tmp/ws");
            }
            other => panic!("wrong variant: {other:?}"),
        }
    }

    #[test]
    fn init_gavin_root_request_roundtrips_through_json_line() {
        let mut buf = Vec::new();
        let req = Request::InitGavinRoot {
            root_path: "/tmp/ws".to_string(),
            workspace_name: "My Workspace".to_string(),
        };
        write_message(&mut buf, &req).unwrap();
        let mut cursor = Cursor::new(buf);
        let decoded: Request = read_message(&mut cursor).unwrap().unwrap();
        match decoded {
            Request::InitGavinRoot { root_path, workspace_name } => {
                assert_eq!(root_path, "/tmp/ws");
                assert_eq!(workspace_name, "My Workspace");
            }
            other => panic!("wrong variant: {other:?}"),
        }
    }

    #[test]
    fn set_plan_frontmatter_field_request_roundtrips_through_json_line() {
        let mut buf = Vec::new();
        let req = Request::SetPlanFrontmatterField {
            path: "/tmp/ws/.gavin-root/plans/a.md".to_string(),
            key: "status".to_string(),
            value: "In Progress".to_string(),
        };
        write_message(&mut buf, &req).unwrap();
        let mut cursor = Cursor::new(buf);
        let decoded: Request = read_message(&mut cursor).unwrap().unwrap();
        match decoded {
            Request::SetPlanFrontmatterField { path, key, value } => {
                assert_eq!(path, "/tmp/ws/.gavin-root/plans/a.md");
                assert_eq!(key, "status");
                assert_eq!(value, "In Progress");
            }
            other => panic!("wrong variant: {other:?}"),
        }
    }

    #[test]
    fn agent_config_serializes_to_the_camel_case_shape_the_frontend_expects() {
        let ctx = GavinContext {
            folder_path: "/ws".to_string(),
            kind: GavinContextKind::Root,
            name: "ws".to_string(),
            plans: vec![],
            docs: vec![],
            specs: vec![],
            has_prd: false,
            config_warning: false,
            agent: Some(AgentConfig {
                profile: Some("claude-code".to_string()),
                file: None,
                command: Some("claude --model opus".to_string()),
                mcp_file: None,
                mcp_format: None,
                model: Some("sonnet".to_string()),
                model_flag: None,
            }),
            outside: false,
            prd: Some("docs/PRD.md".to_string()),
        };
        let json = serde_json::to_value(&ctx).unwrap();
        // The lead document's path rides beside the agent block, not
        // inside it -- the frontend reads it off the context.
        assert_eq!(json["prd"], serde_json::json!("docs/PRD.md"));
        assert_eq!(
            json["agent"],
            serde_json::json!({
                "profile": "claude-code",
                "file": null,
                "command": "claude --model opus",
                "mcpFile": null,
                "mcpFormat": null,
                "model": "sonnet",
                "modelFlag": null
            })
        );
    }

    #[test]
    fn set_root_config_field_request_roundtrips_through_json_line() {
        let mut buf = Vec::new();
        let req = Request::SetRootConfigField {
            root_path: "/ws".to_string(),
            key: "profile".to_string(),
            value: "codex".to_string(),
        };
        write_message(&mut buf, &req).unwrap();
        let mut cursor = Cursor::new(buf);
        let decoded: Request = read_message(&mut cursor).unwrap().unwrap();
        match decoded {
            Request::SetRootConfigField { root_path, key, value } => {
                assert_eq!(root_path, "/ws");
                assert_eq!(key, "profile");
                assert_eq!(value, "codex");
            }
            other => panic!("wrong variant: {other:?}"),
        }
    }

    #[test]
    fn protocol_version_is_twelve_until_a_breaking_change_bumps_it() {
        // v38: NameSession.agent_conversation_id -- an agent self-
        // reporting its CLI's own conversation id once it exists (codex,
        // gemini, opencode). serde(default) and no new variant, so
        // min_version_for cannot see it, but no daemonCompat.ts entry is
        // owed either: gavin-mcp is the only producer and it already
        // fails closed on any protocol mismatch, stricter than the app's
        // own compat window.
        // v37: SaveToolByRoot + DeleteToolByRoot + the ToolsChanged
        // push -- an agent authoring its OWN workspace's tools. Two new
        // request TYPES, so min_version_for really is the whole gate and
        // no daemonCompat.ts entry is owed (the app sends neither). The
        // scope guard is not a version at all: the daemon stamps the
        // watched workspace's id over the payload and refuses a
        // `builtin:` id, a global row and another workspace's row.
        // v36: Rail.trigger -- a rail's own start condition, so a rail can
        // wait for the others to finish instead of being armed by a step
        // on whichever rail happens to run last. serde(default) and no
        // new variant, which is the v16 `Rail.branch` shape exactly: a
        // v35 daemon takes SetOrchestration, drops the trigger and hands
        // the rail back with none, so daemonCompat.ts's `railTrigger` is
        // the only gate there is and the bind dialog's Trigger panel is
        // its consumer. 36 rather than 35 because Hello took 35 on
        // another branch -- see PROTOCOL_VERSION's own comment.
        // v34: DeleteCardFile now removes the card's run history and
        // every rail step aimed at it, not just its session bindings.
        // Neither a new variant nor a widened payload -- a change to
        // what an existing request DOES, which this match cannot see in
        // principle -- so daemonCompat.ts's `cardPurge` is its only
        // gate, and its consumer is the delete confirmation's copy.
        // v33: ToolDef.icon -- a tool's own glyph, named from the app's
        // icon library, drawn in place of the one its kind imposes. No
        // new variant: it widens SaveTool's payload exactly as `cwd` did
        // at v30, so this match is blind to it and daemonCompat.ts's
        // `toolIcon` is its only gate. A v32 daemon takes the save and
        // drops the icon, handing the tool back wearing its kind's glyph.
        // v32: a card's OWN agent -- PlanFileInfo.agent/model, and the
        // ninth and tenth SetPlanFrontmatterField keys. Neither is a new
        // variant, and both fields are serde(default), so this match is
        // structurally blind to the whole change: daemonCompat.ts's
        // `cardAgent` is its only gate, and it has to cover the READ as
        // well as the write -- a v31 daemon never parses the two lines,
        // so a card that already carries an override reads back as
        // carrying none and runs at the workspace's default.
        // v31: a card's `complexity:` (PlanFileInfo.complexity, an eighth
        // SetPlanFrontmatterField key, CreatePlan.complexity) and the
        // root config's `[agent] model_flag` (AgentConfig.model_flag, a
        // seventh SetRootConfigField key). No new variant on either half,
        // which is exactly why daemonCompat.ts owes `complexity` and
        // `agentModelFlag` entries with real consumers.
        // v26: the follow-up queue -- Request::QueueInput,
        // ListQueuedInputs, SetQueuedInputs and SendQueuedInput, plus
        // Response::QueuedInputs and the QueuedInputsChanged push. Four
        // new request TYPES and nothing widened, so min_version_for is
        // the whole WIRE gate; daemonCompat.ts's `queuedFollowUps` is
        // owed anyway, because a compose box that accepts a message and
        // never delivers it is worse than one that is greyed out.
        // v23: Request::SessionProcesses -- one sample of what every
        // live session costs, for the task manager. A new request TYPE,
        // so min_version_for is the real gate; daemonCompat.ts mirrors it
        // only so the panel can say why its columns are empty.
        // v22: recovery PROBES the process a killed session named rather
        // than inferring from the epoch that it must be gone.
        // Request::EndOrphan is a new variant this match does gate; the
        // reporting half (SessionSummary.orphan, the SessionOrphaned
        // push) is not, and it is worse than the usual silent drop --
        // `orphan: None` from a v21 daemon means "never looked", not "no
        // orphan", so daemonCompat.ts's `orphanDetection` is what keeps
        // the app from asserting a clean stop nobody measured.
        // v21: Request::ClaimCardForSession -- an agent binding the card
        // it just put In Progress to its own session. A new request
        // TYPE, so min_version_for is the whole gate and daemonCompat.ts
        // owes it nothing: the app never sends it.
        // v20: the recovery epoch -- SessionRecord.generation, the
        // `interrupted` flag, SessionSummary.interrupted and the
        // SessionInterrupted push. No new Request variant; the field is
        // serde(default), so a v19 daemon's SessionList still parses.
        // v19: card attachments -- PlanFileInfo.attachments, a seventh
        // SetPlanFrontmatterField key, and CreatePlan.attachments. No
        // new variant, which is exactly why daemonCompat.ts owes it a
        // FEATURE_MIN_VERSION entry with real consumers.
        // v30: ToolRun + StartToolRun / SetToolRunOutcome / ToolRuns --
        // a library tool run STANDALONE from the Tools tab, remembered
        // by the daemon so a failure nobody watched survives a restart.
        // Three new request TYPES, which min_version_for does gate; the
        // same version also widens SaveTool's ToolDef with `cwd`, which
        // it cannot see -- daemonCompat.ts owes `toolRuns` and `toolCwd`.
        // v27: CardRun + Request::CardRuns -- a card's run history, kept
        // by the daemon off the links and exits it already sees. A new
        // request TYPE, so this match IS its gate; daemonCompat.ts's
        // `runHistory` exists only so an empty panel can name the reason.
        // v26: CardSession.base_sha and the widened LinkCardSession --
        // the commit a card run started on, which is what the Changes
        // view diffs against and what "discard this run" resets to. No
        // new variant: another widening this match cannot see, so
        // daemonCompat.ts's `runChanges` is its only gate.
        // v21: Request::SetFailurePatterns -- the agent profile's own
        // error text, matched against the daemon's RENDERED screen so a
        // broken agent stops reading as a finished one. A new request
        // TYPE, so min_version_for is the whole gate for it. v21 also
        // widened SetStepRun and LinkCardSession with conversation_id /
        // launch_cwd (conversation resume), which this match structurally
        // cannot see -- daemonCompat.ts's `conversationResume` is that
        // half's only gate. SessionStatus gained `failed`, and
        // SessionSummary a `failure_reason`, both serde-tolerant.
        // v18: Request::Snapshot -- "send me this session's screen
        // again", answered from the daemon's per-session terminal
        // parser. A new request TYPE, which is what min_version_for
        // actually gates, so unlike v15/v16/v17 below it owes
        // v28: SetRailRunByRoot -- arming a rail from gavin-mcp. A new
        // request TYPE, so min_version_for is the entire gate and
        // daemonCompat.ts nothing.
        // v17: a top-level `prd` in the root config -- a sixth key name
        // SetRootConfigField accepts, plus GavinContext.prd. The key
        // widens an EXISTING request, so min_version_for is blind to it
        // and daemonCompat.ts's `prdPath` is the only gate; the field is
        // serde(default), so a v16 daemon's tree still parses.
        // v16: Rail.branch (spec O15), serde(default), so no Request
        // variant changed -- which is exactly why it also needs a
        // `railBranch` entry in app/src/lib/daemonCompat.ts: a v15
        // daemon parses SetOrchestration happily and drops the field,
        // and min_version_for gates request TYPES, not their payloads.
        // v15: Stage.mode/name (grouping spec G1), both serde(default),
        // so no Request variant changed.
        // v12: Request::Unknown (tolerant parsing of a future request
        // type) + Request::Shutdown.
        // v11: the tool library -- ToolDef, Step.tool_id/tool_params,
        // and Get/Save/DeleteTool + GetToolsByRoot. A v10 daemon answers
        // none of those. This branch reserved v11 for that work while it
        // was still an uncommitted merge, and took 12 for itself; both
        // have now landed, so the reservation did its job.
        // v10: PlanFieldSet carries the path a frontmatter write landed
        // on, because a status write can archive the card into
        // `plans/done/`.
        // v9: NameSession + the SessionNamed push (an agent naming its
        // own tab). A pre-v9 daemon cannot parse the request at all.
        // v8: GavinContext.outside + Add/RemoveExternalGavinContext
        // (outside-workspace contexts) + docs/specs deletion guard.
        // v35: Request::Hello + Response::HelloAck/Forbidden -- client
        // identity on the local socket. A new request TYPE, so a pre-v35
        // daemon answers Unsupported and every client reads "no identity
        // yet"; nothing is silently dropped. The same version also widened
        // Rail with `trigger`, which is a field and so invisible here.
        // v39: Request::SessionScreen + Response::SessionScreen -- the
        // rendered screen as plain text, for the TypeSafe turn verdict.
        // A new request TYPE, so a pre-v39 daemon never receives it; the
        // app skips the verdict rather than judging an empty screen.
        // v40: Read/WriteWorkspaceFile + StatWorkspacePaths -- the file
        // access a desktop needs from a daemon on another machine (ssh
        // workspaces) to compose a card run there and write the
        // agent-integration files where the agent runs. Three new TYPES.
        // v41: RunGit + ListWorkspaceDir -- the Git tab and Files tree
        // over ssh. Two new TYPES.
        // v42: FileHumanItem + ResolveHumanItem -- the Decisions tab's
        // two writes, filing a `Decision:`/`Human test:` line on a card
        // and writing the human's answer under it. Two new TYPES, which
        // min_version_for does gate. The same version widens
        // PlanFileInfo with `human_items`, which it cannot see -- that
        // half is an Option rather than a defaulted Vec precisely so the
        // absence survives the Tauri host's round trip as "unknown", and
        // the tab owes it a FEATURE_MIN_VERSION entry with a real
        // consumer (decisions-tab-view.md).
        assert_eq!(PROTOCOL_VERSION, 42);
    }

    #[test]
    fn an_unrecognised_request_type_parses_as_unknown_instead_of_erroring() {
        // The whole point: a future request must not be a parse error, because
        // handle_connection turns a parse error into a closed connection.
        let line = r#"{"type":"SomeFutureRequest","field":1}"#;
        let parsed: Request = serde_json::from_str(line).unwrap();
        assert!(matches!(parsed, Request::Unknown));
    }

    #[test]
    fn malformed_json_is_still_an_error() {
        assert!(serde_json::from_str::<Request>("{not json").is_err());
    }

    #[test]
    fn session_screen_is_a_v39_request() {
        // The gate is half the compatibility story here, and the app
        // owns the other half: a daemon with no such request must never
        // be sent it, AND the app must skip the verdict rather than
        // judge a turn on the empty string it would be left holding.
        assert_eq!(min_version_for(&Request::SessionScreen { id: "s".into() }), 39);
    }

    #[test]
    fn snapshot_is_a_v18_request() {
        // The gate is the whole compatibility story for this one: a daemon
        // with no screen model must never be sent the request, and the app
        // must fall back to leaving the terminal as it found it.
        assert_eq!(min_version_for(&Request::Snapshot { id: "s".into() }), 18);
    }

    /// The gate is the whole compatibility story here too: the app never
    /// sends this one, so nothing but this match stands between
    /// gavin-mcp and a daemon that would drop the connection on it.
    #[test]
    fn set_rail_run_by_root_is_a_v28_request() {
        assert_eq!(
            min_version_for(&Request::SetRailRunByRoot {
                root_path: "/ws".into(),
                rail_id: "r1".into(),
                state: "running".into(),
                current_stage_id: Some("s1".into()),
            }),
            28
        );
    }

    #[test]
    fn shutdown_is_a_v12_request() {
        assert_eq!(min_version_for(&Request::Shutdown), 12);
    }

    #[test]
    fn the_follow_up_queue_requests_are_all_v29() {
        // All four, not just the writer: `ListQueuedInputs` is the
        // read-back a reloaded frontend depends on, and a client that
        // gated the writes but sent the read to a v25 daemon would drop
        // that connection on an unparseable request instead of quietly
        // showing no queue.
        for req in [
            Request::QueueInput { id: "s".into(), text: "carry on".into() },
            Request::ListQueuedInputs,
            Request::SetQueuedInputs { id: "s".into(), queued_ids: vec!["q1".into()] },
            Request::SendQueuedInput { id: "s".into(), queued_id: "q1".into() },
        ] {
            assert_eq!(min_version_for(&req), 29, "{req:?}");
        }
    }

    #[test]
    fn a_queued_input_serializes_to_the_camel_case_shape_the_frontend_expects() {
        // This struct crosses to TypeScript unreconciled, so the field
        // names ARE the contract -- a snake_case leak here reaches the
        // frontend as `undefined`, and an undefined `text` renders an
        // empty row the human cannot tell from a blank message.
        let q = QueuedInput {
            id: "q-1".to_string(),
            session_id: "s-1".to_string(),
            text: "and then run the tests".to_string(),
            created_at_us: 1_725_000_000_000_000,
        };
        assert_eq!(
            serde_json::to_value(&q).unwrap(),
            serde_json::json!({
                "id": "q-1",
                "sessionId": "s-1",
                "text": "and then run the tests",
                "createdAtUs": 1_725_000_000_000_000i64,
            })
        );
    }

    #[test]
    fn follow_up_queue_messages_roundtrip_through_json_line() {
        let queued = vec![QueuedInput {
            id: "q-1".to_string(),
            session_id: "s-1".to_string(),
            // A newline in the text is the ordinary case, not an edge
            // one: the whole feature exists so a multi-line follow-up
            // arrives as one paste. It must survive the line protocol.
            text: "first\nsecond".to_string(),
            created_at_us: 7,
        }];
        let mut buf = Vec::new();
        write_message(&mut buf, &Request::QueueInput {
            id: "s-1".to_string(),
            text: "first\nsecond".to_string(),
        })
        .unwrap();
        write_message(&mut buf, &Response::QueuedInputs { queued: queued.clone() }).unwrap();
        write_message(
            &mut buf,
            &Response::QueuedInputsChanged { id: "s-1".to_string(), queued },
        )
        .unwrap();
        let mut cursor = Cursor::new(buf);
        match read_message::<_, Request>(&mut cursor).unwrap().unwrap() {
            Request::QueueInput { id, text } => {
                assert_eq!(id, "s-1");
                assert_eq!(text, "first\nsecond");
            }
            other => panic!("wrong variant: {other:?}"),
        }
        match read_message::<_, Response>(&mut cursor).unwrap().unwrap() {
            Response::QueuedInputs { queued } => assert_eq!(queued[0].text, "first\nsecond"),
            other => panic!("wrong variant: {other:?}"),
        }
        match read_message::<_, Response>(&mut cursor).unwrap().unwrap() {
            Response::QueuedInputsChanged { id, queued } => {
                assert_eq!(id, "s-1");
                assert_eq!(queued.len(), 1);
            }
            other => panic!("wrong variant: {other:?}"),
        }
    }

    #[test]
    fn group_template_requests_are_v15() {
        for req in [
            Request::GetGroupTemplates { workspace_id: "w".into() },
            Request::SaveGroupTemplate { template: a_group_template() },
            Request::DeleteGroupTemplate { id: "g1".into() },
        ] {
            assert_eq!(min_version_for(&req), 15, "{req:?}");
        }
    }

    fn a_group_template() -> GroupTemplate {
        GroupTemplate {
            id: "g1".into(),
            workspace_id: Some("ws-1".into()),
            name: "Merge and push".into(),
            description: "Land it, then push".into(),
            mode: "sequence".into(),
            steps: vec![GroupTemplateStep {
                tool_id: "builtin:push".into(),
                tool_params: HashMap::from([("remote".into(), "origin".into())]),
            }],
            position: 0,
        }
    }

    #[test]
    fn the_window_floor_is_never_above_the_current_version() {
        assert!(MIN_COMPATIBLE_VERSION <= PROTOCOL_VERSION);
    }

    #[test]
    fn v1_requests_are_available_to_the_oldest_supported_daemon() {
        // ListSessions has existed since v1, so any daemon in the window serves it.
        assert_eq!(min_version_for(&Request::ListSessions), 1);
        assert_eq!(min_version_for(&Request::GetProtocolVersion), 1);
    }

    #[test]
    fn later_variants_report_the_version_that_introduced_them() {
        assert_eq!(min_version_for(&Request::SetChecklistItem {
            path: "/p.md".into(),
            line_index: 0,
            expected_text: "x".into(),
            checked: true,
        }), 4);
        assert_eq!(min_version_for(&Request::DeleteCardFile { path: "/p.md".into() }), 6);
        assert_eq!(min_version_for(&Request::NameSession {
            session_id: "s-1".into(), name: "login flow".into(), agent_conversation_id: None,
        }), 10);
    }

    #[test]
    fn no_variant_claims_a_version_beyond_the_current_one() {
        // Guards the table against a typo that would make a request unsendable.
        assert!(min_version_for(&Request::NameSession {
            session_id: "s-1".into(),
            name: "login flow".into(),
            agent_conversation_id: None,
        }) <= PROTOCOL_VERSION);
    }

    /// One sample of every `Request` variant, `Unknown` included --
    /// `min_version_for` only looks at which variant a request is, never
    /// its payload, so placeholder field values are fine. Kept exhaustive
    /// by hand against the enum, the same way session.rs's own
    /// `one_of_every_request_variant` is; a variant added to the enum
    /// without a matching entry here silently drops out of the count
    /// below instead of failing loudly.
    fn one_of_every_request_variant() -> Vec<Request> {
        vec![
            Request::CreateSession { workspace_path: "w".into(), cwd: "c".into(), command: None },
            Request::ListSessions,
            Request::WriteInput { id: "s".into(), data: "d".into() },
            Request::ResizeSession { id: "s".into(), cols: 80, rows: 24 },
            Request::KillSession { id: "s".into() },
            Request::Attach { id: "s".into() },
            Request::GetBoard { workspace_id: "w".into() },
            Request::SetBoard { workspace_id: "w".into(), columns: vec![], labels: vec![] },
            Request::DeleteBoard { workspace_id: "w".into() },
            Request::WatchGavinRoot { workspace_id: "w".into(), root_path: "r".into() },
            Request::UnwatchGavinRoot { workspace_id: "w".into() },
            Request::Snapshot { id: "s".into() },
            Request::SessionScreen { id: "s".into() },
            Request::SessionProcesses,
            Request::EndOrphan { id: "s".into() },
            // v26's follow-up queue. Four variants, listed here as well
            // as in min_version_for, because the comment further down is
            // right: only the match is compiler-enforced, and the
            // band-count test cannot catch what never reaches this Vec.
            Request::QueueInput { id: "s".into(), text: "carry on".into() },
            Request::ListQueuedInputs,
            Request::SetQueuedInputs { id: "s".into(), queued_ids: vec!["q1".into()] },
            Request::SendQueuedInput { id: "s".into(), queued_id: "q1".into() },
            Request::SetFailurePatterns { id: "s".into(), patterns: vec!["API Error:".into()] },
            Request::GetGavinTree { workspace_id: "w".into() },
            Request::InitGavinRoot { root_path: "r".into(), workspace_name: "n".into() },
            Request::CreateGavinContext { parent_folder: "p".into() },
            Request::AddExternalGavinContext { root_path: "r".into(), folder: "f".into() },
            Request::RemoveExternalGavinContext { root_path: "r".into(), folder: "f".into() },
            Request::SetPlanFrontmatterField { path: "p".into(), key: "k".into(), value: "v".into() },
            Request::SetRootConfigField { root_path: "r".into(), key: "k".into(), value: "v".into() },
            Request::ScanGavinRoot { root_path: "r".into() },
            Request::ReadPrd { root_path: "r".into() },
            Request::ReadWorkspaceFile { root_path: "r".into(), path: "a.md".into() },
            Request::WriteWorkspaceFile { root_path: "r".into(), path: "a.md".into(), content: "c".into() },
            Request::StatWorkspacePaths { root_path: "r".into(), paths: vec!["a.md".into()] },
            Request::RunGit { root_path: "r".into(), cwd: "r".into(), args: vec!["status".into()], stdin: None },
            Request::ListWorkspaceDir { root_path: "r".into(), path: "r".into() },
            Request::FileHumanItem {
                path: "p".into(),
                kind: HumanItemKind::Decision,
                text: "t".into(),
                options: vec![],
            },
            Request::ResolveHumanItem {
                path: "p".into(),
                expected_text: "Decision: t".into(),
                outcome: HumanItemOutcome::Pass,
            },
            Request::CreatePlan {
                context_folder: "c".into(),
                file_name: "f".into(),
                title: "t".into(),
                status: None,
                priority: None,
                body: None,
                kind: None,
                parent: None,
                attachments: None,
                complexity: None,
            },
            Request::GetBoardByRoot { root_path: "r".into() },
            Request::ClaimCardForSession {
                root_path: "r".into(),
                path: "p".into(),
                session_id: "s".into(),
            },
            Request::SpawnAgentSession { root_path: "r".into(), cwd: "c".into(), command: "cmd".into() },
            Request::DeleteCardFile { path: "p".into() },
            Request::SetChecklistItem {
                path: "p".into(),
                line_index: 0,
                expected_text: "x".into(),
                checked: true,
            },
            Request::PromoteChecklistItem { plan_path: "p".into(), item: "i".into() },
            Request::LinkCardSession {
                workspace_id: "w".into(),
                path: "p".into(),
                session_id: "s".into(),
                cwd: "c".into(),
                command: None,
                conversation_id: None,
                launch_cwd: None,
                resume_attempts: None,
                base_sha: None,
            },
            Request::UnlinkCardSession { workspace_id: "w".into(), path: "p".into() },
            Request::CardRuns { workspace_id: "w".into(), path: "p".into() },
            Request::GetOrchestration { workspace_id: "w".into() },
            Request::SetOrchestration { workspace_id: "w".into(), rails: vec![], conflict_notes: vec![] },
            Request::SetRailRun { rail_id: "r".into(), state: "idle".into(), current_stage_id: None },
            Request::SetStepRun { step_id: "s".into(), state: "pending".into(), session_id: None, reason: None, conversation_id: None, launch_cwd: None, resume_attempts: None },
            Request::GetOrchestrationByRoot { root_path: "r".into() },
            Request::SetOrchestrationByRoot { root_path: "r".into(), rails: vec![], conflict_notes: vec![] },
            Request::SetRailRunByRoot {
                root_path: "r".into(),
                rail_id: "r1".into(),
                state: "running".into(),
                current_stage_id: None,
            },
            Request::GitDirtyPaths { cwd: "c".into(), limit: 10 },
            Request::NameSession { session_id: "s".into(), name: "n".into(), agent_conversation_id: None },
            Request::GetProtocolVersion,
            // v11's tool requests, added when the orchestration merge
            // landed. Note what happened at that merge: min_version_for's
            // match refused to compile until these four were recorded
            // there, but THIS list is a plain Vec -- so the band-count
            // test below went green while all four were missing from it.
            // A false green. If you add a Request variant, the compiler
            // will catch the match; nothing but this comment will catch
            // this list.
            Request::GetTools { workspace_id: "w".into() },
            Request::GetToolsByRoot { root_path: "r".into() },
            Request::SaveTool {
                tool: ToolDef {
                    id: "t".into(),
                    workspace_id: None,
                    name: "n".into(),
                    description: "d".into(),
                    kind: "prompt".into(),
                    body: "b".into(),
                    params: vec![],
                    position: 0,
                    cwd: None,
                    icon: None,
                },
            },
            Request::DeleteTool { id: "t".into() },
            // v37's scoped pair: the same two writes with the SCOPE
            // taken out of the caller's hands.
            Request::SaveToolByRoot {
                root_path: "r".into(),
                tool: ToolDef {
                    id: "t".into(),
                    workspace_id: None,
                    name: "n".into(),
                    description: "d".into(),
                    kind: "command".into(),
                    body: "b".into(),
                    params: vec![],
                    position: 0,
                    cwd: None,
                    icon: None,
                },
            },
            Request::DeleteToolByRoot { root_path: "r".into(), id: "t".into() },
            Request::ArchiveCard { path: "/p/t.md".into() },
            Request::UnarchiveCard { path: "/p/t.md".into() },
            Request::Shutdown,
            // v15's group templates -- the first Request variants that
            // genuinely need the version PROTOCOL_VERSION already carries
            // for Stage.mode/name (see group_template_requests_are_v15).
            Request::GetGroupTemplates { workspace_id: "w".into() },
            Request::SaveGroupTemplate { template: a_group_template() },
            Request::DeleteGroupTemplate { id: "g1".into() },
            // v30's standalone tool runs.
            Request::StartToolRun {
                workspace_id: "w".into(),
                tool_id: "t".into(),
                session_id: "s".into(),
                command: None,
                launch_cwd: None,
                conversation_id: None,
            },
            Request::SetToolRunOutcome {
                session_id: "s".into(),
                outcome: "passed".into(),
                exit_code: None,
            },
            Request::ToolRuns { workspace_id: "w".into() },
            // v35's client-identity handshake.
            Request::Hello {
                client: "test".into(),
                protocol_version: PROTOCOL_VERSION,
                auth: HelloAuth::None,
                nonce: "n".into(),
            },
            Request::Unknown,
        ]
    }

    /// A forcing function for `PROTOCOL_VERSION` bump discipline, which has
    /// already failed three times: seven of the eight variants this table
    /// attributes to v10 (GetOrchestration, GetOrchestrationByRoot,
    /// GitDirtyPaths, SetOrchestration, SetOrchestrationByRoot, SetRailRun,
    /// SetStepRun) were added to the wire across commits 6821fc8, c7ecfce
    /// and 35b26dd while `PROTOCOL_VERSION` still read 8 -- three days and
    /// three commits with no bump. Only NameSession genuinely arrived with
    /// the v9/v10 jump (374eb7d).
    ///
    /// The exhaustive match in `min_version_for` forces an author touching
    /// the enum to type *a* version number, but the value that's easiest
    /// to type is whatever `PROTOCOL_VERSION` currently says -- which is
    /// only correct if they also remembered to bump it. That is exactly
    /// the mistake made three times above, and the compiler cannot catch
    /// it because a wrong-but-present number still compiles.
    ///
    /// This test can't know the *true* version for a new variant either,
    /// but it pins how many variants currently live in each band. Adding a
    /// variant to an existing band (the easy, wrong move -- attribute it to
    /// the current `PROTOCOL_VERSION` without bumping) changes that band's
    /// count and trips this test, forcing whoever did it to stop and
    /// consider whether they owe a version bump instead. Counts below were
    /// derived by hand from `min_version_for`'s match arms on this branch,
    /// not copied from a plan: v1=21, v4=2, v5=2, v6=1, v7=1, v8=2, v10=8,
    /// v11=4, v12=1 (Shutdown), v13=2 (the archive), v15=3 (group
    /// templates), v18=1 (Snapshot), v21=1 (SetFailurePatterns), v23=1
    /// (ClaimCardForSession), v24=1 (EndOrphan), v25=1 (SessionProcesses),
    /// v27=1 (CardRuns), v28=1 (SetRailRunByRoot), v29=4 (the
    /// follow-up queue), v30=3 (standalone tool runs), v35=1 (Hello --
    /// client identity), v37=2 (an agent authoring its own workspace's
    /// tools), v39=1 (SessionScreen), v40=3 (ssh workspace files), v41=2
    /// (ssh git/files), v42=2 (the Decisions tab's writes), plus Unknown.
    #[test]
    fn variant_counts_per_version_band_are_pinned_to_catch_a_missed_bump() {
        use std::collections::HashMap;

        let mut counts: HashMap<u32, usize> = HashMap::new();
        for req in one_of_every_request_variant() {
            *counts.entry(min_version_for(&req)).or_default() += 1;
        }

        let mut expected: HashMap<u32, usize> = HashMap::new();
        expected.insert(1, 21);
        expected.insert(4, 2);
        expected.insert(5, 2);
        expected.insert(6, 1);
        expected.insert(7, 1);
        expected.insert(8, 2);
        expected.insert(10, 8);
        expected.insert(11, 4);
        expected.insert(12, 1);
        expected.insert(13, 2);
        expected.insert(15, 3);
        expected.insert(18, 1);
        expected.insert(21, 1);
        expected.insert(23, 1);
        expected.insert(24, 1);
        expected.insert(25, 1);
        expected.insert(27, 1);
        expected.insert(28, 1);
        expected.insert(29, 4);
        expected.insert(30, 3);
        expected.insert(35, 1); // Request::Hello -- client identity
        // Save/DeleteToolByRoot -- agent-authored workspace tools.
        expected.insert(37, 2);
        // Request::SessionScreen -- the rendered screen as text.
        expected.insert(39, 1);
        // Read/WriteWorkspaceFile + StatWorkspacePaths -- workspace files
        // for a desktop on another machine (ssh card runs).
        expected.insert(40, 3);
        // RunGit + ListWorkspaceDir -- the Git tab and Files tree over ssh.
        expected.insert(41, 2);
        // FileHumanItem + ResolveHumanItem -- the Decisions tab's writes.
        expected.insert(42, 2);
        expected.insert(u32::MAX, 1); // Request::Unknown

        assert_eq!(
            counts, expected,
            "a version band's variant count changed -- if you just added a \
             Request variant, make sure you also considered whether \
             PROTOCOL_VERSION needs bumping (see this test's doc comment)"
        );
    }

    /// The run history crosses to the frontend, so its field names are
    /// part of the wire the same way `CardSession`'s are -- and unlike
    /// that one, three of its fields carry a MEANING in their absence
    /// (`endedAt` on an open run, `exitCode` on one nobody watched
    /// finish, `conversationId` on a profile with no id), so the nulls
    /// are asserted rather than left to a `skip_serializing_if` nobody
    /// noticed had been added.
    #[test]
    fn card_run_serializes_to_the_camel_case_shape_the_frontend_expects() {
        let run = CardRun {
            id: 7,
            path: "/p/t.md".to_string(),
            session_id: "s-1".to_string(),
            command: Some("claude 'x'".to_string()),
            conversation_id: None,
            launch_cwd: Some("/p/worktrees/a".to_string()),
            base_sha: Some("f75db30f75db30f75db30f75db30f75db30f75db".to_string()),
            started_at: 1_756_900_000,
            ended_at: None,
            exit_code: None,
            outcome: "running".to_string(),
            resume_attempts: Some(2),
        };
        assert_eq!(
            serde_json::to_value(&run).unwrap(),
            serde_json::json!({ "id": 7, "path": "/p/t.md", "sessionId": "s-1",
                                "command": "claude 'x'", "conversationId": null,
                                "launchCwd": "/p/worktrees/a",
                                "baseSha": "f75db30f75db30f75db30f75db30f75db30f75db",
                                "startedAt": 1_756_900_000, "endedAt": null,
                                "exitCode": null, "outcome": "running",
                                "resumeAttempts": 2 })
        );

        let mut buf = Vec::new();
        write_message(&mut buf, &Request::CardRuns {
            workspace_id: "ws".to_string(),
            path: "/p/t.md".to_string(),
        }).unwrap();
        write_message(&mut buf, &Response::CardRuns { runs: vec![run.clone()] }).unwrap();
        let mut reader = &buf[..];
        match read_message::<_, Request>(&mut reader).unwrap().unwrap() {
            Request::CardRuns { path, .. } => assert_eq!(path, "/p/t.md"),
            other => panic!("expected CardRuns, got {other:?}"),
        }
        match read_message::<_, Response>(&mut reader).unwrap().unwrap() {
            Response::CardRuns { runs } => assert_eq!(runs, vec![run]),
            other => panic!("expected CardRuns, got {other:?}"),
        }
    }

    /// A tool run crosses to the frontend the way a card run does, and
    /// three of its fields carry a MEANING in their absence (`endedAt`
    /// on an open run, `exitCode` on an agent's, `conversationId` on a
    /// shell's), so the nulls are asserted rather than left to a
    /// `skip_serializing_if` nobody noticed had been added.
    #[test]
    fn tool_run_serializes_to_the_camel_case_shape_the_frontend_expects() {
        let run = ToolRun {
            id: 3,
            tool_id: "builtin:consolidate-repo".to_string(),
            session_id: "s-9".to_string(),
            command: Some("claude 'x'".to_string()),
            launch_cwd: Some("/p/apps/web".to_string()),
            conversation_id: None,
            started_at: 1_770_000_000,
            ended_at: None,
            exit_code: None,
            outcome: "running".to_string(),
        };
        assert_eq!(
            serde_json::to_value(&run).unwrap(),
            serde_json::json!({
                "id": 3,
                "toolId": "builtin:consolidate-repo",
                "sessionId": "s-9",
                "command": "claude 'x'",
                "launchCwd": "/p/apps/web",
                "conversationId": null,
                "startedAt": 1_770_000_000i64,
                "endedAt": null,
                "exitCode": null,
                "outcome": "running"
            })
        );

        let mut buf = Vec::new();
        write_message(&mut buf, &Request::ToolRuns { workspace_id: "ws".to_string() }).unwrap();
        write_message(&mut buf, &Response::ToolRuns { runs: vec![run.clone()] }).unwrap();
        let mut reader = &buf[..];
        match read_message::<_, Request>(&mut reader).unwrap().unwrap() {
            Request::ToolRuns { workspace_id } => assert_eq!(workspace_id, "ws"),
            other => panic!("expected ToolRuns, got {other:?}"),
        }
        match read_message::<_, Response>(&mut reader).unwrap().unwrap() {
            Response::ToolRuns { runs } => assert_eq!(runs, vec![run]),
            other => panic!("expected ToolRuns, got {other:?}"),
        }
    }

    /// The half of v30 `min_version_for` cannot see. A tool saved by a
    /// caller that predates the field has no `cwd` on the wire at all,
    /// and that has to parse as None -- "runs at the root" -- rather
    /// than failing the whole library read.
    #[test]
    fn a_card_scanned_before_v32_parses_as_naming_no_agent_of_its_own() {
        // The read half of the `cardAgent` gate, in the one place it can
        // be asserted: a v31 daemon sends neither field, and the app has
        // to see "this card names nothing" rather than fail to parse the
        // whole tree. Which is also why the gate is a hard one -- the
        // absence is indistinguishable from a card that really names
        // nothing.
        let plan: PlanFileInfo = serde_json::from_value(serde_json::json!({
            "path": "/ws/.gavin-root/plans/a.md",
            "fileName": "a.md",
            "title": "a",
            "status": null,
            "priority": null,
            "order": null,
            "kind": "task",
            "parent": null,
            "labels": [],
            "checklistDone": 0,
            "checklistTotal": 0,
            "parseWarning": false
        }))
        .unwrap();
        assert_eq!(plan.agent, None);
        assert_eq!(plan.model, None);
        assert_eq!(plan.complexity, None);
    }

    #[test]
    fn a_tool_def_written_before_v30_parses_with_no_working_directory() {
        let tool: ToolDef = serde_json::from_value(serde_json::json!({
            "id": "u1",
            "workspaceId": null,
            "name": "Push",
            "description": "",
            "kind": "command",
            "body": "git push",
            "params": [],
            "position": 0
        }))
        .unwrap();
        assert_eq!(tool.cwd, None);
        assert_eq!(tool.icon, None);
    }

    #[test]
    fn a_tool_def_written_before_v33_parses_with_no_icon_of_its_own() {
        // Absent is not "no icon at all": it is "draw whatever this
        // tool's kind draws", which is what every tool authored before
        // v33 has always meant.
        let tool: ToolDef = serde_json::from_value(serde_json::json!({
            "id": "u1",
            "workspaceId": null,
            "name": "Push",
            "description": "",
            "kind": "command",
            "body": "git push",
            "params": [],
            "position": 0,
            "cwd": null
        }))
        .unwrap();
        assert_eq!(tool.icon, None);
    }

    #[test]
    fn card_session_serializes_to_the_camel_case_shape_the_frontend_expects() {
        let cs = CardSession {
            path: "/p/t.md".to_string(),
            session_id: "s-1".to_string(),
            cwd: "/p".to_string(),
            command: None,
            conversation_id: Some("conv-1".to_string()),
            launch_cwd: Some("/p/worktrees/a".to_string()),
            resume_attempts: Some(1),
            base_sha: Some("f75db30f75db30f75db30f75db30f75db30f75db".to_string()),
        };
        assert_eq!(
            serde_json::to_value(&cs).unwrap(),
            serde_json::json!({ "path": "/p/t.md", "sessionId": "s-1", "cwd": "/p", "command": null,
                                "conversationId": "conv-1", "launchCwd": "/p/worktrees/a",
                                "resumeAttempts": 1,
                                "baseSha": "f75db30f75db30f75db30f75db30f75db30f75db" })
        );
        let mut buf = Vec::new();
        write_message(&mut buf, &Request::LinkCardSession {
            workspace_id: "ws".to_string(),
            path: "/p/t.md".to_string(),
            session_id: "s-1".to_string(),
            cwd: "/p".to_string(),
            command: Some("claude 'x'".to_string()),
            conversation_id: None,
            launch_cwd: None,
            resume_attempts: None,
            base_sha: None,
        }).unwrap();
        write_message(&mut buf, &Request::UnlinkCardSession {
            workspace_id: "ws".to_string(),
            path: "/p/t.md".to_string(),
        }).unwrap();
        let mut cursor = Cursor::new(buf);
        match read_message::<_, Request>(&mut cursor).unwrap().unwrap() {
            Request::LinkCardSession { session_id, command, .. } => {
                assert_eq!(session_id, "s-1");
                assert_eq!(command.as_deref(), Some("claude 'x'"));
            }
            other => panic!("wrong variant: {other:?}"),
        }
        match read_message::<_, Request>(&mut cursor).unwrap().unwrap() {
            Request::UnlinkCardSession { path, .. } => assert_eq!(path, "/p/t.md"),
            other => panic!("wrong variant: {other:?}"),
        }
    }

    #[test]
    fn checklist_requests_roundtrip_through_json_line() {
        let mut buf = Vec::new();
        write_message(&mut buf, &Request::SetChecklistItem {
            path: "/p/plan.md".to_string(),
            line_index: 4,
            expected_text: "one".to_string(),
            checked: true,
        }).unwrap();
        write_message(&mut buf, &Request::PromoteChecklistItem {
            plan_path: "/p/plan.md".to_string(),
            item: "Ship it".to_string(),
        }).unwrap();
        write_message(&mut buf, &Response::TaskPromoted { path: "/p/ship-it.md".to_string() }).unwrap();
        let mut cursor = Cursor::new(buf);
        match read_message::<_, Request>(&mut cursor).unwrap().unwrap() {
            Request::SetChecklistItem { line_index, expected_text, checked, .. } => {
                assert_eq!(line_index, 4);
                assert_eq!(expected_text, "one");
                assert!(checked);
            }
            other => panic!("wrong variant: {other:?}"),
        }
        match read_message::<_, Request>(&mut cursor).unwrap().unwrap() {
            Request::PromoteChecklistItem { item, .. } => assert_eq!(item, "Ship it"),
            other => panic!("wrong variant: {other:?}"),
        }
        match read_message::<_, Response>(&mut cursor).unwrap().unwrap() {
            Response::TaskPromoted { path } => assert_eq!(path, "/p/ship-it.md"),
            other => panic!("wrong variant: {other:?}"),
        }
    }

    #[test]
    fn create_plan_request_roundtrips_through_json_line() {
        let mut buf = Vec::new();
        let req = Request::CreatePlan {
            context_folder: "/ws/auth".to_string(),
            file_name: "login.md".to_string(),
            title: "Login flow".to_string(),
            status: Some("In Progress".to_string()),
            priority: Some("high".to_string()),
            body: Some("Body text".to_string()),
            kind: Some("task".to_string()),
            parent: Some("auth-plan.md".to_string()),
            attachments: Some("docs/spec.md, /Users/x/shot.png".to_string()),
            complexity: Some("intricate".to_string()),
        };
        write_message(&mut buf, &req).unwrap();
        let mut cursor = Cursor::new(buf);
        let decoded: Request = read_message(&mut cursor).unwrap().unwrap();
        match decoded {
            Request::CreatePlan { context_folder, file_name, title, status, priority, body, kind, parent, attachments, complexity } => {
                assert_eq!(kind.as_deref(), Some("task"));
                assert_eq!(parent.as_deref(), Some("auth-plan.md"));
                assert_eq!(attachments.as_deref(), Some("docs/spec.md, /Users/x/shot.png"));
                assert_eq!(complexity.as_deref(), Some("intricate"));
                assert_eq!(context_folder, "/ws/auth");
                assert_eq!(file_name, "login.md");
                assert_eq!(title, "Login flow");
                assert_eq!(status.as_deref(), Some("In Progress"));
                assert_eq!(priority.as_deref(), Some("high"));
                assert_eq!(body.as_deref(), Some("Body text"));
            }
            other => panic!("wrong variant: {other:?}"),
        }
    }

    #[test]
    fn spawn_agent_session_request_roundtrips_through_json_line() {
        let mut buf = Vec::new();
        let req = Request::SpawnAgentSession {
            root_path: "/ws".to_string(),
            cwd: "/ws/auth".to_string(),
            command: "claude".to_string(),
        };
        write_message(&mut buf, &req).unwrap();
        let mut cursor = Cursor::new(buf);
        let decoded: Request = read_message(&mut cursor).unwrap().unwrap();
        match decoded {
            Request::SpawnAgentSession { root_path, cwd, command } => {
                assert_eq!(root_path, "/ws");
                assert_eq!(cwd, "/ws/auth");
                assert_eq!(command, "claude");
            }
            other => panic!("wrong variant: {other:?}"),
        }
    }

    #[test]
    fn name_session_request_roundtrips_through_json_line() {
        let mut buf = Vec::new();
        write_message(
            &mut buf,
            &Request::NameSession {
                session_id: "s-1".to_string(),
                name: "login flow".to_string(),
                agent_conversation_id: None,
            },
        )
        .unwrap();
        let mut cursor = Cursor::new(buf);
        match read_message::<_, Request>(&mut cursor).unwrap().unwrap() {
            Request::NameSession { session_id, name, agent_conversation_id } => {
                assert_eq!(session_id, "s-1");
                assert_eq!(name, "login flow");
                assert_eq!(agent_conversation_id, None);
            }
            other => panic!("wrong variant: {other:?}"),
        }
    }

    /// v38: an agent whose CLI mints its own conversation id (codex,
    /// gemini, opencode) self-reports it as this field, kept spelled
    /// apart from `session_id` -- gavin's own tab/PTY session -- so the
    /// two are never confused on the wire or in daemon code.
    #[test]
    fn name_session_request_roundtrips_its_agent_conversation_id() {
        let mut buf = Vec::new();
        write_message(
            &mut buf,
            &Request::NameSession {
                session_id: "s-1".to_string(),
                name: "login flow".to_string(),
                agent_conversation_id: Some("rollout-abc123".to_string()),
            },
        )
        .unwrap();
        let mut cursor = Cursor::new(buf);
        match read_message::<_, Request>(&mut cursor).unwrap().unwrap() {
            Request::NameSession { agent_conversation_id, .. } => {
                assert_eq!(agent_conversation_id, Some("rollout-abc123".to_string()));
            }
            other => panic!("wrong variant: {other:?}"),
        }
    }

    /// `serde(default)`: a `NameSession` line with no `agent_conversation_id`
    /// key at all (not just `null`) still parses, so a wire message from
    /// before v38 -- or any producer that omits the field -- never fails
    /// to deserialize.
    #[test]
    fn name_session_request_parses_with_agent_conversation_id_key_absent() {
        let line = r#"{"type":"NameSession","session_id":"s-1","name":"login flow"}
"#;
        let mut cursor = Cursor::new(line.as_bytes().to_vec());
        match read_message::<_, Request>(&mut cursor).unwrap().unwrap() {
            Request::NameSession { session_id, name, agent_conversation_id } => {
                assert_eq!(session_id, "s-1");
                assert_eq!(name, "login flow");
                assert_eq!(agent_conversation_id, None);
            }
            other => panic!("wrong variant: {other:?}"),
        }
    }

    #[test]
    fn session_named_push_roundtrips_through_json_line() {
        let mut buf = Vec::new();
        write_message(
            &mut buf,
            &Response::SessionNamed { session_id: "s-1".to_string(), name: "login flow".to_string() },
        )
        .unwrap();
        let mut cursor = Cursor::new(buf);
        match read_message::<_, Response>(&mut cursor).unwrap().unwrap() {
            Response::SessionNamed { session_id, name } => {
                assert_eq!(session_id, "s-1");
                assert_eq!(name, "login flow");
            }
            other => panic!("wrong variant: {other:?}"),
        }
    }

    #[test]
    fn protocol_version_roundtrips_through_json_line() {
        let mut buf = Vec::new();
        write_message(&mut buf, &Request::GetProtocolVersion).unwrap();
        write_message(&mut buf, &Response::ProtocolVersion { version: PROTOCOL_VERSION }).unwrap();
        let mut cursor = Cursor::new(buf);
        let req: Request = read_message(&mut cursor).unwrap().unwrap();
        assert!(matches!(req, Request::GetProtocolVersion));
        let resp: Response = read_message(&mut cursor).unwrap().unwrap();
        match resp {
            Response::ProtocolVersion { version } => assert_eq!(version, PROTOCOL_VERSION),
            other => panic!("wrong variant: {other:?}"),
        }
    }

    #[test]
    fn agent_session_spawned_response_roundtrips_through_json_line() {
        let mut buf = Vec::new();
        let resp = Response::AgentSessionSpawned {
            workspace_id: "ws-1".to_string(),
            session_id: "s-1".to_string(),
            cwd: "/ws".to_string(),
            command: "claude".to_string(),
        };
        write_message(&mut buf, &resp).unwrap();
        let mut cursor = Cursor::new(buf);
        let decoded: Response = read_message(&mut cursor).unwrap().unwrap();
        match decoded {
            Response::AgentSessionSpawned { workspace_id, session_id, cwd, command } => {
                assert_eq!(workspace_id, "ws-1");
                assert_eq!(session_id, "s-1");
                assert_eq!(cwd, "/ws");
                assert_eq!(command, "claude");
            }
            other => panic!("wrong variant: {other:?}"),
        }
    }

    #[test]
    fn gavin_tree_changed_response_roundtrips_through_json_line() {
        let mut buf = Vec::new();
        let resp = Response::GavinTreeChanged {
            workspace_id: "ws-1".to_string(),
            tree: sample_tree(),
        };
        write_message(&mut buf, &resp).unwrap();
        let mut cursor = Cursor::new(buf);
        let decoded: Response = read_message(&mut cursor).unwrap().unwrap();
        match decoded {
            Response::GavinTreeChanged { workspace_id, tree } => {
                assert_eq!(workspace_id, "ws-1");
                assert_eq!(tree.contexts.len(), 1);
                assert_eq!(tree.contexts[0].plans[0].status.as_deref(), Some("To Do"));
            }
            other => panic!("wrong variant: {other:?}"),
        }
    }

    #[test]
    fn orchestration_types_are_camel_case_on_the_wire() {
        let rail = Rail {
            id: "r1".into(),
            name: "backend".into(),
            position: 0,
            worktree_path: Some("/x/gavin-backend".into()),
            branch: Some("feature/api".into()),
            auto_resume: Some(true),
            trigger: Some(RailTrigger { kind: "rail-done".into(), rail: Some("frontend".into()) }),
            page_id: None,
            stages: vec![Stage {
                id: "s1".into(),
                position: 0,
                mode: default_stage_mode(),
                name: None,
                steps: vec![Step {
                    id: "t1".into(),
                    position: 0,
                    card_path: "/x/a.md".into(),
                    tool_id: None,
                    tool_params: HashMap::new(),
                }],
            }],
        };
        assert_eq!(
            serde_json::to_value(&rail).unwrap(),
            serde_json::json!({
                "id": "r1",
                "name": "backend",
                "position": 0,
                "worktreePath": "/x/gavin-backend",
                "branch": "feature/api",
                "autoResume": true,
                "trigger": { "kind": "rail-done", "rail": "frontend" },
                "pageId": null,
                "stages": [{ "id": "s1", "position": 0, "mode": "parallel", "name": null,
                             "steps": [{ "id": "t1", "position": 0, "cardPath": "/x/a.md",
                                         "toolId": null, "toolParams": {} }] }]
            })
        );

        let run = StepRun {
            step_id: "t1".into(),
            state: "running".into(),
            session_id: Some("sess-1".into()),
            reason: None,
            conversation_id: Some("conv-1".into()),
            launch_cwd: Some("/x/wt".into()),
            resume_attempts: Some(1),
        };
        assert_eq!(
            serde_json::to_value(&run).unwrap(),
            serde_json::json!({ "stepId": "t1", "state": "running", "sessionId": "sess-1", "reason": null,
                                "conversationId": "conv-1", "launchCwd": "/x/wt", "resumeAttempts": 1 })
        );
    }

    /// The old shape must still parse: a rail authored before branch
    /// binding -- or by an agent that omits the field -- means "whatever
    /// is checked out", which is exactly None.
    #[test]
    fn a_rail_without_a_branch_parses_as_unbound_to_any_branch() {
        let rail: Rail = serde_json::from_value(serde_json::json!({
            "id": "r1", "name": "backend", "position": 0,
            "worktreePath": null, "pageId": null, "stages": []
        }))
        .unwrap();
        assert_eq!(rail.branch, None);
        // And the same rail has never opted into resuming itself, which
        // is the only safe reading of a field it does not carry.
        assert_eq!(rail.auto_resume, None);
        // ...nor into starting itself. A rail with no trigger is one only
        // a human (or another rail's step) arms, which is what every rail
        // written before v35 is.
        assert_eq!(rail.trigger, None);
    }

    /// A `rail-done` trigger names its rail; `all-rails-done` names
    /// nothing, and the field is absent rather than null -- an agent
    /// writing the shorter shape must round-trip.
    #[test]
    fn a_trigger_without_a_named_rail_parses_as_naming_none() {
        let rail: Rail = serde_json::from_value(serde_json::json!({
            "id": "r1", "name": "release", "position": 0,
            "worktreePath": null, "pageId": null, "stages": [],
            "trigger": { "kind": "all-rails-done" }
        }))
        .unwrap();
        assert_eq!(
            rail.trigger,
            Some(RailTrigger { kind: "all-rails-done".into(), rail: None })
        );
    }

    /// The old shape must still parse: an agent that has never heard of
    /// tools writes a step with only these three fields (tools spec §6).
    #[test]
    fn a_step_without_tool_fields_parses_as_a_card_step() {
        let step: Step =
            serde_json::from_value(serde_json::json!({ "id": "t1", "position": 0, "cardPath": "/x/a.md" }))
                .unwrap();
        assert_eq!(step.tool_id, None);
        assert!(step.tool_params.is_empty());
    }

    #[test]
    fn a_tool_step_round_trips_with_an_empty_card_path() {
        let step = Step {
            id: "t1".into(),
            position: 0,
            card_path: String::new(),
            tool_id: Some("builtin:push".into()),
            tool_params: HashMap::from([("remote".to_string(), "upstream".to_string())]),
        };
        let back: Step = serde_json::from_value(serde_json::to_value(&step).unwrap()).unwrap();
        assert_eq!(back, step);
    }

    #[test]
    fn tool_def_is_camel_case_on_the_wire() {
        let tool = ToolDef {
            id: "u1".into(),
            workspace_id: None,
            name: "Push".into(),
            description: "git push".into(),
            kind: "command".into(),
            body: "git push -u {{remote}} HEAD".into(),
            params: vec![ToolParam {
                name: "remote".into(),
                label: "Remote".into(),
                default: "origin".into(),
            }],
            position: 0,
            cwd: Some("apps/web".into()),
            icon: Some("rocket".into()),
        };
        assert_eq!(
            serde_json::to_value(&tool).unwrap(),
            serde_json::json!({
                "id": "u1",
                "workspaceId": null,
                "name": "Push",
                "description": "git push",
                "kind": "command",
                "body": "git push -u {{remote}} HEAD",
                "params": [{ "name": "remote", "label": "Remote", "default": "origin" }],
                "position": 0,
                "cwd": "apps/web",
                "icon": "rocket"
            })
        );
    }

    #[test]
    fn a_stage_without_a_mode_deserialises_as_parallel() {
        // Every stage written before groups existed omits the field. It must
        // read as the discipline it actually ran under, never as "".
        let s: Stage = serde_json::from_str(
            r#"{"id":"s1","position":0,"steps":[]}"#,
        )
        .unwrap();
        assert_eq!(s.mode, "parallel");
        assert_eq!(s.name, None);
    }

    #[test]
    fn a_stage_round_trips_its_mode_and_name() {
        let s = Stage {
            id: "s1".into(),
            position: 0,
            mode: "sequence".into(),
            name: Some("Merge and push".into()),
            steps: vec![],
        };
        let back: Stage = serde_json::from_str(&serde_json::to_string(&s).unwrap()).unwrap();
        assert_eq!(back, s);
    }

    #[test]
    fn stage_mode_is_camel_case_on_the_wire() {
        let json = serde_json::to_string(&Stage {
            id: "s1".into(),
            position: 0,
            mode: "sequence".into(),
            name: None,
            steps: vec![],
        })
        .unwrap();
        assert!(json.contains(r#""mode":"sequence""#), "{json}");
    }

    // ---- the data directory seam ------------------------------------

    fn os(s: &str) -> Option<OsString> {
        Some(OsString::from(s))
    }

    #[test]
    fn macos_keeps_application_support_and_ignores_xdg() {
        // The compatibility promise of the Linux port: nobody who has
        // XDG_DATA_HOME exported for some other tool wakes up on a
        // second, empty daemon while their real one still holds the
        // registry.
        let dir = resolve_app_support_dir(os("/Users/x"), os("/Users/x/.local/share"), None, None, HostOs::MacOs).unwrap();
        assert_eq!(dir, PathBuf::from("/Users/x/Library/Application Support/gavin"));
    }

    #[test]
    fn linux_defaults_to_the_xdg_default_when_the_variable_is_unset() {
        let dir = resolve_app_support_dir(os("/home/x"), None, None, None, HostOs::Xdg).unwrap();
        assert_eq!(dir, PathBuf::from("/home/x/.local/share/gavin"));
    }

    #[test]
    fn linux_honours_an_absolute_xdg_data_home() {
        let dir = resolve_app_support_dir(os("/home/x"), os("/data/gavin-home"), None, None, HostOs::Xdg).unwrap();
        assert_eq!(dir, PathBuf::from("/data/gavin-home/gavin"));
    }

    #[test]
    fn an_empty_or_relative_xdg_data_home_is_ignored_the_way_the_spec_says() {
        // The XDG base directory spec: empty means unset, and a relative
        // value "is invalid and must be ignored". Honouring a relative
        // one would put the socket somewhere that moves with whatever
        // cwd the daemon happened to be spawned from.
        for bad in ["", ".local/share", "gavin-data"] {
            let dir = resolve_app_support_dir(os("/home/x"), os(bad), None, None, HostOs::Xdg).unwrap();
            assert_eq!(dir, PathBuf::from("/home/x/.local/share/gavin"), "XDG_DATA_HOME={bad:?}");
        }
    }

    #[test]
    fn a_missing_home_is_an_error_naming_the_variable_not_a_panic() {
        // The old code was `expect("HOME not set")`, which aborts the
        // daemon before it prints anything -- the app then only ever
        // saw "daemon did not become reachable".
        for os_kind in [HostOs::MacOs, HostOs::Xdg] {
            let err = resolve_app_support_dir(None, None, None, None, os_kind)
                .unwrap_err()
                .to_string();
            assert!(err.contains("HOME"), "{err}");
        }
        // Empty is the same as unset: an exported-but-blank HOME would
        // otherwise resolve the whole tree under "/".
        assert!(resolve_app_support_dir(os(""), None, None, None, HostOs::Xdg).is_err());
    }

    #[test]
    fn an_absolute_xdg_data_home_is_enough_on_its_own() {
        // A systemd user unit sets XDG_DATA_HOME and may not set HOME.
        let dir = resolve_app_support_dir(None, os("/run/user/1000/gavin-data"), None, None, HostOs::Xdg).unwrap();
        assert_eq!(dir, PathBuf::from("/run/user/1000/gavin-data/gavin"));
    }

    /// The release spelling of every per-daemon name is the one an
    /// installed gavin is already using. This design ships no migration:
    /// a changed literal here is a daemon that silently starts a new,
    /// empty registry and an app that cannot authenticate to it.
    #[test]
    fn the_release_names_are_the_ones_already_on_disk() {
        assert_eq!(profile_file_name("daemon", "sock", BuildProfile::Release), "daemon.sock");
        assert_eq!(profile_file_name("daemon", "token", BuildProfile::Release), "daemon.token");
        assert_eq!(profile_file_name("daemon", "log", BuildProfile::Release), "daemon.log");
        assert_eq!(profile_file_name("registry", "sqlite", BuildProfile::Release), "registry.sqlite");
    }

    /// Every per-daemon file splits, and the suffix goes before the
    /// extension -- `daemon-dev.sock`, not `daemon.sock-dev`, so the pipe
    /// tag and anything reading by extension still work.
    #[test]
    fn a_dev_build_names_every_per_daemon_file_apart() {
        for (stem, ext) in
            [("daemon", "sock"), ("daemon", "token"), ("daemon", "log"), ("registry", "sqlite")]
        {
            assert_ne!(
                profile_file_name(stem, ext, BuildProfile::Dev),
                profile_file_name(stem, ext, BuildProfile::Release),
                "{stem}.{ext} did not split"
            );
        }
        assert_eq!(profile_file_name("daemon", "sock", BuildProfile::Dev), "daemon-dev.sock");
        assert_eq!(profile_file_name("registry", "sqlite", BuildProfile::Dev), "registry-dev.sqlite");
    }

    /// The property the whole design rests on: two builds, two endpoints,
    /// so neither app can adopt the other's daemon and neither Restart can
    /// reach it. Asserted against the pipe NAME because that is the
    /// endpoint on the platform this matters on, and `pipe_name_for_path`
    /// is compiled everywhere for exactly this reason -- the rule has to
    /// be provable in the suite that runs on a mac and on the Windows
    /// machine that uses it.
    #[test]
    fn the_two_builds_hash_to_different_pipes() {
        let dir = Path::new("/x/gavin");
        let release = transport::pipe_name_for_path(
            &dir.join(profile_file_name("daemon", "sock", BuildProfile::Release)),
        );
        let dev = transport::pipe_name_for_path(
            &dir.join(profile_file_name("daemon", "sock", BuildProfile::Dev)),
        );
        assert_ne!(release, dev);
        // The tag `pipe_name_for_path` keeps in front of the hash, so the
        // two are told apart in Process Explorer as well as by the kernel.
        assert!(dev.contains("daemon-dev-sock"), "{dev}");
        assert!(!release.contains("daemon-dev-sock"), "{release}");
    }

    /// The shared half of the design, pinned so it cannot be widened by
    /// accident: the state DIRECTORY does not split. Both builds find one
    /// board, one set of rails, one workspace list, because those are the
    /// same files.
    #[test]
    fn the_state_directory_itself_never_splits() {
        let dir =
            resolve_app_support_dir(None, None, os(r"C:\Users\x\AppData\Local"), None, HostOs::Windows)
                .unwrap();
        assert_eq!(dir, PathBuf::from(r"C:\Users\x\AppData\Local").join("gavin"));
    }

    #[test]
    fn a_windows_path_reaches_the_wire_with_forward_slashes() {
        assert_eq!(
            normalize_separators(r"C:\Users\Ada\repo\.gavin-root\plans\x.md", true),
            "C:/Users/Ada/repo/.gavin-root/plans/x.md"
        );
        // Mixed already, because git prints forward slashes and the app
        // joins with them: idempotent either way.
        assert_eq!(normalize_separators("C:/Users/Ada/repo", true), "C:/Users/Ada/repo");
    }

    #[test]
    fn a_unix_backslash_is_a_file_name_and_stays_one() {
        // `touch 'a\b'` is legal on every unix. Rewriting it would make
        // the file viewer open a directory that does not exist.
        assert_eq!(normalize_separators(r"/home/ada/a\b", false), r"/home/ada/a\b");
    }

    #[test]
    fn the_verbatim_prefix_comes_off_a_canonicalized_drive_path() {
        assert_eq!(strip_verbatim_prefix(r"\\?\C:\Users\Ada\repo"), "C:/Users/Ada/repo");
        assert_eq!(strip_verbatim_prefix(r"\\?\UNC\server\share\repo"), "//server/share/repo");
    }

    #[test]
    fn a_verbatim_volume_name_keeps_its_prefix() {
        // `\\?\Volume{...}` is not a drive path with decoration on it --
        // it is the only spelling of that volume, and stripping the
        // prefix would name something else.
        let volume = r"\\?\Volume{b75e2c83-0000-0000-0000-602f00000000}\x";
        assert!(strip_verbatim_prefix(volume).starts_with("//?/Volume"));
    }

    #[test]
    fn windows_keeps_its_state_in_local_appdata() {
        let dir = resolve_app_support_dir(
            None,
            None,
            os(r"C:\Users\Ada\AppData\Local"),
            os(r"C:\Users\Ada"),
            HostOs::Windows,
        )
        .unwrap();
        // Joined rather than spelled out: `PathBuf::join` uses the HOST
        // separator, so a literal with backslashes would pass only on
        // Windows and this rule is tested where the suite runs.
        assert_eq!(dir, PathBuf::from(r"C:\Users\Ada\AppData\Local").join("gavin"));
    }

    #[test]
    fn windows_ignores_xdg_and_home_the_way_macos_does() {
        // A developer who runs the app from a Git Bash shell has HOME
        // set to an MSYS path, and may well have XDG_DATA_HOME exported
        // too. Neither is where a Windows application keeps its state,
        // and honouring either would start a second, empty daemon beside
        // the one holding the registry.
        let dir = resolve_app_support_dir(
            os("/c/Users/Ada"),
            os("/c/Users/Ada/.local/share"),
            os(r"C:\Users\Ada\AppData\Local"),
            os(r"C:\Users\Ada"),
            HostOs::Windows,
        )
        .unwrap();
        // Joined rather than spelled out: `PathBuf::join` uses the HOST
        // separator, so a literal with backslashes would pass only on
        // Windows and this rule is tested where the suite runs.
        assert_eq!(dir, PathBuf::from(r"C:\Users\Ada\AppData\Local").join("gavin"));
    }

    #[test]
    fn windows_falls_back_to_the_profile_when_localappdata_is_unset() {
        // %LOCALAPPDATA% is documented as %USERPROFILE%\AppData\Local,
        // so this is the same directory spelled out rather than a guess
        // at a different one.
        for local in [None, os("")] {
            let dir = resolve_app_support_dir(
                None,
                None,
                local.clone(),
                os(r"C:\Users\Ada"),
                HostOs::Windows,
            )
            .unwrap();
            assert_eq!(
                dir,
                PathBuf::from(r"C:\Users\Ada").join("AppData").join("Local").join("gavin")
            );
        }
    }

    #[test]
    fn windows_with_no_profile_at_all_is_an_error_naming_the_variables() {
        let err = resolve_app_support_dir(None, None, None, None, HostOs::Windows)
            .unwrap_err()
            .to_string();
        assert!(err.contains("LOCALAPPDATA"), "{err}");
        assert!(err.contains("USERPROFILE"), "{err}");
    }

    #[test]
    fn a_windows_data_directory_is_not_measured_against_sun_path() {
        // The Windows endpoint is a pipe name hashed from this path, so
        // its length is fixed however long the path is. A deep profile
        // directory that would blow the 103-byte socket budget is
        // perfectly fine there, and `socket_path` only applies the check
        // on unix for exactly this reason.
        let deep = format!(r"C:\Users\{}\AppData\Local", "a".repeat(80));
        let dir = resolve_app_support_dir(None, None, os(&deep), None, HostOs::Windows).unwrap();
        let socket = dir.join("daemon.sock");
        assert!(socket.as_os_str().as_encoded_bytes().len() > SUN_PATH_MAX);
        assert!(crate::transport::pipe_name_for_path(&socket).len() < 64);
    }

    #[test]
    fn the_socket_fits_sun_path_under_a_long_xdg_data_home() {
        // The budget, stated as a test because nothing else reports it:
        // bind() answers an over-long path with EINVAL on macOS and
        // ENAMETOOLONG on Linux, and neither mentions a length. Linux
        // adds "/gavin/daemon.sock" (18 bytes) to the data home against
        // macOS's "/Library/Application Support/gavin/daemon.sock" (46),
        // so the XDG layout is the roomier of the two -- a data home as
        // long as this one still leaves headroom.
        let long = format!("/home/{}/.local/share", "a".repeat(60));
        assert_eq!(long.len(), 79);
        let socket = resolve_app_support_dir(None, os(&long), None, None, HostOs::Xdg).unwrap().join("daemon.sock");
        let len = socket.as_os_str().as_encoded_bytes().len();
        assert!(len <= SUN_PATH_MAX, "{} is {len} bytes", socket.display());
        assert!(check_sun_path(&socket).is_ok());
    }

    #[test]
    fn an_over_long_socket_path_is_refused_with_the_limit_in_the_message() {
        let long = format!("/{}", "a".repeat(SUN_PATH_MAX));
        let socket = PathBuf::from(long).join("daemon.sock");
        let err = check_sun_path(&socket).unwrap_err().to_string();
        assert!(err.contains(&SUN_PATH_MAX.to_string()), "{err}");
        assert!(err.contains("XDG_DATA_HOME"), "{err}");
    }
}
