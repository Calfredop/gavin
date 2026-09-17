use std::io::Read;
use std::process::Stdio;
use std::time::{Duration, Instant};

/// Hard cap on how long a single `git status` subprocess is allowed to
/// run before this scanner gives up on it and moves on -- an unusual repo
/// hook, an enormous repo, or a genuinely hung process must never block a
/// repo root's poller (and by extension, every session mapped to it)
/// indefinitely.
const GIT_STATUS_TIMEOUT: Duration = Duration::from_secs(10);

/// The fields this scanner extracts from `git status --porcelain=v2
/// --branch` output. `ahead`/`behind` are only meaningful when
/// `has_upstream` is true.
#[derive(Debug, Clone, PartialEq)]
pub struct ParsedGitStatus {
    pub branch: String,
    pub dirty: bool,
    pub ahead: u32,
    pub behind: u32,
    pub has_upstream: bool,
}

/// Parses `git status --porcelain=v2 --branch` output. Returns `None` for
/// anything that doesn't look like valid output (missing the mandatory
/// `# branch.head` line) rather than panicking -- this milestone's own
/// silent-degradation convention applies here exactly as it does to a
/// malformed OSC sequence in `status.rs`.
///
/// `dirty` is true if ANY non-header, non-blank line is present -- every
/// such line (ordinary changed entries prefixed `1`, renamed/copied
/// entries prefixed `2`, unmerged entries prefixed `u`, and untracked
/// entries prefixed `?`) means the working tree isn't clean. Untracked
/// files counting as dirty matches plain `git status`'s own "Untracked
/// files" section.
pub fn parse_porcelain_v2(output: &str) -> Option<ParsedGitStatus> {
    let mut branch: Option<String> = None;
    let mut ahead = 0u32;
    let mut behind = 0u32;
    let mut has_upstream = false;
    let mut dirty = false;

    for line in output.lines() {
        if let Some(head) = line.strip_prefix("# branch.head ") {
            branch = Some(if head == "(detached)" { "detached".to_string() } else { head.to_string() });
        } else if let Some(ab) = line.strip_prefix("# branch.ab ") {
            has_upstream = true;
            let mut parts = ab.split_whitespace();
            if let (Some(a), Some(b)) = (parts.next(), parts.next()) {
                ahead = a.trim_start_matches('+').parse().unwrap_or(0);
                behind = b.trim_start_matches('-').parse().unwrap_or(0);
            }
        } else if line.starts_with('#') {
            continue;
        } else if !line.is_empty() {
            dirty = true;
        }
    }

    Some(ParsedGitStatus { branch: branch?, dirty, ahead, behind, has_upstream })
}

/// Resolves the canonical git repository root containing `cwd`, or `None`
/// if `cwd` is not inside any git repository -- or if `git` itself can't
/// even be run at all, which is treated identically (this milestone's own
/// silent-degradation convention: no status, no user-facing error, no
/// distinction made between "definitely not a repo" and "couldn't check").
pub fn resolve_repo_root(cwd: &str) -> Option<String> {
    // No `--path-format=absolute`: `--show-toplevel`'s output is already
    // unconditionally absolute (git's own docs describe it as "the (by
    // default, absolute) path of the top-level directory"), so the flag
    // bought nothing -- and `--path-format` only exists from git 2.31
    // onward, so passing it would silently raise this feature's minimum
    // git version: an older git treats an unrecognized trailing option as
    // a revision argument, exits non-zero, and this function would then
    // return `None` for every session on that machine with nothing logged
    // to explain why.
    let output = crate::program::command("git")
        .args(["rev-parse", "--show-toplevel"])
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let root = String::from_utf8(output.stdout).ok()?;
    let root = root.trim();
    if root.is_empty() {
        return None;
    }
    Some(root.to_string())
}

