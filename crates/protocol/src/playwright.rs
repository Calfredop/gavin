//! Playwright: the version gavin runs, and where its browser lives.
//!
//! One pin, read by every side. `gavin-mcp playwright` runs the pinned
//! `@playwright/mcp`, the setup step installs the headless shell that
//! version brings, and the daemon launches that same headless shell for
//! each agent session. A hand bump changes both constants together, from
//! the new MCP's `playwright-core/browsers.json`. Spike and evidence:
//! `docs/superpowers/specs/2026-10-08-playwright-integration-design.md`.
//!
//! Pure: the home directory, the platform and the environment are handed
//! in, so nothing here reads the OS and the module needs no `os` feature.

use std::path::{Path, PathBuf};

use crate::HostOs;

/// The npm package behind the `browser_*` tools.
pub const MCP_PACKAGE: &str = "@playwright/mcp";

/// The pinned version, bumped by hand: every release depends on a
/// Playwright alpha, so `@latest` would hand agents a browser driver
/// nobody here has run.
pub const MCP_VERSION: &str = "0.0.83";

/// The `chromium-headless-shell` revision [`MCP_VERSION`] installs
/// (Chrome 155.0.8059.12).
pub const HEADLESS_SHELL_REVISION: u32 = 1247;

/// The marker Playwright's installer writes last into a revision's
/// folder. A folder without it is a download that did not finish.
pub const INSTALLATION_COMPLETE: &str = "INSTALLATION_COMPLETE";

/// The `gavin-mcp` subcommand that runs the pinned MCP for its session,
/// and the server key the MCP entry is written under.
pub const SUBCOMMAND: &str = "playwright";

/// `@playwright/mcp@0.0.83`.
pub fn mcp_spec() -> String {
    format!("{MCP_PACKAGE}@{MCP_VERSION}")
}

/// `npx` arguments that install the pinned headless shell. They also warm
/// npx's cache with the pinned package, so an agent's first start does
/// not download it.
pub fn install_args() -> Vec<String> {
    vec![
        "-y".into(),
        mcp_spec(),
        "install-browser".into(),
        "chromium-headless-shell".into(),
    ]
}

/// `npx` arguments that run the pinned MCP against a session's browser.
/// `--output-dir` keeps the snapshot files every action writes out of the
/// agent's repo, where they would otherwise land in `.playwright-mcp/`.
pub fn mcp_args(endpoint: &str, output_dir: &Path) -> Vec<String> {
    vec![
        "-y".into(),
        mcp_spec(),
        "--cdp-endpoint".into(),
        endpoint.into(),
        "--output-dir".into(),
        output_dir.to_string_lossy().into_owned(),
    ]
}

/// Where Playwright keeps its browsers, by playwright-core's own rule:
/// `PLAYWRIGHT_BROWSERS_PATH` when set to an absolute path, else the
/// platform cache directory. `0` (a folder inside the npm package) and a
/// relative path name nothing a separate process can find, so both fall
/// back to the default.
pub fn browsers_dir(os: HostOs, home: &Path, env: impl Fn(&str) -> Option<String>) -> PathBuf {
    if let Some(set) = env("PLAYWRIGHT_BROWSERS_PATH").filter(|v| v != "0" && !v.is_empty()) {
        let set = PathBuf::from(set);
        if set.is_absolute() || (os == HostOs::Windows && looks_absolute_on_windows(&set)) {
            return set;
        }
    }
    let cache = match os {
        HostOs::MacOs => home.join("Library").join("Caches"),
        HostOs::Windows => env("LOCALAPPDATA")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData").join("Local")),
        HostOs::Xdg => env("XDG_CACHE_HOME")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".cache")),
    };
    cache.join("ms-playwright")
}

/// `C:\…` or `\\server\…`, judged by spelling: a Unix host computing a
/// Windows host's path cannot ask `Path::is_absolute`.
fn looks_absolute_on_windows(p: &Path) -> bool {
    let s = p.to_string_lossy();
    let b = s.as_bytes();
    (b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/'))
        || s.starts_with("\\\\")
}

/// `chromium_headless_shell-1247`, the folder one revision installs into.
pub fn headless_shell_folder(revision: u32) -> String {
    format!("chromium_headless_shell-{revision}")
}

/// The revision a folder name holds, when it is a headless shell's.
pub fn headless_shell_revision(folder: &str) -> Option<u32> {
    folder.strip_prefix("chromium_headless_shell-")?.parse().ok()
}

/// The executable inside a revision's folder, by playwright-core's table.
/// `None` for a platform Playwright ships no headless shell for.
pub fn headless_shell_executable(os: HostOs, arch: &str) -> Option<&'static [&'static str]> {
    Some(match (os, arch) {
        (HostOs::MacOs, "aarch64") => &["chrome-headless-shell-mac-arm64", "chrome-headless-shell"],
        (HostOs::MacOs, "x86_64") => &["chrome-headless-shell-mac-x64", "chrome-headless-shell"],
        (HostOs::Xdg, "x86_64") => &["chrome-headless-shell-linux64", "chrome-headless-shell"],
        (HostOs::Xdg, "aarch64") => &["chrome-headless-shell-linux-arm64", "chrome-headless-shell"],
        (HostOs::Windows, "x86_64") => &["chrome-headless-shell-win64", "chrome-headless-shell.exe"],
        _ => return None,
    })
}

