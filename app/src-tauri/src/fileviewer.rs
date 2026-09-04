use notify_debouncer_mini::Debouncer;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
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
/// The parent directory is created when missing. Every path that reaches
/// here names a file some surface already has open, so an absent parent
/// is a folder the user just chose -- the PRD can be pointed at
/// `docs/PRD.md` in a repo with no `docs/` yet, and the tab's first save
/// is what creates it. Without this that save fails with a bare ENOENT.
///
/// Callers must never invoke this for a truncated read: only a prefix of
/// an over-cap file was loaded, so writing it back would destroy the
/// rest. `FileEditor` enforces that by refusing to offer Edit mode at all
/// when `truncated` is true.
#[tauri::command]
pub fn write_file_for_editor(path: String, content: String) -> Result<(), String> {
    if let Some(parent) = std::path::Path::new(&path).parent() {
        if !parent.as_os_str().is_empty() && !parent.is_dir() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
    }
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

/// One card attachment, resolved and stat'd. `path` echoes the raw
/// frontmatter entry (the UI's identity for the chip and the string it
/// removes); `absolute_path` is what an agent is handed and what a chip
/// opens, and is None for an entry gavin refuses to resolve at all.
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentStatus {
    pub path: String,
    pub absolute_path: Option<String>,
    pub exists: bool,
}

/// Resolves a card's `attachments:` entries against the workspace root
/// and says which ones are actually there.
///
/// The root, never the session's cwd: a card bound to a rail runs in a
/// worktree, and resolving `docs/spec.md` against wherever the agent
/// happens to start would hand two sessions two different files (or one
/// of them nothing at all) from the same card.
///
/// A `..` entry is REFUSED rather than stat'd -- `usable_attachment_path`
/// is the authority, shared with the daemon so both sides agree -- and
/// comes back with no absolute path and `exists: false`. That is the
/// same shape as a file that moved, which is what the caller wants: both
/// are a broken chip and both block a run. Stat'ing it instead would
/// make gavin read outside the root on behalf of a line in a card file.
///
/// Called on demand -- the modal opening, the run gate just before
/// spawning -- never on scan: the daemon does not stat attachments, so
/// the board card face can only ever show a count.
#[tauri::command]
pub fn attachment_status(root: String, paths: Vec<String>) -> Vec<AttachmentStatus> {
    let root = PathBuf::from(root);
    paths
        .into_iter()
        .map(|raw| {
            let Some(usable) = protocol::usable_attachment_path(&raw) else {
                return AttachmentStatus { path: raw, absolute_path: None, exists: false };
            };
            let candidate = PathBuf::from(&usable);
            let absolute =
                if candidate.is_absolute() { candidate } else { root.join(&candidate) };
            // is_file, not exists: an attachment names a file to read.
            // A directory that happens to sit at the path would pass
            // `exists` and then hand the agent something it cannot read.
            let exists = absolute.is_file();
            AttachmentStatus {
                path: raw,
                absolute_path: Some(absolute.to_string_lossy().to_string()),
                exists,
            }
        })
        .collect()
}

// ---- the Files tab's directory explorer ------------------------------
//
// A repo-wide tree, unlike the `.gavin*` navigator the daemon feeds:
// reading and writing ordinary files is the Tauri host's job (the file
// viewer spec), so none of this touches the daemon and PROTOCOL_VERSION
// does not move for it.
//
// Every command here takes the workspace ROOT alongside its target and
// refuses anything that resolves outside it. The root is passed rather
// than remembered because the host holds no notion of a "current"
// workspace -- several are open at once -- and a guard that reads its
// own boundary from the same caller it is guarding would be no guard at
// all if the caller could omit it. It cannot: the parameter is required.

/// One entry of a listed directory.
///
/// `is_dir` comes from the entry's *symlink* metadata, so a symlink is
/// never a directory here however it resolves. That is what keeps the
/// tree from following one: a link shows as a leaf, carries
/// `symlink: true` for the row to mark, and offers no chevron to expand.
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DirEntryInfo {
    pub name: String,
    pub is_dir: bool,
    /// Bytes, from the same symlink metadata. 0 for a directory -- a
    /// directory's own inode size says nothing a human wants read out.
    pub size: u64,
    pub symlink: bool,
}

/// The workspace root as an absolute, symlink-free path. Canonicalized
/// because every containment check below compares against it, and on
/// macOS the same folder is reachable as both `/tmp/x` and
/// `/private/tmp/x` -- comparing the two raw strings would refuse the
/// human's own root.
fn canonical_root(root: &str) -> Result<PathBuf, String> {
    std::fs::canonicalize(root).map_err(|e| format!("workspace root {root} is unreadable: {e}"))
}

/// Component-wise containment, never a string prefix: `starts_with` on
/// `Path` compares path components, so `/repo-old` is not inside `/repo`
/// the way a `str::starts_with` would have it.
fn inside_root(root: &Path, candidate: &Path) -> bool {
    candidate == root || candidate.starts_with(root)
}

/// Resolves a path that must already exist, refusing anything outside
/// the root. `allow_root` is false for the mutations: the workspace root
/// itself is not a file the explorer may rename or trash.
fn resolve_existing(root: &Path, path: &str, allow_root: bool) -> Result<PathBuf, String> {
    let canonical =
        std::fs::canonicalize(path).map_err(|e| format!("{path} could not be resolved: {e}"))?;
    if !inside_root(root, &canonical) {
        return Err(format!("{path} is outside the workspace root"));
    }
    if !allow_root && canonical == root {
        return Err("the workspace root itself cannot be changed from the file tree".to_string());
    }
    Ok(canonical)
}

/// Resolves a path that must NOT exist yet -- the target of a create or
/// of a rename.
///
/// The parent is canonicalized (so a symlinked directory leading out of
/// the root is caught the same way an existing path would be) and the
/// final component is required to be a plain name: no separator, no `.`
/// or `..`. Rejecting the name outright rather than normalizing it is
/// deliberate -- a caller that meant a subdirectory should say so with a
/// real path, and "new file" typed as `../../etc/passwd` is a mistake
/// worth reporting, not one worth quietly reinterpreting.
fn resolve_new(root: &Path, path: &str) -> Result<PathBuf, String> {
    let target = Path::new(path);
    // `Path::file_name` is already None for a path that ends in `..` or
    // in a separator, so the two spellings of "this names no entry" get
    // one refusal between them rather than two different sentences.
    let name = target.file_name().and_then(|n| n.to_str()).unwrap_or("");
    if name.is_empty() || name == "." || name == ".." || name.contains('/') {
        return Err(format!("{path} is not a usable name"));
    }
    let parent = target.parent().ok_or_else(|| format!("{path} has no parent directory"))?;
    let canonical_parent = std::fs::canonicalize(parent)
        .map_err(|e| format!("{} could not be resolved: {e}", parent.display()))?;
    if !inside_root(root, &canonical_parent) {
        return Err(format!("{path} is outside the workspace root"));
    }
    if !canonical_parent.is_dir() {
        return Err(format!("{} is not a directory", canonical_parent.display()));
    }
    let resolved = canonical_parent.join(name);
    if resolved.symlink_metadata().is_ok() {
        return Err(format!("{name} already exists"));
    }
    Ok(resolved)
}

/// Lists one directory's entries, for one opened node of the Files tab's
/// tree.
///
/// One `read_dir` per opened directory and never a recursive walk: the
/// daemon learned at some cost that arming a watch over a 3000-folder
/// repo takes minutes, and a tree that walked eagerly would pay the same
/// price on every root. Nothing here is watched at all -- the tree
/// refreshes on demand and after its own mutations.
///
/// Everything on disk is listed, dotfiles and `target/` and
/// `node_modules/` included: filtering by `.gitignore` would hide files
/// the human came here to find, and the cost of listing a large folder
/// is only paid when they open it.
///
/// Refuses a symlinked directory rather than listing through it, so the
/// tree can never leave the root by following a link.
#[tauri::command]
pub fn list_directory(root: String, path: String) -> Result<Vec<DirEntryInfo>, String> {
    let root = canonical_root(&root)?;
    let meta = std::fs::symlink_metadata(&path).map_err(|e| format!("{path}: {e}"))?;
    if meta.file_type().is_symlink() {
        return Err(format!("{path} is a symlink; the file tree does not follow links"));
    }
    let dir = resolve_existing(&root, &path, true)?;
    if !dir.is_dir() {
        return Err(format!("{path} is not a directory"));
    }

    let mut entries = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(|e| format!("{path}: {e}"))? {
        let entry = entry.map_err(|e| format!("{path}: {e}"))?;
        let name = entry.file_name().to_string_lossy().to_string();
        // symlink_metadata, not metadata: a link to a directory must not
        // read as one, and a link whose target is gone must still list.
        let meta = match entry.path().symlink_metadata() {
            Ok(meta) => meta,
            // A file that vanished between the read_dir and the stat is
            // not an error for the whole listing -- an agent writing in
            // this folder is the normal case here, not the exception.
            Err(_) => continue,
        };
        let file_type = meta.file_type();
        let is_dir = file_type.is_dir();
        entries.push(DirEntryInfo {
            name,
            is_dir,
            size: if is_dir { 0 } else { meta.len() },
            symlink: file_type.is_symlink(),
        });
    }
    // Name order only. Directories-before-files is the tree's rule and
    // lives in fileTree.ts with the rest of the presentation; sorting
    // here is just so the same folder does not come back in a different
    // order each time read_dir is asked.
    entries.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(entries)
}

/// Creates an empty file. `create_new` rather than a write, so an
/// existing file is refused by the filesystem itself rather than by a
/// check with a window between it and the write.
#[tauri::command]
pub fn create_file(root: String, path: String) -> Result<(), String> {
    let root = canonical_root(&root)?;
    let target = resolve_new(&root, &path)?;
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&target)
        .map(|_| ())
        .map_err(|e| format!("{}: {e}", target.display()))
}

