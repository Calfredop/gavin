//! Watcher-driven refresh for the Git tab (spec §2, decision G9): a
//! recursive, debounced `notify` watch on the worktree that emits
//! `git-changed`. NEVER a timer — see crates/daemon/src/git_status.rs for
//! the index.lock history behind that rule.
//!
//! A gitignored path never counts (`IgnoreFilter`): it is a change `git
//! status` never shows, so a refresh for it has nothing new to show.

use ignore::gitignore::{Gitignore, GitignoreBuilder};
use ignore::Match;
use notify_debouncer_mini::{Debouncer, DebouncedEvent};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;
use tauri::{AppHandle, State};

pub const GIT_WATCH_DEBOUNCE: Duration = Duration::from_millis(300);

/// Whether the whole worktree root is armed with ONE recursive
/// registration, or one non-recursive registration per top-level entry.
/// The daemon's `crates/daemon/src/gavin.rs` has the full story (its own
/// `ONE_RECURSIVE_WATCH`, duplicated here for the same reason `is_relevant`
/// is: this crate and the daemon share no module to hold it in). Short
/// version: FSEvents and `ReadDirectoryChangesW` each cover a whole tree
/// with one registration, so the per-directory set below only costs more
/// there for no benefit; inotify is genuinely non-recursive, and without
/// this split a `.gavin-worktrees` full of nested checkouts costs this
/// watch one inotify descriptor per directory of every one of them --
/// `node_modules` and `target` included -- which is enough to exhaust
/// `fs.inotify.max_user_watches` on its own.
const ONE_RECURSIVE_WATCH: bool = cfg!(any(target_os = "macos", windows));

