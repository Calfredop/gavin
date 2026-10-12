//! Compare two refs: the changed-file list, the counts, and one file's
//! diff between them -- the Git tab's Compare view.
//!
//! Three-dot is the default question -- "what would merging <target>
//! into <base> change", the diff GitHub's compare page shows -- answered
//! as the diff from the two refs' merge-base to the target. Two-dot is
//! the plain tree difference between the tips. The ahead/behind counts
//! are reported either way: how far the refs have diverged does not
//! depend on which diff is on screen.
//!
//! Refs arrive as plain revs -- a sha, a branch, `origin/foo`, HEAD --
//! and are handed to git untouched. Resolving a worktree's checkout to
//! its branch is the frontend's job, and a remote-tracking branch
//! compares against whatever the last fetch left locally; nothing here
//! fetches.

use serde::{Deserialize, Serialize};

use crate::git::commands::MAX_DIFF_BYTES;
use crate::git::parse::{parse_diff, parse_name_status};
use crate::git::run::{off_main_thread, ok, run_git_ro, run_git_ro_capped};
use crate::git::runchanges::parse_shortstat;
use crate::git::types::{FileDiff, FileEntry};

/// Everything the Compare view renders for one pair of refs.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CompareSummary {
    pub files: Vec<FileEntry>,
    pub insertions: u32,
    pub deletions: u32,
    pub files_changed: u32,
    /// Commits on target that base does not have (`base..target`).
    pub commits_ahead: u32,
    /// Commits on base that target does not have (`target..base`).
    pub commits_behind: u32,
    /// The commit the three-dot diff ran from. None in two-dot mode, and
    /// None when the refs share no history -- where the three-dot
    /// question falls back to the two-dot answer, the only one there is.
    pub merge_base: Option<String>,
}

/// The merge-base of the two refs, or None when they share no history.
/// A rev that does not resolve at all is an error, not a None: the view
/// has to say "no such ref" rather than quietly diff the wrong pair.
fn merge_base(cwd: &str, base_ref: &str, target_ref: &str) -> Result<Option<String>, String> {
    let out = run_git_ro(cwd, &["merge-base", base_ref, target_ref])?;
    match out.code {
        0 => Ok(Some(out.stdout_str().trim().to_string())),
        1 => Ok(None),
        _ => Err(out.stderr.trim().to_string()),
    }
}

/// The rev the diff runs FROM: the merge-base in three-dot mode, the
/// base itself otherwise (and when there is no merge-base to run from).
fn diff_start(cwd: &str, base_ref: &str, target_ref: &str, three_dot: bool) -> Result<(String, Option<String>), String> {
    let base = if three_dot { merge_base(cwd, base_ref, target_ref)? } else { None };
    Ok((base.clone().unwrap_or_else(|| base_ref.to_string()), base))
}

fn rev_count(cwd: &str, range: &str) -> Result<u32, String> {
    Ok(ok(run_git_ro(cwd, &["rev-list", "--count", range])?)?.stdout_str().trim().parse().unwrap_or(0))
}

/// The changed-file list and the counts between `base_ref` and
/// `target_ref`. `-M` so a rename reads as one row, as in `run_changes`.
pub fn compare(cwd: &str, base_ref: &str, target_ref: &str, three_dot: bool) -> Result<CompareSummary, String> {
    let (start, base) = diff_start(cwd, base_ref, target_ref, three_dot)?;
    let mut out = CompareSummary { merge_base: base, ..Default::default() };

    let named = ok(run_git_ro(cwd, &["diff", "--name-status", "-M", &start, target_ref])?)?;
    out.files = parse_name_status(&named.stdout_str());
    out.files_changed = out.files.len() as u32;

    let shortstat = ok(run_git_ro(cwd, &["diff", "--shortstat", &start, target_ref])?)?;
    let (insertions, deletions) = parse_shortstat(&shortstat.stdout_str());
    out.insertions = insertions;
    out.deletions = deletions;

    out.commits_ahead = rev_count(cwd, &format!("{base_ref}..{target_ref}"))?;
    out.commits_behind = rev_count(cwd, &format!("{target_ref}..{base_ref}"))?;
    Ok(out)
}

