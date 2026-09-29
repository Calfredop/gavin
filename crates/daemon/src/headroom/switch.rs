//! The daemon's copy of the compression switch.
//!
//! Compression is on or off per workspace, and the setting is the
//! app's: it lives in `config.json`, where a workspace's own choice
//! falls through to an app-wide default. The daemon keeps a copy of the
//! RESOLVED answer per workspace because it is the one that needs it
//! when nobody is there to ask -- a session another agent spawns over
//! MCP never passes through the app, and a daemon that restarts before
//! any app connects still has to know whether to start Headroom.
//!
//! So the app pushes the whole list whenever it changes, and this holds
//! and persists it. It decides nothing about Headroom itself: `any_on`
//! is what `Headroom::set_workspaces` turns into a start or a stop.

use super::store;
use protocol::{BuildProfile, HeadroomWorkspace};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError};

/// What is remembered between lifetimes: each workspace the app named,
/// by path, and whether compression is on in it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct SwitchRecord {
    pub workspaces: BTreeMap<String, bool>,
}

/// Per build, like the run record beside it: it is one daemon's copy of
/// what ITS app said, and a dev daemon reading the release app's list
/// would be holding a copy of something it was never told.
pub fn switch_path(state_dir: &Path, profile: BuildProfile) -> PathBuf {
    state_dir.join(protocol::profile_file_name("headroom-workspaces", "json", profile))
}

/// One spelling per workspace.
///
/// The path arrives from three places -- the app's push, `CreateSession`
/// and gavin-mcp's `SpawnAgentSession` -- and they need not agree on a
/// trailing slash or a symlink (`/tmp` is one on macOS). Resolved when
/// the directory is there to resolve, which is when a session can be
/// spawned in it; trimmed otherwise, so a workspace whose disk is
/// unmounted keeps its setting under the name it was given.
pub fn key(workspace_path: &str) -> String {
    match std::fs::canonicalize(workspace_path) {
        Ok(resolved) => resolved.to_string_lossy().into_owned(),
        Err(_) => {
            let trimmed = workspace_path.trim_end_matches(['/', '\\']);
            if trimmed.is_empty() { workspace_path } else { trimmed }.to_string()
        }
    }
}

pub struct Switch {
    path: PathBuf,
    record: Mutex<SwitchRecord>,
}

impl Switch {
    /// Reads what the last lifetime was told.
    pub fn open(state_dir: &Path, profile: BuildProfile) -> Switch {
        let path = switch_path(state_dir, profile);
        let record = store::load(&path);
        Switch { path, record: Mutex::new(record) }
    }

    fn lock(&self) -> MutexGuard<'_, SwitchRecord> {
        self.record.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Takes the app's list in place of the one held, and persists it.
    ///
    /// Replaced, not merged: a workspace the app has closed is simply
    /// absent from the next list, and a merge would keep Headroom
    /// running for a workspace nobody can turn off any more.
    ///
    /// A list that names one workspace twice ends on its last word. The
    /// write is attempted even when nothing changed, so a record the
    /// human deleted comes back; a failure to write is reported and the
    /// copy in memory still stands for this lifetime.
    pub fn replace(&self, workspaces: &[HeadroomWorkspace]) {
        let next = SwitchRecord {
            workspaces: workspaces
                .iter()
                .map(|workspace| (key(&workspace.workspace_path), workspace.enabled))
                .collect(),
        };
        let mut record = self.lock();
        *record = next;
        if let Err(e) = store::save(&self.path, &*record) {
            eprintln!("headroom: could not write {}: {e}", self.path.display());
        }
    }

    /// Whether compression is on in this workspace. A workspace the app
    /// never named is off: the default starts Off, and a daemon that
    /// guessed otherwise would be compressing on nobody's say-so.
    pub fn is_on(&self, workspace_path: &str) -> bool {
        self.lock().workspaces.get(&key(workspace_path)).copied().unwrap_or(false)
    }

