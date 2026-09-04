use protocol::{read_message, write_message, Request, Response, PROTOCOL_VERSION};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};

// ---------- daemon transport ----------

pub trait DaemonTransport {
    fn request(&mut self, req: &Request) -> anyhow::Result<Response>;
}

/// A daemon too old to parse the version probe answers nothing and closes
/// the connection. Per the 2026-08-07 stale-daemon incident that failure
/// SHAPE has to land on a named, actionable state rather than a mystery,
/// so it maps to the same message as an explicit below-floor version.
const UNREACHABLE: &str =
    "the gavin daemon is too old to talk to this gavin-mcp — restart it from the gavin app";

/// A live daemon connection together with the protocol version the daemon
/// on it advertised, held in ONE value so a version can never outlive the
/// connection it was negotiated on. `connect` is the only constructor and
/// it always probes, so every reconnect re-negotiates: a daemon replaced
/// mid-session is gated against what is running NOW, not against what
/// answered at startup. (The app keeps the two apart and has a documented
/// gap to match -- see `send_command_reconnecting_at` in
/// `app/src-tauri/src/session.rs`.)
struct Connection {
    reader: BufReader<UnixStream>,
    daemon_version: u32,
}

/// Lazy persistent connection to the daemon socket. Every fresh connect
/// runs the version probe (spec §4) and sorts the answer into the same
/// three-way band the app uses (`protocol::version_band`): a daemon inside
/// the window is USED, with the requests it predates gated off, rather
/// than refused outright.
struct SocketTransport {
    socket_path: PathBuf,
    conn: Option<Connection>,
}

impl SocketTransport {
    fn new() -> Self {
        Self::at(protocol::socket_path())
    }

    /// Takes the socket path rather than resolving one itself, so the
    /// connect/probe/gate path stays directly testable against a throwaway
    /// tempdir socket -- the same seam `send_command_reconnecting_at` uses
    /// on the app side. The alternative, a test overriding `$HOME` to move
    /// `protocol::socket_path()`, would be racing every other test in the
    /// process for one global.
    fn at(socket_path: PathBuf) -> Self {
        Self { socket_path, conn: None }
    }

    fn connect(&mut self) -> anyhow::Result<()> {
        // Dropped before the probe, not after it: a failed connect must
        // not leave the previous daemon's version behind for the gate.
        self.conn = None;
        let stream = UnixStream::connect(&self.socket_path)
            .map_err(|_| anyhow::anyhow!("gavin daemon isn't running — open the gavin app"))?;
        let mut reader = BufReader::new(stream);
        write_message(reader.get_mut(), &Request::GetProtocolVersion)
            .map_err(|_| anyhow::anyhow!("gavin daemon isn't running — open the gavin app"))?;
        let version = match read_message::<_, Response>(&mut reader) {
            Ok(Some(Response::ProtocolVersion { version })) => version,
            _ => anyhow::bail!(UNREACHABLE),
        };
        match protocol::version_band(version, PROTOCOL_VERSION, protocol::MIN_COMPATIBLE_VERSION) {
            // Stays a hard error, as it is for the app: an unreleased
            // protocol cannot be guessed at. Phase 2 of the compat work
            // replaces this arm with a self re-exec (spec §3).
            protocol::VersionBand::DaemonNewer => anyhow::bail!(
                "the gavin daemon is newer than this gavin-mcp (v{version} vs v{PROTOCOL_VERSION}) — update gavin, then restart this Claude Code session"
            ),
            protocol::VersionBand::DaemonTooOld => anyhow::bail!(
                "the gavin daemon is too old to use (v{version}, minimum v{}) — restart it from the gavin app",
                protocol::MIN_COMPATIBLE_VERSION
            ),
            // Degraded or at parity, the connection is the same; what
            // differs is only which requests the gate below lets through.
            protocol::VersionBand::Usable { .. } => {
                self.conn = Some(Connection { reader, daemon_version: version });
                Ok(())
            }
        }
    }

    fn request_once(&mut self, req: &Request) -> anyhow::Result<Response> {
        if self.conn.is_none() {
            self.connect()?;
        }
        let conn = self.conn.as_mut().unwrap();
        // Gated HERE -- after connect, which is what learns the version,
        // and before a single byte leaves. Inside `request_once` rather
        // than once in `request` so the reconnect below re-gates against
        // the daemon it actually lands on, which need not be the one the
        // first attempt talked to.
        protocol::gate_request(req, conn.daemon_version)?;
        write_message(conn.reader.get_mut(), req)?;
        match read_message::<_, Response>(&mut conn.reader)? {
            Some(resp) => Ok(resp),
            None => anyhow::bail!("daemon closed the connection"),
        }
    }
}

impl DaemonTransport for SocketTransport {
    fn request(&mut self, req: &Request) -> anyhow::Result<Response> {
        match self.request_once(req) {
            Ok(resp) => Ok(resp),
            // A gated request never reached the socket, so there is
            // nothing for a reconnect to fix -- and retrying would throw
            // away the one message that says which version is missing, in
            // favour of whatever the second attempt happened to fail on.
            Err(e) if e.is::<protocol::GatedRequest>() => Err(e),
            Err(_) => {
                // One reconnect per call: the daemon may have restarted.
                self.conn = None;
                self.request_once(req)
            }
        }
    }
}

use std::collections::{HashMap, HashSet};

/// Cap on dirty paths reported per worktree (spec §8.1). Evidence, not
/// an inventory -- a hundred-file diff tells the agent what it needs.
const DIRTY_PATH_LIMIT: u32 = 200;

// ---------- root resolution ----------

/// Walks up from `start` to the nearest directory containing .gavin-root.
fn find_gavin_root(start: &Path) -> Option<PathBuf> {
    let mut current = Some(start);
    while let Some(dir) = current {
        if dir.join(".gavin-root").is_dir() {
            return Some(dir.to_path_buf());
        }
        current = dir.parent();
    }
    None
}

/// Absolute as-is; relative resolved against the gavin root (spec §2).
fn resolve_against_root(root: &Path, input: &str) -> PathBuf {
    let p = Path::new(input);
    if p.is_absolute() {
        p.to_path_buf()
    } else {
        root.join(p)
    }
}

// ---------- tools ----------

const NOT_IN_WORKSPACE: &str =
    "not inside a gavin workspace (no .gavin-root above the current directory) — run gavin_init_root first";

fn tool_definitions() -> Value {
    json!([
        { "name": "gavin_get_tree", "description": "The gavin workspace's contexts and plan files (canonical parse, incl. statuses and warnings).", "inputSchema": { "type": "object", "properties": {} } },
        { "name": "gavin_read_prd", "description": "Read the workspace PRD — the lead document for all development.", "inputSchema": { "type": "object", "properties": {} } },
        { "name": "gavin_create_plan", "description": "Create a card file (note, task, or plan) in a gavin context with canonical frontmatter. Never overwrites. Creating one In Progress claims it for your session, so the board stops offering to start a second agent on it.", "inputSchema": { "type": "object", "properties": {
            "context_folder": { "type": "string", "description": "Folder that is the root or contains .gavin (relative allowed)" },
            "file_name": { "type": "string", "description": "kebab-case-name.md" },
            "title": { "type": "string" },
            "status": { "type": "string", "description": "Board column name; default To Do (omitted on a task with a parent: it nests)" },
            "priority": { "type": "string", "enum": ["none", "low", "medium", "high", "urgent"] },
            "body": { "type": "string", "description": "For kind task this IS the agent prompt" },
            "kind": { "type": "string", "enum": ["note", "task", "plan"], "description": "Default plan" },
            "parent": { "type": "string", "description": "Parent plan's file name (kind task only); no status -> nests inside it" },
            "attachments": { "type": "string", "description": "Comma-separated files the card points at; relative resolves against the workspace root, absolute is kept as-is" }
        }, "required": ["context_folder", "file_name", "title"] } },
        { "name": "gavin_set_plan_field", "description": "Update one frontmatter field (status, priority, or integer order) of a plan file, preserving every other byte. Setting status to In Progress claims the card for your session, so the board stops offering to start a second agent on it — write it when you START, not only when you finish. Setting status to Done files the card under plans/done/ (and any status off Done brings it back); the reply carries the card's path afterwards.", "inputSchema": { "type": "object", "properties": {
            "path": { "type": "string" },
            "key": { "type": "string", "enum": ["status", "priority", "order"] },
            "value": { "type": "string" }
        }, "required": ["path", "key", "value"] } },
        { "name": "gavin_create_context", "description": "Turn a folder into a gavin context (.gavin scaffold) for a feature/library.", "inputSchema": { "type": "object", "properties": {
            "parent_folder": { "type": "string" }
        }, "required": ["parent_folder"] } },
        { "name": "gavin_init_root", "description": "Initialize .gavin-root (PRD template, plans/docs/specs) in a folder; idempotent, never overwrites.", "inputSchema": { "type": "object", "properties": {
            "path": { "type": "string", "description": "Defaults to the current directory" }
        } } },
        { "name": "gavin_get_board", "description": "The workspace kanban board: columns (the status vocabulary) and the human's free-form cards. Requires the workspace open in gavin.", "inputSchema": { "type": "object", "properties": {} } },
        { "name": "gavin_promote_task", "description": "Promote a plan's checklist item into a nested task card (rewrites the item into a link to the new file).", "inputSchema": { "type": "object", "properties": {
            "plan_path": { "type": "string" },
            "item": { "type": "string", "description": "The checklist item's exact text" }
        }, "required": ["plan_path", "item"] } },
        { "name": "gavin_get_orchestration", "description": "The workspace's orchestration: rails with their worktrees, branches and uncommitted files, stages, steps with their cards or tools and live run state, the board's columns, every runnable card not yet on a rail (a plan's nested children ride with it and are not listed separately), and the tool library. Read this before writing an arrangement. Requires the workspace open in gavin.", "inputSchema": { "type": "object", "properties": {} } },
        { "name": "gavin_set_orchestration", "description": "Replace the workspace's orchestration wholesale: rails of stages of steps, plus your own conflict notes. Read gavin_get_orchestration first and preserve the ids of steps you are keeping — run state follows the id — AND each stage's `mode` and `name`: omitting `mode` reverts that stage to `parallel`, which turns a sequential group into steps that all run at once in one checkout. Removing a step whose run state is 'running' is refused.", "inputSchema": { "type": "object", "properties": {
            "rails": { "type": "array", "description": "Ordered rails. Each: { id, name, position, worktreePath, branch, pageId, stages: [{ id, position, mode, name, steps: [...] }] }. A step is EITHER a card step { id, position, cardPath } OR a tool step { id, position, toolId, toolParams: { name: value } } — never both. Stages run one after another. A stage's `mode` is \"parallel\" (its steps run at once in the rail's checkout) or \"sequence\" (one at a time, in position order); a stage of two or more steps is what the app calls a GROUP, and `name` is what it is called. `mode` defaults to \"parallel\" when omitted. `worktreePath` says WHICH CHECKOUT (null = the workspace root), `branch` says WHICH BRANCH gavin puts that checkout on before launching a step (null = whatever is checked out) — so a branch with no worktree means the root checkout on that branch, no separate folder.", "items": { "type": "object" } },
            "conflict_notes": { "type": "array", "description": "Your judgements, shown to the human in the Conflicts box. Each: { id, stepIds: [...], note }.", "items": { "type": "object" } }
        }, "required": ["rails"] } },
        { "name": "gavin_start_rail", "description": "Arm a rail by NAME, exactly as the human's Start button does: gavin runs it from its first unfinished stage, on the rail's own page. Refuses a name no rail has, a name two rails share, and a PAUSED rail (a pause is a human's or a stalled step's, and resuming it is theirs). A rail already running is left alone — starting it would rewind it — and so is one with nothing unfinished; both answer with what they are, not an error. Never write run state to the daemon socket yourself. Requires the workspace open in gavin.", "inputSchema": { "type": "object", "properties": {
            "rail": { "type": "string", "description": "The rail's name as gavin_get_orchestration reports it; matched case- and space-insensitively" }
        }, "required": ["rail"] } },
        { "name": "gavin_spawn_session", "description": "Spawn a terminal session in the gavin app (visible to the human on the Agents page). Requires the workspace open in gavin.", "inputSchema": { "type": "object", "properties": {
            "command": { "type": "string", "description": "Program to run, e.g. claude" },
            "cwd": { "type": "string", "description": "Defaults to the workspace root" }
        }, "required": ["command"] } },
        { "name": "gavin_name_session", "description": "Name your own tab in the gavin app — do this first, so the human can tell your session apart from every other one. Short and specific: what this session is working on, not who you are.", "inputSchema": { "type": "object", "properties": {
            "name": { "type": "string", "description": "2-4 words, e.g. \"login flow\" or \"git tab conflicts\"" }
        }, "required": ["name"] } }
    ])
}

