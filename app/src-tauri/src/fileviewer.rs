use crate::session::{WorkspacesData, WorkspacesState};
use notify_debouncer_mini::Debouncer;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

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

// ---- containment for the five raw-path commands ----------------------
//
// `read_file_for_viewer`, `write_file_for_editor`, `resolve_path_under_
// cursor`, `watch_file_for_viewer` and `unwatch_file_for_viewer` take a
// raw absolute path with no `root` argument -- unlike the six explorer
// commands below, which the frontend always calls with the workspace
// root alongside the target. These five instead check the path against
// every OPEN workspace's root (State, not an argument the caller could
// omit or forge) plus each root's own registered `extra_contexts`. A
// compromised page can still invoke any of the ~165 commands (AS-01/R5),
// but it can no longer name a path gavin was never pointed at.
//
// Traded away deliberately, per the fix card: an attachment/PRD/agent
// file that lives outside every open root and every registered context
// -- a screenshot on the Desktop, a spec on a shared volume, the case
// `attachment_status`'s own doc comment calls "the common case, not an
// escape" -- now refuses to open in-app too, where it previously worked.
// `extra_contexts` is the only widening lever, and it scaffolds a
// `.gavin` into whatever it is pointed at, so it is not a drop-in fix for
// this case -- narrowing AS-04 shut this door along with the one that
// mattered.

/// Every directory the five commands may resolve into: each open
/// workspace's canonical root, plus that root's own `extra_contexts` --
/// external folders a human registered from inside an already-open
/// workspace (`add_external_gavin_context`), read straight off
/// `config.toml` the same way the delete wizard's footprint scan does
/// (`workspace_delete::outside_contexts`). A workspace with no root, or a
/// root that no longer resolves, contributes nothing rather than
/// erroring -- one stale workspace must not break file access for every
/// other open tab.
fn allowed_roots(workspaces: &WorkspacesData) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    for workspace in &workspaces.workspaces {
        let Some(root_path) = workspace.root_path.as_deref() else { continue };
        let Ok(root) = std::fs::canonicalize(root_path) else { continue };
        roots.extend(extra_context_roots(&root));
        roots.push(root);
    }
    roots
}

/// The root config's `extra_contexts`: absolute folders a human
/// registered from inside an already-trusted, already-open workspace.
/// Trusted for the whole folder, not just its `.gavin` planning
/// metadata -- a registered context is where the file viewer and PRD/
/// agent pickers legitimately follow a card into.
fn extra_context_roots(root: &Path) -> Vec<PathBuf> {
    let config = root.join(".gavin-root").join("config.toml");
    let Ok(content) = std::fs::read_to_string(&config) else { return Vec::new() };
    let Ok(table) = content.parse::<toml::Table>() else { return Vec::new() };
    let Some(entries) = table.get("extra_contexts").and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    entries
        .iter()
        .filter_map(|v| v.as_str())
        .filter_map(|s| std::fs::canonicalize(s).ok())
        .collect()
}

/// Resolves an absolute path for containment even when it (or some
/// ancestor of it) does not exist yet -- `write_file_for_editor` creates
/// missing parent directories on save, and a PRD/agent-file tab opens
/// before its file does. Walks up to the nearest EXISTING ancestor,
/// canonicalizes it (so a symlinked directory anywhere in the existing
/// prefix is caught exactly the way `resolve_existing` catches one for
/// the six guarded explorer commands below), then reattaches the still-
/// missing suffix unresolved -- there is nothing on disk yet for a
/// symlink to be.
fn resolve_for_containment(path: &str) -> Result<PathBuf, String> {
    let mut existing = Path::new(path);
    if !existing.is_absolute() {
        return Err(format!("{path} is not an absolute path"));
    }
    let mut suffix: Vec<&std::ffi::OsStr> = Vec::new();
    while !existing.exists() {
        let name = existing.file_name().ok_or_else(|| format!("{path} could not be resolved"))?;
        suffix.push(name);
        existing = existing.parent().ok_or_else(|| format!("{path} could not be resolved"))?;
    }
    let mut canonical = std::fs::canonicalize(existing)
        .map_err(|e| format!("{path} could not be resolved: {e}"))?;
    for name in suffix.into_iter().rev() {
        canonical.push(name);
    }
    Ok(canonical)
}

