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
#[cfg(test)]
pub fn parse_porcelain_v2(output: &str) -> Option<ParsedGitStatus> {
    parse_porcelain_v2_impl(output)
}

#[cfg(not(test))]
pub fn parse_porcelain_v2(output: &str) -> Option<ParsedGitStatus> {
    parse_porcelain_v2_impl(output)
}

fn parse_porcelain_v2_impl(output: &str) -> Option<ParsedGitStatus> {
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
