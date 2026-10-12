//! Playwright's browser installed on the machine this daemon runs on
//! (v66), for the setup step of an ssh workspace: the agents run on the
//! host, so the host's daemon is the one that can look `npx` up there,
//! read the environment that may have moved Playwright's cache, and run
//! the install.
//!
//! The install answers at once and runs on a thread of its own, like
//! Headroom's: the download can take minutes, and an ssh host has one
//! command connection that everything else on the link waits behind.

use std::ffi::OsString;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use protocol::{PlaywrightInstallRun, PlaywrightMachineStatus};

/// The spike measured 19 s for the 208 MB download on a fast line; the
/// desktop's own install allows the same ten minutes.
const INSTALL_TIMEOUT: Duration = Duration::from_secs(600);

/// How much of the install's output is kept: its last lines are the ones
/// that say what happened, and a progress bar redrawn for minutes is not.
const OUTPUT_KEPT: usize = 16 * 1024;

/// One daemon's install state.
#[derive(Default)]
pub struct Installer {
    state: Arc<Mutex<State>>,
}

#[derive(Default)]
struct State {
    installing: bool,
    last: Option<PlaywrightInstallRun>,
}

/// This daemon's PATH, with the well-known install directories a Dock or
/// launchd start lacks: where `npx` is looked for, and the PATH it runs
/// under -- `npx` is a `#!/usr/bin/env node` script, so the directory it
/// was found in has to be on the PATH it starts with.
fn search_path() -> Option<OsString> {
    let home = home_dir();
    let dirs = protocol::bin_dirs::well_known_bin_dirs(home.as_deref(), cfg!(windows));
    let current = std::env::var_os("PATH");
    protocol::bin_dirs::path_with_bin_dirs(current.as_deref(), &dirs, cfg!(windows), |p| p.is_dir()).or(current)
}

fn home_dir() -> Option<PathBuf> {
    let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var_os(var).filter(|v| !v.is_empty()).map(PathBuf::from)
}

/// The first `npx` on `path`.
pub fn find_npx(path: Option<&std::ffi::OsStr>, windows: bool) -> Option<PathBuf> {
    let name = if windows { "npx.cmd" } else { "npx" };
    std::env::split_paths(path?).map(|dir| dir.join(name)).find(|candidate| candidate.is_file())
}

/// The pinned revision's marker, where this daemon's environment puts
/// Playwright's cache.
fn marker() -> PathBuf {
    let home = home_dir().unwrap_or_default();
    protocol::playwright::browsers_dir(protocol::HostOs::current(), &home, |k| std::env::var(k).ok())
        .join(protocol::playwright::headless_shell_folder(protocol::playwright::HEADLESS_SHELL_REVISION))
        .join(protocol::playwright::INSTALLATION_COMPLETE)
}

/// The end of `bytes`, at a character boundary.
fn tail(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    if text.len() <= OUTPUT_KEPT {
        return text.into_owned();
    }
    let mut start = text.len() - OUTPUT_KEPT;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    format!("…{}", &text[start..])
}

impl Installer {
    pub fn status(&self) -> PlaywrightMachineStatus {
        let marker = marker();
        let state = self.state.lock().unwrap();
        PlaywrightMachineStatus {
            npx: find_npx(search_path().as_deref(), cfg!(windows)).is_some(),
            browser_installed: marker.is_file(),
            marker: marker.to_string_lossy().into_owned(),
            installing: state.installing,
            last_install: state.last.clone(),
        }
    }

    /// Starts the install unless one is running, and answers with the
    /// status after.
    pub fn start(&self) -> PlaywrightMachineStatus {
        {
            let mut state = self.state.lock().unwrap();
            if !state.installing {
                state.installing = true;
                let shared = Arc::clone(&self.state);
                let started = std::thread::Builder::new().name("playwright-install".into()).spawn(move || {
                    let run = run_install();
                    let mut state = shared.lock().unwrap();
                    state.installing = false;
                    state.last = Some(run);
                });
                if let Err(e) = started {
                    state.installing = false;
                    state.last = Some(PlaywrightInstallRun { code: -1, output: format!("could not start the install: {e}") });
                }
            }
        }
        self.status()
    }
}