/// The commit `cwd`'s checkout is on right now, or `None` when `cwd` is
/// in no repository, HEAD is unborn, or git cannot be run -- the same
/// silent-degradation convention as `resolve_repo_root` above.
///
/// The daemon's one baseline resolver, and it exists for exactly one
/// caller: a card CLAIM (`claim_card_for_session`), where an agent binds
/// itself to a card gavin never launched. Every gavin-launched run gets
/// its baseline from the app, which knows the launch directory before
/// there is a session at all; a claim is the case where nobody else was
/// there to look.
///
/// `--verify` and `-q` rather than a bare `rev-parse HEAD`: on an unborn
/// HEAD a bare one prints the literal string "HEAD" and exits non-zero,
/// and a bare one in a non-repo prints git's error to stdout on some
/// versions. Both would otherwise be recorded as a sha.
pub fn head_sha(cwd: &str) -> Option<String> {
    let output = crate::program::command("git")
        .args(["rev-parse", "--verify", "-q", "HEAD"])
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let sha = String::from_utf8(output.stdout).ok()?;
    let sha = sha.trim();
    // Length-checked rather than trusted: this value is handed to
    // `git reset --hard` later on, and the one thing that must never
    // reach that is a string git resolves to something else.
    if sha.len() != 40 || !sha.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    Some(sha.to_string())
}

/// Runs `git --no-optional-locks status --porcelain=v2 --branch` in
/// `repo_root`, parses the result, and returns it -- or `None` if git
/// fails to spawn, exits non-zero, times out, or produces output
/// `parse_porcelain_v2` can't make sense of. Never panics; every failure
/// mode degrades to "no status available."
///
/// `--no-optional-locks` (git 2.14+) stops `status` from taking
/// `.git/index.lock` to refresh the index -- the standard mitigation for
/// exactly the lock contention this whole polling design exists to avoid
/// (cmux #2722, where naive timer-based polling broke other tools and the
/// user's own concurrent git commands). It is a TOP-LEVEL git option: it
/// must come before the subcommand, since `git status --no-optional-locks`
/// is an "unknown option" error, not a no-op.
/// Spawn git, drain stdout on its own thread, wait with a deadline.
/// None on spawn failure, non-zero exit, or timeout.
///
/// The draining thread is load-bearing, not an optimization: `git status`
/// can write more output than the OS pipe buffer holds (a large change
/// set), and a `try_wait()` loop with nothing reading blocks the child on
/// its own `write()` and this function on the child -- the classic
/// `std::process` deadlock that `Child::wait_with_output` exists to
/// avoid, and which a timeout loop cannot use directly.
fn run_git_capture(repo_root: &str, args: &[&str], timeout: Duration) -> Option<String> {
    let mut child = crate::program::command("git")
        .args(args)
        .current_dir(repo_root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;

    let mut stdout = child.stdout.take()?;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut output = String::new();
        let _ = stdout.read_to_string(&mut output);
        let _ = tx.send(output);
    });

    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(_) => return None,
        }
    };
    if !status.success() {
        return None;
    }
    rx.recv_timeout(Duration::from_secs(1)).ok()
}

/// Every path with an uncommitted change, from porcelain=v2 output --
/// the SAME format run_git_status already uses, so this file reasons
/// about one git format rather than two.
///
/// Field layouts (v2, no -z):
///   1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
///   2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <Xscore> <path>\t<origPath>
///   u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
///   ? <path>
/// Renames report the NEW path: that is the file an agent would edit.
/// `!` (ignored) and `#` (header) lines are not changes.
///
/// Returns (paths, truncated). This is EVIDENCE for an agent, not a
/// correctness-critical read: a path containing a literal newline (which
/// git would quote here) is not worth a -z parser.
pub fn parse_dirty_paths(output: &str, limit: usize) -> (Vec<String>, bool) {
    let mut paths = Vec::new();
    let mut truncated = false;
    for line in output.lines() {
        let path = if let Some(rest) = line.strip_prefix("? ") {
            Some(rest)
        } else if line.starts_with("1 ") {
            line.splitn(9, ' ').nth(8)
        } else if line.starts_with("2 ") {
            line.splitn(10, ' ').nth(9).and_then(|p| p.split('\t').next())
        } else if line.starts_with("u ") {
            line.splitn(11, ' ').nth(10)
        } else {
            None
        };
        let Some(path) = path.filter(|p| !p.is_empty()) else { continue };
        if paths.len() >= limit {
            truncated = true;
            break;
        }
        paths.push(path.to_string());
    }
    (paths, truncated)
}

