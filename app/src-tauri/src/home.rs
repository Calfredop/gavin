//! The one place the app reads the user's home directory.
//!
//! There were five, and they disagreed: two returned `None` for an
//! exported-but-empty `HOME`, one turned it into `PathBuf::from("")` so
//! that `~/.codex/sessions` silently became the RELATIVE path
//! `.codex/sessions`, and `create_fresh_session` fell back to `/`. Every
//! one of them is a path handed to an agent CLI or opened for reading,
//! and a relative one resolves against whatever cwd the app was launched
//! from -- which is `/` under a desktop launcher and the checkout under
//! `npm run tauri dev`, so the bug only ever appears in the packaged
//! build.
//!
//! One helper, one rule: a home directory is an absolute path or it is
//! nothing.
//!
//! The dot-directories underneath it are NOT per-OS, which is why this
//! is the whole of the Linux AND Windows story for agent state. Claude
//! Code keeps
//! `~/.claude` (with `projects/` and, off macOS, `.credentials.json`)
//! on every platform, codex keeps `~/.codex/sessions` (its `CODEX_HOME`
//! override aside), gemini keeps `~/.gemini`, and opencode is already
//! XDG-shaped at `~/.config/opencode/opencode.json`. None of them moves
//! to `%APPDATA%` on Windows -- they are Node and Rust CLIs that join
//! against the home directory, so the whole per-OS difference is which
//! variable NAMES that directory, which is this module's one job.
//! gavin's OWN state is the exception and moves per OS -- see
//! `protocol::app_support_dir`.

use std::path::PathBuf;

/// The user's home directory, or `None` when the environment does not
/// name one usable as a path.
///
/// Empty is `None` (an exported-but-blank `HOME` is not a directory),
/// and so is a relative value, for the reason in the module comment.
pub fn home_dir() -> Option<PathBuf> {
    resolve(std::env::var_os("HOME"), std::env::var_os("USERPROFILE"), cfg!(windows))
}

/// The home directory, with the environment and the platform passed in.
///
/// `%USERPROFILE%` FIRST on Windows, and not merely as a fallback for an
/// unset `HOME`. A developer who starts the app from a Git Bash shell
/// inherits `HOME=/c/Users/Ada` -- an MSYS path, which is not a path any
/// Windows API can open, and which `from_env` would reject as relative
/// anyway (it has a root but no drive). Reading the OS's own answer
/// first means the packaged app and the one launched from Git Bash agree
/// on where `~/.claude` is. `HOME` still wins where it is the truth,
/// which is every unix.
pub fn resolve(
    home: Option<std::ffi::OsString>,
    user_profile: Option<std::ffi::OsString>,
    windows: bool,
) -> Option<PathBuf> {
    if windows {
        return from_env_on(user_profile, true).or_else(|| from_env_on(home, true));
    }
    from_env_on(home, false)
}

/// The rule, with the environment passed in, so it can be tested at
/// every interesting value without `set_var` -- the suite is
/// multi-threaded and several of its tests read `$HOME` themselves.
pub fn from_env(home: Option<std::ffi::OsString>) -> Option<PathBuf> {
    from_env_on(home, cfg!(windows))
}

/// The same rule with the PLATFORM passed in too.
///
/// Absoluteness is the part that differs, and `Path::is_absolute` only
/// ever answers for the host: on a mac it calls `C:\Users\Ada` relative
/// and `/c/Users/Ada` absolute, which is exactly backwards for the two
/// values a Windows process actually sees. Every developer here is on a
/// mac, so a rule that could only be exercised on the target is a rule
/// nothing checks.
pub fn from_env_on(home: Option<std::ffi::OsString>, windows: bool) -> Option<PathBuf> {
    let path = PathBuf::from(home?);
    if path.as_os_str().is_empty() || !is_absolute_on(&path, windows) {
        return None;
    }
    Some(path)
}

/// `Path::is_absolute`, spelled out for a platform that may not be this
/// one. Same verdicts as std gives on each.
///
/// Windows: a drive letter with a separator after it, or a UNC/verbatim
/// prefix. `C:notes` is drive-RELATIVE (it resolves against that drive's
/// own current directory) and `\notes` is root-relative to the current
/// drive; std calls neither absolute, and neither is a home directory.
pub fn is_absolute_on(path: &std::path::Path, windows: bool) -> bool {
    let s = path.to_string_lossy();
    if !windows {
        return s.starts_with('/');
    }
    let b = s.as_bytes();
    if s.starts_with(r"\\") || s.starts_with("//") {
        return true;
    }
    b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/')
}

