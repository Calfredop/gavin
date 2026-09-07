//! Turning a bare command name into something the OS will actually
//! start.
//!
//! On unix `Command::new("claude")` searches `PATH` and that is the end
//! of it. On Windows it is not: `CreateProcess` does not apply
//! `PATHEXT`, so a name with no extension resolves only if a file with
//! exactly that name is executable -- and every agent CLI gavin probes
//! is installed by npm, which writes `claude.cmd` (for `cmd`) and a
//! bare, extensionless `claude` (a `#!/bin/sh` script, for Git Bash).
//! `Command::new("claude")` would find the second, hand it to
//! `CreateProcess`, and be told it is not a valid application.
//!
//! So the extension has to be chosen here. Running the file once found
//! does not: since 1.77.2 Rust's own `Command` invokes a `.bat` or
//! `.cmd` through `cmd /c` with the quoting that CVE-2024-24576 was
//! about, so a resolved `.cmd` path is spawned like any other program.
//!
//! Only for programs gavin runs ITSELF. A command line typed into a
//! card, a tool body or `[agent].command` goes to the PTY and is
//! resolved by the shell there, which has its own rules and already
//! finds the npm shims (see `pty.rs`).

use std::path::{Path, PathBuf};

/// The default `PATHEXT` Windows uses when the variable is unset. `.CMD`
/// and `.BAT` matter here; the rest are carried because leaving one out
/// would make this quietly narrower than the shell.
const DEFAULT_PATHEXT: &str = ".COM;.EXE;.BAT;.CMD";

/// A path `Command::new` can be given for `name`, or `None` when nothing
/// on `PATH` answers to it.
pub fn resolve(name: &str) -> Option<PathBuf> {
    resolve_with(
        name,
        std::env::var_os("PATH"),
        std::env::var_os("PATHEXT"),
        cfg!(windows),
        |p| p.is_file(),
    )
}

/// Whether `name` is startable at all -- the question "is gh installed"
/// really is.
pub fn on_path(name: &str) -> bool {
    resolve(name).is_some()
}

/// The rule with the environment, the platform and the filesystem passed
/// in.
///
/// The filesystem as a predicate so the Windows arm can be exercised on
/// the mac everyone here develops on: the whole behaviour is "which of
/// these candidate names exists", and a test that could only run on the
/// target is a test that runs never.
pub fn resolve_with(
    name: &str,
    path_var: Option<std::ffi::OsString>,
    pathext_var: Option<std::ffi::OsString>,
    windows: bool,
    exists: impl Fn(&Path) -> bool,
) -> Option<PathBuf> {
    // Already a path, not a name: the caller has said where, and PATH
    // has nothing to do with it.
    if name.contains('/') || (windows && name.contains('\\')) {
        let path = PathBuf::from(name);
        return exists(&path).then_some(path);
    }
    let path_var = path_var?;
    let dirs = split_path_var(&path_var.to_string_lossy(), windows);
    if !windows {
        return dirs.into_iter().map(|d| join(&d, name, false)).find(|p| exists(p));
    }
    // A name that already carries one of the executable extensions is
    // taken as given -- `python.exe` must not become `python.exe.COM`.
    let exts: Vec<String> = pathext_var
        .map(|e| e.to_string_lossy().to_string())
        .filter(|e| !e.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_PATHEXT.to_string())
        .split(';')
        // Lowercased. Windows's own default PATHEXT is upper case, the
        // files npm and every installer write are lower, and the
        // filesystem does not care -- but Rust's `Command` decides
        // whether to route a program through `cmd /c` by looking at the
        // extension it was handed, and that comparison is not this
        // module's to assume. Lower case is the spelling the file
        // actually has.
        .map(|e| e.trim().to_lowercase())
        .filter(|e| !e.is_empty())
        .collect();
    let already_suffixed = exts.iter().any(|e| name.to_lowercase().ends_with(e.as_str()));
    for dir in dirs {
        if already_suffixed {
            let candidate = join(&dir, name, true);
            if exists(&candidate) {
                return Some(candidate);
            }
            continue;
        }
        for ext in &exts {
            let candidate = join(&dir, &format!("{name}{ext}"), true);
            if exists(&candidate) {
                return Some(candidate);
            }
        }
    }
    None
}

/// `PATH` into its directories, for the platform named rather than the
/// one running.
///
/// `std::env::split_paths` splits on the HOST's separator, which makes
/// the Windows rule impossible to test from a mac: `C:\a;C:\b` comes
/// back as `C` and `\a;C` and `\b`. Quotes are honoured on Windows
/// because they are what lets a directory hold a `;`, and std strips
/// them for the same reason.
fn split_path_var(value: &str, windows: bool) -> Vec<String> {
    if !windows {
        return value.split(':').filter(|s| !s.is_empty()).map(|s| s.to_string()).collect();
    }
    let mut out = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    for c in value.chars() {
        match c {
            '"' => quoted = !quoted,
            ';' if !quoted => {
                if !current.is_empty() {
                    out.push(std::mem::take(&mut current));
                }
            }
            _ => current.push(c),
        }
    }
    if !current.is_empty() {
        out.push(current);
    }
    out
}

