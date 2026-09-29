//! What the daemon remembers about Headroom between lifetimes.
//!
//! Two files, because there are two kinds of fact.
//!
//! `headroom.json` is about the MACHINE: where Headroom is, and the file
//! the human located. It is shared by the release and dev daemons the
//! way `kanban.sqlite` is -- the human located Headroom once, and a
//! rebuild is not a reason to make them do it again.
//!
//! `headroom-run[-dev].json` is about ONE DAEMON's Headroom: whether it
//! is wanted, the port it was given, and the process it is. It splits
//! per build for the reason `registry.sqlite` does: it holds process
//! identity, and a dev daemon reading the release daemon's pid would
//! adopt -- and later stop -- a proxy that is not its own.

use protocol::BuildProfile;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Where Headroom is on this machine.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct InstallRecord {
    /// The absolute path every start uses.
    pub path: Option<PathBuf>,
    /// `detect::Source::id` of where it was found.
    pub source: Option<String>,
    /// What it said its version was when it was found.
    pub version: Option<String>,
    /// The file the human picked with Locate…, kept even while another
    /// candidate wins, so "Check again" still has it to fall back on.
    pub located: Option<PathBuf>,
}

/// One daemon's Headroom.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct RunRecord {
    /// Whether this daemon has been asked to keep Headroom running.
    /// Persisted so a daemon that restarts before any app connects
    /// still knows.
    pub wanted: bool,
    /// The port, chosen once and kept. Every compressed agent carries it
    /// in its environment, so a restart on another port would strand
    /// every one of them.
    pub port: Option<u16>,
    /// The process this daemon started, until it is known to be gone.
    pub process: Option<ProcessRecord>,
    /// `/stats`' lifetime total as last read, so Settings has a number
    /// to show while Headroom is stopped.
    pub lifetime_tokens_saved: Option<u64>,
}

/// A Headroom this daemon started: enough to recognise it again after a
/// crash, and to refuse anything that merely resembles it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProcessRecord {
    pub pid: u32,
    /// The reuse guard, as `proc::ProcessHandle` records it.
    pub started_at_us: i64,
    /// What `/health` must still say.
    pub version: String,
    /// What it was started on.
    pub port: u16,
}

impl ProcessRecord {
    pub fn handle(&self) -> crate::proc::ProcessHandle {
        crate::proc::ProcessHandle { pid: self.pid, started_at_us: self.started_at_us }
    }
}

pub fn install_path(state_dir: &Path) -> PathBuf {
    state_dir.join("headroom.json")
}

pub fn run_path(state_dir: &Path, profile: BuildProfile) -> PathBuf {
    state_dir.join(protocol::profile_file_name("headroom-run", "json", profile))
}

/// Reads a record, and reads anything it cannot parse as no record.
///
/// A truncated or hand-edited file must not stop the daemon starting:
/// the default for both records is "nothing known", which costs a fresh
/// detection or a fresh start, and both are safe.
pub fn load<T: Default + for<'de> Deserialize<'de>>(path: &Path) -> T {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|body| serde_json::from_str(&body).ok())
        .unwrap_or_default()
}

/// Writes a record whole, by rename, so a reader never sees half of one
/// and a crash mid-write leaves the previous record rather than none.
pub fn save<T: Serialize>(path: &Path, record: &T) -> anyhow::Result<()> {
    let body = serde_json::to_string_pretty(record)?;
    let file_name = path
        .file_name()
        .ok_or_else(|| anyhow::anyhow!("{} names no file", path.display()))?
        .to_string_lossy()
        .into_owned();
    // Unique per writer: two daemons share `headroom.json`, and two
    // threads of one daemon can write a run record at once.
    let temp = path.with_file_name(format!(
        ".{file_name}.{}.{:?}.tmp",
        std::process::id(),
        std::thread::current().id()
    ));
    std::fs::write(&temp, body)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&temp, std::fs::Permissions::from_mode(0o600))?;
    }
    if let Err(e) = std::fs::rename(&temp, path) {
        let _ = std::fs::remove_file(&temp);
        return Err(e.into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_record_reads_back_as_it_was_written() {
        let dir = tempfile::tempdir().unwrap();
        let path = run_path(dir.path(), BuildProfile::Dev);
        let record = RunRecord {
            wanted: true,
            port: Some(51234),
            process: Some(ProcessRecord {
                pid: 4172,
                started_at_us: 1_790_000_000_123_456,
                version: "0.39.1".into(),
                port: 51234,
            }),
            lifetime_tokens_saved: Some(98_765),
        };
        save(&path, &record).unwrap();
        assert_eq!(load::<RunRecord>(&path), record);
    }

    #[test]
    fn a_missing_or_damaged_record_reads_as_nothing_known() {
        let dir = tempfile::tempdir().unwrap();
        let path = install_path(dir.path());
        assert_eq!(load::<InstallRecord>(&path), InstallRecord::default());

        std::fs::write(&path, "{\"path\": \"/x/headroom\", \"sour").unwrap();
        assert_eq!(load::<InstallRecord>(&path), InstallRecord::default());
        assert_eq!(load::<RunRecord>(&path), RunRecord::default());
    }

    /// A record written by a build that knew fewer fields still loads,
    /// and one written by a build that knows more does not fail here.
    #[test]
    fn a_record_with_missing_or_extra_fields_still_loads() {
        let dir = tempfile::tempdir().unwrap();
        let path = run_path(dir.path(), BuildProfile::Release);
        std::fs::write(&path, r#"{"wanted": true, "port": 50001, "later": [1, 2]}"#).unwrap();
        let record: RunRecord = load(&path);
        assert!(record.wanted);
        assert_eq!(record.port, Some(50001));
        assert_eq!(record.process, None);
    }

    #[test]
    fn the_run_record_splits_per_build_and_the_install_record_does_not() {
        let dir = Path::new("/state");
        assert_eq!(run_path(dir, BuildProfile::Release), dir.join("headroom-run.json"));
        assert_eq!(run_path(dir, BuildProfile::Dev), dir.join("headroom-run-dev.json"));
        assert_eq!(install_path(dir), dir.join("headroom.json"));
    }

    #[test]
    fn saving_replaces_the_record_and_leaves_no_temporary_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = install_path(dir.path());
        for version in ["0.38.0", "0.39.1"] {
            let record = InstallRecord {
                path: Some("/x/headroom".into()),
                source: Some("located".into()),
                version: Some(version.into()),
                located: Some("/x/headroom".into()),
            };
            save(&path, &record).unwrap();
            assert_eq!(load::<InstallRecord>(&path), record);
        }
        let names: Vec<String> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, ["headroom.json"]);
    }

    #[cfg(unix)]
    #[test]
    fn a_record_is_readable_by_its_owner_alone() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = run_path(dir.path(), BuildProfile::Dev);
        save(&path, &RunRecord::default()).unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }
}
