//! Pure parsers for git's machine-readable output (spec §2). Both are
//! exact by necessity: the frontend patch builder reverses `parse_diff`.

use crate::git::types::{BranchInfo, FileDiff, FileEntry, Hunk, Line, RemoteInfo, StashInfo, StatusResult, WorktreeInfo};

/// `worktree list --porcelain`: blank-line separated blocks of
/// `worktree <path>` / `HEAD <sha>` / `branch refs/heads/<n>` | `detached` /
/// `bare` / `locked [reason]` / `prunable [reason]`. Git lists the main
/// worktree first.
pub fn parse_worktree_list(raw: &str) -> Vec<WorktreeInfo> {
    let mut out: Vec<WorktreeInfo> = Vec::new();
    let mut cur: Option<WorktreeInfo> = None;
    let flush = |cur: &mut Option<WorktreeInfo>, out: &mut Vec<WorktreeInfo>| {
        if let Some(w) = cur.take() {
            out.push(w);
        }
    };
    for line in raw.lines() {
        if line.is_empty() {
            flush(&mut cur, &mut out);
            continue;
        }
        if let Some(path) = line.strip_prefix("worktree ") {
            flush(&mut cur, &mut out);
            cur = Some(WorktreeInfo {
                path: path.to_string(),
                head: String::new(),
                branch: None,
                is_main: out.is_empty(),
                locked: false,
                prunable: false,
            });
            continue;
        }
        let Some(w) = cur.as_mut() else { continue };
        if let Some(sha) = line.strip_prefix("HEAD ") {
            w.head = sha.to_string();
        } else if let Some(b) = line.strip_prefix("branch ") {
            w.branch = Some(b.strip_prefix("refs/heads/").unwrap_or(b).to_string());
        } else if line == "detached" {
            w.branch = None;
        } else if line == "locked" || line.starts_with("locked ") {
            w.locked = true;
        } else if line == "prunable" || line.starts_with("prunable ") {
            w.prunable = true;
        }
    }
    flush(&mut cur, &mut out);
    out
}

#[cfg(test)]
mod worktree_tests {
    use super::*;

    #[test]
    fn worktree_list_parses_main_linked_detached_and_prunable() {
        let raw = "worktree /r/main\nHEAD aaaa\nbranch refs/heads/main\n\nworktree /r/wt-feature\nHEAD bbbb\nbranch refs/heads/feature\nlocked\n\nworktree /r/wt-det\nHEAD cccc\ndetached\nprunable gitdir file points to non-existent location\n\n";
        let w = parse_worktree_list(raw);
        assert_eq!(w.len(), 3);
        assert!(w[0].is_main && w[0].branch.as_deref() == Some("main") && w[0].head == "aaaa");
        assert!(!w[1].is_main && w[1].locked && w[1].branch.as_deref() == Some("feature"));
        assert!(w[2].branch.is_none() && w[2].prunable && !w[2].is_main);
    }
}

/// `%(upstream:track)` → (ahead, behind, gone): "[ahead 2, behind 1]",
/// "[ahead 3]", "[behind 4]", "[gone]" or "".
pub fn parse_track(s: &str) -> (u32, u32, bool) {
    let s = s.trim().trim_start_matches('[').trim_end_matches(']');
    if s == "gone" {
        return (0, 0, true);
    }
    let (mut ahead, mut behind) = (0, 0);
    for part in s.split(',') {
        let part = part.trim();
        if let Some(n) = part.strip_prefix("ahead ") {
            ahead = n.parse().unwrap_or(0);
        } else if let Some(n) = part.strip_prefix("behind ") {
            behind = n.parse().unwrap_or(0);
        }
    }
    (ahead, behind, false)
}

/// Lines of `for-each-ref --format='%(refname:short)%00%(HEAD)%00
/// %(upstream:short)%00%(upstream:track)%00%(objectname:short)%00%(subject)'`.
pub fn parse_branches(raw: &str) -> Vec<BranchInfo> {
    raw.lines()
        .filter(|l| !l.is_empty())
        .filter_map(|l| {
            let f: Vec<&str> = l.split('\0').collect();
            if f.len() < 6 {
                return None;
            }
            let (ahead, behind, _gone) = parse_track(f[3]);
            Some(BranchInfo {
                name: f[0].to_string(),
                current: f[1] == "*",
                upstream: (!f[2].is_empty()).then(|| f[2].to_string()),
                ahead,
                behind,
                sha: f[4].to_string(),
                subject: f[5].to_string(),
            })
        })
        .collect()
}

