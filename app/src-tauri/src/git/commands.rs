//! Tauri commands for the Git tab (spec §2). Each `#[tauri::command]` is a
//! thin wrapper over a plain function so the temp-repo tests below call the
//! real code path without a Tauri runtime.

use crate::git::parse::{parse_branches, parse_diff, parse_log, parse_name_status, parse_remotes, parse_stashes, parse_status, parse_worktree_list};
use crate::git::run::{ok, run_git, run_git_env, run_git_ro};
use crate::git::types::{Author, CommitDetail, FileDiff, LogPage, RefsSnapshot, RepoInfo, StatusResult, WorktreeInfo};
use std::path::Path;

/// Diffs larger than this are not rendered (spec §1: "Diff too large").
pub const MAX_DIFF_BYTES: usize = 2 * 1024 * 1024;

fn config_value(cwd: &str, key: &str) -> Result<Option<String>, String> {
    let out = run_git_ro(cwd, &["config", "--get", key])?;
    // Exit 1 = unset; anything else non-zero is a real error.
    match out.code {
        0 => Ok(Some(out.stdout_str().trim().to_string()).filter(|s| !s.is_empty())),
        1 => Ok(None),
        _ => Err(out.stderr.trim().to_string()),
    }
}

pub fn repo_info(cwd: &str) -> Result<RepoInfo, String> {
    let top = run_git_ro(cwd, &["rev-parse", "--show-toplevel"])?;
    if top.code != 0 {
        return Ok(RepoInfo { not_a_repo: true, ..Default::default() });
    }
    let root = top.stdout_str().trim().to_string();
    let unborn = run_git_ro(cwd, &["rev-parse", "--verify", "-q", "HEAD"])?.code != 0;
    let sym = run_git_ro(cwd, &["symbolic-ref", "--short", "-q", "HEAD"])?;
    let (branch, detached) = if sym.code == 0 {
        (Some(sym.stdout_str().trim().to_string()), false)
    } else {
        let sha = ok(run_git_ro(cwd, &["rev-parse", "--short", "HEAD"])?)?;
        (Some(sha.stdout_str().trim().to_string()), true)
    };
    let author = match (config_value(cwd, "user.name")?, config_value(cwd, "user.email")?) {
        (Some(name), Some(email)) => Some(Author { name, email }),
        _ => None,
    };
    let head_message = if unborn {
        None
    } else {
        Some(ok(run_git_ro(cwd, &["log", "-1", "--format=%B"])?)?.stdout_str().trim_end().to_string())
    };
    let git_dir = ok(run_git_ro(cwd, &["rev-parse", "--absolute-git-dir"])?)?.stdout_str().trim().to_string();
    let git_dir = Path::new(&git_dir);
    let in_progress = if git_dir.join("MERGE_HEAD").exists() {
        Some("merge".to_string())
    } else if git_dir.join("rebase-merge").exists() || git_dir.join("rebase-apply").exists() {
        Some("rebase".to_string())
    } else if git_dir.join("CHERRY_PICK_HEAD").exists() {
        Some("cherry-pick".to_string())
    } else if git_dir.join("REVERT_HEAD").exists() {
        Some("revert".to_string())
    } else {
        None
    };
    Ok(RepoInfo { not_a_repo: false, root: Some(root), branch, detached, unborn, author, head_message, in_progress })
}

pub fn status(cwd: &str) -> Result<StatusResult, String> {
    let out = ok(run_git_ro(cwd, &["status", "--porcelain=v2", "-z", "--untracked-files=all"])?)?;
    Ok(parse_status(&out.stdout))
}

/// One snapshot of branches (with tracking counts), remotes and stashes —
/// four read-only subprocesses, no per-branch calls (spec SP2 §1.2).
/// `worktrees` is filled in by SP3.
pub fn refs(cwd: &str) -> Result<RefsSnapshot, String> {
    let heads = ok(run_git_ro(
        cwd,
        &[
            "for-each-ref",
            "--format=%(refname:short)%00%(HEAD)%00%(upstream:short)%00%(upstream:track)%00%(objectname:short)%00%(subject)",
            "refs/heads",
        ],
    )?)?
    .stdout_str();
    let remote_refs = ok(run_git_ro(cwd, &["for-each-ref", "--format=%(refname:short)", "refs/remotes"])?)?.stdout_str();
    let remote_urls = ok(run_git_ro(cwd, &["remote", "-v"])?)?.stdout_str();
    // `stash list` takes log formats, where NUL is `%x00` (not for-each-ref's `%00`).
    let stash_raw = ok(run_git_ro(cwd, &["stash", "list", "--format=%gd%x00%gs%x00%cr"])?)?.stdout_str();
    let branches = parse_branches(&heads);
    let head_branch = branches.iter().find(|b| b.current).map(|b| b.name.clone());
    Ok(RefsSnapshot {
        branches,
        remotes: parse_remotes(&remote_urls, &remote_refs),
        stashes: parse_stashes(&stash_raw),
        worktrees: worktrees(cwd)?,
        head_branch,
    })
}

// ---- SP4: history -----------------------------------------------------------

#[cfg(test)]
pub const LOG_PAGE: usize = 300;

fn remote_names(cwd: &str) -> Result<Vec<String>, String> {
    let out = ok(run_git_ro(cwd, &["remote"])?)?;
    Ok(out.stdout_str().lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect())
}

/// One page of `git log --topo-order`; `limit + 1` rows are requested so
/// `has_more` is exact. An unborn HEAD is an empty page, not an error.
pub fn log(cwd: &str, all: bool, skip: usize, limit: usize) -> Result<LogPage, String> {
    let skip_s = format!("--skip={skip}");
    let max_s = format!("--max-count={}", limit + 1);
    let mut args: Vec<&str> = vec![
        "log",
        "--date=iso-strict",
        "--topo-order",
        "--format=%H%x00%P%x00%an%x00%ae%x00%ad%x00%s%x00%D%x1e",
        &skip_s,
        &max_s,
    ];
    if all {
        args.push("--all");
    }
    let out = run_git_ro(cwd, &args)?;
    if out.code != 0 {
        if out.stderr.contains("does not have any commits yet") || out.stderr.contains("bad default revision") {
            return Ok(LogPage::default());
        }
        return Err(out.stderr.trim().to_string());
    }
    let remotes = remote_names(cwd)?;
    let mut commits = parse_log(&out.stdout_str(), &remotes);
    let has_more = commits.len() > limit;
    commits.truncate(limit);
    Ok(LogPage { commits, has_more })
}

pub fn commit_detail(cwd: &str, sha: &str) -> Result<CommitDetail, String> {
    let body = ok(run_git_ro(cwd, &["show", "-s", "--format=%B", sha])?)?.stdout_str().trim_end().to_string();
    let files = ok(run_git_ro(cwd, &["diff-tree", "--root", "--no-commit-id", "--name-status", "-r", "-M", sha])?)?;
    Ok(CommitDetail { body, files: parse_name_status(&files.stdout_str()) })
}

