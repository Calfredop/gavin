//! Git tracking of gavin's own files: `.gavin-root/` and every `.gavin/`
//! context folder under the workspace root.
//!
//! Two ways to hold this. Some projects want the board in the repo -- the
//! PRD, the cards and the rails are the project's plan, and a teammate who
//! clones should get them. Others want gavin's files to stay out of the
//! history entirely. Gavin's answer is one switch per workspace, defaulted
//! app-wide, and the switch is expressed as an ignore block in the root's
//! `.gitignore` rather than as a flag gavin stores somewhere of its own.
//!
//! That choice is the load-bearing one here: **git already holds this
//! state**. A stored boolean would be a second copy of an answer
//! `.gitignore` already gives, free to drift the moment anyone edits that
//! file by hand -- and it would be invisible to every other tool the human
//! uses on this repo. So `status` asks git (`check-ignore`), and `set`
//! edits the file git reads. Nothing is cached.
//!
//! Ignoring a path does not untrack a file already in the index, which is
//! why `set` can also remove them: without that, turning tracking off in a
//! repo whose `.gavin-root/` was committed long ago would write a rule
//! that changes nothing at all. The removal is STAGED and never committed
//! -- the working tree keeps every byte, and the human reviews the change
//! in the Git tab like any other.

use crate::git::run::{run_git, run_git_ro};
use serde::Serialize;

/// The fence gavin writes around its rules. Comments, so git reads them as
/// nothing; they exist so an "on" can remove exactly the block gavin
/// wrote rather than string-matching patterns someone may since have
/// edited or moved.
pub const IGNORE_START: &str = "# gavin:ignore-start";
pub const IGNORE_END: &str = "# gavin:ignore-end";

/// A line of prose inside the fence, so the block explains itself to
/// whoever opens `.gitignore` next -- including the human who turned this
/// on months ago and no longer remembers gavin wrote it.
const IGNORE_NOTE: &str = "# gavin's own files. Toggle from Settings › Git in the app.";

/// What the block ignores. Trailing slashes: both are directories, and the
/// slash keeps a stray FILE called `.gavin` somewhere in the tree from
/// disappearing on a rule meant for context folders. Neither is anchored
/// with a leading `/` -- `.gavin/` has to match a context folder at any
/// depth, and an unanchored `.gavin-root/` costs nothing because a
/// `.gavin-root` below the top level is not a context gavin reads anyway.
pub const IGNORE_PATTERNS: [&str; 2] = [".gavin-root/", ".gavin/"];

/// The paths gavin owns, as git pathspecs. `:(glob)` so `**` crosses
/// directory separators and `*` does not -- without the magic prefix git
/// matches pathspec wildcards across slashes, and `*.gavin/*` would then
/// also claim a directory merely ENDING in `.gavin`.
const GAVIN_PATHSPECS: [&str; 2] = [":(glob)**/.gavin/**", ":(glob)**/.gavin-root/**"];

/// Whether git would track gavin's files here, and what says otherwise.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GavinTracking {
    /// False when the folder is not inside a git work tree at all. Every
    /// other field is then meaningless and the UI says so rather than
    /// offering a switch that would write a `.gitignore` nothing reads.
    pub is_repo: bool,
    /// The answer: true when no ignore rule excludes gavin's paths.
    pub tracked: bool,
    /// The rule that excludes them, as `source:line:pattern` from
    /// `git check-ignore -v`, or None when nothing does. Reported rather
    /// than swallowed because the rule may not be gavin's -- a hand-written
    /// `.gitignore` entry, a parent repo's, or the user's global excludes
    /// all land here, and each of those is a "gavin cannot turn this back
    /// on for you" the human has to be told about by name.
    pub ignored_by: Option<String>,
    /// Whether gavin's own fenced block is present in `<root>/.gitignore`.
    /// The switch is gavin's to flip only while this is true (or while
    /// nothing ignores the paths at all).
    pub gavin_managed: bool,
    /// How many of gavin's files are in the index right now. Ignoring does
    /// not untrack, so this is the number the confirm has to quote before
    /// staging their removal -- and, when tracking is off and this is not
    /// zero, the reason the files still show up in git.
    pub indexed: usize,
}

/// The block gavin writes, without a trailing newline.
pub fn ignore_block() -> String {
    let mut out = String::from(IGNORE_START);
    out.push('\n');
    out.push_str(IGNORE_NOTE);
    for pattern in IGNORE_PATTERNS {
        out.push('\n');
        out.push_str(pattern);
    }
    out.push('\n');
    out.push_str(IGNORE_END);
    out
}