/// `remote -v` (fetch lines give name + URL) joined with the
/// `refs/remotes` short names (`origin/main`; `<remote>/HEAD` dropped).
pub fn parse_remotes(urls_raw: &str, refs_raw: &str) -> Vec<RemoteInfo> {
    let mut remotes: Vec<RemoteInfo> = Vec::new();
    for l in urls_raw.lines() {
        let mut it = l.split('\t');
        let (Some(name), Some(rest)) = (it.next(), it.next()) else { continue };
        if !rest.ends_with("(fetch)") {
            continue;
        }
        let url = rest.trim_end_matches("(fetch)").trim().to_string();
        if !remotes.iter().any(|r| r.name == name) {
            remotes.push(RemoteInfo { name: name.to_string(), url, branches: vec![] });
        }
    }
    for l in refs_raw.lines() {
        let Some((remote, branch)) = l.split_once('/') else { continue };
        if branch == "HEAD" {
            continue;
        }
        if let Some(r) = remotes.iter_mut().find(|r| r.name == remote) {
            r.branches.push(branch.to_string());
        }
    }
    remotes
}

/// Lines of `stash list --format='%gd%00%gs%00%cr'`.
pub fn parse_stashes(raw: &str) -> Vec<StashInfo> {
    raw.lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.split('\0').collect();
            if f.len() < 3 {
                return None;
            }
            let index = f[0].trim_start_matches("stash@{").trim_end_matches('}').parse().ok()?;
            Some(StashInfo { index, message: f[1].to_string(), date: f[2].to_string() })
        })
        .collect()
}

#[cfg(test)]
mod refs_tests {
    use super::*;

    #[test]
    fn track_parses_ahead_behind_gone_and_empty() {
        assert_eq!(parse_track("[ahead 2, behind 1]"), (2, 1, false));
        assert_eq!(parse_track("[ahead 3]"), (3, 0, false));
        assert_eq!(parse_track("[behind 4]"), (0, 4, false));
        assert_eq!(parse_track("[gone]"), (0, 0, true));
        assert_eq!(parse_track(""), (0, 0, false));
    }

    #[test]
    fn branches_parse_current_upstream_and_counts() {
        let raw = "main\0*\0origin/main\0[ahead 1]\0abc1234\0base commit\nfeature\0 \0\0\0def5678\0wip\n";
        let b = parse_branches(raw);
        assert_eq!(b.len(), 2);
        assert!(b[0].current && b[0].upstream.as_deref() == Some("origin/main") && b[0].ahead == 1 && b[0].subject == "base commit");
        assert!(!b[1].current && b[1].upstream.is_none());
    }

    #[test]
    fn remotes_group_branches_and_drop_head_pointers() {
        let urls = "origin\tgit@github.com:a/b.git (fetch)\norigin\tgit@github.com:a/b.git (push)\nupstream\thttps://x/y (fetch)\n";
        let refs = "origin/HEAD\norigin/main\norigin/feature\n";
        let r = parse_remotes(urls, refs);
        assert_eq!(r.len(), 2);
        assert_eq!(r[0].name, "origin");
        assert_eq!(r[0].branches, vec!["main".to_string(), "feature".to_string()]);
        assert_eq!(r[0].url, "git@github.com:a/b.git");
        assert!(r[1].branches.is_empty());
    }

    #[test]
    fn stashes_parse_index_message_and_date() {
        let s = parse_stashes("stash@{0}\0WIP on main: abc msg\02 minutes ago\nstash@{1}\0On feature: x\03 days ago\n");
        assert_eq!(s.len(), 2);
        assert_eq!((s[1].index, s[1].message.as_str(), s[1].date.as_str()), (1, "On feature: x", "3 days ago"));
    }
}

fn letter(c: char) -> Option<&'static str> {
    match c {
        'M' | 'T' => Some("M"),
        'A' => Some("A"),
        'D' => Some("D"),
        'R' => Some("R"),
        'C' => Some("C"),
        _ => None,
    }
}

