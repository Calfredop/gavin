//! What one agent run changed, and how to put the checkout back.
//!
//! The Git tab answers "what is in this checkout" (`commands.rs`); this
//! answers "what did THIS run do", which is a different question with a
//! different baseline: the commit the run's checkout sat on when the
//! agent was launched (`CardSession.base_sha`, protocol v26). Everything
//! here takes that sha as given -- resolving it is the app's job at
//! launch, because by the time anyone asks this question the answer is
//! already unrecoverable.
//!
//! Three commands: the summary, one file's diff, and the discard that
//! resets the checkout back to the baseline. All of them run git in the
//! repository ROOT rather than the run's cwd, so every path in and out
//! is root-relative -- `git diff` reports root-relative paths while
//! `ls-files` reports cwd-relative ones, and a mixed list would send the
//! diff view looking for files that are not there.

use serde::{Deserialize, Serialize};

use crate::git::commands::MAX_DIFF_BYTES;
use crate::git::parse::{parse_diff, parse_name_status};
use crate::git::run::{ok, run_git, run_git_ro};
use crate::git::types::{FileDiff, FileEntry};
use crate::trash::trash_path;

/// Untracked files are counted by reading them, so a run that only
/// created files does not report "+0 -0" -- which reads as "changed
/// nothing", the one misreading this whole feature exists to prevent.
/// Anything bigger is counted as a file and not as lines: a 5 MB asset
/// says nothing useful as a line count and reading it says it slowly.
const MAX_UNTRACKED_COUNT_BYTES: u64 = 1024 * 1024;

/// Everything the Changes view renders for one run.
///
/// `notARepo` and `baseMissing` are answers, not errors: a run launched
/// outside a repository and a baseline whose commit is no longer in this
/// checkout are both ordinary states the view has words for, and an
/// `Err` here would only reach the human as a red strip.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RunChanges {
    pub base_sha: String,
    pub not_a_repo: bool,
    /// The baseline commit is not in this checkout any more (a different
    /// worktree, a pruned object). Nothing can be diffed or discarded.
    pub base_missing: bool,
    pub root: Option<String>,
    /// The baseline commit's subject line, for the header.
    pub base_subject: Option<String>,
    /// Tracked changes against the baseline, then untracked files as `?`.
    pub files: Vec<FileEntry>,
    pub added: u32,
    pub removed: u32,
    /// Commits on HEAD that the baseline does not have -- the ones a
    /// discard would drop.
    pub commits: u32,
    /// The peer baseline this window stops at, when a later run was
    /// launched in the same checkout -- see `next_baseline`. `None` is
    /// the ordinary case: nothing was launched here after this run, so
    /// the window runs all the way to the worktree.
    ///
    /// Reported rather than kept private because the caller has to ask
    /// the same question again for a single file's diff, and a bound
    /// resolved twice is a bound that can differ between the list and
    /// the diff under it.
    pub until_sha: Option<String>,
    /// Every peer baseline that DESCENDS from this one -- the runs
    /// launched in this checkout after this run -- nearest first, each
    /// once. Empty for the unbounded question. The nearest is the bound
    /// above; the whole set is what change attribution needs: a peer
    /// launched after the bound is no co-tenant of a bounded window
    /// either, and only git can say which peers those are, because
    /// ancestry is not a string comparison the frontend could make.
    pub later_baselines: Vec<String>,
}

/// What a discard actually did. Shaped like `RemovalReport` in
/// `workspace_delete.rs` and for the same reason: one failed path must
/// not hide the rest, and the human has to be told which.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DiscardReport {
    /// Paths moved to the Trash.
    pub trashed: Vec<String>,
    /// `(path, reason)` for everything that did not go.
    pub failed: Vec<(String, String)>,
}

fn repo_root(cwd: &str) -> Result<Option<String>, String> {
    let top = run_git_ro(cwd, &["rev-parse", "--show-toplevel"])?;
    if top.code != 0 {
        return Ok(None);
    }
    let root = top.stdout_str().trim().to_string();
    Ok(if root.is_empty() { None } else { Some(root) })
}

/// Whether `base` names a commit this checkout still holds. `^{commit}`
/// rather than a bare verify: a sha that resolves to a tree or a blob is
/// not something `git diff <base>` or `git reset --hard <base>` will do
/// anything sensible with.
fn commit_exists(root: &str, base: &str) -> Result<bool, String> {
    Ok(run_git_ro(root, &["rev-parse", "--verify", "-q", &format!("{base}^{{commit}}")])?.code == 0)
}

