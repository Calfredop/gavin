# Agent Orchestration Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bind workspaces to root directories and give the daemon a `.gavin-root`/`.gavin` scanner + watcher that pushes a live tree of contexts and plan files to the app.

**Architecture:** The daemon owns the entire `.gavin` domain (scan, watch, scaffold, plan-file model) in a new `crates/daemon/src/gavin.rs`; the app registers roots over the wire and renders. `WatchGavinRoot` rides the streaming connection (intercepted like `Attach` to capture the push writer); everything else is command-connection request/reply. Scan state is never persisted.

**Tech Stack:** Rust (notify + notify-debouncer-mini already present; **new dep: `toml`**), Tauri 2 commands/events, Svelte 5 + svelte/store, Vitest with mocked backend.

**Spec:** `docs/superpowers/specs/2026-08-06-agent-orchestration-foundations-design.md` — the requirements authority. Phase context: `docs/superpowers/brainstorms/2026-08-06-agent-orchestration-brainstorm.md`.

## Global Constraints

- User works **directly on `main`** — no worktree (standing preference, consented all project long).
- This session has hit the 200-subagent spawn cap seven times historically — whoever executes should not be surprised if dispatch fails; inline execution has been the user's standing fallback.
- Every frontend-crossing protocol type: `#[serde(rename_all = "camelCase")]` + a `json!` shape-assertion test (the `GitStatus` precedent).
- Frontmatter parsing/writing is **line-oriented, zero new deps**; `config.toml` parsing uses the **`toml` crate** (new daemon dependency) — these are different files with different needs, per spec §1.
- Scaffolding is **idempotent and never overwrites** any existing file (especially `PRD.md`).
- Scan state is **never persisted** (fully re-derivable, the git-status posture).
- Watcher must bake in the three `RepoPoller` lessons from day one: `Arc::downgrade` in the debouncer callback (never a strong-Arc cycle), a minimum-rescan-interval floor (2 s, sleep out the remainder), change-gated emission (`PartialEq` on the tree).
- `dialog:default` is already granted and its default set includes `allow-open` — **verified against `gen/schemas/acl-manifests.json` on 2026-08-06; no capability change needed** for the folder picker.
- Tauri events emitted before a listener exists are lost — the `gavin-tree-changed` listener registers inside `layoutState.bootstrap()`'s existing listener block, before any `watchGavinRoot` call.
- The daemon crate is **binary-only**: new modules go in `main.rs` (`mod gavin;`), never a new `lib.rs` (a prior plan created an orphaned second crate target this way).
- Rust struct literals require every field: adding `root_path` to config's `Workspace` breaks three existing construction sites (listed in Task 4) plus its camelCase shape test — all must be updated in the same task.
- Vitest lesson: any new module-level mutable state needs a `__resetForTesting()` called in `beforeEach`; mocked `backend` functions that get `.catch()`ed must be `vi.fn().mockResolvedValue(undefined)`, never bare `vi.fn()`.

---

### Task 1: Protocol types + requests/responses

**Files:**
- Modify: `crates/protocol/src/lib.rs`

**Interfaces:**
- Consumes: existing `Priority`, `Request`/`Response` tagged enums.
- Produces (for Tasks 2-5): `PlanFileInfo`, `MdFileInfo`, `GavinContextKind`, `GavinContext`, `GavinTree` (all `Clone + PartialEq`, camelCase); `Request::{WatchGavinRoot, UnwatchGavinRoot, GetGavinTree, InitGavinRoot, CreateGavinContext}`; `Response::{GavinTreeSnapshot, GavinTreeChanged}`.

- [ ] **Step 1: Add the structs** after `Board` in `crates/protocol/src/lib.rs`:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlanFileInfo {
    pub path: String,
    pub file_name: String,
    pub title: String,
    pub status: Option<String>,
    pub priority: Option<Priority>,
    pub parse_warning: bool,
}

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
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GavinTree {
    pub root_path: String,
    pub root_missing: bool,
    pub contexts: Vec<GavinContext>,
}
```

- [ ] **Step 2: Add the request variants** to `Request` (after `DeleteBoard`):

```rust
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
```

- [ ] **Step 3: Add the response variants** to `Response` (after `Board`):

```rust
    GavinTreeSnapshot { workspace_id: String, tree: GavinTree },
    GavinTreeChanged { workspace_id: String, tree: GavinTree },
```

- [ ] **Step 4: Add tests** in the existing `mod tests`:

```rust
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
                    parse_warning: false,
                }],
                docs: vec![MdFileInfo {
                    path: "/tmp/ws/.gavin-root/docs/notes.md".to_string(),
                    rel_path: "notes.md".to_string(),
                }],
                specs: vec![],
                has_prd: true,
                config_warning: false,
            }],
        }
    }

    #[test]
    fn gavin_tree_serializes_to_the_camel_case_shape_the_frontend_expects() {
        let json = serde_json::to_value(&sample_tree()).unwrap();
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
                        "parseWarning": false
                    }],
                    "docs": [{ "path": "/tmp/ws/.gavin-root/docs/notes.md", "relPath": "notes.md" }],
                    "specs": [],
                    "hasPrd": true,
                    "configWarning": false
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
```

- [ ] **Step 5: Verify** — `cargo test -p protocol` all green, and `cargo build` for the whole workspace still compiles (the app's streaming reader loop and `get_board_impl` both have catch-all arms, so new variants must not break them — if anything fails to compile, fix the match by extending its catch-all, not by removing variants).

- [ ] **Step 6: Commit** — `git add crates/protocol/src/lib.rs && git commit -m "feat(protocol): gavin tree types and requests"`

---

### Task 2: gavin.rs file model — frontmatter, config, scaffold, walker

**Files:**
- Create: `crates/daemon/src/gavin.rs`
- Modify: `crates/daemon/src/main.rs` (add `mod gavin;` beside the existing `mod` lines — the crate is binary-only, do NOT create a lib.rs)
- Modify: `crates/daemon/Cargo.toml` (add `toml = "0.8"`)

**Interfaces:**
- Consumes: `protocol::{GavinContext, GavinContextKind, GavinTree, MdFileInfo, PlanFileInfo, Priority}` from Task 1.
- Produces (for Task 3): `pub fn scan_root(root: &Path) -> GavinTree`, `pub fn init_gavin_root(root: &Path, workspace_name: &str) -> anyhow::Result<()>`, `pub fn create_gavin_context(parent: &Path) -> anyhow::Result<()>`, `pub fn write_plan_status(path: &Path, new_status: &str) -> anyhow::Result<()>` (write-back wired in sub-project 2, but the function + tests ship now per spec §1).

- [ ] **Step 1: Write the module skeleton with constants** in `crates/daemon/src/gavin.rs`:

```rust
use protocol::{GavinContext, GavinContextKind, GavinTree, MdFileInfo, PlanFileInfo, Priority};
use std::path::{Path, PathBuf};

pub const GAVIN_ROOT_DIR: &str = ".gavin-root";
pub const GAVIN_DIR: &str = ".gavin";
const MAX_SCAN_DEPTH: usize = 12;
const EXCLUDED_DIRS: &[&str] =
    &[".git", "node_modules", "target", "dist", "build", ".venv", "venv", "__pycache__"];

const PRD_TEMPLATE: &str = "# {workspace} — Product Requirements\n\n\
> This PRD is the lead document for development in this workspace. The main agent\n\
> session reads it first; plans in `.gavin*/plans/` should trace back to it.\n\n\
## Vision\n\n_What are we building, for whom, and why?_\n\n\
## Current focus\n\n_The active goals, roughly ordered._\n\n\
## Out of scope\n\n_Explicit non-goals._\n";

const ROOT_CONFIG_TEMPLATE: &str = "version = 1\n\n[agent]\nprofile = \"claude-code\"\n";
```

- [ ] **Step 2: Write the frontmatter parser** (line-oriented, spec §1 rules exactly):

```rust
/// Flat `key: value` frontmatter, parsed line-by-line. `fields` keeps only
/// the recognized pairs; anything else in the block is untouched by
/// parsing and preserved by `write_plan_status`, which edits lines, never
/// re-serializes.
struct Frontmatter {
    fields: Vec<(String, String)>,
    /// Byte-line index just past the closing `---`, or None if the file
    /// has no (complete) frontmatter block.
    present: bool,
    warning: bool,
}