fn str_arg(args: &Value, key: &str) -> Option<String> {
    args.get(key).and_then(|v| v.as_str()).map(|s| s.to_string())
}

fn require_arg(args: &Value, key: &str) -> anyhow::Result<String> {
    str_arg(args, key).ok_or_else(|| anyhow::anyhow!("missing required argument: {key}"))
}

/// Maps one tool call to a daemon request, shapes the result as text.
fn dispatch_tool(
    name: &str,
    args: &Value,
    root: Option<&Path>,
    transport: &mut dyn DaemonTransport,
) -> anyhow::Result<String> {
    // Naming a tab needs no root at all, only the session id the PTY
    // exported: the agent may well be standing in a rail's worktree,
    // which is outside the workspace root (and, in a repo whose
    // .gavin-root is not checked out there, not under one at all).
    if name == "gavin_name_session" {
        return name_session(
            &require_arg(args, "name")?,
            current_session_id(),
            transport,
        );
    }

    // gavin_init_root is the only other tool that works without a
    // resolved root.
    if name == "gavin_init_root" {
        let cwd = std::env::current_dir()?;
        let path = str_arg(args, "path")
            .map(|p| resolve_against_root(&cwd, &p))
            .unwrap_or(cwd);
        let workspace_name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "workspace".to_string());
        let resp = transport.request(&Request::InitGavinRoot {
            root_path: path.to_string_lossy().to_string(),
            workspace_name,
        })?;
        return match resp {
            Response::Ok => Ok(format!("initialized gavin root at {}", path.display())),
            Response::Error { message } => Err(anyhow::anyhow!(message)),
            other => Err(anyhow::anyhow!("unexpected response: {other:?}")),
        };
    }

    let root = root.ok_or_else(|| anyhow::anyhow!(NOT_IN_WORKSPACE))?;
    let root_str = root.to_string_lossy().to_string();

    if name == "gavin_get_orchestration" {
        return get_orchestration(root, transport);
    }

    // Its own path for the same reason `gavin_get_orchestration` has
    // one: it is not one request but a read, a decision and a write.
    if name == "gavin_start_rail" {
        return start_rail(root, &require_arg(args, "rail")?, transport);
    }

    let req = match name {
        "gavin_get_tree" => Request::ScanGavinRoot { root_path: root_str },
        "gavin_read_prd" => Request::ReadPrd { root_path: root_str },
        "gavin_create_plan" => Request::CreatePlan {
            context_folder: resolve_against_root(root, &require_arg(args, "context_folder")?)
                .to_string_lossy()
                .to_string(),
            file_name: require_arg(args, "file_name")?,
            title: require_arg(args, "title")?,
            status: str_arg(args, "status"),
            priority: str_arg(args, "priority"),
            body: str_arg(args, "body"),
            kind: str_arg(args, "kind"),
            parent: str_arg(args, "parent"),
            attachments: str_arg(args, "attachments"),
        },
        "gavin_set_plan_field" => Request::SetPlanFrontmatterField {
            path: resolve_against_root(root, &require_arg(args, "path")?)
                .to_string_lossy()
                .to_string(),
            key: require_arg(args, "key")?,
            value: require_arg(args, "value")?,
        },
        "gavin_create_context" => Request::CreateGavinContext {
            parent_folder: resolve_against_root(root, &require_arg(args, "parent_folder")?)
                .to_string_lossy()
                .to_string(),
        },
        "gavin_get_board" => Request::GetBoardByRoot { root_path: root_str },
        "gavin_promote_task" => Request::PromoteChecklistItem {
            plan_path: resolve_against_root(root, &require_arg(args, "plan_path")?)
                .to_string_lossy()
                .to_string(),
            item: require_arg(args, "item")?,
        },
        "gavin_set_orchestration" => {
            // Deserialized here rather than in the daemon so malformed
            // input answers the agent directly, with serde's own message,
            // and never reaches the store.
            let rails: Vec<protocol::Rail> =
                serde_json::from_value(args.get("rails").cloned().unwrap_or(Value::Null))
                    .map_err(|e| anyhow::anyhow!("rails: {e}"))?;
            let conflict_notes: Vec<protocol::ConflictNote> = match args.get("conflict_notes") {
                Some(v) if !v.is_null() => serde_json::from_value(v.clone())
                    .map_err(|e| anyhow::anyhow!("conflict_notes: {e}"))?,
                _ => vec![],
            };
            Request::SetOrchestrationByRoot { root_path: root_str, rails, conflict_notes }
        }
        "gavin_spawn_session" => Request::SpawnAgentSession {
            root_path: root_str.clone(),
            cwd: str_arg(args, "cwd")
                .map(|c| resolve_against_root(root, &c).to_string_lossy().to_string())
                .unwrap_or(root_str),
            command: require_arg(args, "command")?,
        },
        other => anyhow::bail!("unknown tool: {other}"),
    };

    // Kept so a moved card can be reported as moved: an agent that just
    // marked its own plan Done needs to know the file is under done/ now.
    let requested_path = match &req {
        Request::SetPlanFrontmatterField { path, .. } => Some(path.clone()),
        _ => None,
    };
    let resp = transport.request(&req)?;
    // Before the reply is shaped, and its outcome deliberately dropped:
    // see `claim_card`.
    if let Some(card) = claim_target(&req, &resp) {
        claim_card(root, &card, current_session_id(), transport);
    }
    match resp {
        Response::GavinTreeScanned { tree } => Ok(serde_json::to_string_pretty(&tree)?),
        Response::PrdContent { content } => Ok(content),
        Response::PlanCreated { path } => Ok(format!("created plan: {path}")),
        Response::TaskPromoted { path } => Ok(format!("promoted to task card: {path}")),
        Response::Board { columns, labels, card_sessions: _ } => {
            Ok(serde_json::to_string_pretty(&json!({ "columns": columns, "labels": labels }))?)
        }
        Response::SessionCreated { id } => {
            Ok(format!("spawned session {id} — visible on the Agents page in gavin"))
        }
        Response::PlanFieldSet { path } => Ok(match requested_path {
            Some(before) if before != path => format!("ok — the card now lives at {path}"),
            _ => "ok".to_string(),
        }),
        Response::Ok => Ok("ok".to_string()),
        Response::Error { message } => Err(anyhow::anyhow!(message)),
        other => Err(anyhow::anyhow!("unexpected response: {other:?}")),
    }
}

/// A tab label, not a sentence: one line, collapsed whitespace, and
/// short enough that the tab still shows the beginning of it. An agent
/// handed a whole task description would otherwise push every other tab
/// off the bar.
const MAX_SESSION_NAME: usize = 40;

fn clean_session_name(raw: &str) -> anyhow::Result<String> {
    let collapsed = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        anyhow::bail!("name is empty");
    }
    // char_indices, not byte slicing: a truncated multi-byte character
    // would panic.
    let truncated = match collapsed.char_indices().nth(MAX_SESSION_NAME) {
        Some((byte, _)) => format!("{}…", &collapsed[..byte]),
        None => collapsed,
    };
    Ok(truncated)
}

/// The session this MCP server is running inside, injected into every PTY
/// the daemon spawns (pty.rs). Absent means the agent is not in a gavin
/// tab at all -- a bare `claude` in a terminal, or a test.
fn current_session_id() -> Option<String> {
    std::env::var("GAVIN_SESSION_ID").ok().filter(|v| !v.is_empty())
}

/// The card this tool call just put in the calling session's hands, if
/// it put one there at all.
///
/// Two writes qualify, and they are the two an agent makes when it
/// starts work on its own initiative: filing a card straight into In
/// Progress, and moving an existing one there. Both report the path the
/// card ended up at, which is the one to claim -- a status write can
/// file the card under `plans/done/`, and the binding keys on where the
/// file IS.
///
/// The status VALUE is not read here. "In Progress" is the board's
/// column name and the human may have renamed the columns around it, so
/// the daemon decides from the card on disk (`claim_card_for_session`)
/// and this side only decides *which* card it just wrote.
fn claim_target(req: &Request, resp: &Response) -> Option<String> {
    match (req, resp) {
        (Request::CreatePlan { .. }, Response::PlanCreated { path }) => Some(path.clone()),
        (Request::SetPlanFrontmatterField { key, .. }, Response::PlanFieldSet { path })
            if key == "status" =>
        {
            Some(path.clone())
        }
        _ => None,
    }
}

/// Tells the daemon that this session is working the card it just wrote,
/// so the board stops offering to start a second agent on it.
///
/// Every failure is swallowed on purpose. The agent asked for a card
/// write and got one; the claim is bookkeeping it neither requested nor
/// can act on, and turning "your workspace is not open in gavin" or a
/// daemon too old to know the request into a failed `gavin_create_plan`
/// would break card filing for everyone to fix a board affordance. An
/// un-claimed card is exactly the card every daemon before v21 produced.
fn claim_card(
    root: &Path,
    path: &str,
    session_id: Option<String>,
    transport: &mut dyn DaemonTransport,
) {
    let Some(session_id) = session_id else { return };
    let _ = transport.request(&Request::ClaimCardForSession {
        root_path: root.to_string_lossy().to_string(),
        path: path.to_string(),
        session_id,
    });
}

const NOT_IN_A_SESSION: &str =
    "not running in a gavin session (no GAVIN_SESSION_ID) — only an agent in a gavin tab can name one";