/// `N files changed, X insertions(+), Y deletions(-)` -- any of the
/// three clauses may be absent (a pure-deletion diff has no insertions
/// clause at all), so each is read by its own suffix rather than by
/// position.
fn parse_shortstat(line: &str) -> (u32, u32) {
    let mut added = 0;
    let mut removed = 0;
    for part in line.split(',') {
        let part = part.trim();
        let Some((count, rest)) = part.split_once(' ') else { continue };
        let Ok(count) = count.parse::<u32>() else { continue };
        if rest.starts_with("insertion") {
            added = count;
        } else if rest.starts_with("deletion") {
            removed = count;
        }
    }
    (added, removed)
}

/// Lines in an untracked file, or 0 for one that is binary, unreadable
/// or over the cap. A file with no trailing newline still counts its
/// last line, the way `git diff` counts it.
fn untracked_line_count(path: &std::path::Path) -> u32 {
    let Ok(meta) = std::fs::metadata(path) else { return 0 };
    if !meta.is_file() || meta.len() > MAX_UNTRACKED_COUNT_BYTES {
        return 0;
    }
    let Ok(bytes) = std::fs::read(path) else { return 0 };
    // git's own binary test: a NUL in the first 8000 bytes.
    if bytes.iter().take(8000).any(|b| *b == 0) {
        return 0;
    }
    if bytes.is_empty() {
        return 0;
    }
    let newlines = bytes.iter().filter(|b| **b == b'\n').count() as u32;
    if bytes.last() == Some(&b'\n') { newlines } else { newlines + 1 }
}

/// The commit `cwd`'s checkout is on right now, or `None` when it is in
/// no repository, HEAD is unborn, or git cannot say. The app's baseline
/// resolver, called once per launch (`baseShaForLaunch`) -- the daemon
/// has its own for the one run it binds by itself (`git_status::head_sha`).
///
/// Full 40 characters and validated as hex: this value is handed back to
/// `git reset --hard` later, and a string git resolves to something
/// else is the one thing that must never get there.
pub fn head_sha(cwd: &str) -> Result<Option<String>, String> {
    let out = run_git_ro(cwd, &["rev-parse", "--verify", "-q", "HEAD"])?;
    if out.code != 0 {
        return Ok(None);
    }
    let sha = out.stdout_str().trim().to_string();
    Ok((sha.len() == 40 && sha.chars().all(|c| c.is_ascii_hexdigit())).then_some(sha))
}

/// Every baseline in `peers` that comes AFTER `base` in this checkout's
/// history, nearest first, each once -- empty when nothing was launched
/// here later. The first is the window's bound (`until_sha`); the rest
/// are the runs a bounded window also leaves out (`later_baselines`).
///
/// This is what makes a run's changes the RUN's. `git diff <base>` in a
/// checkout several agents share answers "what does this tree look like
/// versus that commit", which is every later run's work as well as this
/// one's -- on gavin's own board the oldest finished card claimed 196
/// files, nearly the whole tree. Stopping the window where the next run
/// started hands each card the slice between its own launch and the
/// next.
///
/// "After" is ancestry, never a commit date: a rebase rewrites dates,
/// and a bound taken from a commit that is not a descendant would diff
/// two divergent tips and report the difference between two branches as
/// one card's work. A peer that is not a descendant is simply not a
/// bound -- concurrent branches leave the window open rather than
/// closing it on a guess.
///
/// A peer EQUAL to `base` is no bound either. Two runs launched from the
/// same commit are measured identically, and that is the truth about
/// them: nothing here can say which of them wrote what, and a
/// zero-length window would say they wrote nothing.
fn later_baselines(root: &str, base: &str, peers: &[String]) -> Result<Vec<String>, String> {
    let mut later: Vec<(u32, String)> = Vec::new();
    for peer in peers {
        if peer.is_empty() || peer == base || !commit_exists(root, peer)? {
            continue;
        }
        if later.iter().any(|(_, seen)| seen == peer) {
            continue;
        }
        if run_git_ro(root, &["merge-base", "--is-ancestor", base, peer])?.code != 0 {
            continue;
        }
        let counted = run_git_ro(root, &["rev-list", "--count", &format!("{base}..{peer}")])?;
        if counted.code != 0 {
            continue;
        }
        let Ok(distance) = counted.stdout_str().trim().parse::<u32>() else { continue };
        if distance == 0 {
            continue;
        }
        later.push((distance, peer.clone()));
    }
    // Ties broken by the sha itself, so two peers the same distance away
    // do not make the answer depend on the order the app happened to
    // send them in.
    later.sort();
    Ok(later.into_iter().map(|(_, sha)| sha).collect())
}