pub fn checkout_commit(cwd: &str, sha: &str) -> Result<(), String> {
    ok(run_git(cwd, &["switch", "--detach", sha], None)?).map(|_| ())
}

pub fn cherry_pick(cwd: &str, sha: &str) -> Result<(), String> {
    ok(run_git_env(cwd, &["cherry-pick", sha], &[("GIT_EDITOR", "true")])?).map(|_| ())
}

pub fn revert(cwd: &str, sha: &str) -> Result<(), String> {
    ok(run_git(cwd, &["revert", "--no-edit", sha], None)?).map(|_| ())
}

pub fn reset(cwd: &str, sha: &str, mode: &str) -> Result<(), String> {
    let flag = match mode {
        "soft" => "--soft",
        "mixed" => "--mixed",
        "hard" => "--hard",
        other => return Err(format!("unknown reset mode: {other}")),
    };
    ok(run_git(cwd, &["reset", flag, sha], None)?).map(|_| ())
}

#[tauri::command]
pub fn git_log(cwd: String, all: bool, skip: usize, limit: usize) -> Result<LogPage, String> {
    log(&cwd, all, skip, limit.clamp(1, 1000))
}

#[tauri::command]
pub fn git_commit_detail(cwd: String, sha: String) -> Result<CommitDetail, String> {
    commit_detail(&cwd, &sha)
}

#[tauri::command]
pub fn git_checkout_commit(cwd: String, sha: String) -> Result<(), String> {
    checkout_commit(&cwd, &sha)
}

#[tauri::command]
pub fn git_cherry_pick(cwd: String, sha: String) -> Result<(), String> {
    cherry_pick(&cwd, &sha)
}

#[tauri::command]
pub fn git_revert(cwd: String, sha: String) -> Result<(), String> {
    revert(&cwd, &sha)
}

#[tauri::command]
pub fn git_reset(cwd: String, sha: String, mode: String) -> Result<(), String> {
    reset(&cwd, &sha, &mode)
}

#[tauri::command]
pub fn git_continue_in_progress(cwd: String, kind: String) -> Result<(), String> {
    continue_in_progress(&cwd, &kind)
}

// ---- SP3: worktrees ---------------------------------------------------------

pub fn worktrees(cwd: &str) -> Result<Vec<WorktreeInfo>, String> {
    let out = ok(run_git_ro(cwd, &["worktree", "list", "--porcelain"])?)?;
    Ok(parse_worktree_list(&out.stdout_str()))
}

/// `new_branch`: `worktree add -b <branch> <path> [<from>]`; otherwise
/// `worktree add <path> <branch>` for an existing branch.
pub fn worktree_add(cwd: &str, path: &str, branch: &str, from: Option<&str>, new_branch: bool) -> Result<(), String> {
    let mut args = vec!["worktree", "add"];
    if new_branch {
        args.extend(["-b", branch, "--", path]);
        if let Some(f) = from {
            args.push(f);
        }
    } else {
        args.extend(["--", path, branch]);
    }
    ok(run_git(cwd, &args, None)?).map(|_| ())
}

/// Removes a worktree, and tells watchman to stop watching it.
///
/// The watchman half is not tidiness: a root it is watching keeps its
/// whole tree in memory for five DAYS after the directory goes, and a
/// workspace that cuts a worktree per rail leaves one behind on every
/// merge. Eleven of those is a measurable share of the machine, held for
/// checkouts that no longer exist.
///
/// After the git removal and never before it: watchman has to be told
/// about a directory that is actually gone, and a `watch-del` for a path
/// git then refuses to remove would have dropped a watch the human still
/// wanted. `forget_root` is a no-op when no server is running, so the
/// ordinary machine pays nothing for it.
pub fn worktree_remove(cwd: &str, path: &str, force: bool) -> Result<(), String> {
    let mut args = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    args.push(path);
    ok(run_git(cwd, &args, None)?)?;
    crate::memory::forget_root(path);
    Ok(())
}

pub fn worktree_prune(cwd: &str) -> Result<(), String> {
    ok(run_git(cwd, &["worktree", "prune"], None)?).map(|_| ())
}

#[tauri::command]
pub fn git_worktree_add(cwd: String, path: String, branch: String, from: Option<String>, new_branch: bool) -> Result<(), String> {
    worktree_add(&cwd, &path, &branch, from.as_deref(), new_branch)
}

#[tauri::command]
pub fn git_worktree_remove(cwd: String, path: String, force: bool) -> Result<(), String> {
    worktree_remove(&cwd, &path, force)
}

#[tauri::command]
pub fn git_worktree_prune(cwd: String) -> Result<(), String> {
    worktree_prune(&cwd)
}

#[tauri::command]
pub fn git_refs(cwd: String) -> Result<RefsSnapshot, String> {
    refs(&cwd)
}

/// The well-known empty tree: the base for a root commit's diff.
const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

#[cfg(test)]
pub fn diff(cwd: &str, path: &str, old_path: Option<&str>, staged: bool, untracked: bool) -> Result<FileDiff, String> {
    diff_at(cwd, path, old_path, staged, untracked, None)
}

/// `rev` (SP4) diffs `<rev>^..<rev>` (the empty tree for a root commit) and
/// ignores `staged`/`untracked`.
pub fn diff_at(cwd: &str, path: &str, old_path: Option<&str>, staged: bool, untracked: bool, rev: Option<&str>) -> Result<FileDiff, String> {
    let mut args: Vec<&str> = vec!["diff", "--no-color", "--no-ext-diff", "-U3"];
    let parent: String;
    if let Some(rev) = rev {
        let parent_ref = format!("{rev}^");
        let has_parent = run_git_ro(cwd, &["rev-parse", "--verify", "-q", &parent_ref])?.code == 0;
        parent = if has_parent { parent_ref } else { EMPTY_TREE.to_string() };
        args.extend(["-M", &parent, "--", rev]);
        if let Some(old) = old_path {
            args.push(old);
        }
        args.push(path);
    } else if untracked {
        args.extend(["--no-index", "--", "/dev/null", path]);
    } else {
        if staged {
            args.extend(["--cached", "-M"]);
        }
        args.push("--");
        if let Some(old) = old_path {
            args.push(old);
        }
        args.push(path);
    }
    let out = run_git_ro(cwd, &args)?;
    // `diff` exits 1 for "differences found" under --no-index; both 0 and 1
    // are success here.
    if out.code != 0 && out.code != 1 {
        return Err(out.stderr.trim().to_string());
    }
    let mut result = FileDiff { path: path.to_string(), old_path: old_path.map(str::to_string), binary: false, too_large: false, hunks: vec![] };
    if out.stdout.len() > MAX_DIFF_BYTES {
        result.too_large = true;
        return Ok(result);
    }
    let text = out.stdout_str();
    if text.lines().any(|l| l.starts_with("Binary files ")) {
        result.binary = true;
        return Ok(result);
    }
    result.hunks = parse_diff(path, old_path, &text).hunks;
    Ok(result)
}

