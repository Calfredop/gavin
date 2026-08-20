//! Pure parsers for git's machine-readable output (spec §2). Both are
//! exact by necessity: the frontend patch builder reverses `parse_diff`.

use crate::git::types::{FileDiff, FileEntry, Hunk, Line, StatusResult};

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