/// One file's diff between the same endpoints `compare` listed it under.
/// The merge-base is resolved again rather than passed back: the pair
/// the human picked is the question, and a rebase between the two calls
/// moving that base moves the list and the diff together.
pub fn compare_diff(
    cwd: &str,
    base_ref: &str,
    target_ref: &str,
    path: &str,
    old_path: Option<&str>,
    three_dot: bool,
) -> Result<FileDiff, String> {
    let (start, _) = diff_start(cwd, base_ref, target_ref, three_dot)?;
    let mut args: Vec<&str> = vec!["diff", "--no-color", "--no-ext-diff", "-U3", "-M", &start, target_ref, "--"];
    if let Some(old) = old_path {
        args.push(old);
    }
    args.push(path);
    // Capped like `diff_since`: past MAX_DIFF_BYTES the answer is "too
    // large" whatever the rest says, so the rest is never held in memory.
    let out = run_git_ro_capped(cwd, &args, MAX_DIFF_BYTES)?;
    if out.code != 0 && out.code != 1 {
        return Err(out.stderr.trim().to_string());
    }
    let mut result = FileDiff { path: path.to_string(), old_path: old_path.map(str::to_string), binary: false, too_large: false, hunks: vec![] };
    if out.stdout.len() > MAX_DIFF_BYTES || out.wire_truncated {
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

/// `async` + `off_main_thread`, like the Git tab's own reads: one call
/// is several `git` processes, and the view asks again on every refresh
/// while it is open.
#[tauri::command]
pub async fn git_compare(cwd: String, base_ref: String, target_ref: String, three_dot: bool) -> Result<CompareSummary, String> {
    off_main_thread(move || compare(&cwd, &base_ref, &target_ref, three_dot)).await
}

/// `async` like `git_diff_since`: one file at a time, each a `git diff`
/// that can run long on a big file.
#[tauri::command]
pub async fn git_compare_diff(
    cwd: String,
    base_ref: String,
    target_ref: String,
    path: String,
    old_path: Option<String>,
    three_dot: bool,
) -> Result<FileDiff, String> {
    off_main_thread(move || compare_diff(&cwd, &base_ref, &target_ref, &path, old_path.as_deref(), three_dot)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::commands::testutil::{cwd, git, temp_repo, write};

    /// main -- base commit, then one commit on each of main and feature,
    /// so the two-dot and three-dot questions have different answers.
    fn diverged(dir: &tempfile::TempDir) {
        git(cwd(dir), &["checkout", "-q", "-b", "feature"]);
        write(dir, "f.txt", "alpha\nBETA\ngamma\ndelta\nepsilon\n");
        write(dir, "new.txt", "one\ntwo\n");
        git(cwd(dir), &["add", "-A"]);
        git(cwd(dir), &["commit", "-qm", "feature work"]);
        git(cwd(dir), &["checkout", "-q", "main"]);
        write(dir, "other.txt", "main only\n");
        git(cwd(dir), &["add", "-A"]);
        git(cwd(dir), &["commit", "-qm", "main work"]);
    }

    /// The three-dot diff shows what TARGET changed since the fork: the
    /// commit main made afterwards is not part of it, where the two-dot
    /// diff -- the plain difference between the tips -- shows main's
    /// file as deleted.
    #[test]
    fn three_dot_excludes_the_base_sides_own_commits() {
        let dir = temp_repo();
        diverged(&dir);

        let three = compare(cwd(&dir), "main", "feature", true).unwrap();
        assert_eq!(
            three.files.iter().map(|f| (f.path.as_str(), f.status.as_str())).collect::<Vec<_>>(),
            vec![("f.txt", "M"), ("new.txt", "A")]
        );
        assert_eq!(three.files_changed, 2);
        // BETA for beta, and new.txt's two lines.
        assert_eq!((three.insertions, three.deletions), (3, 1));
        assert_eq!(
            three.merge_base.as_deref(),
            Some(git(cwd(&dir), &["rev-parse", "main~1"]).trim()),
            "the fork commit is where the diff runs from"
        );

        let two = compare(cwd(&dir), "main", "feature", false).unwrap();
        assert_eq!(
            two.files.iter().map(|f| (f.path.as_str(), f.status.as_str())).collect::<Vec<_>>(),
            vec![("f.txt", "M"), ("new.txt", "A"), ("other.txt", "D")]
        );
        assert_eq!(two.merge_base, None);
    }

    /// The divergence counts do not depend on the diff mode: feature has
    /// one commit main lacks, and main has one feature lacks.
    #[test]
    fn ahead_and_behind_count_both_directions() {
        let dir = temp_repo();
        diverged(&dir);

        let summary = compare(cwd(&dir), "main", "feature", true).unwrap();
        assert_eq!((summary.commits_ahead, summary.commits_behind), (1, 1));

        let fast_forward = compare(cwd(&dir), "main~1", "main", false).unwrap();
        assert_eq!((fast_forward.commits_ahead, fast_forward.commits_behind), (1, 0));
    }

    /// `-M`, the same flag the Changes views pass: a rename is one R row
    /// carrying its old path, not a delete plus an add.
    #[test]
    fn a_rename_is_detected() {
        let dir = temp_repo();
        git(cwd(&dir), &["checkout", "-q", "-b", "feature"]);
        git(cwd(&dir), &["mv", "f.txt", "renamed.txt"]);
        git(cwd(&dir), &["commit", "-qm", "rename"]);

        let summary = compare(cwd(&dir), "main", "feature", false).unwrap();
        assert_eq!(summary.files.len(), 1);
        let entry = &summary.files[0];
        assert_eq!((entry.path.as_str(), entry.old_path.as_deref(), entry.status.as_str()), ("renamed.txt", Some("f.txt"), "R"));

        let diff = compare_diff(cwd(&dir), "main", "feature", "renamed.txt", Some("f.txt"), false).unwrap();
        assert_eq!(diff.old_path.as_deref(), Some("f.txt"));
    }

    /// A file's diff runs between the same endpoints the list was
    /// produced under, so a row's hunks are the ones its badge counted.
    #[test]
    fn a_files_diff_shows_the_targets_hunks() {
        let dir = temp_repo();
        diverged(&dir);

        let diff = compare_diff(cwd(&dir), "main", "feature", "f.txt", None, true).unwrap();
        let added: Vec<&str> =
            diff.hunks.iter().flat_map(|h| h.lines.iter()).filter(|l| l.kind == "add").map(|l| l.text.as_str()).collect();
        assert_eq!(added, vec!["BETA"]);
        let removed: Vec<&str> =
            diff.hunks.iter().flat_map(|h| h.lines.iter()).filter(|l| l.kind == "del").map(|l| l.text.as_str()).collect();
        assert_eq!(removed, vec!["beta"]);
    }

    #[test]
    fn a_binary_file_is_flagged() {
        let dir = temp_repo();
        git(cwd(&dir), &["checkout", "-q", "-b", "feature"]);
        std::fs::write(dir.path().join("bin.dat"), [0u8, 1, 2, 0, 3, 4]).unwrap();
        git(cwd(&dir), &["add", "-A"]);
        git(cwd(&dir), &["commit", "-qm", "binary"]);

        let diff = compare_diff(cwd(&dir), "main", "feature", "bin.dat", None, false).unwrap();
        assert!(diff.binary);
        assert!(diff.hunks.is_empty());
    }

    /// Refs that share no history have no merge-base to diff from. The
    /// three-dot question then falls back to the two-dot answer -- the
    /// whole difference between the trees -- rather than to an error, and
    /// says so with a null merge base.
    #[test]
    fn unrelated_histories_fall_back_to_two_dot() {
        let dir = temp_repo();
        git(cwd(&dir), &["checkout", "-q", "--orphan", "unrelated"]);
        git(cwd(&dir), &["rm", "-q", "-rf", "."]);
        write(&dir, "standalone.txt", "no shared history\n");
        git(cwd(&dir), &["add", "-A"]);
        git(cwd(&dir), &["commit", "-qm", "orphan root"]);

        let summary = compare(cwd(&dir), "main", "unrelated", true).unwrap();
        assert_eq!(summary.merge_base, None);
        assert_eq!(
            summary.files.iter().map(|f| (f.path.as_str(), f.status.as_str())).collect::<Vec<_>>(),
            vec![("f.txt", "D"), ("standalone.txt", "A")]
        );
    }

    /// A rev that does not resolve is an error with git's own words, not
    /// an empty list -- an empty list is what "no differences" looks
    /// like, and the two must never be confused.
    #[test]
    fn an_unknown_ref_is_an_error() {
        let dir = temp_repo();
        let err = compare(cwd(&dir), "main", "no-such-branch", false).unwrap_err();
        assert!(!err.is_empty());
    }
}
