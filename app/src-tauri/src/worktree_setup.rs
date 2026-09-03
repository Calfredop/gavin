//! The repo-declared setup a new worktree runs before it is usable.
//!
//! A fresh `git worktree add` gives you a checkout with no `node_modules`,
//! no `target/`, no `.env` — so the first agent launched in it spends its
//! opening turn on `npm install` instead of on the work. This is the
//! declaration of what that worktree needs, kept in the repo beside every
//! other thing gavin knows about the workspace:
//!
//! ```toml
//! [worktree]
//! setup = ["npm install", "cargo fetch"]
//! ```
//!
//! Read here rather than through the daemon's tree push for the same reason
//! `agent_setup::root_agent_key` and `prd_relative_path` are: creating a
//! worktree is a one-shot, user-initiated action, and routing this through
//! the protocol would make the feature wait on a version bump, a daemon
//! rebuild and a compat gate before it could do anything at all.

use std::path::Path;

/// The command lines declared for this workspace, in file order.
///
/// Every failure reads as "no setup declared", which is the honest answer
/// for all of them: an absent config.toml is the normal case, and a file
/// that doesn't parse already surfaces to the human as the tree's
/// `configWarning` — raising it a second time here would only turn "your
/// new worktree has no setup" into "your new worktree could not be
/// created". Non-string and blank entries are dropped the way
/// `extra_contexts` drops them, so one bad line costs its own command and
/// not the rest of the list.
pub fn read_setup(root: &Path) -> Vec<String> {
    let path = root.join(".gavin-root").join("config.toml");
    let Ok(content) = std::fs::read_to_string(path) else { return vec![] };
    let Ok(table) = content.parse::<toml::Table>() else { return vec![] };
    table
        .get("worktree")
        .and_then(|v| v.as_table())
        .and_then(|t| t.get("setup"))
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

#[tauri::command]
pub fn worktree_setup(root_path: String) -> Vec<String> {
    read_setup(Path::new(&root_path))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn root_with(config: Option<&str>) -> TempDir {
        let dir = TempDir::new().unwrap();
        let g = dir.path().join(".gavin-root");
        std::fs::create_dir_all(&g).unwrap();
        if let Some(c) = config {
            std::fs::write(g.join("config.toml"), c).unwrap();
        }
        dir
    }

    #[test]
    fn reads_the_declared_commands_in_file_order() {
        let dir = root_with(Some(
            "version = 1\n\n[agent]\nprofile = \"claude-code\"\n\n[worktree]\nsetup = [\"npm install\", \"cargo fetch\"]\n",
        ));
        assert_eq!(read_setup(dir.path()), vec!["npm install", "cargo fetch"]);
    }

    #[test]
    fn a_workspace_that_declares_nothing_has_no_setup() {
        // The three shapes of "nothing", all of which are ordinary: no
        // config.toml at all, a config.toml without the block, and the
        // block with an empty list.
        assert!(read_setup(root_with(None).path()).is_empty());
        assert!(read_setup(root_with(Some("version = 1\n[agent]\nprofile = \"codex\"\n")).path()).is_empty());
        assert!(read_setup(root_with(Some("[worktree]\nsetup = []\n")).path()).is_empty());
    }

    #[test]
    fn an_unreadable_config_reads_as_no_setup_rather_than_an_error() {
        // config_warning in the tree is what tells the human their file is
        // broken; a worktree must still be creatable while it is.
        assert!(read_setup(root_with(Some("this is not [ valid toml\n")).path()).is_empty());
    }

    #[test]
    fn a_wrong_typed_setup_costs_only_the_entries_that_are_wrong() {
        // A scalar where the array belongs is no list at all...
        assert!(read_setup(root_with(Some("[worktree]\nsetup = \"npm install\"\n")).path()).is_empty());
        // ...but inside a real array, only the non-strings and the blanks
        // drop out. Losing the whole list to one stray entry would leave a
        // worktree half-set-up with nothing said about it.
        let dir = root_with(Some("[worktree]\nsetup = [\"npm install\", 7, \"\", \"  \", \"  make dev  \"]\n"));
        assert_eq!(read_setup(dir.path()), vec!["npm install", "make dev"]);
    }

    #[test]
    fn the_root_is_the_workspace_root_not_the_gavin_dir() {
        // Callers hand this the same path they hand watch_gavin_root; a
        // reader that expected `.gavin-root` itself would silently find
        // nothing forever.
        let dir = root_with(Some("[worktree]\nsetup = [\"make\"]\n"));
        assert_eq!(read_setup(dir.path()), vec!["make"]);
        assert!(read_setup(&dir.path().join(".gavin-root")).is_empty());
    }
}
