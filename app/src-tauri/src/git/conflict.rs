//! Conflict resolution backend (spec docs/superpowers/specs/
//! 2026-08-21-git-tab-conflicts-design.md §2): one read that gathers the
//! index stages, the conflict kind, side labels and EOL style of a
//! conflicted path, plus writes that never mark a file resolved while
//! conflict markers remain.

use crate::git::commands::repo_info;
use crate::git::run::{ok, read_repo_file, run_git, run_git_ro};
use crate::git::types::{ConflictInfo, ConflictLabels};
use std::path::Path;

/// Git's own marker lines: seven `<` or `>` at the start of a line,
/// followed by a space or the end of the line. A bare `=======` is NOT
/// treated as a marker on its own (it is common in Markdown and tables).
pub fn has_markers(text: &str) -> bool {
    text.lines().any(|l| {
        let l = l.trim_end_matches('\r');
        (l.starts_with("<<<<<<<") || l.starts_with(">>>>>>>")) && (l.len() == 7 || l.as_bytes()[7] == b' ')
    })
}

/// ("lf" | "crlf", has final newline). CRLF wins when most breaks are CRLF.
pub fn detect_eol(text: &str) -> (&'static str, bool) {
    let crlf = text.matches("\r\n").count();
    let lf = text.matches('\n').count();
    let eol = if crlf > 0 && crlf * 2 >= lf { "crlf" } else { "lf" };
    (eol, text.ends_with('\n'))
}

struct Stage {
    mode: String,
    stage: u8,
}

fn stages(cwd: &str, path: &str) -> Result<Vec<Stage>, String> {
    let out = ok(run_git_ro(cwd, &["ls-files", "-u", "-z", "--", path])?)?;
    let text = out.stdout_str();
    Ok(text
        .split('\0')
        .filter(|r| !r.is_empty())
        .filter_map(|rec| {
            let (meta, _path) = rec.split_once('\t')?;
            let mut f = meta.split_whitespace();
            let mode = f.next()?.to_string();
            let _sha = f.next()?;
            let stage: u8 = f.next()?.parse().ok()?;
            Some(Stage { mode, stage })
        })
        .collect())
}

fn stage_bytes(cwd: &str, path: &str, n: u8) -> Result<Option<Vec<u8>>, String> {
    let spec = format!(":{n}:{path}");
    let out = run_git_ro(cwd, &["show", &spec])?;
    Ok(if out.code == 0 { Some(out.stdout) } else { None })
}

fn is_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8000).any(|b| *b == 0)
}

fn short_name(cwd: &str, rev: &str) -> String {
    let named = run_git_ro(cwd, &["name-rev", "--name-only", "--refs=refs/heads/*", "--refs=refs/remotes/*", rev]);
    if let Ok(out) = named {
        let name = out.stdout_str().trim().to_string();
        if out.code == 0 && !name.is_empty() && name != "undefined" {
            return name.trim_end_matches("^0").to_string();
        }
    }
    run_git_ro(cwd, &["rev-parse", "--short", rev]).map(|o| o.stdout_str().trim().to_string()).unwrap_or_else(|_| rev.to_string())
}

fn head_subject(cwd: &str, rev: &str) -> String {
    run_git_ro(cwd, &["log", "-1", "--format=%h %s", rev]).map(|o| o.stdout_str().trim().to_string()).unwrap_or_else(|_| rev.to_string())
}