/// `peers` is every OTHER baseline recorded against the same checkout,
/// which is what lets this bound the window (`next_baseline`). Pass an
/// empty slice for the unbounded question -- what the checkout looks
/// like versus this baseline -- which is what the per-run Changes view
/// asks.
pub fn run_changes(cwd: &str, base_sha: &str, peers: &[String]) -> Result<RunChanges, String> {
    let mut out = RunChanges { base_sha: base_sha.to_string(), ..Default::default() };
    let Some(root) = repo_root(cwd)? else {
        out.not_a_repo = true;
        return Ok(out);
    };
    out.root = Some(root.clone());
    if !commit_exists(&root, base_sha)? {
        out.base_missing = true;
        return Ok(out);
    }
    out.base_subject = Some(
        ok(run_git_ro(&root, &["log", "-1", "--format=%s", base_sha])?)?.stdout_str().trim().to_string(),
    );

    out.later_baselines = later_baselines(&root, base_sha, peers)?;
    out.until_sha = out.later_baselines.first().cloned();
    let until = out.until_sha.clone();

    // The worktree against the baseline, staged and unstaged together:
    // the question is what the run changed, not what it happened to
    // stage. `-M` so a rename reads as one row rather than as a delete
    // and an add. A bounded window names the peer instead of the
    // worktree, which is the same diff with the later runs left out.
    let mut named_args = vec!["diff", "--name-status", "-M", base_sha];
    let mut stat_args = vec!["diff", "--shortstat", base_sha];
    if let Some(end) = until.as_deref() {
        named_args.push(end);
        stat_args.push(end);
    }
    let named = ok(run_git_ro(&root, &named_args)?)?;
    out.files = parse_name_status(&named.stdout_str());

    let shortstat = ok(run_git_ro(&root, &stat_args)?)?;
    let (added, removed) = parse_shortstat(&shortstat.stdout_str());
    out.added = added;
    out.removed = removed;

    // Untracked files belong to the unbounded question only. `ls-files
    // --others` reports what the tree holds NOW with no baseline in it
    // at all, so it cannot be cut down to a window: handing this run the
    // whole checkout's untracked set is the same misattribution the
    // bound exists to remove, and every run sharing the checkout would
    // get the identical list.
    if until.is_none() {
        let untracked = ok(run_git_ro(&root, &["ls-files", "--others", "--exclude-standard"])?)?;
        for path in untracked.stdout_str().lines().filter(|l| !l.is_empty()) {
            out.added += untracked_line_count(&std::path::Path::new(&root).join(path));
            out.files.push(FileEntry { path: path.to_string(), old_path: None, status: "?".to_string() });
        }
    }
    out.files.sort_by(|a, b| a.path.cmp(&b.path));

    // Commits the baseline does not have. Not `--count base..HEAD` on an
    // unborn HEAD, which fails; and a rail that rebased its branch still
    // gets a truthful count, because this asks what is on HEAD and not
    // in base rather than assuming one descends from the other.
    let end = until.as_deref().unwrap_or("HEAD");
    let revs = run_git_ro(&root, &["rev-list", "--count", &format!("{base_sha}..{end}")])?;
    if revs.code == 0 {
        out.commits = revs.stdout_str().trim().parse().unwrap_or(0);
    }
    Ok(out)
}