fn parse_frontmatter(content: &str) -> Frontmatter {
    let mut lines = content.lines();
    if lines.next() != Some("---") {
        return Frontmatter { fields: vec![], present: false, warning: false };
    }
    let mut fields = Vec::new();
    for line in lines {
        if line == "---" {
            return Frontmatter { fields, present: true, warning: false };
        }
        if let Some((key, value)) = line.split_once(':') {
            let key = key.trim();
            if !key.is_empty()
                && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
            {
                let mut value = value.trim();
                for quote in ['"', '\''] {
                    if value.len() >= 2 && value.starts_with(quote) && value.ends_with(quote) {
                        value = &value[1..value.len() - 1];
                        break;
                    }
                }
                fields.push((key.to_string(), value.to_string()));
            }
        }
    }
    // Opening marker, no closing marker before EOF.
    Frontmatter { fields: vec![], present: false, warning: true }
}

fn parse_priority(value: &str) -> Option<Priority> {
    match value.to_ascii_lowercase().as_str() {
        "none" => Some(Priority::None),
        "low" => Some(Priority::Low),
        "medium" => Some(Priority::Medium),
        "high" => Some(Priority::High),
        "urgent" => Some(Priority::Urgent),
        _ => None,
    }
}

/// Builds a PlanFileInfo from a plan file's path and content. Never fails:
/// unreadable frontmatter degrades to status None + parse_warning.
pub fn plan_file_info(path: &Path, content: &str) -> PlanFileInfo {
    let fm = parse_frontmatter(content);
    let mut warning = fm.warning;
    let get = |key: &str| {
        fm.fields
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.clone())
            .filter(|v| !v.is_empty())
    };
    let file_name =
        path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let stem = path
        .file_stem()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| file_name.clone());
    let priority = match get("priority") {
        None => None,
        Some(raw) => {
            let parsed = parse_priority(&raw);
            if parsed.is_none() {
                warning = true;
            }
            parsed
        }
    };
    PlanFileInfo {
        path: path.to_string_lossy().to_string(),
        file_name,
        title: get("title").unwrap_or(stem),
        status: get("status"),
        priority,
        parse_warning: warning,
    }
}
```

- [ ] **Step 3: Write `write_plan_status`** (surgical, byte-preserving):

```rust
/// Rewrites ONLY the `status:` line (spec §1): replace in place if present,
/// insert as the block's first line if the block exists without one,
/// prepend a new block if the file has no frontmatter. Every other byte is
/// preserved -- including the presence/absence of a trailing newline.
pub fn write_plan_status(path: &Path, new_status: &str) -> anyhow::Result<()> {
    let content = std::fs::read_to_string(path)?;
    let had_trailing_newline = content.ends_with('\n');
    let lines: Vec<&str> = content.lines().collect();
    let mut out: Vec<String>;

    let fm = parse_frontmatter(&content);
    if fm.present {
        // Find the closing marker so we only touch lines inside the block.
        let close = lines.iter().skip(1).position(|l| *l == "---").map(|i| i + 1).unwrap();
        let status_line = lines[1..close]
            .iter()
            .position(|l| {
                l.split_once(':').map(|(k, _)| k.trim() == "status").unwrap_or(false)
            })
            .map(|i| i + 1);
        out = lines.iter().map(|l| l.to_string()).collect();
        match status_line {
            Some(i) => out[i] = format!("status: {new_status}"),
            None => out.insert(1, format!("status: {new_status}")),
        }
    } else {
        out = vec!["---".to_string(), format!("status: {new_status}"), "---".to_string()];
        out.extend(lines.iter().map(|l| l.to_string()));
    }

    let mut rebuilt = out.join("\n");
    if had_trailing_newline || content.is_empty() {
        rebuilt.push('\n');
    }
    std::fs::write(path, rebuilt)?;
    Ok(())
}
```

- [ ] **Step 4: Write the config parsers** (toml crate):

```rust
/// A context's display name from its config.toml, or None on any
/// missing/unparseable config (caller falls back to the folder name and
/// sets config_warning only when the file exists but doesn't parse).
fn parse_context_name(config_path: &Path) -> (Option<String>, bool) {
    let content = match std::fs::read_to_string(config_path) {
        Ok(c) => c,
        Err(_) => return (None, false), // absent config is normal, not a warning
    };
    match content.parse::<toml::Table>() {
        Ok(table) => {
            let name = table.get("name").and_then(|v| v.as_str()).map(|s| s.to_string());
            (name, false)
        }
        Err(_) => (None, true),
    }
}
```

- [ ] **Step 5: Write the scaffolders** (idempotent, never overwrite):

```rust
fn scaffold_gavin_dir(gavin_dir: &Path) -> anyhow::Result<()> {
    for sub in ["plans", "docs", "specs"] {
        let dir = gavin_dir.join(sub);
        std::fs::create_dir_all(&dir)?;
        let keep = dir.join(".gitkeep");
        if !keep.exists() {
            std::fs::write(&keep, "")?;
        }
    }
    Ok(())
}

/// Never overwrites: each piece is created only if missing, so this both
/// completes a partial skeleton and no-ops on a complete one (spec §4).
pub fn init_gavin_root(root: &Path, workspace_name: &str) -> anyhow::Result<()> {
    if !root.is_dir() {
        anyhow::bail!("root does not exist or is not a directory: {}", root.display());
    }
    let gavin_dir = root.join(GAVIN_ROOT_DIR);
    std::fs::create_dir_all(&gavin_dir)?;
    scaffold_gavin_dir(&gavin_dir)?;
    let config = gavin_dir.join("config.toml");
    if !config.exists() {
        std::fs::write(&config, ROOT_CONFIG_TEMPLATE)?;
    }
    let prd = gavin_dir.join("PRD.md");
    if !prd.exists() {
        std::fs::write(&prd, PRD_TEMPLATE.replace("{workspace}", workspace_name))?;
    }
    Ok(())
}

pub fn create_gavin_context(parent: &Path) -> anyhow::Result<()> {
    if !parent.is_dir() {
        anyhow::bail!("parent does not exist or is not a directory: {}", parent.display());
    }
    let gavin_dir = parent.join(GAVIN_DIR);
    std::fs::create_dir_all(&gavin_dir)?;
    scaffold_gavin_dir(&gavin_dir)?;
    let config = gavin_dir.join("config.toml");
    if !config.exists() {
        let name = parent.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        std::fs::write(&config, format!("name = \"{name}\"\n"))?;
    }
    Ok(())
}
```

- [ ] **Step 6: Write the walker**:

```rust
fn list_md_files(dir: &Path) -> Vec<MdFileInfo> {
    fn walk(dir: &Path, base: &Path, out: &mut Vec<MdFileInfo>) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(&path, base, out);
            } else if path.extension().map(|e| e == "md").unwrap_or(false) {
                out.push(MdFileInfo {
                    path: path.to_string_lossy().to_string(),
                    rel_path: path
                        .strip_prefix(base)
                        .unwrap_or(&path)
                        .to_string_lossy()
                        .to_string(),
                });
            }
        }
    }
    let mut out = Vec::new();
    walk(dir, dir, &mut out);
    out.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    out
}

fn build_context(folder: &Path, gavin_dir: &Path, kind: GavinContextKind) -> GavinContext {
    let (config_name, config_warning) = parse_context_name(&gavin_dir.join("config.toml"));
    let folder_name =
        folder.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let plans_dir = gavin_dir.join("plans");
    let plans = list_md_files(&plans_dir)
        .into_iter()
        .map(|md| {
            let path = PathBuf::from(&md.path);
            let content = std::fs::read_to_string(&path).unwrap_or_default();
            plan_file_info(&path, &content)
        })
        .collect();
    GavinContext {
        folder_path: folder.to_string_lossy().to_string(),
        kind: kind.clone(),
        name: config_name.unwrap_or(folder_name),
        plans,
        docs: list_md_files(&gavin_dir.join("docs")),
        specs: list_md_files(&gavin_dir.join("specs")),
        has_prd: matches!(kind, GavinContextKind::Root) && gavin_dir.join("PRD.md").is_file(),
        config_warning,
    }
}

