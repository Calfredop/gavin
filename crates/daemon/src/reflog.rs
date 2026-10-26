//! The Workspace log's git entries (v79): new reflog lines, read when the
//! repository's reflogs change.
//!
//! Read off the reflog FILES rather than through `git log -g`: no process,
//! no lock, and a byte offset is a cursor nothing else can give. The files
//! are git's own record of every commit, checkout, merge, pull, rebase and
//! reset -- `<common>/logs/HEAD` for the main checkout and
//! `<common>/worktrees/<name>/logs/HEAD` for each linked one, rail
//! worktrees included -- and of every push, in the remote-tracking reflogs
//! under `<common>/logs/refs/remotes/`. Those live once per repository, so
//! a push made from any worktree is one line in one file and is logged
//! once.
//!
//! The watch is the daemon's own and runs beside each workspace's `.gavin*`
//! watch, for as long as it does. It is not `git_watch.rs`'s: that one
//! watches a worktree for an ssh desk and runs only while one asks, where
//! this has to see every workspace's git, local ones above all. It watches
//! `logs/` and `worktrees/` inside the common git dir and reads nothing
//! but reflogs, so `git status` churn on the index never wakes it twice.
//!
//! A cursor per reflog (`workspace_log_reflogs` in `kanban.sqlite`) keeps
//! the byte offset read up to, the last line read and the branch HEAD was
//! on after it, so nothing is logged twice -- not across wakes, not across
//! restarts, and not by the second daemon sharing the file, which reads
//! and advances the same cursor inside the same IMMEDIATE transaction. A
//! reflog that shrank (`git reflog expire`, a gc) is found again by its
//! last line, or failing that by its time.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use protocol::workspace_log::{LogEntry, LogKind, LogPayload};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};

/// How long a burst of reflog writes is let settle. A rebase writes a line
/// per pick; one read after it is enough.
const REFLOG_DEBOUNCE: std::time::Duration = std::time::Duration::from_millis(400);

/// The table, created on open (`KanbanStore::open`). A row with an empty
/// `path` marks a workspace whose reflogs have been looked at once: until
/// then every reflog is taken from its end, because the log starts empty
/// rather than with a repository's whole history. After it, a reflog seen
/// for the first time -- a worktree just added, a branch pushed for the
/// first time -- is read from its first line.
pub const SCHEMA: &str = "
    CREATE TABLE IF NOT EXISTS workspace_log_reflogs (
        workspace_id TEXT NOT NULL,
        path TEXT NOT NULL,
        offset INTEGER NOT NULL,
        last_line TEXT,
        branch TEXT,
        PRIMARY KEY (workspace_id, path)
    );
";

/// One reflog line: `<old> <new> <name> <<email>> <unix> <tz>\t<message>`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReflogLine {
    pub old: String,
    pub new: String,
    pub at: i64,
    pub message: String,
}

pub fn parse_line(line: &str) -> Option<ReflogLine> {
    let (head, message) = line.split_once('\t').unwrap_or((line, ""));
    let mut words = head.split(' ');
    let old = words.next()?.to_string();
    let new = words.next()?.to_string();
    // The identity can hold spaces; the time is the second word from the
    // end, before the zone.
    let mut tail = head.rsplitn(3, ' ');
    let _zone = tail.next()?;
    let at = tail.next()?.parse().ok()?;
    Some(ReflogLine { old, new, at, message: message.trim_end().to_string() })
}

