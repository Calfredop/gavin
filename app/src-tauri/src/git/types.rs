use serde::{Deserialize, Serialize};

/// One changed path in one list. `status` is a single letter:
/// M A D R C ? U (T — type change — is folded into M).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    pub status: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StatusResult {
    pub unstaged: Vec<FileEntry>,
    pub staged: Vec<FileEntry>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Line {
    /// "context" | "add" | "del"
    pub kind: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub old_no: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub new_no: Option<u32>,
    #[serde(default)]
    pub no_newline: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hunk {
    /// The raw `@@ … @@` line, verbatim.
    pub header: String,
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    pub lines: Vec<Line>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    #[serde(default)]
    pub binary: bool,
    #[serde(default)]
    pub too_large: bool,
    #[serde(default)]
    pub hunks: Vec<Hunk>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Author {
    pub name: String,
    pub email: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
    pub name: String,
    pub current: bool,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub sha: String,
    pub subject: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteInfo {
    pub name: String,
    pub url: String,
    pub branches: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StashInfo {
    pub index: u32,
    pub message: String,
    /// Relative date (`%cr`), e.g. "2 minutes ago".
    pub date: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    pub path: String,
    pub head: String,
    /// None when detached.
    pub branch: Option<String>,
    pub is_main: bool,
    pub locked: bool,
    pub prunable: bool,
}

/// Everything the sidebar and toolbar render, fetched in one `git_refs`
/// call alongside status (spec SP2 §1.2).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RefsSnapshot {
    pub branches: Vec<BranchInfo>,
    pub remotes: Vec<RemoteInfo>,
    pub stashes: Vec<StashInfo>,
    pub worktrees: Vec<WorktreeInfo>,
    pub head_branch: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    pub not_a_repo: bool,
    pub root: Option<String>,
    /// Branch name, or the short SHA when `detached`.
    pub branch: Option<String>,
    pub detached: bool,
    pub unborn: bool,
    pub author: Option<Author>,
    pub head_message: Option<String>,
    /// "merge" | "rebase" | null
    pub in_progress: Option<String>,
}
