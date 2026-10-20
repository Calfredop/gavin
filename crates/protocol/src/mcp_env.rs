//! Session env Cursor's MCP spawn cannot inherit.
//!
//! Cursor's Agent CLI strips almost every variable when it starts a
//! stdio MCP server (PATH/cwd only). Gavin used to re-forward
//! `GAVIN_SESSION_*` through `.cursor/mcp.json`'s `env` block with
//! `${env:…}` interpolation — which works for the tools, but Cursor
//! hashes the *resolved* env into its MCP approval fingerprint
//! (`~/.cursor/projects/<slug>/mcp-approvals.json`). A new tab mints a
//! new session id and token, so the fingerprint changes every launch and
//! the human re-approves the same two servers forever.
//!
//! The daemon therefore writes the session's env under
//! `{app_support}/mcp-env/<pty-child-pid>` when it opens a tab, and
//! gavin-mcp (and the relative launcher) walks its parent chain for that
//! file when the variables are absent. The mcp.json entry carries no
//! per-session env, so the approval hash stays stable.

use std::path::{Path, PathBuf};

/// Directory name under [`crate::app_support_dir`], profile-suffixed the
/// same way the socket is (`mcp-env` / `mcp-env-dev`) so a debug daemon
/// and a release one never share passthrough files.
pub fn dir_name(profile: crate::BuildProfile) -> String {
    match profile.suffix() {
        "" => "mcp-env".to_string(),
        suffix => format!("mcp-env{suffix}"),
    }
}

/// `{app_support}/mcp-env` (or `mcp-env-dev`) for this build.
#[cfg(feature = "os")]
pub fn dir() -> anyhow::Result<PathBuf> {
    Ok(crate::app_support_dir()?.join(dir_name(crate::BuildProfile::current())))
}

/// One session's env, the four variables `PtySession::spawn` puts on a
/// tab. Written as `KEY=VALUE\n` lines so the shell launcher can source
/// them without a JSON parser.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Passthrough {
    pub session_id: String,
    pub session_token: String,
    pub session_socket: String,
    pub gavin_mcp: String,
}

impl Passthrough {
    pub const SESSION_ID: &'static str = "GAVIN_SESSION_ID";
    pub const SESSION_TOKEN: &'static str = "GAVIN_SESSION_TOKEN";
    pub const SESSION_SOCKET: &'static str = "GAVIN_SESSION_SOCKET";
    pub const GAVIN_MCP: &'static str = "GAVIN_MCP";

    /// Encode for the on-disk file. Values must not contain newlines —
    /// session ids, hex tokens and socket paths never do.
    pub fn encode(&self) -> String {
        let mut out = String::new();
        for (key, value) in [
            (Self::SESSION_ID, self.session_id.as_str()),
            (Self::SESSION_TOKEN, self.session_token.as_str()),
            (Self::SESSION_SOCKET, self.session_socket.as_str()),
            (Self::GAVIN_MCP, self.gavin_mcp.as_str()),
        ] {
            if value.is_empty() {
                continue;
            }
            out.push_str(key);
            out.push('=');
            out.push_str(value);
            out.push('\n');
        }
        out
    }

    pub fn parse(body: &str) -> Self {
        let mut out = Self::default();
        for line in body.lines() {
            let Some((key, value)) = line.split_once('=') else {
                continue;
            };
            match key {
                Self::SESSION_ID => out.session_id = value.to_string(),
                Self::SESSION_TOKEN => out.session_token = value.to_string(),
                Self::SESSION_SOCKET => out.session_socket = value.to_string(),
                Self::GAVIN_MCP => out.gavin_mcp = value.to_string(),
                _ => {}
            }
        }
        out
    }

    /// Apply every non-empty field onto this process's environment, but
    /// only for keys that are currently unset — so an explicit injection
    /// (tests, a future Cursor that stops stripping) wins.
    #[cfg(feature = "os")]
    pub fn apply_if_missing(&self) {
        for (key, value) in [
            (Self::SESSION_ID, self.session_id.as_str()),
            (Self::SESSION_TOKEN, self.session_token.as_str()),
            (Self::SESSION_SOCKET, self.session_socket.as_str()),
            (Self::GAVIN_MCP, self.gavin_mcp.as_str()),
        ] {
            if value.is_empty() {
                continue;
            }
            if std::env::var_os(key).filter(|v| !v.is_empty()).is_some() {
                continue;
            }
            // SAFETY: called once at gavin-mcp startup, before any other
            // thread in this process reads these keys. The MCP server is
            // single-threaded through init.
            unsafe { std::env::set_var(key, value) };
        }
    }
}

/// Path of the passthrough file for one PTY child pid.
pub fn path_for(dir: &Path, pid: u32) -> PathBuf {
    dir.join(pid.to_string())
}

