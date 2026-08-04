# File Viewer — Schema + Backend (Part 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the file-tab data model (persisted across restarts) and the Tauri commands for reading, watching, and path-resolving files, so Part 2's viewer UI has everything it needs.

**Architecture:** A file tab is just another opaque id in the pane tree's existing `tabs: string[]` — no `LayoutNode` change at all. A parallel `fileTabsById` map (frontend) / `file_tabs` map (persisted `AppConfig`) carries the one extra thing a file tab needs: its path. The two places that currently assume "every tab id is a session id" — `resolve_sessions` and `bootstrap`'s Attach loop — learn to skip file tabs. Three new file-I/O Tauri commands (`read_file_for_viewer`, `watch_file_for_viewer`, `unwatch_file_for_viewer`) plus `resolve_path_under_cursor` live in a new `app/src-tauri/src/fileviewer.rs`, with no daemon involvement whatsoever.

**Tech Stack:** Rust, Tauri 2, `notify` + `notify-debouncer-mini`, TypeScript/Vitest.

## Global Constraints

- **Part 2 is a separate plan.** This plan must NOT touch `FileViewerPane.svelte` (doesn't exist yet), `Pane.svelte`, `confirmClose.ts`, or add any frontend rendering dependency (`highlight.js`, `marked`, `DOMPurify`, `@xterm/addon-web-links` are all Part 2). `backend.ts` wrappers ARE in scope here — this project's established convention, set by both the kanban backend plan and the integration-layer backend plan.
- **No daemon changes.** `crates/daemon` and `crates/protocol` are untouched. File I/O lives entirely in `app/src-tauri`.
- `AppConfig` (`app/src-tauri/src/config.rs`) has **no** `#[serde(rename_all = "camelCase")]` — its JSON keys are snake_case (`active_workspace_id`, `session_names`). The new field is therefore `file_tabs` in JSON too. Do not add a rename attribute; matching the existing file exactly matters more than consistency with `Workspace`/`Page` (which DO use camelCase).
- Adding a field to `AppConfig` breaks every Rust struct-literal construction site (Rust requires every field named explicitly). There are exactly **4**: `config.rs:121`, `config.rs:137`, `config.rs:223` (all tests), and `session.rs:50` (inside `persist_workspaces`). Each is handled explicitly in Task 1.
- `persist_workspaces` (`session.rs`) is the single funnel every `AppConfig` save goes through, and its doc comment states the rule: *"every command that saves one must read the other's current value too, or it would silently reset the other field to empty on every save."* `file_tabs` becomes a third field subject to that exact trap — it must be threaded through `persist_workspaces`, never reconstructed independently at a call site.
- Size cap for `read_file_for_viewer`: **1 MiB** (`1024 * 1024` bytes).
- Debounce for the file watcher: **500ms**, matching the daemon's own `GIT_STATUS_DEBOUNCE`.
- User works directly on `main` (no worktree) — standing preference for this project.
- This session has hit the 200-subagent spawn cap seven times, always on a fresh plan's first dispatch, each time resolved by the user choosing direct controller implementation. Expect it may happen again; it is not a sign anything is wrong with this plan.
- Every commit stages only the files that specific task actually needs — never `git add -A` / `git add .`.

---

### Task 1: `AppConfig.file_tabs` + persistence plumbing

**Files:**
- Modify: `app/src-tauri/src/config.rs`
- Modify: `app/src-tauri/src/session.rs`

**Interfaces:**
- Produces: `AppConfig.file_tabs: HashMap<String, String>` (tab id → absolute path); `persist_workspaces(config_dir, data, session_names, file_tabs)` (signature gains a 4th parameter); `pub struct FileTabs(pub Mutex<HashMap<String, String>>)` managed state; `get_file_tabs()` / `set_file_tabs(file_tabs)` Tauri commands.

- [ ] **Step 1: Write the failing tests**

Add to `config.rs`'s `mod tests`, after `load_defaults_session_names_when_the_field_is_absent`:

```rust
    #[test]
    fn file_tabs_roundtrip_alongside_workspaces() {
        let dir = tempfile::tempdir().unwrap();
        let mut file_tabs = HashMap::new();
        file_tabs.insert("tab-1".to_string(), "/Users/alice/project/README.md".to_string());
        let config = AppConfig {
            workspaces: vec![sample_workspace()],
            active_workspace_id: Some("workspace-1".to_string()),
            session_names: HashMap::new(),
            file_tabs,
        };
        save(dir.path(), &config).unwrap();

        let loaded = load(dir.path()).unwrap();
        assert_eq!(loaded, config);
        assert_eq!(
            loaded.file_tabs.get("tab-1"),
            Some(&"/Users/alice/project/README.md".to_string())
        );
    }

    #[test]
    fn load_defaults_file_tabs_when_the_field_is_absent_from_an_older_config_file() {
        let dir = tempfile::tempdir().unwrap();
        // A real config.json from before the file viewer shipped: has
        // workspaces and session_names, no file_tabs key at all.
        std::fs::write(
            config_path(dir.path()),
            r#"{"workspaces": [], "active_workspace_id": null, "session_names": {"abc-123": "my project"}}"#,
        )
        .unwrap();

        let config = load(dir.path()).unwrap();
        assert_eq!(config.file_tabs, HashMap::new());
        assert_eq!(config.session_names.get("abc-123"), Some(&"my project".to_string()));
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from the repo root): `source "$HOME/.cargo/env" && cargo test -p app config::`
Expected: FAIL to compile — `AppConfig` has no `file_tabs` field.

- [ ] **Step 3: Add the field**

In `config.rs`, add to `AppConfig` as its last field:

```rust
    /// Open file-viewer tabs, keyed by tab id (the same opaque id space as
    /// session ids in the pane tree's `tabs` array -- a tab id appearing
    /// here means "this tab shows a file," not "this is a terminal
    /// session"). Value is the file's absolute path. Like `session_names`,
    /// this persists alongside `workspaces` and must always be carried
    /// through `persist_workspaces` rather than reconstructed, or it will
    /// silently reset to empty on the next save.
    #[serde(default)]
    pub file_tabs: HashMap<String, String>,
```

- [ ] **Step 4: Fix the 3 existing test literals in `config.rs`**

Add `file_tabs: HashMap::new(),` as the last field to the `AppConfig { ... }` literals in `save_then_load_roundtrips` (line ~121), `session_names_roundtrip_alongside_workspaces` (line ~137), and `save_creates_missing_parent_directories` (line ~223).

- [ ] **Step 5: Thread `file_tabs` through `persist_workspaces`**

In `session.rs`, replace the whole `persist_workspaces` function:

```rust
fn persist_workspaces(
    config_dir: &std::path::Path,
    data: &WorkspacesData,
    session_names: HashMap<String, String>,
    file_tabs: HashMap<String, String>,
) -> anyhow::Result<()> {
    crate::config::save(
        config_dir,
        &crate::config::AppConfig {
            workspaces: data.workspaces.clone(),
            active_workspace_id: data.active_workspace_id.clone(),
            session_names,
            file_tabs,
        },
    )
}
```

Add the managed-state struct next to `SessionNames`:

```rust
/// Open file-viewer tabs (tab id -> absolute path). Independent
/// Tauri-managed state from `WorkspacesState`/`SessionNames`, but all
/// three persist into the same `AppConfig` -- every command that saves one
/// must read the others' current values too, or it would silently reset
/// them to empty on every save.
pub struct FileTabs(pub Mutex<HashMap<String, String>>);
```

- [ ] **Step 6: Update every `persist_workspaces` call site**

There are exactly 3. In `set_workspaces_state`, add a `file_tabs_state: State<FileTabs>` parameter and pass its value through:

```rust
#[tauri::command]
pub fn set_workspaces_state(
    workspaces: Vec<Workspace>,
    active_workspace_id: Option<String>,
    app_handle: AppHandle,
    state: State<WorkspacesState>,
    names_state: State<SessionNames>,
    file_tabs_state: State<FileTabs>,
) -> Result<(), String> {
    let data = WorkspacesData { workspaces, active_workspace_id };
    *state.0.lock().unwrap() = data.clone();
    let session_names = names_state.0.lock().unwrap().clone();
    let file_tabs = file_tabs_state.0.lock().unwrap().clone();
    let config_dir = app_handle.path().app_config_dir().map_err(|e| e.to_string())?;
    persist_workspaces(&config_dir, &data, session_names, file_tabs).map_err(|e| e.to_string())
}
```

In `set_session_name`, add the same parameter and pass it through — change its signature to include `file_tabs_state: State<FileTabs>,` after `names_state`, and its final line to:

```rust
    let file_tabs = file_tabs_state.0.lock().unwrap().clone();
    let data = workspaces_state.0.lock().unwrap().clone();
    let config_dir = app_handle.path().app_config_dir().map_err(|e| e.to_string())?;
    persist_workspaces(&config_dir, &data, session_names, file_tabs).map_err(|e| e.to_string())
```

In `bootstrap`, the call becomes (the `file_tabs` local is added in Step 7):

```rust
    persist_workspaces(&config_dir, &workspaces_data, session_names.clone(), file_tabs.clone())?;
```

- [ ] **Step 7: Load and manage `file_tabs` in `bootstrap`**

In `bootstrap`, right after `let session_names = config.session_names;`, add:

```rust
    let file_tabs = config.file_tabs;
```

And alongside the other `app_handle.manage(...)` calls, add:

```rust
    app_handle.manage(FileTabs(Mutex::new(file_tabs)));
```

- [ ] **Step 8: Add the two new commands**

In `session.rs`, after `set_session_name`:

```rust
#[tauri::command]
pub fn get_file_tabs(state: State<FileTabs>) -> HashMap<String, String> {
    state.0.lock().unwrap().clone()
}

/// Replaces the whole file-tab map. Whole-map rather than per-tab
/// (unlike `set_session_name`) because Part 2's callers always mutate it
/// alongside a pane-tree change they're already persisting wholesale --
/// there is no "rename one file tab" operation the way there is for
/// session names.
#[tauri::command]
pub fn set_file_tabs(
    file_tabs: HashMap<String, String>,
    app_handle: AppHandle,
    workspaces_state: State<WorkspacesState>,
    names_state: State<SessionNames>,
    file_tabs_state: State<FileTabs>,
) -> Result<(), String> {
    *file_tabs_state.0.lock().unwrap() = file_tabs.clone();
    let session_names = names_state.0.lock().unwrap().clone();
    let data = workspaces_state.0.lock().unwrap().clone();
    let config_dir = app_handle.path().app_config_dir().map_err(|e| e.to_string())?;
    persist_workspaces(&config_dir, &data, session_names, file_tabs).map_err(|e| e.to_string())
}
```

- [ ] **Step 9: Register the new commands**

In `app/src-tauri/src/lib.rs`, add to the `tauri::generate_handler![...]` list, after `session::set_session_name,`:

```rust
            session::get_file_tabs,
            session::set_file_tabs,
```

- [ ] **Step 10: Run the tests to verify they pass**

Run: `source "$HOME/.cargo/env" && cargo test -p app`
Expected: PASS, all tests (37 total: 35 existing + 2 new).

- [ ] **Step 11: Commit**

```bash
git add app/src-tauri/src/config.rs app/src-tauri/src/session.rs app/src-tauri/src/lib.rs
git commit -m "feat(app): persist open file-viewer tabs in AppConfig"
```

---

### Task 2: Skip file tabs during session reconciliation

**Files:**
- Modify: `app/src-tauri/src/session.rs`

**Interfaces:**
- Consumes: Task 1's `file_tabs` local in `bootstrap`.
- Produces: `resolve_sessions(node, command_conn, all_sessions, file_tab_ids)` (signature gains a 4th parameter); `resolve_workspaces(workspaces, command_conn, file_tab_ids)` (signature gains a 3rd).

**Why this task exists:** two separate places currently assume every id in a pane tree's `tabs` array is a terminal session id. Without this task, a persisted file tab would be (1) treated as a stale session by `resolve_sessions` and silently replaced with a freshly spawned shell, and (2) sent an `Attach` request by `bootstrap`'s own loop for an id the daemon has never heard of.

- [ ] **Step 1: Write the failing test**

Add to `session.rs`'s `mod resolve_workspaces_tests`:

```rust
    #[test]
    fn a_file_tab_id_is_left_alone_not_replaced_with_a_fresh_session() {
        // Zero queued responses: if resolve_workspaces treated the file tab
        // as a stale session it would try to CreateSession and hang/fail on
        // the empty queue. A workspace whose only tab is a file tab must
        // not even call ListSessions.
        let (client, captured, _dir) = fake_daemon_capturing_requests(vec![]);
        let conn = Mutex::new(client);
        let mut workspaces = vec![workspace("ws-1", vec![page("page-1", leaf(&["file-tab-1"]))])];
        let file_tab_ids: HashSet<String> = ["file-tab-1".to_string()].into_iter().collect();

        resolve_workspaces(&mut workspaces, &conn, &file_tab_ids).unwrap();

        assert_eq!(workspaces[0].pages[0].layout, leaf(&["file-tab-1"]));
        assert!(captured.lock().unwrap().is_empty(), "no daemon calls at all for a file-tab-only workspace");
    }

    #[test]
    fn a_file_tab_alongside_a_stale_session_leaves_the_file_tab_and_replaces_only_the_session() {
        let (client, _captured, _dir) = fake_daemon_capturing_requests(vec![
            Response::SessionList { sessions: vec![] },
            Response::SessionCreated { id: "fresh-a".to_string() },
        ]);
        let conn = Mutex::new(client);
        let mut workspaces =
            vec![workspace("ws-1", vec![page("page-1", leaf(&["file-tab-1", "stale-session"]))])];
        let file_tab_ids: HashSet<String> = ["file-tab-1".to_string()].into_iter().collect();

        resolve_workspaces(&mut workspaces, &conn, &file_tab_ids).unwrap();

        assert_eq!(workspaces[0].pages[0].layout, leaf(&["file-tab-1", "fresh-a"]));
    }
```

Add `use std::collections::HashSet;` to the test module's imports if not already inherited via `use super::*`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `source "$HOME/.cargo/env" && cargo test -p app resolve_workspaces_tests`
Expected: FAIL to compile — `resolve_workspaces` takes 2 arguments, not 3.

- [ ] **Step 3: Add the parameter to `resolve_sessions`**

Replace `resolve_sessions`:

```rust
/// Walks the tree, replacing any session id not present in `valid_ids`
/// (stale, exited, or never existed) with a freshly created session — the
/// same silent, normal fallback Milestone B established for its one
/// session, now applied uniformly to every tab in every pane.
///
/// Ids in `file_tab_ids` are file-viewer tabs, not terminal sessions --
/// they're skipped entirely. The daemon has never heard of them, so
/// without this check every persisted file tab would be treated as a
/// stale session and silently replaced by a freshly spawned shell on
/// every single launch.
fn resolve_sessions(
    node: &mut LayoutNode,
    command_conn: &Mutex<UnixStream>,
    all_sessions: &HashMap<String, protocol::SessionSummary>,
    file_tab_ids: &HashSet<String>,
) -> anyhow::Result<()> {
    match node {
        LayoutNode::Leaf { tabs, .. } => {
            for id in tabs.iter_mut() {
                if file_tab_ids.contains(id.as_str()) {
                    continue;
                }
                let is_valid = all_sessions.get(id.as_str()).is_some_and(|s| s.status != "exited");
                if !is_valid {
                    let last_known_cwd = all_sessions.get(id.as_str()).map(|s| s.cwd.as_str());
                    *id = create_fresh_session(command_conn, last_known_cwd, None)?;
                }
            }
            Ok(())
        }
        LayoutNode::Split { children, .. } => {
            for child in children.iter_mut() {
                resolve_sessions(child, command_conn, all_sessions, file_tab_ids)?;
            }
            Ok(())
        }
    }
}
```

Add `HashSet` to the file's imports: change `use std::collections::HashMap;` to `use std::collections::{HashMap, HashSet};`.

- [ ] **Step 4: Add the parameter to `resolve_workspaces`**

Replace `resolve_workspaces`:

```rust
fn resolve_workspaces(
    workspaces: &mut [Workspace],
    command_conn: &Mutex<UnixStream>,
    file_tab_ids: &HashSet<String>,
) -> anyhow::Result<()> {
    if workspaces.is_empty() {
        return Ok(());
    }
    // Every tab across every page is a file tab -- there are no sessions to
    // reconcile, so skip the ListSessions round-trip entirely (matching the
    // empty-workspaces early return above).
    let has_any_session_tab = workspaces
        .iter()
        .flat_map(|w| w.pages.iter())
        .flat_map(|p| p.layout.all_session_ids())
        .any(|id| !file_tab_ids.contains(&id));
    if !has_any_session_tab {
        return Ok(());
    }
    let all_sessions = list_valid_session_ids(command_conn)?;
    for workspace in workspaces.iter_mut() {
        for page in workspace.pages.iter_mut() {
            resolve_sessions(&mut page.layout, command_conn, &all_sessions, file_tab_ids)?;
        }
    }
    Ok(())
}
```

- [ ] **Step 5: Update the existing `resolve_workspaces` call sites in tests**

Every existing call in `mod resolve_workspaces_tests` gains an empty set. Add this helper to that module:

```rust
    fn no_file_tabs() -> HashSet<String> {
        HashSet::new()
    }
```

Then change each existing `resolve_workspaces(&mut workspaces, &conn).unwrap();` to `resolve_workspaces(&mut workspaces, &conn, &no_file_tabs()).unwrap();`. There are 6 such call sites (lines ~421, 442, 461, 478, 500, 529).

- [ ] **Step 6: Update `bootstrap`**

In `bootstrap`, `file_tabs` is loaded before this point (Task 1, Step 7). Change the `resolve_workspaces` call and the Attach loop:

```rust
    let file_tab_ids: HashSet<String> = file_tabs.keys().cloned().collect();
    resolve_workspaces(&mut workspaces, &command_conn, &file_tab_ids)?;
```

And the Attach loop — a file tab id must never be sent to the daemon:

```rust
    let all_session_ids: Vec<String> = workspaces_data
        .workspaces
        .iter()
        .flat_map(|w| w.pages.iter())
        .flat_map(|p| p.layout.all_session_ids())
        .filter(|id| !file_tab_ids.contains(id))
        .collect();
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `source "$HOME/.cargo/env" && cargo test -p app`
Expected: PASS, all tests (39 total: 37 after Task 1 + 2 new).

- [ ] **Step 8: Commit**

```bash
git add app/src-tauri/src/session.rs
git commit -m "feat(app): skip file tabs when reconciling sessions at bootstrap"
```

---

### Task 3: `read_file_for_viewer` + `resolve_path_under_cursor`

**Files:**
- Create: `app/src-tauri/src/fileviewer.rs`
- Modify: `app/src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: nothing from Tasks 1-2 (independent).
- Produces: `pub const MAX_VIEWER_FILE_BYTES: usize = 1024 * 1024;`; `pub struct FileContent { content: String, truncated: bool }` (serialized camelCase); `read_file_for_viewer(path: String) -> Result<FileContent, String>`; `resolve_path_under_cursor(candidate: String, cwd: String) -> Option<String>`; `pub const VIEWABLE_EXTENSIONS: &[&str]`; `viewable_extensions() -> Vec<String>`.

- [ ] **Step 1: Create the module with its failing tests**

Create `app/src-tauri/src/fileviewer.rs`:

```rust
use serde::Serialize;
use std::path::PathBuf;

/// Files larger than this are truncated rather than rendered whole --
/// generous for source/markdown, small enough to never freeze the
/// renderer on a multi-GB log.
pub const MAX_VIEWER_FILE_BYTES: usize = 1024 * 1024;

/// Extensions the internal viewer handles. Everything else (images,
/// video, binaries, and any unrecognized extension) is handed to the OS's
/// default application instead -- see the design spec's Goals. Exposed to
/// the frontend via `viewable_extensions` so the cmd+click handler and
/// this list can never disagree.
pub const VIEWABLE_EXTENSIONS: &[&str] = &[
    "txt", "md", "markdown", "rs", "ts", "js", "tsx", "jsx", "svelte", "py", "go", "rb", "java",
    "c", "h", "cpp", "hpp", "cs", "swift", "kt", "sh", "bash", "zsh", "fish", "toml", "yaml",
    "yml", "json", "xml", "html", "css", "scss", "sql", "graphql", "lua", "php", "pl", "r",
    "dockerfile", "gitignore", "env", "ini", "conf", "cfg", "log", "csv",
];

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    pub content: String,
    pub truncated: bool,
}