/// Full scan of one bound root (spec §3). Never fails: a missing root
/// yields `root_missing: true` with no contexts.
pub fn scan_root(root: &Path) -> GavinTree {
    let root_str = root.to_string_lossy().to_string();
    if !root.is_dir() {
        return GavinTree { root_path: root_str, root_missing: true, contexts: vec![] };
    }

    let mut contexts = Vec::new();
    // Root context: `.gavin-root` recognized ONLY directly under the root.
    let root_gavin = root.join(GAVIN_ROOT_DIR);
    let root_has_gavin_root = root_gavin.is_dir();
    if root_has_gavin_root {
        contexts.push(build_context(root, &root_gavin, GavinContextKind::Root));
    }
    // Spec §1 edge rule: if the root somehow has BOTH markers,
    // `.gavin-root` wins and the root's `.gavin` is ignored entirely.
    let skip_root_gavin = root_has_gavin_root;

    fn walk(
        dir: &Path,
        depth: usize,
        skip_gavin_here: bool,
        contexts: &mut Vec<GavinContext>,
    ) {
        if depth > MAX_SCAN_DEPTH {
            return;
        }
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            // A deep `.gavin-root` is ignored entirely (spec §1 edge rules);
            // `.gavin` marks its PARENT as a context, and the walker never
            // descends into `.gavin*` directories themselves.
            if name == GAVIN_DIR {
                if !skip_gavin_here {
                    contexts.push(build_context(dir, &path, GavinContextKind::Context));
                }
                continue;
            }
            if name == GAVIN_ROOT_DIR || EXCLUDED_DIRS.contains(&name.as_str()) || name.starts_with('.') {
                continue;
            }
            walk(&path, depth + 1, false, contexts);
        }
    }
    // Depth 1 = the root's immediate children; skip_gavin_here applies the
    // both-markers-at-root rule to the root level only.
    walk(root, 1, skip_root_gavin, &mut contexts);

    // Root context first, then by folder path.
    contexts.sort_by(|a, b| {
        let a_root = matches!(a.kind, GavinContextKind::Root);
        let b_root = matches!(b.kind, GavinContextKind::Root);
        b_root.cmp(&a_root).then(a.folder_path.cmp(&b.folder_path))
    });
    GavinTree { root_path: root_str, root_missing: false, contexts }
}
```

Note: a `.gavin` **directly at the root** is handled by the walk (root's children include its `.gavin` entry? No — `walk(root, 1, …)` iterates the root's children, so a `.gavin` child of the root marks the ROOT folder as an ordinary context, matching spec §1's "treated as an ordinary context"). `derive(Clone)` on `GavinContextKind` comes from Task 1.

- [ ] **Step 7: Add `mod gavin;` to `crates/daemon/src/main.rs`** beside the existing `mod` declarations, and `toml = "0.8"` to `crates/daemon/Cargo.toml` `[dependencies]`.

- [ ] **Step 8: Write the unit tests** at the bottom of `gavin.rs` (`#[cfg(test)] mod tests`, tempfile is already a dev-dependency). Write all of these; each is a plain tempdir test:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn plan(content: &str) -> PlanFileInfo {
        plan_file_info(Path::new("/tmp/plans/auth-flow.md"), content)
    }

    #[test]
    fn plan_with_full_frontmatter_parses_all_fields() {
        let p = plan("---\nstatus: In Progress\npriority: high\ntitle: Auth rework\n---\n# body\n");
        assert_eq!(p.status.as_deref(), Some("In Progress"));
        assert_eq!(p.priority, Some(Priority::High));
        assert_eq!(p.title, "Auth rework");
        assert!(!p.parse_warning);
    }

    #[test]
    fn plan_without_frontmatter_gets_stem_title_and_no_status() {
        let p = plan("# just a heading\n");
        assert_eq!(p.status, None);
        assert_eq!(p.title, "auth-flow");
        assert!(!p.parse_warning);
    }

    #[test]
    fn unterminated_frontmatter_sets_parse_warning() {
        let p = plan("---\nstatus: To Do\nno closing marker\n");
        assert_eq!(p.status, None);
        assert!(p.parse_warning);
    }

    #[test]
    fn quoted_values_are_unquoted_and_unknown_priority_warns() {
        let p = plan("---\nstatus: \"Review\"\npriority: banana\n---\n");
        assert_eq!(p.status.as_deref(), Some("Review"));
        assert_eq!(p.priority, None);
        assert!(p.parse_warning);
    }

    #[test]
    fn unknown_keys_and_comments_are_ignored_without_warning() {
        let p = plan("---\n# a comment\nowner: alice\nstatus: Done\n---\n");
        assert_eq!(p.status.as_deref(), Some("Done"));
        assert!(!p.parse_warning);
    }

    #[test]
    fn write_plan_status_replaces_only_the_status_line() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("p.md");
        let original = "---\ntitle: Keep me\nstatus: To Do\nowner: alice\n---\n# Body\n\nText.\n";
        std::fs::write(&path, original).unwrap();
        write_plan_status(&path, "In Progress").unwrap();
        let after = std::fs::read_to_string(&path).unwrap();
        assert_eq!(after, "---\ntitle: Keep me\nstatus: In Progress\nowner: alice\n---\n# Body\n\nText.\n");
    }

    #[test]
    fn write_plan_status_inserts_into_a_block_that_lacks_one() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("p.md");
        std::fs::write(&path, "---\ntitle: T\n---\nbody\n").unwrap();
        write_plan_status(&path, "Done").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "---\nstatus: Done\ntitle: T\n---\nbody\n");
    }

    #[test]
    fn write_plan_status_prepends_a_block_when_none_exists() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("p.md");
        std::fs::write(&path, "# Heading only\n").unwrap();
        write_plan_status(&path, "To Do").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "---\nstatus: To Do\n---\n# Heading only\n");
    }

    #[test]
    fn init_creates_full_skeleton_and_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        init_gavin_root(dir.path(), "My WS").unwrap();
        let g = dir.path().join(GAVIN_ROOT_DIR);
        assert!(g.join("config.toml").is_file());
        assert!(g.join("PRD.md").is_file());
        for sub in ["plans", "docs", "specs"] {
            assert!(g.join(sub).join(".gitkeep").is_file());
        }
        let prd = std::fs::read_to_string(g.join("PRD.md")).unwrap();
        assert!(prd.starts_with("# My WS — Product Requirements"));
        init_gavin_root(dir.path(), "My WS").unwrap(); // second run: no-op, no error
    }

    #[test]
    fn init_never_overwrites_an_existing_prd() {
        let dir = tempfile::tempdir().unwrap();
        let g = dir.path().join(GAVIN_ROOT_DIR);
        std::fs::create_dir_all(&g).unwrap();
        std::fs::write(g.join("PRD.md"), "my precious prd\n").unwrap();
        init_gavin_root(dir.path(), "WS").unwrap();
        assert_eq!(std::fs::read_to_string(g.join("PRD.md")).unwrap(), "my precious prd\n");
        // ...while still completing the missing pieces:
        assert!(g.join("config.toml").is_file());
        assert!(g.join("plans").join(".gitkeep").is_file());
    }

    #[test]
    fn create_context_scaffolds_with_folder_name() {
        let dir = tempfile::tempdir().unwrap();
        let feature = dir.path().join("auth");
        std::fs::create_dir_all(&feature).unwrap();
        create_gavin_context(&feature).unwrap();
        let config = std::fs::read_to_string(feature.join(GAVIN_DIR).join("config.toml")).unwrap();
        assert_eq!(config, "name = \"auth\"\n");
    }

    #[test]
    fn scan_finds_root_and_nested_contexts_root_first() {
        let dir = tempfile::tempdir().unwrap();
        init_gavin_root(dir.path(), "WS").unwrap();
        let feature = dir.path().join("src").join("auth");
        std::fs::create_dir_all(&feature).unwrap();
        create_gavin_context(&feature).unwrap();
        std::fs::write(
            feature.join(GAVIN_DIR).join("plans").join("login.md"),
            "---\nstatus: To Do\n---\n# Login\n",
        )
        .unwrap();

        let tree = scan_root(dir.path());
        assert!(!tree.root_missing);
        assert_eq!(tree.contexts.len(), 2);
        assert_eq!(tree.contexts[0].kind, GavinContextKind::Root);
        assert!(tree.contexts[0].has_prd);
        assert_eq!(tree.contexts[1].name, "auth");
        assert_eq!(tree.contexts[1].plans.len(), 1);
        assert_eq!(tree.contexts[1].plans[0].status.as_deref(), Some("To Do"));
    }

    #[test]
    fn scan_honors_exclusions_depth_cap_and_deep_gavin_root() {
        let dir = tempfile::tempdir().unwrap();
        // Excluded dir: a context inside node_modules must not be found.
        let hidden = dir.path().join("node_modules").join("pkg");
        std::fs::create_dir_all(hidden.join(GAVIN_DIR)).unwrap();
        // Deep .gavin-root: ignored entirely.
        let deep = dir.path().join("sub");
        std::fs::create_dir_all(deep.join(GAVIN_ROOT_DIR)).unwrap();
        // Beyond the depth cap: d1/d2/.../d13/.gavin must not be found.
        let mut too_deep = dir.path().to_path_buf();
        for i in 1..=13 {
            too_deep = too_deep.join(format!("d{i}"));
        }
        std::fs::create_dir_all(too_deep.join(GAVIN_DIR)).unwrap();

        let tree = scan_root(dir.path());
        assert_eq!(tree.contexts.len(), 0);
    }

    #[test]
    fn gavin_root_wins_when_root_has_both_markers() {
        let dir = tempfile::tempdir().unwrap();
        init_gavin_root(dir.path(), "WS").unwrap();
        std::fs::create_dir_all(dir.path().join(GAVIN_DIR).join("plans")).unwrap();
        let tree = scan_root(dir.path());
        // Only the Root context -- the root-level .gavin is ignored.
        assert_eq!(tree.contexts.len(), 1);
        assert_eq!(tree.contexts[0].kind, GavinContextKind::Root);
    }

    #[test]
    fn scan_of_missing_root_reports_root_missing() {
        let tree = scan_root(Path::new("/definitely/not/a/real/path"));
        assert!(tree.root_missing);
        assert!(tree.contexts.is_empty());
    }

    #[test]
    fn unparseable_config_toml_falls_back_to_folder_name_with_warning() {
        let dir = tempfile::tempdir().unwrap();
        let feature = dir.path().join("auth");
        std::fs::create_dir_all(feature.join(GAVIN_DIR)).unwrap();
        std::fs::write(feature.join(GAVIN_DIR).join("config.toml"), "not [ valid toml").unwrap();
        let tree = scan_root(dir.path());
        assert_eq!(tree.contexts.len(), 1);
        assert_eq!(tree.contexts[0].name, "auth");
        assert!(tree.contexts[0].config_warning);
    }
}
```

- [ ] **Step 9: Run** `cargo test -p gavin-daemon gavin::` — all green (fix as needed; the depth-cap arithmetic in particular: `walk(root, 1, …)` + `depth > MAX_SCAN_DEPTH` means `.gavin` at level 13 is skipped, level 12 found — verify the test agrees before adjusting either).

- [ ] **Step 10: Commit** — `git add crates/daemon && git commit -m "feat(daemon): gavin file model — frontmatter, scaffold, walker"`

---

### Task 3: Watcher + SessionManager wiring + protocol handling

**Files:**
- Modify: `crates/daemon/src/gavin.rs` (add `GavinWatcher`)
- Modify: `crates/daemon/src/server.rs` (SessionManager field + methods, handle_connection interception, handle_request arms, integration tests)

**Interfaces:**
- Consumes: Task 2's `scan_root`/`init_gavin_root`/`create_gavin_context`; `notify_debouncer_mini::new_debouncer`; `protocol::write_message`.
- Produces (for Task 4): daemon handling of all five gavin requests; `GavinTreeChanged` pushes on the watching connection's writer.

- [ ] **Step 1: Add `GavinWatcher` to `gavin.rs`.** Model it on `RepoPoller`, with all three of its review lessons baked in (weak Arc in the callback, min-interval floor, change-gated emission), and the whole decide-scan-compare-emit sequence under ONE mutex (the `HeuristicState` lesson — no split-primitive races). **Before writing the `new_debouncer` call, read `RepoPoller`'s own call in `server.rs` and match its exact signature/callback type** — the crate's API shifted across versions and the in-repo call is the ground truth, not the sketch below:

```rust
use protocol::Response;
use std::os::unix::net::UnixStream;
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

