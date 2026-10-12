//! Where agent CLIs install themselves, for a process whose `PATH` does
//! not say.
//!
//! The daemon and the app inherit the `PATH` they were started with. A
//! macOS app launched from the Dock gets `/usr/bin:/bin:/usr/sbin:/sbin`,
//! and one launched from a terminal gets that terminal's `PATH` frozen at
//! the moment it started -- so an agent installed afterwards is missing
//! from both. Several agent installers write only to their own directory
//! and add it to the shell rc file: Kimi Code to `~/.kimi-code/bin`,
//! opencode to `~/.opencode/bin`. `sh -c` reads no rc file, so a
//! workspace whose default agent is Kimi died with `/bin/sh: kimi:
//! command not found` on a machine where `kimi` ran fine in a terminal.
//!
//! One table, read by both sides: the daemon puts these directories on
//! the `PATH` an agent's command line runs under, and the app searches
//! them when it asks whether an agent is installed -- so "found" in the
//! setup wizard and "starts" in a session are the same answer.
//!
//! Pure: the home directory and the platform are handed in, so nothing
//! here reads the environment and the module needs no `os` feature.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};

/// Home-relative install directories, most specific first. Each is where
/// some agent's own installer puts its binary without touching any
/// system `PATH`:
///
/// - `.local/bin` -- Claude Code's native installer, Cursor Agent, uv
/// - `.claude/local` -- Claude Code's older per-user install
/// - `.kimi-code/bin` -- Kimi Code
/// - `.opencode/bin` -- opencode
/// - `.bun/bin`, `.cargo/bin` -- `bun add -g`, `cargo install`
const HOME_DIRS: &[&str] = &[
    ".local/bin",
    ".claude/local",
    ".kimi-code/bin",
    ".opencode/bin",
    ".bun/bin",
    ".cargo/bin",
];

/// Package-manager directories a Dock-launched `PATH` lacks: Homebrew on
/// Apple Silicon, then Homebrew on Intel and npm's global prefix there.
const UNIX_DIRS: &[&str] = &["/opt/homebrew/bin", "/usr/local/bin"];

/// Every well-known install directory for this platform, whether or not
/// it exists.
pub fn well_known_bin_dirs(home: Option<&Path>, windows: bool) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = home
        .map(|home| HOME_DIRS.iter().map(|tail| home.join(tail)).collect())
        .unwrap_or_default();
    if !windows {
        dirs.extend(UNIX_DIRS.iter().map(PathBuf::from));
    }
    dirs
}

/// `current` with every directory of `dirs` that exists and is not
/// already on it appended, or `None` when that adds nothing -- in which
/// case the caller leaves `PATH` as it found it.
///
/// Appended, never prepended: `PATH` stays the policy and these are a
/// rescue. A machine with two `claude` installs runs the one its shell
/// would.
pub fn path_with_bin_dirs(
    current: Option<&OsStr>,
    dirs: &[PathBuf],
    windows: bool,
    exists: impl Fn(&Path) -> bool,
) -> Option<OsString> {
    let sep = if windows { ";" } else { ":" };
    let current = current.filter(|c| !c.is_empty());
    let on_path: Vec<String> = current
        .map(|c| {
            c.to_string_lossy()
                .split(sep)
                .map(|d| d.trim_end_matches('/').to_string())
                .collect()
        })
        .unwrap_or_default();
    let mut added: Vec<&PathBuf> = Vec::new();
    for dir in dirs {
        let spelled = dir.to_string_lossy();
        let spelled = spelled.trim_end_matches('/');
        if on_path.iter().any(|d| d == spelled) || added.contains(&dir) || !exists(dir) {
            continue;
        }
        added.push(dir);
    }
    if added.is_empty() {
        return None;
    }
    // Built by pushing rather than through a lossy string, so an
    // inherited PATH that is not UTF-8 reaches the child byte for byte.
    let mut out = current.map(OsString::from).unwrap_or_default();
    for dir in added {
        if !out.is_empty() {
            out.push(sep);
        }
        out.push(dir.as_os_str());
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn present(dirs: &'static [&'static str]) -> impl Fn(&Path) -> bool {
        move |p| dirs.iter().any(|d| Path::new(d) == p)
    }

    #[test]
    fn kimi_and_opencode_install_dirs_are_in_the_table() {
        let dirs = well_known_bin_dirs(Some(Path::new("/Users/ada")), false);
        assert!(dirs.contains(&PathBuf::from("/Users/ada/.kimi-code/bin")));
        assert!(dirs.contains(&PathBuf::from("/Users/ada/.opencode/bin")));
        assert!(dirs.contains(&PathBuf::from("/opt/homebrew/bin")));
    }

    #[test]
    fn windows_gets_no_unix_system_dirs_and_no_home_means_none_of_home() {
        let dirs = well_known_bin_dirs(Some(Path::new("C:/Users/Ada")), true);
        assert!(!dirs.contains(&PathBuf::from("/usr/local/bin")));
        assert!(dirs.contains(&PathBuf::from("C:/Users/Ada/.kimi-code/bin")));
        assert_eq!(
            well_known_bin_dirs(None, false),
            vec![
                PathBuf::from("/opt/homebrew/bin"),
                PathBuf::from("/usr/local/bin")
            ]
        );
    }

    /// The reported failure: a Dock PATH, kimi installed under home.
    #[test]
    fn an_existing_dir_missing_from_path_is_appended() {
        let dirs = well_known_bin_dirs(Some(Path::new("/Users/ada")), false);
        let path = path_with_bin_dirs(
            Some(OsStr::new("/usr/bin:/bin")),
            &dirs,
            false,
            present(&["/Users/ada/.kimi-code/bin"]),
        );
        assert_eq!(
            path,
            Some(OsString::from("/usr/bin:/bin:/Users/ada/.kimi-code/bin"))
        );
    }

    #[test]
    fn a_dir_already_on_path_is_not_repeated_and_nothing_new_is_none() {
        let dirs = vec![PathBuf::from("/opt/homebrew/bin")];
        let path = path_with_bin_dirs(
            Some(OsStr::new("/opt/homebrew/bin/:/usr/bin")),
            &dirs,
            false,
            present(&["/opt/homebrew/bin"]),
        );
        assert_eq!(path, None);
    }

    #[test]
    fn a_missing_dir_is_not_added() {
        let dirs = vec![PathBuf::from("/Users/ada/.kimi-code/bin")];
        assert_eq!(
            path_with_bin_dirs(Some(OsStr::new("/usr/bin")), &dirs, false, |_| false),
            None
        );
    }

    /// An empty inherited PATH must not gain a leading separator: an empty
    /// entry means the current directory.
    #[test]
    fn an_empty_path_gets_no_leading_separator() {
        let dirs = vec![PathBuf::from("/a"), PathBuf::from("/b")];
        let path = path_with_bin_dirs(Some(OsStr::new("")), &dirs, false, |_| true);
        assert_eq!(path, Some(OsString::from("/a:/b")));
        let path = path_with_bin_dirs(None, &dirs, false, |_| true);
        assert_eq!(path, Some(OsString::from("/a:/b")));
    }

    #[test]
    fn windows_joins_with_semicolons() {
        let dirs = vec![PathBuf::from("C:/Users/Ada/.kimi-code/bin")];
        let path = path_with_bin_dirs(Some(OsStr::new("C:/Windows")), &dirs, true, |_| true);
        assert_eq!(
            path,
            Some(OsString::from("C:/Windows;C:/Users/Ada/.kimi-code/bin"))
        );
    }
}