fn with_paths<'a>(head: &[&'a str], paths: &'a [String]) -> Vec<&'a str> {
    let mut args: Vec<&str> = head.to_vec();
    args.push("--");
    args.extend(paths.iter().map(String::as_str));
    args
}

fn head_is_unborn(cwd: &str) -> Result<bool, String> {
    Ok(run_git_ro(cwd, &["rev-parse", "--verify", "-q", "HEAD"])?.code != 0)
}

pub fn stage_files(cwd: &str, paths: &[String]) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }
    ok(run_git(cwd, &with_paths(&["add", "-A"], paths), None)?).map(|_| ())
}

pub fn unstage_files(cwd: &str, paths: &[String]) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }
    let head: &[&str] = if head_is_unborn(cwd)? { &["rm", "--cached", "-r", "-q"] } else { &["restore", "--staged"] };
    ok(run_git(cwd, &with_paths(head, paths), None)?).map(|_| ())
}

pub fn stage_all(cwd: &str) -> Result<(), String> {
    ok(run_git(cwd, &["add", "-A"], None)?).map(|_| ())
}

pub fn unstage_all(cwd: &str) -> Result<(), String> {
    let args: &[&str] = if head_is_unborn(cwd)? { &["rm", "--cached", "-r", "-q", "."] } else { &["reset", "-q"] };
    ok(run_git(cwd, args, None)?).map(|_| ())
}

/// `mode`: "stage" (→ index), "unstage" (reverse, index), "discard"
/// (reverse, worktree). The patch is built by the frontend (patch.ts).
pub fn apply_patch(cwd: &str, patch: &str, mode: &str) -> Result<(), String> {
    let mut args = vec!["apply", "--unidiff-zero", "--whitespace=nowarn"];
    match mode {
        "stage" => args.push("--cached"),
        "unstage" => args.extend(["--cached", "-R"]),
        "discard" => args.push("-R"),
        other => return Err(format!("unknown apply mode: {other}")),
    }
    ok(run_git(cwd, &args, Some(patch.as_bytes()))?).map(|_| ())
}

/// Tracked paths are restored from the index (`checkout --`); untracked
/// ones are deleted from disk (`clean -f`). Always confirmed in the UI.
pub fn discard_files(cwd: &str, tracked: &[String], untracked: &[String]) -> Result<(), String> {
    if !tracked.is_empty() {
        ok(run_git(cwd, &with_paths(&["checkout"], tracked), None)?)?;
    }
    if !untracked.is_empty() {
        ok(run_git(cwd, &with_paths(&["clean", "-f"], untracked), None)?)?;
    }
    Ok(())
}

pub fn commit(cwd: &str, message: &str, amend: bool) -> Result<(), String> {
    let mut args = vec!["commit", "-F", "-"];
    if amend {
        args.push("--amend");
    }
    ok(run_git(cwd, &args, Some(message.as_bytes()))?).map(|_| ())
}

pub fn init(cwd: &str) -> Result<(), String> {
    ok(run_git(cwd, &["init", "-q"], None)?).map(|_| ())
}

// ---- SP2: branches, remotes, stashes, in-progress control -----------------

fn local_branch_exists(cwd: &str, name: &str) -> Result<bool, String> {
    Ok(run_git_ro(cwd, &["show-ref", "--verify", "-q", &format!("refs/heads/{name}")])?.code == 0)
}

/// `switch <name>`; with `track_remote` and no local branch of that name,
/// `switch -c <name> --track <remote>/<name>`. A dirty tree that would be
/// overwritten is git's refusal, surfaced verbatim (G14).
pub fn checkout(cwd: &str, name: &str, track_remote: Option<&str>) -> Result<(), String> {
    match track_remote {
        Some(remote) if !local_branch_exists(cwd, name)? => {
            let upstream = format!("{remote}/{name}");
            ok(run_git(cwd, &["switch", "-c", name, "--track", &upstream], None)?).map(|_| ())
        }
        _ => ok(run_git(cwd, &["switch", "--", name], None)?).map(|_| ()),
    }
}

pub fn create_branch(cwd: &str, name: &str, from: Option<&str>, checkout_after: bool) -> Result<(), String> {
    let mut args = vec!["branch", "--", name];
    if let Some(f) = from {
        args.push(f);
    }
    ok(run_git(cwd, &args, None)?)?;
    if checkout_after {
        checkout(cwd, name, None)?;
    }
    Ok(())
}

pub fn delete_branch(cwd: &str, name: &str, force: bool) -> Result<(), String> {
    ok(run_git(cwd, &["branch", if force { "-D" } else { "-d" }, "--", name], None)?).map(|_| ())
}

/// Local branches whose every commit is already on `base` — `git branch
/// --merged`, which is exactly the question "would deleting this lose
/// anything". `base` itself comes back in the list (a branch is merged
/// into itself); the caller decides what to do with that.
///
/// `--format` rather than parsing the plain listing: the bare output
/// prefixes the current branch with `* ` and a branch checked out in
/// another worktree with `+ `, and a sweep that silently skipped
/// whichever branch happened to be checked out is the kind of bug that
/// only shows up on the machine that has the worktree.
pub fn merged_branches(cwd: &str, base: &str) -> Result<Vec<String>, String> {
    let out = ok(run_git_ro(cwd, &["branch", "--merged", base, "--format=%(refname:short)"])?)?;
    Ok(out
        .stdout_str()
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(str::to_string)
        .collect())
}

/// `merge --no-edit <branch>`; a conflict exits non-zero with MERGE_HEAD
/// left behind, which `repo_info` reports as `in_progress: "merge"`.
pub fn merge(cwd: &str, branch: &str) -> Result<(), String> {
    ok(run_git(cwd, &["merge", "--no-edit", "--", branch], None)?).map(|_| ())
}

pub fn abort_in_progress(cwd: &str, kind: &str) -> Result<(), String> {
    let args: &[&str] = match kind {
        "merge" => &["merge", "--abort"],
        "rebase" => &["rebase", "--abort"],
        "cherry-pick" => &["cherry-pick", "--abort"],
        "revert" => &["revert", "--abort"],
        other => return Err(format!("unknown in-progress kind: {other}")),
    };
    ok(run_git(cwd, args, None)?).map(|_| ())
}