#[tauri::command]
pub fn viewable_extensions() -> Vec<String> {
    VIEWABLE_EXTENSIONS.iter().map(|e| e.to_string()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn reads_a_small_utf8_file_whole() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("hello.txt");
        std::fs::write(&path, "hello world").unwrap();

        let result = read_file_for_viewer(path.to_string_lossy().to_string()).unwrap();

        assert_eq!(result, FileContent { content: "hello world".to_string(), truncated: false });
    }

    #[test]
    fn truncates_a_file_larger_than_the_cap() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("big.txt");
        let mut f = std::fs::File::create(&path).unwrap();
        // 2 MiB of 'a' -- comfortably over the 1 MiB cap.
        let chunk = vec![b'a'; 1024];
        for _ in 0..2048 {
            f.write_all(&chunk).unwrap();
        }
        drop(f);

        let result = read_file_for_viewer(path.to_string_lossy().to_string()).unwrap();

        assert!(result.truncated);
        assert_eq!(result.content.len(), MAX_VIEWER_FILE_BYTES);
    }

    #[test]
    fn rejects_a_non_utf8_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("binary.bin");
        // 0xFF is never valid UTF-8.
        std::fs::write(&path, [0xFF, 0xFE, 0x00, 0x01]).unwrap();

        let result = read_file_for_viewer(path.to_string_lossy().to_string());

        assert!(result.is_err());
    }

    #[test]
    fn rejects_a_missing_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("does-not-exist.txt");

        let result = read_file_for_viewer(path.to_string_lossy().to_string());

        assert!(result.is_err());
    }

    #[test]
    fn resolves_an_absolute_path_that_exists() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("real.txt");
        std::fs::write(&path, "x").unwrap();

        let resolved = resolve_path_under_cursor(
            path.to_string_lossy().to_string(),
            dir.path().to_string_lossy().to_string(),
        );

        assert!(resolved.is_some());
    }

    #[test]
    fn resolves_a_relative_path_against_the_given_cwd() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("real.txt"), "x").unwrap();

        let resolved =
            resolve_path_under_cursor("real.txt".to_string(), dir.path().to_string_lossy().to_string());

        assert!(resolved.is_some());
        assert!(resolved.unwrap().ends_with("real.txt"));
    }

    #[test]
    fn returns_none_for_a_path_that_does_not_exist() {
        let dir = tempfile::tempdir().unwrap();

        let resolved = resolve_path_under_cursor(
            "nope.txt".to_string(),
            dir.path().to_string_lossy().to_string(),
        );

        assert_eq!(resolved, None);
    }

    #[test]
    fn returns_none_for_a_directory_rather_than_a_file() {
        let dir = tempfile::tempdir().unwrap();
        let subdir = dir.path().join("subdir");
        std::fs::create_dir(&subdir).unwrap();

        let resolved = resolve_path_under_cursor(
            "subdir".to_string(),
            dir.path().to_string_lossy().to_string(),
        );

        assert_eq!(resolved, None);
    }
}
```

- [ ] **Step 2: Register the module and run the tests to verify they fail**

Add `mod fileviewer;` to `app/src-tauri/src/lib.rs`'s module list (after `mod daemon;`).

Run: `source "$HOME/.cargo/env" && cargo test -p app fileviewer::`
Expected: FAIL to compile — `read_file_for_viewer` and `resolve_path_under_cursor` don't exist yet.

- [ ] **Step 3: Implement the two commands**

Add to `fileviewer.rs`, after `viewable_extensions`:

```rust
/// Reads a file for display, capped at `MAX_VIEWER_FILE_BYTES`. A file
/// over the cap comes back truncated (with `truncated: true`) rather than
/// refused, so the viewer can show the beginning of a big log alongside a
/// "too large to preview in full" notice. Non-UTF8 content is an error,
/// not lossy-decoded garbage -- the frontend treats that identically to an
/// unsupported extension and offers to open externally instead.
#[tauri::command]
pub fn read_file_for_viewer(path: String) -> Result<FileContent, String> {
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    let truncated = bytes.len() > MAX_VIEWER_FILE_BYTES;
    let slice = if truncated { &bytes[..MAX_VIEWER_FILE_BYTES] } else { &bytes[..] };
    let content = String::from_utf8(slice.to_vec())
        .map_err(|_| "file is not valid UTF-8 text".to_string())?;
    Ok(FileContent { content, truncated })
}

