//! Tauri commands for the Git tab (spec §2). Each `#[tauri::command]` is a
//! thin wrapper over a plain function so the temp-repo tests below call the
//! real code path without a Tauri runtime.

use crate::git::parse::{parse_branches, parse_diff, parse_remotes, parse_stashes, parse_status};
use crate::git::run::{ok, run_git, run_git_ro};
use crate::git::types::{Author, FileDiff, RefsSnapshot, RepoInfo, StatusResult};
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
        worktrees: vec![],
        head_branch,
    })
}

#[tauri::command]
pub fn git_refs(cwd: String) -> Result<RefsSnapshot, String> {
    refs(&cwd)
}

pub fn diff(cwd: &str, path: &str, old_path: Option<&str>, staged: bool, untracked: bool) -> Result<FileDiff, String> {
    let mut args: Vec<&str> = vec!["diff", "--no-color", "--no-ext-diff", "-U3"];
    if untracked {
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

#[tauri::command]
pub fn git_diff(cwd: String, path: String, old_path: Option<String>, staged: bool, untracked: bool) -> Result<FileDiff, String> {
    diff(&cwd, &path, old_path.as_deref(), staged, untracked)
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
        assert!(r.worktrees.is_empty());
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