/// The half-open line range the block occupies, or None when there is no
/// complete fence. An unterminated start marker counts as no block: the
/// rest of the file is then someone else's rules, and splicing to the end
/// would delete them.
fn block_span(lines: &[&str]) -> Option<(usize, usize)> {
    let start = lines.iter().position(|l| l.trim() == IGNORE_START)?;
    let end = lines[start..].iter().position(|l| l.trim() == IGNORE_END)? + start;
    Some((start, end + 1))
}

/// Whether this `.gitignore` text carries gavin's block.
pub fn has_block(content: &str) -> bool {
    block_span(&content.lines().collect::<Vec<_>>()).is_some()
}

/// The file's text with the block present or absent. Idempotent both ways,
/// so a caller may write the answer back unconditionally.
///
/// A block that is already there is left exactly as it is, edits and all --
/// the same rule the card body's auto-commit block follows. Someone who
/// added a third pattern of their own inside the fence has not asked for it
/// back, and re-writing the canonical block over theirs would take it away
/// on a no-op save.
pub fn with_block(content: &str, present: bool) -> String {
    let lines: Vec<&str> = content.lines().collect();
    let span = block_span(&lines);
    if present {
        if span.is_some() {
            return content.to_string();
        }
        let head = content.trim_end();
        if head.is_empty() {
            return format!("{}\n", ignore_block());
        }
        return format!("{}\n\n{}\n", head, ignore_block());
    }
    let Some((start, end)) = span else { return content.to_string() };
    let mut kept: Vec<&str> = Vec::with_capacity(lines.len());
    kept.extend_from_slice(&lines[..start]);
    kept.extend_from_slice(&lines[end..]);
    let rest = kept.join("\n");
    let rest = rest.trim_matches('\n');
    if rest.trim().is_empty() {
        // Empty, not " \n": the caller deletes the file at that point, and
        // a `.gitignore` that exists only to hold nothing is a file the
        // human then has to explain to their own diff.
        return String::new();
    }
    format!("{}\n", rest)
}

fn gitignore_path(root: &str) -> std::path::PathBuf {
    std::path::Path::new(root).join(".gitignore")
}

fn read_gitignore(root: &str) -> String {
    std::fs::read_to_string(gitignore_path(root)).unwrap_or_default()
}

fn is_repo(root: &str) -> bool {
    run_git_ro(root, &["rev-parse", "--is-inside-work-tree"])
        .map(|o| o.code == 0 && o.stdout_str().trim() == "true")
        .unwrap_or(false)
}

/// The first rule that ignores one of gavin's paths, `source:line:pattern`.
///
/// `--no-index` is not an optimisation, it is the question being asked. By
/// default `check-ignore` reports a TRACKED path as un-ignored however
/// many rules match it -- true of the file, but not the answer this switch
/// wants: right after turning tracking off in a repo whose files are still
/// in the index, the plain form would say "not ignored" and the toggle
/// would appear to have done nothing. `indexed` reports that half
/// separately, where it can be acted on.
///
/// The trailing slashes on the queried paths are load-bearing. Both of
/// gavin's patterns end in one, so they match directories only, and git
/// decides whether a queried path IS a directory by looking at the disk
/// unless the query says so -- ask about a bare `.gavin-root` in a
/// workspace that has not been initialised yet and a rule that plainly
/// ignores it answers "no".
fn ignored_by(root: &str) -> Option<String> {
    let out = run_git_ro(
        root,
        &["check-ignore", "--no-index", "-v", "--", ".gavin-root/", ".gavin/"],
    )
    .ok()?;
    if out.code != 0 {
        return None;
    }
    let line = out.stdout_str();
    let line = line.lines().next()?.trim_end();
    // `<source>:<line>:<pattern>\t<pathname>` -- the pathname is the path
    // we just asked about, so it says nothing back.
    Some(line.split('\t').next().unwrap_or(line).to_string())
}

fn indexed_files(root: &str) -> Vec<String> {
    let mut args = vec!["ls-files", "-z", "--"];
    args.extend_from_slice(&GAVIN_PATHSPECS);
    let Ok(out) = run_git_ro(root, &args) else { return Vec::new() };
    if out.code != 0 {
        return Vec::new();
    }
    out.stdout_str().split('\0').filter(|s| !s.is_empty()).map(|s| s.to_string()).collect()
}

/// What git currently says about gavin's files under `root`.
pub fn status(root: &str) -> Result<GavinTracking, String> {
    if !std::path::Path::new(root).is_dir() {
        return Err(format!("directory not found: {root}"));
    }
    if !is_repo(root) {
        return Ok(GavinTracking {
            is_repo: false,
            // Nothing ignores anything outside a repo, and calling that
            // "tracked" would be a claim about a repo that isn't there --
            // but it is the state the switch would restore, so the UI
            // renders the honest shape and disables the control on
            // `is_repo` alone.
            tracked: true,
            ignored_by: None,
            gavin_managed: false,
            indexed: 0,
        });
    }
    let rule = ignored_by(root);
    Ok(GavinTracking {
        is_repo: true,
        tracked: rule.is_none(),
        ignored_by: rule,
        gavin_managed: has_block(&read_gitignore(root)),
        indexed: indexed_files(root).len(),
    })
}

