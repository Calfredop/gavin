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

/// PATH for the shell an emitted command line runs in, with Git for
/// Windows' own tool directories on the front of it. `None` when there
/// is nothing to add, which is every non-Windows platform.
///
/// `sh -c <line>` is neither a login nor an interactive shell, so it
/// reads no profile -- and a default Git for Windows install writes only
/// `<git>\cmd` into the machine PATH, which carries `git.exe` and
/// essentially nothing else. Measured on a stock Windows 11 box: the
/// persisted machine PATH is `…;C:\Program Files\Git\cmd;…` with no
/// `usr\bin` anywhere, so an app started from the Start menu hands every
/// emitted command line a POSIX shell with no `bash`, no `ls`, no `sed`
/// and no `grep`.
///
/// That is not a cosmetic gap. A `script`-kind tool is emitted as
/// `bash -c <body>` (`buildToolCommand`), so it dies with "command not
/// found" before its body runs, and the failure epilogue then reports
/// 127 for a tool that never started -- a rail step stalls with a
/// verdict about the wrong thing. A dev build hides it completely,
/// because a daemon launched from a terminal inherits that terminal's
/// PATH and Git Bash's profile has already fixed it there.
///
/// Prepended rather than appended, which is both what Git Bash's own
/// `/etc/profile` does and the safer half of the choice: an emitted
/// POSIX line that reaches `C:\Windows\System32\find.exe` or `sort.exe`
/// instead of the MSYS ones does something quietly different rather than
/// failing where it can be seen.
///
/// Only for the POSIX shell. `interactive_shell` is a Windows shell a
/// human typed into and keeps the PATH Windows gave it.
pub fn path_with_posix_tools(shell: &Path) -> Option<std::ffi::OsString> {
    if !cfg!(windows) {
        return None;
    }
    posix_tools_path(
        &shell.to_string_lossy(),
        std::env::var_os("PATH").as_deref(),
        |p| p.is_dir(),
    )
}