/// Which paths (relative to the worktree root) should trigger a refresh.
/// Everything outside `.git/` counts except a `.gavin-worktrees` folder
/// at any depth: it holds OTHER checkouts, which this one's status never
/// lists (the folder ignores itself, see `commands::WORKTREES_DIR`) and
/// which get a watcher of their own when a Git tab looks at one --
/// counting them would refresh this tab on every build an agent runs in
/// a worktree. `IgnoreFilter` then drops the gitignored paths. Inside
/// `.git/` only the state files the tab actually renders from. `*.lock`
/// never counts — `index.lock` is created by every writing git command
/// including our own, and reacting to it would make the watcher chase
/// its own tail.
pub fn is_relevant(rel: &Path) -> bool {
    use crate::git::commands::WORKTREES_DIR;
    let mut comps = rel.components().map(|c| c.as_os_str().to_string_lossy().into_owned());
    let Some(first) = comps.next() else { return false };
    if first != ".git" {
        return first != WORKTREES_DIR && !comps.any(|c| c == WORKTREES_DIR);
    }
    if rel.to_string_lossy().ends_with(".lock") {
        return false;
    }
    let Some(second) = comps.next() else { return false };
    matches!(
        second.as_str(),
        "HEAD" | "ORIG_HEAD" | "MERGE_HEAD" | "index" | "packed-refs" | "refs" | "rebase-merge" | "rebase-apply"
    )
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitChanged {
    pub cwd: String,
}

/// Active worktree watchers keyed by worktree path, refcounted so two
/// callers (e.g. the tab and the Home tile) share one OS watch.
pub struct GitWatchers(pub Mutex<HashMap<String, (Arc<WorktreeWatch>, usize)>>);

impl Default for GitWatchers {
    fn default() -> Self {
        GitWatchers(Mutex::new(HashMap::new()))
    }
}

/// A linked worktree's real gitdir (`<main>/.git/worktrees/<name>/`) when it
/// lies outside `cwd`; None for a main worktree, whose `.git/` lives inside
/// `cwd` itself (`WorktreeWatch::arm_initial` watches it directly in that
/// case, off `ONE_RECURSIVE_WATCH`).
pub fn gitdir_for(cwd: &str) -> Option<PathBuf> {
    let out = crate::git::run::run_git_ro(cwd, &["rev-parse", "--absolute-git-dir"]).ok()?;
    if out.code != 0 {
        return None;
    }
    let dir = PathBuf::from(out.stdout_str().trim());
    // Canonicalise both sides: macOS hands out /var/… tmp paths that git
    // reports back as /private/var/….
    let canon_dir = std::fs::canonicalize(&dir).unwrap_or_else(|_| dir.clone());
    let canon_cwd = std::fs::canonicalize(cwd).unwrap_or_else(|_| PathBuf::from(cwd));
    if canon_dir.starts_with(&canon_cwd) {
        None
    } else {
        Some(dir)
    }
}

/// Routes an event path through `is_relevant`: paths under the worktree use
/// the root-relative rule; paths under a linked gitdir are treated as if
/// they were under `.git/` so the same filter applies. Anything else is
/// conservatively relevant.
pub fn relevant_event(root: &Path, gitdir: Option<&Path>, path: &Path) -> bool {
    if let Some(gd) = gitdir {
        if let Ok(rel) = path.strip_prefix(gd) {
            return is_relevant(&Path::new(".git").join(rel));
        }
    }
    match path.strip_prefix(root) {
        Ok(rel) => is_relevant(rel),
        Err(_) => true,
    }
}

/// Whether a direct child of the worktree root, named `entry_name`, gets
/// its own Recursive watch off `ONE_RECURSIVE_WATCH`. Everything qualifies
/// except `.git` (targeted coverage instead, see `WorktreeWatch::arm_initial`)
/// and `.gavin-worktrees` (another checkout entirely; recursing into it is
/// the whole perf problem this split exists to avoid -- inotify pays one
/// watch per directory of every nested worktree, `node_modules` and
/// `target` included).
fn is_top_level_watch_target(entry_name: &std::ffi::OsStr) -> bool {
    use crate::git::commands::WORKTREES_DIR;
    entry_name != ".git" && entry_name != WORKTREES_DIR
}

/// Owns the OS-level watch for one worktree root. Off `ONE_RECURSIVE_WATCH`
/// (Linux), a `RecursiveMode::Recursive` registration only covers what
/// already existed under a path the moment `watch()` ran, so a brand-new
/// top-level entry needs its own registration the instant it appears --
/// otherwise nothing created inside it is ever seen for the life of this
/// watcher. `rearm_new_top_level_dirs` does that from inside the debounce
/// callback, which is why the callback needs to reach back into this
/// struct at all.
///
/// That reach-back is a `Weak` self-reference, mirroring the daemon's own
/// `GavinWatcher::start` (`crates/daemon/src/gavin.rs`): `debouncer` starts
/// `None` and is only ever populated by `spawn_worktree_watcher` itself, so
/// a strong reference captured by the callback (rather than a `Weak` one)
/// would keep this struct -- and the OS watch inside it -- alive for as
/// long as the debouncer's background thread runs, which is until `Drop`
/// sends it `Shutdown`, which only happens when the LAST strong reference
/// goes... which would be the one the callback itself is holding. `git_unwatch`
/// dropping its handle when the refcount hits zero would leave the watch
/// running anyway.
pub struct WorktreeWatch {
    root: PathBuf,
    debouncer: Mutex<Option<Debouncer<notify::RecommendedWatcher>>>,
    armed: Mutex<HashSet<PathBuf>>,
}

impl WorktreeWatch {
    /// Registers the platform's watch set on the debouncer this instance
    /// already owns. Split out of `spawn_worktree_watcher` so every
    /// `watch()` call happens AFTER `self.debouncer` holds the debouncer:
    /// were it the other way around, an event from the very first
    /// `watch()` call could reach the callback (on its own background
    /// thread) before there was anywhere for `rearm_new_top_level_dirs` to
    /// register a watch through.
    fn arm_initial(&self, gitdir: Option<&Path>) -> anyhow::Result<()> {
        let mut guard = self.debouncer.lock().unwrap();
        let watcher = guard.as_mut().expect("debouncer stored before arm_initial runs").watcher();

        if ONE_RECURSIVE_WATCH {
            watcher.watch(&self.root, notify::RecursiveMode::Recursive)?;
        } else {
            // The root itself, non-recursively, to notice new/deleted
            // top-level entries (mirrors the daemon's own RepoPoller,
            // `setup_filesystem_watch` in crates/daemon/src/server.rs).
            watcher.watch(&self.root, notify::RecursiveMode::NonRecursive)?;
            if let Ok(entries) = std::fs::read_dir(&self.root) {
                for entry in entries.flatten() {
                    if !is_top_level_watch_target(&entry.file_name()) {
                        continue;
                    }
                    let path = entry.path();
                    if watcher.watch(&path, notify::RecursiveMode::Recursive).is_ok() {
                        self.armed.lock().unwrap().insert(path);
                    }
                }
            }
        }

        if let Some(gd) = gitdir {
            // Linked worktree: HEAD, index, MERGE_HEAD live at the
            // gitdir's top level; refs are shared with the main repo and
            // covered by its own watcher (unchanged by this split).
            if gd.is_dir() {
                watcher.watch(gd, notify::RecursiveMode::NonRecursive)?;
            }
        } else if !ONE_RECURSIVE_WATCH {
            // Main worktree: the loop above just skipped `.git`, so on
            // Linux its state needs the same targeted coverage the
            // daemon's RepoPoller gives it. HEAD/index/ORIG_HEAD/
            // MERGE_HEAD/packed-refs are all replaced via lockfile-rename
            // right at `.git`'s own top level (a NonRecursive watch on
            // `.git` itself catches all of them, plus a rebase starting
            // or finishing); `refs` is the one subtree under it that
            // genuinely needs full depth -- a new branch, or an existing
            // one moving, both write inside `refs/heads/`. `.git/objects`
            // stays out on purpose: it is the thousands-of-loose-files
            // directory this whole split exists to avoid registering.
            // Both watches are best-effort, unlike the root watch above:
            // a repo can be watched before its first commit, when `refs`
            // does not exist yet.
            let git_dir = self.root.join(".git");
            if git_dir.is_dir() {
                let _ = watcher.watch(&git_dir, notify::RecursiveMode::NonRecursive);
                let _ = watcher.watch(&git_dir.join("refs"), notify::RecursiveMode::Recursive);
            }
        }
        Ok(())
    }

    /// A brand-new top-level directory needs its own Recursive
    /// registration the moment it appears -- see the struct doc. Only
    /// meaningful off `ONE_RECURSIVE_WATCH`: the single recursive root
    /// watch already covers a new directory automatically everywhere
    /// else, and this is never called there.
    fn rearm_new_top_level_dirs(&self, events: &[DebouncedEvent]) {
        for e in events {
            let Ok(rel) = e.path.strip_prefix(&self.root) else { continue };
            if rel.components().count() != 1 || !e.path.is_dir() {
                continue;
            }
            if !is_top_level_watch_target(rel.as_os_str()) {
                continue;
            }
            if self.armed.lock().unwrap().contains(&e.path) {
                continue;
            }
            let mut guard = self.debouncer.lock().unwrap();
            let Some(debouncer) = guard.as_mut() else { continue };
            let armed = debouncer.watcher().watch(&e.path, notify::RecursiveMode::Recursive).is_ok();
            drop(guard);
            if armed {
                self.armed.lock().unwrap().insert(e.path.clone());
            }
        }
    }
}

/// `relevant_event` with git's ignore rules on top, for one watched
/// worktree. Everything outside `.git/` used to count, gitignored paths
/// included: a 4-second `npm install` into an ignored `node_modules/` was
/// 30,220 events and a dozen `git-changed`, each a full refresh of a view
/// with nothing new to show.
///
/// The rules come from the `ignore` crate's gitignore matcher, never from
/// a `git check-ignore` per event. Each batch reads them afresh -- only
/// the `.gitignore` files on the paths it touches, each parsed once -- so
/// an edited `.gitignore` needs no invalidation: the next batch reads the
/// new one.
///
/// What a pattern cannot say is whether a file is TRACKED, and `git
/// status` shows a change to a tracked file whatever the rules say. A
/// file force-added under an ignored folder is common (a third of the
/// repos on the owner's disk have one, some of them source files), so
/// those come from `git ls-files --cached --ignored` and keep counting.
/// That is a git process, so its answer is kept between batches and read
/// again only once the index or a rule has moved -- on this watcher's
/// thread, never the main one.
pub struct IgnoreFilter {
    root: PathBuf,
    gitdir: Option<PathBuf>,
    /// `core.excludesFile`, then `info/exclude`: located by asking git the
    /// first time a batch needs a verdict.
    excludes: Option<Vec<PathBuf>>,
    /// Their bytes as the last batch read them. Neither is reliably inside
    /// the watch -- the first lives in the home folder, and a linked
    /// worktree's `info/exclude` is in the main repo's gitdir -- so a
    /// change to them is noticed here rather than as an event.
    excludes_seen: Vec<u8>,
    /// None until a verdict needs it, and again once it may be stale.
    tracked: Option<TrackedIgnored>,
}

/// Tracked files an ignore rule matches, and every folder above one: an
/// event on such a folder can be the only word of a change inside it.
#[derive(Default)]
struct TrackedIgnored {
    files: HashSet<PathBuf>,
    dirs: HashSet<PathBuf>,
}

impl TrackedIgnored {
    fn contains(&self, rel: &Path) -> bool {
        self.files.contains(rel) || self.dirs.contains(rel)
    }
}

impl IgnoreFilter {
    /// `root` and `gitdir` as the watch was pointed at them, which is how
    /// event paths arrive.
    pub fn new(root: &Path, gitdir: Option<&Path>) -> IgnoreFilter {
        IgnoreFilter {
            root: root.to_path_buf(),
            gitdir: gitdir.map(Path::to_path_buf),
            excludes: None,
            excludes_seen: Vec::new(),
            tracked: None,
        }
    }

    /// Whether any path in one debounced batch is a change the Git tab
    /// could show.
    pub fn any_relevant<'a>(&mut self, batch: impl IntoIterator<Item = &'a Path>) -> bool {
        let batch: Vec<&Path> = batch.into_iter().collect();
        let mut rules = None;
        // Over the whole batch first: the verdicts below stop at the first
        // relevant path, and a rule change can sit behind it.
        for &path in &batch {
            if self.moves_tracked_set(path) {
                self.tracked = None;
            } else if let Some(rel) = self.worktree_rel(path) {
                let dir = rel.parent().unwrap_or(Path::new(""));
                // One in an ignored folder is one git never reads.
                if rel.file_name() == Some(OsStr::new(".gitignore"))
                    && (dir.as_os_str().is_empty() || !self.rules(&mut rules).matches(dir, true))
                {
                    self.tracked = None;
                }
            }
        }
        for &path in &batch {
            if !relevant_event(&self.root, self.gitdir.as_deref(), path) {
                continue;
            }
            // A `.git/` state file, or a path outside the watch.
            let Some(rel) = self.worktree_rel(path) else { return true };
            if !self.rules(&mut rules).matches(rel, is_dir(path)) {
                return true;
            }
            match self.tracked_ignored() {
                Some(tracked) if !tracked.contains(rel) => {}
                // Tracked, or git could not say.
                _ => return true,
            }
        }
        false
    }

    /// `path` relative to the worktree when it is in the tree proper: not
    /// the root itself, not `.git/`, not a linked worktree's gitdir.
    fn worktree_rel<'p>(&self, path: &'p Path) -> Option<&'p Path> {
        if self.gitdir.as_deref().is_some_and(|gd| path.starts_with(gd)) {
            return None;
        }
        let rel = path.strip_prefix(&self.root).ok()?;
        let first = rel.components().next()?;
        (first.as_os_str() != ".git").then_some(rel)
    }

    /// The index or `info/exclude`: which files are tracked, or which rules
    /// cover them, may have changed.
    fn moves_tracked_set(&self, path: &Path) -> bool {
        let in_gitdir = self.gitdir.as_deref().and_then(|gd| path.strip_prefix(gd).ok());
        let Some(rel) = in_gitdir.or_else(|| path.strip_prefix(self.root.join(".git")).ok()) else {
            return false;
        };
        rel == Path::new("index") || rel == Path::new("info/exclude")
    }

    /// This batch's rules, read on first use.
    fn rules<'r>(&mut self, slot: &'r mut Option<Rules>) -> &'r mut Rules {
        slot.get_or_insert_with(|| {
            if self.excludes.is_none() {
                self.excludes = Some(locate_excludes(&self.root));
            }
            let (rules, seen) = Rules::read(&self.root, self.excludes.as_deref().unwrap_or_default());
            if seen != self.excludes_seen {
                self.excludes_seen = seen;
                self.tracked = None;
            }
            rules
        })
    }

    /// The tracked files an ignore rule matches. None when git cannot say,
    /// which counts the path asked about -- and ends the batch, so a
    /// failing git runs once a batch, not once a path.
    fn tracked_ignored(&mut self) -> Option<&TrackedIgnored> {
        if self.tracked.is_none() {
            self.tracked = load_tracked_ignored(&self.root);
        }
        self.tracked.as_ref()
    }
}