/// Stages the removal of every gavin file in the index. `--cached` so the
/// working tree is untouched: the files stay on disk and gavin keeps
/// reading them. `-f` because a file whose worktree copy differs from the
/// index would otherwise refuse -- a safety check about LOSING content,
/// and `--cached` loses none.
fn untrack(root: &str) -> Result<(), String> {
    if indexed_files(root).is_empty() {
        return Ok(());
    }
    let mut args = vec!["rm", "-r", "--cached", "-f", "--quiet", "--ignore-unmatch", "--"];
    args.extend_from_slice(&GAVIN_PATHSPECS);
    let out = run_git(root, &args, None)?;
    if out.code != 0 {
        return Err(out.stderr.trim().to_string());
    }
    Ok(())
}

/// Turns tracking on or off, and reports where that left things.
///
/// `untrack_indexed` only ever applies to turning it OFF, and is the
/// caller's answer to a question the human was asked by name: it stages
/// deletions in a repo the human may be mid-commit in, so it is never
/// implied by the toggle itself.
///
/// Turning it back ON deliberately stages nothing. Un-ignoring makes the
/// files untracked-and-visible, which is exactly the state a fresh
/// workspace is in; deciding they belong in a commit is the human's, and
/// the Git tab is where that decision already lives.
pub fn set(root: &str, tracked: bool, untrack_indexed: bool) -> Result<GavinTracking, String> {
    if !std::path::Path::new(root).is_dir() {
        return Err(format!("directory not found: {root}"));
    }
    let path = gitignore_path(root);
    let before = read_gitignore(root);
    let after = with_block(&before, !tracked);
    if after != before {
        if after.is_empty() {
            // Only ever reached by an "on" that removed the sole block
            // from a file gavin created for it. Removing the file is the
            // rest of that undo.
            let _ = std::fs::remove_file(&path);
        } else {
            std::fs::write(&path, &after).map_err(|e| format!("could not write .gitignore: {e}"))?;
        }
    }
    if !tracked && untrack_indexed && is_repo(root) {
        untrack(root)?;
    }
    status(root)
}

#[tauri::command]
pub fn gavin_git_tracking(root: String) -> Result<GavinTracking, String> {
    status(&root)
}

