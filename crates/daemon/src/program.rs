//! Starting a program from the daemon without opening a window for it.
//!
//! Every subprocess the daemon runs itself -- as opposed to the sessions
//! it hosts under a PTY -- is built here, for one Windows reason.
//!
//! A console program inherits its parent's console, and when the parent
//! has none it allocates one -- and a new console is a window (on a
//! machine where Windows Terminal is the default terminal, a whole
//! terminal window). The app gives the daemon a hidden console of its
//! own when it spawns it (`CREATE_NO_WINDOW` in the app's `daemon.rs`),
//! which is what stopped the packaged app flashing a terminal for every
//! `git` the daemon ran. But that flag lives in the LAUNCHER, and the
//! daemon is designed to be adopted by launchers that did not start it:
//! it outlives the app across upgrades, an installer never stops it, and
//! `MIN_COMPATIBLE_VERSION` lets a new app carry on against a daemon from
//! an older build. A daemon started by hand from a terminal loses its
//! console when that terminal closes. In every one of those states each
//! `git rev-parse` the daemon runs for a new session -- one per rail
//! step -- opened a window, and nothing in this crate could stop it.
//!
//! So the flag goes on the daemon's own spawns as well, where it is
//! independent of who started the daemon and how. `DETACHED_PROCESS` is
//! not the answer: it gives the child NO console, which only moves the
//! same window down to the child's own children.

use std::process::Command;

/// `CREATE_NO_WINDOW`: the child gets a console of its own with no
/// window on it. Valid only for console programs, which every program
/// this daemon runs is.
#[cfg(windows)]
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// A `Command` for a program the daemon runs itself, built so that on
/// Windows it opens no console window whatever console the daemon does
/// or does not own. The way this crate builds one: `spawn_sites_outside`
/// lists any `Command::new` elsewhere, and a test keeps that list empty.
pub fn command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

/// Whether this process is attached to a console at all, for the
/// startup log. `GetConsoleCP` answers 0 (with `ERROR_INVALID_HANDLE`)
/// when there is none. Not consulted for any decision -- `command`
/// spawns the same way either way -- but a daemon log that can say
/// "no console" is what tells a launcher problem apart from anything
/// else on a machine nobody can attach a debugger to.
#[cfg(windows)]
pub fn has_console() -> bool {
    #[link(name = "kernel32")]
    extern "system" {
        fn GetConsoleCP() -> u32;
    }
    unsafe { GetConsoleCP() != 0 }
}