/// One batch's reading of git's ignore rules. Each folder's `.gitignore`
/// is parsed at most once and each folder's verdict remembered: a batch is
/// typically thousands of paths under the same ignored folder.
struct Rules {
    root: PathBuf,
    /// `core.excludesFile` then `info/exclude` in one matcher, where the
    /// later line wins -- git's order between the two.
    base: Gitignore,
    gitignores: HashMap<PathBuf, Gitignore>,
    dir_verdicts: HashMap<PathBuf, bool>,
}

impl Rules {
    /// The rules, and the excludes files' bytes as read.
    fn read(root: &Path, excludes: &[PathBuf]) -> (Rules, Vec<u8>) {
        let mut builder = GitignoreBuilder::new(root);
        let mut seen = Vec::new();
        for file in excludes {
            let bytes = std::fs::read(file).unwrap_or_default();
            for line in String::from_utf8_lossy(&bytes).trim_start_matches('\u{feff}').lines() {
                // A line the matcher cannot parse is skipped, as git does.
                let _ = builder.add_line(Some(file.clone()), line);
            }
            seen.extend_from_slice(&bytes);
            seen.push(0);
        }
        let rules = Rules {
            root: root.to_path_buf(),
            base: builder.build().unwrap_or_else(|_| Gitignore::empty()),
            gitignores: HashMap::new(),
            dir_verdicts: HashMap::new(),
        };
        (rules, seen)
    }