/// What a HEAD reflog line is, and the part of its message worth showing.
/// None for a line that is not one of the log's kinds: a rebase's
/// intermediate picks, a worktree's creation, a reset that moved nothing.
pub fn head_kind(line: &ReflogLine) -> Option<(LogKind, String)> {
    let (action, rest) = line.message.split_once(": ").unwrap_or((line.message.as_str(), ""));
    let rest = rest.to_string();
    let verb = action.split_whitespace().next()?;
    // `rebase (pick)`, `pull --rebase (finish)`: a sequence is one entry,
    // written when it finishes.
    let step = action.find('(').map(|i| action[i..].trim());
    let finished = || step.is_none_or(|s| s == "(finish)");
    let kind = match verb {
        "commit" if action.contains("(merge)") => LogKind::GitMerge,
        "commit" | "cherry-pick" | "am" | "revert" => LogKind::GitCommit,
        "checkout" => LogKind::GitCheckout,
        "merge" => LogKind::GitMerge,
        "pull" if finished() => LogKind::GitPull,
        "rebase" if step == Some("(finish)") => LogKind::GitRebase,
        "reset" if line.old != line.new => LogKind::GitReset,
        _ => return None,
    };
    let detail = match kind {
        // `merge feat: Fast-forward` keeps what was merged.
        LogKind::GitMerge if verb == "merge" => line.message.trim_start_matches("merge ").to_string(),
        _ => rest,
    };
    Some((kind, detail))
}

/// The branch a checkout line moved HEAD to, None for a detached HEAD.
fn checkout_target(message: &str) -> Option<Option<String>> {
    let rest = message.strip_prefix("checkout: moving from ")?;
    let (_, to) = rest.rsplit_once(" to ")?;
    Some(branch_name(to))
}

/// A rebase's finish line names the branch it returned to.
fn rebase_target(message: &str) -> Option<Option<String>> {
    let (_, to) = message.split_once("returning to ")?;
    Some(branch_name(to))
}

/// A name HEAD can stand on, with `refs/heads/` dropped, or None for a
/// commit id (detached).
fn branch_name(name: &str) -> Option<String> {
    let name = name.trim().trim_start_matches("refs/heads/");
    let detached = name.len() >= 7 && name.chars().all(|c| c.is_ascii_hexdigit());
    (!name.is_empty() && !detached).then(|| name.to_string())
}

/// The branch a checkout's HEAD file names now.
fn head_branch(head_file: &Path) -> Option<String> {
    let text = std::fs::read_to_string(head_file).ok()?;
    let target = text.trim().strip_prefix("ref: ")?;
    branch_name(target)
}

/// One reflog the log reads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Source {
    /// A checkout's HEAD reflog, with that checkout's HEAD file and folder.
    Head { reflog: PathBuf, head_file: PathBuf, worktree: String },
    /// A remote-tracking ref's reflog; `name` is `origin/main`.
    Remote { reflog: PathBuf, name: String },
}

impl Source {
    fn reflog(&self) -> &Path {
        match self {
            Source::Head { reflog, .. } | Source::Remote { reflog, .. } => reflog,
        }
    }
}

/// The repository's common git dir for a checkout, or None outside one.
pub fn common_dir(root: &Path) -> Option<PathBuf> {
    let out = crate::git_status::git()
        .args(["--no-optional-locks", "rev-parse", "--git-common-dir"])
        .current_dir(root)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let dir = PathBuf::from(String::from_utf8_lossy(&out.stdout).trim());
    let dir = if dir.is_absolute() { dir } else { root.join(dir) };
    Some(std::fs::canonicalize(&dir).unwrap_or(dir))
}

/// Every reflog in a repository the log reads: each checkout's HEAD and
/// every remote-tracking ref's.
pub fn sources(common: &Path) -> Vec<Source> {
    let mut out = Vec::new();
    let main = common.parent().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
    out.push(Source::Head {
        reflog: common.join("logs/HEAD"),
        head_file: common.join("HEAD"),
        worktree: main,
    });
    if let Ok(entries) = std::fs::read_dir(common.join("worktrees")) {
        let mut linked: Vec<PathBuf> = entries.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
        linked.sort();
        for dir in linked {
            // `gitdir` names the checkout's `.git` file; its folder is the
            // checkout.
            let worktree = std::fs::read_to_string(dir.join("gitdir"))
                .ok()
                .and_then(|g| Path::new(g.trim()).parent().map(|p| p.to_string_lossy().to_string()))
                .unwrap_or_else(|| dir.to_string_lossy().to_string());
            out.push(Source::Head { reflog: dir.join("logs/HEAD"), head_file: dir.join("HEAD"), worktree });
        }
    }
    let remotes = common.join("logs/refs/remotes");
    let mut stack = vec![remotes.clone()];
    let mut found = Vec::new();
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else { continue };
            if kind.is_dir() {
                stack.push(entry.path());
            } else if kind.is_file() {
                let path = entry.path();
                if let Ok(rel) = path.strip_prefix(&remotes) {
                    let name = rel.to_string_lossy().replace('\\', "/");
                    if name.rsplit('/').next() != Some("HEAD") {
                        found.push(Source::Remote { reflog: path.clone(), name });
                    }
                }
            }
        }
    }
    found.sort_by(|a, b| a.reflog().cmp(b.reflog()));
    out.extend(found);
    out
}

