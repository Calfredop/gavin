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
        { "name": "gavin_create_plan", "description": "Create a plan file in a gavin context with canonical frontmatter. Never overwrites.", "inputSchema": { "type": "object", "properties": {
            "context_folder": { "type": "string", "description": "Folder that is the root or contains .gavin (relative allowed)" },
            "file_name": { "type": "string", "description": "kebab-case-name.md" },
            "title": { "type": "string" },
            "status": { "type": "string", "description": "Board column name; default To Do" },
            "priority": { "type": "string", "enum": ["none", "low", "medium", "high", "urgent"] },
            "body": { "type": "string" }
        }, "required": ["context_folder", "file_name", "title"] } },
        { "name": "gavin_set_plan_field", "description": "Update one frontmatter field (status or priority) of a plan file, preserving every other byte.", "inputSchema": { "type": "object", "properties": {
            "path": { "type": "string" },
            "key": { "type": "string", "enum": ["status", "priority"] },
            "value": { "type": "string" }
        }, "required": ["path", "key", "value"] } },
        { "name": "gavin_create_context", "description": "Turn a folder into a gavin context (.gavin scaffold) for a feature/library.", "inputSchema": { "type": "object", "properties": {
            "parent_folder": { "type": "string" }
        }, "required": ["parent_folder"] } },
        { "name": "gavin_init_root", "description": "Initialize .gavin-root (PRD template, plans/docs/specs) in a folder; idempotent, never overwrites.", "inputSchema": { "type": "object", "properties": {
            "path": { "type": "string", "description": "Defaults to the current directory" }
        } } },
        { "name": "gavin_get_board", "description": "The workspace kanban board: columns (the status vocabulary) and the human's free-form cards. Requires the workspace open in gavin.", "inputSchema": { "type": "object", "properties": {} } },
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
        Response::Board { columns, labels } => {
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
        assert_eq!(v.pointer("/result/tools").unwrap().as_array().unwrap().len(), 8);
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
