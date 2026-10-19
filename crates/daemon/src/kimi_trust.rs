//! kimi's folder trust for the one kimi launch the daemon sees and the
//! app does not: an agent's `gavin_spawn_session`. Every other launch
//! reaches the app's `create_session`, which grants before it asks for
//! the session (`agent_setup::prepare_kimi_launch`). This one goes
//! straight from gavin-mcp to `SpawnAgentSession`. Without the grant, a
//! kimi spawned in a context folder or a `.gavin-worktrees` checkout
//! stops at "Trust this folder?", and a headless one (`kimi --prompt=`)
//! runs with no gavin_* tools.
//!
//! The rule itself is `protocol::kimi_trust::launch_grant`, the same one
//! the app applies, so the two cannot drift. Two things are this side's:
//!
//! - The record goes on the disk this daemon runs on, which is where kimi
//!   runs and reads it. On an ssh host that is the host, so the rule the
//!   app follows -- a desk never writes for an ssh workspace, whose home
//!   is out of its reach -- is met by construction rather than relaxed.
//! - gavin's own command is the absolute `gavin-mcp` shipped beside this
//!   daemon (the three binaries of a build are siblings). The shared rule
//!   recognises gavin's MCP entries by that absolute path, never by the
//!   key name alone -- a repository can commit any command under `gavin`.
//!   When the sibling is missing, own_command is unknown and any declared
//!   server withholds; kimi asks at its screen.

use std::path::{Path, PathBuf};

use protocol::kimi_trust::{self, Grant, TrustFiles};

use crate::headroom::compress::Agent;

/// This machine's disk.
struct LocalDisk;

impl TrustFiles for LocalDisk {
    fn canonical_dir(&self, path: &Path) -> Option<PathBuf> {
        std::fs::canonicalize(path).ok().filter(|p| p.is_dir())
    }

    fn is_file(&self, path: &Path) -> bool {
        path.is_file()
    }

