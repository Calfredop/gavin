//! Watching a git worktree for the Git tab of a workspace on ANOTHER
//! machine (`WatchGitWorktree`, v42,
//! `docs/superpowers/specs/2026-09-23-ssh-git-sync-and-conflicts-design.md`).
//!
//! The desktop's own watcher (`app/src-tauri/src/git/watch.rs`) is a
//! recursive, debounced `notify` watch on the worktree. For an ssh
//! workspace there is no worktree on the desktop's disk to point it at,
//! so the same watch runs HERE and its verdict crosses the wire as a
//! `GitWorktreeChanged` push.
//!
//! NEVER a timer. `git_status.rs` records why: anything that runs
//! `git status` on a cadence creates `.git/index.lock` and fights every
//! writing git command including gavin's own. Crossing a network does
//! not soften that rule -- it adds a round trip to every wasted poll.
//!
//! `is_relevant` is a transcription of the desktop's function of the same
//! name, deliberately duplicated: the crate the two share is `protocol`,
//! which carries wire types, and a filesystem predicate is not one. The
//! two copies are tested on the same table of paths; change one and
//! change the other.

use notify_debouncer_mini::Debouncer;
use std::path::{Path, PathBuf};
use std::time::Duration;

pub const GIT_WATCH_DEBOUNCE: Duration = Duration::from_millis(300);

/// Which paths (relative to the worktree root) should trigger a refresh.
/// Everything outside `.git/` counts; inside it only the state files the
/// tab actually renders from. `*.lock` never counts -- `index.lock` is
/// created by every writing git command including our own, and reacting
/// to it would make the watcher chase its own tail.
pub fn is_relevant(rel: &Path) -> bool {
    let mut comps = rel.components().map(|c| c.as_os_str().to_string_lossy().into_owned());
    let Some(first) = comps.next() else { return false };
    if first != ".git" {
        return true;
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

/// A linked worktree's real gitdir (`<main>/.git/worktrees/<name>/`) when
/// it lies outside `cwd`; None for a main worktree, whose `.git/` is
/// already inside the recursive watch.
pub fn gitdir_for(cwd: &Path) -> Option<PathBuf> {
    let out = crate::program::command("git")
        .args(["--no-optional-locks", "rev-parse", "--absolute-git-dir"])
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let dir = PathBuf::from(String::from_utf8_lossy(&out.stdout).trim().to_string());
    if dir.as_os_str().is_empty() {
        return None;
    }
    // Canonicalise both sides: macOS hands out /var/… tmp paths that git
    // reports back as /private/var/….
    let canon_dir = std::fs::canonicalize(&dir).unwrap_or_else(|_| dir.clone());
    let canon_cwd = std::fs::canonicalize(cwd).unwrap_or_else(|_| cwd.to_path_buf());
    if canon_dir.starts_with(&canon_cwd) {
        None
    } else {
        Some(dir)
    }
}

/// Routes an event path through `is_relevant`: paths under the worktree
/// use the root-relative rule; paths under a linked gitdir are treated as
/// if they were under `.git/` so the same filter applies. Anything else
/// is conservatively relevant.
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

/// Starts the recursive, debounced watch on `root`, calling `on_change`
/// when a relevant path moves. The returned debouncer owns the OS watch:
/// drop it and the watch ends, which is how a closed connection takes its
/// watchers with it.
pub fn spawn_worktree_watcher<F>(
    root: &Path,
    on_change: F,
) -> anyhow::Result<Debouncer<notify::RecommendedWatcher>>
where
    F: Fn() + Send + 'static,
{
    let filter_root = root.to_path_buf();
    let gitdir = gitdir_for(root);
    let filter_gitdir = gitdir.clone();
    let mut debouncer = notify_debouncer_mini::new_debouncer(
        GIT_WATCH_DEBOUNCE,
        move |res: notify_debouncer_mini::DebounceEventResult| {
            let Ok(events) = res else { return };
            if events.iter().any(|e| relevant_event(&filter_root, filter_gitdir.as_deref(), &e.path)) {
                on_change();
            }
        },
    )?;
    debouncer.watcher().watch(root, notify::RecursiveMode::Recursive)?;
    if let Some(gd) = gitdir {
        // HEAD, index, MERGE_HEAD live at the gitdir's top level; refs are
        // shared with the main repo and covered by its own watcher.
        if gd.is_dir() {
            debouncer.watcher().watch(&gd, notify::RecursiveMode::NonRecursive)?;
        }
    }
    Ok(debouncer)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rel(p: &str) -> bool {
        is_relevant(Path::new(p))
    }

    /// The same table the desktop's `watch.rs` tests assert, so the two
    /// copies of the predicate cannot drift without one of them going red.
    #[test]
    fn worktree_paths_are_relevant() {
        assert!(rel("src/lib/foo.ts"));
        assert!(rel("README.md"));
        assert!(rel("nested/.gitignore"));
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

    /// The watch fires on an ordinary write and stays quiet for an
    /// `index.lock`, which is the whole reason the filter exists.
    #[test]
    fn a_relevant_write_wakes_the_watcher() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join(".git")).unwrap();
        let hits = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = std::sync::Arc::clone(&hits);
        let _watcher = spawn_worktree_watcher(dir.path(), move || {
            counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        })
        .unwrap();
        std::fs::write(dir.path().join(".git").join("index.lock"), "x").unwrap();
        std::thread::sleep(GIT_WATCH_DEBOUNCE * 3);
        assert_eq!(hits.load(std::sync::atomic::Ordering::SeqCst), 0, "index.lock must never wake it");
        std::fs::write(dir.path().join("a.txt"), "hello").unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while hits.load(std::sync::atomic::Ordering::SeqCst) == 0 && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(25));
        }
        assert!(hits.load(std::sync::atomic::Ordering::SeqCst) > 0, "an ordinary write must wake it");
    }
}
