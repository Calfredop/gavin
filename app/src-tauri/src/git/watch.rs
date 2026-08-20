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

fn spawn_worktree_watcher<F>(root: &str, on_change: F) -> anyhow::Result<Debouncer<notify::RecommendedWatcher>>
where
    F: Fn() + Send + 'static,
{
    let root_path = PathBuf::from(root);
    let filter_root = root_path.clone();
    let mut debouncer = notify_debouncer_mini::new_debouncer(
        GIT_WATCH_DEBOUNCE,
        move |res: notify_debouncer_mini::DebounceEventResult| {
            let Ok(events) = res else { return };
            let hit = events.iter().any(|e| match e.path.strip_prefix(&filter_root) {
                Ok(rel) => is_relevant(rel),
                Err(_) => true,
            });
            if hit {
                on_change();
            }
        },
    )?;
    debouncer.watcher().watch(&root_path, notify::RecursiveMode::Recursive)?;
    Ok(debouncer)
}

#[tauri::command]
pub fn git_watch(cwd: String, app_handle: AppHandle, state: State<GitWatchers>) -> Result<(), String> {
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
}