    /// Whether git ignores `rel`: it, or any folder above it, is excluded.
    /// Git never descends into an ignored folder, so nothing below one can
    /// be re-included.
    fn matches(&mut self, rel: &Path, is_dir: bool) -> bool {
        let mut prefix = PathBuf::new();
        let mut components = rel.components().peekable();
        while let Some(component) = components.next() {
            prefix.push(component);
            let excluded = if components.peek().is_none() {
                self.excluded(&prefix, is_dir)
            } else if let Some(&verdict) = self.dir_verdicts.get(&prefix) {
                verdict
            } else {
                let verdict = self.excluded(&prefix, true);
                self.dir_verdicts.insert(prefix.clone(), verdict);
                verdict
            };
            if excluded {
                return true;
            }
        }
        false
    }

    /// One path's own verdict, by git's precedence: the nearest
    /// `.gitignore` with an opinion decides, then `info/exclude`, then
    /// `core.excludesFile`.
    fn excluded(&mut self, rel: &Path, is_dir: bool) -> bool {
        let mut dir = rel.parent();
        while let Some(d) = dir {
            // Relative to that `.gitignore`'s own folder, which is what its
            // anchored patterns are anchored to.
            let sub = rel.strip_prefix(d).unwrap_or(rel);
            match self.gitignore(d).matched(sub, is_dir) {
                Match::Ignore(_) => return true,
                Match::Whitelist(_) => return false,
                Match::None => {}
            }
            dir = d.parent();
        }
        self.base.matched(rel, is_dir).is_ignore()
    }

    fn gitignore(&mut self, dir: &Path) -> &Gitignore {
        let root = &self.root;
        self.gitignores.entry(dir.to_path_buf()).or_insert_with(|| {
            let dir = root.join(dir);
            let mut builder = GitignoreBuilder::new(&dir);
            // Most folders have none, and an unreadable one counts as none.
            let _ = builder.add(dir.join(".gitignore"));
            builder.build().unwrap_or_else(|_| Gitignore::empty())
        })
    }
}

/// Whether `path` is a folder now. A deleted one reads as a file, which
/// at worst counts a path a folder-only pattern would have dropped.
fn is_dir(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|m| m.is_dir())
}

