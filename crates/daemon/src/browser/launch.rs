//! Finding the headless shell, starting it, and stopping it.
//!
//! The browser is Playwright's `chromium-headless-shell` at the revision
//! the pinned `@playwright/mcp` installs (`protocol::playwright`). Each
//! one is started with `--remote-debugging-port=0` in a fresh profile
//! folder, and the port it chose is read back from that folder's
//! `DevToolsActivePort`. It runs in a process group of its own, which the
//! spike measured to hold all four of its processes, so stopping it is
//! one signal to the group.

use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::proc::{self, ProcessHandle};

/// How long a launch may take to write its port. A warm start writes it
/// in half a second; a binary macOS has never seen is scanned first.
const PORT_FILE_PATIENCE: Duration = Duration::from_secs(20);
const PORT_FILE_POLL: Duration = Duration::from_millis(50);

/// SIGTERM to SIGKILL.
pub const STOP_GRACE: Duration = Duration::from_secs(2);

/// Where the headless shell to launch is, or why there is none. `env`
/// is the daemon's environment; the home directory and the platform
/// come from it and from this build.
pub fn find_executable(env: impl Fn(&str) -> Option<String>) -> Result<PathBuf, String> {
    let os = protocol::HostOs::current();
    let home_var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    let home = env(home_var).filter(|h| !h.is_empty()).map(PathBuf::from).unwrap_or_default();
    let dir = protocol::playwright::browsers_dir(os, &home, &env);
    find_in(&dir, os, std::env::consts::ARCH)
}

/// [`find_executable`] for one browsers directory and platform.
pub fn find_in(dir: &Path, os: protocol::HostOs, arch: &str) -> Result<PathBuf, String> {
    let not_installed = || {
        format!(
            "Playwright's browser is not installed (no complete chromium_headless_shell-* in {}) -- run the Playwright step in gavin's setup, or `npx {}`",
            dir.display(),
            protocol::playwright::install_args().join(" ")
        )
    };
    let complete: Vec<String> = std::fs::read_dir(dir)
        .map_err(|_| not_installed())?
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.path().join(protocol::playwright::INSTALLATION_COMPLETE).is_file())
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    let revision =
        protocol::playwright::pick_revision(complete.iter().map(String::as_str)).ok_or_else(not_installed)?;
    let parts = protocol::playwright::headless_shell_executable(os, arch)
        .ok_or_else(|| format!("Playwright ships no headless shell for {os:?} on {arch}"))?;
    let mut exe = dir.join(protocol::playwright::headless_shell_folder(revision));
    for part in parts {
        exe.push(part);
    }
    if !exe.is_file() {
        return Err(format!("{} is marked installed but has no {}", dir.display(), exe.display()));
    }
    Ok(exe)
}

/// A started browser: the process, who it is, and its CDP websocket.
pub struct Launched {
    pub child: Child,
    pub handle: ProcessHandle,
    pub ws_url: String,
}

/// Starts the headless shell with its profile in `profile_dir` (made
/// fresh) and its output in `log`, and waits for the port it chose.
pub fn launch(exe: &Path, profile_dir: &Path, log: &Path) -> Result<Launched, String> {
    let _ = std::fs::remove_dir_all(profile_dir);
    std::fs::create_dir_all(profile_dir)
        .map_err(|e| format!("could not create {}: {e}", profile_dir.display()))?;
    let out = std::fs::File::create(log).map_err(|e| format!("could not create {}: {e}", log.display()))?;
    let err = out.try_clone().map_err(|e| format!("could not open {}: {e}", log.display()))?;

    let mut command = crate::program::command(exe);
    command
        .arg("--remote-debugging-port=0")
        .arg(format!("--user-data-dir={}", profile_dir.display()))
        .arg("--no-first-run")
        .arg("--no-default-browser-check")
        // Without it the headless viewport is 800x600: the MCP connects
        // with Playwright's `noDefaults` and sets none of its own.
        .arg("--window-size=1280,800")
        .arg("about:blank")
        .stdin(Stdio::null())
        .stdout(Stdio::from(out))
        .stderr(Stdio::from(err));
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // A group of its own: the browser, its GPU and network helpers
        // and every renderer, and nothing else -- so one signal to the
        // group stops all of it, and Ctrl-C aimed at the daemon's group
        // does not.
        command.process_group(0);
    }
    let mut child = command.spawn().map_err(|e| format!("could not start {}: {e}", exe.display()))?;
    let Some(handle) = proc::identify(child.id()) else {
        let _ = child.kill();
        let _ = child.wait();
        return Err(format!("{} exited as it started{}", exe.display(), log_tail(log)));
    };

    let port_file = profile_dir.join("DevToolsActivePort");
    let deadline = Instant::now() + PORT_FILE_PATIENCE;
    loop {
        if let Some(url) = std::fs::read_to_string(&port_file).ok().and_then(|s| ws_url_from_port_file(&s)) {
            return Ok(Launched { child, handle, ws_url: url });
        }
        if let Ok(Some(status)) = child.try_wait() {
            return Err(format!("{} exited ({status}) before it listened{}", exe.display(), log_tail(log)));
        }
        if Instant::now() >= deadline {
            stop(handle, Some(&mut child));
            return Err(format!(
                "{} did not open its debugging port within {}s{}",
                exe.display(),
                PORT_FILE_PATIENCE.as_secs(),
                log_tail(log)
            ));
        }
        std::thread::sleep(PORT_FILE_POLL);
    }
}