/// Resolves a path-shaped candidate string from terminal output against
/// the session's own live cwd, returning its absolute path only if it
/// actually points at a readable file. Backs the "only real paths are
/// clickable" rule -- the frontend calls this on hover and only applies
/// the clickable underline when it returns Some, so there are no
/// dead-end clicks. Directories return None: this opens files, and a
/// clickable directory that did nothing on click would be exactly the
/// dead-end this check exists to prevent.
#[tauri::command]
pub fn resolve_path_under_cursor(candidate: String, cwd: String) -> Option<String> {
    let expanded = if let Some(rest) = candidate.strip_prefix("~/") {
        let home = std::env::var("HOME").ok()?;
        PathBuf::from(home).join(rest)
    } else {
        PathBuf::from(&candidate)
    };
    let absolute = if expanded.is_absolute() { expanded } else { PathBuf::from(&cwd).join(expanded) };
    let canonical = std::fs::canonicalize(&absolute).ok()?;
    if !canonical.is_file() {
        return None;
    }
    Some(canonical.to_string_lossy().to_string())
}
```

- [ ] **Step 4: Register the commands**

In `app/src-tauri/src/lib.rs`, add to `tauri::generate_handler![...]`:

```rust
            fileviewer::read_file_for_viewer,
            fileviewer::resolve_path_under_cursor,
            fileviewer::viewable_extensions,
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `source "$HOME/.cargo/env" && cargo test -p app`
Expected: PASS, all tests (47 total: 39 after Task 2 + 8 new).