fn name_session(
    raw_name: &str,
    session_id: Option<String>,
    transport: &mut dyn DaemonTransport,
) -> anyhow::Result<String> {
    let session_id = session_id.ok_or_else(|| anyhow::anyhow!(NOT_IN_A_SESSION))?;
    let name = clean_session_name(raw_name)?;
    let resp = transport.request(&Request::NameSession { session_id, name: name.clone() })?;
    match resp {
        Response::Ok => Ok(format!("named this tab \"{name}\"")),
        Response::Error { message } => Err(anyhow::anyhow!(message)),
        other => Err(anyhow::anyhow!("unexpected response: {other:?}")),
    }
}

/// Whether this card is DRAWN INSIDE another's: `kind: task`, a
/// `parent:` that is not itself, no `status:` of its own, and a parent
/// that resolves to a plan in the same context. The conditions the board
/// nests on (`mergePlanCards`) and the orchestration tab reads through
/// (`nestedParent` in orchestration.ts), spelled once here.
///
/// A `parent:` that resolves to nothing, to a task, or to the card
/// itself is NOT nesting -- the board draws such a card in its own
/// column wearing a broken-parent mark, so it is its own unit of work.
fn is_nested(plan: &protocol::PlanFileInfo, plans_in_context: &HashSet<&str>) -> bool {
    if plan.status.is_some() || !matches!(plan.kind, protocol::CardKind::Task) {
        return false;
    }
    match plan.parent.as_deref() {
        Some(parent) => parent != plan.file_name && plans_in_context.contains(parent),
        None => false,
    }
}

fn kind_str(kind: &protocol::CardKind) -> &'static str {
    match kind {
        protocol::CardKind::Note => "note",
        protocol::CardKind::Task => "task",
        protocol::CardKind::Plan => "plan",
    }
}

/// Composed from four daemon calls rather than one fat protocol
/// response: the wire types stay honest, and the payload is shaped for
/// an agent (titles resolved, run state folded onto steps, unplaced
/// cards offered).
///
/// It carries FACTS, not gavin's computed conflict list -- that lives in
/// the app's TypeScript, and a second Rust implementation of the same
/// rule would be free to drift from the one the human sees. The skill
/// states the rule instead.
fn get_orchestration(root: &Path, transport: &mut dyn DaemonTransport) -> anyhow::Result<String> {
    let root_str = root.to_string_lossy().to_string();

    let (rails, conflict_notes, rail_runs, step_runs) = match transport
        .request(&Request::GetOrchestrationByRoot { root_path: root_str.clone() })?
    {
        Response::Orchestration { rails, conflict_notes, rail_runs, step_runs } => {
            (rails, conflict_notes, rail_runs, step_runs)
        }
        Response::Error { message } => return Err(anyhow::anyhow!(message)),
        other => return Err(anyhow::anyhow!("unexpected response: {other:?}")),
    };

    let columns = match transport.request(&Request::GetBoardByRoot { root_path: root_str.clone() })? {
        Response::Board { columns, .. } => columns,
        Response::Error { message } => return Err(anyhow::anyhow!(message)),
        other => return Err(anyhow::anyhow!("unexpected response: {other:?}")),
    };
    // The done column is the highest POSITION, not the last element --
    // the array's order is not the board's order.
    let done_column = columns.iter().max_by_key(|c| c.position).map(|c| c.name.clone());

    let tools = match transport.request(&Request::GetToolsByRoot { root_path: root_str.clone() })? {
        Response::Tools { tools } => tools,
        Response::Error { message } => return Err(anyhow::anyhow!(message)),
        other => return Err(anyhow::anyhow!("unexpected response: {other:?}")),
    };

    let tree = match transport.request(&Request::ScanGavinRoot { root_path: root_str })? {
        Response::GavinTreeScanned { tree } => tree,
        Response::Error { message } => return Err(anyhow::anyhow!(message)),
        other => return Err(anyhow::anyhow!("unexpected response: {other:?}")),
    };

    let mut cards: HashMap<&str, &protocol::PlanFileInfo> = HashMap::new();
    for ctx in &tree.contexts {
        for plan in &ctx.plans {
            cards.insert(plan.path.as_str(), plan);
        }
    }
    let run_of: HashMap<&str, &protocol::StepRun> =
        step_runs.iter().map(|r| (r.step_id.as_str(), r)).collect();
    let rail_run_of: HashMap<&str, &protocol::RailRun> =
        rail_runs.iter().map(|r| (r.rail_id.as_str(), r)).collect();

    // One GitDirtyPaths per DISTINCT worktree: several rails may share
    // one, and re-running git per rail would be pure waste.
    let mut dirty: HashMap<String, (Vec<String>, bool)> = HashMap::new();
    for rail in &rails {
        let Some(path) = rail.worktree_path.clone() else { continue };
        if dirty.contains_key(&path) {
            continue;
        }
        let entry = match transport
            .request(&Request::GitDirtyPaths { cwd: path.clone(), limit: DIRTY_PATH_LIMIT })?
        {
            Response::DirtyPaths { paths, truncated } => (paths, truncated),
            // A worktree git cannot read yields empty evidence rather
            // than failing the whole payload.
            _ => (vec![], false),
        };
        dirty.insert(path, entry);
    }

    // Its own pass: mutating a set inside the nested map closures below
    // would mean reborrowing it through two FnMut layers for no gain.
    let placed: HashSet<&str> = rails
        .iter()
        .flat_map(|r| r.stages.iter())
        .flat_map(|s| s.steps.iter())
        .filter(|t| t.tool_id.is_none())
        .map(|t| t.card_path.as_str())
        .collect();

    let tool_by_id: HashMap<&str, &protocol::ToolDef> =
        tools.iter().map(|t| (t.id.as_str(), t)).collect();

    let rails_json: Vec<Value> = rails
        .iter()
        .map(|rail| {
            let (paths, truncated) = rail
                .worktree_path
                .as_ref()
                .and_then(|p| dirty.get(p))
                .cloned()
                .unwrap_or_default();
            let stages: Vec<Value> = rail
                .stages
                .iter()
                .map(|stage| {
                    let steps: Vec<Value> = stage
                        .steps
                        .iter()
                        .map(|step| {
                            let run = run_of.get(step.id.as_str()).map(|r| r.state.clone())
                                .unwrap_or_else(|| "pending".to_string());
                            // A TOOL step (tools spec T1). Rendered by its
                            // tool rather than by a card it does not have,
                            // so an agent rewriting this rail carries the
                            // toolId through instead of inventing a card.
                            if let Some(tool_id) = &step.tool_id {
                                let tool = tool_by_id.get(tool_id.as_str());
                                return json!({
                                    "id": step.id,
                                    "toolId": tool_id,
                                    "toolName": tool.map(|t| t.name.clone()),
                                    "toolKind": tool.map(|t| t.kind.clone()),
                                    "toolParams": step.tool_params,
                                    "run": run,
                                });
                            }
                            let card = cards.get(step.card_path.as_str());
                            json!({
                                "id": step.id,
                                "cardPath": step.card_path,
                                "title": card.map(|c| c.title.clone()),
                                "kind": card.map(|c| kind_str(&c.kind)),
                                "status": card.and_then(|c| c.status.clone()),
                                "run": run,
                            })
                        })
                        .collect();
                    json!({
                        "id": stage.id,
                        "position": stage.position,
                        "mode": stage.mode,
                        "name": stage.name,
                        "steps": steps,
                    })
                })
                .collect();
            json!({
                "id": rail.id,
                "name": rail.name,
                "worktreePath": rail.worktree_path,
                "branch": rail.branch,
                "pageId": rail.page_id,
                "state": rail_run_of.get(rail.id.as_str()).map(|r| r.state.clone())
                    .unwrap_or_else(|| "idle".to_string()),
                "dirtyPaths": paths,
                "dirtyTruncated": truncated,
                "stages": stages,
            })
        })
        .collect();

    // What a rail can still take on. Notes are not runnable, and an
    // ARCHIVED card is not on the board at all -- the human filed it
    // away, so offering it back here would have the agent place work
    // they deliberately put down. Same rule as the tab's own drawer
    // (availableCards in orchestration.ts), matched the same way it is:
    // by the folder, since the folder IS the archive.
    //
    // A NESTED child is left out for the same reason the drawer leaves
    // it out: it has no card of its own on the board -- it is drawn
    // inside its plan's, and so is a rail step carrying that plan -- so
    // the plan is the unit of placement and listing the children beside
    // it offers the same work over again. This list is the AUTHORITATIVE
    // one (the tab's own Generate prompt tells the agent to read it), so
    // the two spellings of the rule have to agree.
    let unplaced: Vec<Value> = tree
        .contexts
        .iter()
        .flat_map(|ctx| {
            // Resolved per CONTEXT, on file_name: exactly the key the
            // board nests on (`planKey`), so a `parent:` naming a plan in
            // some other context does not nest here either.
            let plans_here: HashSet<&str> = ctx
                .plans
                .iter()
                .filter(|p| matches!(p.kind, protocol::CardKind::Plan))
                .map(|p| p.file_name.as_str())
                .collect();
            ctx.plans.iter().filter(move |p| !is_nested(p, &plans_here))
        })
        .filter(|p| !matches!(p.kind, protocol::CardKind::Note))
        .filter(|p| !p.path.contains("/plans/archive/"))
        .filter(|p| !placed.contains(p.path.as_str()))
        .map(|p| {
            json!({
                "path": p.path,
                "title": p.title,
                "kind": kind_str(&p.kind),
                "status": p.status,
            })
        })
        .collect();

    // The tool library, so an arrangement can PLACE a tool rather than
    // only preserve one. Bodies are deliberately absent: what the agent
    // needs is which tools exist and what each takes, and a body can be
    // a hundred lines of script.
    let tools_json: Vec<Value> = tools
        .iter()
        .map(|t| {
            json!({
                "id": t.id,
                "name": t.name,
                "description": t.description,
                "kind": t.kind,
                "scope": if t.workspace_id.is_none() { "global" } else { "workspace" },
                "params": t.params.iter().map(|p| json!({
                    "name": p.name, "label": p.label, "default": p.default
                })).collect::<Vec<_>>(),
            })
        })
        .collect();

    Ok(serde_json::to_string_pretty(&json!({
        "rails": rails_json,
        "conflictNotes": conflict_notes,
        "doneColumn": done_column,
        "columns": columns.iter().map(|c| c.name.clone()).collect::<Vec<_>>(),
        "unplacedCards": unplaced,
        "tools": tools_json,
    }))?)
}

// ---------- arming a rail ----------

/// What `gavin_start_rail` should do about the rail it names.
///
/// A PORT of `startRailVerdict` in `app/src/lib/orchestration.ts`, minus
/// its self-reference case (nothing here is running on a rail, so there
/// is no rail this call could loop back onto). That function carries the
/// reasoning; this one must answer the same, in the same words, because
/// the human reads its verdict on the Orchestration tab and the agent
/// reads this one -- a change to either owes the other.
enum StartVerdict {
    /// Arm this rail at this stage.
    Start { rail_id: String, rail_name: String, stage_id: String, stage_label: String },
    /// The rail is fine as it is, and saying so is the whole answer.
    Noop { text: String },
    Refuse { reason: String },
}

