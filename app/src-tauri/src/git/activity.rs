//! The activity calendar's git half (`tbd-feat-activity-calendar.md`):
//! every commit on any ref since a time, with the files it changed, and
//! every push this checkout made, read off the remote-tracking reflogs.
//! Read-only through `run_git_ro_capped`, so an ssh workspace's history is
//! read on its host. Nothing here records anything: the calendar draws
//! what git already keeps.

use serde::Serialize;

use crate::git::run::{off_main_thread, ok, run_git_ro, run_git_ro_capped};

/// One commit on the calendar. `at` is the AUTHOR date in UTC unix
/// seconds -- when the work was done, which a rebase or a cherry-pick
/// leaves alone and the committer date does not.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityCommit {
    pub sha: String,
    pub at: i64,
    pub author: String,
    pub subject: String,
    /// Paths relative to the repository root. Empty for a merge: git
    /// shows a merge no diff of its own, so its files are counted on the
    /// commits that made them.
    pub files: Vec<String>,
}

/// One `git push` that moved a remote-tracking ref. `at` is the reflog
/// entry's time; `old_sha` is the sha the ref held before, absent for
/// the push that created it (or when the reflog has expired past it).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityPush {
    pub at: i64,
    /// The ref as git names it under `refs/remotes/`: `origin/main`.
    pub remote_ref: String,
    pub old_sha: Option<String>,
    pub new_sha: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitActivity {
    /// Newest first, as git walks them; one per sha.
    pub commits: Vec<ActivityCommit>,
    /// Newest first within each ref.
    pub pushes: Vec<ActivityPush>,
}

/// The reflog message git writes for a remote-tracking ref a push moved.
const PUSH_SUBJECT: &str = "update by push";

/// How much of one read is kept locally. Far past a year of any real
/// history; a read that reaches it pages on like an ssh one cut at the
/// wire ceiling, rather than ending in the middle of a record.
const STDOUT_CAP: usize = 64 * 1024 * 1024;

#[tauri::command]
pub async fn git_activity(cwd: String, since: i64) -> Result<GitActivity, String> {
    off_main_thread(move || activity(&cwd, since)).await
}

pub fn activity(cwd: &str, since: i64) -> Result<GitActivity, String> {
    if run_git_ro(cwd, &["rev-parse", "--git-dir"])?.code != 0 {
        return Ok(GitActivity::default());
    }
    Ok(GitActivity { commits: commits(cwd, since)?, pushes: pushes(cwd, since)? })
}

/// Below this, git's date parser does not read `@<n>` as a timestamp
/// (`--since=@0` keeps nothing), so a `since` that small walks everything
/// and the filter below does the cutting alone.
const SINCE_PARSES_FROM: i64 = 100_000_000;

fn commits(cwd: &str, since: i64) -> Result<Vec<ActivityCommit>, String> {
    let since_arg = format!("--since=@{since}");
    let mut args = vec!["log", "--all", "-z", "--name-only", "--format=%x1e%H%x1f%at%x1f%an%x1f%s"];
    if since >= SINCE_PARSES_FROM {
        args.push(&since_arg);
    }
    let records = records(cwd, &args)?;
    let mut seen = std::collections::HashSet::new();
    Ok(records
        .iter()
        .filter_map(|r| parse_commit(r))
        // `--since` prunes the walk by COMMITTER date; a commit counts at
        // its author date, which a rebase can leave outside the window.
        .filter(|c| c.at >= since && seen.insert(c.sha.clone()))
        .collect())
}

fn pushes(cwd: &str, since: i64) -> Result<Vec<ActivityPush>, String> {
    let records = records(cwd, &["log", "-g", "--remotes", "-z", "--date=unix", "--format=%x1e%gD%x1f%H%x1f%gs"])?;
    Ok(parse_pushes(&records).into_iter().filter(|p| p.at >= since).collect())
}

/// `args`' stdout as its `\x1e`-led records. One read, unless the output
/// was cut -- an ssh host stops at the wire ceiling -- and then the
/// complete records are kept and the rest asked for again past them with
/// `--skip`, which counts the same commits or reflog entries the records
/// are. A single record bigger than a whole read is kept as far as it
/// came, so the walk always moves on.
fn records(cwd: &str, args: &[&str]) -> Result<Vec<String>, String> {
    let mut out: Vec<String> = Vec::new();
    loop {
        let skip = format!("--skip={}", out.len());
        let mut argv = args.to_vec();
        argv.push(&skip);
        let read = run_git_ro_capped(cwd, &argv, STDOUT_CAP)?;
        let cut = read.wire_truncated || read.stdout.len() > STDOUT_CAP;
        let text = ok(read)?.stdout_str();
        let mut got: Vec<String> = text.split('\x1e').filter(|r| !r.is_empty()).map(str::to_string).collect();
        if !cut {
            out.extend(got);
            return Ok(out);
        }
        let partial = got.pop();
        if got.is_empty() {
            match partial {
                Some(partial) => out.push(partial),
                None => return Ok(out),
            }
        }
        out.extend(got);
    }
}

