//! `.gitignore` and `.git/info/exclude` for the Git tab: the untracked-row
//! "Ignore" quick actions and the plain-text editor panel opened from the
//! toolbar, plus the Files tab's own tree menu (see `app/src/lib/gitIgnore.ts`,
//! shared by both surfaces).
//!
//! Two files, one shape, different audiences. `.gitignore` is committed
//! and shared with whoever clones the repo; `.git/info/exclude` never
//! leaves this checkout. Both are resolved through git itself rather
//! than joined onto `cwd` by hand: `.gitignore` lives at the toplevel,
//! which is not `cwd` in a nested checkout, and `info/exclude` lives in
//! the COMMON git dir, which is not `cwd/.git` at all in a linked
//! worktree -- only `--git-common-dir` gets that right.

//! Both files are resolved through git, which for an ssh workspace runs
//! on the host -- so the paths below are the host's, and the read and
//! write that follow go there too (`read_repo_file`/`write_repo_file`).
//! One caveat that is the host's confinement and not this module's: a
//! LINKED worktree's common git dir can lie outside the workspace root,
//! and `.git/info/exclude` is then refused there while `.gitignore` at
//! the toplevel is not.

use crate::git::run::{ok, read_repo_file, run_git_ro, write_repo_file};
use std::path::PathBuf;

fn toplevel(cwd: &str) -> Result<PathBuf, String> {
    let out = ok(run_git_ro(cwd, &["rev-parse", "--show-toplevel"])?)?;
    Ok(PathBuf::from(out.stdout_str().trim().to_string()))
}

/// Absolute, whether or not git prints it that way: `--git-common-dir`
/// answers relative to `cwd` when it answers relative at all, and every
/// caller here already runs git with `-C cwd`.
fn common_git_dir(cwd: &str) -> Result<PathBuf, String> {
    let out = ok(run_git_ro(cwd, &["rev-parse", "--git-common-dir"])?)?;
    let raw = PathBuf::from(out.stdout_str().trim().to_string());
    Ok(if raw.is_absolute() { raw } else { PathBuf::from(cwd).join(raw) })
}

fn ignore_file_path(cwd: &str, kind: &str) -> Result<PathBuf, String> {
    match kind {
        "gitignore" => Ok(toplevel(cwd)?.join(".gitignore")),
        "exclude" => Ok(common_git_dir(cwd)?.join("info").join("exclude")),
        other => Err(format!("unknown ignore file: {other}")),
    }
}

/// The file's text, or "" when it does not exist yet. `.gitignore` is
/// ordinary that way; `.git/info/exclude` usually is not -- `git init`
/// seeds it with a comment-only template, which reads back as that
/// template rather than "".
pub fn read_ignore_file(cwd: &str, kind: &str) -> Result<String, String> {
    let path = ignore_file_path(cwd, kind)?;
    Ok(read_repo_file(cwd, &path)?
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        .unwrap_or_default())
}

/// Overwrites the file with exactly what the editor holds -- what the
/// panel's Save button calls, verbatim, no reformatting.
pub fn write_ignore_file(cwd: &str, kind: &str, content: &str) -> Result<(), String> {
    let path = ignore_file_path(cwd, kind)?;
    write_repo_file(cwd, &path, content)
}

/// Appends `pattern` as its own line, unless a line already reads
/// exactly that (surrounding whitespace ignored) -- the quick action a
/// human presses on two files sharing an extension must not pile up
/// duplicate rules.
pub fn add_ignore_pattern(cwd: &str, kind: &str, pattern: &str) -> Result<(), String> {
    let pattern = pattern.trim();
    let existing = read_ignore_file(cwd, kind)?;
    if existing.lines().any(|l| l.trim() == pattern) {
        return Ok(());
    }
    let mut out = existing;
    if !out.is_empty() && !out.ends_with('\n') {
        out.push('\n');
    }
    out.push_str(pattern);
    out.push('\n');
    write_ignore_file(cwd, kind, &out)
}

#[tauri::command]
pub fn git_read_ignore_file(cwd: String, kind: String) -> Result<String, String> {
    read_ignore_file(&cwd, &kind)
}

#[tauri::command]
pub fn git_write_ignore_file(cwd: String, kind: String, content: String) -> Result<(), String> {
    write_ignore_file(&cwd, &kind, &content)
}