- [ ] **Step 6: Commit**

```bash
git add app/src-tauri/src/fileviewer.rs app/src-tauri/src/lib.rs
git commit -m "feat(app): add read_file_for_viewer and resolve_path_under_cursor"
```

---

### Task 4: File watching with live-reload events

**Files:**
- Modify: `app/src-tauri/Cargo.toml`
- Modify: `app/src-tauri/src/fileviewer.rs`
- Modify: `app/src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: Task 3's `fileviewer` module.
- Produces: `pub struct FileWatchers(pub Mutex<HashMap<String, Debouncer<notify::RecommendedWatcher>>>)` managed state; `watch_file_for_viewer(path, app_handle, state) -> Result<(), String>`; `unwatch_file_for_viewer(path, state) -> Result<(), String>`; emits a `file-changed` event carrying the watched path as its payload.

**Critical design note for the implementer:** watch the file's **parent directory** non-recursively and filter events by filename — do NOT watch the file path itself. The daemon's own git-status watcher documents why (`crates/daemon/src/server.rs`, `setup_filesystem_watch`): editors and agents commonly write files via write-to-temp-then-rename, and on Linux `inotify` watches inodes rather than paths, so a rename-over-target orphans a per-file watch and it silently stops firing after the very first save. Watching the containing directory catches the replacement regardless of how it's written.

- [ ] **Step 1: Add the dependencies**

In `app/src-tauri/Cargo.toml`, add to `[dependencies]` (same versions the daemon already uses):

```toml
notify = "8"
notify-debouncer-mini = "0.7"
```

- [ ] **Step 2: Write the failing test**

Add to `fileviewer.rs`'s `mod tests`:

```rust
    #[test]
    fn a_watched_files_change_fires_the_callback_once_after_debouncing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("watched.txt");
        std::fs::write(&path, "before").unwrap();
        let (tx, rx) = std::sync::mpsc::channel::<String>();

        let watcher = spawn_file_watcher(path.to_string_lossy().as_ref(), move |changed| {
            let _ = tx.send(changed);
        })
        .unwrap();

        std::fs::write(&path, "after").unwrap();

        // Generous relative to the 500ms debounce -- this asserts the
        // callback fires at all, not how fast.
        let received = rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap();
        assert_eq!(received, path.to_string_lossy().to_string());
        drop(watcher);
    }

    #[test]
    fn a_sibling_files_change_does_not_fire_the_callback() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("watched.txt");
        let sibling = dir.path().join("other.txt");
        std::fs::write(&path, "before").unwrap();
        let (tx, rx) = std::sync::mpsc::channel::<String>();

        let watcher = spawn_file_watcher(path.to_string_lossy().as_ref(), move |changed| {
            let _ = tx.send(changed);
        })
        .unwrap();

        // The watch is on the parent DIRECTORY (see this task's design
        // note), so a sibling's change reaches the debouncer -- it must be
        // filtered out by filename before reaching the callback.
        std::fs::write(&sibling, "unrelated").unwrap();

        assert!(rx.recv_timeout(std::time::Duration::from_secs(2)).is_err());
        drop(watcher);
    }
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `source "$HOME/.cargo/env" && cargo test -p app fileviewer::`
Expected: FAIL to compile — `spawn_file_watcher` doesn't exist.