fn labels(cwd: &str) -> Result<ConflictLabels, String> {
    let info = repo_info(cwd)?;
    let head_branch = match run_git_ro(cwd, &["symbolic-ref", "--short", "-q", "HEAD"])? {
        o if o.code == 0 => o.stdout_str().trim().to_string(),
        _ => "HEAD".to_string(),
    };
    let git_dir = ok(run_git_ro(cwd, &["rev-parse", "--absolute-git-dir"])?)?.stdout_str().trim().to_string();
    let git_dir = Path::new(&git_dir);
    let op = info.in_progress.as_deref().unwrap_or("");
    Ok(match op {
        "merge" => ConflictLabels { ours: head_branch, theirs: short_name(cwd, "MERGE_HEAD"), operation: "merge".into() },
        "rebase" => {
            // During a rebase git's "ours" is the upstream being rebased onto
            // and "theirs" is the branch being replayed; say so in the labels.
            //
            // These four reads are of the git dir git just named, which is
            // on whichever machine the repo is -- `read_repo_file` is what
            // makes that true for an ssh workspace. Each keeps its own
            // fallback, so a host that refuses one (a linked worktree
            // whose common git dir is outside the workspace root) gets a
            // generic label rather than a broken 3-pane.
            let state_file = |name: &str| -> Option<String> {
                read_repo_file(cwd, &git_dir.join(name))
                    .ok()
                    .flatten()
                    .map(|b| String::from_utf8_lossy(&b).into_owned())
            };
            let dir = if state_file("rebase-merge/head-name").is_some() { "rebase-merge" } else { "rebase-apply" };
            let head_name = state_file(&format!("{dir}/head-name"))
                .map(|s| s.trim().trim_start_matches("refs/heads/").to_string())
                .unwrap_or_else(|| "branch".into());
            let onto = state_file(&format!("{dir}/onto")).map(|s| s.trim().to_string());
            let upstream = onto.map(|o| short_name(cwd, &o)).unwrap_or_else(|| "upstream".into());
            ConflictLabels { ours: format!("{upstream} (upstream)"), theirs: format!("{head_name} (rebasing)"), operation: "rebase".into() }
        }
        "cherry-pick" => ConflictLabels { ours: head_branch, theirs: head_subject(cwd, "CHERRY_PICK_HEAD"), operation: "cherry-pick".into() },
        "revert" => ConflictLabels { ours: head_branch, theirs: format!("revert of {}", head_subject(cwd, "REVERT_HEAD")), operation: "revert".into() },
        _ => {
            let has_stash = run_git_ro(cwd, &["rev-parse", "-q", "--verify", "refs/stash"])?.code == 0;
            ConflictLabels {
                ours: head_branch,
                theirs: if has_stash { "stash".into() } else { "theirs".into() },
                operation: if has_stash { "stash".into() } else { "unknown".into() },
            }
        }
    })
}

pub fn conflict_info(cwd: &str, path: &str) -> Result<ConflictInfo, String> {
    let st = stages(cwd, path)?;
    if st.is_empty() {
        return Err(format!("{path} is not in a conflicted state"));
    }
    let has = |n: u8| st.iter().any(|s| s.stage == n);
    let submodule = st.iter().any(|s| s.mode == "160000");
    let raw = |n: u8| -> Result<Option<Vec<u8>>, String> { if has(n) && !submodule { stage_bytes(cwd, path, n) } else { Ok(None) } };
    let base_b = raw(1)?;
    let ours_b = raw(2)?;
    let theirs_b = raw(3)?;
    let binary = [&base_b, &ours_b, &theirs_b].iter().any(|b| b.as_ref().is_some_and(|v| is_binary(v)));

    let (kind, deleted_by) = if submodule {
        ("submodule", None)
    } else if !has(2) && !has(3) {
        ("deleteModify", Some("both".to_string()))
    } else if !has(2) {
        ("deleteModify", Some("ours".to_string()))
    } else if !has(3) {
        ("deleteModify", Some("theirs".to_string()))
    } else if binary {
        ("binary", None)
    } else if !has(1) {
        ("addedBoth", None)
    } else {
        ("text", None)
    };

    let to_text = |b: Option<Vec<u8>>| -> Option<String> { b.filter(|v| !is_binary(v)).map(|v| String::from_utf8_lossy(&v).into_owned()) };
    let base = to_text(base_b);
    let ours = to_text(ours_b);
    let theirs = to_text(theirs_b);
    // The worktree side is the one thing here git cannot hand over: it is
    // the file on disk, markers and all, and that disk is the host's for
    // an ssh workspace. A read the host refuses (binary, or outside the
    // root) lands as None, which is what a binary file already meant.
    let worktree = read_repo_file(cwd, &Path::new(cwd).join(path))
        .ok()
        .flatten()
        .and_then(|v| if is_binary(&v) { None } else { Some(String::from_utf8_lossy(&v).into_owned()) });
    let has_markers_now = worktree.as_deref().is_some_and(has_markers);
    let (eol, final_newline) = detect_eol(ours.as_deref().or(theirs.as_deref()).or(worktree.as_deref()).unwrap_or("\n"));

    Ok(ConflictInfo {
        path: path.to_string(),
        kind: kind.to_string(),
        base,
        ours,
        theirs,
        worktree,
        has_markers: has_markers_now,
        eol: eol.to_string(),
        final_newline,
        labels: labels(cwd)?,
        deleted_by,
    })
}