fn sort_entries(list: &mut [FileEntry]) {
    // Conflicts first (spec §1), then by path.
    list.sort_by(|a, b| (a.status != "U").cmp(&(b.status != "U")).then_with(|| a.path.cmp(&b.path)));
}

/// Parses `git status --porcelain=v2 -z --untracked-files=all` output.
/// A path changed in both the index and the worktree yields an entry in
/// BOTH lists; unmerged (`u`) and untracked (`?`) records go to `unstaged`.
pub fn parse_status(raw: &[u8]) -> StatusResult {
    let text = String::from_utf8_lossy(raw);
    let mut tokens = text.split('\0').filter(|t| !t.is_empty());
    let mut out = StatusResult::default();

    while let Some(rec) = tokens.next() {
        let kind = rec.chars().next().unwrap_or('#');
        match kind {
            '1' | '2' => {
                // "<kind> XY sub mH mI mW hH hI [Xscore] path"
                let fields: Vec<&str> = rec.splitn(if kind == '1' { 9 } else { 10 }, ' ').collect();
                let (xy, path) = match (fields.get(1), fields.last()) {
                    (Some(xy), Some(path)) if fields.len() >= 9 => (*xy, (*path).to_string()),
                    _ => continue,
                };
                let old_path = if kind == '2' { tokens.next().map(|s| s.to_string()) } else { None };
                let mut xy = xy.chars();
                let x = xy.next().unwrap_or('.');
                let y = xy.next().unwrap_or('.');
                if let Some(s) = letter(x) {
                    out.staged.push(FileEntry { path: path.clone(), old_path: old_path.clone(), status: s.to_string() });
                }
                if let Some(s) = letter(y) {
                    out.unstaged.push(FileEntry { path, old_path: None, status: s.to_string() });
                }
            }
            'u' => {
                if let Some(path) = rec.splitn(11, ' ').last() {
                    out.unstaged.push(FileEntry { path: path.to_string(), old_path: None, status: "U".into() });
                }
            }
            '?' => {
                if let Some(path) = rec.strip_prefix("? ") {
                    out.unstaged.push(FileEntry { path: path.to_string(), old_path: None, status: "?".into() });
                }
            }
            _ => {} // '!' ignored entries and '#' headers
        }
    }
    sort_entries(&mut out.staged);
    sort_entries(&mut out.unstaged);
    out
}

/// Parses a `@@ -a[,b] +c[,d] @@…` header into (a, b, c, d); a missing
/// count means 1 (unified-diff convention).
fn parse_hunk_header(line: &str) -> Option<(u32, u32, u32, u32)> {
    let rest = line.strip_prefix("@@ -")?;
    let end = rest.find(" @@")?;
    let ranges = &rest[..end];
    let (old, new) = ranges.split_once(" +")?;
    fn range(s: &str) -> Option<(u32, u32)> {
        match s.split_once(',') {
            Some((a, b)) => Some((a.parse().ok()?, b.parse().ok()?)),
            None => Some((s.parse().ok()?, 1)),
        }
    }
    let (os, ol) = range(old)?;
    let (ns, nl) = range(new)?;
    Some((os, ol, ns, nl))
}

/// Parses `git diff` unified output for ONE file. Preamble lines
/// (`diff --git`, `index`, `new file mode`, `rename from/to`, `---`,
/// `+++`) are skipped; only hunk headers and `+`/`-`/` `/`\` lines matter.
pub fn parse_diff(path: &str, old_path: Option<&str>, raw: &str) -> FileDiff {
    let mut hunks: Vec<Hunk> = Vec::new();
    let mut old_no = 0u32;
    let mut new_no = 0u32;

    for line in raw.split_inclusive('\n') {
        let line = line.strip_suffix('\n').unwrap_or(line);
        if let Some((os, ol, ns, nl)) = line.starts_with("@@").then(|| parse_hunk_header(line)).flatten() {
            hunks.push(Hunk { header: line.to_string(), old_start: os, old_lines: ol, new_start: ns, new_lines: nl, lines: Vec::new() });
            old_no = os;
            new_no = ns;
            continue;
        }
        let Some(hunk) = hunks.last_mut() else { continue };
        if let Some(text) = line.strip_prefix('+') {
            hunk.lines.push(Line { kind: "add".into(), text: text.into(), old_no: None, new_no: Some(new_no), no_newline: false });
            new_no += 1;
        } else if let Some(text) = line.strip_prefix('-') {
            hunk.lines.push(Line { kind: "del".into(), text: text.into(), old_no: Some(old_no), new_no: None, no_newline: false });
            old_no += 1;
        } else if let Some(text) = line.strip_prefix(' ') {
            hunk.lines.push(Line { kind: "context".into(), text: text.into(), old_no: Some(old_no), new_no: Some(new_no), no_newline: false });
            old_no += 1;
            new_no += 1;
        } else if line.starts_with('\\') {
            if let Some(prev) = hunk.lines.last_mut() {
                prev.no_newline = true;
            }
        } else if line.is_empty() {
            // A blank context line whose leading space was trimmed by a
            // pager/editor; treat as context to stay robust.
            hunk.lines.push(Line { kind: "context".into(), text: String::new(), old_no: Some(old_no), new_no: Some(new_no), no_newline: false });
            old_no += 1;
            new_no += 1;
        }
    }

    FileDiff { path: path.to_string(), old_path: old_path.map(str::to_string), binary: false, too_large: false, hunks }
}

