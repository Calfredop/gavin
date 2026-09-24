//! Long-running git ops (fetch/pull/push): streamed progress over the
//! `git-op-progress` event, one registry entry per op so the frontend can
//! cancel it (spec SP2 §1.1, decision G13).

use crate::git::run::{run_git_ro, run_git_streaming, SharedChild};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};

/// Running ops keyed by the frontend-generated op id.
#[derive(Clone, Default)]
pub struct GitOps(pub Arc<Mutex<HashMap<String, SharedChild>>>);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Progress {
    op_id: String,
    line: String,
}

/// Emits one progress line for `op_id`. The single place the event name
/// and its payload are spelled, so the local runner below and the relay
/// thread that carries a host's `GitOpProgress` (`session.rs`) cannot
/// drift into two slightly different events for the same row.
pub fn emit_progress(app: &AppHandle, op_id: String, line: String) {
    let _ = app.emit("git-op-progress", Progress { op_id, line });
}

/// Kills the op's child if it is still registered. The runner then reports
/// `cancelled` to its caller.
///
/// An op running on a host has no child here to kill: the remote registry
/// is asked first, and it answers only for an id it is actually running,
/// so a local op never takes the remote path or the other way round.
pub fn cancel(ops: &GitOps, op_id: &str) -> bool {
    if let Some(cancelled) = crate::remote::cancel_git_op_over_link(op_id) {
        return cancelled;
    }
    let child = ops.0.lock().unwrap().remove(op_id);
    match child {
        Some(shared) => {
            if let Some(mut c) = shared.lock().unwrap().take() {
                let _ = c.kill();
                let _ = c.wait();
            }
            true
        }
        None => false,
    }
}

fn current_branch(cwd: &str) -> Result<String, String> {
    let out = run_git_ro(cwd, &["symbolic-ref", "--short", "-q", "HEAD"])?;
    if out.code != 0 {
        return Err("detached HEAD: check out a branch first".into());
    }
    Ok(out.stdout_str().trim().to_string())
}

fn has_upstream(cwd: &str) -> Result<bool, String> {
    Ok(run_git_ro(cwd, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])?.code == 0)
}

fn push_args(cwd: &str, remote: &str) -> Result<Vec<String>, String> {
    if has_upstream(cwd)? {
        Ok(vec!["push".into(), "--progress".into()])
    } else {
        // "Publish": a branch with no upstream gets one on the chosen remote.
        let branch = current_branch(cwd)?;
        Ok(vec!["push".into(), "--progress".into(), "-u".into(), remote.to_string(), branch])
    }
}

#[cfg(test)]
pub(crate) fn fetch_blocking(cwd: &str, remote: &str, on_line: &mut dyn FnMut(String)) -> Result<(), String> {
    run_git_streaming(cwd, &["fetch", "--progress", "--prune", remote], on_line, &mut |_| {})
}

#[cfg(test)]
pub(crate) fn pull_blocking(cwd: &str, on_line: &mut dyn FnMut(String)) -> Result<(), String> {
    run_git_streaming(cwd, &["pull", "--progress"], on_line, &mut |_| {})
}

#[cfg(test)]
pub(crate) fn push_blocking(cwd: &str, remote: &str, on_line: &mut dyn FnMut(String)) -> Result<(), String> {
    let args = push_args(cwd, remote)?;
    let argv: Vec<&str> = args.iter().map(String::as_str).collect();
    run_git_streaming(cwd, &argv, on_line, &mut |_| {})
}

fn run_op(ops: GitOps, app: AppHandle, op_id: String, cwd: String, args: Vec<String>) -> Result<(), String> {
    // An ssh workspace's repo is on the host, and so is the git that
    // fetches into it. The request goes out on the link's streaming
    // connection and this blocks until the host's `GitOpDone` comes back
    // through the relay -- so this function returns "the op ended, here
    // is how" either way and `git_fetch`/`git_pull`/`git_push` are
    // unchanged. The routing lives HERE rather than in
    // `run_git_streaming` because the op id is what addresses the stream
    // and the cancel, and only this layer has one.
    //
    // Progress is not returned: the relay emits each `GitOpProgress` as
    // the same `git-op-progress` event the local closure below emits, so
    // the toolbar reads one stream of lines however the op ran.
    if let Some(result) = crate::remote::run_git_op_over_link(&cwd, &args, &op_id) {
        return result;
    }
    let argv: Vec<&str> = args.iter().map(String::as_str).collect();
    let emitter = app.clone();
    let id = op_id.clone();
    let registry = ops.clone();
    let reg_id = op_id.clone();
    let result = run_git_streaming(
        &cwd,
        &argv,
        &mut |line| {
            emit_progress(&emitter, id.clone(), line);
        },
        &mut |child| {
            registry.0.lock().unwrap().insert(reg_id.clone(), child);
        },
    );
    ops.0.lock().unwrap().remove(&op_id);
    result
}

