//! Keeping ONE card out of git: the card detail modal's Git row.
//!
//! `tracking.rs` answers this for gavin's files as a whole; this answers it
//! for a single card -- a personal note on a board the team shares, a card
//! whose body quotes something that should not be committed. The same rule
//! holds here as there: **git already holds this state**, so the flag is
//! an ignore rule in `.gitignore` (shared with whoever clones) or in
//! `.git/info/exclude` (this checkout only), read back with
//! `git check-ignore`. A frontmatter field would be a second copy free to
//! drift from the file git actually reads, and would mean nothing to any
//! other tool pointed at the repo.
//!
//! The rule names the card by FILE NAME under its context's `plans/`
//! folder, not by its path: `/.gavin-root/plans/**/<name>.md`. Done files a
//! card under `plans/done/` and archiving moves it to `plans/archive/`, and
//! a rule pinned to the path it had when it was ticked would silently stop
//! matching on the first move. `**/` matches zero directories as well, so
//! the one pattern covers all three places. Renaming the file does break
//! it -- the read-back then reports the card as tracked, which is the truth.
//!
//! The pattern line itself is gavin's marker: an "off" removes exactly the
//! line gavin would have written, from whichever of the two files holds it,
//! and leaves every other rule alone. A card ignored by some OTHER rule (a
//! hand-written one, or workspace tracking turned off for the whole
//! `.gavin-root/`) is reported by name, because gavin cannot turn that one
//! back on for the human.

use crate::git::ignore::{read_ignore_file, write_ignore_file};
use crate::git::run::{off_main_thread, run_git, run_git_ro};
use serde::Serialize;
use std::path::{Component, Path};

/// The two files a card's rule can live in, as `ignore.rs` names them.
/// `.gitignore` first: it takes precedence over `info/exclude` when both
/// match, which is the order `check-ignore` would report them in.
const KINDS: [&str; 2] = ["gitignore", "exclude"];

/// What git says about one card.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CardIgnore {
    /// False outside a git work tree; every other field is then empty and
    /// the row says so instead of offering a choice nothing would read.
    pub is_repo: bool,
    /// The rule gavin writes for this card.
    pub pattern: String,
    /// Which file holds gavin's rule for this card -- "gitignore" or
    /// "exclude" -- or None when neither does. When both somehow do,
    /// `.gitignore`, the one git consults first.
    pub rule_in: Option<String>,
    /// The answer: whether git ignores the card right now, by any rule.
    pub ignored: bool,
    /// The rule that decided, `source:line:pattern`, or None when none
    /// matched. Reported for an un-ignore too (a `!` pattern): that is
    /// the reason gavin's own rule would not be holding.
    pub decided_by: Option<String>,
    /// Whether the rule that decided is gavin's own line for this card.
    pub decided_by_gavin: bool,
    /// Whether the card is in the index. Ignoring never untracks a file
    /// already committed, so this is what the "stage its removal?"
    /// question is about -- and, when it is true while ignored, why the
    /// card still shows up in git.
    pub indexed: bool,
}