/// Expands a leading `~/` against the home directory.
///
/// `None` only when the string starts with `~/` and there is no home to
/// expand it against -- anything else is returned as it came, because a
/// path that does not start with `~/` has nothing to do with `$HOME` and
/// a caller that had to unwrap it would be worse off.
pub fn expand_tilde(path: &str) -> Option<PathBuf> {
    match path.strip_prefix("~/") {
        Some(rest) => Some(home_dir()?.join(rest)),
        None => Some(PathBuf::from(path)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;

    fn os(s: &str) -> Option<OsString> {
        Some(OsString::from(s))
    }

    #[test]
    fn an_absolute_home_comes_back_as_it_is() {
        assert_eq!(from_env_on(os("/home/x"), false), Some(PathBuf::from("/home/x")));
        assert_eq!(from_env_on(os("/Users/x"), false), Some(PathBuf::from("/Users/x")));
        assert_eq!(
            from_env_on(os(r"C:\Users\x"), true),
            Some(PathBuf::from(r"C:\Users\x"))
        );
    }

    #[test]
    fn an_unset_empty_or_relative_home_is_nothing() {
        // The `PathBuf::from("")` case is the one that mattered: joined
        // with ".codex/sessions" it produced a relative path that reads
        // whatever happens to sit under the app's cwd.
        assert_eq!(from_env_on(None, false), None);
        assert_eq!(from_env_on(os(""), false), None);
        assert_eq!(from_env_on(os("home/x"), false), None);
        assert_eq!(from_env_on(os("."), false), None);
        // The Windows shapes that look absolute and are not: a
        // drive-relative path resolves against that drive's own current
        // directory, and a rooted one against the current drive.
        assert_eq!(from_env_on(os(r"C:Users\x"), true), None);
        assert_eq!(from_env_on(os(r"\Users\x"), true), None);
        assert_eq!(from_env_on(os("/c/Users/x"), true), None);
    }

    #[test]
    fn absoluteness_is_judged_by_the_target_not_the_host() {
        // Both directions, because both are wrong on the other platform
        // and the mac is where this runs.
        assert!(is_absolute_on(std::path::Path::new(r"C:\Users\Ada"), true));
        assert!(is_absolute_on(std::path::Path::new("C:/Users/Ada"), true));
        assert!(is_absolute_on(std::path::Path::new(r"\\server\share"), true));
        assert!(!is_absolute_on(std::path::Path::new("/c/Users/Ada"), true));
        assert!(is_absolute_on(std::path::Path::new("/c/Users/Ada"), false));
        assert!(!is_absolute_on(std::path::Path::new(r"C:\Users\Ada"), false));
    }

    #[test]
    fn the_running_process_has_a_home_and_it_is_absolute() {
        // Guards the shape of the real read, not a value: every agent
        // dot-directory the app looks in hangs off this.
        let home = home_dir().expect("a test process has HOME set");
        assert!(home.is_absolute(), "{}", home.display());
    }

    #[test]
    fn windows_reads_the_profile_before_an_msys_home() {
        // Git Bash exports HOME=/c/Users/Ada. It is a real directory to
        // the shell and to nothing else: no Windows API opens it, and
        // `~/.claude` built on it would be read from a path that does
        // not exist. The OS's own variable is the answer.
        assert_eq!(
            resolve(os("/c/Users/Ada"), os(r"C:\Users\Ada"), true),
            Some(PathBuf::from(r"C:\Users\Ada"))
        );
    }

    #[test]
    fn windows_still_falls_back_to_home_when_it_is_usable() {
        // An absolute Windows HOME (someone set it deliberately) is a
        // real answer, and losing it because USERPROFILE happened to be
        // unset would be worse than taking it.
        assert_eq!(
            resolve(os(r"D:\home\ada"), None, true),
            Some(PathBuf::from(r"D:\home\ada"))
        );
        assert_eq!(resolve(None, None, true), None);
    }

    #[test]
    fn off_windows_the_profile_variable_is_not_consulted() {
        // USERPROFILE can be set on a unix -- a Wine prefix, a shell
        // profile someone copied -- and it is not where anything lives
        // there.
        assert_eq!(resolve(os("/home/ada"), os("/wine/users/ada"), false), Some(PathBuf::from("/home/ada")));
        assert_eq!(resolve(None, os("/wine/users/ada"), false), None);
    }

    #[test]
    fn expand_tilde_only_touches_a_leading_tilde_slash() {
        let home = home_dir().unwrap();
        assert_eq!(expand_tilde("~/notes.md"), Some(home.join("notes.md")));
        // A bare "~" and "~other" are NOT home: the shell expands the
        // first and another user's home for the second, and guessing at
        // either would open the wrong file.
        assert_eq!(expand_tilde("~"), Some(PathBuf::from("~")));
        assert_eq!(expand_tilde("~root/x"), Some(PathBuf::from("~root/x")));
        assert_eq!(expand_tilde("/abs/x"), Some(PathBuf::from("/abs/x")));
        assert_eq!(expand_tilde("rel/x"), Some(PathBuf::from("rel/x")));
    }
}
