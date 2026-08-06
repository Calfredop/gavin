// Second language, to confirm highlighting is not hardcoded to one:
// fileLanguage("sample.rs") -> "rust".

use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq)]
pub struct FileTab {
    pub id: String,
    pub path: String,
}

impl FileTab {
    pub fn new(id: &str, path: &str) -> Self {
        Self { id: id.to_string(), path: path.to_string() }
    }
}

pub fn index_by_id(tabs: Vec<FileTab>) -> HashMap<String, FileTab> {
    tabs.into_iter().map(|t| (t.id.clone(), t)).collect()
}