#[cfg(test)]
mod status_tests {
    use super::*;

    fn z(records: &[&str]) -> Vec<u8> {
        let mut v = Vec::new();
        for r in records {
            v.extend_from_slice(r.as_bytes());
            v.push(0);
        }
        v
    }

    #[test]
    fn a_file_modified_in_both_index_and_worktree_appears_in_both_lists() {
        let raw = z(&["1 MM N... 100644 100644 100644 600d48a d2099bb f.txt"]);
        let s = parse_status(&raw);
        assert_eq!(s.staged, vec![FileEntry { path: "f.txt".into(), old_path: None, status: "M".into() }]);
        assert_eq!(s.unstaged, vec![FileEntry { path: "f.txt".into(), old_path: None, status: "M".into() }]);
    }

    #[test]
    fn index_only_and_worktree_only_changes_land_in_one_list_each() {
        let raw = z(&[
            "1 A. N... 000000 100644 100644 0000000 7898192 new.ts",
            "1 .D N... 100644 100644 000000 abc1234 abc1234 gone.md",
            "1 .T N... 100644 100644 120000 abc1234 abc1234 link",
        ]);
        let s = parse_status(&raw);
        assert_eq!(s.staged.iter().map(|e| (e.path.as_str(), e.status.as_str())).collect::<Vec<_>>(), vec![("new.ts", "A")]);
        assert_eq!(
            s.unstaged.iter().map(|e| (e.path.as_str(), e.status.as_str())).collect::<Vec<_>>(),
            vec![("gone.md", "D"), ("link", "M")]
        );
    }

    #[test]
    fn rename_records_take_the_original_path_from_the_next_token() {
        let raw = z(&["2 RM N... 100644 100644 100644 600d48a d2099bb R64 g.txt", "f.txt"]);
        let s = parse_status(&raw);
        assert_eq!(s.staged, vec![FileEntry { path: "g.txt".into(), old_path: Some("f.txt".into()), status: "R".into() }]);
        assert_eq!(s.unstaged, vec![FileEntry { path: "g.txt".into(), old_path: None, status: "M".into() }]);
    }

    #[test]
    fn untracked_and_unmerged_go_to_unstaged_and_sort_conflicts_first() {
        let raw = z(&[
            "? zzz.txt",
            "u UU N... 100644 100644 100644 100644 aaaa bbbb cccc conflict.rs",
            "! ignored.log",
        ]);
        let s = parse_status(&raw);
        assert_eq!(
            s.unstaged.iter().map(|e| (e.path.as_str(), e.status.as_str())).collect::<Vec<_>>(),
            vec![("conflict.rs", "U"), ("zzz.txt", "?")]
        );
        assert!(s.staged.is_empty());
    }

    #[test]
    fn lists_are_sorted_by_path_and_paths_with_spaces_survive() {
        let raw = z(&[
            "1 .M N... 100644 100644 100644 a b src/zeta.ts",
            "1 .M N... 100644 100644 100644 a b my file.txt",
        ]);
        let s = parse_status(&raw);
        assert_eq!(s.unstaged.iter().map(|e| e.path.as_str()).collect::<Vec<_>>(), vec!["my file.txt", "src/zeta.ts"]);
    }