const RESCAN_DEBOUNCE: Duration = Duration::from_millis(500);
const MIN_RESCAN_INTERVAL: Duration = Duration::from_secs(2);

struct WatcherInner {
    last_tree: Option<GavinTree>,
    last_scan: Option<Instant>,
}

/// One per watched workspace root. Owns the debouncer; dropping the
/// watcher shuts the watch thread down -- which is exactly why the
/// debouncer callback must hold a Weak, not an Arc (the RepoPoller
/// reference-cycle Critical: a strong Arc in the callback would keep
/// `drop` from ever running, leaking the watch thread and OS watches
/// for the daemon's lifetime).
pub struct GavinWatcher {
    pub workspace_id: String,
    pub root_path: PathBuf,
    writer: Arc<Mutex<UnixStream>>,
    inner: Mutex<WatcherInner>,
    _debouncer: Mutex<Option<notify_debouncer_mini::Debouncer<notify::RecommendedWatcher>>>,
}

impl GavinWatcher {
    /// Creates the watcher, performs the initial scan, pushes the initial
    /// GavinTreeChanged, and starts the filesystem watch. Watch-setup
    /// failure degrades to scan-on-demand (spec §4): the initial push
    /// still happens and GetGavinTree still works.
    pub fn start(
        workspace_id: String,
        root_path: PathBuf,
        writer: Arc<Mutex<UnixStream>>,
    ) -> Arc<Self> {
        let watcher = Arc::new(GavinWatcher {
            workspace_id,
            root_path,
            writer,
            inner: Mutex::new(WatcherInner { last_tree: None, last_scan: None }),
            _debouncer: Mutex::new(None),
        });

        watcher.rescan_and_push();

        let weak: Weak<GavinWatcher> = Arc::downgrade(&watcher);
        let debouncer = notify_debouncer_mini::new_debouncer(
            RESCAN_DEBOUNCE,
            move |events: Result<Vec<notify_debouncer_mini::DebouncedEvent>, notify::Error>| {
                let Some(watcher) = weak.upgrade() else { return };
                let Ok(events) = events else { return };
                let relevant = events.iter().any(|e| {
                    e.path.components().any(|c| {
                        let s = c.as_os_str().to_string_lossy();
                        s == GAVIN_DIR || s == GAVIN_ROOT_DIR
                    })
                });
                if relevant {
                    watcher.rescan_and_push();
                }
            },
        );
        match debouncer {
            Ok(mut d) => {
                use notify::Watcher as _;
                if d.watcher()
                    .watch(&watcher.root_path, notify::RecursiveMode::Recursive)
                    .is_ok()
                {
                    *watcher._debouncer.lock().unwrap() = Some(d);
                }
            }
            Err(_) => {} // degrade to scan-on-demand, logged nowhere better to put it
        }
        watcher
    }

    /// The entire floor-check + scan + compare + emit runs under one lock:
    /// two debouncer flushes (or a flush racing an initial scan) can never
    /// interleave into an out-of-order emission.
    pub fn rescan_and_push(&self) {
        let mut inner = self.inner.lock().unwrap();
        if let Some(last) = inner.last_scan {
            let elapsed = last.elapsed();
            if elapsed < MIN_RESCAN_INTERVAL {
                std::thread::sleep(MIN_RESCAN_INTERVAL - elapsed);
            }
        }
        let tree = scan_root(&self.root_path);
        inner.last_scan = Some(Instant::now());
        if inner.last_tree.as_ref() == Some(&tree) {
            return; // change-gated: byte-identical trees never re-emit
        }
        inner.last_tree = Some(tree.clone());
        let response = Response::GavinTreeChanged {
            workspace_id: self.workspace_id.clone(),
            tree,
        };
        // A dead writer (app restarted) fails silently; the next
        // WatchGavinRoot from the new connection replaces this watcher.
        let mut writer = self.writer.lock().unwrap();
        let _ = protocol::write_message(&mut *writer, &response);
    }

    /// Fresh scan for GetGavinTree -- shares the floor/dedup state so a
    /// snapshot request can't defeat MIN_RESCAN_INTERVAL, but always
    /// returns the tree (even when unchanged).
    pub fn snapshot(&self) -> GavinTree {
        let mut inner = self.inner.lock().unwrap();
        if let Some(last) = inner.last_scan {
            if let Some(tree) = &inner.last_tree {
                if last.elapsed() < MIN_RESCAN_INTERVAL {
                    return tree.clone();
                }
            }
        }
        let tree = scan_root(&self.root_path);
        inner.last_scan = Some(Instant::now());
        inner.last_tree = Some(tree.clone());
        tree.clone()
    }
}
```

- [ ] **Step 2: Wire into `SessionManager`** (`server.rs`). Add the field beside `repo_pollers` and initialize it in `new()`:

```rust
    /// One per workspace with a watched gavin root. Keyed by workspace id;
    /// replaced wholesale on every WatchGavinRoot (idempotent re-watch,
    /// and how a restarted app's fresh connection takes over pushes).
    /// Never persisted, like repo_pollers.
    gavin_watchers: Mutex<HashMap<String, Arc<gavin::GavinWatcher>>>,
```

```rust
            gavin_watchers: Mutex::new(HashMap::new()),