/// Creates one directory. `create_dir`, not `create_dir_all`: a missing
/// parent is a typo worth reporting, and an existing target must be
/// refused rather than silently accepted.
#[tauri::command]
pub fn create_directory(root: String, path: String) -> Result<(), String> {
    let root = canonical_root(&root)?;
    let target = resolve_new(&root, &path)?;
    std::fs::create_dir(&target).map_err(|e| format!("{}: {e}", target.display()))
}

/// Renames or moves an entry inside the root.
///
/// Both ends are guarded, and the destination must not exist:
/// `fs::rename` overwrites silently on unix, which would turn a
/// mistyped rename into a deleted file with no trip through the Trash.
/// `resolve_new` is what refuses it.
#[tauri::command]
pub fn rename_path(root: String, from: String, to: String) -> Result<(), String> {
    let root = canonical_root(&root)?;
    let source = resolve_existing(&root, &from, false)?;
    let target = resolve_new(&root, &to)?;
    std::fs::rename(&source, &target).map_err(|e| format!("{} -> {}: {e}", source.display(), target.display()))
}

/// Moves an entry to the OS Trash.
///
/// Through `trash::trash_path`, the same route the workspace delete
/// wizard and a run discard take -- nothing gavin removes on the
/// human's behalf is unrecoverable, and the macOS delete method is
/// settled in that module (the crate's default drives Finder over Apple
/// events at ~13s a call and needs an Automation grant).
///
/// A symlink is trashed, never followed: `resolve_existing`
/// canonicalizes for the containment check only, and what is handed to
/// the trash is that canonical path -- so a link is refused when its
/// target lies outside the root, which is the conservative direction.
#[tauri::command]
pub fn trash_entry(root: String, path: String) -> Result<(), String> {
    let root = canonical_root(&root)?;
    let target = resolve_existing(&root, &path, false)?;
    crate::trash::trash_path(&target.to_string_lossy())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn attachment_status_resolves_against_the_root_and_refuses_traversal() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("ws");
        std::fs::create_dir_all(root.join("docs")).unwrap();
        std::fs::write(root.join("docs/spec.md"), "spec").unwrap();
        // Deliberately REAL and reachable via `..` from the root, so the
        // refusal below cannot be mistaken for "the file wasn't there".
        std::fs::write(dir.path().join("outside.md"), "secret").unwrap();
        let outside = dir.path().join("outside.md").to_string_lossy().to_string();

        let got = attachment_status(
            root.to_string_lossy().to_string(),
            vec![
                "docs/spec.md".to_string(),
                "docs/gone.md".to_string(),
                outside.clone(),
                "../outside.md".to_string(),
                "docs".to_string(),
            ],
        );

        // Relative, present: resolved against the root.
        assert_eq!(got[0].path, "docs/spec.md");
        assert_eq!(got[0].absolute_path.as_deref(), Some(root.join("docs/spec.md").to_string_lossy().as_ref()));
        assert!(got[0].exists);

        // Relative, moved away: resolved, and honestly missing.
        assert!(!got[1].exists);
        assert!(got[1].absolute_path.is_some());

        // Absolute outside the root is the COMMON case, not an escape --
        // a screenshot on the Desktop, a spec on a shared volume.
        assert_eq!(got[2].absolute_path.as_deref(), Some(outside.as_str()));
        assert!(got[2].exists);

        // `..` is refused, not stat'd: no absolute path comes back at
        // all, even though the file it points at exists.
        assert_eq!(got[3].path, "../outside.md");
        assert_eq!(got[3].absolute_path, None);
        assert!(!got[3].exists);

        // A directory is not a file to read.
        assert!(!got[4].exists);
    }

    #[test]
    fn a_first_save_creates_the_parent_directory_it_needs() {
        let dir = tempfile::tempdir().unwrap();
        // What repointing the PRD at docs/PRD.md in a repo with no docs/
        // looks like: the tab opens empty and the first save has to make
        // the folder, not fail with ENOENT.
        let path = dir.path().join("docs").join("PRD.md");
        write_file_for_editor(path.to_string_lossy().to_string(), "# theirs\n".to_string())
            .unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "# theirs\n");

        // An existing parent is untouched, and so is the rest of it.
        std::fs::write(dir.path().join("docs").join("other.md"), "keep").unwrap();
        write_file_for_editor(path.to_string_lossy().to_string(), "# again\n".to_string())
            .unwrap();
        assert_eq!(std::fs::read_to_string(dir.path().join("docs/other.md")).unwrap(), "keep");
    }

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

    // ---- the Files tab's directory explorer ---------------------------

    /// A root plus the string form both the commands and these tests
    /// pass around. `tempfile` hands back `/var/folders/...` on macOS
    /// where the real path is `/private/var/...`; the commands
    /// canonicalize, so the tests hand over the raw path on purpose --
    /// that IS the case that would break a string-prefix guard.
    fn root_of(dir: &tempfile::TempDir) -> String {
        dir.path().to_string_lossy().to_string()
    }

    fn under(dir: &tempfile::TempDir, rel: &str) -> String {
        dir.path().join(rel).to_string_lossy().to_string()
    }

    #[test]
    fn list_directory_reports_kind_size_and_link_for_every_entry() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("src")).unwrap();
        std::fs::write(dir.path().join("Cargo.toml"), "[package]").unwrap();
        // Dotfiles and build output are LISTED, not hidden: the tree
        // shows everything on disk (the .gitignore filter is exactly the
        // decision this feature declined to make).
        std::fs::write(dir.path().join(".gitignore"), "target\n").unwrap();
        std::fs::create_dir(dir.path().join("target")).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(dir.path().join("Cargo.toml"), dir.path().join("link.toml"))
            .unwrap();

        let entries = list_directory(root_of(&dir), root_of(&dir)).unwrap();
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        // Sorted by name, so the same folder never comes back shuffled.
        #[cfg(unix)]
        assert_eq!(names, vec![".gitignore", "Cargo.toml", "link.toml", "src", "target"]);
        #[cfg(not(unix))]
        assert_eq!(names, vec![".gitignore", "Cargo.toml", "src", "target"]);

        let toml = entries.iter().find(|e| e.name == "Cargo.toml").unwrap();
        assert!(!toml.is_dir);
        assert!(!toml.symlink);
        assert_eq!(toml.size, "[package]".len() as u64);

        let src = entries.iter().find(|e| e.name == "src").unwrap();
        assert!(src.is_dir);
        // A directory's own inode size is not a number worth showing.
        assert_eq!(src.size, 0);

        #[cfg(unix)]
        {
            let link = entries.iter().find(|e| e.name == "link.toml").unwrap();
            assert!(link.symlink);
            assert!(!link.is_dir);
        }
    }

    #[test]
    fn list_directory_refuses_a_path_outside_the_root() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("ws");
        std::fs::create_dir(&root).unwrap();
        // Real and readable, so the refusal cannot be mistaken for
        // "there was nothing there".
        std::fs::write(dir.path().join("secret.txt"), "s").unwrap();

        let outside = list_directory(
            root.to_string_lossy().to_string(),
            dir.path().to_string_lossy().to_string(),
        );
        assert!(outside.unwrap_err().contains("outside the workspace root"));

        // The classic traversal spelling, which canonicalize collapses
        // before the containment check ever runs.
        let traversal = list_directory(
            root.to_string_lossy().to_string(),
            root.join("..").to_string_lossy().to_string(),
        );
        assert!(traversal.unwrap_err().contains("outside the workspace root"));
    }

    #[cfg(unix)]
    #[test]
    fn list_directory_refuses_to_follow_a_symlinked_directory() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("ws");
        std::fs::create_dir(&root).unwrap();
        let elsewhere = dir.path().join("elsewhere");
        std::fs::create_dir(&elsewhere).unwrap();
        std::fs::write(elsewhere.join("secret.txt"), "s").unwrap();
        // A link INSIDE the root pointing out of it: canonicalizing would
        // catch this one, but a link pointing back inside the root would
        // not -- and the tree must not walk through either.
        std::os::unix::fs::symlink(&elsewhere, root.join("escape")).unwrap();
        std::fs::create_dir(root.join("real")).unwrap();
        std::os::unix::fs::symlink(root.join("real"), root.join("inward")).unwrap();

        for link in ["escape", "inward"] {
            let err = list_directory(
                root.to_string_lossy().to_string(),
                root.join(link).to_string_lossy().to_string(),
            )
            .unwrap_err();
            assert!(err.contains("does not follow links"), "{link}: {err}");
        }

        // The link is still LISTED in its parent -- as a leaf, so the
        // tree shows it without offering to open it.
        let entries = list_directory(
            root.to_string_lossy().to_string(),
            root.to_string_lossy().to_string(),
        )
        .unwrap();
        let escape = entries.iter().find(|e| e.name == "escape").unwrap();
        assert!(escape.symlink);
        assert!(!escape.is_dir);
    }

    #[test]
    fn list_directory_refuses_a_file_and_a_missing_path() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "a").unwrap();

        assert!(list_directory(root_of(&dir), under(&dir, "a.txt"))
            .unwrap_err()
            .contains("not a directory"));
        assert!(list_directory(root_of(&dir), under(&dir, "nope")).is_err());
    }

    #[test]
    fn create_file_makes_an_empty_file_and_refuses_to_clobber_one() {
        let dir = tempfile::tempdir().unwrap();

        create_file(root_of(&dir), under(&dir, "notes.md")).unwrap();
        assert_eq!(std::fs::read_to_string(dir.path().join("notes.md")).unwrap(), "");

        std::fs::write(dir.path().join("kept.md"), "important").unwrap();
        let err = create_file(root_of(&dir), under(&dir, "kept.md")).unwrap_err();
        assert!(err.contains("already exists"), "{err}");
        // The refusal is the point: the file it would have replaced is
        // still whole.
        assert_eq!(std::fs::read_to_string(dir.path().join("kept.md")).unwrap(), "important");
    }

    #[test]
    fn create_refuses_outside_the_root_and_refuses_a_traversal_name() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("ws");
        std::fs::create_dir(&root).unwrap();
        let root_s = root.to_string_lossy().to_string();

        let outside = dir.path().join("outside.md").to_string_lossy().to_string();
        assert!(create_file(root_s.clone(), outside.clone())
            .unwrap_err()
            .contains("outside the workspace root"));
        assert!(create_directory(root_s.clone(), outside)
            .unwrap_err()
            .contains("outside the workspace root"));

        // A `..` final component is refused as a NAME rather than
        // normalized away -- the caller meant something it should have
        // spelled out.
        let dots = root.join("..").to_string_lossy().to_string();
        assert!(create_file(root_s.clone(), dots).unwrap_err().contains("not a usable name"));

        // ...and the traversal spelled through a parent is refused for
        // being outside, not silently created.
        let escaped = root.join("../escaped.md").to_string_lossy().to_string();
        assert!(create_file(root_s, escaped).unwrap_err().contains("outside the workspace root"));
        assert!(!dir.path().join("escaped.md").exists());
    }

    #[test]
    fn create_directory_makes_one_level_and_refuses_an_existing_entry() {
        let dir = tempfile::tempdir().unwrap();

        create_directory(root_of(&dir), under(&dir, "docs")).unwrap();
        assert!(dir.path().join("docs").is_dir());

        assert!(create_directory(root_of(&dir), under(&dir, "docs"))
            .unwrap_err()
            .contains("already exists"));

        // A missing parent is a typo, not a folder to invent: create_dir,
        // never create_dir_all.
        assert!(create_directory(root_of(&dir), under(&dir, "a/b/c")).is_err());
        assert!(!dir.path().join("a").exists());
    }

    #[test]
    fn rename_moves_an_entry_and_refuses_to_overwrite_the_destination() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("docs")).unwrap();
        std::fs::write(dir.path().join("draft.md"), "text").unwrap();
        std::fs::write(dir.path().join("taken.md"), "keep me").unwrap();

        // Same folder: an ordinary rename.
        rename_path(root_of(&dir), under(&dir, "draft.md"), under(&dir, "final.md")).unwrap();
        assert!(!dir.path().join("draft.md").exists());
        assert_eq!(std::fs::read_to_string(dir.path().join("final.md")).unwrap(), "text");

        // Another folder: the same command moves.
        rename_path(root_of(&dir), under(&dir, "final.md"), under(&dir, "docs/final.md")).unwrap();
        assert_eq!(std::fs::read_to_string(dir.path().join("docs/final.md")).unwrap(), "text");

        // fs::rename overwrites silently on unix, which would make a
        // mistyped rename a deletion with no trip through the Trash.
        let err = rename_path(root_of(&dir), under(&dir, "docs/final.md"), under(&dir, "taken.md"))
            .unwrap_err();
        assert!(err.contains("already exists"), "{err}");
        assert_eq!(std::fs::read_to_string(dir.path().join("taken.md")).unwrap(), "keep me");
        assert!(dir.path().join("docs/final.md").exists());
    }

    #[test]
    fn rename_refuses_either_end_outside_the_root_and_refuses_the_root_itself() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("ws");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("inside.md"), "in").unwrap();
        std::fs::write(dir.path().join("outside.md"), "out").unwrap();
        let root_s = root.to_string_lossy().to_string();
        let outside = dir.path().join("outside.md").to_string_lossy().to_string();

        // Source outside: reading a file gavin was never pointed at.
        let err = rename_path(root_s.clone(), outside.clone(), root.join("stolen.md").to_string_lossy().to_string());
        assert!(err.unwrap_err().contains("outside the workspace root"));
        assert!(dir.path().join("outside.md").exists());

        // Destination outside: writing one.
        let err = rename_path(
            root_s.clone(),
            root.join("inside.md").to_string_lossy().to_string(),
            dir.path().join("leaked.md").to_string_lossy().to_string(),
        );
        assert!(err.unwrap_err().contains("outside the workspace root"));
        assert!(root.join("inside.md").exists());

        // The root is not one of its own entries.
        let err = rename_path(
            root_s.clone(),
            root_s,
            dir.path().join("ws2").to_string_lossy().to_string(),
        );
        assert!(err.unwrap_err().contains("workspace root itself"));
    }

    #[test]
    fn trash_refuses_a_path_outside_the_root_and_the_root_itself() {
        // Only the refusals are exercised. A happy-path assertion would
        // put a file in the developer's real Trash on every `cargo test`
        // -- the whole point of trash_path is that it does not delete.
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("ws");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(dir.path().join("outside.md"), "out").unwrap();
        let root_s = root.to_string_lossy().to_string();

        let err = trash_entry(root_s.clone(), dir.path().join("outside.md").to_string_lossy().to_string());
        assert!(err.unwrap_err().contains("outside the workspace root"));
        assert!(dir.path().join("outside.md").exists());

        let err = trash_entry(root_s.clone(), root_s.clone());
        assert!(err.unwrap_err().contains("workspace root itself"));
        assert!(root.is_dir());

        // A path that isn't there at all fails to resolve rather than
        // reporting a delete that never happened.
        assert!(trash_entry(root_s, root.join("ghost.md").to_string_lossy().to_string()).is_err());
    }
}