struct Cursor {
    offset: usize,
    last_line: Option<String>,
    branch: Option<String>,
}

/// Where to start reading a reflog's complete lines, given its cursor.
fn start_index(content: &[u8], lines: &[&[u8]], cursor: &Cursor) -> usize {
    let Some(last) = cursor.last_line.as_deref() else { return 0 };
    let mut ending = last.as_bytes().to_vec();
    ending.push(b'\n');
    if cursor.offset <= content.len() && content[..cursor.offset].ends_with(&ending) {
        return content[..cursor.offset].iter().filter(|b| **b == b'\n').count();
    }
    // Rewritten under the cursor. The last line read, if it survived, is
    // where to go on from; if not, every line newer than it is new.
    if let Some(i) = lines.iter().rposition(|l| *l == last.as_bytes()) {
        return i + 1;
    }
    let last_at = parse_line(last).map(|l| l.at).unwrap_or(i64::MIN);
    lines
        .iter()
        .position(|l| parse_line(&String::from_utf8_lossy(l)).is_some_and(|p| p.at > last_at))
        .unwrap_or(lines.len())
}

/// Reads every new reflog line of a workspace's repository and appends its
/// entries, advancing each cursor in the same transaction.
pub fn sync(conn: &mut Connection, workspace_id: &str, sources: &[Source]) -> anyhow::Result<Vec<LogEntry>> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let seeded: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM workspace_log_reflogs WHERE workspace_id = ?1 AND path = '')",
        params![workspace_id],
        |row| row.get(0),
    )?;
    let mut entries = Vec::new();
    for source in sources {
        let reflog = source.reflog();
        let key = reflog.to_string_lossy().to_string();
        let Ok(content) = std::fs::read(reflog) else { continue };
        // Complete lines only: a line still being written is read next time.
        let complete = content.iter().rposition(|b| *b == b'\n').map_or(0, |i| i + 1);
        let content = &content[..complete];
        let lines: Vec<&[u8]> = content.split(|b| *b == b'\n').filter(|l| !l.is_empty()).collect();
        let stored: Option<Cursor> = tx
            .query_row(
                "SELECT offset, last_line, branch FROM workspace_log_reflogs WHERE workspace_id = ?1 AND path = ?2",
                params![workspace_id, key],
                |row| {
                    Ok(Cursor {
                        offset: row.get::<_, i64>(0)?.max(0) as usize,
                        last_line: row.get(1)?,
                        branch: row.get(2)?,
                    })
                },
            )
            .optional()?;
        let (start, mut branch) = match (&stored, source) {
            (Some(cursor), _) => (start_index(content, &lines, cursor), cursor.branch.clone()),
            (None, Source::Head { head_file, .. }) => {
                (if seeded { 0 } else { lines.len() }, head_branch(head_file))
            }
            (None, Source::Remote { .. }) => (if seeded { 0 } else { lines.len() }, None),
        };
        for raw in &lines[start.min(lines.len())..] {
            let Some(line) = parse_line(&String::from_utf8_lossy(raw)) else { continue };
            let entry = match source {
                Source::Head { worktree, .. } => {
                    if let Some(to) = checkout_target(&line.message).or_else(|| rebase_target(&line.message)) {
                        branch = to;
                    }
                    head_kind(&line).map(|(kind, detail)| {
                        (
                            kind,
                            LogPayload {
                                branch: branch.clone(),
                                worktree: Some(worktree.clone()),
                                sha: Some(line.new.clone()),
                                message: Some(detail).filter(|d| !d.is_empty()),
                                ..Default::default()
                            },
                        )
                    })
                }
                Source::Remote { name, .. } => (line.message == "update by push").then(|| {
                    (
                        LogKind::GitPush,
                        LogPayload { branch: Some(name.clone()), sha: Some(line.new.clone()), ..Default::default() },
                    )
                }),
            };
            if let Some((kind, payload)) = entry {
                entries.push(crate::workspace_log::append(&tx, workspace_id, line.at, kind, &payload)?);
            }
        }
        let last_line = lines.last().map(|l| String::from_utf8_lossy(l).to_string());
        tx.execute(
            "INSERT INTO workspace_log_reflogs (workspace_id, path, offset, last_line, branch)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(workspace_id, path) DO UPDATE SET
               offset = excluded.offset, last_line = excluded.last_line, branch = excluded.branch",
            params![workspace_id, key, content.len() as i64, last_line, branch],
        )?;
    }
    tx.execute(
        "INSERT OR IGNORE INTO workspace_log_reflogs (workspace_id, path, offset) VALUES (?1, '', 0)",
        params![workspace_id],
    )?;
    tx.commit()?;
    Ok(entries)
}

