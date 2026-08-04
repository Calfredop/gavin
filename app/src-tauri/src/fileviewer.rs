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
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    let truncated = bytes.len() > MAX_VIEWER_FILE_BYTES;
    let slice = if truncated { &bytes[..MAX_VIEWER_FILE_BYTES] } else { &bytes[..] };
    let content =
        String::from_utf8(slice.to_vec()).map_err(|_| "file is not valid UTF-8 text".to_string())?;
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
