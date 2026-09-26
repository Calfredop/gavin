//! Watcher-driven refresh for the Git tab (spec §2, decision G9): a
//! recursive, debounced `notify` watch on the worktree that emits
//! `git-changed`. NEVER a timer — see crates/daemon/src/git_status.rs for
//! the index.lock history behind that rule.

use notify_debouncer_mini::{Debouncer, DebouncedEvent};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

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
/// a worktree. Inside `.git/` only the state files the tab actually
/// renders from. `*.lock` never counts — `index.lock` is created by every
/// writing git command including our own, and reacting to it would make
/// the watcher chase its own tail.
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

fn spawn_worktree_watcher<F>(root: &str, on_change: F) -> anyhow::Result<Arc<WorktreeWatch>>
where
    F: Fn() + Send + 'static,
{
    let root_path = PathBuf::from(root);
    let filter_root = root_path.clone();
    let gitdir = gitdir_for(root);
    let filter_gitdir = gitdir.clone();

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
            let hit = events.iter().any(|e| relevant_event(&filter_root, filter_gitdir.as_deref(), &e.path));
            if hit {
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
        let _ = emitter.emit("git-changed", payload.clone());
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