/// Where Start arms a rail: the first stage (by position) holding a step
/// whose run row is not FINISHED. Card statuses play no part -- the app's
/// `firstUnfinishedStageId`, which this mirrors, leaves that to the
/// scheduler's own first tick.
///
/// Finished is `done` OR `skipped`: a step the human sent the rail past
/// is as much behind it as one that ran, and an agent arming the rail
/// here must not rewind onto it -- that would undo the skip and re-run
/// work somebody had explicitly declined.
fn first_unfinished_stage(
    rail: &protocol::Rail,
    step_runs: &[protocol::StepRun],
) -> Option<protocol::Stage> {
    let mut stages = rail.stages.clone();
    stages.sort_by_key(|s| s.position);
    stages.into_iter().find(|stage| {
        !stage.steps.iter().all(|step| {
            step_runs
                .iter()
                .any(|r| r.step_id == step.id && (r.state == "done" || r.state == "skipped"))
        })
    })
}

/// A stage said the way the human sees it: its name when it has one, and
/// its place in the rail either way -- an agent that reads "stage 2 of 4"
/// can check the arming against what it just wrote.
fn stage_label(rail: &protocol::Rail, stage: &protocol::Stage) -> String {
    let total = rail.stages.len();
    let mut ordered = rail.stages.clone();
    ordered.sort_by_key(|s| s.position);
    let nth = ordered.iter().position(|s| s.id == stage.id).map(|i| i + 1).unwrap_or(1);
    match stage.name.as_deref().map(str::trim).filter(|n| !n.is_empty()) {
        Some(name) => format!("stage {nth} of {total} (\u{201c}{name}\u{201d})"),
        None => format!("stage {nth} of {total}"),
    }
}

fn start_rail_verdict(
    rails: &[protocol::Rail],
    rail_runs: &[protocol::RailRun],
    step_runs: &[protocol::StepRun],
    name: &str,
) -> StartVerdict {
    let wanted = name.trim().to_lowercase();
    // The app's wording here names a step's Rail parameter, which is
    // where a blank reaches IT. A blank reaches this one as an argument,
    // so the sentence says argument.
    if wanted.is_empty() {
        return StartVerdict::Refuse {
            reason: "no rail named — pass the name of the rail to start".to_string(),
        };
    }
    let matches: Vec<&protocol::Rail> =
        rails.iter().filter(|r| r.name.trim().to_lowercase() == wanted).collect();
    let named = name.trim();
    if matches.is_empty() {
        return StartVerdict::Refuse {
            reason: format!("no rail called \u{201c}{named}\u{201d} in this workspace"),
        };
    }
    // Rail names are not unique -- nothing in the app makes them so --
    // and arming an arbitrary one of two would be worse than saying
    // which fact is missing.
    if matches.len() > 1 {
        return StartVerdict::Refuse {
            reason: format!(
                "\u{201c}{named}\u{201d} names {} rails — rename one of them",
                matches.len()
            ),
        };
    }
    let target = matches[0];
    let state = rail_runs
        .iter()
        .find(|r| r.rail_id == target.id)
        .map(|r| r.state.as_str())
        .unwrap_or("idle");
    // A pause is a human's, or a stalled step's (rule 5). Resuming it
    // would re-launch the very step that failed.
    if state == "paused" {
        return StartVerdict::Refuse {
            reason: format!("\u{201c}{}\u{201d} is paused — resume it yourself", target.name),
        };
    }
    // Not an error, and not a start either: Start REWINDS a rail to its
    // first unfinished stage, so arming one that is already going three
    // stages in would restart it from behind whatever stalled.
    if state == "running" {
        return StartVerdict::Noop {
            text: format!(
                "\u{201c}{}\u{201d} is already running — left alone (starting it would rewind it to its first unfinished stage)",
                target.name
            ),
        };
    }
    match first_unfinished_stage(target, step_runs) {
        None => StartVerdict::Noop {
            text: format!(
                "\u{201c}{}\u{201d} has no unfinished steps — nothing to arm",
                target.name
            ),
        },
        Some(stage) => StartVerdict::Start {
            rail_id: target.id.clone(),
            rail_name: target.name.clone(),
            stage_label: stage_label(target, &stage),
            stage_id: stage.id,
        },
    }
}

/// Arms a rail the way the human's Start button does: read the whole
/// orchestration, decide here, and only then write.
///
/// The decision is the MCP's on purpose. The daemon stores run state and
/// has no opinion about it, so an agent writing `running` straight to the
/// socket -- which is what happened before this tool existed -- guessed
/// the stage and could rewind a running rail or resume a paused one
/// without knowing it.
fn start_rail(
    root: &Path,
    name: &str,
    transport: &mut dyn DaemonTransport,
) -> anyhow::Result<String> {
    let root_str = root.to_string_lossy().to_string();
    let (rails, rail_runs, step_runs) = match transport
        .request(&Request::GetOrchestrationByRoot { root_path: root_str.clone() })?
    {
        Response::Orchestration { rails, rail_runs, step_runs, .. } => (rails, rail_runs, step_runs),
        Response::Error { message } => return Err(anyhow::anyhow!(message)),
        other => return Err(anyhow::anyhow!("unexpected response: {other:?}")),
    };

    let (rail_id, rail_name, stage_id, stage_label) =
        match start_rail_verdict(&rails, &rail_runs, &step_runs, name) {
            StartVerdict::Refuse { reason } => return Err(anyhow::anyhow!(reason)),
            // A success, never an error: the agent asked for a rail to be
            // going and it is going, or there is nothing left for it to do.
            StartVerdict::Noop { text } => return Ok(text),
            StartVerdict::Start { rail_id, rail_name, stage_id, stage_label } => {
                (rail_id, rail_name, stage_id, stage_label)
            }
        };

    // SetRailRunByRoot rather than SetRailRun: only the ByRoot form
    // resolves a workspace, and only a resolved workspace can be told --
    // without the push the row sits in SQLite and the rail reads idle in
    // the app until something else makes it re-read.
    match transport.request(&Request::SetRailRunByRoot {
        root_path: root_str,
        rail_id,
        state: "running".to_string(),
        current_stage_id: Some(stage_id),
    })? {
        Response::Ok => Ok(format!("armed \u{201c}{rail_name}\u{201d} at {stage_label}")),
        Response::Error { message } => Err(anyhow::anyhow!(message)),
        other => Err(anyhow::anyhow!("unexpected response: {other:?}")),
    }
}

// ---------- JSON-RPC ----------

fn rpc_result(id: &Value, result: Value) -> String {
    json!({ "jsonrpc": "2.0", "id": id, "result": result }).to_string()
}

fn rpc_error(id: &Value, code: i64, message: &str) -> String {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } }).to_string()
}

fn tool_text_result(id: &Value, text: String, is_error: bool) -> String {
    rpc_result(id, json!({ "content": [{ "type": "text", "text": text }], "isError": is_error }))
}

/// Turns the gate's refusal into something an agent can act on rather
/// than a bare transport failure: WHICH tool is unavailable, the daemon
/// version it needs, the version actually running, and what to do. The
/// tool name is added here because only this layer knows it -- the
/// transport sees a `Request`, and a tool like `gavin_get_orchestration`
/// makes several. Every other error passes through untouched.
fn gated_tool_error(tool: &str, e: &anyhow::Error) -> String {
    match e.downcast_ref::<protocol::GatedRequest>() {
        Some(gated) => format!(
            "{tool} {gated} (this gavin-mcp speaks v{PROTOCOL_VERSION}) — restart the daemon from the gavin app to use it"
        ),
        None => e.to_string(),
    }
}

/// One request line in, at most one reply line out (None for
/// notifications and unparseable input -- MCP stdio never replies to
/// those).
fn handle_line(line: &str, root: Option<&Path>, transport: &mut dyn DaemonTransport) -> Option<String> {
    let msg: Value = serde_json::from_str(line).ok()?;
    let method = msg.get("method")?.as_str()?.to_string();
    let id = match msg.get("id").cloned() {
        Some(id) => id,
        None => return None, // notification (e.g. notifications/initialized)
    };

    match method.as_str() {
        "initialize" => {
            let requested = msg
                .pointer("/params/protocolVersion")
                .and_then(|v| v.as_str())
                .unwrap_or("2024-11-05");
            Some(rpc_result(
                &id,
                json!({
                    "protocolVersion": requested,
                    "capabilities": { "tools": {} },
                    "serverInfo": { "name": "gavin-mcp", "version": env!("CARGO_PKG_VERSION") }
                }),
            ))
        }
        "ping" => Some(rpc_result(&id, json!({}))),
        "tools/list" => Some(rpc_result(&id, json!({ "tools": tool_definitions() }))),
        "tools/call" => {
            let name = msg.pointer("/params/name").and_then(|v| v.as_str()).unwrap_or("");
            let empty = json!({});
            let args = msg.pointer("/params/arguments").unwrap_or(&empty);
            match dispatch_tool(name, args, root, transport) {
                Ok(text) => Some(tool_text_result(&id, text, false)),
                Err(e) => Some(tool_text_result(&id, gated_tool_error(name, &e), true)),
            }
        }
        _ => Some(rpc_error(&id, -32601, &format!("method not found: {method}"))),
    }
}