```

Add the methods on `SessionManager`:

```rust
    pub fn watch_gavin_root(
        &self,
        workspace_id: &str,
        root_path: &str,
        writer: Arc<Mutex<UnixStream>>,
    ) {
        let watcher = gavin::GavinWatcher::start(
            workspace_id.to_string(),
            std::path::PathBuf::from(root_path),
            writer,
        );
        // Insert AFTER start: the old watcher (if any) drops here, tearing
        // down its debouncer thread.
        self.gavin_watchers.lock().unwrap().insert(workspace_id.to_string(), watcher);
    }

    pub fn unwatch_gavin_root(&self, workspace_id: &str) {
        self.gavin_watchers.lock().unwrap().remove(workspace_id);
    }

    pub fn gavin_tree_snapshot(&self, workspace_id: &str) -> Option<protocol::GavinTree> {
        let watcher = self.gavin_watchers.lock().unwrap().get(workspace_id).cloned();
        watcher.map(|w| w.snapshot())
    }
```

(Use the file's existing import style; `gavin::` items may need `use crate::gavin;` — the module is declared in `main.rs`, so within the crate refer to it as `crate::gavin`.)

- [ ] **Step 3: Intercept `WatchGavinRoot` in `handle_connection`** — it needs the connection's writer, exactly like `Attach` (server.rs:1154):

```rust
        if let Request::WatchGavinRoot { workspace_id, root_path } = req {
            manager.watch_gavin_root(&workspace_id, &root_path, Arc::clone(&writer));
            continue;
        }
```

Place it immediately after the existing `Attach` interception.

- [ ] **Step 4: Add the `handle_request` arms** (server.rs:1084's match, after the board arms):

```rust
        Request::WatchGavinRoot { .. } => {
            unreachable!("WatchGavinRoot is intercepted in handle_connection")
        }
        Request::UnwatchGavinRoot { workspace_id } => {
            manager.unwatch_gavin_root(&workspace_id);
            Response::Ok
        }
        Request::GetGavinTree { workspace_id } => match manager.gavin_tree_snapshot(&workspace_id) {
            Some(tree) => Response::GavinTreeSnapshot { workspace_id, tree },
            None => Response::Error {
                message: format!("no gavin root watched for workspace: {workspace_id}"),
            },
        },
        Request::InitGavinRoot { root_path, workspace_name } => {
            match crate::gavin::init_gavin_root(std::path::Path::new(&root_path), &workspace_name) {
                Ok(()) => Response::Ok,
                Err(e) => Response::Error { message: e.to_string() },
            }
        }
        Request::CreateGavinContext { parent_folder } => {
            match crate::gavin::create_gavin_context(std::path::Path::new(&parent_folder)) {
                Ok(()) => Response::Ok,
                Err(e) => Response::Error { message: e.to_string() },
            }
        }
```

- [ ] **Step 5: Integration tests** in server.rs's existing `mod tests` (socket-level, using `start_test_server` + the `request` helper; read a nearby streaming test first for the read-loop idiom):

```rust
    #[test]
    fn watch_gavin_root_pushes_initial_tree_then_changes() {
        let (socket_path, _dir) = start_test_server();
        let ws_dir = tempfile::tempdir().unwrap();
        crate::gavin::init_gavin_root(ws_dir.path(), "WS").unwrap();

        let mut stream = UnixStream::connect(&socket_path).unwrap();
        write_message(
            &mut stream,
            &Request::WatchGavinRoot {
                workspace_id: "ws-1".to_string(),
                root_path: ws_dir.path().to_string_lossy().to_string(),
            },
        )
        .unwrap();

        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let first: Response = read_message(&mut reader).unwrap().unwrap();
        match &first {
            Response::GavinTreeChanged { workspace_id, tree } => {
                assert_eq!(workspace_id, "ws-1");
                assert!(!tree.root_missing);
                assert_eq!(tree.contexts.len(), 1);
                assert!(tree.contexts[0].has_prd);
            }
            other => panic!("expected initial GavinTreeChanged, got {other:?}"),
        }

        // A new plan file must produce a second push. (Debounce 500ms +
        // floor 2s: the blocking read simply waits it out.)
        std::fs::write(
            ws_dir.path().join(".gavin-root").join("plans").join("new.md"),
            "---\nstatus: To Do\n---\n# New\n",
        )
        .unwrap();
        let second: Response = read_message(&mut reader).unwrap().unwrap();
        match second {
            Response::GavinTreeChanged { tree, .. } => {
                assert_eq!(tree.contexts[0].plans.len(), 1);
                assert_eq!(tree.contexts[0].plans[0].file_name, "new.md");
            }
            other => panic!("expected change push, got {other:?}"),
        }
    }

    #[test]
    fn watching_a_missing_root_reports_root_missing_and_get_tree_replies() {
        let (socket_path, _dir) = start_test_server();
        let mut stream = UnixStream::connect(&socket_path).unwrap();
        write_message(
            &mut stream,
            &Request::WatchGavinRoot {
                workspace_id: "ws-2".to_string(),
                root_path: "/definitely/not/real".to_string(),
            },
        )
        .unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let first: Response = read_message(&mut reader).unwrap().unwrap();
        match first {
            Response::GavinTreeChanged { tree, .. } => assert!(tree.root_missing),
            other => panic!("expected GavinTreeChanged, got {other:?}"),
        }

        // GetGavinTree over a second (command-style) connection.
        let mut cmd = UnixStream::connect(&socket_path).unwrap();
        let resp = request(&mut cmd, &Request::GetGavinTree { workspace_id: "ws-2".to_string() });
        match resp {
            Response::GavinTreeSnapshot { workspace_id, tree } => {
                assert_eq!(workspace_id, "ws-2");
                assert!(tree.root_missing);
            }
            other => panic!("expected snapshot, got {other:?}"),
        }
        let resp =
            request(&mut cmd, &Request::GetGavinTree { workspace_id: "never-watched".to_string() });
        assert!(matches!(resp, Response::Error { .. }));
    }

    #[test]
    fn init_and_create_context_over_socket_are_idempotent() {
        let (socket_path, _dir) = start_test_server();
        let ws_dir = tempfile::tempdir().unwrap();
        let mut cmd = UnixStream::connect(&socket_path).unwrap();
        let root = ws_dir.path().to_string_lossy().to_string();

        let resp = request(
            &mut cmd,
            &Request::InitGavinRoot { root_path: root.clone(), workspace_name: "WS".to_string() },
        );
        assert!(matches!(resp, Response::Ok));
        let resp = request(
            &mut cmd,
            &Request::InitGavinRoot { root_path: root, workspace_name: "WS".to_string() },
        );
        assert!(matches!(resp, Response::Ok)); // idempotent second run

        let feature = ws_dir.path().join("auth");
        std::fs::create_dir_all(&feature).unwrap();
        let resp = request(
            &mut cmd,
            &Request::CreateGavinContext {
                parent_folder: feature.to_string_lossy().to_string(),
            },
        );
        assert!(matches!(resp, Response::Ok));
        assert!(feature.join(".gavin").join("config.toml").is_file());

        let resp = request(
            &mut cmd,
            &Request::CreateGavinContext { parent_folder: "/not/a/real/dir".to_string() },
        );
        assert!(matches!(resp, Response::Error { .. }));
    }
```

- [ ] **Step 6: Unit-test change-gating and teardown** — add to `gavin.rs`'s test module. `UnixStream::pair()` + a read timeout makes the "nothing was emitted" negative assertions deadline-safe (no hanging read):

```rust
    #[test]
    fn watcher_pushes_once_per_change_and_stops_after_drop() {
        use std::io::BufReader;
        use std::os::unix::net::UnixStream;

        let dir = tempfile::tempdir().unwrap();
        init_gavin_root(dir.path(), "WS").unwrap();
        let (ours, theirs) = UnixStream::pair().unwrap();
        ours.set_read_timeout(Some(Duration::from_millis(400))).unwrap();
        let writer = Arc::new(Mutex::new(theirs));

        let watcher = GavinWatcher::start(
            "ws-1".to_string(),
            dir.path().to_path_buf(),
            Arc::clone(&writer),
        );

        let mut reader = BufReader::new(ours);
        // Initial scan pushed exactly once.
        let first: Option<protocol::Response> = protocol::read_message(&mut reader).unwrap();
        assert!(matches!(first, Some(Response::GavinTreeChanged { .. })));

        // A manual rescan with NO underlying change must not emit again:
        // the next read times out instead of yielding a message.
        watcher.rescan_and_push();
        let timed_out: Result<Option<protocol::Response>, _> = protocol::read_message(&mut reader);
        assert!(timed_out.is_err(), "change-gating failed: an unchanged rescan emitted");

        // After drop, even a real change must emit nothing.
        drop(watcher);
        std::fs::write(
            dir.path().join(GAVIN_ROOT_DIR).join("plans").join("late.md"),
            "---\nstatus: To Do\n---\n",
        )
        .unwrap();
        let after_drop: Result<Option<protocol::Response>, _> = protocol::read_message(&mut reader);
        assert!(after_drop.is_err(), "a dropped watcher still emitted");
    }