- [ ] **Step 4: Implement the watcher**

Add to the top of `fileviewer.rs`:

```rust
use notify_debouncer_mini::Debouncer;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};
```

Add the debounce constant next to `MAX_VIEWER_FILE_BYTES`:

```rust
/// Matches the daemon's own GIT_STATUS_DEBOUNCE -- long enough to collapse
/// the burst of events a single save produces, short enough to feel live.
const FILE_WATCH_DEBOUNCE: Duration = Duration::from_millis(500);
```

Add the watcher state and functions:

```rust
/// Active file watchers, keyed by the watched file's path. One per open
/// file-viewer tab; two tabs viewing the same file share the single entry
/// (the second `watch_file_for_viewer` call is a no-op), and the entry is
/// dropped -- shutting down the watcher thread -- by
/// `unwatch_file_for_viewer`.
pub struct FileWatchers(pub Mutex<HashMap<String, Debouncer<notify::RecommendedWatcher>>>);

impl Default for FileWatchers {
    fn default() -> Self {
        FileWatchers(Mutex::new(HashMap::new()))
    }
}

/// Watches `path`'s PARENT DIRECTORY non-recursively and invokes
/// `on_change` with `path` whenever that specific file changes.
///
/// Watching the directory rather than the file itself is deliberate and
/// load-bearing: editors and agents routinely save by writing a temp file
/// and renaming it over the target, and on Linux `inotify` watches inodes
/// rather than paths -- so a watch registered directly on the file would
/// be orphaned by the first such save and silently never fire again. The
/// daemon's git-status watcher hit exactly this and documents it at
/// length (crates/daemon/src/server.rs, setup_filesystem_watch).
fn spawn_file_watcher<F>(path: &str, on_change: F) -> anyhow::Result<Debouncer<notify::RecommendedWatcher>>
where
    F: Fn(String) + Send + 'static,
{
    let watched = PathBuf::from(path);
    let parent = watched
        .parent()
        .ok_or_else(|| anyhow::anyhow!("path has no parent directory: {path}"))?
        .to_path_buf();
    let file_name = watched
        .file_name()
        .ok_or_else(|| anyhow::anyhow!("path has no file name: {path}"))?
        .to_os_string();
    let reported_path = path.to_string();

    let mut debouncer = notify_debouncer_mini::new_debouncer(
        FILE_WATCH_DEBOUNCE,
        move |res: notify_debouncer_mini::DebounceEventResult| {
            let Ok(events) = res else { return };
            if events.iter().any(|e| e.path.file_name() == Some(file_name.as_os_str())) {
                on_change(reported_path.clone());
            }
        },
    )?;
    debouncer.watcher().watch(&parent, notify::RecursiveMode::NonRecursive)?;
    Ok(debouncer)
}

/// Starts watching a file, emitting `file-changed` (payload: the path) on
/// every change until `unwatch_file_for_viewer` is called. Watching an
/// already-watched path is a no-op rather than an error -- two tabs on the
/// same file both just receive the same event.
#[tauri::command]
pub fn watch_file_for_viewer(
    path: String,
    app_handle: AppHandle,
    state: State<FileWatchers>,
) -> Result<(), String> {
    let mut watchers = state.0.lock().unwrap();
    if watchers.contains_key(&path) {
        return Ok(());
    }
    let emitter = app_handle.clone();
    let debouncer = spawn_file_watcher(&path, move |changed| {
        let _ = emitter.emit("file-changed", changed);
    })
    .map_err(|e| e.to_string())?;
    watchers.insert(path, debouncer);
    Ok(())
}

/// Stops watching a file. Dropping the `Debouncer` is what shuts down its
/// background thread and releases the OS-level watch. Unwatching a path
/// that isn't watched is a no-op, not an error.
#[tauri::command]
pub fn unwatch_file_for_viewer(path: String, state: State<FileWatchers>) -> Result<(), String> {
    state.0.lock().unwrap().remove(&path);
    Ok(())
}
```