async fn spawn_op(ops: GitOps, app: AppHandle, op_id: String, cwd: String, args: Vec<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || run_op(ops, app, op_id, cwd, args))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn git_fetch(cwd: String, remote: String, op_id: String, app: AppHandle, ops: State<'_, GitOps>) -> Result<(), String> {
    let args = vec!["fetch".into(), "--progress".into(), "--prune".into(), remote];
    spawn_op(ops.inner().clone(), app, op_id, cwd, args).await
}

#[tauri::command]
pub async fn git_pull(cwd: String, op_id: String, app: AppHandle, ops: State<'_, GitOps>) -> Result<(), String> {
    spawn_op(ops.inner().clone(), app, op_id, cwd, vec!["pull".into(), "--progress".into()]).await
}

#[tauri::command]
pub async fn git_push(cwd: String, remote: String, op_id: String, app: AppHandle, ops: State<'_, GitOps>) -> Result<(), String> {
    let args = push_args(&cwd, &remote)?;
    spawn_op(ops.inner().clone(), app, op_id, cwd, args).await
}

#[tauri::command]
pub fn git_cancel_op(op_id: String, ops: State<'_, GitOps>) -> bool {
    cancel(ops.inner(), &op_id)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::git::commands::testutil::*;
    use crate::git::commands::{refs, status};

    /// A bare "remote" plus a clone of it (identity configured), so
    /// fetch/pull/push run fully offline. Returns (bare, clone).
    pub(crate) fn remote_and_clone() -> (tempfile::TempDir, tempfile::TempDir) {
        let src = temp_repo();
        let bare = tempfile::tempdir().unwrap();
        git(cwd(&src), &["clone", "-q", "--bare", ".", bare.path().to_str().unwrap()]);
        let clone = tempfile::tempdir().unwrap();
        git(cwd(&src), &["clone", "-q", bare.path().to_str().unwrap(), clone.path().to_str().unwrap()]);
        git(cwd(&clone), &["config", "user.email", "t@example.com"]);
        git(cwd(&clone), &["config", "user.name", "T"]);
        git(cwd(&clone), &["config", "commit.gpgsign", "false"]);
        (bare, clone)
    }

    /// An id nothing is running is `false`, through both registries.
    /// The remote arm answers only for an op it is actually running, so
    /// it must not swallow an unknown id and report a cancel that never
    /// happened -- `gitState.ts` reads the verdict to decide whether the
    /// op row is still live.
    #[test]
    fn cancelling_an_unknown_op_is_false_and_never_taken_by_the_remote_arm() {
        let ops = GitOps::default();
        assert!(!cancel(&ops, "no-such-op"));
    }

    #[test]
    fn fetch_pull_push_round_trip_against_a_bare_remote() {
        let (bare, clone) = remote_and_clone();
        // Someone else pushes a commit.
        let other = tempfile::tempdir().unwrap();
        git(cwd(&clone), &["clone", "-q", bare.path().to_str().unwrap(), other.path().to_str().unwrap()]);
        git(cwd(&other), &["config", "user.email", "o@example.com"]);
        git(cwd(&other), &["config", "user.name", "O"]);
        git(cwd(&other), &["config", "commit.gpgsign", "false"]);
        write(&other, "o.txt", "o\n");
        git(cwd(&other), &["add", "o.txt"]);
        git(cwd(&other), &["commit", "-q", "-m", "other"]);
        git(cwd(&other), &["push", "-q"]);

        let mut lines = Vec::new();
        fetch_blocking(cwd(&clone), "origin", &mut |l| lines.push(l)).unwrap();
        let r = refs(cwd(&clone)).unwrap();
        let main = r.branches.iter().find(|b| b.current).unwrap();
        assert_eq!((main.ahead, main.behind), (0, 1));

        pull_blocking(cwd(&clone), &mut |_| {}).unwrap();
        assert!(clone.path().join("o.txt").exists());

        // Publish a new branch: no upstream → push -u.
        git(cwd(&clone), &["switch", "-q", "-c", "feature"]);
        write(&clone, "f2.txt", "f\n");
        git(cwd(&clone), &["add", "f2.txt"]);
        git(cwd(&clone), &["commit", "-q", "-m", "feature"]);
        push_blocking(cwd(&clone), "origin", &mut |_| {}).unwrap();
        let r = refs(cwd(&clone)).unwrap();
        let feature = r.branches.iter().find(|b| b.name == "feature").unwrap();
        assert_eq!(feature.upstream.as_deref(), Some("origin/feature"));
        assert!(status(cwd(&clone)).unwrap().unstaged.is_empty());
    }
}