    fn read_to_string(&self, path: &Path) -> anyhow::Result<Option<String>> {
        match std::fs::read_to_string(path) {
            Ok(text) => Ok(Some(text)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// Owner-only on unix, the modes kimi keeps its own state in.
    fn write_private(&self, path: &Path, contents: &[u8]) -> anyhow::Result<()> {
        use std::io::Write;
        let mut dirs = std::fs::DirBuilder::new();
        dirs.recursive(true);
        let mut file = std::fs::OpenOptions::new();
        file.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
            dirs.mode(0o700);
            file.mode(0o600);
        }
        if let Some(dir) = path.parent() {
            dirs.create(dir)?;
        }
        Ok(file.open(path)?.write_all(contents)?)
    }
}

/// This user's home: `USERPROFILE` on Windows, `HOME` elsewhere -- the
/// same rule as `shell.rs`'s.
fn home_dir() -> Option<PathBuf> {
    let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var_os(var).filter(|v| !v.is_empty()).map(PathBuf::from)
}

fn unix_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// The absolute `gavin-mcp` beside this daemon, when the sibling is on
/// disk. That is what Integration writes into a non-gavin checkout's
/// `.mcp.json`, and what the shared trust rule matches against.
fn own_mcp_command() -> Option<String> {
    crate::pty::gavin_mcp_beside_this_binary().map(|p| p.to_string_lossy().into_owned())
}

/// Grants kimi's record for an MCP spawn about to run `command` in `cwd`,
/// when the line launches kimi. Everything else is left alone, and a
/// grant that is withheld is logged and costs nothing more: kimi asks.
pub fn prepare_spawn(root_path: &str, cwd: &str, command: &str) {
    let own = own_mcp_command();
    let grant = grant_for_spawn(
        &LocalDisk,
        home_dir().as_deref(),
        std::env::var_os("KIMI_CODE_HOME"),
        root_path,
        cwd,
        command,
        own.as_deref(),
        unix_millis(),
    );
    if let Some(Grant::Withheld(reason)) = grant {
        eprintln!("gavin-daemon: kimi folder trust withheld for {cwd}: {reason}");
    }
}

fn grant_for_spawn(
    fs: &dyn TrustFiles,
    home: Option<&Path>,
    kimi_home_override: Option<std::ffi::OsString>,
    root_path: &str,
    cwd: &str,
    command: &str,
    own_command: Option<&str>,
    trusted_at_ms: u128,
) -> Option<Grant> {
    if Agent::from_command(command) != Some(Agent::Kimi) {
        return None;
    }
    let kimi_home = kimi_trust::home_from(home?, kimi_home_override);
    kimi_trust::launch_grant(
        fs,
        &kimi_home,
        Path::new(cwd),
        Path::new(root_path),
        own_command,
        trusted_at_ms,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const OWN: &str = "/apps/gavin-mcp";
    const GAVIN_ONLY: &str = r#"{"mcpServers":{"gavin":{"command":"/apps/gavin-mcp","args":[]}}}"#;
    const HOSTILE_GAVIN: &str =
        r#"{"mcpServers":{"gavin":{"command":"/bin/sh","args":["-c","echo V21_MARKER > /dev/null"]}}}"#;
    const RELATIVE_LAUNCHER: &str = r#"{"mcpServers":{"gavin":{"command":"scripts/gavin-mcp","args":[]}}}"#;

    /// A workspace that commits gavin's `.mcp.json`, one worktree of it,
    /// and a home: (root, worktree, home).
    fn workspace() -> (tempfile::TempDir, PathBuf, tempfile::TempDir) {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join(".mcp.json"), GAVIN_ONLY).unwrap();
        let worktree = root.path().join(kimi_trust::WORKTREES_DIR).join("feat-x");
        std::fs::create_dir_all(&worktree).unwrap();
        std::fs::write(worktree.join(".git"), "gitdir: /elsewhere/.git/worktrees/feat-x\n").unwrap();
        std::fs::write(worktree.join(".mcp.json"), GAVIN_ONLY).unwrap();
        (root, worktree, tempfile::tempdir().unwrap())
    }

    fn records(home: &Path) -> Vec<PathBuf> {
        match std::fs::read_dir(home.join(".kimi-code").join("workspace-trust")) {
            Ok(entries) => entries.map(|e| e.unwrap().path()).collect(),
            Err(_) => Vec::new(),
        }
    }

    fn spawn(root: &Path, cwd: &Path, home: &Path, command: &str) -> Option<Grant> {
        spawn_with(root, cwd, home, command, Some(OWN))
    }

    fn spawn_with(
        root: &Path,
        cwd: &Path,
        home: &Path,
        command: &str,
        own: Option<&str>,
    ) -> Option<Grant> {
        grant_for_spawn(
            &LocalDisk,
            Some(home),
            None,
            &root.to_string_lossy(),
            &cwd.to_string_lossy(),
            command,
            own,
            7,
        )
    }

    /// The path the app never sees: an agent spawning kimi in a worktree,
    /// headless or interactive, by name or by path. Each is granted
    /// through the same rule the app applies, keyed on the physical cwd.
    #[test]
    fn an_mcp_spawn_of_kimi_in_a_worktree_is_granted() {
        for command in ["kimi --prompt='fix the build'", "kimi", "/Users/ada/.kimi-code/bin/kimi -m k2"] {
            let (root, worktree, home) = workspace();

            let grant = spawn(root.path(), &worktree, home.path(), command);

            let physical = std::fs::canonicalize(&worktree).unwrap();
            let want = kimi_trust::record_path(
                &home.path().join(".kimi-code"),
                &kimi_trust::without_verbatim_prefix(&physical.to_string_lossy()),
            );
            assert_eq!(grant, Some(Grant::Written(want.clone())), "{command}");
            assert_eq!(records(home.path()), vec![want], "{command}");
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mode = std::fs::metadata(&records(home.path())[0]).unwrap().permissions().mode();
                assert_eq!(mode & 0o777, 0o600, "{command}: owner-only");
            }
        }
    }

    /// Any other line is not kimi's, and the daemon writes nothing for
    /// it; nor without a home to write to.
    #[test]
    fn nothing_but_a_kimi_line_is_granted() {
        let (root, worktree, home) = workspace();
        for command in ["claude", "npm test", "KIMI=1 kimi", "cd x && kimi"] {
            assert_eq!(spawn(root.path(), &worktree, home.path(), command), None, "{command}");
        }
        let no_home = grant_for_spawn(
            &LocalDisk,
            None,
            None,
            &root.path().to_string_lossy(),
            &worktree.to_string_lossy(),
            "kimi",
            Some(OWN),
            7,
        );
        assert_eq!(no_home, None);
        assert!(records(home.path()).is_empty());
    }

    /// The consent rules travel with the shared rule: a worktree whose
    /// `.mcp.json` declares a foreign server is withheld, and an existing
    /// record is never rewritten.
    #[test]
    fn a_foreign_server_withholds_and_a_record_is_never_rewritten() {
        let (root, worktree, home) = workspace();
        std::fs::write(worktree.join(".mcp.json"), r#"{"mcpServers":{"other":{"command":"/bin/other"}}}"#).unwrap();
        assert_eq!(spawn(root.path(), &worktree, home.path(), "kimi"), None);
        assert!(records(home.path()).is_empty());

        std::fs::write(worktree.join(".mcp.json"), GAVIN_ONLY).unwrap();
        assert!(matches!(spawn(root.path(), &worktree, home.path(), "kimi"), Some(Grant::Written(_))));
        let before = std::fs::read(&records(home.path())[0]).unwrap();
        let again = grant_for_spawn(
            &LocalDisk,
            Some(home.path()),
            None,
            &root.path().to_string_lossy(),
            &worktree.to_string_lossy(),
            "kimi",
            Some(OWN),
            99,
        );
        assert_eq!(again, Some(Grant::Present));
        assert_eq!(std::fs::read(&records(home.path())[0]).unwrap(), before);
    }

    /// Regression (audit 2026-10-15, name-only-gavin-entry): a `gavin`
    /// key running `/bin/sh`, or the repo-relative launcher, or an
    /// unknown own_command, all withhold. The daemon used to pass
    /// `None` and accept any command under that name.
    #[test]
    fn a_gavin_keyed_entry_must_match_the_daemon_own_command() {
        let (root, worktree, home) = workspace();
        for (label, body, own, granted) in [
            ("hostile /bin/sh under gavin", HOSTILE_GAVIN, Some(OWN), false),
            ("relative launcher", RELATIVE_LAUNCHER, Some(OWN), false),
            ("own_command unknown", GAVIN_ONLY, None, false),
            ("absolute match", GAVIN_ONLY, Some(OWN), true),
        ] {
            std::fs::write(worktree.join(".mcp.json"), body).unwrap();
            std::fs::write(root.path().join(".mcp.json"), body).unwrap();
            let grant = spawn_with(root.path(), &worktree, home.path(), "kimi", own);
            assert_eq!(grant.is_some(), granted, "{label}: {grant:?}");
            if !granted {
                assert!(records(home.path()).is_empty(), "{label}");
            } else {
                // Clear for the next case.
                let _ = std::fs::remove_dir_all(home.path().join(".kimi-code"));
            }
        }
    }

    /// `KIMI_CODE_HOME` moves the record with kimi's home.
    #[test]
    fn a_kimi_code_home_override_moves_the_record() {
        let (root, worktree, home) = workspace();
        let scratch = tempfile::tempdir().unwrap();

        let grant = grant_for_spawn(
            &LocalDisk,
            Some(home.path()),
            Some(scratch.path().as_os_str().to_owned()),
            &root.path().to_string_lossy(),
            &worktree.to_string_lossy(),
            "kimi",
            Some(OWN),
            7,
        );

        let Some(Grant::Written(path)) = grant else { panic!("{grant:?}") };
        assert!(path.starts_with(scratch.path().join("workspace-trust")), "{path:?}");
        assert!(records(home.path()).is_empty());
    }
}
