use serde::{Deserialize, Serialize};
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
pub const PROTOCOL_VERSION: u32 = 8;

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
    /// Allow-listed to profile/file/command -- like
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
    GetProtocolVersion,
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
    GavinTreeSnapshot { workspace_id: String, tree: GavinTree },
    GavinTreeChanged { workspace_id: String, tree: GavinTree },
    GavinTreeScanned { tree: GavinTree },
    PrdContent { content: String },
    PlanCreated { path: String },
    AgentSessionSpawned { workspace_id: String, session_id: String, cwd: String, command: String },
    ProtocolVersion { version: u32 },
    TaskPromoted { path: String },
    Ok,
    Error { message: String },
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
/// parses cleanly with all three `None`, and the profile defaults apply.
/// Only ever populated for the root context -- `.gavin` sub-contexts have
/// no agent block.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfig {
    pub profile: Option<String>,
    pub file: Option<String>,
    pub command: Option<String>,
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
                        "parseWarning": false
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
            }),
            outside: false,
        };
        let json = serde_json::to_value(&ctx).unwrap();
        assert_eq!(
            json["agent"],
            serde_json::json!({
                "profile": "claude-code",
                "file": null,
                "command": "claude --model opus"
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
    fn protocol_version_is_eight_until_a_breaking_change_bumps_it() {
        // v8: GavinContext.outside + Add/RemoveExternalGavinContext
        // (outside-workspace contexts) + docs/specs deletion guard.
        assert_eq!(PROTOCOL_VERSION, 8);
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
}