/// Backslash before everything gitignore's matcher would read as syntax,
/// so a file name is matched as written. A space is escaped too: only a
/// TRAILING one is special, but escaping each costs nothing and saves
/// deciding which.
fn escape(segment: &str) -> String {
    let mut out = String::with_capacity(segment.len());
    for c in segment.chars() {
        if matches!(c, '*' | '?' | '[' | ']' | '\\' | ' ' | '!' | '#') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// The card's path relative to the repository's toplevel, as `/`-joined
/// segments, from the workspace root's own prefix (`git rev-parse
/// --show-prefix`) and the card's path under the root. Built from path
/// components rather than string slicing, so a Windows desk's separators
/// read the same as a POSIX host's.
fn segments_under(root: &str, card: &str) -> Result<Vec<String>, String> {
    let rel = Path::new(card)
        .strip_prefix(Path::new(root))
        .map_err(|_| format!("{card} is not inside the workspace {root}"))?;
    let mut out = Vec::new();
    for c in rel.components() {
        match c {
            Component::Normal(s) => out.push(s.to_string_lossy().into_owned()),
            Component::CurDir => {}
            _ => return Err(format!("{card} is not a plain path under the workspace")),
        }
    }
    if out.is_empty() {
        return Err(format!("{card} is the workspace root, not a card"));
    }
    Ok(out)
}

/// The rule for a card at `rel` (toplevel-relative segments). Anchored at
/// the context's `plans/` folder, with `**/` in place of whatever sits
/// between it and the file: `done/`, `archive/`, or nothing.
///
/// None for a path that is not under a context's `plans/` -- not a card,
/// and not something this row has any business writing a rule for.
pub fn card_pattern(rel: &[String]) -> Option<String> {
    let name = rel.last()?;
    // The LAST `.gavin-root/plans` or `.gavin/plans` above the file: a
    // context folder nested in another's tree is its own context.
    let plans = (1..rel.len().saturating_sub(1))
        .rev()
        .find(|&i| rel[i] == "plans" && (rel[i - 1] == ".gavin-root" || rel[i - 1] == ".gavin"))?;
    let dir: Vec<String> = rel[..=plans].iter().map(|s| escape(s)).collect();
    Some(format!("/{}/**/{}", dir.join("/"), escape(name)))
}

fn is_repo(root: &str) -> bool {
    run_git_ro(root, &["rev-parse", "--is-inside-work-tree"])
        .map(|o| o.code == 0 && o.stdout_str().trim() == "true")
        .unwrap_or(false)
}

/// Where the workspace root sits under the toplevel, as segments: empty
/// when the root IS the toplevel, which is the usual case.
fn root_prefix(root: &str) -> Result<Vec<String>, String> {
    let out = run_git_ro(root, &["rev-parse", "--show-prefix"])?;
    if out.code != 0 {
        return Err(out.stderr.trim().to_string());
    }
    Ok(out.stdout_str().trim().split('/').filter(|s| !s.is_empty()).map(str::to_string).collect())
}

/// `rel_root` is the card's path relative to `root`, `/`-joined: what the
/// git commands below are handed, since they all run from the root.
struct Card {
    rel_root: String,
    pattern: String,
}

fn locate(root: &str, card: &str) -> Result<Card, String> {
    let under_root = segments_under(root, card)?;
    let mut rel = root_prefix(root)?;
    rel.extend(under_root.iter().cloned());
    let pattern = card_pattern(&rel).ok_or_else(|| format!("{card} is not a card in a plans folder"))?;
    Ok(Card { rel_root: under_root.join("/"), pattern })
}

fn has_line(text: &str, pattern: &str) -> bool {
    text.lines().any(|l| l.trim() == pattern)
}

/// The text with every line reading exactly `pattern` taken out, and
/// nothing else touched.
fn without_line(text: &str, pattern: &str) -> String {
    let kept: Vec<&str> = text.lines().filter(|l| l.trim() != pattern).collect();
    if kept.is_empty() {
        return String::new();
    }
    format!("{}\n", kept.join("\n"))
}

/// The rule that decides for `rel_root`, as (`source:line:pattern`,
/// pattern), or None when none matches.
///
/// `--no-index` for the reason `tracking.rs` gives: without it a card
/// still in the index reads as "not ignored" however many rules match,
/// and ticking the box would look like it did nothing.
fn deciding_rule(root: &str, rel_root: &str) -> Option<(String, String)> {
    let out = run_git_ro(root, &["check-ignore", "--no-index", "-v", "--", rel_root]).ok()?;
    if out.code != 0 {
        return None;
    }
    parse_verbose(&out.stdout_str())
}

/// One `check-ignore -v` line: `<source>:<linenum>:<pattern>\t<pathname>`.
///
/// Both the source and the pattern may hold a `:` of their own -- a
/// Windows `core.excludesFile` is `C:\...` -- so the split is at the first
/// `:<digits>:`, the line number being the one field that cannot contain
/// one. (`-z` would have spared this, but git accepts it only with
/// `--stdin`.) The pathname after the tab is the path just asked about,
/// so it says nothing back.
fn parse_verbose(text: &str) -> Option<(String, String)> {
    let line = text.lines().next()?;
    let rule = line.split('\t').next().unwrap_or(line);
    let bytes = rule.as_bytes();
    for (i, _) in rule.match_indices(':') {
        let digits = bytes[i + 1..].iter().take_while(|b| b.is_ascii_digit()).count();
        if digits > 0 && bytes.get(i + 1 + digits) == Some(&b':') {
            if i == 0 {
                return None;
            }
            let pattern = &rule[i + 2 + digits..];
            return Some((rule.to_string(), pattern.to_string()));
        }
    }
    None
}

fn indexed(root: &str, rel_root: &str) -> bool {
    run_git_ro(root, &["ls-files", "-z", "--", rel_root])
        .map(|o| o.code == 0 && !o.stdout.is_empty())
        .unwrap_or(false)
}

/// What git currently says about the card at `card` (absolute, under
/// `root`).
pub fn status(root: &str, card: &str) -> Result<CardIgnore, String> {
    if !is_repo(root) {
        return Ok(CardIgnore {
            is_repo: false,
            pattern: String::new(),
            rule_in: None,
            ignored: false,
            decided_by: None,
            decided_by_gavin: false,
            indexed: false,
        });
    }
    let c = locate(root, card)?;
    let mut rule_in = None;
    for kind in KINDS {
        if has_line(&read_ignore_file(root, kind)?, &c.pattern) {
            rule_in = Some(kind.to_string());
            break;
        }
    }
    let rule = deciding_rule(root, &c.rel_root);
    // `-v` reports a matching NEGATION too, with the same exit code as an
    // ignore: the path is then explicitly not ignored, and the `!` line is
    // the reason.
    let ignored = rule.as_ref().is_some_and(|(_, p)| !p.starts_with('!'));
    Ok(CardIgnore {
        is_repo: true,
        decided_by_gavin: rule.as_ref().is_some_and(|(_, p)| *p == c.pattern),
        decided_by: rule.map(|(r, _)| r),
        ignored,
        rule_in,
        indexed: indexed(root, &c.rel_root),
        pattern: c.pattern,
    })
}

/// Puts gavin's rule for the card in `into` ("gitignore", "exclude") and
/// takes it out of the other file, or out of both for None. Idempotent.
///
/// `untrack` is the caller's answer to a question the human was asked by
/// name, and only ever applies to an ignore: it STAGES the card's removal
/// from the index (`--cached`, so the file stays on disk and on the
/// board), in a repo the human may be mid-commit in. Turning the flag off
/// stages nothing -- the card becomes untracked-and-visible, and whether it
/// belongs in a commit is the Git tab's question, as it is for
/// `tracking::set`.
pub fn set(root: &str, card: &str, into: Option<&str>, untrack: bool) -> Result<CardIgnore, String> {
    if let Some(kind) = into {
        if !KINDS.contains(&kind) {
            return Err(format!("unknown ignore file: {kind}"));
        }
    }
    if !is_repo(root) {
        return Err(format!("{root} is not inside a git repository"));
    }
    let c = locate(root, card)?;
    for kind in KINDS {
        let before = read_ignore_file(root, kind)?;
        let want = into == Some(kind);
        let after = if want && !has_line(&before, &c.pattern) {
            let mut out = before.clone();
            if !out.is_empty() && !out.ends_with('\n') {
                out.push('\n');
            }
            out.push_str(&c.pattern);
            out.push('\n');
            out
        } else if !want && has_line(&before, &c.pattern) {
            without_line(&before, &c.pattern)
        } else {
            continue;
        };
        write_ignore_file(root, kind, &after)?;
    }
    if into.is_some() && untrack && indexed(root, &c.rel_root) {
        // `-f`: a card whose staged copy differs from both HEAD and the
        // file would otherwise refuse -- a guard against losing content,
        // and `--cached` loses none of the working tree.
        let out = run_git(root, &["rm", "--cached", "-f", "--quiet", "--", &c.rel_root], None)?;
        if out.code != 0 {
            return Err(out.stderr.trim().to_string());
        }
    }
    status(root, card)
}

// Off the main thread, both: `git check-ignore`, two ignore-file reads and
// `ls-files`, which on an ssh workspace are round trips to the host -- on
// every card modal open.

#[tauri::command]
pub async fn card_git_ignore(root: String, card: String) -> Result<CardIgnore, String> {
    off_main_thread(move || status(&root, &card)).await
}

#[tauri::command]
pub async fn set_card_git_ignore(
    root: String,
    card: String,
    into: Option<String>,
    untrack: bool,
) -> Result<CardIgnore, String> {
    off_main_thread(move || {
        // The same lock as every other ignore-file edit: each is a read and
        // a whole-file write, and two interleaved lose a rule.
        let _edit = crate::git::ignore::one_edit_at_a_time();
        set(&root, &card, into.as_deref(), untrack)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::commands::testutil::{cwd, git, temp_repo};

    fn segs(path: &str) -> Vec<String> {
        path.split('/').map(str::to_string).collect()
    }

    fn put(dir: &tempfile::TempDir, rel: &str, content: &str) -> String {
        let path = dir.path().join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, content).unwrap();
        path.to_str().unwrap().to_string()
    }

    #[test]
    fn a_verbose_line_splits_at_the_line_number_even_with_colons_around_it() {
        assert_eq!(
            parse_verbose(".gitignore:3:.gavin-root/\t.gavin-root/plans/a.md\n"),
            Some((".gitignore:3:.gavin-root/".to_string(), ".gavin-root/".to_string()))
        );
        assert_eq!(
            parse_verbose("C:\\Users\\me\\.gitignore:12:a:b\tx").map(|(_, p)| p),
            Some("a:b".to_string())
        );
        assert_eq!(parse_verbose(""), None);
    }

    #[test]
    fn the_pattern_is_anchored_at_the_plans_folder_and_skips_done_and_archive() {
        let want = Some("/.gavin-root/plans/**/a.md".to_string());
        assert_eq!(card_pattern(&segs(".gavin-root/plans/a.md")), want);
        assert_eq!(card_pattern(&segs(".gavin-root/plans/done/a.md")), want);
        assert_eq!(card_pattern(&segs(".gavin-root/plans/archive/a.md")), want);
    }

    #[test]
    fn a_context_folder_card_is_anchored_at_its_own_context() {
        assert_eq!(
            card_pattern(&segs("crates/x/.gavin/plans/done/b.md")),
            Some("/crates/x/.gavin/plans/**/b.md".to_string())
        );
    }

    #[test]
    fn a_path_outside_a_plans_folder_has_no_pattern() {
        assert_eq!(card_pattern(&segs("docs/plans/a.md")), None);
        assert_eq!(card_pattern(&segs(".gavin-root/PRD.md")), None);
        // `plans` itself is not a card.
        assert_eq!(card_pattern(&segs(".gavin-root/plans")), None);
    }

    #[test]
    fn glob_characters_in_a_name_are_matched_literally() {
        assert_eq!(
            card_pattern(&segs(".gavin-root/plans/[wip] a*b?.md")),
            Some(r"/.gavin-root/plans/**/\[wip\]\ a\*b\?.md".to_string())
        );
    }

    #[test]
    fn a_card_reads_tracked_until_it_is_ignored() {
        let dir = temp_repo();
        let card = put(&dir, ".gavin-root/plans/a.md", "x");
        let s = status(cwd(&dir), &card).unwrap();
        assert!(s.is_repo);
        assert!(!s.ignored);
        assert_eq!(s.rule_in, None);
        assert_eq!(s.pattern, "/.gavin-root/plans/**/a.md");
    }

    #[test]
    fn excluding_a_card_writes_info_exclude_and_reads_back_ignored() {
        let dir = temp_repo();
        let card = put(&dir, ".gavin-root/plans/a.md", "x");
        let s = set(cwd(&dir), &card, Some("exclude"), false).unwrap();
        assert!(s.ignored);
        assert!(s.decided_by_gavin);
        assert_eq!(s.rule_in.as_deref(), Some("exclude"));
        let exclude = std::fs::read_to_string(dir.path().join(".git/info/exclude")).unwrap();
        assert!(exclude.ends_with("/.gavin-root/plans/**/a.md\n"), "{exclude}");
        assert!(!dir.path().join(".gitignore").exists());
        // The other cards stay visible.
        let other = put(&dir, ".gavin-root/plans/b.md", "x");
        assert!(!status(cwd(&dir), &other).unwrap().ignored);
    }

    #[test]
    fn the_rule_follows_the_card_into_done() {
        let dir = temp_repo();
        let card = put(&dir, ".gavin-root/plans/a.md", "x");
        set(cwd(&dir), &card, Some("gitignore"), false).unwrap();
        std::fs::remove_file(&card).unwrap();
        let moved = put(&dir, ".gavin-root/plans/done/a.md", "x");
        let s = status(cwd(&dir), &moved).unwrap();
        assert!(s.ignored);
        assert_eq!(s.rule_in.as_deref(), Some("gitignore"));
    }

    #[test]
    fn switching_files_moves_the_rule_and_off_removes_only_gavins_line() {
        let dir = temp_repo();
        put(&dir, ".gitignore", "target/\n");
        let card = put(&dir, ".gavin-root/plans/a.md", "x");
        set(cwd(&dir), &card, Some("gitignore"), false).unwrap();
        let s = set(cwd(&dir), &card, Some("exclude"), false).unwrap();
        assert_eq!(s.rule_in.as_deref(), Some("exclude"));
        assert_eq!(std::fs::read_to_string(dir.path().join(".gitignore")).unwrap(), "target/\n");
        let s = set(cwd(&dir), &card, None, false).unwrap();
        assert!(!s.ignored);
        assert_eq!(s.rule_in, None);
        let exclude = std::fs::read_to_string(dir.path().join(".git/info/exclude")).unwrap();
        assert!(!exclude.contains("a.md"), "{exclude}");
    }

    #[test]
    fn a_card_ignored_by_someone_elses_rule_names_that_rule() {
        let dir = temp_repo();
        put(&dir, ".gitignore", ".gavin-root/\n");
        let card = put(&dir, ".gavin-root/plans/a.md", "x");
        let s = status(cwd(&dir), &card).unwrap();
        assert!(s.ignored);
        assert!(!s.decided_by_gavin);
        assert_eq!(s.rule_in, None);
        assert_eq!(s.decided_by.as_deref(), Some(".gitignore:1:.gavin-root/"));
    }

    #[test]
    fn a_negation_is_reported_but_is_not_an_ignore() {
        let dir = temp_repo();
        let card = put(&dir, ".gavin-root/plans/a.md", "x");
        set(cwd(&dir), &card, Some("exclude"), false).unwrap();
        put(&dir, ".gitignore", "!/.gavin-root/plans/a.md\n");
        let s = status(cwd(&dir), &card).unwrap();
        assert!(!s.ignored);
        assert_eq!(s.rule_in.as_deref(), Some("exclude"));
        assert!(s.decided_by.unwrap().ends_with(":!/.gavin-root/plans/a.md"));
    }

    #[test]
    fn untrack_stages_the_removal_and_keeps_the_file() {
        let dir = temp_repo();
        let card = put(&dir, ".gavin-root/plans/a.md", "x");
        git(cwd(&dir), &["add", "."]);
        git(cwd(&dir), &["commit", "-qm", "init"]);
        let s = set(cwd(&dir), &card, Some("exclude"), false).unwrap();
        assert!(s.indexed, "ignoring alone never untracks");
        let s = set(cwd(&dir), &card, Some("exclude"), true).unwrap();
        assert!(!s.indexed);
        assert!(Path::new(&card).exists());
        let staged = git(cwd(&dir), &["diff", "--cached", "--name-status"]);
        assert_eq!(staged.trim(), "D\t.gavin-root/plans/a.md");
    }

    #[test]
    fn a_workspace_root_below_the_toplevel_anchors_from_the_toplevel() {
        let dir = temp_repo();
        let root = dir.path().join("app");
        std::fs::create_dir_all(&root).unwrap();
        let card = put(&dir, "app/.gavin-root/plans/a.md", "x");
        let root = root.to_str().unwrap();
        let s = set(root, &card, Some("gitignore"), false).unwrap();
        assert_eq!(s.pattern, "/app/.gavin-root/plans/**/a.md");
        assert!(s.ignored);
        // `.gitignore` is the toplevel's, not the root's.
        assert!(dir.path().join(".gitignore").exists());
    }

    #[test]
    fn outside_a_repo_reports_no_repo_and_refuses_a_set() {
        let dir = tempfile::tempdir().unwrap();
        let card = put(&dir, ".gavin-root/plans/a.md", "x");
        let root = dir.path().to_str().unwrap();
        assert!(!status(root, &card).unwrap().is_repo);
        assert!(set(root, &card, Some("exclude"), false).is_err());
    }
}