/// Which installed headless shell to launch, from the names of the
/// folders in [`browsers_dir`] that carry [`INSTALLATION_COMPLETE`]: the
/// pinned revision when it is there, else the newest one (CDP does not
/// need Playwright's exact revision; the spike drove 1243 with 0.0.83).
pub fn pick_revision<'a>(complete_folders: impl IntoIterator<Item = &'a str>) -> Option<u32> {
    let revisions: Vec<u32> = complete_folders.into_iter().filter_map(headless_shell_revision).collect();
    if revisions.contains(&HEADLESS_SHELL_REVISION) {
        return Some(HEADLESS_SHELL_REVISION);
    }
    revisions.into_iter().max()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &'static [(&'static str, &'static str)]) -> impl Fn(&str) -> Option<String> {
        move |k| pairs.iter().find(|(n, _)| *n == k).map(|(_, v)| v.to_string())
    }

    #[test]
    fn default_browsers_dir_per_os() {
        let none = env(&[]);
        assert_eq!(
            browsers_dir(HostOs::MacOs, Path::new("/Users/ada"), &none),
            PathBuf::from("/Users/ada/Library/Caches/ms-playwright")
        );
        assert_eq!(
            browsers_dir(HostOs::Xdg, Path::new("/home/ada"), &none),
            PathBuf::from("/home/ada/.cache/ms-playwright")
        );
        assert_eq!(
            browsers_dir(HostOs::Xdg, Path::new("/home/ada"), env(&[("XDG_CACHE_HOME", "/var/cache/ada")])),
            PathBuf::from("/var/cache/ada/ms-playwright")
        );
        assert_eq!(
            browsers_dir(
                HostOs::Windows,
                Path::new("C:/Users/Ada"),
                env(&[("LOCALAPPDATA", "C:/Users/Ada/AppData/Local")])
            ),
            PathBuf::from("C:/Users/Ada/AppData/Local/ms-playwright")
        );
    }

    #[test]
    fn browsers_path_override_only_when_absolute_and_not_zero() {
        let home = Path::new("/home/ada");
        assert_eq!(
            browsers_dir(HostOs::Xdg, home, env(&[("PLAYWRIGHT_BROWSERS_PATH", "/opt/pw")])),
            PathBuf::from("/opt/pw")
        );
        for unusable in ["0", "", "relative/dir"] {
            let e = move |k: &str| (k == "PLAYWRIGHT_BROWSERS_PATH").then(|| unusable.to_string());
            assert_eq!(browsers_dir(HostOs::Xdg, home, e), PathBuf::from("/home/ada/.cache/ms-playwright"));
        }
        assert_eq!(
            browsers_dir(
                HostOs::Windows,
                Path::new("C:/Users/Ada"),
                env(&[("PLAYWRIGHT_BROWSERS_PATH", "D:\\pw")])
            ),
            PathBuf::from("D:\\pw")
        );
    }

    #[test]
    fn executable_table_matches_playwright_core() {
        assert_eq!(
            headless_shell_executable(HostOs::MacOs, "aarch64"),
            Some(&["chrome-headless-shell-mac-arm64", "chrome-headless-shell"][..])
        );
        assert_eq!(
            headless_shell_executable(HostOs::Windows, "x86_64").unwrap()[1],
            "chrome-headless-shell.exe"
        );
        assert_eq!(headless_shell_executable(HostOs::Windows, "aarch64"), None);
    }

    #[test]
    fn the_pin_wins_then_the_newest() {
        let pinned = headless_shell_folder(HEADLESS_SHELL_REVISION);
        assert_eq!(
            pick_revision(["chromium_headless_shell-1300", pinned.as_str(), "chromium-1247"]),
            Some(HEADLESS_SHELL_REVISION)
        );
        assert_eq!(
            pick_revision(["chromium_headless_shell-1228", "chromium_headless_shell-1243", "ffmpeg-1011"]),
            Some(1243)
        );
        assert_eq!(pick_revision(["chromium-1247", "webkit-2359"]), None);
    }

    #[test]
    fn npx_lines_carry_the_pin() {
        assert_eq!(install_args(), ["-y", "@playwright/mcp@0.0.83", "install-browser", "chromium-headless-shell"]);
        let args = mcp_args("ws://127.0.0.1:1/devtools/browser/s", Path::new("/tmp/out"));
        assert_eq!(args[1], "@playwright/mcp@0.0.83");
        assert_eq!(&args[2..4], ["--cdp-endpoint", "ws://127.0.0.1:1/devtools/browser/s"]);
        assert_eq!(&args[4..], ["--output-dir", "/tmp/out"]);
    }
}
