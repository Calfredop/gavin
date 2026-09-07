//! Which shell a PTY session actually starts.
//!
//! Two different questions, and they get different answers on Windows.
//!
//! A session with a COMMAND is running a line gavin generated: a tool
//! body, `[agent].command` with a POSIX-quoted prompt appended, a
//! `[worktree] setup` chain joined with `&&`, the failure epilogue
//! `buildToolCommand` puts on the end. Every one of those is POSIX shell
//! source, so the interpreter has to be a POSIX shell -- on Windows that
//! means Git for Windows' `sh.exe`, which is the decision recorded on
//! the windows-port card. The alternative was emitting PowerShell, which
//! would have forked every emission site in the app for a shell none of
//! the agent CLIs need.
//!
//! A session with NO command is a terminal the human typed into, and
//! there the answer is whatever that OS's shell is: `$SHELL` on unix,
//! `%COMSPEC%` on Windows. Deliberately NOT Git Bash, even though the
//! tool sessions use it -- a Windows user who opens a shell expects the
//! one their OS gave them, and `$SHELL` under Git Bash is an MSYS path
//! (`/usr/bin/bash`) that no Windows API can start anyway.

use std::path::{Path, PathBuf};

/// The shell an emitted command line is run through.
///
/// Resolved once. It cannot change while the daemon runs, and the
/// Windows arm costs a `git --exec-path` subprocess.
pub fn posix_shell() -> PathBuf {
    static SHELL: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
    SHELL
        .get_or_init(|| {
            if !cfg!(windows) {
                return PathBuf::from("/bin/sh");
            }
            resolve_posix_shell(git_exec_path().as_deref(), |p| p.is_file())
                // Nothing found: `sh` on PATH is the last thing left to
                // try, and it is what a machine with Git Bash's `bin`
                // directory on PATH answers with. Spawning it and
                // failing is a better error than refusing to start.
                .unwrap_or_else(|| PathBuf::from("sh.exe"))
        })
        .clone()
}

/// The shell a plain terminal tab gets.
pub fn interactive_shell() -> PathBuf {
    if cfg!(windows) {
        return std::env::var_os("COMSPEC")
            .map(PathBuf::from)
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or_else(|| PathBuf::from("cmd.exe"));
    }
    PathBuf::from(std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string()))
}

/// Git for Windows' `sh.exe`, found from git's own idea of where it
/// lives.
///
/// `git --exec-path` prints `<git>/mingw64/libexec/git-core` on a stock
/// 64-bit install -- forward slashes, which Windows accepts everywhere.
/// Asked of git rather than guessed from `%ProgramFiles%` because a
/// scoop, winget or portable install is somewhere else entirely and a
/// 32-bit one says `mingw32`. Walking UP from there rather than
/// stripping exactly three components, so a future layout change costs
/// nothing.
///
/// `usr/bin` before `bin`: both hold the same shell, but `usr/bin` is
/// where the whole MSYS runtime sits and `bin` carries only the
/// three-program PATH-convenience subset.
pub fn resolve_posix_shell(
    git_exec_path: Option<&str>,
    exists: impl Fn(&Path) -> bool,
) -> Option<PathBuf> {
    let exec_path = git_exec_path?.trim().replace('\\', "/");
    let mut dir = exec_path.trim_end_matches('/').to_string();
    for _ in 0..5 {
        let Some(cut) = dir.rfind('/') else { break };
        dir.truncate(cut);
        if dir.is_empty() {
            break;
        }
        for tail in ["/usr/bin/sh.exe", "/bin/sh.exe"] {
            let candidate = PathBuf::from(format!("{dir}{tail}"));
            if exists(&candidate) {
                return Some(candidate);
            }
        }
    }
    None
}

/// `git --exec-path`, or `None` when git is not there to ask.
fn git_exec_path() -> Option<String> {
    let out = std::process::Command::new("git").arg("--exec-path").output().ok()?;
    if !out.status.success() {
        return None;
    }
    let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!path.is_empty()).then_some(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn present(paths: &[&str]) -> impl Fn(&Path) -> bool {
        let set: HashSet<String> = paths.iter().map(|p| p.to_string()).collect();
        move |p: &Path| set.contains(&p.to_string_lossy().replace('\\', "/"))
    }

    /// A stock 64-bit Git for Windows, which is the case this exists for.
    #[test]
    fn a_stock_install_is_found_from_its_exec_path() {
        let found = resolve_posix_shell(
            Some("C:/Program Files/Git/mingw64/libexec/git-core"),
            present(&["C:/Program Files/Git/usr/bin/sh.exe", "C:/Program Files/Git/bin/sh.exe"]),
        );
        assert_eq!(found, Some(PathBuf::from("C:/Program Files/Git/usr/bin/sh.exe")));
    }

    #[test]
    fn a_32_bit_or_relocated_install_is_found_the_same_way() {
        // mingw32 rather than mingw64, and nowhere near %ProgramFiles% --
        // the two reasons this asks git instead of guessing.
        let found = resolve_posix_shell(
            Some("C:/Users/Ada/scoop/apps/git/current/mingw32/libexec/git-core"),
            present(&["C:/Users/Ada/scoop/apps/git/current/usr/bin/sh.exe"]),
        );
        assert_eq!(
            found,
            Some(PathBuf::from("C:/Users/Ada/scoop/apps/git/current/usr/bin/sh.exe"))
        );
    }

    #[test]
    fn backslashes_from_git_are_accepted() {
        let found = resolve_posix_shell(
            Some(r"C:\Program Files\Git\mingw64\libexec\git-core"),
            present(&["C:/Program Files/Git/usr/bin/sh.exe"]),
        );
        assert_eq!(found, Some(PathBuf::from("C:/Program Files/Git/usr/bin/sh.exe")));
    }

    #[test]
    fn bin_is_taken_when_usr_bin_is_not_there() {
        let found = resolve_posix_shell(
            Some("C:/Program Files/Git/mingw64/libexec/git-core"),
            present(&["C:/Program Files/Git/bin/sh.exe"]),
        );
        assert_eq!(found, Some(PathBuf::from("C:/Program Files/Git/bin/sh.exe")));
    }

    #[test]
    fn no_git_and_no_shell_are_both_nothing_rather_than_a_guess() {
        assert_eq!(resolve_posix_shell(None, present(&[])), None);
        assert_eq!(
            resolve_posix_shell(
                Some("C:/Program Files/Git/mingw64/libexec/git-core"),
                present(&["C:/Program Files/Git/mingw64/bin/bash.exe"])
            ),
            None,
            "bash beside git-core is not sh, and inventing one would spawn nothing"
        );
    }

    #[test]
    fn the_walk_up_stops_before_the_drive_root() {
        // Nothing at C:/usr/bin/sh.exe should ever be reached for -- a
        // machine-wide MSYS install is not this git's shell.
        assert_eq!(
            resolve_posix_shell(Some("C:/a/b/c/d/e/f/g/h"), present(&["C:/usr/bin/sh.exe"])),
            None
        );
    }

    /// The unix answer is not resolved at all, and must not become one.
    #[test]
    fn on_unix_the_posix_shell_is_bin_sh() {
        if cfg!(windows) {
            return;
        }
        assert_eq!(posix_shell(), PathBuf::from("/bin/sh"));
    }
}