```

(If `rescan_and_push`'s floor makes this test sleep ~2 s, that is acceptable — it is the floor working; do not weaken the floor for the test.)

- [ ] **Step 7: Run** `cargo test -p gavin-daemon` — all green, including every pre-existing test (the new field must not disturb `SessionManager::new` callers; its signature is unchanged).

- [ ] **Step 8: Commit** — `git add crates/daemon && git commit -m "feat(daemon): gavin root watcher, scan pushes, scaffold requests"`

---

### Task 4: Tauri layer — commands, relay arm, config schema

**Files:**
- Modify: `app/src-tauri/src/config.rs` (Workspace.root_path + tests)
- Modify: `app/src-tauri/src/session.rs` (commands, relay arm, two Workspace literals)
- Modify: `app/src-tauri/src/lib.rs` **or** wherever `tauri::generate_handler![...]` lists commands (grep `invoke_handler` — add the five new command names)
- Modify: `app/src/lib/backend.ts`
- Create: `app/src/lib/gavin.ts` (TS mirror types)

**Interfaces:**
- Consumes: Task 1 protocol variants; Task 3 daemon behavior; existing `DaemonConnection` (streaming writer) and `CommandConnection` states; `send_request`/`send_command` helpers (session.rs:188/204).
- Produces (for Tasks 5-6): Tauri commands `watch_gavin_root(workspaceId, rootPath)`, `unwatch_gavin_root(workspaceId)`, `get_gavin_tree(workspaceId)`, `init_gavin_root(rootPath, workspaceName)`, `create_gavin_context(parentFolder)`, `gavin_root_exists(rootPath) -> bool`; Tauri event `gavin-tree-changed` with payload `(workspaceId, GavinTree)`; backend.ts wrappers of all six; TS types in `gavin.ts`.

- [ ] **Step 1: config.rs — add the field** to `Workspace` (after `active_view`):

```rust
    /// The workspace's bound root directory (agent-orchestration phase).
    /// Optional and never auto-cleared: a missing-on-disk root keeps its
    /// stale value so a remounted volume heals without user action.
    #[serde(default)]
    pub root_path: Option<String>,
```

Update the three construction sites (each gains `root_path: None`): `config.rs` `sample_workspace()`, `session.rs:448` test helper `workspace()`, `session.rs:712` Unfiled literal. Update `config.rs`'s `workspace_serializes_to_the_camel_case_shape_the_frontend_expects` expected JSON to include `"rootPath": null`, and add:

```rust
    #[test]
    fn load_defaults_root_path_to_none_when_absent_from_an_older_workspace_object() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            config_path(dir.path()),
            r#"{"workspaces": [{"id": "ws-1", "name": "A", "pages": [], "activePageId": null}]}"#,
        )
        .unwrap();
        let config = load(dir.path()).unwrap();
        assert_eq!(config.workspaces[0].root_path, None);
    }

    #[test]
    fn root_path_roundtrips_through_save_and_load() {
        let dir = tempfile::tempdir().unwrap();
        let mut ws = sample_workspace();
        ws.root_path = Some("/Users/alice/project".to_string());
        let config = AppConfig {
            workspaces: vec![ws],
            active_workspace_id: Some("workspace-1".to_string()),
            session_names: HashMap::new(),
            file_tabs: HashMap::new(),
        };
        save(dir.path(), &config).unwrap();
        assert_eq!(load(dir.path()).unwrap(), config);
    }
```

- [ ] **Step 2: session.rs — relay arm.** In the streaming reader loop's match (session.rs:790-810), add beside `Response::SessionRestored`:

```rust
                Response::GavinTreeChanged { workspace_id, tree } => {
                    let _ = reader_app_handle.emit("gavin-tree-changed", (workspace_id, tree));
                }
