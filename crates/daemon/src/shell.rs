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

/// Rewrite a command line's leading word to include the extension Windows
/// would resolve it to, when that is one Git Bash's own PATH search would
/// otherwise miss.
///
/// `sh -c` finds a bare `.exe` on PATH -- MSYS's search handles that
/// extension itself -- but it does not probe `PATHEXT`, so a command
/// installed as `agent.cmd` (the shape every npm-global install and many
/// other Windows CLI installers use) reports "command not found" even
/// though the exact same name resolves fine from `cmd.exe`, PowerShell, or
/// a bash prompt a human types into. Handing bash the literal `agent.cmd`
/// sidesteps the gap: an exact existing filename, extension and all, is
/// something bash's own PATH search does match, and MSYS's spawn already
/// knows how to run a `.bat`/`.cmd` once it has one.
///
/// **`.cmd` / `.bat` and multiline prompts.** Those shims forward args
/// with `%*`, and `cmd.exe` truncates an argument at the first newline.
/// Gavin's card prompts are always multiline (name-tab line, blank line,
/// body), so launching via `agent.cmd` delivers only the first line.
/// Cursor Agent's `agent.ps1` would keep newlines, but driving that
/// script through `powershell.exe -File` opens a **new console window**
/// under ConPTY (MSYS spawning a second Win32 console host) -- the rail
/// tab stays empty while a separate PowerShell window runs the agent.
/// So when the install layout matches what `agent.ps1` would run
/// (`node.exe` + `index.js` beside the shim, or under `versions/<ver>/`),
/// rewrite straight to that node pair: multiline argv survives (measured)
/// and the process stays on the PTY. No node entry keeps the `.cmd` form.
///
/// A no-op wherever it cannot help: a leading word that already carries a
/// path separator or a dot, an empty `PATHEXT` (every non-Windows
/// platform, since this is only ever called from the Windows arm of
/// [`PtySession::spawn`]), or nothing on `path` answering to any `PATHEXT`
/// candidate at all -- which is also what a multi-command line's leading
/// shell keyword (`cd`, `if`, …) hits, since none of those are files.
pub fn rewrite_for_windows_shim(command: &str, path: &std::ffi::OsStr) -> String {
    let pathext = std::env::var("PATHEXT").unwrap_or_default();
    command_with_windows_shim(command, path, &pathext, |p| p.is_file(), resolve_bundled_node_entry)
}

/// POSIX single-quote for a path embedded in an `sh -c` line.
fn posix_single_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// What Cursor's `agent.ps1` resolves to: a `node.exe` + `index.js` pair
/// either beside the shim or under the newest `versions/<ver>/` directory.
/// `None` when the layout is not that shape (a plain npm `.cmd` with no
/// bundled runtime).
fn resolve_bundled_node_entry(dir: &Path) -> Option<(PathBuf, PathBuf)> {
    let direct_node = dir.join("node.exe");
    let direct_index = dir.join("index.js");
    if direct_node.is_file() && direct_index.is_file() {
        return Some((direct_node, direct_index));
    }
    let versions = dir.join("versions");
    let entries = std::fs::read_dir(&versions).ok()?;
    let mut best: Option<(u32, String, PathBuf)> = None;
    for entry in entries.flatten() {
        let Ok(ft) = entry.file_type() else { continue };
        if !ft.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(key) = cursor_agent_version_key(&name) else { continue };
        let better = match &best {
            None => true,
            Some((k, n, _)) => key > *k || (key == *k && name > *n),
        };
        if better {
            best = Some((key, name, entry.path()));
        }
    }
    let ver_dir = best?.2;
    let node = ver_dir.join("node.exe");
    let index = ver_dir.join("index.js");
    (node.is_file() && index.is_file()).then_some((node, index))
}

/// Cursor Agent version dirs are `YYYY.MM.DD[-HH-MM-SS]-<commit>`. The
/// date packs into a sortable u32 the same way `agent.ps1`'s
/// `Parse-VersionString` does; same-day builds break ties by name.
fn cursor_agent_version_key(name: &str) -> Option<u32> {
    let date = name.split('-').next()?;
    let mut parts = date.split('.');
    let y: u32 = parts.next()?.parse().ok()?;
    let m: u32 = parts.next()?.parse().ok()?;
    let d: u32 = parts.next()?.parse().ok()?;
    if parts.next().is_some() || m > 12 || d > 31 {
        return None;
    }
    Some(y * 10_000 + m * 100 + d)
}