/// `DevToolsActivePort` is the port on line one and the browser target's
/// path on line two. Half a file -- read while Chromium is still writing
/// it -- is `None`, and the caller reads again.
pub fn ws_url_from_port_file(body: &str) -> Option<String> {
    let mut lines = body.lines();
    let port: u16 = lines.next()?.trim().parse().ok()?;
    let path = lines.next()?.trim();
    if port == 0 || !path.starts_with("/devtools/browser/") {
        return None;
    }
    Some(format!("ws://127.0.0.1:{port}{path}"))
}

/// The end of the browser's own output, for an error that has to say
/// why it would not start -- on Linux, typically a system library.
fn log_tail(log: &Path) -> String {
    let body = std::fs::read_to_string(log).unwrap_or_default();
    let lines: Vec<&str> = body.lines().filter(|l| !l.trim().is_empty()).collect();
    if lines.is_empty() {
        return String::new();
    }
    let tail = lines[lines.len().saturating_sub(4)..].join("\n");
    format!(":\n{tail}")
}

/// Stops a browser this daemon started: the group asked to stop, then
/// told, `STOP_GRACE` apart. The identity is checked before each signal,
/// so a pid recycled since is never signalled. `child` is reaped when
/// given; a browser recorded by an earlier daemon has no `Child`.
pub fn stop(handle: ProcessHandle, mut child: Option<&mut Child>) {
    signal(handle, Signal::Terminate);
    let deadline = Instant::now() + STOP_GRACE;
    while Instant::now() < deadline {
        let gone = match child.as_deref_mut() {
            Some(child) => matches!(child.try_wait(), Ok(Some(_))),
            None => !proc::still_running(handle),
        };
        if gone {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    signal(handle, Signal::Kill);
    if let Some(child) = child {
        let _ = child.kill();
        let _ = child.wait();
    }
}

#[derive(Clone, Copy)]
enum Signal {
    Terminate,
    Kill,
}

/// The whole group on unix, behind the identity check: Headroom's
/// `signal`, for the same reasons.
#[cfg(unix)]
fn signal(handle: ProcessHandle, signal: Signal) -> bool {
    if !proc::still_running(handle) {
        return false;
    }
    let number = match signal {
        Signal::Terminate => libc::SIGTERM,
        Signal::Kill => libc::SIGKILL,
    };
    let pid = handle.pid as i32;
    // SAFETY: `kill` with plain integers. The negative pid is the group
    // `launch` created; ESRCH there falls back to the process alone.
    unsafe { libc::kill(-pid, number) == 0 || libc::kill(pid, number) == 0 }
}

/// Windows stops a process one way. Chromium's helpers watch their
/// parent's handle and leave with it.
#[cfg(not(unix))]
fn signal(handle: ProcessHandle, _signal: Signal) -> bool {
    proc::terminate(handle)
}

/// Every browser this daemon has running, on disk, so the next daemon
/// can stop any that outlived a crash of this one. Split per build like
/// Headroom's run record: the dev and release daemons each start their
/// own browsers and must not stop the other's.
#[derive(Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct RunRecord {
    pub browsers: Vec<RecordedBrowser>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RecordedBrowser {
    pub session_id: String,
    pub process: ProcessHandle,
}

pub fn load_record(path: &Path) -> RunRecord {
    std::fs::read_to_string(path).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

pub fn save_record(path: &Path, record: &RunRecord) {
    if let Err(e) = crate::headroom::store::save(path, record) {
        eprintln!("gavin-daemon: could not write {}: {e}", path.display());
    }
}

/// What a starting daemon does about an earlier one's browsers: stops
/// every one still running, then clears the folder their profiles and
/// output lived in. A browser is never adopted -- its agent's MCP
/// pointed at a proxy that died with that daemon.
pub fn sweep(record_path: &Path, base: &Path) {
    let record = load_record(record_path);
    for browser in &record.browsers {
        if proc::still_running(browser.process) {
            eprintln!(
                "gavin-daemon: stopping session {}'s browser (pid {}), left behind by an earlier daemon",
                browser.session_id, browser.process.pid
            );
            stop(browser.process, None);
        }
    }
    let _ = std::fs::remove_file(record_path);
    let _ = std::fs::remove_dir_all(base);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn port_file_reads_only_when_whole() {
        assert_eq!(
            ws_url_from_port_file("62341\n/devtools/browser/d81ac516-386c\n"),
            Some("ws://127.0.0.1:62341/devtools/browser/d81ac516-386c".into())
        );
        assert_eq!(ws_url_from_port_file("62341\n"), None);
        assert_eq!(ws_url_from_port_file(""), None);
        assert_eq!(ws_url_from_port_file("0\n/devtools/browser/x"), None);
        assert_eq!(ws_url_from_port_file("62341\n/json/version"), None);
    }

    fn installed(dir: &Path, folder: &str, complete: bool) {
        let exe = dir.join(folder).join("chrome-headless-shell-mac-arm64");
        std::fs::create_dir_all(&exe).unwrap();
        std::fs::write(exe.join("chrome-headless-shell"), "").unwrap();
        if complete {
            std::fs::write(dir.join(folder).join("INSTALLATION_COMPLETE"), "").unwrap();
        }
    }

    #[test]
    fn finds_the_pinned_revision_then_the_newest_complete_one() {
        let dir = tempfile::tempdir().unwrap();
        let os = protocol::HostOs::MacOs;
        assert!(find_in(dir.path(), os, "aarch64").unwrap_err().contains("not installed"));

        installed(dir.path(), "chromium_headless_shell-1300", false);
        installed(dir.path(), "chromium_headless_shell-1243", true);
        let found = find_in(dir.path(), os, "aarch64").unwrap();
        assert!(found.ends_with("chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell"));

        let pinned = protocol::playwright::headless_shell_folder(protocol::playwright::HEADLESS_SHELL_REVISION);
        installed(dir.path(), &pinned, true);
        assert!(find_in(dir.path(), os, "aarch64").unwrap().starts_with(dir.path().join(&pinned)));
        assert!(find_in(dir.path(), os, "riscv64").unwrap_err().contains("no headless shell"));
    }

    #[test]
    fn a_missing_browsers_dir_says_how_to_install() {
        let err = find_in(Path::new("/nonexistent/ms-playwright"), protocol::HostOs::Xdg, "x86_64").unwrap_err();
        assert!(err.contains("install-browser chromium-headless-shell"), "{err}");
    }

    #[test]
    fn the_record_round_trips_and_sweeping_clears_it() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("playwright-browsers.json");
        let base = dir.path().join("playwright");
        std::fs::create_dir_all(base.join("s1").join("profile")).unwrap();
        let record = RunRecord {
            browsers: vec![RecordedBrowser {
                session_id: "s1".into(),
                // A pid no process holds with this start time: never signalled.
                process: ProcessHandle { pid: u32::MAX - 7, started_at_us: 1 },
            }],
        };
        save_record(&path, &record);
        assert_eq!(load_record(&path), record);
        sweep(&path, &base);
        assert!(!path.exists());
        assert!(!base.exists());
    }
}