```

- [ ] **Step 3: session.rs — commands.** `watch_gavin_root` sends on the **streaming** connection (mirror `write_input`'s use of `DaemonConnection`); the rest use `send_command` on `CommandConnection` (mirror `kill_session`); `gavin_root_exists` is a pure local fs check:

```rust
#[tauri::command]
pub fn watch_gavin_root(
    workspace_id: String,
    root_path: String,
    conn: State<DaemonConnection>,
) -> Result<(), String> {
    send_request(&conn.writer, &Request::WatchGavinRoot { workspace_id, root_path })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn unwatch_gavin_root(
    workspace_id: String,
    state: State<CommandConnection>,
) -> Result<(), String> {
    let resp =
        send_command(&state.0, &Request::UnwatchGavinRoot { workspace_id }).map_err(|e| e.to_string())?;
    match resp {
        Response::Ok => Ok(()),
        Response::Error { message } => Err(message),
        other => Err(format!("unexpected response: {other:?}")),
    }
}

#[tauri::command]
pub fn get_gavin_tree(
    workspace_id: String,
    state: State<CommandConnection>,
) -> Result<protocol::GavinTree, String> {
    let resp =
        send_command(&state.0, &Request::GetGavinTree { workspace_id }).map_err(|e| e.to_string())?;
    match resp {
        Response::GavinTreeSnapshot { tree, .. } => Ok(tree),
        Response::Error { message } => Err(message),
        other => Err(format!("unexpected response: {other:?}")),
    }
}

#[tauri::command]
pub fn init_gavin_root(
    root_path: String,
    workspace_name: String,
    state: State<CommandConnection>,
) -> Result<(), String> {
    let resp = send_command(&state.0, &Request::InitGavinRoot { root_path, workspace_name })
        .map_err(|e| e.to_string())?;
    match resp {
        Response::Ok => Ok(()),
        Response::Error { message } => Err(message),
        other => Err(format!("unexpected response: {other:?}")),
    }
}

#[tauri::command]
pub fn create_gavin_context(
    parent_folder: String,
    state: State<CommandConnection>,
) -> Result<(), String> {
    let resp = send_command(&state.0, &Request::CreateGavinContext { parent_folder })
        .map_err(|e| e.to_string())?;
    match resp {
        Response::Ok => Ok(()),
        Response::Error { message } => Err(message),
        other => Err(format!("unexpected response: {other:?}")),
    }
}

/// Local fs probe for the set-root flow's init-vs-bind fork (spec §2) --
/// the frontend can't stat the disk itself, and watching hasn't started
/// yet at the moment the picker returns.
#[tauri::command]
pub fn gavin_root_exists(root_path: String) -> bool {
    std::path::Path::new(&root_path).join(".gavin-root").is_dir()
}
```

Adjust to the file's real state names if they differ (read the neighboring commands first; e.g. `DaemonConnection`'s field is `writer` per session.rs:744).

- [ ] **Step 4: Register the commands** — grep `invoke_handler` under `app/src-tauri/src/`, add all six names to the `generate_handler![...]` list.

- [ ] **Step 5: TS types + backend wrappers.** Create `app/src/lib/gavin.ts`:

```typescript
export interface PlanFileInfo {
  path: string;
  fileName: string;
  title: string;
  status: string | null;
  priority: "none" | "low" | "medium" | "high" | "urgent" | null;
  parseWarning: boolean;
}

export interface MdFileInfo {
  path: string;
  relPath: string;
}

export interface GavinContext {
  folderPath: string;
  kind: "root" | "context";
  name: string;
  plans: PlanFileInfo[];
  docs: MdFileInfo[];
  specs: MdFileInfo[];
  hasPrd: boolean;
  configWarning: boolean;
}

export interface GavinTree {
  rootPath: string;
  rootMissing: boolean;
  contexts: GavinContext[];
}
```

Append to `app/src/lib/backend.ts`:

```typescript
export function watchGavinRoot(workspaceId: string, rootPath: string): Promise<void> {
  return invoke("watch_gavin_root", { workspaceId, rootPath });
}

export function unwatchGavinRoot(workspaceId: string): Promise<void> {
  return invoke("unwatch_gavin_root", { workspaceId });
}

export function getGavinTree(workspaceId: string): Promise<GavinTree> {
  return invoke("get_gavin_tree", { workspaceId });
}

export function initGavinRoot(rootPath: string, workspaceName: string): Promise<void> {
  return invoke("init_gavin_root", { rootPath, workspaceName });
}

export function createGavinContext(parentFolder: string): Promise<void> {
  return invoke("create_gavin_context", { parentFolder });
}

export function gavinRootExists(rootPath: string): Promise<boolean> {
  return invoke("gavin_root_exists", { rootPath });
}
```

with `import type { GavinTree } from "./gavin";` at the top.

- [ ] **Step 6: Verify** — `cargo build` (workspace root) + `cargo test -p app` + `cd app && npx svelte-check` (or the project's `npm run check`) all clean.

- [ ] **Step 7: Commit** — `git add app crates && git commit -m "feat(app): gavin tree commands, relay, workspace root_path"`

---

### Task 5: Frontend state — gavinState.ts, rootPath, setWorkspaceRoot

**Files:**
- Modify: `app/src/lib/workspace.ts` (Workspace interface)
- Create: `app/src/lib/gavinState.ts`
- Test: `app/src/lib/gavinState.test.ts`
- Modify: `app/src/lib/layoutState.ts` (bootstrap wiring + setWorkspaceRoot)
- Modify: `app/src/lib/layoutState.test.ts` (mock factory additions)

**Interfaces:**
- Consumes: Task 4's backend wrappers + `gavin-tree-changed` event; existing `persistWorkspaces`, `bootstrap()` listener block, `pollForStartupState`.
- Produces (for Task 6): `gavinTrees` store (`Record<string, GavinTree>`); `initGavinListeners(): Promise<UnlistenFn>`; `watchRootedWorkspaces(workspaces: Workspace[]): void` (once-guarded); `setWorkspaceRoot(workspaceId: string, rootPath: string): Promise<void>` exported from layoutState.ts; `Workspace.rootPath?: string`.

- [ ] **Step 1: workspace.ts** — add to the `Workspace` interface after `activeView?`:

```typescript
  rootPath?: string;
```

- [ ] **Step 2: Write the failing tests** in `app/src/lib/gavinState.test.ts` (mock factory pattern copied from kanbanState.test.ts / layoutState.test.ts — read one first; remember `.mockResolvedValue(undefined)` for anything `.catch()`ed):

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { get } from "svelte/store";

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));
vi.mock("./backend", () => ({
  watchGavinRoot: vi.fn().mockResolvedValue(undefined),
  unwatchGavinRoot: vi.fn().mockResolvedValue(undefined),
}));

import { listen } from "@tauri-apps/api/event";
import * as backend from "./backend";
import { gavinTrees, initGavinListeners, watchRootedWorkspaces, __resetForTesting } from "./gavinState";
import type { GavinTree } from "./gavin";

function ws(id: string, rootPath?: string) {
  return { id, name: id, pages: [], activePageId: null, rootPath };
}

const tree: GavinTree = { rootPath: "/tmp/ws", rootMissing: false, contexts: [] };

describe("gavinState", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetForTesting();
  });

  it("stores a pushed tree under its workspace id", async () => {
    await initGavinListeners();
    const handler = vi.mocked(listen).mock.calls[0][1] as (e: { payload: [string, GavinTree] }) => void;
    handler({ payload: ["ws-1", tree] });
    expect(get(gavinTrees)["ws-1"]).toEqual(tree);
  });

  it("watches only workspaces that have a rootPath", () => {
    watchRootedWorkspaces([ws("ws-1", "/tmp/a"), ws("ws-2"), ws("ws-3", "/tmp/c")]);
    expect(backend.watchGavinRoot).toHaveBeenCalledTimes(2);
    expect(backend.watchGavinRoot).toHaveBeenCalledWith("ws-1", "/tmp/a");
    expect(backend.watchGavinRoot).toHaveBeenCalledWith("ws-3", "/tmp/c");
  });

  it("watches at most once even if both ready paths fire", () => {
    watchRootedWorkspaces([ws("ws-1", "/tmp/a")]);
    watchRootedWorkspaces([ws("ws-1", "/tmp/a")]);
    expect(backend.watchGavinRoot).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 3: Run them to verify they fail** — `cd app && npx vitest run src/lib/gavinState.test.ts` → module not found.

- [ ] **Step 4: Write `app/src/lib/gavinState.ts`**:

```typescript
import { writable } from "svelte/store";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import * as backend from "./backend";
import type { GavinTree } from "./gavin";
import type { Workspace } from "./workspace";

// One live tree per workspace with a watched root. Fed exclusively by
// gavin-tree-changed pushes (the initial WatchGavinRoot scan arrives as
// the first push -- there is no request/reply on the streaming
// connection).
export const gavinTrees = writable<Record<string, GavinTree>>({});

// Guards watchRootedWorkspaces against double-registration: bootstrap has
// two "workspaces are ready" paths (the workspaces-ready event and
// pollForStartupState), and whichever runs second must be a no-op.
let watchedOnce = false;

export async function initGavinListeners(): Promise<UnlistenFn> {
  return listen<[string, GavinTree]>("gavin-tree-changed", (event) => {
    const [workspaceId, tree] = event.payload;
    gavinTrees.update((m) => ({ ...m, [workspaceId]: tree }));
  });
}

export function watchRootedWorkspaces(workspaces: Workspace[]): void {
  if (watchedOnce) return;
  watchedOnce = true;
  for (const ws of workspaces) {
    // Best-effort: a failed watch shows as a missing tree, never blocks
    // startup.
    if (ws.rootPath) void backend.watchGavinRoot(ws.id, ws.rootPath).catch(() => {});
  }
}

/** @internal test-only reset for module-level state */
export function __resetForTesting(): void {
  watchedOnce = false;
  gavinTrees.set({});
}
```

- [ ] **Step 5: Run the tests** — all pass.

- [ ] **Step 6: Wire into layoutState.ts.** In `bootstrap()`'s listener block (with the other `unlisteners.push(...)` calls, BEFORE any watch can fire):

```typescript
  unlisteners.push(await initGavinListeners());
```

In the `workspaces-ready` handler AND in `pollForStartupState`'s ready branch, immediately after each `layoutState.update` that sets `status: "ready"`:

```typescript
      watchRootedWorkspaces(resolved.state.workspaces);
```

(import `{ initGavinListeners, watchRootedWorkspaces }` from `./gavinState`). Then add the orchestration action near the other workspace actions:

```typescript
// Binds (or re-binds) a workspace to a root directory: persists the new
// rootPath, tears down the old watch when the root actually changed, and
// starts the new one. Init (scaffolding) happens BEFORE this is called --
// see WorkspaceRootControl -- so the first push already sees the skeleton.
export async function setWorkspaceRoot(workspaceId: string, rootPath: string): Promise<void> {
  const state = get(layoutState);
  const previous = state.workspaces.find((w) => w.id === workspaceId)?.rootPath;
  const workspaces = state.workspaces.map((w) => (w.id === workspaceId ? { ...w, rootPath } : w));
  layoutState.update((s) => ({ ...s, workspaces }));
  await persistWorkspaces(workspaces, state.activeWorkspaceId);
  if (previous && previous !== rootPath) {
    await backend.unwatchGavinRoot(workspaceId).catch(() => {});
  }
  void backend.watchGavinRoot(workspaceId, rootPath).catch(() => {});
}
```

- [ ] **Step 7: layoutState tests.** Add `watchGavinRoot: vi.fn().mockResolvedValue(undefined)` and `unwatchGavinRoot: vi.fn().mockResolvedValue(undefined)` to layoutState.test.ts's backend mock factory (it will throw "not a function" otherwise), then add:

```typescript
  it("setWorkspaceRoot persists the root and starts watching", async () => {
    setState(stateWithWorkspace("ws-1"));
    await setWorkspaceRoot("ws-1", "/tmp/root");
    expect(backend.setWorkspacesState).toHaveBeenCalled();
    const persisted = vi.mocked(backend.setWorkspacesState).mock.calls.at(-1)![0];
    expect(persisted.find((w: Workspace) => w.id === "ws-1")?.rootPath).toBe("/tmp/root");
    expect(backend.watchGavinRoot).toHaveBeenCalledWith("ws-1", "/tmp/root");
    expect(backend.unwatchGavinRoot).not.toHaveBeenCalled();
  });

  it("setWorkspaceRoot unwatches first when re-binding to a different root", async () => {
    setState(stateWithWorkspace("ws-1", { rootPath: "/tmp/old" }));
    await setWorkspaceRoot("ws-1", "/tmp/new");
    expect(backend.unwatchGavinRoot).toHaveBeenCalledWith("ws-1");
    expect(backend.watchGavinRoot).toHaveBeenCalledWith("ws-1", "/tmp/new");
  });
```

Adapt `setState`/`stateWithWorkspace` to the file's actual existing helpers — read them first and reuse; do not invent new helper names if equivalents exist.

- [ ] **Step 8: Run** the full frontend suite (`cd app && npx vitest run`) + `npx svelte-check` — green, no type errors anywhere.

- [ ] **Step 9: Commit** — `git add app/src && git commit -m "feat(app): gavin tree state, rootPath, setWorkspaceRoot"`

---

### Task 6: Hub UI — root banner/chip, picker, init modal, smoke list

**Files:**
- Create: `app/src/lib/WorkspaceRootControl.svelte`
- Modify: `app/src/routes/+page.svelte`

**Interfaces:**
- Consumes: `setWorkspaceRoot` (Task 5), `gavinTrees` store, `backend.gavinRootExists`/`initGavinRoot`, `open` from `@tauri-apps/plugin-dialog` (dependency + `dialog:default` grant both already present — verified), `Modal.svelte`, `UNFILED_WORKSPACE_ID`.
- Produces: the spec §2 UI. This is the only UI in the sub-project; sub-6 will restyle/reposition it.

- [ ] **Step 1: `WorkspaceRootControl.svelte`** — the full component. The chip shows the raw root path with left-side CSS ellipsis (the tail of a path is its informative end); no home-abbreviation helper — nothing in the app exposes the home dir today, and the tooltip already carries the full path:

```svelte
<script lang="ts">
  import { open } from "@tauri-apps/plugin-dialog";
  import { layoutState, setWorkspaceRoot } from "./layoutState";
  import { gavinTrees } from "./gavinState";
  import * as backend from "./backend";
  import { UNFILED_WORKSPACE_ID, type Workspace } from "./workspace";
  import Modal from "./Modal.svelte";

  interface Props {
    workspace: Workspace;
  }
  let { workspace }: Props = $props();

  // pendingRoot is non-null while the "Initialize gavin here?" modal is up.
  let pendingRoot = $state<string | null>(null);
  let errorMessage = $state<string | null>(null);

  const tree = $derived($gavinTrees[workspace.id]);
  const rootMissing = $derived(Boolean(workspace.rootPath && tree?.rootMissing));

  async function pickRoot(): Promise<void> {
    errorMessage = null;
    const picked = await open({ directory: true, multiple: false, title: "Choose workspace root" });
    if (typeof picked !== "string") return;
    if (await backend.gavinRootExists(picked)) {
      await setWorkspaceRoot(workspace.id, picked);
    } else {
      pendingRoot = picked;
    }
  }

  async function confirmInit(): Promise<void> {
    if (!pendingRoot) return;
    const root = pendingRoot;
    pendingRoot = null;
    try {
      await backend.initGavinRoot(root, workspace.name);
    } catch (e) {
      errorMessage = `Couldn't initialize gavin: ${e}`;
      return;
    }
    await setWorkspaceRoot(workspace.id, root);
  }

  async function bindWithoutInit(): Promise<void> {
    if (!pendingRoot) return;
    const root = pendingRoot;
    pendingRoot = null;
    await setWorkspaceRoot(workspace.id, root);
  }
</script>

{#if workspace.id !== UNFILED_WORKSPACE_ID}
  {#if !workspace.rootPath}
    <div class="banner">
      <span>No root folder set — bind this workspace to a directory to enable gavin features.</span>
      <button type="button" onclick={pickRoot}>Set root…</button>
    </div>
  {:else if rootMissing}
    <div class="banner warning">
      <span>Root not found: {workspace.rootPath}</span>
      <button type="button" onclick={pickRoot}>Re-pick…</button>
    </div>
  {:else}
    <div class="chip" title={workspace.rootPath}>
      <span class="path">{workspace.rootPath}</span>
      <button type="button" class="gear" onclick={pickRoot} title="Change workspace root">⚙</button>
    </div>
  {/if}
  {#if errorMessage}
    <div class="banner warning"><span>{errorMessage}</span></div>
  {/if}
{/if}

{#if pendingRoot}
  <Modal onClose={() => (pendingRoot = null)}>
    <p>Initialize gavin in this folder?</p>
    <p class="detail">{pendingRoot}</p>
    <p class="detail">Creates .gavin-root/ with a PRD template, config, and plans/docs/specs folders. Nothing existing is overwritten.</p>
    <div class="actions">
      <button type="button" onclick={confirmInit}>Initialize</button>
      <button type="button" onclick={bindWithoutInit}>Bind without initializing</button>
      <button type="button" onclick={() => (pendingRoot = null)}>Cancel</button>
    </div>
  </Modal>
{/if}

<style>
  .banner {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 12px;
    margin: 6px 10px 0;
    background: #2a2a2a;
    border: 1px solid #444;
    border-radius: 6px;
    color: #ccc;
    font-family: monospace;
    font-size: 0.8em;
  }
  .banner.warning {
    border-color: #a15c2f;
    color: #e0b08a;
  }
  .banner button,
  .actions button {
    background: #3a3a3a;
    border: none;
    color: #eee;
    padding: 4px 10px;
    border-radius: 4px;
    cursor: pointer;
    font-family: monospace;
    font-size: 1em;
  }
  .chip {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 6px 10px 0;
    padding: 3px 10px;
    color: #888;
    font-family: monospace;
    font-size: 0.75em;
  }
  .path {
    max-width: 360px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    direction: rtl; /* ellipsis on the LEFT: a path's tail is its informative end */
  }
  .gear {
    background: transparent;
    border: none;
    color: #888;
    cursor: pointer;
    padding: 0 2px;
  }
  .gear:hover {
    color: #eee;
  }
  .detail {
    opacity: 0.7;
    font-size: 0.85em;
    word-break: break-all;
  }
  .actions {
    display: flex;
    gap: 8px;
    margin-top: 12px;
  }
</style>
```

Note on the modal: spec §2 says an existing `.gavin-root` binds silently and a missing one asks to initialize — "Bind without initializing" covers the user who wants the root without the scaffold yet; Cancel abandons the pick entirely. `bindWithoutInit` is a deliberate small extension of the spec's two-way fork; keep it (harmless, reversible — init remains available any time via the agent or a later re-pick).

- [ ] **Step 2: Mount it in `+page.svelte`.** In the hub branch (`.content`), between `.tabs` and `.view`:

```svelte
          <WorkspaceRootControl workspace={activeWorkspace} />
```

with the import beside the other `$lib` imports. The banner therefore appears on every hub view (kanban today); the terminal view is untouched.

- [ ] **Step 3: Verify** — `npx svelte-check` clean; `npx vitest run` green; `cargo build` still clean.

- [ ] **Step 4: Manual GUI smoke test (human-performed — present this list to the user, do not claim it passed):**
  1. Open a workspace's hub (kanban tab) → "No root folder set" banner shows (Unfiled: no banner).
  2. Set root → pick this repo → "Initialize gavin here?" → Initialize → `.gavin-root/` appears on disk with PRD.md/config.toml/plans/docs/specs, and the banner becomes the `~/…` chip.
  3. `config.json` now contains the workspace's `rootPath`; restart the app → chip still there (watch re-registers, no banner flash).
  4. Rename the root folder away → banner "Root not found: …" appears (may take up to the debounce+floor window); rename it back → chip returns.
  5. ⚙ → pick a different folder that already has `.gavin-root` → binds silently, no modal.
  6. Create `.gavin-root/plans/test.md` with `---\nstatus: To Do\n---` from a terminal — no visible UI yet (tree consumers arrive in sub-projects 2/5), but no errors/crashes.

- [ ] **Step 5: Commit** — `git add app/src && git commit -m "feat(app): workspace root binding UI — banner, picker, init modal"`

---

## Testing summary

- Rust: 16 new unit tests (Task 2), 1 pair-based watcher unit test + 3 socket-level integration tests (Task 3), 2 new config tests + shape-test updates (Task 4).
- Frontend: 3 gavinState tests, 2 setWorkspaceRoot tests; **no Svelte component tests** (codebase-wide convention — WorkspaceRootControl is covered by the manual smoke list only).
- Full gates per task: `cargo test` (workspace), `npx vitest run`, `npx svelte-check`, `cargo build`.

## Out of scope (later sub-projects)

Board projection & status write-back *wiring* (sub-2; `write_plan_status` ships tested but uncalled), MCP server (sub-3), CodeMirror editing (sub-4), plan explorer (sub-5), orchestration home & nav restyle (sub-6).