/// The pure half of the above: given where `sh.exe` was found and the
/// PATH the daemon inherited, the PATH its children should get.
///
/// The candidates are in `/etc/profile`'s order, and `<git>/bin` is on
/// the end for the one case `resolve_posix_shell` allows it -- a layout
/// with no `usr/bin` at all, where those three programs are the whole
/// of what there is. A bare `sh.exe` with no directory in front of it
/// (the last-resort fallback) says nothing about where the tools live,
/// so it adds nothing rather than guessing.
pub fn posix_tools_path(
    shell: &str,
    current_path: Option<&std::ffi::OsStr>,
    exists: impl Fn(&Path) -> bool,
) -> Option<std::ffi::OsString> {
    let shell = shell.replace('\\', "/");
    let root = ["/usr/bin/sh.exe", "/bin/sh.exe"]
        .into_iter()
        .find_map(|tail| shell.strip_suffix(tail))?;

    let dirs: Vec<String> = ["mingw64/bin", "mingw32/bin", "usr/local/bin", "usr/bin", "bin"]
        .into_iter()
        .map(|tail| format!("{root}/{tail}"))
        .filter(|dir| exists(Path::new(dir)))
        .collect();
    if dirs.is_empty() {
        return None;
    }

    let mut out = std::ffi::OsString::from(dirs.join(";"));
    match current_path {
        // An empty inherited PATH must not leave a trailing separator:
        // on Windows an empty entry means the current directory, and
        // putting one in every session's PATH is how a stray `sort.exe`
        // in a worktree gets run instead of the MSYS one.
        Some(current) if !current.is_empty() => {
            out.push(";");
            out.push(current);
        }
        _ => {}
    }
    Some(out)
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

    fn dirs(paths: &[&str]) -> impl Fn(&Path) -> bool {
        present(paths)
    }

    /// The case this exists for: a stock install, and the PATH a Start
    /// menu launch actually inherits on a Windows 11 box -- `<git>\cmd`
    /// and nothing else from Git for Windows.
    #[test]
    fn the_msys_tool_directories_go_in_front_of_the_inherited_path() {
        let inherited = std::ffi::OsString::from(r"C:\WINDOWS\system32;C:\Program Files\Git\cmd");
        let path = posix_tools_path(
            "C:/Program Files/Git/usr/bin/sh.exe",
            Some(&inherited),
            dirs(&[
                "C:/Program Files/Git/mingw64/bin",
                "C:/Program Files/Git/usr/local/bin",
                "C:/Program Files/Git/usr/bin",
                "C:/Program Files/Git/bin",
            ]),
        );
        assert_eq!(
            path,
            Some(std::ffi::OsString::from(concat!(
                "C:/Program Files/Git/mingw64/bin;",
                "C:/Program Files/Git/usr/local/bin;",
                "C:/Program Files/Git/usr/bin;",
                "C:/Program Files/Git/bin;",
                r"C:\WINDOWS\system32;C:\Program Files\Git\cmd",
            )))
        );
    }

    #[test]
    fn a_32_bit_install_contributes_its_own_mingw() {
        let inherited = std::ffi::OsString::from(r"C:\WINDOWS\system32");
        let path = posix_tools_path(
            "C:/Users/Ada/scoop/apps/git/current/usr/bin/sh.exe",
            Some(&inherited),
            dirs(&[
                "C:/Users/Ada/scoop/apps/git/current/mingw32/bin",
                "C:/Users/Ada/scoop/apps/git/current/usr/bin",
            ]),
        );
        assert_eq!(
            path,
            Some(std::ffi::OsString::from(concat!(
                "C:/Users/Ada/scoop/apps/git/current/mingw32/bin;",
                "C:/Users/Ada/scoop/apps/git/current/usr/bin;",
                r"C:\WINDOWS\system32",
            )))
        );
    }

    /// An empty inherited PATH must not leave a trailing `;`. On Windows
    /// an empty PATH entry means the CURRENT DIRECTORY, so the sloppy
    /// version puts the worktree being worked on onto the search path of
    /// every session in it.
    #[test]
    fn an_empty_inherited_path_leaves_no_trailing_separator() {
        for inherited in [Some(std::ffi::OsString::from("")), None] {
            let path = posix_tools_path(
                "C:/Program Files/Git/usr/bin/sh.exe",
                inherited.as_deref(),
                dirs(&["C:/Program Files/Git/usr/bin"]),
            );
            assert_eq!(path, Some(std::ffi::OsString::from("C:/Program Files/Git/usr/bin")));
        }
    }

    /// The bare `sh.exe` last resort says nothing about where the tools
    /// live, and neither does a directory with none of them in it.
    /// Adding nothing leaves the inherited PATH exactly as it was, which
    /// is the behaviour this whole function is an improvement on -- so
    /// the failure mode is the old one, not a broken PATH.
    #[test]
    fn nothing_is_added_when_there_is_nothing_to_add() {
        let inherited = std::ffi::OsString::from(r"C:\WINDOWS\system32");
        assert_eq!(posix_tools_path("sh.exe", Some(&inherited), dirs(&[])), None);
        assert_eq!(
            posix_tools_path(
                "C:/Program Files/Git/usr/bin/sh.exe",
                Some(&inherited),
                dirs(&[]),
            ),
            None
        );
    }

    #[test]
    fn backslashes_in_the_resolved_shell_are_accepted() {
        let path = posix_tools_path(
            r"C:\Program Files\Git\usr\bin\sh.exe",
            None,
            dirs(&["C:/Program Files/Git/usr/bin"]),
        );
        assert_eq!(path, Some(std::ffi::OsString::from("C:/Program Files/Git/usr/bin")));
    }

    /// Unix resolves `/bin/sh` and needs no help finding anything.
    #[test]
    fn on_unix_the_path_is_left_alone() {
        if cfg!(windows) {
            return;
        }
        assert_eq!(path_with_posix_tools(Path::new("/bin/sh")), None);
    }

    /// The Windows arm end to end: the directories it names are really
    /// there, and `bash.exe` -- which every `script`-kind tool is emitted
    /// against -- is in one of them.
    #[cfg(windows)]
    #[test]
    fn on_windows_the_tools_path_names_directories_that_hold_bash() {
        let shell = posix_shell();
        let path = path_with_posix_tools(&shell).expect("no tool directories found");
        let path = path.to_string_lossy().into_owned();
        let found = path
            .split(';')
            .any(|dir| !dir.is_empty() && Path::new(dir).join("bash.exe").is_file());
        assert!(found, "no bash.exe on the front of {path}");
    }

    /// The resolution above, against a real machine rather than a table
    /// of invented paths. Every test before this one hands
    /// `resolve_posix_shell` a made-up layout; this one asks whether the
    /// layout is real -- that `git --exec-path` answers at all (it is
    /// consulted at PTY spawn, before any workspace is open), and that
    /// walking up from its answer actually lands on a `sh.exe` that
    /// exists.
    ///
    /// The `sh.exe` fallback is a deliberate non-failure in `posix_shell`
    /// -- spawning it and failing beats refusing to start -- which means
    /// a machine with no Git for Windows would otherwise pass this file
    /// silently. Git for Windows is a hard prerequisite of the app (every
    /// worktree action shells out to `git`), so on Windows its absence is
    /// the failure, not an excuse.
    #[cfg(windows)]
    #[test]
    fn on_windows_the_posix_shell_is_a_git_bash_sh_that_is_really_there() {
        let shell = posix_shell();
        assert!(
            shell.is_file(),
            "resolved {shell:?}, which is not a file -- git --exec-path said {:?}",
            git_exec_path()
        );
        assert_eq!(
            shell.file_name().and_then(|n| n.to_str()),
            Some("sh.exe"),
            "resolved {shell:?}"
        );
    }

    /// A plain terminal tab gets the OS's own shell, and `%COMSPEC%` is
    /// set on every Windows since NT. Asserted as a real file because the
    /// `cmd.exe` fallback is a bare name PATH has to answer for, and this
    /// is the one place that can say whether it had to.
    #[cfg(windows)]
    #[test]
    fn on_windows_a_plain_tab_gets_a_comspec_that_is_really_there() {
        let shell = interactive_shell();
        assert!(shell.is_file(), "COMSPEC resolved to {shell:?}");
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