/// `<kind> --continue` with GIT_EDITOR=true so it never opens an editor.
pub fn continue_in_progress(cwd: &str, kind: &str) -> Result<(), String> {
    let verb = match kind {
        "rebase" | "cherry-pick" | "revert" => kind,
        other => return Err(format!("cannot continue a {other}")),
    };
    ok(run_git_env(cwd, &[verb, "--continue"], &[("GIT_EDITOR", "true")])?).map(|_| ())
}

pub fn continue_rebase(cwd: &str) -> Result<(), String> {
    continue_in_progress(cwd, "rebase")
}

pub fn add_remote(cwd: &str, name: &str, url: &str) -> Result<(), String> {
    ok(run_git(cwd, &["remote", "add", name, url], None)?).map(|_| ())
}

pub fn remove_remote(cwd: &str, name: &str) -> Result<(), String> {
    ok(run_git(cwd, &["remote", "remove", name], None)?).map(|_| ())
}

pub fn stash_push(cwd: &str, message: &str, include_untracked: bool) -> Result<(), String> {
    let mut args = vec!["stash", "push"];
    if include_untracked {
        args.push("-u");
    }
    let msg = message.trim();
    if !msg.is_empty() {
        args.extend(["-m", msg]);
    }
    ok(run_git(cwd, &args, None)?).map(|_| ())
}

fn stash_ref(index: u32) -> String {
    format!("stash@{{{index}}}")
}

pub fn stash_pop(cwd: &str, index: u32) -> Result<(), String> {
    ok(run_git(cwd, &["stash", "pop", &stash_ref(index)], None)?).map(|_| ())
}

pub fn stash_apply(cwd: &str, index: u32) -> Result<(), String> {
    ok(run_git(cwd, &["stash", "apply", &stash_ref(index)], None)?).map(|_| ())
}

pub fn stash_drop(cwd: &str, index: u32) -> Result<(), String> {
    ok(run_git(cwd, &["stash", "drop", &stash_ref(index)], None)?).map(|_| ())
}

/// `stash show --name-status` → FileEntry list. `--include-untracked`
/// needs git ≥ 2.32; an older git rejects it, so retry without.
pub fn stash_files(cwd: &str, index: u32) -> Result<Vec<crate::git::types::FileEntry>, String> {
    let r = stash_ref(index);
    let mut out = run_git_ro(cwd, &["stash", "show", "--name-status", "--include-untracked", &r])?;
    if out.code != 0 {
        out = run_git_ro(cwd, &["stash", "show", "--name-status", &r])?;
    }
    let out = ok(out)?;
    Ok(parse_name_status(&out.stdout_str()))
}

#[tauri::command]
pub fn git_checkout(cwd: String, name: String, track_remote: Option<String>) -> Result<(), String> {
    checkout(&cwd, &name, track_remote.as_deref())
}

#[tauri::command]
pub fn git_create_branch(cwd: String, name: String, from: Option<String>, checkout: bool) -> Result<(), String> {
    create_branch(&cwd, &name, from.as_deref(), checkout)
}

#[tauri::command]
pub fn git_delete_branch(cwd: String, name: String, force: bool) -> Result<(), String> {
    delete_branch(&cwd, &name, force)
}

#[tauri::command]
pub fn git_merged_branches(cwd: String, base: String) -> Result<Vec<String>, String> {
    merged_branches(&cwd, &base)
}

#[tauri::command]
pub fn git_merge(cwd: String, branch: String) -> Result<(), String> {
    merge(&cwd, &branch)
}

#[tauri::command]
pub fn git_abort_in_progress(cwd: String, kind: String) -> Result<(), String> {
    abort_in_progress(&cwd, &kind)
}

#[tauri::command]
pub fn git_continue_rebase(cwd: String) -> Result<(), String> {
    continue_rebase(&cwd)
}

#[tauri::command]
pub fn git_add_remote(cwd: String, name: String, url: String) -> Result<(), String> {
    add_remote(&cwd, &name, &url)
}

#[tauri::command]
pub fn git_remove_remote(cwd: String, name: String) -> Result<(), String> {
    remove_remote(&cwd, &name)
}

#[tauri::command]
pub fn git_stash_push(cwd: String, message: String, include_untracked: bool) -> Result<(), String> {
    stash_push(&cwd, &message, include_untracked)
}

#[tauri::command]
pub fn git_stash_pop(cwd: String, index: u32) -> Result<(), String> {
    stash_pop(&cwd, index)
}

#[tauri::command]
pub fn git_stash_apply(cwd: String, index: u32) -> Result<(), String> {
    stash_apply(&cwd, index)
}

#[tauri::command]
pub fn git_stash_drop(cwd: String, index: u32) -> Result<(), String> {
    stash_drop(&cwd, index)
}

#[tauri::command]
pub fn git_stash_files(cwd: String, index: u32) -> Result<Vec<crate::git::types::FileEntry>, String> {
    stash_files(&cwd, index)
}

#[tauri::command]
pub fn git_stage_files(cwd: String, paths: Vec<String>) -> Result<(), String> {
    stage_files(&cwd, &paths)
}

#[tauri::command]
pub fn git_unstage_files(cwd: String, paths: Vec<String>) -> Result<(), String> {
    unstage_files(&cwd, &paths)
}

#[tauri::command]
pub fn git_stage_all(cwd: String) -> Result<(), String> {
    stage_all(&cwd)
}

#[tauri::command]
pub fn git_unstage_all(cwd: String) -> Result<(), String> {
    unstage_all(&cwd)
}

#[tauri::command]
pub fn git_apply_patch(cwd: String, patch: String, mode: String) -> Result<(), String> {
    apply_patch(&cwd, &patch, &mode)
}

#[tauri::command]
pub fn git_discard_files(cwd: String, tracked: Vec<String>, untracked: Vec<String>) -> Result<(), String> {
    discard_files(&cwd, &tracked, &untracked)
}

#[tauri::command]
pub fn git_commit(cwd: String, message: String, amend: bool) -> Result<(), String> {
    commit(&cwd, &message, amend)
}

#[tauri::command]
pub fn git_init(cwd: String) -> Result<(), String> {
    init(&cwd)
}

#[tauri::command]
pub fn git_repo_info(cwd: String) -> Result<RepoInfo, String> {
    repo_info(&cwd)
}

#[tauri::command]
pub fn git_status(cwd: String) -> Result<StatusResult, String> {
    status(&cwd)
}