#[tauri::command]
pub fn set_gavin_git_tracking(
    root: String,
    tracked: bool,
    untrack: bool,
) -> Result<GavinTracking, String> {
    set(&root, tracked, untrack)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_empty_file_becomes_the_block_alone() {
        let out = with_block("", true);
        assert_eq!(out, format!("{}\n", ignore_block()));
        assert!(has_block(&out));
    }

    #[test]
    fn the_block_is_appended_after_existing_rules() {
        let out = with_block("target\nnode_modules\n", true);
        assert!(out.starts_with("target\nnode_modules\n\n"));
        assert!(out.ends_with(&format!("{IGNORE_END}\n")));
        assert!(out.contains(".gavin-root/"));
    }

    #[test]
    fn adding_a_block_that_is_already_there_changes_nothing() {
        let once = with_block("target\n", true);
        assert_eq!(with_block(&once, true), once);
    }

    #[test]
    fn an_edited_block_is_left_exactly_as_the_human_left_it() {
        let edited = format!("{IGNORE_START}\n.gavin-root/\n.gavin/\nnotes.local\n{IGNORE_END}\n");
        assert_eq!(with_block(&edited, true), edited);
    }

    #[test]
    fn removing_the_block_keeps_every_other_rule() {
        let with = with_block("target\nnode_modules\n", true);
        assert_eq!(with_block(&with, false), "target\nnode_modules\n");
    }

    #[test]
    fn removing_the_block_from_between_two_rules_does_not_weld_them() {
        let text = format!("target\n{IGNORE_START}\n.gavin/\n{IGNORE_END}\nnode_modules\n");
        assert_eq!(with_block(&text, false), "target\nnode_modules\n");
    }

    #[test]
    fn a_file_holding_only_the_block_comes_back_empty() {
        let only = with_block("", true);
        assert_eq!(with_block(&only, false), "");
    }

    #[test]
    fn removing_a_block_that_is_not_there_changes_nothing() {
        assert_eq!(with_block("target\n", false), "target\n");
    }

    #[test]
    fn an_unterminated_start_marker_is_not_a_block() {
        let text = format!("{IGNORE_START}\n.gavin/\ntarget\n");
        assert!(!has_block(&text));
        // ...and removing "it" must not eat the rules below the marker.
        assert_eq!(with_block(&text, false), text);
    }

    fn repo(dir: &std::path::Path) {
        for args in [
            vec!["init", "-q"],
            vec!["config", "user.email", "t@example.com"],
            vec!["config", "user.name", "T"],
        ] {
            let out = run_git(dir.to_str().unwrap(), &args, None).unwrap();
            assert_eq!(out.code, 0, "{}", out.stderr);
        }
    }

    #[test]
    fn a_folder_outside_a_repo_reports_no_repo() {
        let dir = tempfile::tempdir().unwrap();
        let s = status(dir.path().to_str().unwrap()).unwrap();
        assert!(!s.is_repo);
        assert!(s.tracked);
    }

    #[test]
    fn a_fresh_repo_tracks_gavin_and_the_switch_turns_it_off_and_back_on() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        repo(dir.path());
        std::fs::create_dir_all(dir.path().join(".gavin-root/plans")).unwrap();
        std::fs::write(dir.path().join(".gavin-root/plans/a.md"), "x").unwrap();

        let s = status(root).unwrap();
        assert!(s.is_repo && s.tracked && !s.gavin_managed);

        let off = set(root, false, false).unwrap();
        assert!(!off.tracked, "{off:?}");
        assert!(off.gavin_managed);
        assert!(off.ignored_by.unwrap().contains(".gitignore"));

        let on = set(root, true, false).unwrap();
        assert!(on.tracked && !on.gavin_managed);
        assert!(!dir.path().join(".gitignore").exists());
    }

    #[test]
    fn a_hand_written_rule_survives_the_switch_and_keeps_ignoring() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        repo(dir.path());
        std::fs::write(dir.path().join(".gitignore"), ".gavin-root/\n").unwrap();

        let on = set(root, true, false).unwrap();
        // Gavin removed nothing (there was no block of its own) and says
        // so: the rule that ignores gavin is still there, by name.
        assert!(!on.tracked);
        assert!(!on.gavin_managed);
        assert_eq!(std::fs::read_to_string(dir.path().join(".gitignore")).unwrap(), ".gavin-root/\n");
    }

    #[test]
    fn turning_tracking_off_can_stage_the_removal_without_touching_the_files() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        repo(dir.path());
        std::fs::create_dir_all(dir.path().join(".gavin-root/plans")).unwrap();
        std::fs::write(dir.path().join(".gavin-root/plans/a.md"), "x").unwrap();
        std::fs::write(dir.path().join("README.md"), "hi").unwrap();
        assert_eq!(run_git(root, &["add", "-A"], None).unwrap().code, 0);
        assert_eq!(
            run_git(root, &["commit", "-qm", "init"], None).unwrap().code,
            0
        );

        assert_eq!(status(root).unwrap().indexed, 1);

        let off = set(root, false, true).unwrap();
        assert!(!off.tracked);
        assert_eq!(off.indexed, 0);
        // The file itself is untouched -- gavin still reads it.
        assert!(dir.path().join(".gavin-root/plans/a.md").exists());
        // ...and nothing outside gavin's paths was swept up.
        let tracked = run_git(root, &["ls-files"], None).unwrap().stdout_str();
        assert_eq!(tracked.trim(), "README.md");
    }

    #[test]
    fn declining_the_removal_leaves_the_index_alone() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        repo(dir.path());
        std::fs::create_dir_all(dir.path().join(".gavin-root")).unwrap();
        std::fs::write(dir.path().join(".gavin-root/PRD.md"), "x").unwrap();
        assert_eq!(run_git(root, &["add", "-A"], None).unwrap().code, 0);
        assert_eq!(run_git(root, &["commit", "-qm", "init"], None).unwrap().code, 0);

        let off = set(root, false, false).unwrap();
        assert!(!off.tracked);
        assert_eq!(off.indexed, 1, "the rule is written, the index is not touched");
    }

    #[test]
    fn a_nested_context_folder_is_covered_too() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_str().unwrap();
        repo(dir.path());
        std::fs::create_dir_all(dir.path().join("crates/lib/.gavin/plans")).unwrap();
        std::fs::write(dir.path().join("crates/lib/.gavin/plans/b.md"), "x").unwrap();
        std::fs::create_dir_all(dir.path().join("crates/lib/src")).unwrap();
        std::fs::write(dir.path().join("crates/lib/src/main.rs"), "fn main(){}").unwrap();
        assert_eq!(run_git(root, &["add", "-A"], None).unwrap().code, 0);
        assert_eq!(run_git(root, &["commit", "-qm", "init"], None).unwrap().code, 0);

        assert_eq!(status(root).unwrap().indexed, 1);
        let off = set(root, false, true).unwrap();
        assert_eq!(off.indexed, 0);
        let tracked = run_git(root, &["ls-files"], None).unwrap().stdout_str();
        assert!(tracked.contains("crates/lib/src/main.rs"));
        assert!(!tracked.contains(".gavin/"));
    }
}