/// The watch on one workspace's reflogs. Dropping it ends the watch.
pub struct ReflogWatch {
    _debouncer: Arc<Mutex<Option<notify_debouncer_mini::Debouncer<crate::changes_only::ChangesOnly>>>>,
}

/// Starts watching the reflogs of the repository `root` is in, reading
/// them once now -- what changed while nobody watched -- and again on
/// every change. None outside a repository.
///
/// `on_change` is handed the repository's reflogs, found afresh each time:
/// a worktree added since the last read brings a reflog of its own.
///
/// Where one recursive watch is one OS stream (`gavin::ONE_RECURSIVE_WATCH`)
/// the whole common dir is watched and the events filtered to reflogs.
/// Elsewhere a recursive watch is a watch per directory, and `objects/`
/// alone is hundreds: there `logs/` and `worktrees/` are watched, and the
/// common dir itself shallowly so the `worktrees/` the first `git worktree
/// add` creates is armed when it appears.
pub fn watch(root: &Path, on_change: impl Fn(&[Source]) + Send + Sync + 'static) -> Option<ReflogWatch> {
    let common = common_dir(root)?;
    let shared: Arc<Mutex<Option<notify_debouncer_mini::Debouncer<crate::changes_only::ChangesOnly>>>> =
        Arc::new(Mutex::new(None));
    let weak = Arc::downgrade(&shared);
    let on_change = Arc::new(on_change);
    let callback = on_change.clone();
    let watched = common.clone();
    let debouncer = crate::changes_only::new_debouncer(
        REFLOG_DEBOUNCE,
        move |res: notify_debouncer_mini::DebounceEventResult| {
            let Ok(events) = res else { return };
            if !crate::gavin::ONE_RECURSIVE_WATCH && events.iter().any(|e| e.path == watched.join("worktrees")) {
                if let Some(shared) = weak.upgrade() {
                    if let Some(d) = shared.lock().unwrap().as_mut() {
                        let _ = d.watcher().watch(&watched.join("worktrees"), notify::RecursiveMode::Recursive);
                    }
                }
            }
            let reflogs = events.iter().any(|e| {
                e.path.strip_prefix(&watched).is_ok_and(|rel| rel.components().any(|c| c.as_os_str() == "logs"))
            });
            if reflogs {
                callback(&sources(&watched));
            }
        },
    )
    .ok()?;
    *shared.lock().unwrap() = Some(debouncer);
    {
        let mut guard = shared.lock().unwrap();
        let fs = guard.as_mut()?.watcher();
        if crate::gavin::ONE_RECURSIVE_WATCH {
            let _ = fs.watch(&common, notify::RecursiveMode::Recursive);
        } else {
            let _ = fs.watch(&common, notify::RecursiveMode::NonRecursive);
            let _ = fs.watch(&common.join("logs"), notify::RecursiveMode::Recursive);
            if common.join("worktrees").is_dir() {
                let _ = fs.watch(&common.join("worktrees"), notify::RecursiveMode::Recursive);
            }
        }
    }
    on_change(&sources(&common));
    Some(ReflogWatch { _debouncer: shared })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn line(old: &str, new: &str, message: &str) -> ReflogLine {
        ReflogLine { old: old.into(), new: new.into(), at: 1, message: message.into() }
    }

    #[test]
    fn a_line_parses_with_spaces_in_the_identity_and_a_missing_message() {
        let l = parse_line("aaa bbb Cosimo Alfredo <c@x> 1792589287 +0200\tcommit: chore: x").unwrap();
        assert_eq!((l.old.as_str(), l.new.as_str(), l.at, l.message.as_str()), ("aaa", "bbb", 1792589287, "commit: chore: x"));
        let bare = parse_line("000 aaa A <a@b> 1793022198 +0100").unwrap();
        assert_eq!((bare.at, bare.message.as_str()), (1793022198, ""));
        assert!(parse_line("garbage").is_none());
    }

    #[test]
    fn each_head_message_maps_to_its_kind() {
        let k = |message: &str| head_kind(&line("a", "b", message)).map(|(k, d)| (k, d));
        assert_eq!(k("commit: fix it"), Some((LogKind::GitCommit, "fix it".into())));
        assert_eq!(k("commit (initial): first").map(|x| x.0), Some(LogKind::GitCommit));
        assert_eq!(k("commit (amend): again").map(|x| x.0), Some(LogKind::GitCommit));
        assert_eq!(k("commit (merge): Merge branch 'x'").map(|x| x.0), Some(LogKind::GitMerge));
        assert_eq!(k("cherry-pick: picked").map(|x| x.0), Some(LogKind::GitCommit));
        assert_eq!(k("checkout: moving from main to feat").map(|x| x.0), Some(LogKind::GitCheckout));
        assert_eq!(k("merge feat: Fast-forward"), Some((LogKind::GitMerge, "feat: Fast-forward".into())));
        assert_eq!(k("pull --progress: Fast-forward").map(|x| x.0), Some(LogKind::GitPull));
        assert_eq!(k("pull --rebase (start): checkout abc"), None);
        assert_eq!(k("pull --rebase (finish): returning to refs/heads/main").map(|x| x.0), Some(LogKind::GitPull));
        assert_eq!(k("rebase (start): checkout main"), None);
        assert_eq!(k("rebase (pick): one"), None);
        assert_eq!(k("rebase (finish): returning to refs/heads/feat").map(|x| x.0), Some(LogKind::GitRebase));
        assert_eq!(k("rebase -i (finish): returning to refs/heads/feat").map(|x| x.0), Some(LogKind::GitRebase));
        assert_eq!(k("reset: moving to HEAD~1").map(|x| x.0), Some(LogKind::GitReset));
        assert_eq!(head_kind(&line("a", "a", "reset: moving to HEAD")), None, "a reset that moved nothing");
        assert_eq!(k(""), None);
        assert_eq!(k("clone: from https://x"), None);
    }

    #[test]
    fn checkout_and_rebase_lines_name_where_head_went() {
        assert_eq!(checkout_target("checkout: moving from main to feat/x"), Some(Some("feat/x".into())));
        assert_eq!(checkout_target("checkout: moving from main to 1a2b3c4d5e"), Some(None));
        assert_eq!(rebase_target("rebase (finish): returning to refs/heads/feat"), Some(Some("feat".into())));
        assert_eq!(checkout_target("commit: x"), None);
    }

    // --- against real repositories -------------------------------------

    fn git(dir: &Path, args: &[&str]) {
        let out = Command::new("git")
            .args(["-c", "user.email=a@b", "-c", "user.name=A", "-c", "init.defaultBranch=main"])
            .args(args)
            .current_dir(dir)
            .env("GIT_TERMINAL_PROMPT", "0")
            .output()
            .unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    }

    fn commit(dir: &Path, file: &str, message: &str) {
        std::fs::write(dir.join(file), message).unwrap();
        git(dir, &["add", file]);
        git(dir, &["commit", "-qm", message]);
    }

    /// A repository with a commit, a bare remote it has pushed to, and a
    /// store. Canonical paths, as the daemon's watcher sees them.
    fn fixture() -> (tempfile::TempDir, PathBuf, Connection) {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().canonicalize().unwrap();
        git(&base, &["init", "-q", "--bare", "remote.git"]);
        let repo = base.join("repo");
        std::fs::create_dir(&repo).unwrap();
        git(&repo, &["init", "-q"]);
        commit(&repo, "f", "first");
        git(&repo, &["remote", "add", "origin", "../remote.git"]);
        git(&repo, &["push", "-q", "-u", "origin", "main"]);
        let mut conn = Connection::open(base.join("kanban.sqlite")).unwrap();
        conn.execute_batch(
            "CREATE TABLE card_runs (id INTEGER PRIMARY KEY, workspace_id TEXT, path TEXT, session_id TEXT,
               command TEXT, started_at INTEGER, ended_at INTEGER, exit_code INTEGER, outcome TEXT);",
        )
        .unwrap();
        crate::workspace_log::migrate(&mut conn).unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        (dir, repo, conn)
    }

    fn read(conn: &mut Connection, repo: &Path) -> Vec<LogEntry> {
        let common = common_dir(repo).unwrap();
        sync(conn, "ws", &sources(&common)).unwrap()
    }

    fn kinds(entries: &[LogEntry]) -> Vec<(LogKind, Option<String>)> {
        entries.iter().map(|e| (e.kind, e.payload.branch.clone())).collect()
    }

    #[test]
    fn the_first_read_seeds_and_later_ones_log_each_line_once_tagged_with_its_branch() {
        let (_dir, repo, mut conn) = fixture();
        assert!(read(&mut conn, &repo).is_empty(), "a repository's history is not news");

        git(&repo, &["switch", "-qc", "feat"]);
        commit(&repo, "g", "on feat");
        git(&repo, &["switch", "-q", "main"]);
        git(&repo, &["merge", "-q", "feat"]);
        git(&repo, &["reset", "-q", "--hard", "HEAD~1"]);
        let entries = read(&mut conn, &repo);
        assert_eq!(
            kinds(&entries),
            vec![
                (LogKind::GitCheckout, Some("feat".into())),
                (LogKind::GitCommit, Some("feat".into())),
                (LogKind::GitCheckout, Some("main".into())),
                (LogKind::GitMerge, Some("main".into())),
                (LogKind::GitReset, Some("main".into())),
            ]
        );
        assert_eq!(entries[1].payload.message.as_deref(), Some("on feat"));
        assert_eq!(entries[1].payload.worktree.as_deref(), Some(repo.to_str().unwrap()));
        assert!(entries.iter().all(|e| e.at > 1_000_000_000), "the reflog's own time");
        assert!(read(&mut conn, &repo).is_empty(), "a second wake reads nothing again");

        // A restart: a new connection on the same file carries on.
        drop(conn);
        let mut conn = Connection::open(repo.parent().unwrap().join("kanban.sqlite")).unwrap();
        commit(&repo, "h", "after restart");
        let entries = read(&mut conn, &repo);
        assert_eq!(kinds(&entries), vec![(LogKind::GitCommit, Some("main".into()))]);
    }

    #[test]
    fn a_worktree_added_later_is_read_from_its_start_and_a_push_from_either_is_logged_once() {
        let (_dir, repo, mut conn) = fixture();
        read(&mut conn, &repo);
        let wt = repo.parent().unwrap().join("wt");
        git(&repo, &["worktree", "add", "-q", wt.to_str().unwrap(), "-b", "wtb"]);
        commit(&wt, "w", "in wt");
        git(&wt, &["push", "-q", "origin", "wtb"]);
        commit(&repo, "m", "in main");
        git(&repo, &["push", "-q", "origin", "main"]);

        let entries = read(&mut conn, &repo);
        let wt_path = wt.to_str().unwrap().to_string();
        let in_wt: Vec<_> = entries.iter().filter(|e| e.payload.worktree.as_deref() == Some(&wt_path)).collect();
        assert_eq!(in_wt.len(), 1, "the worktree's creation lines are not entries: {entries:?}");
        assert_eq!((in_wt[0].kind, in_wt[0].payload.branch.as_deref()), (LogKind::GitCommit, Some("wtb")));
        let pushes: Vec<_> = entries.iter().filter(|e| e.kind == LogKind::GitPush).collect();
        let mut pushed: Vec<_> = pushes.iter().map(|e| e.payload.branch.clone().unwrap()).collect();
        pushed.sort();
        assert_eq!(pushed, vec!["origin/main".to_string(), "origin/wtb".to_string()]);
        assert!(read(&mut conn, &repo).is_empty());
    }

    #[test]
    fn a_reflog_that_shrank_is_found_again_and_only_newer_lines_are_logged() {
        let (_dir, repo, mut conn) = fixture();
        read(&mut conn, &repo);
        commit(&repo, "a", "one");
        commit(&repo, "b", "two");
        assert_eq!(read(&mut conn, &repo).len(), 2);
        // Rewritten shorter, with the last line read still in it.
        let reflog = common_dir(&repo).unwrap().join("logs/HEAD");
        let text = std::fs::read_to_string(&reflog).unwrap();
        let kept: Vec<&str> = text.lines().skip(1).collect();
        std::fs::write(&reflog, format!("{}\n", kept.join("\n"))).unwrap();
        commit(&repo, "c", "three");
        let entries = read(&mut conn, &repo);
        assert_eq!(entries.iter().map(|e| e.payload.message.clone().unwrap()).collect::<Vec<_>>(), vec!["three"]);

        // Expired outright: nothing it held is logged again.
        git(&repo, &["reflog", "expire", "--expire=now", "--all"]);
        assert!(read(&mut conn, &repo).is_empty());
        commit(&repo, "d", "four");
        let entries = read(&mut conn, &repo);
        assert_eq!(entries.iter().map(|e| e.payload.message.clone().unwrap()).collect::<Vec<_>>(), vec!["four"]);
    }

    #[test]
    fn the_watch_reads_on_start_and_again_when_a_reflog_changes() {
        let (_dir, repo, _conn) = fixture();
        let calls = Arc::new(std::sync::Mutex::new(Vec::<usize>::new()));
        let seen = calls.clone();
        let watch = watch(&repo, move |sources| seen.lock().unwrap().push(sources.len())).unwrap();
        assert_eq!(calls.lock().unwrap().len(), 1, "read once on start");
        commit(&repo, "x", "watched");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while calls.lock().unwrap().len() < 2 && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        assert!(calls.lock().unwrap().len() >= 2, "a commit wakes the watch");
        // A worktree added after the watch began, and a checkout inside it
        // -- which writes only that worktree's own HEAD reflog.
        let wt = repo.parent().unwrap().join("wt-later");
        git(&repo, &["worktree", "add", "-q", wt.to_str().unwrap(), "-b", "later"]);
        std::thread::sleep(std::time::Duration::from_millis(900));
        let before = calls.lock().unwrap().len();
        git(&wt, &["checkout", "-q", "--detach"]);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while calls.lock().unwrap().len() == before && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        assert!(calls.lock().unwrap().len() > before, "a checkout in a worktree added later wakes the watch");
        drop(watch);
        assert!(watch_outside_a_repo_is_none());
    }

    fn watch_outside_a_repo_is_none() -> bool {
        let dir = tempfile::tempdir().unwrap();
        watch(dir.path(), |_| {}).is_none()
    }
}