/// The git half of what a reloaded frontend has to read back rather
/// than wait for a push to bring (see `git::baseline`). One answer per
/// cwd, in order, so the caller zips it onto the session ids the cwds
/// came from; `null` means "checked, not in a repo".
///
/// `async` + `spawn_blocking` rather than a plain sync command like its
/// neighbours here: this one runs on the app's load path, where a
/// `git status` over a large dirty checkout must not hold the main
/// thread through the first paint. Same shape `git::ops` uses for its
/// own long-running calls.
#[tauri::command]
pub async fn get_git_baselines(cwds: Vec<String>) -> Result<Vec<Option<protocol::GitStatus>>, String> {
    tauri::async_runtime::spawn_blocking(move || crate::git::baseline::git_baselines(&cwds))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn git_diff(cwd: String, path: String, old_path: Option<String>, staged: bool, untracked: bool, rev: Option<String>) -> Result<FileDiff, String> {
    diff_at(&cwd, &path, old_path.as_deref(), staged, untracked, rev.as_deref())
}

#[cfg(test)]
pub(crate) mod testutil {
    use super::*;
    use std::fs;

    /// A fresh repo with identity + signing configured so commits work on
    /// any machine, and ONE commit of `f.txt` = "alpha..epsilon".
    pub fn temp_repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let cwd = dir.path().to_str().unwrap();
        git(cwd, &["init", "-q", "-b", "main"]);
        git(cwd, &["config", "user.email", "t@example.com"]);
        git(cwd, &["config", "user.name", "Test User"]);
        git(cwd, &["config", "commit.gpgsign", "false"]);
        // Byte-exact blobs regardless of the machine's autocrlf setting.
        git(cwd, &["config", "core.autocrlf", "false"]);
        fs::write(dir.path().join("f.txt"), "alpha\nbeta\ngamma\ndelta\nepsilon\n").unwrap();
        git(cwd, &["add", "f.txt"]);
        git(cwd, &["commit", "-q", "-m", "base"]);
        dir
    }

    pub fn git(cwd: &str, args: &[&str]) -> String {
        let out = ok(run_git(cwd, args, None).unwrap()).unwrap_or_else(|e| panic!("git {args:?}: {e}"));
        out.stdout_str()
    }

    pub fn write(dir: &tempfile::TempDir, name: &str, content: &str) {
        fs::write(dir.path().join(name), content).unwrap();
    }

    pub fn cwd(dir: &tempfile::TempDir) -> &str {
        dir.path().to_str().unwrap()
    }
}

#[cfg(test)]
mod read_tests {
    use super::testutil::*;
    use super::*;

    #[test]
    fn repo_info_on_a_normal_repo() {
        let dir = temp_repo();
        let info = repo_info(cwd(&dir)).unwrap();
        assert!(!info.not_a_repo);
        assert_eq!(info.branch.as_deref(), Some("main"));
        assert!(!info.detached && !info.unborn);
        assert_eq!(info.author, Some(Author { name: "Test User".into(), email: "t@example.com".into() }));
        assert_eq!(info.head_message.as_deref(), Some("base"));
        assert_eq!(info.in_progress, None);
        assert_eq!(info.root.as_deref().map(Path::new).and_then(Path::file_name), dir.path().file_name());
    }

    #[test]
    fn repo_info_reports_not_a_repo_for_a_plain_directory() {
        let dir = tempfile::tempdir().unwrap();
        // Guard against an enclosing repo (e.g. a tmpdir inside a checkout):
        // only assert when git agrees the dir is outside one.
        if run_git(cwd(&dir), &["rev-parse", "--show-toplevel"], None).unwrap().code != 0 {
            let info = repo_info(cwd(&dir)).unwrap();
            assert!(info.not_a_repo);
        }
    }

    #[test]
    fn repo_info_detects_unborn_and_detached_heads() {
        let dir = tempfile::tempdir().unwrap();
        git(cwd(&dir), &["init", "-q", "-b", "main"]);
        let info = repo_info(cwd(&dir)).unwrap();
        assert!(info.unborn, "fresh init must be unborn");
        assert_eq!(info.branch.as_deref(), Some("main"));
        assert_eq!(info.head_message, None);

        let dir = temp_repo();
        git(cwd(&dir), &["checkout", "-q", "--detach"]);
        let info = repo_info(cwd(&dir)).unwrap();
        assert!(info.detached);
        assert_eq!(info.branch.as_deref().map(str::len), Some(7));
    }

    #[test]
    fn status_lists_staged_unstaged_and_untracked() {
        let dir = temp_repo();
        write(&dir, "f.txt", "alpha\nBETA\ngamma\ndelta\nepsilon\n");
        write(&dir, "new.ts", "x\n");
        write(&dir, "u.txt", "hello\n");
        git(cwd(&dir), &["add", "new.ts"]);
        let s = status(cwd(&dir)).unwrap();
        assert_eq!(s.staged.iter().map(|e| (e.path.as_str(), e.status.as_str())).collect::<Vec<_>>(), vec![("new.ts", "A")]);
        assert_eq!(
            s.unstaged.iter().map(|e| (e.path.as_str(), e.status.as_str())).collect::<Vec<_>>(),
            vec![("f.txt", "M"), ("u.txt", "?")]
        );
    }

    #[test]
    fn diff_unstaged_staged_and_untracked() {
        let dir = temp_repo();
        write(&dir, "f.txt", "alpha\nBETA\ngamma\nnew1\nnew2\nepsilon\n");
        let d = diff(cwd(&dir), "f.txt", None, false, false).unwrap();
        assert_eq!(d.hunks.len(), 1);
        assert_eq!(d.hunks[0].header, "@@ -1,5 +1,6 @@");
        assert_eq!(d.hunks[0].lines.iter().filter(|l| l.kind == "add").count(), 3);

        git(cwd(&dir), &["add", "f.txt"]);
        let staged = diff(cwd(&dir), "f.txt", None, true, false).unwrap();
        assert_eq!(staged.hunks[0].header, "@@ -1,5 +1,6 @@");
        let unstaged_now = diff(cwd(&dir), "f.txt", None, false, false).unwrap();
        assert!(unstaged_now.hunks.is_empty());

        write(&dir, "u.txt", "hello\n");
        let u = diff(cwd(&dir), "u.txt", None, false, true).unwrap();
        assert_eq!(u.hunks[0].lines.len(), 1);
        assert_eq!(u.hunks[0].lines[0].kind, "add");
        assert_eq!(u.hunks[0].lines[0].text, "hello");
    }

    #[test]
    fn diff_flags_binary_and_too_large() {
        let dir = temp_repo();
        write(&dir, "blob.bin", "\u{0}\u{1}\u{2}binary\u{0}\n");
        let b = diff(cwd(&dir), "blob.bin", None, false, true).unwrap();
        assert!(b.binary);
        assert!(b.hunks.is_empty());

        let big = "line\n".repeat(MAX_DIFF_BYTES / 5 + 10);
        write(&dir, "big.txt", &big);
        let t = diff(cwd(&dir), "big.txt", None, false, true).unwrap();
        assert!(t.too_large);
        assert!(t.hunks.is_empty());
    }