/// One file's diff against the baseline. `untracked` takes the
/// `--no-index` route the Git tab already uses for a file git has never
/// seen, since there is no baseline blob to compare it to.
///
/// `until` is the bound `run_changes` resolved for this run, passed back
/// rather than recomputed: the row the human clicked was produced under
/// that bound, and a diff taken under a different one would open a file
/// with hunks the row never counted -- or none at all.
pub fn diff_since(
    cwd: &str,
    base_sha: &str,
    path: &str,
    old_path: Option<&str>,
    untracked: bool,
    until: Option<&str>,
) -> Result<FileDiff, String> {
    let root = repo_root(cwd)?.ok_or_else(|| format!("not a git repository: {cwd}"))?;
    let mut args: Vec<&str> = vec!["diff", "--no-color", "--no-ext-diff", "-U3"];
    if untracked {
        args.extend(["--no-index", "--", "/dev/null", path]);
    } else {
        args.extend(["-M", base_sha]);
        if let Some(end) = until {
            args.push(end);
        }
        args.push("--");
        if let Some(old) = old_path {
            args.push(old);
        }
        args.push(path);
    }
    let out = run_git_ro(&root, &args)?;
    // `--no-index` exits 1 for "differences found"; both codes are fine.
    if out.code != 0 && out.code != 1 {
        return Err(out.stderr.trim().to_string());
    }
    let mut result = FileDiff {
        path: path.to_string(),
        old_path: old_path.map(str::to_string),
        binary: false,
        too_large: false,
        hunks: vec![],
    };
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

/// Puts the checkout back to where the run started: `reset --hard` to
/// the baseline, then the named untracked files to the Trash.
///
/// The order is deliberate. The reset is the act; it either happens or
/// the whole call fails, and nothing has been thrown away yet. The
/// trashing is per-path and best effort afterwards, because a
/// permission error on one new file must not leave the tracked half
/// un-reset with no way to tell how far it got.
///
/// `untracked` is what the human saw and agreed to, not a `git clean`:
/// this never removes a file the summary did not list, never touches
/// anything ignored, and never leaves the repository root.
pub fn discard_run(cwd: &str, base_sha: &str, untracked: &[String]) -> Result<DiscardReport, String> {
    discard_with(cwd, base_sha, untracked, trash_path)
}

/// The body, with the removal injected -- so the tests can prove the
/// reset and the path rules without putting a tempdir in the human's
/// real Trash on every `cargo test`.
fn discard_with(
    cwd: &str,
    base_sha: &str,
    untracked: &[String],
    remove: impl Fn(&str) -> Result<(), String>,
) -> Result<DiscardReport, String> {
    let root = repo_root(cwd)?.ok_or_else(|| format!("not a git repository: {cwd}"))?;
    if !commit_exists(&root, base_sha)? {
        return Err(format!(
            "the commit this run started on ({}) is not in this checkout any more, so there is nothing to reset to",
            &base_sha[..base_sha.len().min(7)]
        ));
    }
    let root_path = std::path::Path::new(&root);
    // Checked BEFORE the reset, so a bad path refuses the whole call
    // rather than being discovered after the tracked half is gone.
    for rel in untracked {
        let joined = root_path.join(rel);
        if std::path::Path::new(rel).is_absolute() || !joined.starts_with(root_path) || rel.split('/').any(|c| c == "..") {
            return Err(format!("refusing to remove a path outside the checkout: {rel}"));
        }
    }
    ok(run_git(&root, &["reset", "--hard", base_sha], None)?)?;

    let mut report = DiscardReport::default();
    for rel in untracked {
        let joined = root_path.join(rel);
        if !joined.exists() {
            // Already gone -- the reset removed it, or the agent did.
            continue;
        }
        match remove(&joined.to_string_lossy()) {
            Ok(()) => report.trashed.push(rel.clone()),
            Err(e) => report.failed.push((rel.clone(), e)),
        }
    }
    Ok(report)
}

#[tauri::command]
pub fn git_head_sha(cwd: String) -> Result<Option<String>, String> {
    head_sha(&cwd)
}

#[tauri::command]
pub fn git_run_changes(
    cwd: String,
    base_sha: String,
    peers: Option<Vec<String>>,
) -> Result<RunChanges, String> {
    run_changes(&cwd, &base_sha, &peers.unwrap_or_default())
}

#[tauri::command]
pub fn git_diff_since(
    cwd: String,
    base_sha: String,
    path: String,
    old_path: Option<String>,
    untracked: bool,
    until_sha: Option<String>,
) -> Result<FileDiff, String> {
    diff_since(&cwd, &base_sha, &path, old_path.as_deref(), untracked, until_sha.as_deref())
}

#[tauri::command]
pub fn git_discard_run(
    cwd: String,
    base_sha: String,
    untracked: Vec<String>,
) -> Result<DiscardReport, String> {
    discard_run(&cwd, &base_sha, &untracked)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::commands::testutil::{cwd, git, temp_repo, write};

    /// Everything the run did, whether it committed it or not -- the
    /// question is what changed since the agent started, and an agent
    /// that commits half its work has not changed less.
    #[test]
    fn changes_cover_committed_edits_uncommitted_edits_and_new_files() {
        let dir = temp_repo();
        let base = git(cwd(&dir), &["rev-parse", "HEAD"]).trim().to_string();

        write(&dir, "f.txt", "alpha\nBETA\ngamma\ndelta\nepsilon\n");
        git(cwd(&dir), &["commit", "-qam", "the run's commit"]);
        write(&dir, "f.txt", "alpha\nBETA\nGAMMA\ndelta\nepsilon\n");
        write(&dir, "new.txt", "one\ntwo\n");

        let changes = run_changes(cwd(&dir), &base, &[]).unwrap();
        assert!(!changes.not_a_repo && !changes.base_missing);
        assert_eq!(changes.base_subject.as_deref(), Some("base"));
        assert_eq!(
            changes.files.iter().map(|f| (f.path.as_str(), f.status.as_str())).collect::<Vec<_>>(),
            vec![("f.txt", "M"), ("new.txt", "?")]
        );
        assert_eq!(changes.commits, 1, "the commit the run made is one a discard would drop");
        // Two changed lines in f.txt plus the two lines of the new file:
        // a run that only creates files must not report +0.
        assert_eq!((changes.added, changes.removed), (4, 2));
    }

    /// The bug this bound exists for: several agents share one checkout,
    /// so `git diff <base>` hands the earliest run every later run's work
    /// too. Every card then looks like it touched everything, and the
    /// Review tab's clustering collapses into one group holding the board.
    #[test]
    fn a_later_baseline_in_the_same_checkout_ends_the_window() {
        let dir = temp_repo();
        let base = git(cwd(&dir), &["rev-parse", "HEAD"]).trim().to_string();
        write(&dir, "mine.txt", "one\n");
        git(cwd(&dir), &["add", "-A"]);
        git(cwd(&dir), &["commit", "-qm", "this run's work"]);
        let peer = git(cwd(&dir), &["rev-parse", "HEAD"]).trim().to_string();
        write(&dir, "theirs.txt", "two\n");
        git(cwd(&dir), &["add", "-A"]);
        git(cwd(&dir), &["commit", "-qm", "the next run's work"]);
        write(&dir, "loose.txt", "and an untracked one\n");

        let changes = run_changes(cwd(&dir), &base, &[peer.clone()]).unwrap();
        assert_eq!(changes.until_sha.as_deref(), Some(peer.as_str()));
        assert_eq!(
            changes.files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(),
            vec!["mine.txt"],
            "the later run's file and the checkout's untracked files are not this run's"
        );
        assert_eq!(changes.commits, 1);
    }

    #[test]
    fn a_baseline_older_than_this_one_is_not_a_bound() {
        let dir = temp_repo();
        let older = git(cwd(&dir), &["rev-parse", "HEAD"]).trim().to_string();
        write(&dir, "before.txt", "one\n");
        git(cwd(&dir), &["add", "-A"]);
        git(cwd(&dir), &["commit", "-qm", "before this run"]);
        let base = git(cwd(&dir), &["rev-parse", "HEAD"]).trim().to_string();
        write(&dir, "mine.txt", "two\n");

        let changes = run_changes(cwd(&dir), &base, &[older]).unwrap();
        assert_eq!(changes.until_sha, None);
        assert_eq!(changes.files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), vec!["mine.txt"]);
    }

    #[test]
    fn the_nearest_later_baseline_wins() {
        let dir = temp_repo();
        let base = git(cwd(&dir), &["rev-parse", "HEAD"]).trim().to_string();
        write(&dir, "mine.txt", "one\n");
        git(cwd(&dir), &["add", "-A"]);
        git(cwd(&dir), &["commit", "-qm", "this run"]);
        let near = git(cwd(&dir), &["rev-parse", "HEAD"]).trim().to_string();
        write(&dir, "next.txt", "two\n");
        git(cwd(&dir), &["add", "-A"]);
        git(cwd(&dir), &["commit", "-qm", "the run after that"]);
        let far = git(cwd(&dir), &["rev-parse", "HEAD"]).trim().to_string();

        // Sent far-first, so the answer cannot come from the order.
        let changes = run_changes(cwd(&dir), &base, &[far, near.clone()]).unwrap();
        assert_eq!(changes.until_sha.as_deref(), Some(near.as_str()));
        assert_eq!(changes.files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), vec!["mine.txt"]);
    }

    /// Attribution's co-tenant rule needs EVERY later run, not only the
    /// nearest: a peer launched after the bound is no co-tenant of this
    /// window either, and only git can say which peers those are. Sent
    /// in a scrambled order with this run's own commit and an older peer
    /// mixed in, so the answer cannot come from the order or from a
    /// string comparison.
    #[test]
    fn every_later_baseline_is_reported_nearest_first() {
        let dir = temp_repo();
        let older = git(cwd(&dir), &["rev-parse", "HEAD"]).trim().to_string();
        write(&dir, "before.txt", "zero\n");
        git(cwd(&dir), &["add", "-A"]);
        git(cwd(&dir), &["commit", "-qm", "before this run"]);
        let base = git(cwd(&dir), &["rev-parse", "HEAD"]).trim().to_string();
        write(&dir, "mine.txt", "one\n");
        git(cwd(&dir), &["add", "-A"]);
        git(cwd(&dir), &["commit", "-qm", "this run"]);
        let near = git(cwd(&dir), &["rev-parse", "HEAD"]).trim().to_string();
        write(&dir, "next.txt", "two\n");
        git(cwd(&dir), &["add", "-A"]);
        git(cwd(&dir), &["commit", "-qm", "the run after that"]);
        let far = git(cwd(&dir), &["rev-parse", "HEAD"]).trim().to_string();

        let peers = [far.clone(), older, base.clone(), near.clone(), far.clone()];
        let changes = run_changes(cwd(&dir), &base, &peers).unwrap();
        assert_eq!(changes.until_sha.as_deref(), Some(near.as_str()));
        assert_eq!(
            changes.later_baselines,
            vec![near, far],
            "nearest first, each once; the older peer and this run's own commit are not later"
        );
        // The unbounded question has no later peers by construction.
        assert!(run_changes(cwd(&dir), &base, &[]).unwrap().later_baselines.is_empty());
    }

    /// A run launched on a branch this one never touched is not "after"
    /// it. Diffing the two tips would report the difference between two
    /// branches as this card's work.
    #[test]
    fn a_baseline_on_a_divergent_branch_is_not_a_bound() {
        let dir = temp_repo();
        let fork = git(cwd(&dir), &["rev-parse", "HEAD"]).trim().to_string();
        git(cwd(&dir), &["checkout", "-q", "-b", "elsewhere"]);
        write(&dir, "elsewhere.txt", "theirs\n");
        git(cwd(&dir), &["add", "-A"]);
        git(cwd(&dir), &["commit", "-qm", "another branch"]);
        let sibling = git(cwd(&dir), &["rev-parse", "HEAD"]).trim().to_string();

        // Back to the fork point and off the other way, so neither
        // baseline descends from the other.
        git(cwd(&dir), &["checkout", "-q", "-b", "here", &fork]);
        write(&dir, "here.txt", "ours\n");
        git(cwd(&dir), &["add", "-A"]);
        git(cwd(&dir), &["commit", "-qm", "this branch"]);
        let base = git(cwd(&dir), &["rev-parse", "HEAD"]).trim().to_string();
        write(&dir, "mine.txt", "mine\n");

        let changes = run_changes(cwd(&dir), &base, &[sibling]).unwrap();
        assert_eq!(changes.until_sha, None);
        assert_eq!(changes.files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), vec!["mine.txt"]);
    }

    /// Two runs launched from the same commit are measured identically,
    /// and that IS the truth about them -- nothing here can say which of
    /// them wrote what. A zero-length window would say they wrote nothing.
    #[test]
    fn a_peer_launched_from_the_same_commit_is_not_a_bound() {
        let dir = temp_repo();
        let base = git(cwd(&dir), &["rev-parse", "HEAD"]).trim().to_string();
        write(&dir, "mine.txt", "one\n");

        let changes = run_changes(cwd(&dir), &base, &[base.clone()]).unwrap();
        assert_eq!(changes.until_sha, None);
        assert_eq!(changes.files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), vec!["mine.txt"]);
    }

    /// The row the human clicked was produced under the bound, so the
    /// diff it opens has to be too -- otherwise a file the next run also
    /// edited opens showing that run's hunks under this card's name.
    #[test]
    fn a_bounded_files_diff_stops_at_the_bound() {
        let dir = temp_repo();
        let base = git(cwd(&dir), &["rev-parse", "HEAD"]).trim().to_string();
        write(&dir, "f.txt", "alpha\nBETA\ngamma\ndelta\nepsilon\n");
        git(cwd(&dir), &["commit", "-qam", "this run's edit"]);
        let peer = git(cwd(&dir), &["rev-parse", "HEAD"]).trim().to_string();
        write(&dir, "f.txt", "alpha\nBETA\nGAMMA\ndelta\nepsilon\n");
        git(cwd(&dir), &["commit", "-qam", "the next run's edit"]);

        let diff = diff_since(cwd(&dir), &base, "f.txt", None, false, Some(&peer)).unwrap();
        let added: Vec<&str> = diff
            .hunks
            .iter()
            .flat_map(|h| h.lines.iter())
            .filter(|l| l.kind == "add")
            .map(|l| l.text.as_str())
            .collect();
        assert_eq!(added, vec!["BETA"], "GAMMA belongs to the run after this one");
    }

    #[test]
    fn an_unchanged_checkout_reports_nothing_at_all() {
        let dir = temp_repo();
        let base = git(cwd(&dir), &["rev-parse", "HEAD"]).trim().to_string();
        let changes = run_changes(cwd(&dir), &base, &[]).unwrap();
        assert!(changes.files.is_empty());
        assert_eq!((changes.added, changes.removed, changes.commits), (0, 0, 0));
    }

    /// A baseline whose commit this checkout does not hold -- the rail
    /// was rebound to another worktree, or the objects were pruned. An
    /// answer the view has words for, never an error strip.
    #[test]
    fn a_baseline_missing_from_this_checkout_is_an_answer() {
        let dir = temp_repo();
        let changes = run_changes(cwd(&dir), "0123456789012345678901234567890123456789", &[]).unwrap();
        assert!(changes.base_missing);
        assert!(changes.files.is_empty());
    }

    #[test]
    fn a_cwd_outside_any_repository_says_so() {
        let outside = tempfile::tempdir().unwrap();
        let path = outside.path().to_str().unwrap();
        if run_git_ro(path, &["rev-parse", "--show-toplevel"]).unwrap().code == 0 {
            return; // a temp dir inside a checkout proves nothing
        }
        let changes = run_changes(path, "0123456789012345678901234567890123456789", &[]).unwrap();
        assert!(changes.not_a_repo);
    }

    /// The diff a file row opens is against the BASELINE, so it shows
    /// the run's committed and uncommitted edits as one change -- which
    /// is the whole difference between this view and the Git tab.
    #[test]
    fn a_files_diff_spans_the_runs_commits() {
        let dir = temp_repo();
        let base = git(cwd(&dir), &["rev-parse", "HEAD"]).trim().to_string();
        write(&dir, "f.txt", "alpha\nBETA\ngamma\ndelta\nepsilon\n");
        git(cwd(&dir), &["commit", "-qam", "committed half"]);
        write(&dir, "f.txt", "alpha\nBETA\nGAMMA\ndelta\nepsilon\n");

        let diff = diff_since(cwd(&dir), &base, "f.txt", None, false, None).unwrap();
        let added: Vec<&str> =
            diff.hunks.iter().flat_map(|h| h.lines.iter()).filter(|l| l.kind == "add").map(|l| l.text.as_str()).collect();
        assert_eq!(added, vec!["BETA", "GAMMA"]);
    }

    #[test]
    fn an_untracked_files_diff_is_all_additions() {
        let dir = temp_repo();
        let base = git(cwd(&dir), &["rev-parse", "HEAD"]).trim().to_string();
        write(&dir, "new.txt", "one\ntwo\n");
        let diff = diff_since(cwd(&dir), &base, "new.txt", None, true, None).unwrap();
        assert_eq!(diff.hunks.len(), 1);
        assert!(diff.hunks[0].lines.iter().all(|l| l.kind == "add"));
    }

    #[test]
    fn discarding_drops_the_runs_commits_and_edits_and_removes_only_named_files() {
        let dir = temp_repo();
        let base = git(cwd(&dir), &["rev-parse", "HEAD"]).trim().to_string();
        write(&dir, "f.txt", "alpha\nBETA\ngamma\ndelta\nepsilon\n");
        git(cwd(&dir), &["commit", "-qam", "the run's commit"]);
        write(&dir, "f.txt", "alpha\nBETA\nGAMMA\ndelta\nepsilon\n");
        write(&dir, "new.txt", "one\n");
        write(&dir, "kept.txt", "mine\n");

        let removed = std::cell::RefCell::new(Vec::new());
        let report = discard_with(cwd(&dir), &base, &["new.txt".to_string()], |p| {
            removed.borrow_mut().push(p.to_string());
            std::fs::remove_file(p).map_err(|e| e.to_string())
        })
        .unwrap();

        assert_eq!(report.trashed, vec!["new.txt".to_string()]);
        assert!(report.failed.is_empty());
        assert_eq!(git(cwd(&dir), &["rev-parse", "HEAD"]).trim(), base, "the run's commit is off the branch");
        assert_eq!(
            std::fs::read_to_string(dir.path().join("f.txt")).unwrap(),
            "alpha\nbeta\ngamma\ndelta\nepsilon\n"
        );
        // Untracked and NOT named: a discard removes what the human saw
        // listed, never everything git happens to call untracked.
        assert!(dir.path().join("kept.txt").exists());
        assert_eq!(removed.borrow().len(), 1);
    }

    /// The reset is the act and the removals are the consequence, so a
    /// path that must not be touched refuses the whole call while the
    /// tracked half is still intact.
    #[test]
    fn a_path_outside_the_checkout_refuses_before_anything_is_reset() {
        let dir = temp_repo();
        let base = git(cwd(&dir), &["rev-parse", "HEAD"]).trim().to_string();
        write(&dir, "f.txt", "changed\n");

        for bad in ["../outside.txt", "/etc/hosts", "sub/../../escape.txt"] {
            let err = discard_with(cwd(&dir), &base, &[bad.to_string()], |_| Ok(())).unwrap_err();
            assert!(err.contains("outside the checkout"), "{bad}: {err}");
        }
        assert_eq!(std::fs::read_to_string(dir.path().join("f.txt")).unwrap(), "changed\n");
    }

    #[test]
    fn discarding_against_a_missing_baseline_refuses_rather_than_resetting() {
        let dir = temp_repo();
        write(&dir, "f.txt", "changed\n");
        let err =
            discard_with(cwd(&dir), "0123456789012345678901234567890123456789", &[], |_| Ok(())).unwrap_err();
        assert!(err.contains("not in this checkout"), "{err}");
        assert_eq!(std::fs::read_to_string(dir.path().join("f.txt")).unwrap(), "changed\n");
    }

    #[test]
    fn head_sha_answers_a_full_sha_in_a_repo_and_nothing_outside_one() {
        let dir = temp_repo();
        let sha = head_sha(cwd(&dir)).unwrap().unwrap();
        assert_eq!(sha, git(cwd(&dir), &["rev-parse", "HEAD"]).trim());
        assert_eq!(sha.len(), 40);

        let outside = tempfile::tempdir().unwrap();
        let path = outside.path().to_str().unwrap();
        if run_git_ro(path, &["rev-parse", "--show-toplevel"]).unwrap().code != 0 {
            assert_eq!(head_sha(path).unwrap(), None);
        }
    }

    /// An unborn HEAD is a repository with no commit in it -- a fresh
    /// `git init`, which is exactly where a first card run often starts.
    /// `rev-parse HEAD` prints the literal string "HEAD" there, so a
    /// less careful reader would record that as the baseline.
    #[test]
    fn an_unborn_head_has_no_baseline() {
        let dir = tempfile::tempdir().unwrap();
        let path = cwd(&dir);
        git(path, &["init", "-q", "-b", "main"]);
        assert_eq!(head_sha(path).unwrap(), None);
    }

    #[test]
    fn shortstat_clauses_are_read_by_name_not_by_position() {
        assert_eq!(parse_shortstat(" 3 files changed, 12 insertions(+), 4 deletions(-)"), (12, 4));
        assert_eq!(parse_shortstat(" 1 file changed, 7 deletions(-)"), (0, 7));
        assert_eq!(parse_shortstat(" 1 file changed, 2 insertions(+)"), (2, 0));
        assert_eq!(parse_shortstat(""), (0, 0));
    }
}