    /// Whether any workspace wants compression, which is whether
    /// Headroom should be running at all.
    pub fn any_on(&self) -> bool {
        self.lock().workspaces.values().any(|on| *on)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workspace(path: &str, enabled: bool) -> HeadroomWorkspace {
        HeadroomWorkspace { workspace_path: path.to_string(), enabled }
    }

    fn open(dir: &Path) -> Switch {
        Switch::open(dir, BuildProfile::Release)
    }

    #[test]
    fn a_daemon_that_was_told_nothing_compresses_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let switch = open(dir.path());

        assert!(!switch.any_on());
        assert!(!switch.is_on("/work/gavin"));
    }

    #[test]
    fn a_workspace_is_on_when_the_app_said_so_and_only_then() {
        let dir = tempfile::tempdir().unwrap();
        let switch = open(dir.path());

        switch.replace(&[workspace("/work/gavin", true), workspace("/work/other", false)]);

        assert!(switch.is_on("/work/gavin"));
        assert!(!switch.is_on("/work/other"));
        assert!(!switch.is_on("/work/never-named"));
        assert!(switch.any_on());
    }

    #[test]
    fn the_copy_survives_a_restart() {
        let dir = tempfile::tempdir().unwrap();
        open(dir.path()).replace(&[workspace("/work/gavin", true), workspace("/work/other", false)]);

        let next = open(dir.path());

        assert!(next.is_on("/work/gavin"));
        assert!(!next.is_on("/work/other"));
        assert!(next.any_on());
    }

    /// The reason the list is replaced and not merged: closing the last
    /// compressed workspace has to be able to stop Headroom.
    #[test]
    fn a_workspace_left_out_of_the_next_list_stops_counting() {
        let dir = tempfile::tempdir().unwrap();
        let switch = open(dir.path());
        switch.replace(&[workspace("/work/gavin", true), workspace("/work/other", false)]);

        switch.replace(&[workspace("/work/other", false)]);

        assert!(!switch.is_on("/work/gavin"));
        assert!(!switch.any_on());
        assert!(!open(dir.path()).any_on(), "and the next lifetime agrees");
    }

    #[test]
    fn a_workspace_is_the_same_one_however_its_path_is_spelled() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("repo");
        std::fs::create_dir(&root).unwrap();
        let plain = root.to_string_lossy().into_owned();
        let switch = open(dir.path());

        switch.replace(&[workspace(&format!("{plain}/"), true)]);

        assert!(switch.is_on(&plain));
        assert!(switch.is_on(&format!("{plain}/")));
        assert!(switch.is_on(&format!("{plain}/../repo")));
    }

    #[cfg(unix)]
    #[test]
    fn a_workspace_reached_through_a_symlink_is_the_one_it_points_at() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("repo");
        std::fs::create_dir(&root).unwrap();
        let link = dir.path().join("link");
        std::os::unix::fs::symlink(&root, &link).unwrap();
        let switch = open(dir.path());

        switch.replace(&[workspace(&link.to_string_lossy(), true)]);

        assert!(switch.is_on(&root.to_string_lossy()));
    }

    #[test]
    fn a_workspace_that_is_not_on_this_disk_keeps_its_setting_under_its_name() {
        let dir = tempfile::tempdir().unwrap();
        let switch = open(dir.path());

        switch.replace(&[workspace("/Volumes/unmounted/repo/", true)]);

        assert!(switch.is_on("/Volumes/unmounted/repo"));
    }

    #[test]
    fn a_list_naming_a_workspace_twice_ends_on_its_last_word() {
        let dir = tempfile::tempdir().unwrap();
        let switch = open(dir.path());

        switch.replace(&[workspace("/work/gavin", true), workspace("/work/gavin", false)]);

        assert!(!switch.is_on("/work/gavin"));
    }

    #[test]
    fn a_release_and_a_dev_daemon_each_keep_their_own_copy() {
        let dir = tempfile::tempdir().unwrap();
        Switch::open(dir.path(), BuildProfile::Release).replace(&[workspace("/work/gavin", true)]);

        let dev = Switch::open(dir.path(), BuildProfile::Dev);

        assert!(!dev.is_on("/work/gavin"));
        assert_ne!(
            switch_path(dir.path(), BuildProfile::Release),
            switch_path(dir.path(), BuildProfile::Dev)
        );
    }

    #[test]
    fn a_damaged_record_reads_as_nothing_told() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(switch_path(dir.path(), BuildProfile::Release), "{ not json").unwrap();

        let switch = open(dir.path());

        assert!(!switch.any_on());
    }
}
