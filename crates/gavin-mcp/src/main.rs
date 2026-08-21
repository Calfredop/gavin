use protocol::{read_message, write_message, Request, Response, PROTOCOL_VERSION};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};

// ---------- daemon transport ----------

pub trait DaemonTransport {
    fn request(&mut self, req: &Request) -> anyhow::Result<Response>;
}

/// Lazy persistent connection to the daemon socket. Every fresh connect
/// runs the version probe (spec §4): a daemon too old to parse the probe
/// closes the connection, which maps to the same "restart the daemon"
/// error as an explicit lower version.
struct SocketTransport {
    stream: Option<BufReader<UnixStream>>,
}

impl SocketTransport {
    fn new() -> Self {
        Self { stream: None }
    }

    fn connect(&mut self) -> anyhow::Result<()> {
        let stream = UnixStream::connect(protocol::socket_path())
            .map_err(|_| anyhow::anyhow!("gavin daemon isn't running — open the gavin app"))?;
        let mut reader = BufReader::new(stream);
        write_message(reader.get_mut(), &Request::GetProtocolVersion)
            .map_err(|_| anyhow::anyhow!("gavin daemon isn't running — open the gavin app"))?;
        match read_message::<_, Response>(&mut reader) {
            Ok(Some(Response::ProtocolVersion { version })) if version == PROTOCOL_VERSION => {
                self.stream = Some(reader);
                Ok(())
            }
            Ok(Some(Response::ProtocolVersion { version })) if version > PROTOCOL_VERSION => {
                anyhow::bail!(
                    "the gavin daemon is newer than this gavin-mcp — rebuild and restart the app"
                )
            }
            _ => anyhow::bail!(
                "the gavin daemon is older than this app — restart it (pkill gavin-daemon, then relaunch the gavin app)"
            ),
        }
    }

    fn request_once(&mut self, req: &Request) -> anyhow::Result<Response> {
        if self.stream.is_none() {
            self.connect()?;
        }
        let reader = self.stream.as_mut().unwrap();
        write_message(reader.get_mut(), req)?;
        match read_message::<_, Response>(reader)? {
            Some(resp) => Ok(resp),
            None => anyhow::bail!("daemon closed the connection"),
        }
    }
}

impl DaemonTransport for SocketTransport {
    fn request(&mut self, req: &Request) -> anyhow::Result<Response> {
        match self.request_once(req) {
            Ok(resp) => Ok(resp),
            Err(_) => {
                // One reconnect per call: the daemon may have restarted.
                self.stream = None;
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
        { "name": "gavin_create_plan", "description": "Create a card file (note, task, or plan) in a gavin context with canonical frontmatter. Never overwrites.", "inputSchema": { "type": "object", "properties": {
            "context_folder": { "type": "string", "description": "Folder that is the root or contains .gavin (relative allowed)" },
            "file_name": { "type": "string", "description": "kebab-case-name.md" },
            "title": { "type": "string" },
            "status": { "type": "string", "description": "Board column name; default To Do (omitted on a task with a parent: it nests)" },
            "priority": { "type": "string", "enum": ["none", "low", "medium", "high", "urgent"] },
            "body": { "type": "string", "description": "For kind task this IS the agent prompt" },
            "kind": { "type": "string", "enum": ["note", "task", "plan"], "description": "Default plan" },
            "parent": { "type": "string", "description": "Parent plan's file name (kind task only); no status -> nests inside it" }
        }, "required": ["context_folder", "file_name", "title"] } },
        { "name": "gavin_set_plan_field", "description": "Update one frontmatter field (status, priority, or integer order) of a plan file, preserving every other byte.", "inputSchema": { "type": "object", "properties": {
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
        { "name": "gavin_get_orchestration", "description": "The workspace's orchestration: rails with their worktrees and uncommitted files, stages, steps with their cards and live run state, the board's columns, and every runnable card not yet on a rail. Read this before writing an arrangement. Requires the workspace open in gavin.", "inputSchema": { "type": "object", "properties": {} } },
        { "name": "gavin_set_orchestration", "description": "Replace the workspace's orchestration wholesale: rails of stages of steps, plus your own conflict notes. Read gavin_get_orchestration first and preserve the ids of steps you are keeping — run state follows the id. Removing a step whose run state is 'running' is refused.", "inputSchema": { "type": "object", "properties": {
            "rails": { "type": "array", "description": "Ordered rails. Each: { id, name, position, worktreePath, pageId, stages: [{ id, position, steps: [{ id, position, cardPath }] }] }. A stage's steps run IN PARALLEL in that rail's checkout; stages run one after another.", "items": { "type": "object" } },
            "conflict_notes": { "type": "array", "description": "Your judgements, shown to the human in the Conflicts box. Each: { id, stepIds: [...], note }.", "items": { "type": "object" } }
        }, "required": ["rails"] } },
        { "name": "gavin_spawn_session", "description": "Spawn a terminal session in the gavin app (visible to the human on the Agents page). Requires the workspace open in gavin.", "inputSchema": { "type": "object", "properties": {
            "command": { "type": "string", "description": "Program to run, e.g. claude" },
            "cwd": { "type": "string", "description": "Defaults to the workspace root" }
        }, "required": ["command"] } }
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
    // gavin_init_root is the only tool that works without a resolved root.
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

    let resp = transport.request(&req)?;
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
        Response::Ok => Ok("ok".to_string()),
        Response::Error { message } => Err(anyhow::anyhow!(message)),
        other => Err(anyhow::anyhow!("unexpected response: {other:?}")),
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
        .map(|t| t.card_path.as_str())
        .collect();

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
                            let card = cards.get(step.card_path.as_str());
                            json!({
                                "id": step.id,
                                "cardPath": step.card_path,
                                "title": card.map(|c| c.title.clone()),
                                "kind": card.map(|c| kind_str(&c.kind)),
                                "status": card.and_then(|c| c.status.clone()),
                                "run": run_of.get(step.id.as_str()).map(|r| r.state.clone())
                                    .unwrap_or_else(|| "pending".to_string()),
                            })
                        })
                        .collect();
                    json!({ "id": stage.id, "position": stage.position, "steps": steps })
                })
                .collect();
            json!({
                "id": rail.id,
                "name": rail.name,
                "worktreePath": rail.worktree_path,
                "pageId": rail.page_id,
                "state": rail_run_of.get(rail.id.as_str()).map(|r| r.state.clone())
                    .unwrap_or_else(|| "idle".to_string()),
                "dirtyPaths": paths,
                "dirtyTruncated": truncated,
                "stages": stages,
            })
        })
        .collect();