    #[test]
    fn refs_snapshot_from_a_real_repo_with_a_stash() {
        let dir = temp_repo();
        git(cwd(&dir), &["branch", "other"]);
        write(&dir, "f.txt", "changed\n");
        git(cwd(&dir), &["stash", "push", "-q", "-m", "my stash"]);
        let r = refs(cwd(&dir)).unwrap();
        assert_eq!(r.head_branch.as_deref(), Some("main"));
        assert_eq!(r.branches.iter().filter(|b| b.current).count(), 1);
        assert!(r.branches.iter().any(|b| b.name == "other"));
        assert!(r.remotes.is_empty());
        assert_eq!(r.stashes[0].message, "On main: my stash");
        assert_eq!(r.worktrees.len(), 1);
        assert!(r.worktrees[0].is_main);
    }

    #[test]
    fn diff_of_a_staged_rename_uses_both_paths() {
        let dir = temp_repo();
        git(cwd(&dir), &["mv", "f.txt", "g.txt"]);
        let d = diff(cwd(&dir), "g.txt", Some("f.txt"), true, false).unwrap();
        assert_eq!(d.old_path.as_deref(), Some("f.txt"));
        assert!(d.hunks.is_empty(), "a pure rename has no hunks");
    }
}

#[cfg(test)]
mod write_tests {
    use super::testutil::*;
    use super::*;
    use serde::Deserialize;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Fixture {
        name: String,
        file: String,
        base: String,
        modified: String,
        diff: FileDiff,
        #[allow(dead_code)]
        hunk_index: usize,
        #[allow(dead_code)]
        selected: Option<Vec<String>>,
        expected_patch: String,
    }

    #[derive(Deserialize)]
    struct Fixtures {
        fixtures: Vec<Fixture>,
    }

    const FIXTURES: &str = include_str!("../../../src/lib/fixtures/patch-fixtures.json");

    fn paths(entries: &[crate::git::types::FileEntry]) -> Vec<String> {
        entries.iter().map(|e| format!("{}{}", e.status, e.path)).collect()
    }

    #[test]
    fn stage_and_unstage_files_move_entries_between_lists() {
        let dir = temp_repo();
        write(&dir, "f.txt", "changed\n");
        write(&dir, "u.txt", "new\n");
        stage_files(cwd(&dir), &["f.txt".into(), "u.txt".into()]).unwrap();
        let s = status(cwd(&dir)).unwrap();
        assert_eq!(paths(&s.staged), vec!["Mf.txt", "Au.txt"]);
        assert!(s.unstaged.is_empty());

        unstage_files(cwd(&dir), &["u.txt".into()]).unwrap();
        let s = status(cwd(&dir)).unwrap();
        assert_eq!(paths(&s.staged), vec!["Mf.txt"]);
        assert_eq!(paths(&s.unstaged), vec!["?u.txt"]);
    }

    #[test]
    fn stage_all_and_unstage_all_including_on_an_unborn_head() {
        let dir = temp_repo();
        write(&dir, "f.txt", "changed\n");
        write(&dir, "u.txt", "new\n");
        stage_all(cwd(&dir)).unwrap();
        assert_eq!(status(cwd(&dir)).unwrap().staged.len(), 2);
        unstage_all(cwd(&dir)).unwrap();
        assert!(status(cwd(&dir)).unwrap().staged.is_empty());

        let fresh = tempfile::tempdir().unwrap();
        git(cwd(&fresh), &["init", "-q", "-b", "main"]);
        write(&fresh, "a", "a\n");
        stage_all(cwd(&fresh)).unwrap();
        assert_eq!(paths(&status(cwd(&fresh)).unwrap().staged), vec!["Aa"]);
        unstage_all(cwd(&fresh)).unwrap();
        assert_eq!(paths(&status(cwd(&fresh)).unwrap().unstaged), vec!["?a"]);
    }

    #[test]
    fn fixtures_parse_identically_and_their_patches_apply() {
        let fx: Fixtures = serde_json::from_str(FIXTURES).unwrap();
        assert!(fx.fixtures.len() >= 4);
        for f in &fx.fixtures {
            let dir = tempfile::tempdir().unwrap();
            let c = cwd(&dir);
            git(c, &["init", "-q", "-b", "main"]);
            git(c, &["config", "user.email", "t@example.com"]);
            git(c, &["config", "user.name", "T"]);
            git(c, &["config", "commit.gpgsign", "false"]);
            write(&dir, &f.file, &f.base);
            git(c, &["add", &f.file]);
            git(c, &["commit", "-q", "-m", "base"]);
            write(&dir, &f.file, &f.modified);

            let parsed = diff(c, &f.file, None, false, false).unwrap();
            assert_eq!(parsed, f.diff, "fixture {} diff JSON drifted from the parser", f.name);

            // The builder's expected output must be accepted by git…
            let check = run_git(c, &["apply", "--cached", "--unidiff-zero", "--whitespace=nowarn", "--check"], Some(f.expected_patch.as_bytes())).unwrap();
            assert_eq!(check.code, 0, "fixture {}: {}", f.name, check.stderr);
            // …and actually stage something.
            apply_patch(c, &f.expected_patch, "stage").unwrap();
            assert_eq!(paths(&status(c).unwrap().staged), vec![format!("M{}", f.file)], "fixture {}", f.name);
            // Unstage reverses it exactly.
            apply_patch(c, &f.expected_patch, "unstage").unwrap();
            assert!(status(c).unwrap().staged.is_empty(), "fixture {}", f.name);
        }
    }

    #[test]
    fn discard_mode_reverts_the_worktree_and_discard_files_handles_both_kinds() {
        let dir = temp_repo();
        write(&dir, "f.txt", "alpha\nBETA\ngamma\nnew1\nnew2\nepsilon\n");
        let fx: Fixtures = serde_json::from_str(FIXTURES).unwrap();
        let whole = &fx.fixtures[0];
        apply_patch(cwd(&dir), &whole.expected_patch, "discard").unwrap();
        assert!(status(cwd(&dir)).unwrap().unstaged.is_empty());

        write(&dir, "f.txt", "changed\n");
        write(&dir, "u.txt", "new\n");
        discard_files(cwd(&dir), &["f.txt".into()], &["u.txt".into()]).unwrap();
        assert_eq!(status(cwd(&dir)).unwrap(), StatusResult::default());
        assert!(!dir.path().join("u.txt").exists());
    }

    #[test]
    fn commit_then_amend_rewrites_head_message() {
        let dir = temp_repo();
        write(&dir, "f.txt", "changed\n");
        stage_all(cwd(&dir)).unwrap();
        commit(cwd(&dir), "feat: change\n\nbody line", false).unwrap();
        assert_eq!(repo_info(cwd(&dir)).unwrap().head_message.as_deref(), Some("feat: change\n\nbody line"));
        assert_eq!(git(cwd(&dir), &["rev-list", "--count", "HEAD"]).trim(), "2");

        commit(cwd(&dir), "feat: amended", true).unwrap();
        assert_eq!(repo_info(cwd(&dir)).unwrap().head_message.as_deref(), Some("feat: amended"));
        assert_eq!(git(cwd(&dir), &["rev-list", "--count", "HEAD"]).trim(), "2");
    }

