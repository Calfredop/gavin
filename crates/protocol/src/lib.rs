use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, Read, Write};

/// Cap on a single protocol line, so a client that never sends a newline
/// can't grow the daemon's read buffer unbounded.
const MAX_LINE_BYTES: u64 = 1024 * 1024;

/// Bumped on ANY wire-breaking change. The daemon reports it via
/// Request::GetProtocolVersion; the app (at bootstrap) and gavin-mcp (at
/// connect) probe it and turn mismatches -- including the
/// connection-close an older daemon produces when it can't parse the
/// probe at all -- into actionable "restart the daemon" errors instead of
/// mysteries (see the 2026-08-07 stale-daemon incident).
///
/// v15 widened `Stage` with `mode` and `name` (grouping spec G1). Both are
/// `serde(default)`, so no Request variant changed and `min_version_for`
/// is untouched -- the gate that matters is the app's
/// FEATURE_MIN_VERSION.groups, because a v14 daemon parses the request
/// fine and then drops both fields on the floor.
pub const PROTOCOL_VERSION: u32 = 15;

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
    WriteInput {
        id: String,
        data: String,
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
    /// Writes one key of `.gavin-root/config.toml`'s `[agent]` table.
    /// Allow-listed to profile/file/command/mcp_file/mcp_format -- like
    /// SetPlanFrontmatterField this must never become an arbitrary-key
    /// writer into a file the user hand-edits.
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
    },
    /// The SQLite board of the WATCHED workspace whose root matches.
    GetBoardByRoot {
        root_path: String,
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
    /// Upserts a card file's live session binding (by workspace + path).
    LinkCardSession {
        workspace_id: String,
        path: String,
        session_id: String,
        cwd: String,
        command: Option<String>,
    },
    UnlinkCardSession {
        workspace_id: String,
        path: String,
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

        Request::Shutdown => 12,

        // The archive (`plans/archive/`). v13 also widened PlanFileInfo
        // with `modified_at`, which the archive grid orders by -- that
        // one is `serde(default)`, so it costs an older DAEMON nothing;
        // these two variants are what a v12 daemon genuinely cannot
        // serve, and daemonCompat.ts gates the UI on `archive: 13`.
        Request::ArchiveCard { .. } | Request::UnarchiveCard { .. } => 13,

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
    Board { columns: Vec<Column>, labels: Vec<Label>, card_sessions: Vec<CardSession> },
    DirtyPaths { paths: Vec<String>, truncated: bool },
    Orchestration {
        rails: Vec<Rail>,
        conflict_notes: Vec<ConflictNote>,
        rail_runs: Vec<RailRun>,
        step_runs: Vec<StepRun>,
    },
    Tools { tools: Vec<ToolDef> },
    GavinTreeSnapshot { workspace_id: String, tree: GavinTree },
    GavinTreeChanged { workspace_id: String, tree: GavinTree },
    /// Pushed on the watching connection after any SetOrchestration, so
    /// an agent's rewrite lands in the open tab without a poll. Run-state
    /// writes deliberately do NOT push: they always originate in the app
    /// that already holds the state.
    OrchestrationChanged { workspace_id: String, orchestration: Orchestration },
    GavinTreeScanned { tree: GavinTree },
    PrdContent { content: String },
    PlanCreated { path: String },
    AgentSessionSpawned { workspace_id: String, session_id: String, cwd: String, command: String },
    /// Push: an agent renamed its own tab. The app applies it through the
    /// very same path a human rename takes.
    SessionNamed { session_id: String, name: String },
    ProtocolVersion { version: u32 },
    TaskPromoted { path: String },
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
    pub page_id: Option<String>,
    pub stages: Vec<Stage>,
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
    /// pending | running | done | stalled
    pub state: String,
    pub session_id: Option<String>,
    /// Human-readable stall cause; None otherwise.
    pub reason: Option<String>,
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

use std::path::PathBuf;

pub fn app_support_dir() -> PathBuf {
    let home = std::env::var("HOME").expect("HOME not set");
    PathBuf::from(home)
        .join("Library")
        .join("Application Support")
        .join("gavin")
}

pub fn socket_path() -> PathBuf {
    app_support_dir().join("daemon.sock")
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
                        "modifiedAt": null
                    }],
                    "docs": [{ "path": "/tmp/ws/.gavin-root/docs/notes.md", "relPath": "notes.md" }],
                    "specs": [],
                    "hasPrd": true,
                    "configWarning": false,
                    "agent": null,
                    "outside": false
                }]
            })
        );
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
            }),
            outside: false,
        };
        let json = serde_json::to_value(&ctx).unwrap();
        assert_eq!(
            json["agent"],
            serde_json::json!({
                "profile": "claude-code",
                "file": null,
                "command": "claude --model opus",
                "mcpFile": null,
                "mcpFormat": null,
                "model": "sonnet"
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
        assert_eq!(PROTOCOL_VERSION, 15);
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
    fn shutdown_is_a_v12_request() {
        assert_eq!(min_version_for(&Request::Shutdown), 12);
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
            session_id: "s-1".into(), name: "login flow".into(),
        }), 10);
    }

    #[test]
    fn no_variant_claims_a_version_beyond_the_current_one() {
        // Guards the table against a typo that would make a request unsendable.
        assert!(min_version_for(&Request::NameSession {
            session_id: "s-1".into(),
            name: "login flow".into(),
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
            Request::GetGavinTree { workspace_id: "w".into() },
            Request::InitGavinRoot { root_path: "r".into(), workspace_name: "n".into() },
            Request::CreateGavinContext { parent_folder: "p".into() },
            Request::AddExternalGavinContext { root_path: "r".into(), folder: "f".into() },
            Request::RemoveExternalGavinContext { root_path: "r".into(), folder: "f".into() },
            Request::SetPlanFrontmatterField { path: "p".into(), key: "k".into(), value: "v".into() },
            Request::SetRootConfigField { root_path: "r".into(), key: "k".into(), value: "v".into() },
            Request::ScanGavinRoot { root_path: "r".into() },
            Request::ReadPrd { root_path: "r".into() },
            Request::CreatePlan {
                context_folder: "c".into(),
                file_name: "f".into(),
                title: "t".into(),
                status: None,
                priority: None,
                body: None,
                kind: None,
                parent: None,
            },
            Request::GetBoardByRoot { root_path: "r".into() },
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
            },
            Request::UnlinkCardSession { workspace_id: "w".into(), path: "p".into() },
            Request::GetOrchestration { workspace_id: "w".into() },
            Request::SetOrchestration { workspace_id: "w".into(), rails: vec![], conflict_notes: vec![] },
            Request::SetRailRun { rail_id: "r".into(), state: "idle".into(), current_stage_id: None },
            Request::SetStepRun { step_id: "s".into(), state: "pending".into(), session_id: None, reason: None },
            Request::GetOrchestrationByRoot { root_path: "r".into() },
            Request::SetOrchestrationByRoot { root_path: "r".into(), rails: vec![], conflict_notes: vec![] },
            Request::GitDirtyPaths { cwd: "c".into(), limit: 10 },
            Request::NameSession { session_id: "s".into(), name: "n".into() },
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
                },
            },
            Request::DeleteTool { id: "t".into() },
            Request::ArchiveCard { path: "/p/t.md".into() },
            Request::UnarchiveCard { path: "/p/t.md".into() },
            Request::Shutdown,
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
    /// v11=4, v12=1 (Shutdown), v13=2 (the archive), plus Unknown.
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
        expected.insert(u32::MAX, 1); // Request::Unknown

        assert_eq!(
            counts, expected,
            "a version band's variant count changed -- if you just added a \
             Request variant, make sure you also considered whether \
             PROTOCOL_VERSION needs bumping (see this test's doc comment)"
        );
    }

    #[test]
    fn card_session_serializes_to_the_camel_case_shape_the_frontend_expects() {
        let cs = CardSession {
            path: "/p/t.md".to_string(),
            session_id: "s-1".to_string(),
            cwd: "/p".to_string(),
            command: None,
        };
        assert_eq!(
            serde_json::to_value(&cs).unwrap(),
            serde_json::json!({ "path": "/p/t.md", "sessionId": "s-1", "cwd": "/p", "command": null })
        );
        let mut buf = Vec::new();
        write_message(&mut buf, &Request::LinkCardSession {
            workspace_id: "ws".to_string(),
            path: "/p/t.md".to_string(),
            session_id: "s-1".to_string(),
            cwd: "/p".to_string(),
            command: Some("claude 'x'".to_string()),
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
        };
        write_message(&mut buf, &req).unwrap();
        let mut cursor = Cursor::new(buf);
        let decoded: Request = read_message(&mut cursor).unwrap().unwrap();
        match decoded {
            Request::CreatePlan { context_folder, file_name, title, status, priority, body, kind, parent } => {
                assert_eq!(kind.as_deref(), Some("task"));
                assert_eq!(parent.as_deref(), Some("auth-plan.md"));
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
            },
        )
        .unwrap();
        let mut cursor = Cursor::new(buf);
        match read_message::<_, Request>(&mut cursor).unwrap().unwrap() {
            Request::NameSession { session_id, name } => {
                assert_eq!(session_id, "s-1");
                assert_eq!(name, "login flow");
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
        };
        assert_eq!(
            serde_json::to_value(&run).unwrap(),
            serde_json::json!({ "stepId": "t1", "state": "running", "sessionId": "sess-1", "reason": null })
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
                "position": 0
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
}