- [ ] **Step 5: Register the state and commands**

In `app/src-tauri/src/lib.rs`, add to the `tauri::Builder` chain alongside the other `.manage(...)` calls:

```rust
        .manage(fileviewer::FileWatchers::default())
```

And add to `tauri::generate_handler![...]`:

```rust
            fileviewer::watch_file_for_viewer,
            fileviewer::unwatch_file_for_viewer,
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `source "$HOME/.cargo/env" && cargo test -p app`
Expected: PASS, all tests (49 total: 47 after Task 3 + 2 new).

- [ ] **Step 7: Run the full workspace build**

```bash
source "$HOME/.cargo/env"
cargo build
```

Expected: clean build, 0 warnings.

- [ ] **Step 8: Commit**

```bash
git add app/src-tauri/Cargo.toml Cargo.lock app/src-tauri/src/fileviewer.rs app/src-tauri/src/lib.rs
git commit -m "feat(app): watch open files and emit file-changed on external edits"
```

(`Cargo.lock` is at the repo root — this is a cargo workspace, there is no `app/src-tauri/Cargo.lock`.)

---

### Task 5: Frontend `fileTabsById` state + `backend.ts` wrappers

**Files:**
- Modify: `app/src/lib/backend.ts`
- Modify: `app/src/lib/layoutState.ts`
- Modify: `app/src/lib/layoutState.test.ts`
- Modify: `app/src/lib/confirmClose.test.ts`

**Interfaces:**
- Consumes: Task 1's `get_file_tabs`/`set_file_tabs`, Task 3's `read_file_for_viewer`/`resolve_path_under_cursor`/`viewable_extensions`, Task 4's `watch_file_for_viewer`/`unwatch_file_for_viewer`.
- Produces: `export interface FileTab { path: string }`; `LayoutState.fileTabsById: Record<string, FileTab>`; `backend.getFileTabs()`, `backend.setFileTabs(fileTabs)`, `backend.readFileForViewer(path)`, `backend.resolvePathUnderCursor(candidate, cwd)`, `backend.viewableExtensions()`, `backend.watchFileForViewer(path)`, `backend.unwatchFileForViewer(path)`. Part 2 consumes all of these.

- [ ] **Step 1: Write the failing test**

Add to `app/src/lib/layoutState.test.ts`, after the existing `describe("createSessionForCard", ...)` block:

```ts
describe("bootstrap file tab hydration", () => {
  it("hydrates fileTabsById from the backend on bootstrap", async () => {
    vi.mocked(backend.getWorkspacesState).mockResolvedValue({ workspaces: [], activeWorkspaceId: null });
    vi.mocked(backend.getBootstrapError).mockResolvedValue(null);
    vi.mocked(backend.getSessionNames).mockResolvedValue({});
    vi.mocked(backend.getFileTabs).mockResolvedValue({ "tab-1": "/tmp/README.md" });

    await bootstrap();
    await vi.waitFor(() => {
      expect(get(layoutState).fileTabsById["tab-1"]).toEqual({ path: "/tmp/README.md" });
    });

    teardown();
  });
});
```

Add `getFileTabs: vi.fn(),` to the `vi.mock("./backend", ...)` factory in that file.

- [ ] **Step 2: Run the test to verify it fails**

Run (from `app/`): `npm test -- src/lib/layoutState.test.ts`
Expected: FAIL — `backend.getFileTabs` is not a function / `fileTabsById` is undefined.

- [ ] **Step 3: Add the `backend.ts` wrappers**

Add to `app/src/lib/backend.ts`:

```ts
export function getFileTabs(): Promise<Record<string, string>> {
  return invoke("get_file_tabs");
}