    #[test]
    fn commit_with_nothing_staged_surfaces_gits_message() {
        let dir = temp_repo();
        let err = commit(cwd(&dir), "empty", false).unwrap_err();
        assert!(!err.is_empty());
    }

    #[test]
    fn init_turns_a_plain_directory_into_a_repo() {
        let dir = tempfile::tempdir().unwrap();
        init(cwd(&dir)).unwrap();
        assert!(dir.path().join(".git").is_dir());
        assert!(repo_info(cwd(&dir)).unwrap().unborn);
    }
}

#[cfg(test)]
mod ref_tests {
    use super::testutil::*;
    use super::*;

    #[test]
    fn create_checkout_and_delete_branches() {
        let dir = temp_repo();
        create_branch(cwd(&dir), "feature", None, true).unwrap();
        assert_eq!(repo_info(cwd(&dir)).unwrap().branch.as_deref(), Some("feature"));
        write(&dir, "x", "x\n");
        stage_all(cwd(&dir)).unwrap();
        commit(cwd(&dir), "x", false).unwrap();
        checkout(cwd(&dir), "main", None).unwrap();
        let err = delete_branch(cwd(&dir), "feature", false).unwrap_err();
        assert!(err.contains("not fully merged"), "{err}");
        delete_branch(cwd(&dir), "feature", true).unwrap();
        assert!(!refs(cwd(&dir)).unwrap().branches.iter().any(|b| b.name == "feature"));
    }

    #[test]
    fn checkout_of_a_remote_branch_creates_a_tracking_branch() {
        let (_bare, clone) = crate::git::ops::tests::remote_and_clone();
        git(cwd(&clone), &["switch", "-q", "-c", "topic"]);
        write(&clone, "t", "t\n");
        git(cwd(&clone), &["add", "t"]);
        git(cwd(&clone), &["commit", "-q", "-m", "t"]);
        git(cwd(&clone), &["push", "-q", "-u", "origin", "topic"]);
        git(cwd(&clone), &["switch", "-q", "main"]);
        git(cwd(&clone), &["branch", "-q", "-D", "topic"]);
        checkout(cwd(&clone), "topic", Some("origin")).unwrap();
        let r = refs(cwd(&clone)).unwrap();
        assert_eq!(r.branches.iter().find(|b| b.name == "topic").unwrap().upstream.as_deref(), Some("origin/topic"));
        assert_eq!(r.head_branch.as_deref(), Some("topic"));
    }

    #[test]
    fn merge_conflict_sets_in_progress_and_abort_clears_it() {
        let dir = temp_repo();
        create_branch(cwd(&dir), "b", None, true).unwrap();
        write(&dir, "f.txt", "B\n");
        stage_all(cwd(&dir)).unwrap();
        commit(cwd(&dir), "b", false).unwrap();
        checkout(cwd(&dir), "main", None).unwrap();
        write(&dir, "f.txt", "A\n");
        stage_all(cwd(&dir)).unwrap();
        commit(cwd(&dir), "a", false).unwrap();
        assert!(merge(cwd(&dir), "b").is_err());
        assert_eq!(repo_info(cwd(&dir)).unwrap().in_progress.as_deref(), Some("merge"));
        assert_eq!(status(cwd(&dir)).unwrap().unstaged[0].status, "U");
        abort_in_progress(cwd(&dir), "merge").unwrap();
        assert_eq!(repo_info(cwd(&dir)).unwrap().in_progress, None);
        // A clean merge works.
        create_branch(cwd(&dir), "c", None, true).unwrap();
        write(&dir, "c", "c\n");
        stage_all(cwd(&dir)).unwrap();
        commit(cwd(&dir), "c", false).unwrap();
        checkout(cwd(&dir), "main", None).unwrap();
        merge(cwd(&dir), "c").unwrap();
        assert!(dir.path().join("c").exists());
    }

    #[test]
    fn remotes_add_and_remove() {
        let dir = temp_repo();
        add_remote(cwd(&dir), "upstream", "https://example.invalid/u.git").unwrap();
        assert_eq!(refs(cwd(&dir)).unwrap().remotes[0].url, "https://example.invalid/u.git");
        remove_remote(cwd(&dir), "upstream").unwrap();
        assert!(refs(cwd(&dir)).unwrap().remotes.is_empty());
    }

    #[test]
    fn stash_push_files_apply_pop_drop() {
        let dir = temp_repo();
        write(&dir, "f.txt", "changed\n");
        write(&dir, "u.txt", "u\n");
        stash_push(cwd(&dir), "wip", true).unwrap();
        assert_eq!(status(cwd(&dir)).unwrap(), StatusResult::default());
        let files = stash_files(cwd(&dir), 0).unwrap();
        let mut names: Vec<_> = files.iter().map(|f| f.path.clone()).collect();
        names.sort();
        assert_eq!(names, vec!["f.txt", "u.txt"]);
        stash_apply(cwd(&dir), 0).unwrap();
        assert_eq!(status(cwd(&dir)).unwrap().unstaged.len(), 2);
        assert_eq!(refs(cwd(&dir)).unwrap().stashes.len(), 1);
        discard_files(cwd(&dir), &["f.txt".into()], &["u.txt".into()]).unwrap();
        stash_pop(cwd(&dir), 0).unwrap();
        assert!(refs(cwd(&dir)).unwrap().stashes.is_empty());
        stash_push(cwd(&dir), "", false).unwrap();
        stash_drop(cwd(&dir), 0).unwrap();
        assert!(refs(cwd(&dir)).unwrap().stashes.is_empty());
    }

    #[test]
    fn log_pages_over_all_branches_with_decorations() {
        let dir = temp_repo();
        create_branch(cwd(&dir), "side", None, true).unwrap();
        write(&dir, "s.txt", "s\n");
        stage_all(cwd(&dir)).unwrap();
        commit(cwd(&dir), "side work", false).unwrap();
        checkout(cwd(&dir), "main", None).unwrap();
        write(&dir, "m.txt", "m\n");
        stage_all(cwd(&dir)).unwrap();
        commit(cwd(&dir), "main work", false).unwrap();
        git(cwd(&dir), &["tag", "v1"]);
        merge(cwd(&dir), "side").unwrap();

        let page = log(cwd(&dir), true, 0, LOG_PAGE).unwrap();
        assert!(!page.has_more);
        assert_eq!(page.commits.len(), 4);
        let head = &page.commits[0];
        assert!(head.is_head && head.parents.len() == 2);
        assert!(head.refs.iter().any(|r| r.name == "main" && r.kind == "local"));
        assert!(page.commits.iter().any(|c| c.refs.iter().any(|r| r.name == "v1" && r.kind == "tag")));
        assert!(page.commits.iter().any(|c| c.refs.iter().any(|r| r.name == "side")));

        let first = log(cwd(&dir), true, 0, 2).unwrap();
        assert!(first.has_more && first.commits.len() == 2);
        let rest = log(cwd(&dir), true, 2, 2).unwrap();
        assert!(!rest.has_more && rest.commits.len() == 2);
        assert_eq!(rest.commits[1].subject, "base");

        let fresh = tempfile::tempdir().unwrap();
        git(cwd(&fresh), &["init", "-q", "-b", "main"]);
        assert!(log(cwd(&fresh), false, 0, 10).unwrap().commits.is_empty());
    }

