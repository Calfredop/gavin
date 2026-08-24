use notify_debouncer_mini::Debouncer;
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

/// Files larger than this are truncated rather than rendered whole --
/// generous for source/markdown, small enough to never freeze the
/// renderer on a multi-GB log.
pub const MAX_VIEWER_FILE_BYTES: usize = 1024 * 1024;

/// Matches the daemon's own GIT_STATUS_DEBOUNCE -- long enough to collapse
/// the burst of events a single save produces, short enough to feel live.
const FILE_WATCH_DEBOUNCE: Duration = Duration::from_millis(500);

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
    /// False when the path does not exist yet. The PRD/agent-file hub
    /// tabs open before their file has been created and create it on
    /// first save, so "missing" is a normal state to render, not an
    /// error to show.
    pub exists: bool,
}

#[tauri::command]
pub fn viewable_extensions() -> Vec<String> {
    VIEWABLE_EXTENSIONS.iter().map(|e| e.to_string()).collect()
}

/// Reads a file for display, capped at `MAX_VIEWER_FILE_BYTES`. A file
/// over the cap comes back truncated (with `truncated: true`) rather than
/// refused, so the viewer can show the beginning of a big log alongside a
/// "too large to preview in full" notice. Non-UTF8 content is an error,
/// not lossy-decoded garbage -- the frontend treats that identically to an
/// unsupported extension and offers to open externally instead.
#[tauri::command]
pub fn read_file_for_viewer(path: String) -> Result<FileContent, String> {
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(FileContent { content: String::new(), truncated: false, exists: false })
        }
        Err(e) => return Err(e.to_string()),
    };
    let truncated = bytes.len() > MAX_VIEWER_FILE_BYTES;
    let slice = if truncated { &bytes[..MAX_VIEWER_FILE_BYTES] } else { &bytes[..] };
    let content =
        String::from_utf8(slice.to_vec()).map_err(|_| "file is not valid UTF-8 text".to_string())?;
    Ok(FileContent { content, truncated, exists: true })
}

/// Writes an editor buffer back to disk, creating the file when absent.
/// Plain `fs::write`, matching `gavin::write_plan_field`'s convention
/// rather than introducing temp-file-plus-rename in one place only.
///
/// Callers must never invoke this for a truncated read: only a prefix of
/// an over-cap file was loaded, so writing it back would destroy the
/// rest. `FileEditor` enforces that by refusing to offer Edit mode at all
/// when `truncated` is true.
#[tauri::command]
pub fn write_file_for_editor(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|e| e.to_string())
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

/// Active file watchers, keyed by the watched file's path, REFCOUNTED so
/// several surfaces can watch one file independently: an open editor tab,
/// the Plans tab's editor pane and a card detail modal can all be looking
/// at the same plan, and whichever closes first must not take the others'
/// live updates down with it. Matches `GitWatchers`, which is refcounted
/// for the same reason. The entry -- and with it the watcher thread and
/// the OS watch -- is dropped when the last holder unwatches.
pub struct FileWatchers(pub Mutex<HashMap<String, (Debouncer<notify::RecommendedWatcher>, usize)>>);

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
fn spawn_file_watcher<F>(
    path: &str,
    on_change: F,
) -> anyhow::Result<Debouncer<notify::RecommendedWatcher>>
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
/// every change until the last `unwatch_file_for_viewer` for it. Watching
/// an already-watched path takes a second reference on the one OS watch
/// rather than starting another; every watcher receives the same event.
#[tauri::command]
pub fn watch_file_for_viewer(
    path: String,
    app_handle: AppHandle,
    state: State<FileWatchers>,
) -> Result<(), String> {
    let mut watchers = state.0.lock().unwrap();
    if let Some(entry) = watchers.get_mut(&path) {
        entry.1 += 1;
        return Ok(());
    }
    let emitter = app_handle.clone();
    let debouncer = spawn_file_watcher(&path, move |changed| {
        let _ = emitter.emit("file-changed", changed);
    })
    .map_err(|e| e.to_string())?;
    watchers.insert(path, (debouncer, 1));
    Ok(())
}

/// Releases one reference on a file's watch, shutting it down when the
/// last one goes. Dropping the `Debouncer` is what stops its background
/// thread and releases the OS-level watch. Unwatching a path that isn't
/// watched is a no-op, not an error.
#[tauri::command]
pub fn unwatch_file_for_viewer(path: String, state: State<FileWatchers>) -> Result<(), String> {
    let mut watchers = state.0.lock().unwrap();
    let remove = match watchers.get_mut(&path) {
        Some(entry) => {
            entry.1 = entry.1.saturating_sub(1);
            entry.1 == 0
        }
        None => false,
    };
    if remove {
        watchers.remove(&path);
    }
    Ok(())
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

        assert_eq!(
            result,
            FileContent { content: "hello world".to_string(), truncated: false, exists: true }
        );
    }

    #[test]
    fn write_creates_a_missing_file_and_overwrites_an_existing_one() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("notes.md");
        let p = path.to_string_lossy().to_string();

        write_file_for_editor(p.clone(), "first".to_string()).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "first");

        write_file_for_editor(p, "second".to_string()).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "second");
    }

    #[test]
    fn write_round_trips_multibyte_utf8() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("prd.md");
        let text = "# PRD — vision\n\nemoji: 🚀 accents: éàü\n";
        write_file_for_editor(path.to_string_lossy().to_string(), text.to_string()).unwrap();

        let read = read_file_for_viewer(path.to_string_lossy().to_string()).unwrap();
        assert_eq!(read.content, text);
        assert!(read.exists);
        assert!(!read.truncated);
    }

    #[test]
    fn write_to_an_unwritable_path_errors() {
        let dir = tempfile::tempdir().unwrap();
        // The directory itself is not a writable file target.
        let result =
            write_file_for_editor(dir.path().to_string_lossy().to_string(), "x".to_string());
        assert!(result.is_err());
    }

    #[test]
    fn reading_a_missing_file_reports_it_absent_instead_of_erroring() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("CLAUDE.md");

        let result = read_file_for_viewer(missing.to_string_lossy().to_string()).unwrap();

        assert!(!result.exists);
        assert_eq!(result.content, "");
        assert!(!result.truncated);
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
    fn still_rejects_an_unreadable_file() {
        // A missing file is NO LONGER an error (see
        // reading_a_missing_file_reports_it_absent_instead_of_erroring --
        // the editor's hub tabs open before their file exists). Every
        // other read failure still is: here, a directory.
        let dir = tempfile::tempdir().unwrap();

        let result = read_file_for_viewer(dir.path().to_string_lossy().to_string());

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

        let resolved =
            resolve_path_under_cursor("nope.txt".to_string(), dir.path().to_string_lossy().to_string());

        assert_eq!(resolved, None);
    }

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

        // The watch is on the parent DIRECTORY (see spawn_file_watcher's
        // doc comment), so a sibling's change reaches the debouncer -- it
        // must be filtered out by filename before reaching the callback.
        std::fs::write(&sibling, "unrelated").unwrap();

        assert!(rx.recv_timeout(std::time::Duration::from_secs(2)).is_err());
        drop(watcher);
    }

    #[test]
    fn returns_none_for_a_directory_rather_than_a_file() {
        let dir = tempfile::tempdir().unwrap();
        let subdir = dir.path().join("subdir");
        std::fs::create_dir(&subdir).unwrap();

        let resolved =
            resolve_path_under_cursor("subdir".to_string(), dir.path().to_string_lossy().to_string());

        assert_eq!(resolved, None);
    }
}