export function setFileTabs(fileTabs: Record<string, string>): Promise<void> {
  return invoke("set_file_tabs", { fileTabs });
}

export function readFileForViewer(path: string): Promise<{ content: string; truncated: boolean }> {
  return invoke("read_file_for_viewer", { path });
}

export function resolvePathUnderCursor(candidate: string, cwd: string): Promise<string | null> {
  return invoke("resolve_path_under_cursor", { candidate, cwd });
}

export function viewableExtensions(): Promise<string[]> {
  return invoke("viewable_extensions");
}

export function watchFileForViewer(path: string): Promise<void> {
  return invoke("watch_file_for_viewer", { path });
}

export function unwatchFileForViewer(path: string): Promise<void> {
  return invoke("unwatch_file_for_viewer", { path });
}
```

- [ ] **Step 4: Add `fileTabsById` to `LayoutState`**

In `app/src/lib/layoutState.ts`, add the type export near the top (after the existing `export type { SessionStatus };`):

```ts
/// A pane tab that shows a file instead of a terminal session. Keyed by
/// the same opaque tab-id space session ids live in -- a tab id present in
/// fileTabsById is a file tab, one absent from it is a terminal session.
export interface FileTab {
  path: string;
}
```

Add the field to the `LayoutState` interface (last field):

```ts
  fileTabsById: Record<string, FileTab>;
