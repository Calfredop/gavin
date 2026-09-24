//! Watcher-driven refresh for the Git tab (spec §2, decision G9): a
//! recursive, debounced `notify` watch on the worktree that emits
//! `git-changed`. NEVER a timer — see crates/daemon/src/git_status.rs for
//! the index.lock history behind that rule.

use notify_debouncer_mini::Debouncer;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

pub const GIT_WATCH_DEBOUNCE: Duration = Duration::from_millis(300);

/// Which paths (relative to the worktree root) should trigger a refresh.
/// Everything outside `.git/` counts; inside it only the state files the
/// tab actually renders from. `*.lock` never counts — `index.lock` is
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

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitChanged {
    pub cwd: String,
}

/// Active worktree watchers keyed by worktree path, refcounted so two
/// callers (e.g. the tab and the Home tile) share one OS watch.
pub struct GitWatchers(pub Mutex<HashMap<String, (Debouncer<notify::RecommendedWatcher>, usize)>>);

impl Default for GitWatchers {
    fn default() -> Self {
        GitWatchers(Mutex::new(HashMap::new()))
    }
}

/// A linked worktree's real gitdir (`<main>/.git/worktrees/<name>/`) when it
/// lies outside `cwd`; None for a main worktree, whose `.git/` is already
/// inside the recursive watch.
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

fn spawn_worktree_watcher<F>(root: &str, on_change: F) -> anyhow::Result<Debouncer<notify::RecommendedWatcher>>
where
    F: Fn() + Send + 'static,
{
    let root_path = PathBuf::from(root);
    let filter_root = root_path.clone();
    let gitdir = gitdir_for(root);
    let filter_gitdir = gitdir.clone();
    let mut debouncer = notify_debouncer_mini::new_debouncer(
        GIT_WATCH_DEBOUNCE,
        move |res: notify_debouncer_mini::DebounceEventResult| {
            let Ok(events) = res else { return };
            let hit = events.iter().any(|e| relevant_event(&filter_root, filter_gitdir.as_deref(), &e.path));
            if hit {
                on_change();
            }
        },
    )?;
    debouncer.watcher().watch(&root_path, notify::RecursiveMode::Recursive)?;
    if let Some(gd) = gitdir {
        // HEAD, index, MERGE_HEAD live at the gitdir's top level; refs are
        // shared with the main repo and covered by its own watcher.
        if gd.is_dir() {
            debouncer.watcher().watch(&gd, notify::RecursiveMode::NonRecursive)?;
        }
    }
    Ok(debouncer)
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
    let debouncer = spawn_worktree_watcher(&cwd, move || {
        let _ = emitter.emit("git-changed", payload.clone());
    })
    .map_err(|e| e.to_string())?;
    watchers.insert(cwd, (debouncer, 1));
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
}