fn main() {
    let root = std::env::current_dir().ok().and_then(|cwd| find_gavin_root(&cwd));
    match &root {
        Some(r) => eprintln!("gavin-mcp: workspace root {}", r.display()),
        None => eprintln!("gavin-mcp: no .gavin-root above cwd — only gavin_init_root will work"),
    }
    let mut transport = SocketTransport::new();
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        if let Some(reply) = handle_line(&line, root.as_deref(), &mut transport) {
            let mut out = stdout.lock();
            let _ = writeln!(out, "{reply}");
            let _ = out.flush();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    struct MockTransport {
        replies: Vec<Response>,
        requests: Vec<Request>,
    }
    impl DaemonTransport for MockTransport {
        fn request(&mut self, req: &Request) -> anyhow::Result<Response> {
            self.requests.push(req.clone());
            if self.replies.is_empty() {
                anyhow::bail!("mock exhausted")
            }
            Ok(self.replies.remove(0))
        }
    }
    fn mock(replies: Vec<Response>) -> MockTransport {
        MockTransport { replies, requests: vec![] }
    }

    /// A fake daemon on a throwaway socket that answers the version probe
    /// with `version` and every later request from `replies`, in order,
    /// while recording everything it ACTUALLY receives.
    ///
    /// The recording is the point. The gate's contract is not "the call
    /// fails" -- a bare `Err` proves nothing about the wire -- it is that a
    /// request the daemon predates produces zero bytes, and only the
    /// receiving end can testify to that.
    fn fake_daemon(
        version: u32,
        replies: Vec<Response>,
    ) -> (PathBuf, Arc<Mutex<Vec<Request>>>, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("fake.sock");
        let listener = std::os::unix::net::UnixListener::bind(&path).unwrap();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let recorder = Arc::clone(&seen);

        std::thread::spawn(move || {
            let mut replies = replies.into_iter();
            // Accepts repeatedly, not once: SocketTransport reconnects on
            // failure, and a one-shot accept would hang that retry instead
            // of failing it.
            while let Ok((mut stream, _)) = listener.accept() {
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                while let Ok(Some(req)) = read_message::<_, Request>(&mut reader) {
                    recorder.lock().unwrap().push(req.clone());
                    let resp = match req {
                        Request::GetProtocolVersion => Response::ProtocolVersion { version },
                        _ => match replies.next() {
                            Some(r) => r,
                            None => break,
                        },
                    };
                    if write_message(&mut stream, &resp).is_err() {
                        break;
                    }
                }
            }
        });

        (path, seen, dir)
    }

    fn call_tool(tool: &str, transport: &mut dyn DaemonTransport) -> String {
        let line = format!(
            r#"{{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{{"name":"{tool}","arguments":{{}}}}}}"#
        );
        let reply = handle_line(&line, Some(Path::new("/ws")), transport).unwrap();
        let v: Value = serde_json::from_str(&reply).unwrap();
        v.pointer("/result/content/0/text").unwrap().as_str().unwrap().to_string()
    }

    fn is_error(tool: &str, transport: &mut dyn DaemonTransport) -> bool {
        let line = format!(
            r#"{{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{{"name":"{tool}","arguments":{{}}}}}}"#
        );
        let reply = handle_line(&line, Some(Path::new("/ws")), transport).unwrap();
        let v: Value = serde_json::from_str(&reply).unwrap();
        v.pointer("/result/isError").unwrap().as_bool().unwrap()
    }

    /// The version `gavin_get_orchestration`'s first request was
    /// introduced at, read from the table rather than typed as a literal:
    /// a test hard-coding 10 would keep passing while silently testing
    /// nothing if that entry ever moved.
    fn orchestration_min_version() -> u32 {
        protocol::min_version_for(&Request::GetOrchestrationByRoot { root_path: "/ws".into() })
    }

    #[test]
    fn a_request_the_daemon_predates_never_reaches_the_socket() {
        let needed = orchestration_min_version();
        let daemon_version = needed - 1;
        assert!(
            daemon_version >= protocol::MIN_COMPATIBLE_VERSION,
            "the pinned daemon has to sit INSIDE the window, or this tests the connect \
             refusal instead of the gate"
        );

        let (path, seen, _dir) = fake_daemon(daemon_version, vec![]);
        let mut t = SocketTransport::at(path);
        let text = call_tool("gavin_get_orchestration", &mut t);

        // Names the tool, the version it needs, and the version running --
        // everything needed to decide whether to restart the daemon.
        assert!(text.contains("gavin_get_orchestration"), "{text}");
        assert!(text.contains(&format!("v{needed}")), "should name the version needed: {text}");
        assert!(
            text.contains(&format!("v{daemon_version}")),
            "should name the version running: {text}"
        );

        // The contract: zero bytes on the wire. The probe is the only
        // thing the daemon ever saw.
        let seen = seen.lock().unwrap();
        assert!(
            matches!(seen.as_slice(), [Request::GetProtocolVersion]),
            "a gated request must produce nothing on the wire, but the daemon saw {seen:?}"
        );
    }

    #[test]
    fn an_older_in_window_daemon_still_serves_the_requests_it_does_understand() {
        // The whole reason for the band: on a daemon below several tools'
        // requirements, the v1 tools are unaffected. Before this, the
        // connect probe's equality check failed them all.
        let (path, seen, _dir) = fake_daemon(
            protocol::MIN_COMPATIBLE_VERSION,
            vec![Response::GavinTreeScanned { tree: two_card_tree() }],
        );
        let mut t = SocketTransport::at(path);
        assert!(!is_error("gavin_get_tree", &mut t), "a v1 request must survive the band");

        let seen = seen.lock().unwrap();
        assert!(
            matches!(seen.as_slice(), [Request::GetProtocolVersion, Request::ScanGavinRoot { .. }]),
            "{seen:?}"
        );
    }

    #[test]
    fn a_daemon_below_the_floor_is_refused_at_connect() {
        let (path, seen, _dir) = fake_daemon(protocol::MIN_COMPATIBLE_VERSION - 1, vec![]);
        let mut t = SocketTransport::at(path);
        let text = call_tool("gavin_get_tree", &mut t);
        assert!(text.contains("too old"), "{text}");
        assert!(
            text.contains(&format!("v{}", protocol::MIN_COMPATIBLE_VERSION - 1)),
            "should name the version running: {text}"
        );
        // Below the floor nothing is safe to send, not even a v1 request.
        assert!(!seen.lock().unwrap().iter().any(|r| !matches!(r, Request::GetProtocolVersion)));
    }

    #[test]
    fn a_daemon_newer_than_this_gavin_mcp_is_refused_naming_both_versions() {
        let (path, _seen, _dir) = fake_daemon(PROTOCOL_VERSION + 1, vec![]);
        let mut t = SocketTransport::at(path);
        let text = call_tool("gavin_get_tree", &mut t);
        assert!(text.contains("newer than this gavin-mcp"), "{text}");
        assert!(text.contains(&format!("v{}", PROTOCOL_VERSION + 1)), "{text}");
        assert!(text.contains(&format!("v{PROTOCOL_VERSION}")), "{text}");
    }

    #[test]
    fn a_gated_request_is_not_retried_through_a_reconnect() {
        // The retry exists for a daemon that went away mid-call. A gate
        // refusal is the opposite case -- nothing was sent, so nothing can
        // be fixed by reconnecting -- and retrying it would replace the
        // version message with whatever the second attempt failed on.
        let needed = orchestration_min_version();
        let (path, seen, _dir) = fake_daemon(needed - 1, vec![]);
        let mut t = SocketTransport::at(path);
        let text = call_tool("gavin_get_orchestration", &mut t);

        assert!(text.contains(&format!("v{needed}")), "{text}");
        assert_eq!(
            seen.lock().unwrap().len(),
            1,
            "one probe, one refusal -- a retry would have re-probed"
        );
    }

    fn two_card_tree() -> protocol::GavinTree {
        let card = |file: &str, title: &str| protocol::PlanFileInfo {
            path: format!("/ws/.gavin-root/plans/{file}"),
            file_name: file.into(),
            title: title.into(),
            status: Some("To Do".into()),
            priority: None,
            order: None,
            kind: protocol::CardKind::Task,
            parent: None,
            labels: vec![],
            checklist_done: 0,
            checklist_total: 0,
            parse_warning: false,
            modified_at: None,
            attachments: vec![],
        };
        protocol::GavinTree {
            root_path: "/ws".into(),
            root_missing: false,
            contexts: vec![protocol::GavinContext {
                folder_path: "/ws/.gavin-root".into(),
                kind: protocol::GavinContextKind::Root,
                name: "ws".into(),
                plans: vec![
                    card("a.md", "Card A"),
                    card("b.md", "Card B"),
                    protocol::PlanFileInfo {
                        path: "/ws/.gavin-root/plans/archive/filed.md".into(),
                        ..card("filed.md", "Filed away")
                    },
                ],
                docs: vec![],
                specs: vec![],
                has_prd: true,
                config_warning: false,
                agent: None,
                outside: false,
                prd: None,
            }],
        }
    }

    /// two_card_tree plus a nested child of a plan, a child of that plan
    /// with a status of its OWN, and a child whose `parent:` resolves to
    /// nothing. Only the first is drawn inside another card.
    fn nesting_tree() -> protocol::GavinTree {
        let mut tree = two_card_tree();
        let base = tree.contexts[0].plans[0].clone();
        let child = |file: &str, title: &str, parent: &str, status: Option<&str>| {
            protocol::PlanFileInfo {
                path: format!("/ws/.gavin-root/plans/{file}"),
                file_name: file.into(),
                title: title.into(),
                status: status.map(str::to_string),
                parent: Some(parent.into()),
                kind: protocol::CardKind::Task,
                ..base.clone()
            }
        };
        tree.contexts[0].plans.push(protocol::PlanFileInfo {
            path: "/ws/.gavin-root/plans/big.md".into(),
            file_name: "big.md".into(),
            title: "Big plan".into(),
            kind: protocol::CardKind::Plan,
            ..base.clone()
        });
        tree.contexts[0].plans.push(child("nested.md", "Nested child", "big.md", None));
        tree.contexts[0].plans.push(child("free.md", "Free child", "big.md", Some("To Do")));
        tree.contexts[0].plans.push(child("orphan.md", "Orphan", "gone.md", None));
        tree
    }

    fn unplaced_titles(tree: protocol::GavinTree) -> Vec<String> {
        let mut t = mock(vec![
            orchestration_reply(),
            board_reply(),
            tools_reply(),
            Response::GavinTreeScanned { tree },
            Response::DirtyPaths { paths: vec![], truncated: false },
        ]);
        let reply = handle_line(
            r#"{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"gavin_get_orchestration","arguments":{}}}"#,
            Some(Path::new("/ws")),
            &mut t,
        )
        .unwrap();
        let envelope: serde_json::Value = serde_json::from_str(&reply).unwrap();
        let text: serde_json::Value =
            serde_json::from_str(envelope["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
        text["unplacedCards"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["title"].as_str().unwrap().to_string())
            .collect()
    }

    /// This list is the AUTHORITATIVE one -- the tab's Generate prompt
    /// sends the agent here for the truth -- so it has to leave out
    /// exactly what the drawer leaves out. A nested child has no card of
    /// its own on the board; its plan is the unit of placement, and
    /// listing both offers the same work twice.
    #[test]
    fn unplaced_cards_leave_out_nested_children() {
        let titles = unplaced_titles(nesting_tree());
        assert!(!titles.contains(&"Nested child".to_string()), "{titles:?}");
        assert!(titles.contains(&"Big plan".to_string()), "{titles:?}");
    }

    /// A status of its own is what makes a child free-standing: the board
    /// draws it in its own column, so it is its own work and its own step.
    /// A `parent:` that resolves to nothing is not nesting either -- the
    /// board draws that card in its own column too, wearing a broken mark.
    #[test]
    fn unplaced_cards_keep_free_standing_and_orphaned_children() {
        let titles = unplaced_titles(nesting_tree());
        assert!(titles.contains(&"Free child".to_string()), "{titles:?}");
        assert!(titles.contains(&"Orphan".to_string()), "{titles:?}");
    }

    // ---- gavin_start_rail ----------------------------------------------
    // The route this tool replaces: an orchestrating agent that found no
    // start action among the gavin_* tools wrote `SetRailRun` rows to the
    // daemon socket by hand -- naming no workspace (so nothing was
    // pushed), guessing the stage, and rewinding or resuming rails that
    // said not to.

    fn a_step(id: &str, position: i64) -> protocol::Step {
        protocol::Step {
            id: id.into(),
            position,
            card_path: format!("/ws/.gavin-root/plans/{id}.md"),
            tool_id: None,
            tool_params: Default::default(),
        }
    }

    fn a_stage(id: &str, position: i64, steps: Vec<protocol::Step>) -> protocol::Stage {
        protocol::Stage {
            id: id.into(),
            position,
            mode: protocol::default_stage_mode(),
            name: None,
            steps,
        }
    }

    fn a_rail(id: &str, name: &str, stages: Vec<protocol::Stage>) -> protocol::Rail {
        protocol::Rail {
            id: id.into(),
            name: name.into(),
            position: 0,
            worktree_path: None,
            branch: None,
            auto_resume: None,
            page_id: None,
            stages,
        }
    }

    fn done(step_id: &str) -> protocol::StepRun {
        step_run(step_id, "done")
    }

    fn step_run(step_id: &str, state: &str) -> protocol::StepRun {
        protocol::StepRun {
            step_id: step_id.into(),
            state: state.into(),
            session_id: None,
            reason: None,
            conversation_id: None,
            launch_cwd: None,
            resume_attempts: None,
        }
    }

    /// Two stages, the first already finished: "the first unfinished
    /// stage" is only a real answer when there is a finished one in front
    /// of it to skip.
    fn two_stage_rail() -> Vec<protocol::Rail> {
        vec![a_rail(
            "r1",
            "Backend",
            vec![
                a_stage("s1", 0, vec![a_step("t1", 0)]),
                a_stage("s2", 1, vec![a_step("t2", 0), a_step("t3", 1)]),
            ],
        )]
    }

    fn orchestration(
        rails: Vec<protocol::Rail>,
        rail_runs: Vec<protocol::RailRun>,
        step_runs: Vec<protocol::StepRun>,
    ) -> Response {
        Response::Orchestration { rails, conflict_notes: vec![], rail_runs, step_runs }
    }

    fn running(rail_id: &str, stage_id: &str) -> protocol::RailRun {
        protocol::RailRun {
            rail_id: rail_id.into(),
            state: "running".into(),
            current_stage_id: Some(stage_id.into()),
        }
    }

    /// `call_tool` with arguments. Goes through `handle_line` like every
    /// other tool test, so the JSON-RPC shaping is exercised too, and
    /// returns the text WITH the error flag -- a refusal and a no-op read
    /// alike in the text alone, and the difference between them is the
    /// whole point of two of these tests.
    fn call_start_rail(rail: &str, transport: &mut dyn DaemonTransport) -> (String, bool) {
        let line = format!(
            r#"{{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{{"name":"gavin_start_rail","arguments":{{"rail":"{rail}"}}}}}}"#
        );
        let reply = handle_line(&line, Some(Path::new("/ws")), transport).unwrap();
        let v: Value = serde_json::from_str(&reply).unwrap();
        (
            v.pointer("/result/content/0/text").unwrap().as_str().unwrap().to_string(),
            v.pointer("/result/isError").unwrap().as_bool().unwrap(),
        )
    }

    #[test]
    fn start_rail_arms_an_idle_rail_at_its_first_unfinished_stage() {
        let mut t = mock(vec![
            orchestration(two_stage_rail(), vec![], vec![done("t1")]),
            Response::Ok,
        ]);
        // Case- and space-insensitively, exactly as the app matches it.
        let (text, is_error) = call_start_rail(" backend ", &mut t);
        assert!(!is_error, "{text}");
        assert!(text.contains("Backend"), "should name the rail: {text}");
        assert!(text.contains("stage 2 of 2"), "should name the stage: {text}");

        // The write, and it is the ByRoot form: the plain SetRailRun names
        // no workspace, so the daemon could not push it and the app would
        // go on showing the rail idle.
        match &t.requests[1] {
            Request::SetRailRunByRoot { root_path, rail_id, state, current_stage_id } => {
                assert_eq!(root_path, "/ws");
                assert_eq!(rail_id, "r1");
                assert_eq!(state, "running");
                assert_eq!(current_stage_id.as_deref(), Some("s2"));
            }
            other => panic!("wrong request: {other:?}"),
        }
    }

    /// A step the human SKIPPED is behind the rail exactly as a done one
    /// is. Arming here must not rewind onto it: that would undo the skip
    /// and re-run work somebody had explicitly declined.
    #[test]
    fn start_rail_arms_past_a_skipped_step() {
        let mut t = mock(vec![
            orchestration(two_stage_rail(), vec![], vec![step_run("t1", "skipped")]),
            Response::Ok,
        ]);
        let (text, is_error) = call_start_rail("Backend", &mut t);
        assert!(!is_error, "{text}");
        assert!(text.contains("stage 2 of 2"), "should arm past the skip: {text}");
    }

    /// A stage is unfinished while ANY of its steps is not done -- one
    /// finished step in a stage of two does not move the rail past it.
    #[test]
    fn start_rail_stays_on_a_stage_that_is_only_half_done() {
        let mut t = mock(vec![
            orchestration(two_stage_rail(), vec![], vec![done("t1"), done("t2")]),
            Response::Ok,
        ]);
        let (text, is_error) = call_start_rail("Backend", &mut t);
        assert!(!is_error, "{text}");
        match &t.requests[1] {
            Request::SetRailRunByRoot { current_stage_id, .. } => {
                assert_eq!(current_stage_id.as_deref(), Some("s2"));
            }
            other => panic!("wrong request: {other:?}"),
        }
    }

    #[test]
    fn start_rail_refuses_a_name_no_rail_has() {
        let mut t = mock(vec![orchestration(two_stage_rail(), vec![], vec![])]);
        let (text, is_error) = call_start_rail("frontend", &mut t);
        assert!(is_error, "{text}");
        assert_eq!(text, "no rail called \u{201c}frontend\u{201d} in this workspace");
        assert_eq!(t.requests.len(), 1, "a refusal writes nothing: {:?}", t.requests);
    }

    /// Rail names are not unique, so an ambiguous one says which fact is
    /// missing rather than arming an arbitrary half of the pair.
    #[test]
    fn start_rail_refuses_a_name_two_rails_share() {
        let rails = vec![
            a_rail("r1", "Backend", vec![a_stage("s1", 0, vec![a_step("t1", 0)])]),
            a_rail("r2", "backend ", vec![a_stage("s2", 0, vec![a_step("t2", 0)])]),
        ];
        let mut t = mock(vec![orchestration(rails, vec![], vec![])]);
        let (text, is_error) = call_start_rail("Backend", &mut t);
        assert!(is_error, "{text}");
        assert_eq!(text, "\u{201c}Backend\u{201d} names 2 rails — rename one of them");
        assert_eq!(t.requests.len(), 1, "a refusal writes nothing: {:?}", t.requests);
    }

    /// A pause is a human's or a stalled step's. Resuming it from here
    /// would re-launch the very step that failed.
    #[test]
    fn start_rail_refuses_a_paused_rail() {
        let paused = protocol::RailRun {
            rail_id: "r1".into(),
            state: "paused".into(),
            current_stage_id: Some("s1".into()),
        };
        let mut t = mock(vec![orchestration(two_stage_rail(), vec![paused], vec![])]);
        let (text, is_error) = call_start_rail("Backend", &mut t);
        assert!(is_error, "{text}");
        assert_eq!(text, "\u{201c}Backend\u{201d} is paused — resume it yourself");
        assert_eq!(t.requests.len(), 1, "a refusal writes nothing: {:?}", t.requests);
    }

    /// Start REWINDS: it re-points a rail at its FIRST unfinished stage.
    /// A rail already going three stages in must therefore be left alone,
    /// and told about -- an error would read as "your rail is not
    /// running", which is the opposite of what is true.
    #[test]
    fn start_rail_leaves_a_running_rail_alone_and_says_so() {
        let mut t = mock(vec![orchestration(
            two_stage_rail(),
            vec![running("r1", "s2")],
            vec![done("t1")],
        )]);
        let (text, is_error) = call_start_rail("Backend", &mut t);
        assert!(!is_error, "a no-op is a success: {text}");
        assert!(text.contains("already running"), "{text}");
        assert_eq!(t.requests.len(), 1, "nothing to write: {:?}", t.requests);
    }

    #[test]
    fn start_rail_says_so_when_every_step_is_already_done() {
        let mut t = mock(vec![orchestration(
            two_stage_rail(),
            vec![],
            vec![done("t1"), done("t2"), done("t3")],
        )]);
        let (text, is_error) = call_start_rail("Backend", &mut t);
        assert!(!is_error, "a no-op is a success: {text}");
        assert!(text.contains("nothing to arm"), "{text}");
        assert_eq!(t.requests.len(), 1, "nothing to write: {:?}", t.requests);
    }

    /// The gate is the whole compatibility story for this tool: the write
    /// is a v28 request, so against an older daemon the agent gets a
    /// version message instead of a rail armed with nothing watching it.
    #[test]
    fn start_rail_is_gated_on_the_daemon_that_can_serve_its_write() {
        let needed = protocol::min_version_for(&Request::SetRailRunByRoot {
            root_path: "/ws".into(),
            rail_id: "r1".into(),
            state: "running".into(),
            current_stage_id: None,
        });
        let (path, seen, _dir) = fake_daemon(
            needed - 1,
            vec![orchestration(two_stage_rail(), vec![], vec![done("t1")])],
        );
        let mut t = SocketTransport::at(path);
        let (text, is_error) = call_start_rail("Backend", &mut t);
        assert!(is_error, "{text}");
        assert!(text.contains("gavin_start_rail"), "{text}");
        assert!(text.contains(&format!("v{needed}")), "{text}");
        // The read went out; only the write was withheld.
        assert!(
            !seen.lock().unwrap().iter().any(|r| matches!(r, Request::SetRailRunByRoot { .. })),
            "a gated write must produce nothing on the wire"
        );
    }

    fn orchestration_reply() -> Response {
        Response::Orchestration {
            rails: vec![protocol::Rail {
                id: "r1".into(),
                name: "backend".into(),
                position: 0,
                worktree_path: Some("/x/wt-a".into()),
                branch: Some("feature/api".into()),
                auto_resume: None,
                page_id: None,
                stages: vec![protocol::Stage {
                    id: "s1".into(),
                    position: 0,
                    mode: protocol::default_stage_mode(),
                    name: None,
                    steps: vec![
                        protocol::Step {
                            id: "t1".into(),
                            position: 0,
                            card_path: "/ws/.gavin-root/plans/a.md".into(),
                            tool_id: None,
                            tool_params: Default::default(),
                        },
                        protocol::Step {
                            id: "t2".into(),
                            position: 1,
                            card_path: String::new(),
                            tool_id: Some("u1".into()),
                            tool_params: std::collections::HashMap::from([(
                                "remote".to_string(),
                                "upstream".to_string(),
                            )]),
                        },
                    ],
                }],
            }],
            conflict_notes: vec![],
            rail_runs: vec![],
            step_runs: vec![protocol::StepRun {
                step_id: "t1".into(),
                state: "running".into(),
                session_id: Some("s-1".into()),
                reason: None,
                conversation_id: None,
                launch_cwd: None,
                resume_attempts: None,
            }],
        }
    }

    fn board_reply() -> Response {
        Response::Board {
            columns: vec![
                protocol::Column { id: "c0".into(), name: "To Do".into(), position: 0 },
                protocol::Column { id: "c2".into(), name: "Done".into(), position: 2 },
                protocol::Column { id: "c1".into(), name: "In Progress".into(), position: 1 },
            ],
            labels: vec![],
            card_sessions: vec![],
        }
    }

    fn tools_reply() -> Response {
        Response::Tools {
            tools: vec![protocol::ToolDef {
                id: "u1".into(),
                workspace_id: None,
                name: "Push branch".into(),
                description: "git push".into(),
                kind: "command".into(),
                body: "git push -u {{remote}} HEAD".into(),
                params: vec![protocol::ToolParam {
                    name: "remote".into(),
                    label: "Remote".into(),
                    default: "origin".into(),
                }],
                position: 0,
            }],
        }
    }

    #[test]
    fn get_orchestration_composes_plan_board_tree_and_dirty_paths() {
        let root = Path::new("/ws");
        let mut t = mock(vec![
            orchestration_reply(),
            board_reply(),
            tools_reply(),
            Response::GavinTreeScanned { tree: two_card_tree() },
            Response::DirtyPaths { paths: vec!["app/src/lib/git.ts".into()], truncated: false },
        ]);
        let reply = handle_line(
            r#"{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"gavin_get_orchestration","arguments":{}}}"#,
            Some(root),
            &mut t,
        )
        .unwrap();

        // One GitDirtyPaths per DISTINCT rail worktree, capped at 200.
        match &t.requests[4] {
            Request::GitDirtyPaths { cwd, limit } => {
                assert_eq!(cwd, "/x/wt-a");
                assert_eq!(*limit, 200);
            }
            other => panic!("wrong request: {other:?}"),
        }

        let envelope: serde_json::Value = serde_json::from_str(&reply).unwrap();
        let text: serde_json::Value =
            serde_json::from_str(envelope["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
        // The done column is the HIGHEST position, not the last element.
        assert_eq!(text["doneColumn"], "Done");
        assert_eq!(text["rails"][0]["dirtyPaths"][0], "app/src/lib/git.ts");
        assert_eq!(text["rails"][0]["dirtyTruncated"], false);
        assert_eq!(text["rails"][0]["state"], "idle");
        // Steps carry their card's title and their live run state.
        assert_eq!(text["rails"][0]["stages"][0]["steps"][0]["title"], "Card A");
        assert_eq!(text["rails"][0]["stages"][0]["steps"][0]["kind"], "task");
        assert_eq!(text["rails"][0]["stages"][0]["steps"][0]["run"], "running");
        // b.md is not on a rail, so it is offered as unplaced. a.md is on
        // one, and filed.md is archived -- neither is on offer.
        let unplaced: Vec<&str> = text["unplacedCards"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["title"].as_str().unwrap())
            .collect();
        assert_eq!(unplaced, vec!["Card B"]);

        // A TOOL step is rendered by its tool, with the step's own
        // overrides, so an agent rewriting this rail can carry both
        // through instead of inventing a card for it.
        let step = &text["rails"][0]["stages"][0]["steps"][1];
        assert_eq!(step["toolId"], "u1");
        assert_eq!(step["toolName"], "Push branch");
        assert_eq!(step["toolKind"], "command");
        assert_eq!(step["toolParams"]["remote"], "upstream");
        assert!(step["cardPath"].is_null(), "a tool step carries no cardPath");

        // The library, so an arrangement can PLACE a tool rather than
        // only preserve one. Bodies stay out: a script can be long.
        assert_eq!(text["tools"][0]["id"], "u1");
        assert_eq!(text["tools"][0]["scope"], "global");
        assert_eq!(text["tools"][0]["params"][0]["default"], "origin");
        assert!(text["tools"][0]["body"].is_null(), "bodies stay out of the payload");
    }

    #[test]
    fn get_orchestration_reports_each_stages_mode_and_name() {
        // gavin_set_orchestration replaces the arrangement WHOLESALE, so an
        // agent that cannot read a stage's mode cannot preserve it -- and
        // every group in the workspace flattens to parallel on its first
        // rewrite.
        let mut orchestration = orchestration_reply();
        if let Response::Orchestration { rails, .. } = &mut orchestration {
            rails[0].stages[0].mode = "sequence".into();
            rails[0].stages[0].name = Some("Merge and push".into());
        } else {
            panic!("orchestration_reply() no longer returns Response::Orchestration");
        }
        let mut t = mock(vec![
            orchestration,
            board_reply(),
            tools_reply(),
            Response::GavinTreeScanned { tree: two_card_tree() },
            Response::DirtyPaths { paths: vec![], truncated: false },
        ]);
        let text: Value = serde_json::from_str(&call_tool("gavin_get_orchestration", &mut t)).unwrap();
        assert_eq!(text["rails"][0]["stages"][0]["mode"], "sequence");
        assert_eq!(text["rails"][0]["stages"][0]["name"], "Merge and push");
    }

    #[test]
    fn set_orchestration_accepts_a_tool_step_without_a_card_path() {
        let root = Path::new("/ws");
        let mut t = mock(vec![Response::Ok]);
        handle_line(
            r#"{"jsonrpc":"2.0","id":15,"method":"tools/call","params":{"name":"gavin_set_orchestration","arguments":{
                "rails":[{"id":"r1","name":"backend","position":0,"worktreePath":null,"pageId":null,
                  "stages":[{"id":"s1","position":0,"steps":[
                    {"id":"t1","position":0,"toolId":"u1","toolParams":{"remote":"upstream"}}]}]}]
            }}}"#,
            Some(root),
            &mut t,
        )
        .unwrap();
        match &t.requests[0] {
            Request::SetOrchestrationByRoot { rails, .. } => {
                let step = &rails[0].stages[0].steps[0];
                assert_eq!(step.tool_id.as_deref(), Some("u1"));
                assert_eq!(step.card_path, "");
                assert_eq!(step.tool_params.get("remote").map(String::as_str), Some("upstream"));
            }
            other => panic!("wrong request: {other:?}"),
        }
    }

    /// An agent that predates tools writes only the three original
    /// fields; that must still parse as a card step.
    #[test]
    fn set_orchestration_still_accepts_the_pre_tools_step_shape() {
        let root = Path::new("/ws");
        let mut t = mock(vec![Response::Ok]);
        handle_line(
            r#"{"jsonrpc":"2.0","id":16,"method":"tools/call","params":{"name":"gavin_set_orchestration","arguments":{
                "rails":[{"id":"r1","name":"backend","position":0,"worktreePath":null,"pageId":null,
                  "stages":[{"id":"s1","position":0,"steps":[{"id":"t1","position":0,"cardPath":"/ws/a.md"}]}]}]
            }}}"#,
            Some(root),
            &mut t,
        )
        .unwrap();
        match &t.requests[0] {
            Request::SetOrchestrationByRoot { rails, .. } => {
                assert_eq!(rails[0].stages[0].steps[0].card_path, "/ws/a.md");
                assert_eq!(rails[0].stages[0].steps[0].tool_id, None);
            }
            other => panic!("wrong request: {other:?}"),
        }
    }

    /// A stage's `mode` and `name` are ordinary fields on the wholesale
    /// replace, not something the daemon infers -- an agent that reads
    /// them back from gavin_get_orchestration and writes them straight
    /// through must see them land unchanged.
    #[test]
    fn set_orchestration_preserves_a_stage_mode_it_is_given() {
        let root = Path::new("/ws");
        let mut t = mock(vec![Response::Ok]);
        handle_line(
            r#"{"jsonrpc":"2.0","id":17,"method":"tools/call","params":{"name":"gavin_set_orchestration","arguments":{
                "rails":[{"id":"r1","name":"backend","position":0,"worktreePath":null,"pageId":null,
                  "stages":[{"id":"s1","position":0,"mode":"sequence","name":"Merge and push",
                  "steps":[{"id":"t1","position":0,"cardPath":"/ws/a.md"}]}]}]
            }}}"#,
            Some(root),
            &mut t,
        )
        .unwrap();
        match &t.requests[0] {
            Request::SetOrchestrationByRoot { rails, .. } => {
                assert_eq!(rails[0].stages[0].mode, "sequence");
                assert_eq!(rails[0].stages[0].name.as_deref(), Some("Merge and push"));
            }
            other => panic!("wrong request: {other:?}"),
        }
    }

    #[test]
    fn get_orchestration_needs_the_workspace_open() {
        let root = Path::new("/ws");
        let mut t = mock(vec![Response::Error { message: "workspace not open in gavin".into() }]);
        let reply = handle_line(
            r#"{"jsonrpc":"2.0","id":10,"method":"tools/call","params":{"name":"gavin_get_orchestration","arguments":{}}}"#,
            Some(root),
            &mut t,
        )
        .unwrap();
        assert!(reply.contains("not open in gavin"));
        assert_eq!(t.requests.len(), 1, "no further calls after the first failure");
    }

    #[test]
    fn set_orchestration_deserializes_rails_and_notes() {
        let root = Path::new("/ws");
        let mut t = mock(vec![Response::Ok]);
        let reply = handle_line(
            r#"{"jsonrpc":"2.0","id":11,"method":"tools/call","params":{"name":"gavin_set_orchestration","arguments":{
                "rails":[{"id":"r1","name":"backend","position":0,"worktreePath":"/x/wt-a","pageId":null,
                  "stages":[{"id":"s1","position":0,"steps":[{"id":"t1","position":0,"cardPath":"/ws/a.md"}]}]}],
                "conflict_notes":[{"id":"n1","stepIds":["t1"],"note":"touches the diff renderer"}]
            }}}"#,
            Some(root),
            &mut t,
        )
        .unwrap();
        assert!(reply.contains("ok"), "{reply}");
        match &t.requests[0] {
            Request::SetOrchestrationByRoot { root_path, rails, conflict_notes } => {
                assert_eq!(root_path, "/ws");
                assert_eq!(rails[0].stages[0].steps[0].card_path, "/ws/a.md");
                assert_eq!(conflict_notes[0].step_ids, vec!["t1".to_string()]);
            }
            other => panic!("wrong request: {other:?}"),
        }
    }

    #[test]
    fn set_orchestration_defaults_conflict_notes_to_empty() {
        let root = Path::new("/ws");
        let mut t = mock(vec![Response::Ok]);
        handle_line(
            r#"{"jsonrpc":"2.0","id":12,"method":"tools/call","params":{"name":"gavin_set_orchestration","arguments":{
                "rails":[{"id":"r1","name":"backend","position":0,"worktreePath":null,"pageId":null,"stages":[]}]
            }}}"#,
            Some(root),
            &mut t,
        )
        .unwrap();
        match &t.requests[0] {
            Request::SetOrchestrationByRoot { conflict_notes, .. } => assert!(conflict_notes.is_empty()),
            other => panic!("wrong request: {other:?}"),
        }
    }

    #[test]
    fn set_orchestration_reports_malformed_rails_without_calling_the_daemon() {
        let root = Path::new("/ws");
        let mut t = mock(vec![]);
        let reply = handle_line(
            r#"{"jsonrpc":"2.0","id":13,"method":"tools/call","params":{"name":"gavin_set_orchestration","arguments":{"rails":[{"id":"r1"}]}}}"#,
            Some(root),
            &mut t,
        )
        .unwrap();
        assert!(reply.contains("rails"), "{reply}");
        assert!(t.requests.is_empty(), "malformed input never reaches the daemon");
    }

    #[test]
    fn set_orchestration_surfaces_the_running_step_guard() {
        let root = Path::new("/ws");
        let mut t = mock(vec![Response::Error {
            message: "step t1 (/ws/a.md) is running — pause or let it finish before removing it".into(),
        }]);
        let reply = handle_line(
            r#"{"jsonrpc":"2.0","id":14,"method":"tools/call","params":{"name":"gavin_set_orchestration","arguments":{"rails":[]}}}"#,
            Some(root),
            &mut t,
        )
        .unwrap();
        assert!(reply.contains("is running"), "{reply}");
    }

    #[test]
    fn find_gavin_root_walks_up_and_stops() {
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("a").join("b");
        std::fs::create_dir_all(&nested).unwrap();
        assert_eq!(find_gavin_root(&nested), None);
        std::fs::create_dir_all(dir.path().join(".gavin-root")).unwrap();
        assert_eq!(find_gavin_root(&nested).unwrap(), dir.path());
    }

    #[test]
    fn initialize_echoes_version_and_lists_tools() {
        let mut t = mock(vec![]);
        let reply = handle_line(
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26"}}"#,
            None,
            &mut t,
        )
        .unwrap();
        let v: Value = serde_json::from_str(&reply).unwrap();
        assert_eq!(v.pointer("/result/protocolVersion").unwrap(), "2025-03-26");
        assert_eq!(v.pointer("/result/serverInfo/name").unwrap(), "gavin-mcp");

        let reply =
            handle_line(r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#, None, &mut t).unwrap();
        let v: Value = serde_json::from_str(&reply).unwrap();
        // Asserted against tool_definitions() rather than a literal: a
        // hard-coded count turns every new tool into an unrelated test
        // failure that says nothing about what broke.
        let listed = v.pointer("/result/tools").unwrap().as_array().unwrap();
        assert_eq!(listed.len(), tool_definitions().as_array().unwrap().len());
        let names: Vec<&str> = listed.iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert!(names.contains(&"gavin_get_orchestration"), "{names:?}");
    }

    #[test]
    fn notifications_and_garbage_produce_no_reply_and_unknown_methods_error() {
        let mut t = mock(vec![]);
        assert!(handle_line(
            r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#,
            None,
            &mut t
        )
        .is_none());
        assert!(handle_line("not json at all", None, &mut t).is_none());
        let reply =
            handle_line(r#"{"jsonrpc":"2.0","id":3,"method":"resources/list"}"#, None, &mut t)
                .unwrap();
        assert!(reply.contains("-32601"));
    }

    #[test]
    fn tools_require_a_root_except_init() {
        let mut t = mock(vec![Response::Ok]);
        let reply = handle_line(
            r#"{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"gavin_get_tree","arguments":{}}}"#,
            None,
            &mut t,
        )
        .unwrap();
        let v: Value = serde_json::from_str(&reply).unwrap();
        assert_eq!(v.pointer("/result/isError").unwrap(), true);
        assert!(reply.contains("not inside a gavin workspace"));
        assert!(t.requests.is_empty(), "no daemon call without a root");
    }

    #[test]
    fn a_status_write_and_a_new_card_are_the_two_claimable_writes() {
        // The card an agent just put in its own hands, and nothing else.
        // Both answers are the path the daemon REPORTED, not the one
        // asked for: a status write can file the card under plans/done/,
        // and the binding keys on where the file is.
        assert_eq!(
            claim_target(
                &Request::CreatePlan {
                    context_folder: "/ws".into(),
                    file_name: "a.md".into(),
                    title: "A".into(),
                    status: Some("In Progress".into()),
                    priority: None,
                    body: None,
                    kind: None,
                    parent: None,
                    attachments: None,
                },
                &Response::PlanCreated { path: "/ws/plans/a.md".into() }
            )
            .as_deref(),
            Some("/ws/plans/a.md")
        );
        assert_eq!(
            claim_target(
                &Request::SetPlanFrontmatterField {
                    path: "/ws/plans/a.md".into(),
                    key: "status".into(),
                    value: "Done".into(),
                },
                &Response::PlanFieldSet { path: "/ws/plans/done/a.md".into() }
            )
            .as_deref(),
            Some("/ws/plans/done/a.md")
        );
        // A priority write says nothing about who is working the card.
        assert_eq!(
            claim_target(
                &Request::SetPlanFrontmatterField {
                    path: "/ws/plans/a.md".into(),
                    key: "priority".into(),
                    value: "high".into(),
                },
                &Response::PlanFieldSet { path: "/ws/plans/a.md".into() }
            ),
            None
        );
        // And neither does a card write that failed.
        assert_eq!(
            claim_target(
                &Request::CreatePlan {
                    context_folder: "/ws".into(),
                    file_name: "a.md".into(),
                    title: "A".into(),
                    status: None,
                    priority: None,
                    body: None,
                    kind: None,
                    parent: None,
                    attachments: None,
                },
                &Response::Error { message: "nope".into() }
            ),
            None
        );
    }

    #[test]
    fn the_claim_carries_the_root_and_is_skipped_outside_a_gavin_tab() {
        let mut t = mock(vec![Response::Ok]);
        claim_card(Path::new("/ws"), "/ws/plans/a.md", Some("s-1".into()), &mut t);
        match &t.requests[0] {
            Request::ClaimCardForSession { root_path, path, session_id } => {
                assert_eq!(root_path, "/ws");
                assert_eq!(path, "/ws/plans/a.md");
                assert_eq!(session_id, "s-1");
            }
            other => panic!("wrong request: {other:?}"),
        }

        // A bare `claude` in a terminal has no session to bind to. It
        // still gets to file cards -- the claim is the only thing that
        // drops out.
        let mut t = mock(vec![Response::Ok]);
        claim_card(Path::new("/ws"), "/ws/plans/a.md", None, &mut t);
        assert!(t.requests.is_empty());

        // And a daemon that refuses it -- too old to know the request,
        // workspace not open in gavin -- is swallowed rather than
        // returned. The exhausted mock errors on every call, so this
        // asserts both halves: the claim WAS attempted, and its failure
        // went nowhere.
        let mut t = mock(vec![]);
        claim_card(Path::new("/ws"), "/ws/plans/a.md", Some("s-1".into()), &mut t);
        assert_eq!(t.requests.len(), 1);
    }

    #[test]
    fn a_refused_claim_never_fails_the_card_write_that_earned_it() {
        // The daemon refuses everything after the create -- too old to
        // know the request, workspace not open, whatever. The agent
        // asked for a card and must still be told it got one.
        let mut t = mock(vec![Response::PlanCreated { path: "/ws/plans/a.md".into() }]);
        let reply = handle_line(
            r#"{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"gavin_create_plan","arguments":{"context_folder":".","file_name":"a.md","title":"A"}}}"#,
            Some(Path::new("/ws")),
            &mut t,
        )
        .unwrap();
        let v: Value = serde_json::from_str(&reply).unwrap();
        assert_eq!(v.pointer("/result/isError").unwrap(), false, "{reply}");
        assert!(reply.contains("created plan"), "{reply}");
    }

    #[test]
    fn create_plan_resolves_relative_context_and_maps_arguments() {
        let root = Path::new("/ws");
        let mut t =
            mock(vec![Response::PlanCreated { path: "/ws/.gavin-root/plans/a.md".into() }]);
        let reply = handle_line(
            r#"{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"gavin_create_plan","arguments":{"context_folder":".","file_name":"a.md","title":"A","priority":"high"}}}"#,
            Some(root),
            &mut t,
        )
        .unwrap();
        assert!(reply.contains("created plan"));
        match &t.requests[0] {
            Request::CreatePlan { context_folder, file_name, title, priority, .. } => {
                assert_eq!(context_folder, "/ws/.");
                assert_eq!(file_name, "a.md");
                assert_eq!(title, "A");
                assert_eq!(priority.as_deref(), Some("high"));
            }
            other => panic!("wrong request: {other:?}"),
        }
    }

    #[test]
    fn a_session_name_is_one_short_line() {
        assert_eq!(clean_session_name("  login   flow \n").unwrap(), "login flow");
        assert!(clean_session_name("   ").is_err());
        // Truncation counts CHARACTERS: byte-slicing a multi-byte one
        // would panic instead of shortening.
        let long = "é".repeat(60);
        let short = clean_session_name(&long).unwrap();
        assert_eq!(short.chars().count(), MAX_SESSION_NAME + 1);
        assert!(short.ends_with('…'));
    }

    #[test]
    fn naming_a_session_sends_the_id_the_pty_exported() {
        let mut t = mock(vec![Response::Ok]);
        let reply = name_session("  login  flow ", Some("s-1".into()), &mut t).unwrap();
        assert!(reply.contains("login flow"));
        match &t.requests[0] {
            Request::NameSession { session_id, name } => {
                assert_eq!(session_id, "s-1");
                assert_eq!(name, "login flow");
            }
            other => panic!("wrong request: {other:?}"),
        }
    }

    #[test]
    fn naming_outside_a_gavin_session_says_so_without_calling_the_daemon() {
        let mut t = mock(vec![]);
        let err = name_session("x", None, &mut t).unwrap_err();
        assert!(err.to_string().contains("GAVIN_SESSION_ID"));
        assert!(t.requests.is_empty());
    }

    #[test]
    fn spawn_defaults_cwd_to_root_and_reports_the_agents_page() {
        let root = Path::new("/ws");
        let mut t = mock(vec![Response::SessionCreated { id: "s-1".into() }]);
        let reply = handle_line(
            r#"{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"gavin_spawn_session","arguments":{"command":"claude"}}}"#,
            Some(root),
            &mut t,
        )
        .unwrap();
        assert!(reply.contains("Agents page"));
        match &t.requests[0] {
            Request::SpawnAgentSession { root_path, cwd, command } => {
                assert_eq!(root_path, "/ws");
                assert_eq!(cwd, "/ws");
                assert_eq!(command, "claude");
            }
            other => panic!("wrong request: {other:?}"),
        }
    }

    #[test]
    fn daemon_errors_surface_as_tool_errors() {
        let root = Path::new("/ws");
        let mut t =
            mock(vec![Response::Error { message: "workspace not open in gavin".into() }]);
        let reply = handle_line(
            r#"{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"gavin_get_board","arguments":{}}}"#,
            Some(root),
            &mut t,
        )
        .unwrap();
        let v: Value = serde_json::from_str(&reply).unwrap();
        assert_eq!(v.pointer("/result/isError").unwrap(), true);
        assert!(reply.contains("workspace not open in gavin"));
    }
}
