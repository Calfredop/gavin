//! Tauri commands for the Git tab (spec §2). Each `#[tauri::command]` is a
//! thin wrapper over a plain function so the temp-repo tests below call the
//! real code path without a Tauri runtime.

use crate::git::ops::{GitOps, RunningOp};
use crate::git::parse::{parse_branches, parse_diff, parse_log, parse_name_status, parse_remotes, parse_stashes, parse_status, parse_worktree_list};
use crate::git::run::{off_main_thread, ok, read_repo_file, run_git, run_git_action, run_git_ro, run_git_ro_capped, write_repo_file, OpControl};
use crate::git::types::{Author, CommitDetail, FileDiff, LogPage, RefsSnapshot, RepoInfo, StatusResult, WorktreeInfo};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, State};

/// Diffs larger than this are not rendered (spec §1: "Diff too large").
pub const MAX_DIFF_BYTES: usize = 2 * 1024 * 1024;

/// `user.name` and `user.email` in one read. `-z` so a value is taken
/// whole; a key set at several levels is listed once per level, and the
/// last one wins, which is how `git config --get` resolves it too.
fn author(cwd: &str) -> Result<Option<Author>, String> {
    let out = run_git_ro(cwd, &["config", "-z", "--get-regexp", r"^user\.(name|email)$"])?;
    // Exit 1 = neither is set; anything else non-zero is a real error.
    match out.code {
        0 => {}
        1 => return Ok(None),
        _ => return Err(out.stderr.trim().to_string()),
    }
    let (mut name, mut email) = (None, None);
    for entry in out.stdout_str().split('\0') {
        let (key, value) = entry.split_once('\n').unwrap_or((entry, ""));
        let slot = match key {
            "user.name" => &mut name,
            "user.email" => &mut email,
            _ => continue,
        };
        *slot = Some(value.trim().to_string()).filter(|v| !v.is_empty());
    }
    Ok(name.zip(email).map(|(name, email)| Author { name, email }))
}

/// Five git processes (four on an unborn HEAD), down from eight: it runs
/// on every Git-view refresh, and over ssh each one is a round trip.
pub fn repo_info(cwd: &str) -> Result<RepoInfo, String> {
    let paths = run_git_ro(cwd, &["rev-parse", "--show-toplevel", "--absolute-git-dir"])?;
    let paths = if paths.code == 0 { paths.stdout_str() } else { String::new() };
    let mut lines = paths.lines();
    // Not a repository prints neither path; a git old enough to answer
    // `--show-toplevel` with nothing outside a work tree prints only one.
    let (Some(root), Some(git_dir)) = (lines.next(), lines.next()) else {
        return Ok(RepoInfo { not_a_repo: true, ..Default::default() });
    };
    let root = root.trim().to_string();
    // One read answers both whether HEAD is born and, when it is detached,
    // the name to show for it.
    let head = run_git_ro(cwd, &["rev-parse", "--verify", "-q", "--short", "HEAD"])?;
    let unborn = head.code != 0;
    let sym = run_git_ro(cwd, &["symbolic-ref", "--short", "-q", "HEAD"])?;
    let (branch, detached) = if sym.code == 0 {
        (Some(sym.stdout_str().trim().to_string()), false)
    } else if !unborn {
        (Some(head.stdout_str().trim().to_string()), true)
    } else {
        return Err("HEAD is neither a branch nor a commit".to_string());
    };
    let author = author(cwd)?;
    let head_message = if unborn {
        None
    } else {
        Some(ok(run_git_ro(cwd, &["log", "-1", "--format=%B"])?)?.stdout_str().trim_end().to_string())
    };
    let in_progress = in_progress_at(Path::new(git_dir.trim()));
    Ok(RepoInfo { not_a_repo: false, root: Some(root), branch, detached, unborn, author, head_message, in_progress })
}