/// The guard shared by all five raw-path commands: resolves `path` and
/// refuses it unless it lies inside one of `roots`, with a named error a
/// refusal can be told apart by wherever it surfaces -- the frontend's
/// existing error banner for the two commands that return one to it, a
/// quiet no-op for watch/unwatch, which already treat an unmatched path
/// that way.
fn ensure_within_open_workspaces(path: &str, roots: &[PathBuf]) -> Result<PathBuf, String> {
    let resolved = resolve_for_containment(path)?;
    if roots.iter().any(|root| inside_root(root, &resolved)) {
        Ok(resolved)
    } else {
        Err(format!("{path} is outside every open workspace"))
    }
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
///
/// Refuses a path outside every open workspace (AS-04) before reading.
///
/// A path inside an ssh workspace is on the host: the read goes to that
/// host's daemon (`ReadWorkspaceFile`, v39) and answers in the same
/// shape, so every reader of this command -- the card modal, a card run's
/// composition, the editor -- works there unchanged.
#[tauri::command]
pub fn read_file_for_viewer(
    path: String,
    app_handle: AppHandle,
    workspaces: State<WorkspacesState>,
) -> Result<FileContent, String> {
    if let crate::remote::Route::Remote(link) = crate::remote::route_for_path(&app_handle, &path)? {
        let root = remote_root_for(&app_handle, &path)?;
        let (content, truncated) = link.read_file(&root, &path).map_err(|e| e.to_string())?;
        return Ok(match content {
            Some(content) => FileContent { content, truncated, exists: true },
            None => FileContent { content: String::new(), truncated: false, exists: false },
        });
    }
    let roots = allowed_roots(&workspaces.0.lock().unwrap());
    read_file_for_viewer_impl(&path, &roots)
}

/// The ssh workspace root a path belongs to, for the request's
/// `root_path`. Only ever asked after `route_for_path` found a link, so
/// the absence is a bug rather than a case.
fn remote_root_for(app_handle: &AppHandle, path: &str) -> Result<String, String> {
    let workspaces = app_handle.state::<WorkspacesState>();
    let workspaces = workspaces.0.lock().unwrap();
    workspaces
        .workspaces
        .iter()
        .filter(|w| w.ssh.is_some())
        .find(|w| w.root_path.as_deref().is_some_and(|root| crate::remote::path_is_under(root, path)))
        .and_then(|w| w.root_path.clone())
        .ok_or_else(|| format!("{path} is not inside an ssh workspace"))
}

fn read_file_for_viewer_impl(path: &str, roots: &[PathBuf]) -> Result<FileContent, String> {
    let resolved = ensure_within_open_workspaces(path, roots)?;
    let bytes = match std::fs::read(&resolved) {
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
///
/// Refuses a path outside every open workspace (AS-04) before writing.
#[tauri::command]
pub fn write_file_for_editor(
    path: String,
    content: String,
    app_handle: AppHandle,
    workspaces: State<WorkspacesState>,
) -> Result<(), String> {
    if let crate::remote::Route::Remote(link) = crate::remote::route_for_path(&app_handle, &path)? {
        let root = remote_root_for(&app_handle, &path)?;
        return link.write_file(&root, &path, &content).map_err(|e| e.to_string());
    }
    let roots = allowed_roots(&workspaces.0.lock().unwrap());
    write_file_for_editor_impl(&path, content, &roots)
}

fn write_file_for_editor_impl(path: &str, content: String, roots: &[PathBuf]) -> Result<(), String> {
    let resolved = ensure_within_open_workspaces(path, roots)?;
    if let Some(parent) = resolved.parent() {
        if !parent.as_os_str().is_empty() && !parent.is_dir() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
    }
    std::fs::write(&resolved, content).map_err(|e| e.to_string())
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
pub fn resolve_path_under_cursor(
    candidate: String,
    cwd: String,
    workspaces: State<WorkspacesState>,
) -> Option<String> {
    let roots = allowed_roots(&workspaces.0.lock().unwrap());
    resolve_path_under_cursor_impl(&candidate, &cwd, &roots)
}

/// Containment refuses by returning `None`, the same as every other
/// invalid candidate this already handles (missing, a directory, no
/// home directory) -- this command has no error channel to name a
/// refusal on, and a hover link that silently fails to underline is
/// indistinguishable from one that never matched.
///
/// The path primitives are the portable ones on purpose: `expand_tilde`
/// rather than a bare `$HOME` read, which Windows does not set, and
/// `protocol::canonical_path`, which strips the `\\?\` prefix that a
/// Windows canonicalize returns and would otherwise leak into every
/// comparison below.
fn resolve_path_under_cursor_impl(candidate: &str, cwd: &str, roots: &[PathBuf]) -> Option<String> {
    let expanded = crate::home::expand_tilde(candidate)?;
    let absolute = if expanded.is_absolute() { expanded } else { PathBuf::from(cwd).join(expanded) };
    let canonical = protocol::canonical_path(&absolute).ok()?;
    if !canonical.is_file() {
        return None;
    }
    // The terminal's Cmd+click legitimately resolves paths under the
    // session's own cwd in addition to every open workspace (and its
    // extra contexts) -- a shell running outside any workspace root is
    // ordinary, and cwd here is the session's own tracked cwd
    // (`cwdForSession` in terminalRegistry.ts), not caller-chosen text.
    let under_cwd =
        protocol::canonical_path(Path::new(cwd)).is_ok_and(|root| inside_root(&root, &canonical));
    if !under_cwd && !roots.iter().any(|root| inside_root(root, &canonical)) {
        return None;
    }
    Some(protocol::wire_path(&canonical))
}

/// The OS's temp directory, forward-slashed.
///
/// A `until` rail step tees its check's output to a file so the retry
/// prompt and the exhausted step's reason can quote it, and BOTH sides
/// have to name the same file: the shell writes it and this process
/// reads it back. `/tmp` was that name, and it is not one on Windows --
/// Git Bash maps `/tmp` to `%TEMP%` while a Rust read of `/tmp` looks
/// for `C:\tmp`, so the check would write somewhere the app never
/// looked. Asking the host once, at bootstrap, gives both sides the
/// same directory on every platform.
#[tauri::command]
pub fn temp_dir() -> String {
    protocol::wire_path(&std::env::temp_dir())
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
///
/// Refuses a path outside every open workspace (AS-04) before touching
/// `FileWatchers` at all.
#[tauri::command]
pub fn watch_file_for_viewer(
    path: String,
    app_handle: AppHandle,
    state: State<FileWatchers>,
    workspaces: State<WorkspacesState>,
) -> Result<(), String> {
    // A file on the host has no watcher here; the host daemon's tree
    // watcher still pushes a card's changes through gavin-tree-changed.
    // Not an error: the caller's read already worked, and a watch that
    // cannot be armed is a missed refresh, not a broken viewer.
    if matches!(crate::remote::route_for_path(&app_handle, &path)?, crate::remote::Route::Remote(_)) {
        return Ok(());
    }
    let roots = allowed_roots(&workspaces.0.lock().unwrap());
    ensure_within_open_workspaces(&path, &roots)?;
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
/// watched is a no-op, not an error -- but a path outside every open
/// workspace (AS-04) IS one, same as `watch_file_for_viewer`.
#[tauri::command]
pub fn unwatch_file_for_viewer(
    path: String,
    app_handle: AppHandle,
    state: State<FileWatchers>,
    workspaces: State<WorkspacesState>,
) -> Result<(), String> {
    if matches!(crate::remote::route_for_path(&app_handle, &path)?, crate::remote::Route::Remote(_)) {
        return Ok(());
    }
    let roots = allowed_roots(&workspaces.0.lock().unwrap());
    ensure_within_open_workspaces(&path, &roots)?;
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

/// Where a resolved attachment landed relative to what gavin trusts.
/// `Root` and `ExtraContext` are read and handed to the agent exactly as
/// before; `Outside` is not -- see `attachment_status`'s doc comment.
/// `Refused` is neither: gavin will not resolve it at all, and no future
/// confirmation changes that.
#[derive(Debug, Serialize, PartialEq, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub enum AttachmentLocation {
    Root,
    ExtraContext,
    Outside,
    Refused,
}

/// One card attachment, resolved and stat'd. `path` echoes the raw
/// frontmatter entry (the UI's identity for the chip and the string it
/// removes); `absolute_path` is what a chip opens, and is None for a
/// `Refused` entry -- gavin will not resolve it at all. `refused_reason`
/// is the human-readable "why" for exactly those entries, and None for
/// every other one, `Outside` included: lying outside the workspace is
/// not by itself a refusal, only a reason to withhold the bytes (the
/// pure `attachments.ts` module is what decides that; this command only
/// classifies).
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentStatus {
    pub path: String,
    pub absolute_path: Option<String>,
    pub exists: bool,
    pub location: AttachmentLocation,
    pub refused_reason: Option<String>,
    /// The file's size in bytes, or None when there was nothing to stat
    /// -- a refused entry, or a path that resolves to no file. Read by
    /// the first-Run review sheet (`cardReview.ts`), which tells a human
    /// how much a card is about to put into an agent's context: "read
    /// this file" means one thing for a 2 KB spec and another for a
    /// 40 MB log.
    pub size_bytes: Option<u64>,
}

/// Sensitive directories under the human's home folder, by name --
/// `sensitive_home_roots` turns these into canonical paths. An
/// attachment resolving inside any of them is refused outright,
/// confirmation included: a card that names `~/.ssh/id_rsa` is not a
/// screenshot on the Desktop, and no first-Run review is the right place
/// to ask a human to bless handing an agent their private key.
const SENSITIVE_HOME_DIRS: &[&str] = &["Library", ".ssh", ".aws", ".config"];

/// `SENSITIVE_HOME_DIRS`, resolved against `$HOME` through
/// `resolve_for_containment` -- so a directory that does not exist yet
/// (a fresh machine has no `~/.aws` until the first `aws configure`)
/// still refuses, and one reached through a symlinked home mount is
/// canonicalized the same way every other containment check here is. No
/// `$HOME` means nothing to refuse against, not a refusal of everything.
fn sensitive_home_roots() -> Vec<(&'static str, PathBuf)> {
    let Some(home) = std::env::var_os("HOME") else { return Vec::new() };
    let home = PathBuf::from(home);
    SENSITIVE_HOME_DIRS
        .iter()
        .filter_map(|name| resolve_for_containment(&home.join(name).to_string_lossy()).ok().map(|p| (*name, p)))
        .collect()
}

/// Resolves a card's `attachments:` entries against `root` and
/// classifies each one -- `Root`/`ExtraContext` inside what gavin
/// already trusts, `Outside` a legal reference gavin will not read
/// silently, `Refused` one it will never read at all.
///
/// `root` is the checkout the agent is about to run in, and the caller
/// names it (`resolveAttachmentsForRun` in `cardRunActions.ts`): the
/// workspace root for a board Run, the rail's worktree for a step on a
/// bound rail, whose card is about that checkout and not the root's copy
/// of it. This command does not care which. Containment is classified
/// against whatever it is given, `extra_contexts` is read from the
/// `.gavin-root/config.toml` under it (a worktree carries the file), and
/// the sensitive-home refusals below are root-independent.
///
/// EVERY resolvable candidate is canonicalized (`resolve_for_containment`,
/// the same walk-up-and-follow-symlinks the five raw-path commands above
/// use), not just the ones inside the root: an absolute entry outside
/// the root used to reach the agent unresolved, which is exactly the gap
/// this closes -- a symlink planted inside the root that points at
/// `~/.ssh` must classify by where it actually leads, not by the root-
/// relative name that names it.
///
/// A `..` entry is REFUSED rather than stat'd -- `usable_attachment_path`
/// is the authority, shared with the daemon so both sides agree. So is
/// one that canonicalizes into a sensitive home directory
/// (`sensitive_home_roots`). Both come back with no absolute path,
/// `exists: false`, and a reason naming why -- the same broken-chip shape
/// a missing file has, so both block a run the same way, but a distinct
/// message says this one is not a typo to go fix.
///
/// `Outside` is NOT stat'd into `exists: false` the way a refusal is --
/// `attachments.ts` decides from `location` whether to read it, this
/// command only classifies. It stays the common case it always was (a
/// screenshot on the Desktop, a spec on a shared volume), just no longer
/// a silent one: the pure module withholds its bytes and notes it by
/// name in the prompt instead of handing it over unread.
///
/// Called on demand -- the modal opening, the run gate just before
/// spawning -- never on scan: the daemon does not stat attachments, so
/// the board card face can only ever show a count.
///
/// For an ssh workspace's root the classification is the host daemon's
/// (`StatWorkspacePaths`, v39): the same facts, established where the
/// files are -- and where the agent that would read them runs, which is
/// what makes the host's sensitive-home refusal the right one. A host
/// that cannot be asked answers every entry as refused, naming why, so
/// the run gate blocks rather than handing the agent paths nobody
/// checked.
#[tauri::command]
pub fn attachment_status(root: String, paths: Vec<String>, app_handle: AppHandle) -> Vec<AttachmentStatus> {
    if let Ok(crate::remote::Route::Remote(link)) = crate::remote::route_for_root(&app_handle, Some(&root)) {
        return match link.stat_paths(&root, &paths) {
            Ok(stats) => stats.into_iter().map(attachment_status_from_stat).collect(),
            Err(e) => paths
                .into_iter()
                .map(|path| AttachmentStatus {
                    path,
                    absolute_path: None,
                    exists: false,
                    location: AttachmentLocation::Refused,
                    refused_reason: Some(format!("the host could not be asked: {e}")),
                    size_bytes: None,
                })
                .collect(),
        };
    }
    let root = PathBuf::from(root);
    let root_canonical = std::fs::canonicalize(&root).unwrap_or_else(|_| root.clone());
    let extra_roots = extra_context_roots(&root_canonical);
    let sensitive_roots = sensitive_home_roots();
    attachment_status_impl(&root_canonical, paths, &extra_roots, &sensitive_roots)
}

/// One host-side stat in this command's own shape. The vocabulary is
/// shared by construction (`protocol::WorkspacePathStat` documents the
/// four words); anything else the host says is refused rather than
/// guessed at.
fn attachment_status_from_stat(stat: protocol::WorkspacePathStat) -> AttachmentStatus {
    let location = match stat.location.as_str() {
        "root" => AttachmentLocation::Root,
        "extraContext" => AttachmentLocation::ExtraContext,
        "outside" => AttachmentLocation::Outside,
        _ => AttachmentLocation::Refused,
    };
    let refused = location == AttachmentLocation::Refused;
    AttachmentStatus {
        path: stat.path,
        absolute_path: if refused { None } else { stat.absolute_path },
        exists: stat.exists && !refused,
        location,
        refused_reason: if refused {
            Some(stat.refused_reason.unwrap_or_else(|| "the host refused it".to_string()))
        } else {
            None
        },
        size_bytes: if refused { None } else { stat.size_bytes },
    }
}

fn attachment_status_impl(
    root: &Path,
    paths: Vec<String>,
    extra_roots: &[PathBuf],
    sensitive_roots: &[(&'static str, PathBuf)],
) -> Vec<AttachmentStatus> {
    paths
        .into_iter()
        .map(|raw| {
            let Some(usable) = protocol::usable_attachment_path(&raw) else {
                return AttachmentStatus {
                    path: raw,
                    absolute_path: None,
                    exists: false,
                    location: AttachmentLocation::Refused,
                    refused_reason: Some("contains a `..` component".to_string()),
                    size_bytes: None,
                };
            };
            let candidate = PathBuf::from(&usable);
            let absolute = if candidate.is_absolute() { candidate } else { root.join(&candidate) };
            let resolved = resolve_for_containment(&absolute.to_string_lossy())
                .unwrap_or_else(|_| absolute.clone());

            if let Some((name, _)) = sensitive_roots.iter().find(|(_, s)| inside_root(s, &resolved)) {
                return AttachmentStatus {
                    path: raw,
                    absolute_path: None,
                    exists: false,
                    location: AttachmentLocation::Refused,
                    refused_reason: Some(format!(
                        "lies inside ~/{name}, which gavin refuses to hand an agent"
                    )),
                    size_bytes: None,
                };
            }

            // is_file, not exists: an attachment names a file to read. A
            // directory that happens to sit at the path would pass
            // `exists` and then hand the agent something it cannot read.
            //
            // One stat rather than two: the size the review sheet quotes
            // comes from the same call that answered `exists`, so the two
            // can never describe different files.
            let metadata = resolved.metadata().ok().filter(|m| m.is_file());
            let exists = metadata.is_some();
            let location = if inside_root(root, &resolved) {
                AttachmentLocation::Root
            } else if extra_roots.iter().any(|r| inside_root(r, &resolved)) {
                AttachmentLocation::ExtraContext
            } else {
                AttachmentLocation::Outside
            };
            AttachmentStatus {
                path: raw,
                absolute_path: Some(resolved.to_string_lossy().to_string()),
                exists,
                location,
                refused_reason: None,
                size_bytes: metadata.map(|m| m.len()),
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
    // Through `protocol::canonical_path` so the answer is comparable to
    // everything else gavin holds: Windows canonicalisation returns a
    // `\\?\C:\...` verbatim path, and `inside_root` below is a
    // component-wise `starts_with` against paths that are not verbatim.
    protocol::canonical_path(std::path::Path::new(root))
        .map_err(|e| format!("workspace root {root} is unreadable: {e}"))
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
    let canonical = protocol::canonical_path(std::path::Path::new(path))
        .map_err(|e| format!("{path} could not be resolved: {e}"))?;
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
    let canonical_parent = protocol::canonical_path(parent)
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
///
/// `token` is the grant `confirm_gate` minted for THIS path when the
/// human answered the Trash prompt, spent before anything moves: the
/// confirmation is the product's promise here, and a direct `invoke`
/// used to walk straight past it (AS-05/R5).
#[tauri::command]
pub fn trash_entry(
    root: String,
    path: String,
    token: String,
    gate: State<crate::confirm_gate::ConfirmGate>,
) -> Result<(), String> {
    crate::confirm_gate::spend(&gate, &token, "trash_entry", &path)?;
    trash_entry_impl(&root, &path)
}

/// The containment half, without the `State` a unit test cannot build.
fn trash_entry_impl(root: &str, path: &str) -> Result<(), String> {
    let root = canonical_root(root)?;
    let target = resolve_existing(&root, path, false)?;
    crate::trash::trash_path(&target.to_string_lossy())
}

// ---- handing a path to the OS ----------------------------------------
//
// `open` LAUNCHES things: on macOS it starts an `.app` bundle outright
// and hands anything else to its registered handler, which is a second
// program of the attacker's choosing. That is why the frontend no longer
// holds `opener:allow-open-path` at all -- the capability's scope is
// static (`tauri-plugin-opener`'s `Entry` is deserialized once from
// capabilities/default.json and has no runtime setter), so the only way
// to scope it to something as mutable as "the workspaces open right now"
// is to put the check on this side of the IPC (AS-09/R5).
//
// Both commands answer against `allowed_roots` -- the same set the five
// raw-path viewer commands use -- so what gavin will OPEN and what it
// will READ agree. Before this, `resolve_path_under_cursor` would
// underline a Cmd+clickable file under a terminal's cwd outside every
// workspace and `read_file_for_viewer` would then refuse it; now the
// external-open half refuses it too, which is the coherent direction:
// the boundary is the same one, named once.

/// Hands `path` to the OS's default application for it.
///
/// Refuses a path outside every open workspace. The error carries the
/// path, because every call site of this shows the human a message --
/// "Couldn't open in Finder", the editor's `openError`, the card's
/// `errorMessage` -- and a refusal has to read as a refusal rather than
/// as a click that did nothing.
#[tauri::command]
pub fn open_path_externally(path: String, workspaces: State<WorkspacesState>) -> Result<(), String> {
    let roots = allowed_roots(&workspaces.0.lock().unwrap());
    let resolved = ensure_within_open_workspaces(&path, &roots)?;
    tauri_plugin_opener::open_path(&resolved, None::<&str>).map_err(|e| e.to_string())
}

/// Selects `path` in the OS file manager (Finder on macOS).
///
/// Guarded on the same set as `open_path_externally` even though
/// revealing is the milder of the two -- it selects an entry rather than
/// running anything. `opener:default` grants `allow-reveal-item-in-dir`
/// with no scope whatsoever, so leaving that permission in place would
/// have left an unscoped raw-path opener command behind the one that was
/// just taken away; the capability now carries `allow-open-url` and
/// `allow-default-urls` (which is where the mailto/tel/http/https scheme
/// scope lives) and no path permission at all.
#[tauri::command]
pub fn reveal_path_externally(path: String, workspaces: State<WorkspacesState>) -> Result<(), String> {
    let roots = allowed_roots(&workspaces.0.lock().unwrap());
    let resolved = ensure_within_open_workspaces(&path, &roots)?;
    tauri_plugin_opener::reveal_item_in_dir(&resolved).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// The `roots` slice `read_file_for_viewer_impl`/`write_file_for_
    /// editor_impl`/`resolve_path_under_cursor_impl` take in place of the
    /// `WorkspacesState` the real commands read -- one open workspace
    /// rooted at `dir`, canonicalized the same way `allowed_roots` would.
    fn roots_of(dir: &tempfile::TempDir) -> Vec<PathBuf> {
        vec![std::fs::canonicalize(dir.path()).unwrap()]
    }

    /// The `sensitive_roots` slice `attachment_status_impl` takes in place
    /// of the real `sensitive_home_roots` -- one sensitive-looking name
    /// pointed at a tempdir subdirectory, canonicalized the same way the
    /// real function resolves `~/.ssh` and friends.
    fn sensitive_roots_of(dir: &tempfile::TempDir, name: &'static str) -> Vec<(&'static str, PathBuf)> {
        let path = dir.path().join(name);
        std::fs::create_dir_all(&path).unwrap();
        vec![(name, std::fs::canonicalize(&path).unwrap())]
    }

    #[test]
    fn attachment_status_resolves_against_the_root_and_classifies_by_location() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("ws");
        std::fs::create_dir_all(root.join("docs")).unwrap();
        std::fs::write(root.join("docs/spec.md"), "spec").unwrap();
        // Deliberately REAL and reachable via `..` from the root, so the
        // refusal below cannot be mistaken for "the file wasn't there".
        std::fs::write(dir.path().join("outside.md"), "secret").unwrap();
        let outside = dir.path().join("outside.md");
        let root_canonical = std::fs::canonicalize(&root).unwrap();

        let got = attachment_status_impl(
            &root_canonical,
            vec![
                "docs/spec.md".to_string(),
                "docs/gone.md".to_string(),
                outside.to_string_lossy().to_string(),
                "../outside.md".to_string(),
                "docs".to_string(),
            ],
            &[],
            &[],
        );

        // Relative, present: resolved against the root, classified Root.
        assert_eq!(got[0].path, "docs/spec.md");
        assert_eq!(
            got[0].absolute_path.as_deref(),
            Some(root_canonical.join("docs/spec.md").to_string_lossy().as_ref())
        );
        assert!(got[0].exists);
        assert_eq!(got[0].location, AttachmentLocation::Root);
        assert_eq!(got[0].refused_reason, None);
        // The size the first-Run review sheet quotes: taken from the same
        // stat that answered `exists`, so the two can never disagree.
        assert_eq!(got[0].size_bytes, Some(4));

        // Relative, moved away: resolved, still Root, and honestly missing.
        assert!(!got[1].exists);
        assert!(got[1].absolute_path.is_some());
        assert_eq!(got[1].location, AttachmentLocation::Root);
        assert_eq!(got[1].size_bytes, None);

        // Absolute outside the root is the COMMON case, not an escape --
        // a screenshot on the Desktop, a spec on a shared volume -- but it
        // is now classified Outside rather than treated as freely
        // readable. `attachments.ts` is what decides not to hand it over.
        assert_eq!(
            got[2].absolute_path.as_deref(),
            Some(std::fs::canonicalize(&outside).unwrap().to_string_lossy().as_ref())
        );
        assert!(got[2].exists);
        assert_eq!(got[2].location, AttachmentLocation::Outside);
        assert_eq!(got[2].refused_reason, None);

        // `..` is refused, not stat'd: no absolute path comes back at
        // all, even though the file it points at exists, and the reason
        // says why.
        assert_eq!(got[3].path, "../outside.md");
        assert_eq!(got[3].absolute_path, None);
        assert!(!got[3].exists);
        assert_eq!(got[3].location, AttachmentLocation::Refused);
        assert!(got[3].refused_reason.as_deref().unwrap().contains(".."));
        // Never stat'd, so there is no size to report -- a refused entry
        // must not leak so much as the size of what it points at.
        assert_eq!(got[3].size_bytes, None);

        // A directory is not a file to read.
        assert!(!got[4].exists);
        assert_eq!(got[4].location, AttachmentLocation::Root);
        assert_eq!(got[4].size_bytes, None);
    }

    #[test]
    fn attachment_status_classifies_an_extra_context_and_refuses_a_sensitive_home_dir() {
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize({
            let root = dir.path().join("ws");
            std::fs::create_dir(&root).unwrap();
            root
        })
        .unwrap();
        let context = dir.path().join("registered-context");
        std::fs::create_dir(&context).unwrap();
        std::fs::write(context.join("shared.md"), "shared").unwrap();
        let extra_root = std::fs::canonicalize(&context).unwrap();

        let ssh = sensitive_roots_of(&dir, ".ssh");
        std::fs::write(ssh[0].1.join("id_rsa"), "not-a-real-key").unwrap();
        let key_path = ssh[0].1.join("id_rsa").to_string_lossy().to_string();

        let got = attachment_status_impl(
            &root,
            vec![context.join("shared.md").to_string_lossy().to_string(), key_path],
            &[extra_root],
            &ssh,
        );

        // A registered extra context is trusted the same way the root is.
        assert_eq!(got[0].location, AttachmentLocation::ExtraContext);
        assert!(got[0].exists);
        assert!(got[0].absolute_path.is_some());

        // A sensitive home directory is refused outright, whatever a
        // future confirmation might say -- no absolute path, a reason
        // naming which directory, and blocked the same way a missing
        // file is.
        assert_eq!(got[1].location, AttachmentLocation::Refused);
        assert_eq!(got[1].absolute_path, None);
        assert!(!got[1].exists);
        assert!(got[1].refused_reason.as_deref().unwrap().contains(".ssh"));
    }

    #[cfg(unix)]
    #[test]
    fn attachment_status_classifies_by_where_a_symlink_inside_the_root_actually_leads() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("ws");
        std::fs::create_dir(&root).unwrap();
        let elsewhere = dir.path().join("elsewhere");
        std::fs::create_dir(&elsewhere).unwrap();
        std::fs::write(elsewhere.join("secret.txt"), "s3cr3t").unwrap();
        // A link INSIDE the root pointing OUT of it: the root-relative
        // name says "escape/secret.txt", but where it actually leads is
        // what has to decide the classification.
        std::os::unix::fs::symlink(&elsewhere, root.join("escape")).unwrap();
        let root_canonical = std::fs::canonicalize(&root).unwrap();
        let elsewhere_canonical = std::fs::canonicalize(&elsewhere).unwrap();

        let got = attachment_status_impl(
            &root_canonical,
            vec!["escape/secret.txt".to_string()],
            &[],
            &[],
        );

        assert_eq!(got[0].location, AttachmentLocation::Outside);
        assert!(got[0].exists);
        assert_eq!(
            got[0].absolute_path.as_deref(),
            Some(elsewhere_canonical.join("secret.txt").to_string_lossy().as_ref())
        );
    }

    #[test]
    fn a_first_save_creates_the_parent_directory_it_needs() {
        let dir = tempfile::tempdir().unwrap();
        // What repointing the PRD at docs/PRD.md in a repo with no docs/
        // looks like: the tab opens empty and the first save has to make
        // the folder, not fail with ENOENT.
        let path = dir.path().join("docs").join("PRD.md");
        let roots = roots_of(&dir);
        write_file_for_editor_impl(&path.to_string_lossy(), "# theirs\n".to_string(), &roots)
            .unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "# theirs\n");

        // An existing parent is untouched, and so is the rest of it.
        std::fs::write(dir.path().join("docs").join("other.md"), "keep").unwrap();
        write_file_for_editor_impl(&path.to_string_lossy(), "# again\n".to_string(), &roots)
            .unwrap();
        assert_eq!(std::fs::read_to_string(dir.path().join("docs/other.md")).unwrap(), "keep");
    }

    #[test]
    fn reads_a_small_utf8_file_whole() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("hello.txt");
        std::fs::write(&path, "hello world").unwrap();

        let result = read_file_for_viewer_impl(&path.to_string_lossy(), &roots_of(&dir)).unwrap();

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
        let roots = roots_of(&dir);

        write_file_for_editor_impl(&p, "first".to_string(), &roots).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "first");

        write_file_for_editor_impl(&p, "second".to_string(), &roots).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "second");
    }

    #[test]
    fn write_round_trips_multibyte_utf8() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("prd.md");
        let text = "# PRD — vision\n\nemoji: 🚀 accents: éàü\n";
        let roots = roots_of(&dir);
        write_file_for_editor_impl(&path.to_string_lossy(), text.to_string(), &roots).unwrap();

        let read = read_file_for_viewer_impl(&path.to_string_lossy(), &roots).unwrap();
        assert_eq!(read.content, text);
        assert!(read.exists);
        assert!(!read.truncated);
    }

    #[test]
    fn write_to_an_unwritable_path_errors() {
        let dir = tempfile::tempdir().unwrap();
        // The directory itself is not a writable file target.
        let result = write_file_for_editor_impl(
            &dir.path().to_string_lossy(),
            "x".to_string(),
            &roots_of(&dir),
        );
        assert!(result.is_err());
    }

    #[test]
    fn reading_a_missing_file_reports_it_absent_instead_of_erroring() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("CLAUDE.md");

        let result = read_file_for_viewer_impl(&missing.to_string_lossy(), &roots_of(&dir)).unwrap();

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

        let result = read_file_for_viewer_impl(&path.to_string_lossy(), &roots_of(&dir)).unwrap();

        assert!(result.truncated);
        assert_eq!(result.content.len(), MAX_VIEWER_FILE_BYTES);
    }

    #[test]
    fn rejects_a_non_utf8_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("binary.bin");
        // 0xFF is never valid UTF-8.
        std::fs::write(&path, [0xFF, 0xFE, 0x00, 0x01]).unwrap();

        let result = read_file_for_viewer_impl(&path.to_string_lossy(), &roots_of(&dir));

        assert!(result.is_err());
    }

    #[test]
    fn still_rejects_an_unreadable_file() {
        // A missing file is NO LONGER an error (see
        // reading_a_missing_file_reports_it_absent_instead_of_erroring --
        // the editor's hub tabs open before their file exists). Every
        // other read failure still is: here, a directory.
        let dir = tempfile::tempdir().unwrap();

        let result = read_file_for_viewer_impl(&dir.path().to_string_lossy(), &roots_of(&dir));

        assert!(result.is_err());
    }

    #[test]
    fn resolves_an_absolute_path_that_exists() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("real.txt");
        std::fs::write(&path, "x").unwrap();

        let resolved = resolve_path_under_cursor_impl(
            &path.to_string_lossy(),
            &dir.path().to_string_lossy(),
            &[],
        );

        assert!(resolved.is_some());
    }

    #[test]
    fn resolves_a_relative_path_against_the_given_cwd() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("real.txt"), "x").unwrap();

        let resolved =
            resolve_path_under_cursor_impl("real.txt", &dir.path().to_string_lossy(), &[]);

        assert!(resolved.is_some());
        assert!(resolved.unwrap().ends_with("real.txt"));
    }

    #[test]
    fn returns_none_for_a_path_that_does_not_exist() {
        let dir = tempfile::tempdir().unwrap();

        let resolved =
            resolve_path_under_cursor_impl("nope.txt", &dir.path().to_string_lossy(), &[]);

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
            resolve_path_under_cursor_impl("subdir", &dir.path().to_string_lossy(), &[]);

        assert_eq!(resolved, None);
    }

    // ---- containment on the five raw-path commands (AS-04) ------------

    #[test]
    fn extra_context_roots_reads_registered_folders_and_skips_a_stale_one() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("ws");
        std::fs::create_dir_all(root.join(".gavin-root")).unwrap();
        let registered = dir.path().join("registered");
        std::fs::create_dir(&registered).unwrap();
        let gone = dir.path().join("gone");
        std::fs::write(
            root.join(".gavin-root").join("config.toml"),
            format!(
                "name = \"ws\"\nextra_contexts = [\"{}\", \"{}\"]\n",
                registered.display(),
                gone.display(),
            ),
        )
        .unwrap();

        // A folder still on disk is included; one that moved on (`gone`
        // was never created) is skipped rather than erroring the whole
        // read, same as `workspace_delete::outside_contexts`'s reasoning
        // for the same key.
        let roots = extra_context_roots(&std::fs::canonicalize(&root).unwrap());
        assert_eq!(roots, vec![std::fs::canonicalize(&registered).unwrap()]);
    }

    #[test]
    fn extra_context_roots_is_empty_with_no_config_or_no_key() {
        let dir = tempfile::tempdir().unwrap();
        assert!(extra_context_roots(dir.path()).is_empty());

        std::fs::create_dir_all(dir.path().join(".gavin-root")).unwrap();
        std::fs::write(dir.path().join(".gavin-root").join("config.toml"), "name = \"ws\"\n")
            .unwrap();
        assert!(extra_context_roots(dir.path()).is_empty());
    }

    #[test]
    fn read_file_for_viewer_refuses_a_path_outside_every_open_workspace() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().join("ws");
        std::fs::create_dir(&workspace).unwrap();
        // Deliberately REAL, so the refusal cannot be mistaken for "there
        // was nothing there".
        let outside = dir.path().join("secret.txt");
        std::fs::write(&outside, "s3cr3t").unwrap();
        let roots = vec![std::fs::canonicalize(&workspace).unwrap()];

        let err = read_file_for_viewer_impl(&outside.to_string_lossy(), &roots).unwrap_err();
        assert!(err.contains("outside every open workspace"), "{err}");
    }

    #[cfg(unix)]
    #[test]
    fn read_file_for_viewer_refuses_a_symlink_that_leaves_every_open_workspace() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().join("ws");
        std::fs::create_dir(&workspace).unwrap();
        let elsewhere = dir.path().join("elsewhere");
        std::fs::create_dir(&elsewhere).unwrap();
        std::fs::write(elsewhere.join("secret.txt"), "s3cr3t").unwrap();
        // A link INSIDE the workspace pointing out of it -- canonicalizing
        // the literal path (not just the workspace root) is what catches
        // this, the same way `resolve_existing` catches it for the six
        // guarded explorer commands.
        std::os::unix::fs::symlink(&elsewhere, workspace.join("escape")).unwrap();
        let roots = vec![std::fs::canonicalize(&workspace).unwrap()];

        let err = read_file_for_viewer_impl(
            &workspace.join("escape/secret.txt").to_string_lossy(),
            &roots,
        )
        .unwrap_err();
        assert!(err.contains("outside every open workspace"), "{err}");
    }

    #[test]
    fn write_file_for_editor_refuses_a_path_outside_every_open_workspace() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().join("ws");
        std::fs::create_dir(&workspace).unwrap();
        let outside = dir.path().join("leaked.txt");
        let roots = vec![std::fs::canonicalize(&workspace).unwrap()];

        let err =
            write_file_for_editor_impl(&outside.to_string_lossy(), "owned".to_string(), &roots)
                .unwrap_err();
        assert!(err.contains("outside every open workspace"), "{err}");
        // The refusal is the point: nothing was written outside the
        // workspace on the way to reporting it.
        assert!(!outside.exists());
    }

    #[cfg(unix)]
    #[test]
    fn write_file_for_editor_refuses_a_symlink_that_leaves_every_open_workspace() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().join("ws");
        std::fs::create_dir(&workspace).unwrap();
        let elsewhere = dir.path().join("elsewhere");
        std::fs::create_dir(&elsewhere).unwrap();
        std::os::unix::fs::symlink(&elsewhere, workspace.join("escape")).unwrap();
        let roots = vec![std::fs::canonicalize(&workspace).unwrap()];

        // The target file does not exist yet -- the walk-up in
        // `resolve_for_containment` must still catch the symlinked
        // ancestor before anything is created through it.
        let err = write_file_for_editor_impl(
            &workspace.join("escape/new.md").to_string_lossy(),
            "owned".to_string(),
            &roots,
        )
        .unwrap_err();
        assert!(err.contains("outside every open workspace"), "{err}");
        assert!(!elsewhere.join("new.md").exists());
    }

    #[test]
    fn resolve_path_under_cursor_refuses_a_path_outside_every_open_workspace_and_the_cwd() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().join("ws");
        std::fs::create_dir(&workspace).unwrap();
        let outside = dir.path().join("outside.txt");
        std::fs::write(&outside, "secret").unwrap();
        let roots = vec![std::fs::canonicalize(&workspace).unwrap()];

        // The session's cwd is the workspace, not the tempdir the file
        // actually lives in: outside every open workspace AND outside the
        // cwd carve-out, so it is refused.
        let resolved = resolve_path_under_cursor_impl(
            &outside.to_string_lossy(),
            &workspace.to_string_lossy(),
            &roots,
        );
        assert_eq!(resolved, None);

        // The same file resolves once the terminal session's own cwd is
        // where it lives -- Cmd+click legitimately follows a shell
        // wherever it runs, workspace root or not.
        let resolved = resolve_path_under_cursor_impl(
            &outside.to_string_lossy(),
            &dir.path().to_string_lossy(),
            &roots,
        );
        assert!(resolved.is_some());
    }

    #[cfg(unix)]
    #[test]
    fn resolve_path_under_cursor_refuses_a_symlink_that_leaves_every_open_workspace() {
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().join("ws");
        std::fs::create_dir(&workspace).unwrap();
        let elsewhere = dir.path().join("elsewhere");
        std::fs::create_dir(&elsewhere).unwrap();
        std::fs::write(elsewhere.join("secret.txt"), "s").unwrap();
        std::os::unix::fs::symlink(&elsewhere, workspace.join("escape")).unwrap();
        let roots = vec![std::fs::canonicalize(&workspace).unwrap()];

        let resolved = resolve_path_under_cursor_impl(
            &workspace.join("escape/secret.txt").to_string_lossy(),
            &workspace.to_string_lossy(),
            &roots,
        );
        assert_eq!(resolved, None);
    }

    #[test]
    fn watch_and_unwatch_file_for_viewer_refuse_a_path_outside_every_open_workspace() {
        // The guard both commands run before touching `FileWatchers` --
        // see their bodies, which call this directly. Exercised here
        // rather than through the `#[tauri::command]` functions
        // themselves, which need a live `AppHandle`/`State` the way every
        // other command test in this module avoids.
        let dir = tempfile::tempdir().unwrap();
        let workspace = dir.path().join("ws");
        std::fs::create_dir(&workspace).unwrap();
        let outside = dir.path().join("secret.txt");
        std::fs::write(&outside, "s").unwrap();
        let roots = vec![std::fs::canonicalize(&workspace).unwrap()];

        let err = ensure_within_open_workspaces(&outside.to_string_lossy(), &roots).unwrap_err();
        assert!(err.contains("outside every open workspace"), "{err}");
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

        let err = trash_entry_impl(&root_s, &dir.path().join("outside.md").to_string_lossy());
        assert!(err.unwrap_err().contains("outside the workspace root"));
        assert!(dir.path().join("outside.md").exists());

        let err = trash_entry_impl(&root_s, &root_s);
        assert!(err.unwrap_err().contains("workspace root itself"));
        assert!(root.is_dir());

        // A path that isn't there at all fails to resolve rather than
        // reporting a delete that never happened.
        assert!(trash_entry_impl(&root_s, &root.join("ghost.md").to_string_lossy()).is_err());
    }
}