    let unplaced: Vec<Value> = tree
        .contexts
        .iter()
        .flat_map(|ctx| ctx.plans.iter())
        .filter(|p| !matches!(p.kind, protocol::CardKind::Note))
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

    Ok(serde_json::to_string_pretty(&json!({
        "rails": rails_json,
        "conflictNotes": conflict_notes,
        "doneColumn": done_column,
        "columns": columns.iter().map(|c| c.name.clone()).collect::<Vec<_>>(),
        "unplacedCards": unplaced,
    }))?)
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
                Err(e) => Some(tool_text_result(&id, e.to_string(), true)),
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
        };
        protocol::GavinTree {
            root_path: "/ws".into(),
            root_missing: false,
            contexts: vec![protocol::GavinContext {
                folder_path: "/ws/.gavin-root".into(),
                kind: protocol::GavinContextKind::Root,
                name: "ws".into(),
                plans: vec![card("a.md", "Card A"), card("b.md", "Card B")],
                docs: vec![],
                specs: vec![],
                has_prd: true,
                config_warning: false,
                agent: None,
                outside: false,
            }],
        }
    }

    fn orchestration_reply() -> Response {
        Response::Orchestration {
            rails: vec![protocol::Rail {
                id: "r1".into(),
                name: "backend".into(),
                position: 0,
                worktree_path: Some("/x/wt-a".into()),
                page_id: None,
                stages: vec![protocol::Stage {
                    id: "s1".into(),
                    position: 0,
                    steps: vec![protocol::Step {
                        id: "t1".into(),
                        position: 0,
                        card_path: "/ws/.gavin-root/plans/a.md".into(),
                    }],
                }],
            }],
            conflict_notes: vec![],
            rail_runs: vec![],
            step_runs: vec![protocol::StepRun {
                step_id: "t1".into(),
                state: "running".into(),
                session_id: Some("s-1".into()),
                reason: None,
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

    #[test]
    fn get_orchestration_composes_plan_board_tree_and_dirty_paths() {
        let root = Path::new("/ws");
        let mut t = mock(vec![
            orchestration_reply(),
            board_reply(),
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
        match &t.requests[3] {
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
        // b.md is not on a rail, so it is offered as unplaced; a.md is not.
        let unplaced: Vec<&str> = text["unplacedCards"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["title"].as_str().unwrap())
            .collect();
        assert_eq!(unplaced, vec!["Card B"]);
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