```

Add it to `initialState`:

```ts
  fileTabsById: {},
```

- [ ] **Step 5: Hydrate it in `bootstrap`**

In `bootstrap`, right after the existing `void backend.getSessionNames()...` block, add:

```ts
  // Like session names: frontend-owned, never externally driven, so a
  // one-shot fetch is sufficient -- no live event. Best-effort, matching
  // getSessionNames: a failure means file tabs render their error state
  // until the next successful load, not a reason to block startup.
  void backend
    .getFileTabs()
    .then((fileTabs) => {
      const fileTabsById: Record<string, FileTab> = {};
      for (const [tabId, path] of Object.entries(fileTabs)) {
        fileTabsById[tabId] = { path };
      }
      layoutState.update((s) => ({ ...s, fileTabsById }));
    })
    .catch(() => {});
```

- [ ] **Step 6: Update the 3 `LayoutState` literals in tests**

Add `fileTabsById: {},` as the last field to the `layoutState.set({...})` literals at `layoutState.test.ts:93` (inside `setState`), `layoutState.test.ts:109` (inside `beforeEach`), and `confirmClose.test.ts:40`.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, all tests (240 total: 239 existing + 1 new).

- [ ] **Step 8: Run the type checker**

Run: `npm run check`
Expected: 0 errors, 34 warnings (this project's established baseline).

- [ ] **Step 9: Commit**

```bash
git add app/src/lib/backend.ts app/src/lib/layoutState.ts app/src/lib/layoutState.test.ts app/src/lib/confirmClose.test.ts
git commit -m "feat(frontend): add fileTabsById state and file-viewer backend wrappers"
```