/// `git add` only when the file carries no conflict markers (the UI
/// mirrors this check; the backend enforces it).
pub fn mark_resolved(cwd: &str, path: &str) -> Result<(), String> {
    let full = Path::new(cwd).join(path);
    // On the machine the worktree is on. A read that fails leaves the
    // check unmade and the `add` proceeds -- which is what the local path
    // has always done with an unreadable file, and the right direction:
    // refusing to stage a file nobody could look at would strand the
    // resolution with no way out.
    if let Ok(Some(bytes)) = read_repo_file(cwd, &full) {
        if !is_binary(&bytes) && has_markers(&String::from_utf8_lossy(&bytes)) {
            return Err("conflict markers remain in the file".to_string());
        }
    }
    ok(run_git(cwd, &["add", "--", path], None)?).map(|_| ())
}

pub fn resolve_whole(cwd: &str, path: &str, side: &str) -> Result<(), String> {
    let flag = match side {
        "ours" => "--ours",
        "theirs" => "--theirs",
        other => return Err(format!("unknown side: {other}")),
    };
    ok(run_git(cwd, &["checkout", flag, "--", path], None)?)?;
    ok(run_git(cwd, &["add", "--", path], None)?).map(|_| ())
}

/// deleteModify: keep the surviving side's file, or delete it.
pub fn resolve_deleted(cwd: &str, path: &str, keep: bool) -> Result<(), String> {
    if !keep {
        return ok(run_git(cwd, &["rm", "-f", "-q", "--", path], None)?).map(|_| ());
    }
    let st = stages(cwd, path)?;
    let has = |n: u8| st.iter().any(|s| s.stage == n);
    let flag = if has(2) { "--ours" } else if has(3) { "--theirs" } else { return Err("both sides deleted the file".into()) };
    ok(run_git(cwd, &["checkout", flag, "--", path], None)?)?;
    ok(run_git(cwd, &["add", "--", path], None)?).map(|_| ())
}

/// Undo: recreate the conflict markers from the index stages.
pub fn restore_conflict(cwd: &str, path: &str) -> Result<(), String> {
    ok(run_git(cwd, &["checkout", "-m", "--", path], None)?).map(|_| ())
}

pub fn merge_tool_name(cwd: &str) -> Result<Option<String>, String> {
    let out = run_git_ro(cwd, &["config", "--get", "merge.tool"])?;
    Ok(if out.code == 0 { Some(out.stdout_str().trim().to_string()).filter(|s| !s.is_empty()) } else { None })
}

#[tauri::command]
pub fn git_conflict(cwd: String, path: String) -> Result<ConflictInfo, String> {
    conflict_info(&cwd, &path)
}

#[tauri::command]
pub fn git_mark_resolved(cwd: String, path: String) -> Result<(), String> {
    mark_resolved(&cwd, &path)
}

#[tauri::command]
pub fn git_resolve_whole(cwd: String, path: String, side: String) -> Result<(), String> {
    resolve_whole(&cwd, &path, &side)
}

#[tauri::command]
pub fn git_resolve_deleted(cwd: String, path: String, keep: bool) -> Result<(), String> {
    resolve_deleted(&cwd, &path, keep)
}

#[tauri::command]
pub fn git_restore_conflict(cwd: String, path: String) -> Result<(), String> {
    restore_conflict(&cwd, &path)
}