/// The pure half of [`rewrite_for_windows_shim`].
///
/// `node_entry` is how a `.cmd` directory yields a bundled node pair:
/// production passes [`resolve_bundled_node_entry`]; tests pass a stub.
pub fn command_with_windows_shim(
    command: &str,
    path: &std::ffi::OsStr,
    pathext: &str,
    exists: impl Fn(&Path) -> bool,
    node_entry: impl Fn(&Path) -> Option<(PathBuf, PathBuf)>,
) -> String {
    let word_end = command.find(char::is_whitespace).unwrap_or(command.len());
    let word = &command[..word_end];
    if word.is_empty() || word.contains(['/', '\\', '.']) {
        return command.to_string();
    }
    // Lower-cased once here rather than left to the real filesystem's own
    // case-insensitivity: `PATHEXT` is conventionally all-caps, but the
    // files it describes almost never are, and a test's fake `exists`
    // should not have to special-case what NTFS would paper over.
    let exts: Vec<String> =
        pathext.split(';').filter(|e| !e.is_empty()).map(|e| e.to_ascii_lowercase()).collect();
    let found = std::env::split_paths(path).find_map(|dir| {
        exts.iter().find_map(|ext| {
            let candidate = dir.join(format!("{word}{ext}"));
            exists(&candidate).then(|| (dir.clone(), ext.clone()))
        })
    });
    match found {
        Some((dir, ext)) if matches!(ext.as_str(), ".cmd" | ".bat") => {
            if let Some((node, script)) = node_entry(&dir) {
                let node = node.to_string_lossy().replace('\\', "/");
                let script = script.to_string_lossy().replace('\\', "/");
                // CURSOR_INVOKED_AS is what agent.ps1 stamps before exec;
                // without it some CLI paths treat the process as anonymous.
                format!(
                    "CURSOR_INVOKED_AS={} {} {}{}",
                    posix_single_quote(&format!("{word}.ps1")),
                    posix_single_quote(&node),
                    posix_single_quote(&script),
                    &command[word_end..]
                )
            } else {
                format!("{word}{ext}{}", &command[word_end..])
            }
        }
        Some((_, ext)) => format!("{word}{ext}{}", &command[word_end..]),
        None => command.to_string(),
    }
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

    fn no_node(_: &Path) -> Option<(PathBuf, PathBuf)> {
        None
    }

    fn shim(command: &str, path: &str, pathext: &str, files: &[&str]) -> String {
        command_with_windows_shim(
            command,
            &std::ffi::OsString::from(path),
            pathext,
            present(files),
            no_node,
        )
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

    /// Against a real Cursor Agent install when one is on PATH: the
    /// rewrite must land on node.exe, not powershell.exe and not
    /// agent.cmd -- those are the two broken Windows shapes.
    #[cfg(windows)]
    #[test]
    fn on_windows_a_real_cursor_agent_rewrites_to_bundled_node() {
        let path = std::env::var_os("PATH").unwrap_or_default();
        let rewritten = rewrite_for_windows_shim("agent --trust 'line1\n\nline2'", &path);
        if rewritten.starts_with("agent ") || rewritten == "agent --trust 'line1\n\nline2'" {
            // No agent on PATH in this environment -- nothing to assert.
            return;
        }
        assert!(
            rewritten.contains("node.exe") && rewritten.contains("index.js"),
            "expected bundled node launch, got: {rewritten}"
        );
        assert!(
            !rewritten.contains("powershell"),
            "powershell opens a new console window under ConPTY: {rewritten}"
        );
        assert!(
            !rewritten.contains("agent.cmd"),
            "agent.cmd truncates multiline prompts: {rewritten}"
        );
        assert!(
            rewritten.contains("line1\n\nline2"),
            "prompt newlines must survive the rewrite: {rewritten}"
        );
    }

    /// The case this exists for: an npm-global shim, which is a `.cmd`
    /// file, not a `.exe`. No bundled node runtime -- keep the `.cmd` form.
    #[test]
    fn a_cmd_shim_gets_its_extension_appended() {
        assert_eq!(
            shim("agent 'do the thing'", "C:/tools", ".COM;.EXE;.BAT;.CMD", &["C:/tools/agent.cmd"]),
            "agent.cmd 'do the thing'"
        );
    }

    /// Cursor Agent's install is `agent.cmd` + `versions/<ver>/node.exe`.
    /// Rewriting to that node pair keeps multiline prompts (unlike `.cmd`
    /// `%*`) and stays on the ConPTY (unlike `powershell.exe -File`).
    #[test]
    fn a_cmd_shim_with_bundled_node_runs_node_directly() {
        let path = std::ffi::OsString::from("C:/tools");
        let rewritten = command_with_windows_shim(
            "agent --approve-mcps --trust 'line1\n\nline2'",
            &path,
            ".COM;.EXE;.BAT;.CMD",
            present(&["C:/tools/agent.cmd"]),
            |_| {
                Some((
                    PathBuf::from("C:/tools/versions/2026.09.10-abc/node.exe"),
                    PathBuf::from("C:/tools/versions/2026.09.10-abc/index.js"),
                ))
            },
        );
        assert_eq!(
            rewritten,
            "CURSOR_INVOKED_AS='agent.ps1' 'C:/tools/versions/2026.09.10-abc/node.exe' 'C:/tools/versions/2026.09.10-abc/index.js' --approve-mcps --trust 'line1\n\nline2'"
        );
    }

    /// A node path with an apostrophe still round-trips through the
    /// POSIX single-quote the rewrite embeds.
    #[test]
    fn a_node_path_with_an_apostrophe_is_posix_quoted() {
        let path = std::ffi::OsString::from("C:/Ada's tools");
        let rewritten = command_with_windows_shim(
            "agent 'go'",
            &path,
            ".CMD",
            present(&["C:/Ada's tools/agent.cmd"]),
            |_| {
                Some((
                    PathBuf::from("C:/Ada's tools/node.exe"),
                    PathBuf::from("C:/Ada's tools/index.js"),
                ))
            },
        );
        assert_eq!(
            rewritten,
            "CURSOR_INVOKED_AS='agent.ps1' 'C:/Ada'\\''s tools/node.exe' 'C:/Ada'\\''s tools/index.js' 'go'"
        );
    }

    /// Newest `versions/<ver>/` wins; same-day builds break ties by name.
    #[test]
    fn cursor_agent_version_key_packs_the_date() {
        assert_eq!(cursor_agent_version_key("2026.09.10-fd3934a"), Some(2026_09_10));
        assert_eq!(cursor_agent_version_key("2026.9.1-aabbcc"), Some(2026_09_01));
        assert_eq!(
            cursor_agent_version_key("2026.09.10-12-00-00-fd3934a"),
            Some(2026_09_10)
        );
        assert_eq!(cursor_agent_version_key("not-a-version"), None);
    }

    /// PATHEXT order is honoured: an `.exe` earlier in the list wins over
    /// a `.cmd` later in the same directory, matching what `cmd.exe`
    /// itself would run.
    #[test]
    fn the_first_pathext_match_wins_over_a_later_one() {
        assert_eq!(
            shim(
                "thing arg",
                "C:/tools",
                ".COM;.EXE;.BAT;.CMD",
                &["C:/tools/thing.exe", "C:/tools/thing.cmd"]
            ),
            "thing.exe arg"
        );
    }

    /// PATH order is honoured too: the first directory that has ANY
    /// match wins, even over a better match further down PATH.
    #[test]
    fn the_first_path_directory_with_a_match_wins() {
        assert_eq!(
            shim(
                "thing",
                "C:/first;C:/second",
                ".COM;.EXE;.BAT;.CMD",
                &["C:/first/thing.cmd", "C:/second/thing.exe"]
            ),
            "thing.cmd"
        );
    }

    /// A bare name that already resolves (an `.exe` MSYS's own search
    /// would have found anyway) is left alone -- there is nothing broken
    /// to fix, and rewriting it would just be noise.
    #[test]
    fn a_word_matching_nothing_on_pathext_is_left_alone() {
        assert_eq!(
            shim("sh -c 'true'", "C:/tools", ".COM;.EXE;.BAT;.CMD", &[]),
            "sh -c 'true'"
        );
    }

    /// A multi-command line's leading shell keyword is not a file on any
    /// PATH directory, so it is left alone -- the miss this function
    /// cannot close, not a regression it introduces.
    #[test]
    fn a_leading_shell_builtin_is_left_alone_even_if_a_later_word_is_a_shim() {
        assert_eq!(
            shim(
                "cd /work && agent 'go'",
                "C:/tools",
                ".COM;.EXE;.BAT;.CMD",
                &["C:/tools/agent.cmd"]
            ),
            "cd /work && agent 'go'"
        );
    }

    /// A word that already carries a path or an extension is assumed
    /// already-qualified and is not second-guessed.
    #[test]
    fn an_already_qualified_word_is_left_alone() {
        for word in ["C:/tools/agent", "agent.cmd", "./agent"] {
            let line = format!("{word} 'go'");
            assert_eq!(
                shim(&line, "C:/tools", ".COM;.EXE;.BAT;.CMD", &["C:/tools/agent.cmd"]),
                line
            );
        }
    }

    /// An empty `PATHEXT` -- every non-Windows platform -- makes this a
    /// pure no-op, which is what lets `rewrite_for_windows_shim` skip its
    /// own `cfg!(windows)` check and just call through.
    #[test]
    fn an_empty_pathext_is_always_a_no_op() {
        assert_eq!(
            shim("agent 'go'", "C:/tools", "", &["C:/tools/agent.cmd"]),
            "agent 'go'"
        );
    }
}