/// `core.excludesFile` and this repo's `info/exclude`: the ignore rules
/// that are not a `.gitignore` in the tree. Asked of git, which knows the
/// repo's own config and the includes a config file can pull in.
fn locate_excludes(root: &Path) -> Vec<PathBuf> {
    let path = |args: &[&str]| {
        let out = git_stdout(root, args)?;
        let line = String::from_utf8_lossy(&out).trim().to_string();
        (!line.is_empty()).then(|| root.join(line))
    };
    let mut files = Vec::new();
    // Unset is an exit 1, and then git reads its default location.
    files.extend(
        path(&["config", "--path", "--get", "core.excludesFile"])
            .or_else(ignore::gitignore::gitconfig_excludes_path),
    );
    files.extend(path(&["rev-parse", "--git-path", "info/exclude"]));
    files
}

fn load_tracked_ignored(root: &Path) -> Option<TrackedIgnored> {
    let out = git_stdout(root, &["ls-files", "-z", "--cached", "--ignored", "--exclude-standard"])?;
    let mut tracked = TrackedIgnored::default();
    for name in out.split(|&b| b == 0).filter(|name| !name.is_empty()) {
        let file = PathBuf::from(String::from_utf8_lossy(name).into_owned());
        let dirs = file.ancestors().skip(1).filter(|d| !d.as_os_str().is_empty());
        tracked.dirs.extend(dirs.map(Path::to_path_buf));
        tracked.files.insert(file);
    }
    Some(tracked)
}

/// `git <args>` in `root`: its stdout, when it exits 0.
fn git_stdout(root: &Path, args: &[&str]) -> Option<Vec<u8>> {
    let out = crate::git::run::run_git_ro(root.to_str()?, args).ok()?;
    (out.code == 0).then_some(out.stdout)
}

fn spawn_worktree_watcher<F>(root: &str, on_change: F) -> anyhow::Result<Arc<WorktreeWatch>>
where
    F: Fn() + Send + 'static,
{
    // Resolved, the way the daemon's watcher resolves its root: the OS
    // reports events under the resolved path (on macOS `/private/var/...`
    // for a folder under `/var`), and one outside the root counts, so a
    // root reached through a symlink counted every path, `index.lock`
    // included.
    let root_path = protocol::canonical_path(Path::new(root)).unwrap_or_else(|_| PathBuf::from(root));
    let gitdir = gitdir_for(root).map(|gd| protocol::canonical_path(&gd).unwrap_or(gd));
    let mut filter = IgnoreFilter::new(&root_path, gitdir.as_deref());

    let watch = Arc::new(WorktreeWatch {
        root: root_path,
        debouncer: Mutex::new(None),
        armed: Mutex::new(HashSet::new()),
    });
    let weak: Weak<WorktreeWatch> = Arc::downgrade(&watch);

    let debouncer = notify_debouncer_mini::new_debouncer(
        GIT_WATCH_DEBOUNCE,
        move |res: notify_debouncer_mini::DebounceEventResult| {
            let Ok(events) = res else { return };
            // After the last strong Arc<WorktreeWatch> is dropped,
            // upgrade() returns None and this is a silent no-op --
            // correct, since whoever owned this watch has already given
            // it up.
            let Some(watch) = weak.upgrade() else { return };
            if !ONE_RECURSIVE_WATCH {
                watch.rearm_new_top_level_dirs(&events);
            }
            if filter.any_relevant(events.iter().map(|e| e.path.as_path())) {
                on_change();
            }
        },
    )?;

    *watch.debouncer.lock().unwrap() = Some(debouncer);
    watch.arm_initial(gitdir.as_deref())?;
    Ok(watch)
}

#[tauri::command]
pub fn git_watch(cwd: String, app_handle: AppHandle, state: State<GitWatchers>) -> Result<(), String> {
    // An ssh workspace's repo is on the host, so the watch runs THERE:
    // the host daemon points the same `notify` watch at the same tree
    // through the same relevance filter, and pushes `GitWorktreeChanged`,
    // which the relay emits as this module's own `git-changed` (v42).
    // Refcounting is the host's for these, per connection.
    //
    // A host below v42 answers `Unsupported`, which is a plain error and
    // not a reason to fail the tab -- swallowed here so the Refresh
    // button keeps working, exactly as this call no-op'd before the
    // request existed.
    if let Some(result) = crate::remote::watch_git_over_link(&cwd) {
        if let Err(e) = result {
            eprintln!("git watch over ssh unavailable for {cwd}: {e}");
        }
        return Ok(());
    }
    let mut watchers = state.0.lock().unwrap();
    if let Some(entry) = watchers.get_mut(&cwd) {
        entry.1 += 1;
        return Ok(());
    }
    let emitter = app_handle.clone();
    let payload = GitChanged { cwd: cwd.clone() };
    let watch = spawn_worktree_watcher(&cwd, move || {
        let _ = crate::forwarding::emit(&emitter, "git-changed", payload.clone());
    })
    .map_err(|e| e.to_string())?;
    watchers.insert(cwd, (watch, 1));
    Ok(())
}

