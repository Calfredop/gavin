//! A read-back path for the git status a session's tab, page row and
//! sidebar chip display.
//!
//! `Response::GitStatusChanged` is the only way the frontend ever learns
//! a session's branch/dirty/ahead/behind, and the daemon sends the
//! baseline for it in reply to `Attach` -- which runs once per app
//! PROCESS (`session::attach_and_relay`), not once per frontend load.
//! The push is change-only by design on top of that: once a repo root's
//! poller holds a cached status, nothing re-sends it until the repo
//! itself changes. So a reloaded frontend -- every edit under `tauri
//! dev` -- comes up with `gitStatusById` empty and stays that way: no
//! repo chip on the workspace, no branch line on its page rows, no dot
//! on the pane, until someone happens to commit or check out. This is
//! the same gap `session::get_session_baselines` closed for
//! cwd/status/restored, for the one map it left out.
//!
//! Answered from the host rather than through a new daemon request, so
//! it needs no protocol version of its own: a daemon running a build
//! behind the app is precisely the situation this has to work in.
//!
//! Deliberately the SAME git command and the same parse rules as
//! `crates/daemon/src/git_status.rs`. A seed that disagreed with the
//! push that eventually replaces it would make the sidebar silently
//! change its mind about a repo nothing had touched.

use std::collections::HashMap;

use protocol::GitStatus;

use super::run::run_git_ro;

/// The canonical repository root containing `cwd`, or `None` when `cwd`
/// is inside no repository -- or when git cannot be run at all, which is
/// treated identically (the daemon's silent-degradation convention: no
/// status, no user-facing error, no distinction drawn between "not a
/// repo" and "could not check").
fn repo_root(cwd: &str) -> Option<String> {
    let out = run_git_ro(cwd, &["rev-parse", "--show-toplevel"]).ok()?;
    if out.code != 0 {
        return None;
    }
    let root = out.stdout_str().trim().to_string();
    if root.is_empty() {
        None
    } else {
        Some(root)
    }
}

/// Parses `git status --porcelain=v2 --branch`, mirroring the daemon's
/// `parse_porcelain_v2`: `dirty` is true for ANY non-header, non-blank
/// line (`1` ordinary, `2` renamed/copied, `u` unmerged, `?` untracked --
/// untracked counting as dirty the way plain `git status` does), and
/// `ahead`/`behind` are only meaningful when `# branch.ab` was present at
/// all. Output with no `# branch.head` line is not status output; `None`
/// rather than a guess.
fn parse_porcelain_v2(root: &str, output: &str) -> Option<GitStatus> {
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

    Some(GitStatus {
        repo_root: root.to_string(),
        branch: branch?,
        dirty,
        ahead,
        behind,
        has_upstream,
    })
}

fn status_for_root(root: &str) -> Option<GitStatus> {
    // `--no-optional-locks` comes from run_git_ro, and is load-bearing
    // rather than tidy: it stops `status` taking `.git/index.lock` to
    // refresh the index, which is what keeps this from fighting the
    // human's own concurrent git commands in the very repo they are
    // working in.
    let out = run_git_ro(root, &["status", "--porcelain=v2", "--branch"]).ok()?;
    if out.code != 0 {
        return None;
    }
    parse_porcelain_v2(root, &out.stdout_str())
}

/// One answer per input cwd, in the order given, so the caller can zip
/// the result straight back onto the session ids it derived the cwds
/// from. `None` means "checked, not in a repo" -- a real answer, not a
/// failure to look.
///
/// At most one `rev-parse` per DISTINCT cwd and one `status` per
/// DISTINCT repo root: a workspace commonly has a dozen sessions sitting
/// in two or three checkouts, and this runs on the app's load path.
pub fn git_baselines(cwds: &[String]) -> Vec<Option<GitStatus>> {
    let mut roots: HashMap<String, Option<String>> = HashMap::new();
    let mut statuses: HashMap<String, Option<GitStatus>> = HashMap::new();
    let mut out = Vec::with_capacity(cwds.len());
    for cwd in cwds {
        let root = match roots.get(cwd) {
            Some(cached) => cached.clone(),
            None => {
                let resolved = repo_root(cwd);
                roots.insert(cwd.clone(), resolved.clone());
                resolved
            }
        };
        out.push(match root {
            Some(root) => match statuses.get(&root) {
                Some(cached) => cached.clone(),
                None => {
                    let status = status_for_root(&root);
                    statuses.insert(root, status.clone());
                    status
                }
            },
            None => None,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(output: &str) -> Option<GitStatus> {
        parse_porcelain_v2("/repo", output)
    }

    #[test]
    fn reads_branch_and_upstream_deltas() {
        let status = parse("# branch.oid abc\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +2 -3\n")
            .unwrap();
        assert_eq!(status.branch, "main");
        assert_eq!((status.ahead, status.behind), (2, 3));
        assert!(status.has_upstream);
        assert!(!status.dirty);
        assert_eq!(status.repo_root, "/repo");
    }

    #[test]
    fn a_branch_with_no_upstream_reports_no_deltas() {
        let status = parse("# branch.oid abc\n# branch.head wip\n").unwrap();
        assert!(!status.has_upstream);
        assert_eq!((status.ahead, status.behind), (0, 0));
    }

    #[test]
    fn any_entry_line_makes_the_tree_dirty() {
        for entry in [
            "1 M. N... 100644 100644 100644 abc def src/foo.rs",
            "2 R. N... 100644 100644 100644 R100 new.rs\told.rs",
            "u UU N... 100644 100644 100644 100644 a b c d both.rs",
            "? untracked.rs",
        ] {
            let out = format!("# branch.head main\n{entry}\n");
            assert!(parse(&out).unwrap().dirty, "{entry} should count as dirty");
        }
    }

    #[test]
    fn a_detached_head_reports_the_daemons_own_label() {
        assert_eq!(parse("# branch.head (detached)\n").unwrap().branch, "detached");
    }

    #[test]
    fn output_without_a_branch_head_line_is_not_status_output() {
        assert!(parse("fatal: not a git repository\n").is_none());
    }

    #[test]
    fn a_cwd_outside_any_repo_answers_none() {
        let dir = tempfile::tempdir().unwrap();
        let cwds = vec![dir.path().to_str().unwrap().to_string()];
        assert_eq!(git_baselines(&cwds), vec![None]);
    }

    #[test]
    fn every_cwd_in_one_checkout_gets_that_checkouts_status() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let sub = root.join("src");
        std::fs::create_dir(&sub).unwrap();
        for args in [
            vec!["init", "-b", "main"],
            vec!["config", "user.email", "t@example.com"],
            vec!["config", "user.name", "T"],
        ] {
            run_git_ro(root.to_str().unwrap(), &args).unwrap();
        }
        std::fs::write(sub.join("a.rs"), "fn main() {}").unwrap();

        let cwds = vec![
            root.to_str().unwrap().to_string(),
            sub.to_str().unwrap().to_string(),
        ];
        let out = git_baselines(&cwds);
        assert_eq!(out.len(), 2);
        // The same answer for both, and the ROOT's path in each -- a
        // session sitting in a subdirectory is in the same repo as one
        // sitting at the top, which is what lets the sidebar dedupe them.
        assert_eq!(out[0], out[1]);
        let status = out[0].clone().unwrap();
        assert_eq!(status.branch, "main");
        assert!(status.dirty, "an untracked file is a dirty tree");
        assert!(!status.has_upstream);
    }
}