    #[test]
    fn commit_detail_and_revision_diff_work_for_a_root_commit() {
        let dir = temp_repo();
        let root = git(cwd(&dir), &["rev-parse", "HEAD"]).trim().to_string();
        let d = commit_detail(cwd(&dir), &root).unwrap();
        assert_eq!(d.body, "base");
        assert_eq!(d.files.len(), 1);
        assert_eq!((d.files[0].path.as_str(), d.files[0].status.as_str()), ("f.txt", "A"));
        let diff = diff_at(cwd(&dir), "f.txt", None, false, false, Some(&root)).unwrap();
        assert_eq!(diff.hunks.len(), 1);
        assert_eq!(diff.hunks[0].lines.iter().filter(|l| l.kind == "add").count(), 5);
    }

    #[test]
    fn cherry_pick_conflict_revert_and_reset_modes() {
        let dir = temp_repo();
        create_branch(cwd(&dir), "b", None, true).unwrap();
        write(&dir, "f.txt", "B\n");
        stage_all(cwd(&dir)).unwrap();
        commit(cwd(&dir), "b", false).unwrap();
        let b_sha = git(cwd(&dir), &["rev-parse", "HEAD"]).trim().to_string();
        checkout(cwd(&dir), "main", None).unwrap();
        write(&dir, "f.txt", "A\n");
        stage_all(cwd(&dir)).unwrap();
        commit(cwd(&dir), "a", false).unwrap();
        let a_sha = git(cwd(&dir), &["rev-parse", "HEAD"]).trim().to_string();

        assert!(cherry_pick(cwd(&dir), &b_sha).is_err());
        assert_eq!(repo_info(cwd(&dir)).unwrap().in_progress.as_deref(), Some("cherry-pick"));
        abort_in_progress(cwd(&dir), "cherry-pick").unwrap();
        assert_eq!(repo_info(cwd(&dir)).unwrap().in_progress, None);

        revert(cwd(&dir), &a_sha).unwrap();
        assert_eq!(std::fs::read_to_string(dir.path().join("f.txt")).unwrap(), "alpha\nbeta\ngamma\ndelta\nepsilon\n");
        assert_eq!(log(cwd(&dir), false, 0, 10).unwrap().commits.len(), 3);

        // soft: index keeps the revert's change; mixed: worktree keeps it; hard: gone.
        reset(cwd(&dir), &a_sha, "soft").unwrap();
        assert_eq!(status(cwd(&dir)).unwrap().staged.len(), 1);
        reset(cwd(&dir), &a_sha, "mixed").unwrap();
        let s = status(cwd(&dir)).unwrap();
        assert!(s.staged.is_empty() && s.unstaged.len() == 1);
        reset(cwd(&dir), &a_sha, "hard").unwrap();
        assert_eq!(status(cwd(&dir)).unwrap(), StatusResult::default());
        checkout_commit(cwd(&dir), &b_sha).unwrap();
        assert!(repo_info(cwd(&dir)).unwrap().detached);
    }

    #[test]
    fn worktree_add_list_remove_prune_round_trip() {
        let dir = temp_repo();
        let name = dir.path().file_name().unwrap().to_string_lossy().to_string();
        let wt = dir.path().parent().unwrap().join(format!("{name}-feature"));
        let wt_s = wt.to_str().unwrap().to_string();
        worktree_add(cwd(&dir), &wt_s, "feature", None, true).unwrap();
        let r = refs(cwd(&dir)).unwrap();
        assert_eq!(r.worktrees.len(), 2);
        assert!(r.worktrees[0].is_main);
        assert_eq!(r.worktrees[1].branch.as_deref(), Some("feature"));
        assert_eq!(repo_info(&wt_s).unwrap().branch.as_deref(), Some("feature"));

        std::fs::write(wt.join("dirty.txt"), "x").unwrap();
        let err = worktree_remove(cwd(&dir), &wt_s, false).unwrap_err();
        assert!(err.contains("modified or untracked"), "{err}");
        worktree_remove(cwd(&dir), &wt_s, true).unwrap();
        assert_eq!(refs(cwd(&dir)).unwrap().worktrees.len(), 1);

        // Existing-branch mode, then prune after an external rm -rf.
        worktree_add(cwd(&dir), &wt_s, "feature", None, false).unwrap();
        std::fs::remove_dir_all(&wt).unwrap();
        assert!(refs(cwd(&dir)).unwrap().worktrees[1].prunable);
        worktree_prune(cwd(&dir)).unwrap();
        assert_eq!(refs(cwd(&dir)).unwrap().worktrees.len(), 1);
    }

    /// The sweep's first disqualifier. The listing has to survive both
    /// decorations git puts in front of a branch name — `*` for the
    /// current one, `+` for one checked out in another worktree — which
    /// is exactly the case a sweep runs into.
    #[test]
    fn merged_branches_lists_landed_work_including_checked_out_ones() {
        let dir = temp_repo();
        let base = repo_info(cwd(&dir)).unwrap().branch.unwrap();

        create_branch(cwd(&dir), "landed", None, false).unwrap();
        create_branch(cwd(&dir), "ahead", None, true).unwrap();
        std::fs::write(dir.path().join("new.txt"), "x").unwrap();
        stage_files(cwd(&dir), &["new.txt".into()]).unwrap();
        commit(cwd(&dir), "work", false).unwrap();
        checkout(cwd(&dir), &base, None).unwrap();

        let name = dir.path().file_name().unwrap().to_string_lossy().to_string();
        let wt = dir.path().parent().unwrap().join(format!("{name}-landed"));
        let wt_s = wt.to_str().unwrap().to_string();
        worktree_add(cwd(&dir), &wt_s, "landed", None, false).unwrap();

        let merged = merged_branches(cwd(&dir), &base).unwrap();
        // `landed` is checked out in the linked worktree, so git decorates
        // it with "+ " in the undecorated listing.
        assert!(merged.contains(&"landed".to_string()), "{merged:?}");
        assert!(merged.contains(&base), "{merged:?}");
        assert!(!merged.contains(&"ahead".to_string()), "{merged:?}");

        worktree_remove(cwd(&dir), &wt_s, true).unwrap();
    }
}