#[tauri::command]
pub fn git_unwatch(cwd: String, state: State<GitWatchers>) -> Result<(), String> {
    if let Some(result) = crate::remote::unwatch_git_over_link(&cwd) {
        if let Err(e) = result {
            eprintln!("git unwatch over ssh failed for {cwd}: {e}");
        }
        return Ok(());
    }
    let mut watchers = state.0.lock().unwrap();
    let remove = match watchers.get_mut(&cwd) {
        Some(entry) => {
            entry.1 = entry.1.saturating_sub(1);
            entry.1 == 0
        }
        None => false,
    };
    if remove {
        watchers.remove(&cwd);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rel(p: &str) -> bool {
        is_relevant(Path::new(p))
    }

    #[test]
    fn worktree_paths_are_relevant() {
        assert!(rel("src/lib/foo.ts"));
        assert!(rel("README.md"));
        assert!(rel("nested/.gitignore"));
    }

    #[test]
    fn nested_gavin_worktrees_are_not_relevant() {
        assert!(!rel(".gavin-worktrees"));
        assert!(!rel(".gavin-worktrees/.gitignore"));
        assert!(!rel(".gavin-worktrees/feat-x/src/lib/foo.ts"));
        assert!(!rel(".gavin-worktrees/feat-x/target/debug/deps/x.o"));
        // A workspace opened at a package folder keeps its worktrees there.
        assert!(!rel("packages/foo/.gavin-worktrees/feat-x/README.md"));
        // Only that exact name.
        assert!(rel(".gavin-worktrees-notes.md"));
        assert!(rel(".gavin-root/plans/a.md"));
    }

    #[test]
    fn only_state_files_inside_dot_git_are_relevant() {
        for p in ["HEAD", "ORIG_HEAD", "MERGE_HEAD", "index", "packed-refs", "refs/heads/main", "rebase-merge/done", "rebase-apply/next"] {
            assert!(rel(&format!(".git/{p}")), "{p} should be relevant");
        }
        for p in ["index.lock", "refs/heads/main.lock", "objects/ab/cdef", "logs/HEAD", "FETCH_HEAD", "COMMIT_EDITMSG", "hooks/pre-commit"] {
            assert!(!rel(&format!(".git/{p}")), "{p} should be ignored");
        }
    }

    #[test]
    fn lock_files_anywhere_under_dot_git_are_ignored() {
        assert!(!rel(".git/HEAD.lock"));
        assert!(!rel(".git/packed-refs.lock"));
    }

    #[test]
    fn gitdir_events_map_onto_the_dot_git_rule() {
        let root = Path::new("/r/wt");
        let gitdir = Path::new("/r/main/.git/worktrees/wt");
        assert!(relevant_event(root, Some(gitdir), Path::new("/r/main/.git/worktrees/wt/HEAD")));
        assert!(relevant_event(root, Some(gitdir), Path::new("/r/main/.git/worktrees/wt/index")));
        assert!(!relevant_event(root, Some(gitdir), Path::new("/r/main/.git/worktrees/wt/index.lock")));
        assert!(!relevant_event(root, Some(gitdir), Path::new("/r/main/.git/worktrees/wt/logs/HEAD")));
        assert!(relevant_event(root, Some(gitdir), Path::new("/r/wt/src/a.ts")));
        assert!(relevant_event(root, None, Path::new("/r/wt/README.md")));
    }

    /// A repo with one commit whose ignore rules are only its own: the
    /// machine's `core.excludesFile` is swapped for one inside `.git/`.
    fn repo(files: &[(&str, &str)]) -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = protocol::canonical_path(dir.path()).unwrap();
        git(&root, &["init", "-q", "-b", "main"]);
        git(&root, &["config", "core.excludesFile", root.join(".git/test-excludes").to_str().unwrap()]);
        for (rel, body) in files {
            put(&root, rel, body);
        }
        git(&root, &["add", "-A"]);
        git(&root, &["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "x"]);
        (dir, root)
    }

    fn git(root: &Path, args: &[&str]) {
        let out = crate::git::run::run_git(root.to_str().unwrap(), args, None).unwrap();
        assert_eq!(out.code, 0, "git {args:?}: {}", out.stderr);
    }

    fn put(root: &Path, rel: &str, body: &str) {
        let path = root.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, body).unwrap();
    }

    fn counts(filter: &mut IgnoreFilter, root: &Path, rel: &str) -> bool {
        filter.any_relevant([root.join(rel).as_path()])
    }

    #[test]
    fn an_ignored_path_is_not_relevant() {
        let (_dir, root) = repo(&[(".gitignore", "node_modules/\n/target\n*.log\n"), ("web/.gitignore", "dist/\n")]);
        let ignored = ["node_modules/left-pad/index.js", "web/node_modules/p/index.js", "target/debug/app", "web/dist/app.js", "debug.log", "src/trace.log"];
        for p in ignored {
            put(&root, p, "x");
        }
        let mut filter = IgnoreFilter::new(&root, None);
        for p in ignored {
            assert!(!counts(&mut filter, &root, p), "{p} is ignored");
        }
        // A folder-only pattern covers the folder's own event as well.
        assert!(!counts(&mut filter, &root, "web/node_modules"));
        // `/target` is anchored to the root, and web's `dist/` to web/.
        put(&root, "web/target/x", "x");
        put(&root, "dist/x", "x");
        assert!(counts(&mut filter, &root, "web/target/x"));
        assert!(counts(&mut filter, &root, "dist/x"));
    }

    #[test]
    fn a_tracked_path_and_an_untracked_unignored_one_are_relevant() {
        let (_dir, root) = repo(&[(".gitignore", "node_modules/\n"), ("src/main.rs", "fn main() {}\n")]);
        put(&root, "src/new.rs", "");
        let mut filter = IgnoreFilter::new(&root, None);
        assert!(counts(&mut filter, &root, "src/main.rs"));
        assert!(counts(&mut filter, &root, "src/new.rs"));
        // The `.git/` rule still holds underneath.
        assert!(counts(&mut filter, &root, ".git/index"));
        assert!(!counts(&mut filter, &root, ".git/index.lock"));
    }

    #[test]
    fn a_batch_counts_when_any_path_in_it_does() {
        let (_dir, root) = repo(&[(".gitignore", "node_modules/\n"), ("src/main.rs", "fn main() {}\n")]);
        let mut batch: Vec<PathBuf> = (0..500).map(|i| root.join(format!("node_modules/p{i}/index.js"))).collect();
        let mut filter = IgnoreFilter::new(&root, None);
        assert!(!filter.any_relevant(batch.iter().map(PathBuf::as_path)));
        batch.push(root.join("src/main.rs"));
        assert!(filter.any_relevant(batch.iter().map(PathBuf::as_path)));
    }

    /// `git status` shows a change to a tracked file whatever the rules
    /// say, and a file force-added under an ignored folder is common.
    #[test]
    fn a_tracked_file_an_ignore_rule_matches_stays_relevant() {
        let (_dir, root) = repo(&[(".gitignore", "build/\n*.log\n")]);
        put(&root, "build/keep.txt", "x");
        put(&root, "keep.log", "x");
        put(&root, "build/other.txt", "x");
        git(&root, &["add", "-f", "build/keep.txt", "keep.log"]);
        let mut filter = IgnoreFilter::new(&root, None);
        assert!(counts(&mut filter, &root, "build/keep.txt"));
        assert!(counts(&mut filter, &root, "keep.log"));
        assert!(counts(&mut filter, &root, "build"));
        assert!(!counts(&mut filter, &root, "build/other.txt"));
    }

    #[test]
    fn a_gitignore_edit_rearms_the_matcher() {
        let (_dir, root) = repo(&[(".gitignore", "node_modules/\n"), ("docs/guide.md", "x")]);
        put(&root, "node_modules/p/index.js", "x");
        let mut filter = IgnoreFilter::new(&root, None);
        assert!(!counts(&mut filter, &root, "node_modules/p/index.js"));
        put(&root, ".gitignore", "docs/\n");
        assert!(counts(&mut filter, &root, ".gitignore"));
        assert!(counts(&mut filter, &root, "node_modules/p/index.js"));
        // A rule that newly covers a tracked file leaves it counting: the
        // tracked set is re-read, not the one from before the edit.
        assert!(counts(&mut filter, &root, "docs/guide.md"));
        put(&root, "docs/draft.md", "x");
        assert!(!counts(&mut filter, &root, "docs/draft.md"));
    }

    #[test]
    fn an_index_change_rearms_the_tracked_set() {
        let (_dir, root) = repo(&[(".gitignore", "build/\n")]);
        put(&root, "build/a.txt", "x");
        put(&root, "build/b.txt", "x");
        let mut filter = IgnoreFilter::new(&root, None);
        assert!(!counts(&mut filter, &root, "build/a.txt"));
        git(&root, &["add", "-f", "build/a.txt"]);
        assert!(counts(&mut filter, &root, ".git/index"));
        assert!(counts(&mut filter, &root, "build/a.txt"));
        assert!(!counts(&mut filter, &root, "build/b.txt"));
    }

    #[test]
    fn the_nearest_gitignore_decides() {
        let (_dir, root) = repo(&[(".gitignore", "*.log\n"), ("logs/.gitignore", "!keep.log\n")]);
        put(&root, "logs/keep.log", "x");
        put(&root, "logs/other.log", "x");
        let mut filter = IgnoreFilter::new(&root, None);
        assert!(counts(&mut filter, &root, "logs/keep.log"));
        assert!(!counts(&mut filter, &root, "logs/other.log"));
    }

    #[test]
    fn info_exclude_and_core_excludes_file_are_rules_too() {
        let (_dir, root) = repo(&[]);
        put(&root, ".git/info/exclude", "scratch/\n");
        put(&root, ".git/test-excludes", "*.tmp\n");
        put(&root, "scratch/a", "x");
        put(&root, "a.tmp", "x");
        let mut filter = IgnoreFilter::new(&root, None);
        assert!(!counts(&mut filter, &root, "scratch/a"));
        assert!(!counts(&mut filter, &root, "a.tmp"));
        put(&root, ".git/test-excludes", "");
        assert!(counts(&mut filter, &root, "a.tmp"));
    }

    #[test]
    fn a_gitignore_inside_an_ignored_folder_is_not_read() {
        let (_dir, root) = repo(&[(".gitignore", "node_modules/\n")]);
        put(&root, "node_modules/p/.gitignore", "!*\n");
        put(&root, "node_modules/p/index.js", "x");
        let mut filter = IgnoreFilter::new(&root, None);
        assert!(!counts(&mut filter, &root, "node_modules/p/.gitignore"));
        assert!(!counts(&mut filter, &root, "node_modules/p/index.js"));
    }

    /// The real watch, pointed at a tempdir the way the tab hands one over
    /// -- unresolved, so on macOS under `/var` while events arrive under
    /// `/private/var`.
    #[test]
    fn an_ignored_write_leaves_the_watcher_quiet() {
        let (dir, root) = repo(&[(".gitignore", "node_modules/\n")]);
        let hits = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = std::sync::Arc::clone(&hits);
        let _watcher = spawn_worktree_watcher(dir.path().to_str().unwrap(), move || {
            counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        })
        .unwrap();
        put(&root, "node_modules/p/index.js", "x");
        std::fs::write(root.join(".git").join("index.lock"), "x").unwrap();
        std::thread::sleep(GIT_WATCH_DEBOUNCE * 3);
        assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 0, "an ignored write must not wake it");
        put(&root, "src/a.rs", "x");
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while hits.load(std::sync::atomic::Ordering::SeqCst) == 0 && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(25));
        }
        assert!(hits.load(std::sync::atomic::Ordering::SeqCst) > 0, "an ordinary write must wake it");
    }

    #[test]
    fn gitdir_for_is_none_for_a_main_worktree_and_some_for_a_linked_one() {
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().to_str().unwrap();
        let _ = crate::git::run::run_git(cwd, &["init", "-q", "-b", "main"], None).unwrap();
        let _ = crate::git::run::run_git(cwd, &["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "x"], None).unwrap();
        assert!(gitdir_for(cwd).is_none());
        let wt = dir.path().join("linked");
        let _ = crate::git::run::run_git(cwd, &["worktree", "add", "-q", "-b", "side", wt.to_str().unwrap()], None).unwrap();
        let gd = gitdir_for(wt.to_str().unwrap()).expect("linked worktree has an external gitdir");
        assert!(gd.ends_with("worktrees/linked"), "{}", gd.display());
    }

    #[test]
    fn top_level_watch_target_skips_git_and_nested_worktrees() {
        use crate::git::commands::WORKTREES_DIR;
        use std::ffi::OsStr;
        assert!(!is_top_level_watch_target(OsStr::new(".git")));
        assert!(!is_top_level_watch_target(OsStr::new(WORKTREES_DIR)));
        assert!(is_top_level_watch_target(OsStr::new("src")));
        // Only that exact name -- matches is_relevant's own rule.
        assert!(is_top_level_watch_target(OsStr::new(".gavin-worktrees-notes.md")));
    }

    /// Exercises `rearm_new_top_level_dirs` directly rather than through
    /// `spawn_worktree_watcher`, so this proves the mechanism itself works
    /// regardless of which arm mode this build's `ONE_RECURSIVE_WATCH`
    /// happens to select -- a NonRecursive root watch (what the
    /// per-top-level-entry arm always uses, Linux or not) never reports a
    /// write two levels deep on its own, so a passing assertion here can
    /// only mean re-arming really happened.
    #[test]
    fn a_new_top_level_directory_needs_rearming_before_its_contents_are_seen() {
        let dir = tempfile::tempdir().unwrap();
        let root = protocol::canonical_path(dir.path()).unwrap();
        std::fs::create_dir(root.join(".git")).unwrap();

        let hits = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = std::sync::Arc::clone(&hits);
        let watch = Arc::new(WorktreeWatch {
            root: root.clone(),
            debouncer: Mutex::new(None),
            armed: Mutex::new(HashSet::new()),
        });
        let weak: Weak<WorktreeWatch> = Arc::downgrade(&watch);
        let filter_root = root.clone();
        let debouncer = notify_debouncer_mini::new_debouncer(
            GIT_WATCH_DEBOUNCE,
            move |res: notify_debouncer_mini::DebounceEventResult| {
                let Ok(events) = res else { return };
                let Some(watch) = weak.upgrade() else { return };
                watch.rearm_new_top_level_dirs(&events);
                if events.iter().any(|e| relevant_event(&filter_root, None, &e.path)) {
                    counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                }
            },
        )
        .unwrap();
        *watch.debouncer.lock().unwrap() = Some(debouncer);
        watch
            .debouncer
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .watcher()
            .watch(&root, notify::RecursiveMode::NonRecursive)
            .unwrap();

        let new_dir = root.join("newpkg");
        std::fs::create_dir(&new_dir).unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !watch.armed.lock().unwrap().contains(&new_dir) && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(25));
        }
        assert!(watch.armed.lock().unwrap().contains(&new_dir), "a new top-level directory must get re-armed");

        std::fs::write(new_dir.join("a.txt"), "hello").unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while hits.load(std::sync::atomic::Ordering::SeqCst) < 2 && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(25));
        }
        assert!(
            hits.load(std::sync::atomic::Ordering::SeqCst) >= 2,
            "both the new directory's own creation and a write inside it must be seen"
        );
    }
}