/// The operation a repository is stopped in the middle of, from the state
/// files under its git dir: `repo_info`'s `in_progress`, and what the
/// conflict labels are named after.
pub fn in_progress_at(git_dir: &Path) -> Option<String> {
    if git_dir.join("MERGE_HEAD").exists() {
        Some("merge".to_string())
    } else if git_dir.join("rebase-merge").exists() || git_dir.join("rebase-apply").exists() {
        Some("rebase".to_string())
    } else if git_dir.join("CHERRY_PICK_HEAD").exists() {
        Some("cherry-pick".to_string())
    } else if git_dir.join("REVERT_HEAD").exists() {
        Some("revert".to_string())
    } else {
        None
    }
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

pub fn checkout_commit(cwd: &str, sha: &str, control: &OpControl) -> Result<(), String> {
    ok(run_git_action(cwd, &["switch", "--detach", sha], &[], None, control)?).map(|_| ())
}

pub fn cherry_pick(cwd: &str, sha: &str, control: &OpControl) -> Result<(), String> {
    ok(run_git_action(cwd, &["cherry-pick", sha], &[("GIT_EDITOR", "true")], None, control)?).map(|_| ())
}

pub fn revert(cwd: &str, sha: &str, control: &OpControl) -> Result<(), String> {
    ok(run_git_action(cwd, &["revert", "--no-edit", sha], &[], None, control)?).map(|_| ())
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

// The reads below -- `git_log`, `git_commit_detail`, `git_refs`,
// `git_repo_info`, `git_status`, `git_diff` -- are `async` and run on the
// blocking pool: a Git-view refresh chains them, and on the main thread
// they measured 6-7 s of frozen window a minute with one view open.
// Ordering is the caller's: each store write in gitState.ts checks its own
// token, and `refresh()` runs one pass at a time per view.
//
// So are the actions -- what the Git tab's buttons run. Each is its own
// git plus the refresh after it, 0.7-1.3 s a click with no hooks at all,
// and the ones that run hooks, sign, or check out through a filter wait
// on whatever those do. Those take the op bar's `op_id` and run through
// `run_git_action`: cancellable, with their stderr on the bar. Ordering
// is the caller's here too: `runWithReason` holds `busy` for the whole
// action and `runBlocker` refuses a second one, and the rail's branch
// switch runs inside its workspace's `ticking` guard.

#[tauri::command]
pub async fn git_log(cwd: String, all: bool, skip: usize, limit: usize) -> Result<LogPage, String> {
    off_main_thread(move || log(&cwd, all, skip, limit.clamp(1, 1000))).await
}

#[tauri::command]
pub async fn git_commit_detail(cwd: String, sha: String) -> Result<CommitDetail, String> {
    off_main_thread(move || commit_detail(&cwd, &sha)).await
}

#[tauri::command]
pub async fn git_checkout_commit(cwd: String, sha: String, op_id: Option<String>, app: AppHandle, ops: State<'_, GitOps>) -> Result<(), String> {
    let op = RunningOp::register(&ops, &app, op_id);
    off_main_thread(move || checkout_commit(&cwd, &sha, &op.control)).await
}

#[tauri::command]
pub async fn git_cherry_pick(cwd: String, sha: String, op_id: Option<String>, app: AppHandle, ops: State<'_, GitOps>) -> Result<(), String> {
    let op = RunningOp::register(&ops, &app, op_id);
    off_main_thread(move || cherry_pick(&cwd, &sha, &op.control)).await
}

#[tauri::command]
pub async fn git_revert(cwd: String, sha: String, op_id: Option<String>, app: AppHandle, ops: State<'_, GitOps>) -> Result<(), String> {
    let op = RunningOp::register(&ops, &app, op_id);
    off_main_thread(move || revert(&cwd, &sha, &op.control)).await
}

#[tauri::command]
pub async fn git_reset(cwd: String, sha: String, mode: String) -> Result<(), String> {
    off_main_thread(move || reset(&cwd, &sha, &mode)).await
}

#[tauri::command]
pub async fn git_continue_in_progress(cwd: String, kind: String, op_id: Option<String>, app: AppHandle, ops: State<'_, GitOps>) -> Result<(), String> {
    let op = RunningOp::register(&ops, &app, op_id);
    off_main_thread(move || continue_in_progress(&cwd, &kind, &op.control)).await
}

// ---- SP3: worktrees ---------------------------------------------------------

pub fn worktrees(cwd: &str) -> Result<Vec<WorktreeInfo>, String> {
    let out = ok(run_git_ro(cwd, &["worktree", "list", "--porcelain"])?)?;
    Ok(parse_worktree_list(&out.stdout_str()))
}

/// The folder inside a workspace every worktree gavin cuts lands in:
/// `WORKTREES_DIR` in app/src/lib/git/git.ts proposes it, and the
/// orchestrate skill cuts into it by hand.
pub const WORKTREES_DIR: &str = ".gavin-worktrees";

/// That folder's own `.gitignore`: everything, itself included.
const WORKTREES_GITIGNORE: &str =
    "# gavin's worktrees: each one is a checkout of its own, never content of this one.\n*\n";

/// The absolute `.gavin-worktrees` ancestor of `cwd/path`, when `path`
/// actually lands inside one -- `None` for a worktree the human cut
/// somewhere of their own choosing.
fn worktrees_dir(cwd: &str, path: &str) -> Option<PathBuf> {
    let target = Path::new(cwd).join(path);
    target.ancestors().skip(1).find(|a| a.file_name().is_some_and(|n| n == WORKTREES_DIR)).map(Path::to_path_buf)
}

/// Makes the `.gavin-worktrees` folder a worktree is about to land in
/// ignore itself, before git puts anything there.
///
/// Without it the checkout the folder sits in lists every worktree as
/// untracked, and a `git add .` there records one as an embedded
/// repository -- a gitlink the next commit hands to everyone. The ignore
/// lives INSIDE the folder: a line in the root `.gitignore` is a tracked
/// change on every branch that lacks it, and `.git/info/exclude` is
/// repository state that outlives the folder and that an agent cutting a
/// worktree by hand would have to go and find. The folder's own file
/// holds on every branch, at any depth -- a workspace opened below the
/// git root keeps its worktrees there -- and goes when the folder does.
///
/// A path under no `.gavin-worktrees` is left alone: the human typed a
/// folder of their own. An existing `.gitignore` is theirs as well and
/// is never rewritten. Read and written through the same routed helpers
/// as `ignore.rs`'s `.gitignore`: over ssh the folder is on the host, and
/// `run_git` is about to cut the worktree there.
fn prepare_worktrees_dir(cwd: &str, path: &str) -> Result<(), String> {
    let Some(dir) = worktrees_dir(cwd, path) else {
        return Ok(());
    };
    let ignore = dir.join(".gitignore");
    if read_repo_file(cwd, &ignore)?.is_some() {
        return Ok(());
    }
    write_repo_file(cwd, &ignore, WORKTREES_GITIGNORE)
}

/// `CLAUDE.md`, `CLAUDE.local.md` and `.claude/CLAUDE.md` in every
/// directory strictly above `worktree`, up to and including
/// `workspace_root`. Those are exactly the levels a worktree cut as a
/// SIBLING of the checkout never climbed through -- nesting it inside
/// `.gavin-worktrees` is what put them in Claude Code's memory walk
/// (code.claude.com/docs/en/memory.md, "How CLAUDE.md files load").
fn claude_md_excludes(worktree: &Path, workspace_root: &Path) -> Vec<String> {
    let mut excludes = Vec::new();
    let mut dir = worktree.parent();
    while let Some(d) = dir {
        excludes.push(d.join("CLAUDE.md"));
        excludes.push(d.join("CLAUDE.local.md"));
        excludes.push(d.join(".claude").join("CLAUDE.md"));
        if d == workspace_root {
            break;
        }
        dir = d.parent();
    }
    excludes.into_iter().map(|p| p.to_string_lossy().into_owned()).collect()
}

/// Writes `claudeMdExcludes` into the new worktree's own
/// `.claude/settings.local.json`, so a Claude Code agent there loads
/// exactly what it loaded back when worktrees were siblings of the
/// checkout: its own `CLAUDE.md`, and nothing this nesting exposed.
///
/// Does nothing -- rather than risk a wrong file -- unless every guard
/// holds: the worktree's checked-out branch tracks its own `CLAUDE.md`
/// (otherwise the parent's copy is the only one the agent would get, and
/// excluding it is a regression, not a fix); `settings.local.json` does
/// not already exist with the key set (an existing file is merged into,
/// never overwritten, and a file that fails to parse as a JSON object is
/// left alone); and `.claude/settings.local.json` itself would be
/// git-ignored here, so writing it does not dirty the worktree
/// `worktree_add` just cut.
fn write_claude_md_excludes(worktree: &Path, workspace_root: &Path) {
    let worktree_cwd = worktree.to_string_lossy().into_owned();
    let git_ok = |args: &[&str]| run_git_ro(&worktree_cwd, args).map(|o| o.code == 0).unwrap_or(false);

    if !git_ok(&["ls-files", "--error-unmatch", "--", "CLAUDE.md"]) {
        return;
    }
    if !git_ok(&["check-ignore", "-q", "--", ".claude/settings.local.json"]) {
        return;
    }

    let settings_path = worktree.join(".claude").join("settings.local.json");
    let Ok(existing) = read_repo_file(&worktree_cwd, &settings_path) else { return };
    let mut doc: serde_json::Value = match &existing {
        None => serde_json::json!({}),
        Some(bytes) => {
            let Ok(text) = std::str::from_utf8(bytes) else { return };
            let Ok(parsed) = serde_json::from_str(text) else { return };
            parsed
        }
    };
    let Some(obj) = doc.as_object_mut() else { return };
    if obj.contains_key("claudeMdExcludes") {
        return;
    }
    obj.insert("claudeMdExcludes".to_string(), serde_json::json!(claude_md_excludes(worktree, workspace_root)));
    let Ok(text) = serde_json::to_string_pretty(&doc) else { return };
    let _ = write_repo_file(&worktree_cwd, &settings_path, &format!("{text}\n"));
}

/// `new_branch`: `worktree add -b <branch> <path> [<from>]`; otherwise
/// `worktree add <path> <branch>` for an existing branch.
///
/// An action rather than a plain run: it checks the whole tree out,
/// through the post-checkout hook and any LFS smudge, so it gets the op
/// ceiling and `control` can stop it. A stop is a TERM, and git answers
/// one during the checkout by deleting the half-made folder and its
/// registration. A stop in the post-checkout hook leaves a whole
/// worktree, which is git's own rule: a failed hook deletes nothing.
pub fn worktree_add(cwd: &str, path: &str, branch: &str, from: Option<&str>, new_branch: bool, control: &OpControl) -> Result<(), String> {
    prepare_worktrees_dir(cwd, path)?;
    let mut args = vec!["worktree", "add"];
    if new_branch {
        args.extend(["-b", branch, "--", path]);
        if let Some(f) = from {
            args.push(f);
        }
    } else {
        args.extend(["--", path, branch]);
    }
    ok(run_git_action(cwd, &args, &[], None, control)?)?;
    if let Some(dir) = worktrees_dir(cwd, path) {
        if let Some(workspace_root) = dir.parent() {
            write_claude_md_excludes(&Path::new(cwd).join(path), workspace_root);
        }
    }
    Ok(())
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
///
/// The removal deletes build output too: gavin's own worktrees hold 30k
/// files and 4-6.6 GB each, 2.7 s to unlink on this Mac and more on a
/// busy disk. So it gets the op ceiling rather than GIT_TIMEOUT, and no
/// cancel. Git has no cleanup for a remove stopped part-way, and one
/// leaves the folder half deleted and still registered.
pub fn worktree_remove(cwd: &str, path: &str, force: bool) -> Result<(), String> {
    let mut args = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    args.push(path);
    ok(run_git_action(cwd, &args, &[], None, &OpControl::default())?)?;
    crate::memory::forget_root(path);
    Ok(())
}

pub fn worktree_prune(cwd: &str) -> Result<(), String> {
    ok(run_git(cwd, &["worktree", "prune"], None)?).map(|_| ())
}

// Adding and removing are `async` on the blocking pool as well: a
// checkout of the whole tree, or a delete of one. Best-of-N adds its
// candidates one after another, and a sweep or a discard removes its
// worktrees one after another. Ordering is the caller's again: each
// batch awaits one git before starting the next, under `busy`.

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn git_worktree_add(
    cwd: String,
    path: String,
    branch: String,
    from: Option<String>,
    new_branch: bool,
    op_id: Option<String>,
    app: AppHandle,
    ops: State<'_, GitOps>,
) -> Result<(), String> {
    let op = RunningOp::register(&ops, &app, op_id);
    off_main_thread(move || worktree_add(&cwd, &path, &branch, from.as_deref(), new_branch, &op.control)).await
}

#[tauri::command]
pub async fn git_worktree_remove(cwd: String, path: String, force: bool) -> Result<(), String> {
    off_main_thread(move || worktree_remove(&cwd, &path, force)).await
}

#[tauri::command]
pub async fn git_worktree_prune(cwd: String) -> Result<(), String> {
    off_main_thread(move || worktree_prune(&cwd)).await
}

#[tauri::command]
pub async fn git_refs(cwd: String) -> Result<RefsSnapshot, String> {
    off_main_thread(move || refs(&cwd)).await
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
    // Capped: past MAX_DIFF_BYTES the answer is "too large" whatever the
    // rest says, so the rest is never held in memory.
    let out = run_git_ro_capped(cwd, &args, MAX_DIFF_BYTES)?;
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

pub fn commit(cwd: &str, message: &str, amend: bool, control: &OpControl) -> Result<(), String> {
    let mut args = vec!["commit", "-F", "-"];
    if amend {
        args.push("--amend");
    }
    ok(run_git_action(cwd, &args, &[], Some(message.as_bytes()), control)?).map(|_| ())
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
pub fn checkout(cwd: &str, name: &str, track_remote: Option<&str>, control: &OpControl) -> Result<(), String> {
    match track_remote {
        Some(remote) if !local_branch_exists(cwd, name)? => {
            let upstream = format!("{remote}/{name}");
            ok(run_git_action(cwd, &["switch", "-c", name, "--track", &upstream], &[], None, control)?).map(|_| ())
        }
        _ => ok(run_git_action(cwd, &["switch", "--", name], &[], None, control)?).map(|_| ()),
    }
}

pub fn create_branch(cwd: &str, name: &str, from: Option<&str>, checkout_after: bool, control: &OpControl) -> Result<(), String> {
    let mut args = vec!["branch", "--", name];
    if let Some(f) = from {
        args.push(f);
    }
    ok(run_git(cwd, &args, None)?)?;
    if checkout_after {
        checkout(cwd, name, None, control)?;
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
pub fn merge(cwd: &str, branch: &str, control: &OpControl) -> Result<(), String> {
    ok(run_git_action(cwd, &["merge", "--no-edit", "--", branch], &[], None, control)?).map(|_| ())
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
pub fn continue_in_progress(cwd: &str, kind: &str, control: &OpControl) -> Result<(), String> {
    let verb = match kind {
        "rebase" | "cherry-pick" | "revert" => kind,
        other => return Err(format!("cannot continue a {other}")),
    };
    ok(run_git_action(cwd, &[verb, "--continue"], &[("GIT_EDITOR", "true")], None, control)?).map(|_| ())
}

pub fn continue_rebase(cwd: &str, control: &OpControl) -> Result<(), String> {
    continue_in_progress(cwd, "rebase", control)
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
pub async fn git_checkout(cwd: String, name: String, track_remote: Option<String>, op_id: Option<String>, app: AppHandle, ops: State<'_, GitOps>) -> Result<(), String> {
    let op = RunningOp::register(&ops, &app, op_id);
    off_main_thread(move || checkout(&cwd, &name, track_remote.as_deref(), &op.control)).await
}

#[tauri::command]
pub async fn git_create_branch(cwd: String, name: String, from: Option<String>, checkout: bool, op_id: Option<String>, app: AppHandle, ops: State<'_, GitOps>) -> Result<(), String> {
    let op = RunningOp::register(&ops, &app, op_id);
    off_main_thread(move || create_branch(&cwd, &name, from.as_deref(), checkout, &op.control)).await
}

#[tauri::command]
pub async fn git_delete_branch(cwd: String, name: String, force: bool) -> Result<(), String> {
    off_main_thread(move || delete_branch(&cwd, &name, force)).await
}

#[tauri::command]
pub async fn git_merged_branches(cwd: String, base: String) -> Result<Vec<String>, String> {
    off_main_thread(move || merged_branches(&cwd, &base)).await
}

#[tauri::command]
pub async fn git_merge(cwd: String, branch: String, op_id: Option<String>, app: AppHandle, ops: State<'_, GitOps>) -> Result<(), String> {
    let op = RunningOp::register(&ops, &app, op_id);
    off_main_thread(move || merge(&cwd, &branch, &op.control)).await
}

#[tauri::command]
pub async fn git_abort_in_progress(cwd: String, kind: String) -> Result<(), String> {
    off_main_thread(move || abort_in_progress(&cwd, &kind)).await
}

#[tauri::command]
pub async fn git_continue_rebase(cwd: String, op_id: Option<String>, app: AppHandle, ops: State<'_, GitOps>) -> Result<(), String> {
    let op = RunningOp::register(&ops, &app, op_id);
    off_main_thread(move || continue_rebase(&cwd, &op.control)).await
}

#[tauri::command]
pub async fn git_add_remote(cwd: String, name: String, url: String) -> Result<(), String> {
    off_main_thread(move || add_remote(&cwd, &name, &url)).await
}

#[tauri::command]
pub async fn git_remove_remote(cwd: String, name: String) -> Result<(), String> {
    off_main_thread(move || remove_remote(&cwd, &name)).await
}

#[tauri::command]
pub async fn git_stash_push(cwd: String, message: String, include_untracked: bool) -> Result<(), String> {
    off_main_thread(move || stash_push(&cwd, &message, include_untracked)).await
}

#[tauri::command]
pub async fn git_stash_pop(cwd: String, index: u32) -> Result<(), String> {
    off_main_thread(move || stash_pop(&cwd, index)).await
}

#[tauri::command]
pub async fn git_stash_apply(cwd: String, index: u32) -> Result<(), String> {
    off_main_thread(move || stash_apply(&cwd, index)).await
}

#[tauri::command]
pub async fn git_stash_drop(cwd: String, index: u32) -> Result<(), String> {
    off_main_thread(move || stash_drop(&cwd, index)).await
}

#[tauri::command]
pub async fn git_stash_files(cwd: String, index: u32) -> Result<Vec<crate::git::types::FileEntry>, String> {
    off_main_thread(move || stash_files(&cwd, index)).await
}

#[tauri::command]
pub async fn git_stage_files(cwd: String, paths: Vec<String>) -> Result<(), String> {
    off_main_thread(move || stage_files(&cwd, &paths)).await
}

#[tauri::command]
pub async fn git_unstage_files(cwd: String, paths: Vec<String>) -> Result<(), String> {
    off_main_thread(move || unstage_files(&cwd, &paths)).await
}

#[tauri::command]
pub async fn git_stage_all(cwd: String) -> Result<(), String> {
    off_main_thread(move || stage_all(&cwd)).await
}

#[tauri::command]
pub async fn git_unstage_all(cwd: String) -> Result<(), String> {
    off_main_thread(move || unstage_all(&cwd)).await
}

#[tauri::command]
pub async fn git_apply_patch(cwd: String, patch: String, mode: String) -> Result<(), String> {
    off_main_thread(move || apply_patch(&cwd, &patch, &mode)).await
}

#[tauri::command]
pub async fn git_discard_files(cwd: String, tracked: Vec<String>, untracked: Vec<String>) -> Result<(), String> {
    off_main_thread(move || discard_files(&cwd, &tracked, &untracked)).await
}

#[tauri::command]
pub async fn git_commit(cwd: String, message: String, amend: bool, op_id: Option<String>, app: AppHandle, ops: State<'_, GitOps>) -> Result<(), String> {
    let op = RunningOp::register(&ops, &app, op_id);
    off_main_thread(move || commit(&cwd, &message, amend, &op.control)).await
}

#[tauri::command]
pub async fn git_init(cwd: String) -> Result<(), String> {
    off_main_thread(move || init(&cwd)).await
}

#[tauri::command]
pub async fn git_repo_info(cwd: String) -> Result<RepoInfo, String> {
    off_main_thread(move || repo_info(&cwd)).await
}

#[tauri::command]
pub async fn git_status(cwd: String) -> Result<StatusResult, String> {
    off_main_thread(move || status(&cwd)).await
}

/// The git half of what a reloaded frontend has to read back rather
/// than wait for a push to bring (see `git::baseline`). One answer per
/// cwd, in order, so the caller zips it onto the session ids the cwds
/// came from; `null` means "checked, not in a repo".
///
/// `async` + `spawn_blocking`, the first command here to be: this one
/// runs on the app's load path, where a `git status` over a large dirty
/// checkout must not hold the main thread through the first paint. Same
/// shape `git::ops` uses for its own long-running calls.
#[tauri::command]
pub async fn get_git_baselines(cwds: Vec<String>) -> Result<Vec<Option<protocol::GitStatus>>, String> {
    tauri::async_runtime::spawn_blocking(move || crate::git::baseline::git_baselines(&cwds))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn git_diff(cwd: String, path: String, old_path: Option<String>, staged: bool, untracked: bool, rev: Option<String>) -> Result<FileDiff, String> {
    off_main_thread(move || diff_at(&cwd, &path, old_path.as_deref(), staged, untracked, rev.as_deref())).await
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

    /// Both halves come from one `config --get-regexp`, so the rules
    /// `config --get` applied per key are this parser's job now. The
    /// repo's own config is listed last, which keeps these independent of
    /// whatever the machine's global config says.
    #[test]
    fn repo_info_author_takes_each_keys_last_value_and_needs_both() {
        let dir = temp_repo();
        git(cwd(&dir), &["config", "--add", "user.name", "Later Name"]);
        let info = repo_info(cwd(&dir)).unwrap();
        assert_eq!(info.author, Some(Author { name: "Later Name".into(), email: "t@example.com".into() }));

        git(cwd(&dir), &["config", "--add", "user.email", ""]);
        assert_eq!(repo_info(cwd(&dir)).unwrap().author, None, "an empty last email is no identity");
    }

    #[test]
    fn a_diff_past_the_cap_is_still_too_large_under_the_capped_read() {
        let dir = temp_repo();
        write(&dir, "big.txt", &"x".repeat(MAX_DIFF_BYTES + 1));
        let d = diff(cwd(&dir), "big.txt", None, false, true).unwrap();
        assert!(d.too_large);
        assert!(d.hunks.is_empty());
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
        commit(cwd(&dir), "feat: change\n\nbody line", false, &OpControl::default()).unwrap();
        assert_eq!(repo_info(cwd(&dir)).unwrap().head_message.as_deref(), Some("feat: change\n\nbody line"));
        assert_eq!(git(cwd(&dir), &["rev-list", "--count", "HEAD"]).trim(), "2");

        commit(cwd(&dir), "feat: amended", true, &OpControl::default()).unwrap();
        assert_eq!(repo_info(cwd(&dir)).unwrap().head_message.as_deref(), Some("feat: amended"));
        assert_eq!(git(cwd(&dir), &["rev-list", "--count", "HEAD"]).trim(), "2");
    }

    #[test]
    fn commit_with_nothing_staged_surfaces_gits_message() {
        let dir = temp_repo();
        let err = commit(cwd(&dir), "empty", false, &OpControl::default()).unwrap_err();
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
        create_branch(cwd(&dir), "feature", None, true, &OpControl::default()).unwrap();
        assert_eq!(repo_info(cwd(&dir)).unwrap().branch.as_deref(), Some("feature"));
        write(&dir, "x", "x\n");
        stage_all(cwd(&dir)).unwrap();
        commit(cwd(&dir), "x", false, &OpControl::default()).unwrap();
        checkout(cwd(&dir), "main", None, &OpControl::default()).unwrap();
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
        checkout(cwd(&clone), "topic", Some("origin"), &OpControl::default()).unwrap();
        let r = refs(cwd(&clone)).unwrap();
        assert_eq!(r.branches.iter().find(|b| b.name == "topic").unwrap().upstream.as_deref(), Some("origin/topic"));
        assert_eq!(r.head_branch.as_deref(), Some("topic"));
    }

    #[test]
    fn merge_conflict_sets_in_progress_and_abort_clears_it() {
        let dir = temp_repo();
        create_branch(cwd(&dir), "b", None, true, &OpControl::default()).unwrap();
        write(&dir, "f.txt", "B\n");
        stage_all(cwd(&dir)).unwrap();
        commit(cwd(&dir), "b", false, &OpControl::default()).unwrap();
        checkout(cwd(&dir), "main", None, &OpControl::default()).unwrap();
        write(&dir, "f.txt", "A\n");
        stage_all(cwd(&dir)).unwrap();
        commit(cwd(&dir), "a", false, &OpControl::default()).unwrap();
        assert!(merge(cwd(&dir), "b", &OpControl::default()).is_err());
        assert_eq!(repo_info(cwd(&dir)).unwrap().in_progress.as_deref(), Some("merge"));
        assert_eq!(status(cwd(&dir)).unwrap().unstaged[0].status, "U");
        abort_in_progress(cwd(&dir), "merge").unwrap();
        assert_eq!(repo_info(cwd(&dir)).unwrap().in_progress, None);
        // A clean merge works.
        create_branch(cwd(&dir), "c", None, true, &OpControl::default()).unwrap();
        write(&dir, "c", "c\n");
        stage_all(cwd(&dir)).unwrap();
        commit(cwd(&dir), "c", false, &OpControl::default()).unwrap();
        checkout(cwd(&dir), "main", None, &OpControl::default()).unwrap();
        merge(cwd(&dir), "c", &OpControl::default()).unwrap();
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
        create_branch(cwd(&dir), "side", None, true, &OpControl::default()).unwrap();
        write(&dir, "s.txt", "s\n");
        stage_all(cwd(&dir)).unwrap();
        commit(cwd(&dir), "side work", false, &OpControl::default()).unwrap();
        checkout(cwd(&dir), "main", None, &OpControl::default()).unwrap();
        write(&dir, "m.txt", "m\n");
        stage_all(cwd(&dir)).unwrap();
        commit(cwd(&dir), "main work", false, &OpControl::default()).unwrap();
        git(cwd(&dir), &["tag", "v1"]);
        merge(cwd(&dir), "side", &OpControl::default()).unwrap();

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
        create_branch(cwd(&dir), "b", None, true, &OpControl::default()).unwrap();
        write(&dir, "f.txt", "B\n");
        stage_all(cwd(&dir)).unwrap();
        commit(cwd(&dir), "b", false, &OpControl::default()).unwrap();
        let b_sha = git(cwd(&dir), &["rev-parse", "HEAD"]).trim().to_string();
        checkout(cwd(&dir), "main", None, &OpControl::default()).unwrap();
        write(&dir, "f.txt", "A\n");
        stage_all(cwd(&dir)).unwrap();
        commit(cwd(&dir), "a", false, &OpControl::default()).unwrap();
        let a_sha = git(cwd(&dir), &["rev-parse", "HEAD"]).trim().to_string();

        assert!(cherry_pick(cwd(&dir), &b_sha, &OpControl::default()).is_err());
        assert_eq!(repo_info(cwd(&dir)).unwrap().in_progress.as_deref(), Some("cherry-pick"));
        abort_in_progress(cwd(&dir), "cherry-pick").unwrap();
        assert_eq!(repo_info(cwd(&dir)).unwrap().in_progress, None);

        revert(cwd(&dir), &a_sha, &OpControl::default()).unwrap();
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
        checkout_commit(cwd(&dir), &b_sha, &OpControl::default()).unwrap();
        assert!(repo_info(cwd(&dir)).unwrap().detached);
    }

    #[test]
    fn worktree_add_list_remove_prune_round_trip() {
        let dir = temp_repo();
        let name = dir.path().file_name().unwrap().to_string_lossy().to_string();
        let wt = dir.path().parent().unwrap().join(format!("{name}-feature"));
        let wt_s = wt.to_str().unwrap().to_string();
        worktree_add(cwd(&dir), &wt_s, "feature", None, true, &OpControl::default()).unwrap();
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
        worktree_add(cwd(&dir), &wt_s, "feature", None, false, &OpControl::default()).unwrap();
        std::fs::remove_dir_all(&wt).unwrap();
        assert!(refs(cwd(&dir)).unwrap().worktrees[1].prunable);
        worktree_prune(cwd(&dir)).unwrap();
        assert_eq!(refs(cwd(&dir)).unwrap().worktrees.len(), 1);
        // A folder of the human's own choosing gets nothing written for it.
        assert!(!dir.path().join(WORKTREES_DIR).exists());
    }

    /// The folder the app forks into ignores itself: the checkout it sits
    /// in stays clean, and a `git add -A` there records no gitlink.
    #[test]
    fn a_worktree_in_gavin_worktrees_leaves_the_enclosing_checkout_clean() {
        let dir = temp_repo();
        let wt = dir.path().join(WORKTREES_DIR).join("feature");
        let wt_s = wt.to_str().unwrap().to_string();
        worktree_add(cwd(&dir), &wt_s, "feature", None, true, &OpControl::default()).unwrap();
        assert_eq!(repo_info(&wt_s).unwrap().branch.as_deref(), Some("feature"));

        assert_eq!(git(cwd(&dir), &["status", "--porcelain"]), "");
        git(cwd(&dir), &["add", "-A"]);
        assert_eq!(git(cwd(&dir), &["diff", "--cached", "--name-only"]), "");
        // Ignored, not merely unseen.
        let ignored = git(cwd(&dir), &["status", "--porcelain", "--ignored"]);
        assert!(ignored.contains(&format!("!! {WORKTREES_DIR}/")), "{ignored}");

        // The worktree is an ordinary checkout: its own status sees its files.
        std::fs::write(wt.join("new.txt"), "x").unwrap();
        assert!(git(&wt_s, &["status", "--porcelain"]).contains("?? new.txt"));
        worktree_remove(cwd(&dir), &wt_s, true).unwrap();
    }

    /// A workspace opened at a package folder keeps its worktrees there,
    /// below the git root -- where an anchored exclude would miss them.
    #[test]
    fn a_worktrees_folder_below_the_git_root_ignores_itself_too() {
        let dir = temp_repo();
        let pkg = dir.path().join("packages").join("foo");
        std::fs::create_dir_all(&pkg).unwrap();
        std::fs::write(pkg.join("a.txt"), "a").unwrap();
        git(cwd(&dir), &["add", "."]);
        git(cwd(&dir), &["commit", "-q", "-m", "pkg"]);

        let wt = pkg.join(WORKTREES_DIR).join("feature");
        worktree_add(cwd(&dir), wt.to_str().unwrap(), "feature", None, true, &OpControl::default()).unwrap();
        assert_eq!(git(cwd(&dir), &["status", "--porcelain"]), "");
    }

    #[test]
    fn an_existing_worktrees_gitignore_is_left_as_the_human_wrote_it() {
        let dir = temp_repo();
        let folder = dir.path().join(WORKTREES_DIR);
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join(".gitignore"), "*\n!notes.md\n").unwrap();
        worktree_add(cwd(&dir), folder.join("feature").to_str().unwrap(), "feature", None, true, &OpControl::default()).unwrap();
        assert_eq!(std::fs::read_to_string(folder.join(".gitignore")).unwrap(), "*\n!notes.md\n");
    }

    /// A tracked `CLAUDE.md` plus a repo rule that ignores
    /// `.claude/settings.local.json` (never relying on whatever the test
    /// machine's own global excludes happen to say) is the case the card
    /// asks this to fix: the new worktree gets its own excludes file, and
    /// nothing about cutting it shows up as a change anywhere.
    #[test]
    fn worktree_add_writes_claude_md_excludes_for_a_tracked_claude_md() {
        let dir = temp_repo();
        write(&dir, "CLAUDE.md", "root instructions\n");
        write(&dir, ".gitignore", ".claude/settings.local.json\n");
        git(cwd(&dir), &["add", "CLAUDE.md", ".gitignore"]);
        git(cwd(&dir), &["commit", "-q", "-m", "claude memory"]);

        let wt = dir.path().join(WORKTREES_DIR).join("feature");
        worktree_add(cwd(&dir), wt.to_str().unwrap(), "feature", None, true, &OpControl::default()).unwrap();

        let settings = std::fs::read_to_string(wt.join(".claude").join("settings.local.json")).unwrap();
        let json: serde_json::Value = serde_json::from_str(&settings).unwrap();
        let excludes: Vec<String> =
            json["claudeMdExcludes"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect();
        let root_claude_md = dir.path().join("CLAUDE.md").to_string_lossy().into_owned();
        let worktrees_dir_claude_md = dir.path().join(WORKTREES_DIR).join("CLAUDE.md").to_string_lossy().into_owned();
        assert!(excludes.contains(&root_claude_md), "{excludes:?}");
        assert!(excludes.contains(&worktrees_dir_claude_md), "{excludes:?}");
        // One directory strictly above the worktree (`.gavin-worktrees`
        // itself), and the workspace root it sits in -- three names each.
        assert_eq!(excludes.len(), 6, "{excludes:?}");

        // Its own status stays clean: the excludes file it just wrote is
        // gitignored there too.
        assert_eq!(git(wt.to_str().unwrap(), &["status", "--porcelain"]), "");
        // And cutting it never dirtied the checkout it came from.
        assert_eq!(git(cwd(&dir), &["status", "--porcelain"]), "");
    }

    /// The project's `CLAUDE.md` is untracked here -- the parent's copy is
    /// the only one the agent would otherwise get, so excluding it would
    /// be a regression, not a fix. No file is written at all.
    #[test]
    fn worktree_add_skips_claude_md_excludes_without_a_tracked_claude_md() {
        let dir = temp_repo();
        let wt = dir.path().join(WORKTREES_DIR).join("feature");
        worktree_add(cwd(&dir), wt.to_str().unwrap(), "feature", None, true, &OpControl::default()).unwrap();
        assert!(!wt.join(".claude").join("settings.local.json").exists());
    }

    /// `!.claude/settings.local.json` makes the path un-ignored regardless
    /// of whatever the running machine's own global excludes say --
    /// deterministic proof that the third guard (`check-ignore -q` must
    /// hold) actually stops the write, rather than the write happening to
    /// stay clean by luck of this machine's config.
    #[test]
    fn worktree_add_skips_claude_md_excludes_when_settings_local_json_is_not_ignored() {
        let dir = temp_repo();
        write(&dir, "CLAUDE.md", "root instructions\n");
        write(&dir, ".gitignore", "!.claude/settings.local.json\n");
        git(cwd(&dir), &["add", "CLAUDE.md", ".gitignore"]);
        git(cwd(&dir), &["commit", "-q", "-m", "claude memory"]);

        let wt = dir.path().join(WORKTREES_DIR).join("feature");
        worktree_add(cwd(&dir), wt.to_str().unwrap(), "feature", None, true, &OpControl::default()).unwrap();
        assert!(!wt.join(".claude").join("settings.local.json").exists());
    }

    /// The merge guard, exercised directly: an unrelated setting already
    /// in the file survives, and a file that already sets the key is left
    /// byte-for-byte alone rather than clobbered with gavin's own list.
    #[test]
    fn write_claude_md_excludes_merges_into_an_existing_file_but_never_touches_an_existing_key() {
        let dir = temp_repo();
        write(&dir, "CLAUDE.md", "root instructions\n");
        write(&dir, ".gitignore", ".claude/settings.local.json\n");
        git(cwd(&dir), &["add", "CLAUDE.md", ".gitignore"]);
        git(cwd(&dir), &["commit", "-q", "-m", "claude memory"]);

        let worktree = dir.path().to_path_buf();
        let workspace_root = worktree.parent().unwrap().to_path_buf();
        let settings_dir = worktree.join(".claude");
        let settings_file = settings_dir.join("settings.local.json");
        std::fs::create_dir_all(&settings_dir).unwrap();

        std::fs::write(&settings_file, "{\n  \"foo\": \"bar\"\n}\n").unwrap();
        write_claude_md_excludes(&worktree, &workspace_root);
        let merged: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&settings_file).unwrap()).unwrap();
        assert_eq!(merged["foo"], "bar");
        assert!(merged["claudeMdExcludes"].is_array());

        let already_set = "{\n  \"claudeMdExcludes\": [\"custom\"]\n}\n";
        std::fs::write(&settings_file, already_set).unwrap();
        write_claude_md_excludes(&worktree, &workspace_root);
        assert_eq!(std::fs::read_to_string(&settings_file).unwrap(), already_set);
    }

    /// Why an add is safe to put a Cancel on. A stop during the checkout,
    /// here stuck in a smudge filter the way an LFS download gets stuck,
    /// is a TERM. Git answers it by deleting the half-made folder and its
    /// registration. A SIGKILL would have left both: a folder holding
    /// some of the files, and a `worktree list` entry pointing at it.
    #[cfg(unix)]
    #[test]
    fn a_worktree_add_stopped_mid_checkout_leaves_nothing_behind() {
        use std::sync::atomic::Ordering;
        use std::time::{Duration, Instant};
        let dir = temp_repo();
        write(&dir, ".gitattributes", "f.txt filter=slow\n");
        git(cwd(&dir), &["add", ".gitattributes"]);
        git(cwd(&dir), &["commit", "-q", "-m", "slow filter"]);
        let started = dir.path().join("smudge-started");
        git(cwd(&dir), &["config", "filter.slow.smudge", &format!("touch '{}'; sleep 30", started.display())]);
        let outside = tempfile::tempdir().unwrap();
        let wt = outside.path().join("slow");
        let control = OpControl::default();
        let cancel = control.cancel.clone();
        let canceller = std::thread::spawn(move || {
            // Once the checkout is under way, not before.
            let t = Instant::now();
            while !started.exists() {
                assert!(t.elapsed() < Duration::from_secs(10), "the smudge filter never ran");
                std::thread::sleep(Duration::from_millis(20));
            }
            cancel.store(true, Ordering::Relaxed);
        });
        let err = worktree_add(cwd(&dir), wt.to_str().unwrap(), "slow", None, true, &control).unwrap_err();
        canceller.join().unwrap();
        assert_eq!(err, "cancelled");
        assert!(!wt.exists(), "the half-made worktree is still on disk");
        assert_eq!(refs(cwd(&dir)).unwrap().worktrees.len(), 1, "the half-made worktree is still registered");
    }

    /// The sweep's first disqualifier. The listing has to survive both
    /// decorations git puts in front of a branch name — `*` for the
    /// current one, `+` for one checked out in another worktree — which
    /// is exactly the case a sweep runs into.
    #[test]
    fn merged_branches_lists_landed_work_including_checked_out_ones() {
        let dir = temp_repo();
        let base = repo_info(cwd(&dir)).unwrap().branch.unwrap();

        create_branch(cwd(&dir), "landed", None, false, &OpControl::default()).unwrap();
        create_branch(cwd(&dir), "ahead", None, true, &OpControl::default()).unwrap();
        std::fs::write(dir.path().join("new.txt"), "x").unwrap();
        stage_files(cwd(&dir), &["new.txt".into()]).unwrap();
        commit(cwd(&dir), "work", false, &OpControl::default()).unwrap();
        checkout(cwd(&dir), &base, None, &OpControl::default()).unwrap();

        let name = dir.path().file_name().unwrap().to_string_lossy().to_string();
        let wt = dir.path().parent().unwrap().join(format!("{name}-landed"));
        let wt_s = wt.to_str().unwrap().to_string();
        worktree_add(cwd(&dir), &wt_s, "landed", None, false, &OpControl::default()).unwrap();

        let merged = merged_branches(cwd(&dir), &base).unwrap();
        // `landed` is checked out in the linked worktree, so git decorates
        // it with "+ " in the undecorated listing.
        assert!(merged.contains(&"landed".to_string()), "{merged:?}");
        assert!(merged.contains(&base), "{merged:?}");
        assert!(!merged.contains(&"ahead".to_string()), "{merged:?}");

        worktree_remove(cwd(&dir), &wt_s, true).unwrap();
    }
}
