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