/// Write `body` for `pid`, creating `dir` if needed.
#[cfg(feature = "os")]
pub fn write(dir: &Path, pid: u32, body: &Passthrough) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    std::fs::write(path_for(dir, pid), body.encode())
}

/// Best-effort remove. Missing file is fine — a crashed daemon may have
/// cleaned up already, or never written.
#[cfg(feature = "os")]
pub fn remove(dir: &Path, pid: u32) {
    let _ = std::fs::remove_file(path_for(dir, pid));
}

/// Walk from `start_pid` up the parent chain (inclusive), returning the
/// first passthrough file that parses with a non-empty session id.
///
/// Cursor's MCP child is typically a grandchild of the PTY process the
/// daemon recorded, so a single `getppid` is not enough; a short walk
/// covers sh → agent → mcp and anything Cursor inserts between.
#[cfg(feature = "os")]
pub fn load_walking(dir: &Path, start_pid: u32) -> Option<Passthrough> {
    let mut pid = start_pid;
    for _ in 0..8 {
        if let Ok(body) = std::fs::read_to_string(path_for(dir, pid)) {
            let parsed = Passthrough::parse(&body);
            if !parsed.session_id.is_empty() {
                return Some(parsed);
            }
        }
        let parent = parent_pid(pid)?;
        if parent == 0 || parent == pid {
            break;
        }
        pid = parent;
    }
    None
}

/// Install any missing session env by walking from this process's parent.
/// No-op when `GAVIN_SESSION_ID` is already set, or when the passthrough
/// directory cannot be resolved.
#[cfg(feature = "os")]
pub fn apply_from_ancestor_passthrough() {
    if std::env::var_os(Passthrough::SESSION_ID)
        .filter(|v| !v.is_empty())
        .is_some()
    {
        return;
    }
    let Ok(dir) = self::dir() else {
        return;
    };
    let Some(parent) = parent_pid(std::process::id()) else {
        return;
    };
    if let Some(pass) = load_walking(&dir, parent) {
        pass.apply_if_missing();
    }
}

#[cfg(all(feature = "os", unix))]
fn parent_pid(pid: u32) -> Option<u32> {
    // `ps -o ppid=` is the portable shape that works on macOS and Linux
    // without parsing /proc, which macOS does not have.
    let output = std::process::Command::new("ps")
        .args(["-o", "ppid=", "-p", &pid.to_string()])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    text.trim().parse().ok()
}

#[cfg(all(feature = "os", windows))]
fn parent_pid(pid: u32) -> Option<u32> {
    // PowerShell rather than Toolhelp: keeps the windows crate feature
    // set unchanged, and soft-fails the same way a missing file does.
    let output = std::process::Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-Command",
            &format!(
                "(Get-CimInstance Win32_Process -Filter \"ProcessId={pid}\").ParentProcessId"
            ),
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout).trim().parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_round_trips_every_field() {
        let pass = Passthrough {
            session_id: "sid".into(),
            session_token: "tok".into(),
            session_socket: "/tmp/daemon.sock".into(),
            gavin_mcp: "/apps/gavin-mcp".into(),
        };
        assert_eq!(Passthrough::parse(&pass.encode()), pass);
    }

    #[test]
    fn encode_skips_empty_fields() {
        let pass = Passthrough {
            session_id: "sid".into(),
            ..Passthrough::default()
        };
        let body = pass.encode();
        assert_eq!(body, "GAVIN_SESSION_ID=sid\n");
        assert!(!body.contains("TOKEN"));
    }

    #[test]
    fn dir_name_follows_the_build_profile_suffix() {
        assert_eq!(dir_name(crate::BuildProfile::Release), "mcp-env");
        assert_eq!(dir_name(crate::BuildProfile::Dev), "mcp-env-dev");
    }

    #[test]
    fn path_for_names_the_file_after_the_pid() {
        assert_eq!(
            path_for(Path::new("/tmp/mcp-env"), 42),
            PathBuf::from("/tmp/mcp-env/42")
        );
    }

    #[cfg(feature = "os")]
    #[test]
    fn load_walking_finds_an_ancestor_file() {
        let dir = std::env::temp_dir().join(format!(
            "gavin-mcp-env-test-{}-{}",
            std::process::id(),
            "find"
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let pass = Passthrough {
            session_id: "from-grandparent".into(),
            session_token: "t".into(),
            ..Passthrough::default()
        };
        // Pretend pid 100's parent chain is fabricated by writing only
        // for 100; load_walking(100) finds it on the first step.
        write(&dir, 100, &pass).unwrap();
        let got = load_walking(&dir, 100).unwrap();
        assert_eq!(got.session_id, "from-grandparent");
        assert_eq!(got.session_token, "t");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(feature = "os")]
    #[test]
    fn load_walking_returns_none_when_nothing_matches() {
        let dir = std::env::temp_dir().join(format!(
            "gavin-mcp-env-test-{}-{}",
            std::process::id(),
            "miss"
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        assert!(load_walking(&dir, 1).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