/// `npx -y @playwright/mcp@<pin> install-browser chromium-headless-shell`,
/// to completion or the deadline. Run from the home directory: in a
/// workspace, a cloned repo's `.npmrc` or `node_modules` could decide what
/// the pinned spec resolves to.
fn run_install() -> PlaywrightInstallRun {
    let path = search_path();
    let Some(npx) = find_npx(path.as_deref(), cfg!(windows)) else {
        return PlaywrightInstallRun {
            code: -1,
            output: "Node.js (npx) was not found on this machine -- install Node.js, then install again".into(),
        };
    };
    let mut command = crate::program::command(&npx);
    command
        .args(protocol::playwright::install_args())
        .current_dir(home_dir().filter(|h| h.is_dir()).unwrap_or_else(std::env::temp_dir))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(path) = &path {
        command.env("PATH", path);
    }
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(e) => return PlaywrightInstallRun { code: -1, output: format!("could not start {}: {e}", npx.display()) },
    };
    // Both streams into one buffer, each on a thread of its own so
    // neither pipe fills and stalls the other.
    let output = Arc::new(Mutex::new(Vec::new()));
    let readers: Vec<_> = [child.stdout.take().map(|s| Box::new(s) as Box<dyn Read + Send>), child.stderr.take().map(|s| Box::new(s) as Box<dyn Read + Send>)]
        .into_iter()
        .flatten()
        .map(|mut stream| {
            let output = Arc::clone(&output);
            std::thread::spawn(move || {
                let mut chunk = [0u8; 8192];
                while let Ok(n) = stream.read(&mut chunk) {
                    if n == 0 {
                        break;
                    }
                    output.lock().unwrap().extend_from_slice(&chunk[..n]);
                }
            })
        })
        .collect();
    let deadline = Instant::now() + INSTALL_TIMEOUT;
    let code = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.code().unwrap_or(-1),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(200)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                output
                    .lock()
                    .unwrap()
                    .extend_from_slice(format!("\ngavin: the install did not finish in {}s and was stopped", INSTALL_TIMEOUT.as_secs()).as_bytes());
                break -1;
            }
        }
    };
    for reader in readers {
        let _ = reader.join();
    }
    let output = tail(&output.lock().unwrap());
    PlaywrightInstallRun { code, output }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn npx_is_the_first_one_on_the_path() {
        let dir = tempfile::tempdir().unwrap();
        let (a, b) = (dir.path().join("a"), dir.path().join("b"));
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        let path = std::env::join_paths([&a, &b]).unwrap();
        assert_eq!(find_npx(Some(&path), false), None);
        std::fs::write(b.join("npx"), "").unwrap();
        assert_eq!(find_npx(Some(&path), false), Some(b.join("npx")));
        std::fs::write(a.join("npx.cmd"), "").unwrap();
        assert_eq!(find_npx(Some(&path), true), Some(a.join("npx.cmd")));
        assert_eq!(find_npx(None, false), None);
    }

    #[test]
    fn only_the_end_of_a_long_output_is_kept() {
        let long = "é".repeat(OUTPUT_KEPT);
        let kept = tail(long.as_bytes());
        assert!(kept.starts_with('…'));
        assert!(kept.len() <= OUTPUT_KEPT + '…'.len_utf8());
        assert_eq!(tail(b"short"), "short");
    }

    #[test]
    fn the_marker_is_the_pinned_revisions() {
        let marker = marker();
        let folder = protocol::playwright::headless_shell_folder(protocol::playwright::HEADLESS_SHELL_REVISION);
        assert!(marker.ends_with(Path::new(&folder).join(protocol::playwright::INSTALLATION_COMPLETE)));
    }
}
