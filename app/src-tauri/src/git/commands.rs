//! Tauri commands for the Git tab (spec §2). Each `#[tauri::command]` is a
//! thin wrapper over a plain function so the temp-repo tests below call the
//! real code path without a Tauri runtime.

use crate::git::parse::{parse_diff, parse_status};
use crate::git::run::{ok, run_git, run_git_ro};
use crate::git::types::{Author, FileDiff, RepoInfo, StatusResult};
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
    fn diff_of_a_staged_rename_uses_both_paths() {
        let dir = temp_repo();
        git(cwd(&dir), &["mv", "f.txt", "g.txt"]);
        let d = diff(cwd(&dir), "g.txt", Some("f.txt"), true, false).unwrap();
        assert_eq!(d.old_path.as_deref(), Some("f.txt"));
        assert!(d.hunks.is_empty(), "a pure rename has no hunks");
    }
}