#[tauri::command]
pub fn git_merge_tool_name(cwd: String) -> Result<Option<String>, String> {
    merge_tool_name(&cwd)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::commands::testutil::*;
    use crate::git::commands::{checkout, create_branch, status};

    fn commit_all(dir: &tempfile::TempDir, msg: &str) {
        git(cwd(dir), &["add", "-A"]);
        git(cwd(dir), &["commit", "-q", "-m", msg]);
    }

    /// main and `feature` both edit line 2 of f.txt; merging conflicts.
    fn text_conflict() -> tempfile::TempDir {
        let dir = temp_repo();
        create_branch(cwd(&dir), "feature", None, true).unwrap();
        write(&dir, "f.txt", "alpha\nFEATURE\ngamma\ndelta\nepsilon\n");
        commit_all(&dir, "feature edit");
        checkout(cwd(&dir), "main", None).unwrap();
        write(&dir, "f.txt", "alpha\nMAIN\ngamma\ndelta\nepsilon\n");
        commit_all(&dir, "main edit");
        let _ = run_git(cwd(&dir), &["merge", "feature"], None).unwrap();
        dir
    }

    #[test]
    fn marker_detection_ignores_bare_equals_lines() {
        assert!(has_markers("a\n<<<<<<< HEAD\nb\n=======\nc\n>>>>>>> x\n"));
        assert!(has_markers("<<<<<<<\n"));
        assert!(!has_markers("Title\n=======\nbody\n"));
        assert!(!has_markers("<<<<<<<<NOTAMARKER\n"));
    }

    #[test]
    fn eol_detection() {
        assert_eq!(detect_eol("a\r\nb\r\n"), ("crlf", true));
        assert_eq!(detect_eol("a\nb"), ("lf", false));
        assert_eq!(detect_eol("a\r\nb\nc\n"), ("lf", true)); // minority CRLF loses
        assert_eq!(detect_eol("a\r\nb\r\nc\n"), ("crlf", true));
    }

    #[test]
    fn text_conflict_reports_stages_labels_and_markers() {
        let dir = text_conflict();
        assert_eq!(status(cwd(&dir)).unwrap().unstaged[0].status, "U");
        let c = conflict_info(cwd(&dir), "f.txt").unwrap();
        assert_eq!(c.kind, "text");
        assert!(c.has_markers);
        assert_eq!(c.base.as_deref(), Some("alpha\nbeta\ngamma\ndelta\nepsilon\n"));
        assert!(c.ours.as_deref().unwrap().contains("MAIN"));
        assert!(c.theirs.as_deref().unwrap().contains("FEATURE"));
        assert_eq!((c.labels.ours.as_str(), c.labels.theirs.as_str(), c.labels.operation.as_str()), ("main", "feature", "merge"));
        assert_eq!((c.eol.as_str(), c.final_newline), ("lf", true));
    }

    #[test]
    fn mark_resolved_refuses_markers_then_accepts_a_clean_file_and_restore_brings_them_back() {
        let dir = text_conflict();
        let err = mark_resolved(cwd(&dir), "f.txt").unwrap_err();
        assert!(err.contains("markers remain"));
        write(&dir, "f.txt", "alpha\nBOTH\ngamma\ndelta\nepsilon\n");
        mark_resolved(cwd(&dir), "f.txt").unwrap();
        assert!(status(cwd(&dir)).unwrap().unstaged.is_empty());
        assert_eq!(status(cwd(&dir)).unwrap().staged[0].status, "M");
        restore_conflict(cwd(&dir), "f.txt").unwrap();
        let c = conflict_info(cwd(&dir), "f.txt").unwrap();
        assert!(c.has_markers && c.kind == "text");
    }

    #[test]
    fn resolve_whole_takes_a_side() {
        let dir = text_conflict();
        resolve_whole(cwd(&dir), "f.txt", "theirs").unwrap();
        assert_eq!(std::fs::read_to_string(dir.path().join("f.txt")).unwrap(), "alpha\nFEATURE\ngamma\ndelta\nepsilon\n");
        assert!(status(cwd(&dir)).unwrap().unstaged.is_empty());
    }

    #[test]
    fn rebase_labels_are_swapped_and_explicit() {
        let dir = temp_repo();
        create_branch(cwd(&dir), "feature", None, true).unwrap();
        write(&dir, "f.txt", "alpha\nFEATURE\ngamma\ndelta\nepsilon\n");
        commit_all(&dir, "feature edit");
        checkout(cwd(&dir), "main", None).unwrap();
        write(&dir, "f.txt", "alpha\nMAIN\ngamma\ndelta\nepsilon\n");
        commit_all(&dir, "main edit");
        checkout(cwd(&dir), "feature", None).unwrap();
        let _ = run_git(cwd(&dir), &["rebase", "main"], None).unwrap();
        let c = conflict_info(cwd(&dir), "f.txt").unwrap();
        assert_eq!(c.labels.operation, "rebase");
        assert_eq!(c.labels.ours, "main (upstream)");
        assert_eq!(c.labels.theirs, "feature (rebasing)");
        assert!(c.ours.as_deref().unwrap().contains("MAIN"));
        let _ = run_git(cwd(&dir), &["rebase", "--abort"], None).unwrap();
    }

    #[test]
    fn cherry_pick_label_names_the_commit() {
        let dir = temp_repo();
        create_branch(cwd(&dir), "feature", None, true).unwrap();
        write(&dir, "f.txt", "alpha\nFEATURE\ngamma\ndelta\nepsilon\n");
        commit_all(&dir, "feature edit");
        let sha = git(cwd(&dir), &["rev-parse", "--short", "HEAD"]).trim().to_string();
        checkout(cwd(&dir), "main", None).unwrap();
        write(&dir, "f.txt", "alpha\nMAIN\ngamma\ndelta\nepsilon\n");
        commit_all(&dir, "main edit");
        let _ = run_git(cwd(&dir), &["cherry-pick", &sha], None).unwrap();
        let c = conflict_info(cwd(&dir), "f.txt").unwrap();
        assert_eq!(c.labels.operation, "cherry-pick");
        assert_eq!(c.labels.theirs, format!("{sha} feature edit"));
    }

    #[test]
    fn delete_modify_in_both_directions_and_keep_or_delete() {
        // They deleted, we modified.
        let dir = temp_repo();
        create_branch(cwd(&dir), "feature", None, true).unwrap();
        git(cwd(&dir), &["rm", "-q", "f.txt"]);
        commit_all(&dir, "feature deletes");
        checkout(cwd(&dir), "main", None).unwrap();
        write(&dir, "f.txt", "alpha\nMAIN\ngamma\ndelta\nepsilon\n");
        commit_all(&dir, "main edits");
        let _ = run_git(cwd(&dir), &["merge", "feature"], None).unwrap();
        let c = conflict_info(cwd(&dir), "f.txt").unwrap();
        assert_eq!((c.kind.as_str(), c.deleted_by.as_deref()), ("deleteModify", Some("theirs")));
        assert!(c.theirs.is_none() && c.ours.is_some());
        resolve_deleted(cwd(&dir), "f.txt", true).unwrap();
        assert!(dir.path().join("f.txt").exists());
        assert!(status(cwd(&dir)).unwrap().unstaged.is_empty());

        // We deleted, they modified → delete it.
        let dir = temp_repo();
        create_branch(cwd(&dir), "feature", None, true).unwrap();
        write(&dir, "f.txt", "alpha\nFEATURE\ngamma\ndelta\nepsilon\n");
        commit_all(&dir, "feature edits");
        checkout(cwd(&dir), "main", None).unwrap();
        git(cwd(&dir), &["rm", "-q", "f.txt"]);
        commit_all(&dir, "main deletes");
        let _ = run_git(cwd(&dir), &["merge", "feature"], None).unwrap();
        let c = conflict_info(cwd(&dir), "f.txt").unwrap();
        assert_eq!(c.deleted_by.as_deref(), Some("ours"));
        resolve_deleted(cwd(&dir), "f.txt", false).unwrap();
        assert!(!dir.path().join("f.txt").exists());
        assert!(status(cwd(&dir)).unwrap().unstaged.iter().all(|e| e.status != "U"));
    }

    #[test]
    fn added_by_both_binary_and_crlf_kinds() {
        let dir = temp_repo();
        create_branch(cwd(&dir), "feature", None, true).unwrap();
        write(&dir, "new.txt", "theirs\r\nline\r\n");
        std::fs::write(dir.path().join("img.bin"), b"\x00\x01THEIRS").unwrap();
        commit_all(&dir, "feature adds");
        checkout(cwd(&dir), "main", None).unwrap();
        write(&dir, "new.txt", "ours\r\nline\r\n");
        std::fs::write(dir.path().join("img.bin"), b"\x00\x01OURS").unwrap();
        commit_all(&dir, "main adds");
        let _ = run_git(cwd(&dir), &["merge", "feature"], None).unwrap();
        let t = conflict_info(cwd(&dir), "new.txt").unwrap();
        assert_eq!(t.kind, "addedBoth");
        assert!(t.base.is_none());
        assert_eq!(t.eol, "crlf");
        let b = conflict_info(cwd(&dir), "img.bin").unwrap();
        assert_eq!(b.kind, "binary");
        assert!(b.ours.is_none() && b.worktree.is_none());
        resolve_whole(cwd(&dir), "img.bin", "ours").unwrap();
        assert_eq!(std::fs::read(dir.path().join("img.bin")).unwrap(), b"\x00\x01OURS");
    }

    #[test]
    fn merge_tool_name_reads_config() {
        let dir = temp_repo();
        assert_eq!(merge_tool_name(cwd(&dir)).unwrap_or(None).is_some(), run_git_ro(cwd(&dir), &["config", "--get", "merge.tool"]).unwrap().code == 0);
        git(cwd(&dir), &["config", "merge.tool", "opendiff"]);
        assert_eq!(merge_tool_name(cwd(&dir)).unwrap().as_deref(), Some("opendiff"));
    }
}