/// Every `Command::new(` in non-test code under `src`, other than in
/// this file, as `path:line: text`. The lint behind the test that keeps
/// it empty, kept apart from the test so its own discrimination can be
/// tested against a fixture rather than trusted.
///
/// Only non-test code counts: each file in this crate keeps its test
/// module at the bottom behind a single `#[cfg(test)]`, and tests spawn
/// `git` freely to build fixtures -- they run on a console, and a flash
/// there is nobody's problem. A commented-out call is not a spawn site.
#[cfg(test)]
pub fn spawn_sites_outside(src: &std::path::Path) -> Vec<String> {
    fn walk(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(&path, out);
            } else if path.extension().is_some_and(|e| e == "rs") {
                out.push(path);
            }
        }
    }
    let mut files = Vec::new();
    walk(src, &mut files);
    files.sort();
    let mut offenders = Vec::new();
    for file in files {
        let rel = file.strip_prefix(src).unwrap_or(&file).to_string_lossy().replace('\\', "/");
        if rel == "program.rs" {
            continue;
        }
        let Ok(source) = std::fs::read_to_string(&file) else { continue };
        let non_test = source.lines().take_while(|line| line.trim() != "#[cfg(test)]");
        for (i, line) in non_test.enumerate() {
            if !line.contains("Command::new(") || line.trim_start().starts_with("//") {
                continue;
            }
            offenders.push(format!("{rel}:{}: {}", i + 1, line.trim()));
        }
    }
    offenders
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    /// The flag word itself, so a typo cannot silently become a
    /// different creation flag. `DETACHED_PROCESS` (0x8) must stay out
    /// of it: the two are not combined by `CreateProcess`, and detached
    /// is the state this module exists to survive, not to create.
    #[cfg(windows)]
    #[test]
    fn the_flag_is_create_no_window_and_not_detached() {
        assert_eq!(CREATE_NO_WINDOW, 0x0800_0000);
        assert_eq!(CREATE_NO_WINDOW & 0x0000_0008, 0);
    }

    /// The bug `command` exists for, observed on a real child.
    ///
    /// `GetConsoleProcessList` names the processes attached to the
    /// CALLER's console. A plainly spawned child appears there -- the
    /// positive control, proving the probe sees children at all -- and
    /// one spawned through `command` must not, because it was given a
    /// console of its own. A runner with no console (the list comes back
    /// empty) cannot tell the two apart and says so rather than passing
    /// vacuously.
    ///
    /// A child joins the console during its own startup, after
    /// `CreateProcess` has returned, so the control is polled for rather
    /// than read once: the first sample after `spawn` can miss it.
    #[cfg(windows)]
    #[test]
    fn a_command_child_does_not_share_this_console() {
        use std::process::Stdio;
        use std::time::{Duration, Instant};

        #[link(name = "kernel32")]
        extern "system" {
            fn GetConsoleProcessList(list: *mut u32, count: u32) -> u32;
        }
        fn our_console() -> Vec<u32> {
            let mut list = vec![0u32; 512];
            let n = unsafe { GetConsoleProcessList(list.as_mut_ptr(), list.len() as u32) } as usize;
            list.truncate(n.min(512));
            list
        }
        if our_console().is_empty() {
            eprintln!("skipped: this test runner has no console to compare against");
            return;
        }

        // `ping` holds for a couple of seconds, long enough to be looked
        // at.
        let hold = ["-n", "3", "127.0.0.1"];
        let mut plain = Command::new("ping").args(hold).stdout(Stdio::null()).spawn().unwrap();
        let mut quiet = command("ping").args(hold).stdout(Stdio::null()).spawn().unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        let mut plain_attached = false;
        let mut quiet_attached = false;
        while Instant::now() < deadline {
            let attached = our_console();
            plain_attached |= attached.contains(&plain.id());
            quiet_attached |= attached.contains(&quiet.id());
            if plain_attached {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        for child in [&mut plain, &mut quiet] {
            let _ = child.kill();
            let _ = child.wait();
        }
        assert!(plain_attached, "the probe: a plain child inherits this console and is listed on it");
        assert!(!quiet_attached, "a `command` child must have a hidden console of its own, not this one");
    }

    /// `has_console` agrees with the probe the test above trusts: a
    /// runner listed on a console has one, and a runner with an empty
    /// list has none.
    #[cfg(windows)]
    #[test]
    fn has_console_agrees_with_the_console_process_list() {
        #[link(name = "kernel32")]
        extern "system" {
            fn GetConsoleProcessList(list: *mut u32, count: u32) -> u32;
        }
        let mut list = vec![0u32; 8];
        let n = unsafe { GetConsoleProcessList(list.as_mut_ptr(), list.len() as u32) };
        assert_eq!(has_console(), n != 0);
    }

    /// The lint tells a spawn site from a test fixture by the
    /// `#[cfg(test)]` line, and leaves this file and comments alone.
    #[test]
    fn the_lint_counts_non_test_code_and_nothing_else() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path();
        std::fs::create_dir_all(src.join("git")).unwrap();
        std::fs::write(
            src.join("git/run.rs"),
            "use std::process::Command;\n\
             fn run() { let _ = Command::new(\"git\"); }\n\
             // let _ = Command::new(\"commented out\");\n\
             #[cfg(test)]\n\
             mod tests { fn fixture() { let _ = Command::new(\"git\"); } }\n",
        )
        .unwrap();
        std::fs::write(
            src.join("clean.rs"),
            "fn run() { let _ = crate::program::command(\"git\"); }\n\
             #[cfg(test)]\n\
             mod tests { fn fixture() { let _ = std::process::Command::new(\"git\"); } }\n",
        )
        .unwrap();
        std::fs::write(src.join("program.rs"), "let mut command = Command::new(program);\n").unwrap();
        assert_eq!(
            spawn_sites_outside(src),
            vec!["git/run.rs:2: fn run() { let _ = Command::new(\"git\"); }".to_string()]
        );
    }

    /// Every program this crate starts goes through `command`, so that no
    /// spawn site can bring the window back. Read off the sources rather
    /// than trusted to review, the way the app crate's twin of this test
    /// is: its first pass routed every site a flat listing showed and
    /// missed one in a subdirectory.
    #[test]
    fn every_spawn_in_this_crate_goes_through_command() {
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let offenders = spawn_sites_outside(&src);
        assert!(
            offenders.is_empty(),
            "spawn sites not going through program::command:\n{}",
            offenders.join("\n")
        );
    }
}