/// A directory and a file name joined with the separator the TARGET
/// uses, not `PathBuf::join`'s, which is the host's.
fn join(dir: &str, name: &str, windows: bool) -> PathBuf {
    let sep = if windows { '\\' } else { '/' };
    let dir = dir.trim_end_matches(['/', '\\']);
    PathBuf::from(format!("{dir}{sep}{name}"))
}

/// `resolve`, falling back to the bare name.
///
/// For the call sites whose "not found" handling already lives in the
/// spawn's `NotFound` arm: handing them `None` would mean inventing a
/// second spelling of "there is no gh", and there is deliberately only
/// one.
pub fn resolve_or_name(name: &str) -> PathBuf {
    resolve(name).unwrap_or_else(|| PathBuf::from(name))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn os(s: &str) -> Option<std::ffi::OsString> {
        Some(std::ffi::OsString::from(s))
    }

    fn present(paths: &[&str]) -> impl Fn(&Path) -> bool {
        let set: HashSet<String> = paths.iter().map(|p| p.to_lowercase()).collect();
        move |p: &Path| set.contains(&p.to_string_lossy().to_lowercase())
    }

    #[test]
    fn windows_prefers_the_cmd_shim_over_the_extensionless_shell_script() {
        // Exactly what npm writes into its global bin directory, and the
        // bug this module exists for: the bare `claude` is a
        // `#!/bin/sh` script that CreateProcess refuses.
        let found = resolve_with(
            "claude",
            os(r"C:\Users\Ada\AppData\Roaming\npm"),
            None,
            true,
            present(&[
                r"C:\Users\Ada\AppData\Roaming\npm\claude",
                r"C:\Users\Ada\AppData\Roaming\npm\claude.cmd",
            ]),
        );
        assert_eq!(found, Some(PathBuf::from(r"C:\Users\Ada\AppData\Roaming\npm\claude.cmd")));
    }

    #[test]
    fn windows_walks_path_in_order_and_honours_pathext() {
        let found = resolve_with(
            "gh",
            os(r"C:\first;C:\second"),
            os(".EXE;.CMD"),
            true,
            present(&[r"C:\second\gh.exe", r"C:\first\gh.cmd"]),
        );
        // The DIRECTORY order wins over the extension order: a shell
        // resolves the first directory that answers at all.
        assert_eq!(found, Some(PathBuf::from(r"C:\first\gh.cmd")));
    }

    #[test]
    fn a_name_that_already_has_an_extension_is_not_extended_again() {
        let found = resolve_with(
            "curl.exe",
            os(r"C:\Windows\System32"),
            None,
            true,
            present(&[r"C:\Windows\System32\curl.exe"]),
        );
        assert_eq!(found, Some(PathBuf::from(r"C:\Windows\System32\curl.exe")));
    }

    #[test]
    fn nothing_on_path_is_nothing() {
        assert_eq!(resolve_with("gh", os(r"C:\first"), None, true, present(&[])), None);
        assert_eq!(resolve_with("gh", os("/usr/bin"), None, false, present(&[])), None);
        assert_eq!(resolve_with("gh", None, None, false, present(&["/usr/bin/gh"])), None);
    }

    #[test]
    fn unix_appends_no_extension_and_takes_the_first_directory() {
        let found = resolve_with(
            "gh",
            os("/usr/local/bin:/usr/bin"),
            None,
            false,
            present(&["/usr/bin/gh", "/usr/local/bin/gh"]),
        );
        assert_eq!(found, Some(PathBuf::from("/usr/local/bin/gh")));
    }

    #[test]
    fn a_path_rather_than_a_name_is_taken_as_given() {
        assert_eq!(
            resolve_with("/opt/gh/bin/gh", os("/usr/bin"), None, false, present(&["/opt/gh/bin/gh"])),
            Some(PathBuf::from("/opt/gh/bin/gh"))
        );
        assert_eq!(
            resolve_with(r"C:\tools\gh.exe", None, None, true, present(&[r"C:\tools\gh.exe"])),
            Some(PathBuf::from(r"C:\tools\gh.exe"))
        );
        // And a path that does not exist is not silently searched for on
        // PATH instead.
        assert_eq!(
            resolve_with("/opt/gh/bin/gh", os("/usr/bin"), None, false, present(&["/usr/bin/gh"])),
            None
        );
    }

    #[test]
    fn the_running_process_can_find_something_it_definitely_has() {
        // One test against the real filesystem, so the wiring above is
        // not the only thing checked.
        let git = resolve("git");
        assert!(git.is_some(), "the suite runs in a git checkout");
        assert!(resolve("a-program-no-machine-has-ee1f3a").is_none());
    }
}
