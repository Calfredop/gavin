//! The one place the app reads `$HOME`.
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
//! is the whole of the Linux story for agent state. Claude Code keeps
//! `~/.claude` (with `projects/` and, off macOS, `.credentials.json`)
//! on every platform, codex keeps `~/.codex/sessions` (its `CODEX_HOME`
//! override aside), gemini keeps `~/.gemini`, and opencode is already
//! XDG-shaped at `~/.config/opencode/opencode.json`. gavin's OWN state
//! is the exception and moves per OS -- see `protocol::app_support_dir`.

use std::path::PathBuf;

/// The user's home directory, or `None` when the environment does not
/// name one usable as a path.
///
/// Empty is `None` (an exported-but-blank `HOME` is not a directory),
/// and so is a relative value, for the reason in the module comment.
pub fn home_dir() -> Option<PathBuf> {
    from_env(std::env::var_os("HOME"))
}

/// The rule, with the environment passed in, so it can be tested at
/// every interesting value without `set_var` -- the suite is
/// multi-threaded and several of its tests read `$HOME` themselves.
pub fn from_env(home: Option<std::ffi::OsString>) -> Option<PathBuf> {
    let path = PathBuf::from(home?);
    if path.as_os_str().is_empty() || !path.is_absolute() {
        return None;
    }
    Some(path)
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
        assert_eq!(from_env(os("/home/x")), Some(PathBuf::from("/home/x")));
        assert_eq!(from_env(os("/Users/x")), Some(PathBuf::from("/Users/x")));
    }

    #[test]
    fn an_unset_empty_or_relative_home_is_nothing() {
        // The `PathBuf::from("")` case is the one that mattered: joined
        // with ".codex/sessions" it produced a relative path that reads
        // whatever happens to sit under the app's cwd.
        assert_eq!(from_env(None), None);
        assert_eq!(from_env(os("")), None);
        assert_eq!(from_env(os("home/x")), None);
        assert_eq!(from_env(os(".")), None);
    }

    #[test]
    fn the_running_process_has_a_home_and_it_is_absolute() {
        // Guards the shape of the real read, not a value: every agent
        // dot-directory the app looks in hangs off this.
        let home = home_dir().expect("a test process has HOME set");
        assert!(home.is_absolute(), "{}", home.display());
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