/// `sha \x1f at \x1f author \x1f subject \0` and then, after a newline,
/// the changed paths each ended by a NUL (`-z`, so no path is quoted).
fn parse_commit(record: &str) -> Option<ActivityCommit> {
    let (header, rest) = record.split_once('\0').unwrap_or((record, ""));
    let mut fields = header.splitn(4, '\x1f');
    let sha = fields.next()?.trim().to_string();
    let at = fields.next()?.trim().parse().ok()?;
    let author = fields.next()?.to_string();
    let subject = fields.next().unwrap_or_default().to_string();
    if sha.is_empty() {
        return None;
    }
    let files = rest
        .split('\0')
        .map(|p| p.trim_start_matches('\n'))
        .filter(|p| !p.is_empty())
        .map(str::to_string)
        .collect();
    Some(ActivityCommit { sha, at, author, subject, files })
}

/// `refs/remotes/<r>@{<unix>} \x1f sha \x1f subject`, every remote-tracking
/// reflog entry newest first within its ref. A push's `old_sha` is the
/// entry just older than it on the same ref, whatever moved it then -- a
/// fetch counts -- so it is read off the whole list before the pushes are
/// picked out of it.
fn parse_pushes(records: &[String]) -> Vec<ActivityPush> {
    let entries: Vec<(String, i64, String, String)> = records
        .iter()
        .filter_map(|r| {
            let mut fields = r.trim_end_matches(['\0', '\n']).splitn(3, '\x1f');
            let selector = fields.next()?;
            let sha = fields.next()?.trim().to_string();
            let subject = fields.next().unwrap_or_default().trim().to_string();
            let (name, at) = selector.rsplit_once("@{")?;
            let at = at.strip_suffix('}')?.parse().ok()?;
            let name = name.strip_prefix("refs/remotes/")?.to_string();
            Some((name, at, sha, subject))
        })
        .collect();
    entries
        .iter()
        .enumerate()
        .filter(|(_, (_, _, _, subject))| subject == PUSH_SUBJECT)
        .map(|(i, (name, at, sha, _))| ActivityPush {
            at: *at,
            remote_ref: name.clone(),
            old_sha: entries.get(i + 1).filter(|(next, ..)| next == name).map(|(_, _, sha, _)| sha.clone()),
            new_sha: sha.clone(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::commands::testutil::{cwd, git, temp_repo, write};

    fn commit_at(dir: &tempfile::TempDir, file: &str, subject: &str, date: &str) {
        if let Some(parent) = std::path::Path::new(file).parent() {
            std::fs::create_dir_all(dir.path().join(parent)).unwrap();
        }
        write(dir, file, subject);
        git(cwd(dir), &["add", file]);
        let out = crate::program::command("git")
            .args(["commit", "-q", "-m", subject])
            .current_dir(cwd(dir))
            .env("GIT_AUTHOR_DATE", date)
            .env("GIT_COMMITTER_DATE", date)
            .output()
            .unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    }

    fn sha(dir: &tempfile::TempDir, rev: &str) -> String {
        git(cwd(dir), &["rev-parse", rev]).trim().to_string()
    }

    /// Two branches, a merge, two pushes, and a `since` that leaves the
    /// first commit out. The base commit `temp_repo` makes is dated now,
    /// so the dated history is built on a fresh orphan branch instead.
    #[test]
    fn a_repo_with_a_bare_remote_answers_its_commits_files_and_pushes() {
        let dir = temp_repo();
        let remote = tempfile::tempdir().unwrap();
        git(cwd(&remote), &["init", "-q", "--bare"]);
        git(cwd(&dir), &["checkout", "-q", "--orphan", "dated"]);
        git(cwd(&dir), &["rm", "-q", "-r", "--cached", "."]);
        git(cwd(&dir), &["branch", "-q", "-D", "main"]);
        git(cwd(&dir), &["remote", "add", "origin", cwd(&remote)]);

        // 2026-01-01T09:00:00Z, written in +02:00: `at` must be UTC.
        commit_at(&dir, "old.txt", "too old", "2026-01-01T11:00:00+02:00");
        commit_at(&dir, "a.txt", "first in window", "2026-02-01T10:00:00Z");
        git(cwd(&dir), &["push", "-q", "origin", "dated"]);
        let first_push = sha(&dir, "HEAD");
        git(cwd(&dir), &["checkout", "-q", "-b", "feat"]);
        commit_at(&dir, "dir with space/b é.txt", "on feat", "2026-02-02T10:00:00Z");
        git(cwd(&dir), &["checkout", "-q", "dated"]);
        commit_at(&dir, "c.txt", "on dated", "2026-02-03T10:00:00Z");
        let merge = crate::program::command("git")
            .args(["merge", "-q", "--no-ff", "feat", "-m", "merge feat"])
            .current_dir(cwd(&dir))
            .env("GIT_AUTHOR_DATE", "2026-02-04T10:00:00Z")
            .env("GIT_COMMITTER_DATE", "2026-02-04T10:00:00Z")
            .output()
            .unwrap();
        assert!(merge.status.success(), "{}", String::from_utf8_lossy(&merge.stderr));
        git(cwd(&dir), &["push", "-q", "origin", "dated"]);
        let second_push = sha(&dir, "HEAD");

        let jan_15 = 1_768_435_200; // 2026-01-15T00:00:00Z
        let got = activity(cwd(&dir), jan_15).unwrap();

        let subjects: Vec<&str> = got.commits.iter().map(|c| c.subject.as_str()).collect();
        assert_eq!(subjects.len(), 4, "the commit before `since` is cut off: {subjects:?}");
        assert!(!subjects.contains(&"too old"));
        for s in ["first in window", "on feat", "on dated", "merge feat"] {
            assert!(subjects.contains(&s), "{s} is on a ref: {subjects:?}");
        }
        let by = |s: &str| got.commits.iter().find(|c| c.subject == s).unwrap();
        assert_eq!(by("first in window").at, 1_769_940_000);
        assert_eq!(by("first in window").files, vec!["a.txt"]);
        assert_eq!(by("on feat").files, vec!["dir with space/b é.txt"], "an odd path comes through unquoted");
        assert!(by("merge feat").files.is_empty(), "a merge's files are its parents'");
        assert_eq!(by("on dated").author, "Test User");
        assert_eq!(by("merge feat").sha, second_push);
        let all = activity(cwd(&dir), 0).unwrap();
        assert_eq!(all.commits.iter().find(|c| c.subject == "too old").unwrap().at, 1_767_258_000, "+02:00 read as UTC");

        assert_eq!(got.pushes.len(), 2, "{:?}", got.pushes);
        assert_eq!(got.pushes[0].remote_ref, "origin/dated");
        assert_eq!(got.pushes[0].new_sha, second_push);
        assert_eq!(got.pushes[0].old_sha.as_deref(), Some(first_push.as_str()), "the range the second push moved");
        assert_eq!(got.pushes[1].new_sha, first_push);
        assert_eq!(got.pushes[1].old_sha, None, "the push that created the ref moved it from nothing");
        assert!(got.pushes.iter().all(|p| p.at >= jan_15));
        let future = activity(cwd(&dir), 4_000_000_000).unwrap();
        assert!(future.pushes.is_empty() && future.commits.is_empty());
    }

    #[test]
    fn a_folder_that_is_not_a_repo_answers_empty_lists() {
        let dir = tempfile::tempdir().unwrap();
        if run_git_ro(cwd(&dir), &["rev-parse", "--git-dir"]).unwrap().code != 0 {
            assert_eq!(activity(cwd(&dir), 0).unwrap(), GitActivity::default());
        }
    }

    #[test]
    fn a_repo_with_no_commits_answers_empty_lists() {
        let dir = tempfile::tempdir().unwrap();
        git(cwd(&dir), &["init", "-q", "-b", "main"]);
        assert_eq!(activity(cwd(&dir), 0).unwrap(), GitActivity::default());
    }

    /// The fetch between two pushes is what the second push's range
    /// starts from, though it is not itself a push.
    #[test]
    fn a_push_after_a_fetch_moved_the_ref_starts_from_the_fetched_sha() {
        let records: Vec<String> = [
            "refs/remotes/origin/main@{300}\x1fccc\x1fupdate by push\0",
            "refs/remotes/origin/main@{200}\x1fbbb\x1ffetch: fast-forward\0",
            "refs/remotes/origin/main@{100}\x1faaa\x1fupdate by push\0",
            "refs/remotes/origin/feat@{250}\x1fddd\x1fupdate by push\0",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();

        let pushes = parse_pushes(&records);

        assert_eq!(
            pushes.iter().map(|p| (p.remote_ref.as_str(), p.at, p.old_sha.as_deref(), p.new_sha.as_str())).collect::<Vec<_>>(),
            vec![
                ("origin/main", 300, Some("bbb"), "ccc"),
                ("origin/main", 100, None, "aaa"),
                ("origin/feat", 250, None, "ddd"),
            ]
        );
    }
}