    #[test]
    fn headers_and_empty_input_yield_empty_lists() {
        assert_eq!(parse_status(&z(&["# branch.oid abc", "# branch.head main"])), StatusResult::default());
        assert_eq!(parse_status(b""), StatusResult::default());
    }
}

#[cfg(test)]
mod diff_tests {
    use super::*;

    const SAMPLE: &str = "diff --git a/f.txt b/f.txt\nindex 600d48a..e12a1b5 100644\n--- a/f.txt\n+++ b/f.txt\n@@ -1,5 +1,6 @@\n alpha\n-beta\n+BETA\n gamma\n-delta\n+new1\n+new2\n epsilon\n";

    fn l(kind: &str, text: &str, old_no: Option<u32>, new_no: Option<u32>) -> Line {
        Line { kind: kind.into(), text: text.into(), old_no, new_no, no_newline: false }
    }

    #[test]
    fn parses_one_hunk_with_running_line_numbers() {
        let d = parse_diff("f.txt", None, SAMPLE);
        assert_eq!(d.path, "f.txt");
        assert_eq!(d.old_path, None);
        assert!(!d.binary && !d.too_large);
        assert_eq!(d.hunks.len(), 1);
        let h = &d.hunks[0];
        assert_eq!((h.header.as_str(), h.old_start, h.old_lines, h.new_start, h.new_lines), ("@@ -1,5 +1,6 @@", 1, 5, 1, 6));
        assert_eq!(
            h.lines,
            vec![
                l("context", "alpha", Some(1), Some(1)),
                l("del", "beta", Some(2), None),
                l("add", "BETA", None, Some(2)),
                l("context", "gamma", Some(3), Some(3)),
                l("del", "delta", Some(4), None),
                l("add", "new1", None, Some(4)),
                l("add", "new2", None, Some(5)),
                l("context", "epsilon", Some(5), Some(6)),
            ]
        );
    }

    #[test]
    fn header_without_counts_means_one_line_and_no_newline_marker_attaches_to_previous_line() {
        let raw = "diff --git a/n.txt b/n.txt\nindex c1b0730..e25f181 100644\n--- a/n.txt\n+++ b/n.txt\n@@ -1 +1 @@\n-x\n\\ No newline at end of file\n+y\n\\ No newline at end of file\n";
        let d = parse_diff("n.txt", None, raw);
        let h = &d.hunks[0];
        assert_eq!((h.header.as_str(), h.old_start, h.old_lines, h.new_start, h.new_lines), ("@@ -1 +1 @@", 1, 1, 1, 1));
        assert_eq!(h.lines.len(), 2);
        assert!(h.lines[0].no_newline && h.lines[1].no_newline);
        assert_eq!(h.lines[0].text, "x");
        assert_eq!(h.lines[1].text, "y");
    }

    #[test]
    fn multiple_hunks_and_function_context_in_header_are_kept() {
        let raw = "--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@ fn main() {\n a\n-b\n+B\n@@ -10,2 +10,3 @@\n j\n+K\n k\n";
        let d = parse_diff("x", None, raw);
        assert_eq!(d.hunks.len(), 2);
        assert_eq!(d.hunks[0].header, "@@ -1,2 +1,2 @@ fn main() {");
        assert_eq!(d.hunks[1].old_start, 10);
        assert_eq!(d.hunks[1].lines[1], l("add", "K", None, Some(11)));
    }

    #[test]
    fn new_file_and_rename_preambles_are_skipped_and_old_path_is_passed_through() {
        let raw = "diff --git a/u.txt b/u.txt\nnew file mode 100644\nindex 0000000..ce01362\n--- /dev/null\n+++ b/u.txt\n@@ -0,0 +1 @@\n+hello\n";
        let d = parse_diff("u.txt", None, raw);
        assert_eq!(d.hunks[0].lines, vec![l("add", "hello", None, Some(1))]);
        let renamed = parse_diff("g.txt", Some("f.txt"), "diff --git a/f.txt b/g.txt\nsimilarity index 64%\nrename from f.txt\nrename to g.txt\n");
        assert_eq!(renamed.old_path.as_deref(), Some("f.txt"));
        assert!(renamed.hunks.is_empty());
    }

    #[test]
    fn empty_output_is_an_empty_diff() {
        assert!(parse_diff("x", None, "").hunks.is_empty());
    }
}