#[tauri::command]
pub fn git_add_ignore_pattern(cwd: String, kind: String, pattern: String) -> Result<(), String> {
    add_ignore_pattern(&cwd, &kind, &pattern)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::commands::testutil::{cwd, git, temp_repo, write};

    #[test]
    fn a_missing_gitignore_reads_as_empty() {
        let dir = temp_repo();
        assert_eq!(read_ignore_file(cwd(&dir), "gitignore").unwrap(), "");
    }

    /// `git init` seeds `.git/info/exclude` with its own comment-only
    /// template, so "missing" is not a state this file is ever actually
    /// in -- reading it back has to return that template rather than "".
    #[test]
    fn the_exclude_file_git_init_seeds_reads_back_as_its_own_template() {
        let dir = temp_repo();
        let text = read_ignore_file(cwd(&dir), "exclude").unwrap();
        assert!(text.contains("exclude"), "{text}");
    }

    #[test]
    fn write_creates_gitignore_at_the_toplevel() {
        let dir = temp_repo();
        write_ignore_file(cwd(&dir), "gitignore", "target/\n").unwrap();
        assert_eq!(std::fs::read_to_string(dir.path().join(".gitignore")).unwrap(), "target/\n");
        assert_eq!(read_ignore_file(cwd(&dir), "gitignore").unwrap(), "target/\n");
    }

    #[test]
    fn write_creates_the_exclude_file_and_its_info_directory() {
        let dir = temp_repo();
        // A fresh `git init` already has `.git/info/`, but nothing here
        // should assume that -- prove it by removing it first.
        std::fs::remove_dir_all(dir.path().join(".git/info")).unwrap();
        write_ignore_file(cwd(&dir), "exclude", "*.local\n").unwrap();
        assert_eq!(std::fs::read_to_string(dir.path().join(".git/info/exclude")).unwrap(), "*.local\n");
        assert_eq!(read_ignore_file(cwd(&dir), "exclude").unwrap(), "*.local\n");
    }

    #[test]
    fn add_pattern_appends_with_a_trailing_newline_even_over_a_file_missing_one() {
        let dir = temp_repo();
        write_ignore_file(cwd(&dir), "gitignore", "one").unwrap();
        add_ignore_pattern(cwd(&dir), "gitignore", "two").unwrap();
        assert_eq!(read_ignore_file(cwd(&dir), "gitignore").unwrap(), "one\ntwo\n");
    }

    #[test]
    fn add_pattern_on_an_empty_or_missing_file_writes_just_the_pattern() {
        let dir = temp_repo();
        add_ignore_pattern(cwd(&dir), "gitignore", "*.log").unwrap();
        assert_eq!(read_ignore_file(cwd(&dir), "gitignore").unwrap(), "*.log\n");
    }

    #[test]
    fn add_pattern_never_duplicates_a_line_already_there() {
        let dir = temp_repo();
        add_ignore_pattern(cwd(&dir), "gitignore", "/build/").unwrap();
        add_ignore_pattern(cwd(&dir), "gitignore", "/build/").unwrap();
        add_ignore_pattern(cwd(&dir), "gitignore", "  /build/  ").unwrap();
        assert_eq!(read_ignore_file(cwd(&dir), "gitignore").unwrap(), "/build/\n");
    }

    #[test]
    fn an_unknown_kind_is_refused() {
        let dir = temp_repo();
        let err = read_ignore_file(cwd(&dir), "bogus").unwrap_err();
        assert!(err.contains("bogus"), "{err}");
    }

    /// The reason this module never joins `cwd` onto `.git/info/exclude`
    /// by hand: a linked worktree's `.git` is a pointer FILE, not a
    /// directory, and `info/exclude` lives in the checkout that owns the
    /// shared object database -- not the worktree that happens to be cwd.
    #[test]
    fn exclude_resolves_to_the_common_dir_from_a_linked_worktree() {
        let dir = temp_repo();
        let name = dir.path().file_name().unwrap().to_string_lossy().to_string();
        let wt = dir.path().parent().unwrap().join(format!("{name}-ignore-wt"));
        let wt_s = wt.to_str().unwrap().to_string();
        git(cwd(&dir), &["worktree", "add", "-q", "-b", "ignore-wt", &wt_s]);

        add_ignore_pattern(&wt_s, "exclude", "*.secret").unwrap();
        assert!(!wt.join(".git").is_dir(), "a linked worktree's .git is a file, not this checkout's own directory");
        assert!(std::fs::read_to_string(dir.path().join(".git/info/exclude")).unwrap().ends_with("*.secret\n"));
        // The main checkout sees the same rule the worktree just wrote.
        assert!(read_ignore_file(cwd(&dir), "exclude").unwrap().ends_with("*.secret\n"));
    }

    #[test]
    fn gitignore_written_from_a_linked_worktree_lands_at_that_worktrees_own_toplevel() {
        let dir = temp_repo();
        let name = dir.path().file_name().unwrap().to_string_lossy().to_string();
        let wt = dir.path().parent().unwrap().join(format!("{name}-gi-wt"));
        let wt_s = wt.to_str().unwrap().to_string();
        git(cwd(&dir), &["worktree", "add", "-q", "-b", "gi-wt", &wt_s]);

        add_ignore_pattern(&wt_s, "gitignore", "/dist/").unwrap();
        assert_eq!(std::fs::read_to_string(wt.join(".gitignore")).unwrap(), "/dist/\n");
        assert!(!dir.path().join(".gitignore").exists(), "the main checkout's own .gitignore is untouched");
    }

    #[test]
    fn write_then_read_round_trips_an_empty_save() {
        let dir = temp_repo();
        write(&dir, ".gitignore", "target/\n");
        write_ignore_file(cwd(&dir), "gitignore", "").unwrap();
        assert_eq!(read_ignore_file(cwd(&dir), "gitignore").unwrap(), "");
    }
}