pub fn dirty_paths(repo_root: &str, limit: usize) -> Option<(Vec<String>, bool)> {
    let output = run_git_capture(
        repo_root,
        &["--no-optional-locks", "status", "--porcelain=v2", "--untracked-files=all"],
        GIT_STATUS_TIMEOUT,
    )?;
    Some(parse_dirty_paths(&output, limit))
}

pub fn run_git_status(repo_root: &str) -> Option<protocol::GitStatus> {
    let output = run_git_capture(
        repo_root,
        &["--no-optional-locks", "status", "--porcelain=v2", "--branch"],
        GIT_STATUS_TIMEOUT,
    )?;
    let parsed = parse_porcelain_v2(&output)?;
    Some(protocol::GitStatus {
        repo_root: repo_root.to_string(),
        branch: parsed.branch,
        dirty: parsed.dirty,
        ahead: parsed.ahead,
        behind: parsed.behind,
        has_upstream: parsed.has_upstream,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dirty_paths_reads_ordinary_staged_and_unstaged_entries() {
        let output = "# branch.oid abc\n# branch.head main\n\
            1 M. N... 100644 100644 100644 abc def src/foo.rs\n\
            1 .M N... 100644 100644 100644 abc def src/bar.rs\n";
        let (paths, truncated) = parse_dirty_paths(output, 10);
        assert_eq!(paths, vec!["src/foo.rs", "src/bar.rs"]);
        assert!(!truncated);
    }

    #[test]
    fn dirty_paths_takes_the_new_side_of_a_rename() {
        let output = "2 R. N... 100644 100644 100644 abc def R100 src/new.rs\tsrc/old.rs\n";
        assert_eq!(parse_dirty_paths(output, 10).0, vec!["src/new.rs"]);
    }

    #[test]
    fn dirty_paths_includes_untracked_and_unmerged_entries() {
        let output = "? new-file.txt\n\
            u UU N... 100644 100644 100644 100644 aaa bbb ccc src/conflict.rs\n";
        assert_eq!(parse_dirty_paths(output, 10).0, vec!["new-file.txt", "src/conflict.rs"]);
    }

    #[test]
    fn dirty_paths_skips_headers_and_ignored_entries() {
        let output = "# branch.oid abc\n# branch.head main\n! build/out.js\n";
        assert!(parse_dirty_paths(output, 10).0.is_empty());
    }

    #[test]
    fn dirty_paths_caps_at_the_limit_and_says_so() {
        let output = (0..5).map(|i| format!("? file{i}.txt\n")).collect::<String>();
        let (paths, truncated) = parse_dirty_paths(&output, 3);
        assert_eq!(paths.len(), 3);
        assert!(truncated);
    }

    #[test]
    fn dirty_paths_handles_a_path_containing_spaces() {
        let output = "1 M. N... 100644 100644 100644 abc def src/a file.rs\n";
        assert_eq!(parse_dirty_paths(output, 10).0, vec!["src/a file.rs"]);
    }

    #[test]
    fn parses_a_clean_repo_with_no_upstream() {
        let output = "# branch.oid abc123\n# branch.head main\n";
        let parsed = parse_porcelain_v2(output).unwrap();
        assert_eq!(parsed.branch, "main");
        assert_eq!(parsed.dirty, false);
        assert_eq!(parsed.has_upstream, false);
    }

    #[test]
    fn a_changed_entry_counts_as_dirty() {
        let output = "# branch.oid abc123\n# branch.head main\n1 M. N... 100644 100644 100644 abc def src/foo.rs\n";
        let parsed = parse_porcelain_v2(output).unwrap();
        assert_eq!(parsed.dirty, true);
    }

    #[test]
    fn untracked_files_count_as_dirty() {
        let output = "# branch.oid abc123\n# branch.head main\n? new-file.txt\n";
        let parsed = parse_porcelain_v2(output).unwrap();
        assert_eq!(parsed.dirty, true);
    }

    #[test]
    fn a_renamed_entry_counts_as_dirty() {
        let output = "# branch.oid abc123\n# branch.head main\n2 R. N... 100644 100644 100644 abc def R100 src/new.rs\tsrc/old.rs\n";
        let parsed = parse_porcelain_v2(output).unwrap();
        assert_eq!(parsed.dirty, true);
    }

    #[test]
    fn an_unmerged_entry_counts_as_dirty() {
        let output = "# branch.oid abc123\n# branch.head main\nu UU N... 100644 100644 100644 100644 abc def ghi src/conflict.rs\n";
        let parsed = parse_porcelain_v2(output).unwrap();
        assert_eq!(parsed.dirty, true);
    }

    #[test]
    fn parses_ahead_and_behind_from_branch_ab_when_upstream_exists() {
        let output = "# branch.oid abc123\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +2 -3\n";
        let parsed = parse_porcelain_v2(output).unwrap();
        assert_eq!(parsed.has_upstream, true);
        assert_eq!(parsed.ahead, 2);
        assert_eq!(parsed.behind, 3);
    }

    #[test]
    fn ahead_and_behind_are_zero_and_has_upstream_is_false_with_no_upstream_configured() {
        let output = "# branch.oid abc123\n# branch.head main\n";
        let parsed = parse_porcelain_v2(output).unwrap();
        assert_eq!(parsed.has_upstream, false);
        assert_eq!(parsed.ahead, 0);
        assert_eq!(parsed.behind, 0);
    }

    #[test]
    fn detached_head_maps_to_a_detached_label_instead_of_the_raw_marker() {
        let output = "# branch.oid abc123\n# branch.head (detached)\n";
        let parsed = parse_porcelain_v2(output).unwrap();
        assert_eq!(parsed.branch, "detached");
    }

    #[test]
    fn malformed_output_with_no_branch_head_line_returns_none_rather_than_panicking() {
        let output = "this is not valid git status output at all\n";
        assert_eq!(parse_porcelain_v2(output), None);
    }

    #[test]
    fn empty_output_returns_none() {
        assert_eq!(parse_porcelain_v2(""), None);
    }

    #[test]
    fn a_clean_repo_with_only_header_lines_and_trailing_blank_line_is_not_dirty() {
        let output = "# branch.oid abc123\n# branch.head main\n\n";
        let parsed = parse_porcelain_v2(output).unwrap();
        assert_eq!(parsed.dirty, false);
    }

    mod git_shelling_tests {
        use super::super::*;
        use std::process::Command;

        fn init_repo(dir: &std::path::Path) {
            Command::new("git").args(["init", "-q"]).current_dir(dir).status().unwrap();
            Command::new("git").args(["config", "user.email", "test@example.com"]).current_dir(dir).status().unwrap();
            Command::new("git").args(["config", "user.name", "Test"]).current_dir(dir).status().unwrap();
            // git init's default branch name depends on the test machine's
            // global config -- pin it explicitly so these tests don't
            // depend on that.
            Command::new("git").args(["checkout", "-q", "-b", "main"]).current_dir(dir).status().unwrap();
        }

        fn commit_all(dir: &std::path::Path, message: &str) {
            Command::new("git").args(["add", "-A"]).current_dir(dir).status().unwrap();
            Command::new("git").args(["commit", "-q", "-m", message]).current_dir(dir).status().unwrap();
        }

        #[test]
        fn resolve_repo_root_finds_the_toplevel_from_a_nested_subdirectory() {
            let dir = tempfile::tempdir().unwrap();
            init_repo(dir.path());
            std::fs::write(dir.path().join("file.txt"), "hello").unwrap();
            commit_all(dir.path(), "initial");

            let nested = dir.path().join("a").join("b");
            std::fs::create_dir_all(&nested).unwrap();

            let root = resolve_repo_root(nested.to_str().unwrap()).unwrap();
            // Canonicalize both sides -- macOS's /tmp is a symlink to
            // /private/tmp, and `git rev-parse --show-toplevel` resolves
            // through it, so a direct string comparison against the
            // un-canonicalized tempdir path would spuriously fail.
            assert_eq!(
                std::fs::canonicalize(&root).unwrap(),
                std::fs::canonicalize(dir.path()).unwrap()
            );
        }

        #[test]
        fn resolve_repo_root_returns_none_outside_any_repo() {
            let dir = tempfile::tempdir().unwrap();
            assert_eq!(resolve_repo_root(dir.path().to_str().unwrap()), None);
        }

        #[test]
        fn run_git_status_reports_clean_for_a_fully_committed_repo() {
            let dir = tempfile::tempdir().unwrap();
            init_repo(dir.path());
            std::fs::write(dir.path().join("file.txt"), "hello").unwrap();
            commit_all(dir.path(), "initial");

            let status = run_git_status(dir.path().to_str().unwrap()).unwrap();
            assert_eq!(status.branch, "main");
            assert_eq!(status.dirty, false);
            assert_eq!(status.has_upstream, false);
        }

        #[test]
        fn run_git_status_reports_dirty_for_an_uncommitted_change() {
            let dir = tempfile::tempdir().unwrap();
            init_repo(dir.path());
            std::fs::write(dir.path().join("file.txt"), "hello").unwrap();
            commit_all(dir.path(), "initial");

            std::fs::write(dir.path().join("file.txt"), "changed").unwrap();

            let status = run_git_status(dir.path().to_str().unwrap()).unwrap();
            assert_eq!(status.dirty, true);
        }

        #[test]
        fn run_git_status_reports_dirty_for_an_untracked_file() {
            let dir = tempfile::tempdir().unwrap();
            init_repo(dir.path());
            std::fs::write(dir.path().join("file.txt"), "hello").unwrap();
            commit_all(dir.path(), "initial");

            std::fs::write(dir.path().join("new-file.txt"), "new").unwrap();

            let status = run_git_status(dir.path().to_str().unwrap()).unwrap();
            assert_eq!(status.dirty, true);
        }

        #[test]
        fn run_git_status_includes_the_repo_root_in_its_result() {
            let dir = tempfile::tempdir().unwrap();
            init_repo(dir.path());
            std::fs::write(dir.path().join("file.txt"), "hello").unwrap();
            commit_all(dir.path(), "initial");

            let repo_root = dir.path().to_str().unwrap();
            let status = run_git_status(repo_root).unwrap();
            assert_eq!(status.repo_root, repo_root);
        }

        #[test]
        fn run_git_status_reports_ahead_count_against_a_local_upstream() {
            let remote_dir = tempfile::tempdir().unwrap();
            Command::new("git").args(["init", "-q", "--bare"]).current_dir(remote_dir.path()).status().unwrap();

            let dir = tempfile::tempdir().unwrap();
            init_repo(dir.path());
            std::fs::write(dir.path().join("file.txt"), "hello").unwrap();
            commit_all(dir.path(), "initial");
            Command::new("git")
                .args(["remote", "add", "origin", remote_dir.path().to_str().unwrap()])
                .current_dir(dir.path())
                .status()
                .unwrap();
            Command::new("git")
                .args(["push", "-q", "-u", "origin", "main"])
                .current_dir(dir.path())
                .status()
                .unwrap();

            // A commit made locally, never pushed, is one commit ahead of
            // the already-configured upstream tracking branch -- checked
            // purely against the local copy of origin/main (from the push
            // above), no live network fetch involved, matching this
            // milestone's own "never fetches" constraint.
            std::fs::write(dir.path().join("file2.txt"), "more").unwrap();
            commit_all(dir.path(), "second");

            let status = run_git_status(dir.path().to_str().unwrap()).unwrap();
            assert_eq!(status.has_upstream, true);
            assert_eq!(status.ahead, 1);
            assert_eq!(status.behind, 0);
        }

        #[test]
        fn run_git_status_returns_none_for_a_directory_that_is_not_a_repo() {
            let dir = tempfile::tempdir().unwrap();
            assert_eq!(run_git_status(dir.path().to_str().unwrap()), None);
        }
    }
}
