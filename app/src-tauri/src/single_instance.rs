//! One running app per build on Windows.
//!
//! Every app state gavin has -- the workspace list, the boards, the rails --
//! is shared through the data directory, so a second `Gavin.exe` comes up
//! looking exactly like the first: same workspaces, same pages, same
//! state. And it is not a second view, it is a second app. It runs its own
//! rail scheduler over the same `orchestration.sqlite`, so every step one
//! instance launches the other can launch too; each launch is another
//! agent, and a machine running nested cards with Cursor on Windows grew
//! window after window of these until it went down.
//!
//! macOS never showed it: LaunchServices refuses a second copy of a
//! running bundle on its own. Windows has no such rule -- anything that
//! starts `Gavin.exe` gets a whole new app -- so the rule is here: the
//! first instance holds a named mutex for its whole life, and a later one
//! that finds it taken raises the running window and exits before Tauri
//! builds anything.
//!
//! **Per build, not per identifier.** The dev tree and a release install
//! share `com.gavin.app` but are meant to run side by side (each talks to
//! its own daemon, `protocol::BuildProfile`), which is why this is not
//! `tauri-plugin-single-instance`: it names its lock after the
//! identifier, and the dev app would hand itself to the installed one and
//! quit. The mutex carries the same per-build suffix the daemon's files do.
//!
//! **Each refused launch says who asked.** What starts the extra copies
//! was not visible from the app, so the refused launch appends one line
//! to `second-launch.log` beside the daemon log: when, with what
//! arguments, from which directory, and the chain of processes above it.
//! That chain is the culprit's name the next time it happens.

use std::path::{Path, PathBuf};

/// The mutex this build's first instance holds. `Local\` scopes it to
/// the signed-in session: another user on the same machine runs a gavin
/// of their own, against their own data directory.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn mutex_name(profile: protocol::BuildProfile) -> String {
    format!("Local\\gavin-app{}", profile.suffix())
}

/// Where refused launches are recorded, per build like the daemon log.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn launch_log_path(dir: &Path, profile: protocol::BuildProfile) -> PathBuf {
    dir.join(protocol::profile_file_name("second-launch", "log", profile))
}

/// One process in the chain above a refused launch.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(not(windows), allow(dead_code))]
pub struct Ancestor {
    pub pid: u32,
    pub image: String,
}

/// The line a refused launch appends. One line, so a log that collects
/// hundreds of them still reads one launch per row.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn launch_line(unix_secs: u64, args: &[String], cwd: Option<&Path>, ancestors: &[Ancestor]) -> String {
    let cwd = cwd.map(|c| c.display().to_string()).unwrap_or_else(|| "?".to_string());
    let chain = if ancestors.is_empty() {
        "unknown".to_string()
    } else {
        ancestors.iter().map(|a| format!("{} ({})", a.image, a.pid)).collect::<Vec<_>>().join(" <- ")
    };
    format!("{unix_secs} refused second launch: args {args:?}, cwd {cwd}, started by {chain}")
}

/// Walks `ppid` links up from `pid`, at most `max` steps, over a snapshot
/// of `pid -> (parent pid, image)`. Stops at a pid the snapshot does not
/// hold (the parent already exited, which Windows does not reparent) and
/// at a cycle, which a recycled pid can produce.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn ancestor_chain(
    pid: u32,
    table: &std::collections::HashMap<u32, (u32, String)>,
    max: usize,
) -> Vec<Ancestor> {
    let mut out: Vec<Ancestor> = Vec::new();
    let mut current = pid;
    while out.len() < max {
        let Some((parent, _)) = table.get(&current) else { break };
        let parent = *parent;
        if parent == 0 || parent == pid || out.iter().any(|a| a.pid == parent) {
            break;
        }
        let Some((_, image)) = table.get(&parent) else { break };
        out.push(Ancestor { pid: parent, image: image.clone() });
        current = parent;
    }
    out
}

/// Claims this build's single instance, or hands off to the one already
/// running and exits. Called first thing in `run`, before any window or
/// plugin exists. A no-op off Windows (see the module docs).
#[cfg(not(windows))]
pub fn claim_or_exit() {}

#[cfg(windows)]
pub fn claim_or_exit() {
    if win::claim(&mutex_name(protocol::BuildProfile::current())) {
        return;
    }
    record_refused_launch();
    win::raise_running_window();
    std::process::exit(0);
}

/// Best-effort: a launch that cannot write its line is still refused.
#[cfg(windows)]
fn record_refused_launch() {
    use std::io::Write;
    let Ok(dir) = protocol::app_support_dir() else { return };
    let _ = std::fs::create_dir_all(&dir);
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let args: Vec<String> = std::env::args().collect();
    let cwd = std::env::current_dir().ok();
    let ancestors = ancestor_chain(std::process::id(), &win::process_table(), 6);
    let line = launch_line(secs, &args, cwd.as_deref(), &ancestors);
    let path = launch_log_path(&dir, protocol::BuildProfile::current());
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{line}");
    }
}

#[cfg(windows)]
mod win {
    use std::collections::HashMap;
    use std::path::PathBuf;

    use windows::core::{BOOL, PCWSTR, PWSTR};
    use windows::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, HWND, LPARAM};
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };
    use windows::Win32::System::Threading::{
        CreateMutexW, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowThreadProcessId, IsIconic, IsWindowVisible, SetForegroundWindow, ShowWindow,
        SW_RESTORE,
    };

    /// Creates (or opens) the named mutex and reports whether this process
    /// is the first to hold it. The handle is never closed: the kernel
    /// releases it when the process exits, which is exactly how long the
    /// claim has to last. A mutex that cannot be created at all claims
    /// nothing and refuses nothing -- running twice is the old behaviour,
    /// not running at all would be a new and worse one.
    pub fn claim(name: &str) -> bool {
        let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
        // SAFETY: `wide` is NUL-terminated and outlives the call.
        let created = unsafe { CreateMutexW(None, false, PCWSTR(wide.as_ptr())) };
        // Read before anything else can overwrite the thread's last error:
        // CreateMutexW succeeds on an existing mutex and says so only there.
        // SAFETY: no arguments.
        let existed = unsafe { GetLastError() } == ERROR_ALREADY_EXISTS;
        match created {
            Ok(_handle) => !existed,
            Err(_) => true,
        }
    }

    /// `pid -> (parent pid, executable name)` for every process, from one
    /// snapshot. Empty when the snapshot cannot be taken.
    pub fn process_table() -> HashMap<u32, (u32, String)> {
        let mut table = HashMap::new();
        // SAFETY: no pointer arguments; the handle is closed below.
        let Ok(snapshot) = (unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }) else {
            return table;
        };
        let mut entry = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        // SAFETY: `entry` is live and its dwSize is set, as both calls require.
        unsafe {
            if Process32FirstW(snapshot, &mut entry).is_ok() {
                loop {
                    let len = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(entry.szExeFile.len());
                    let image = String::from_utf16_lossy(&entry.szExeFile[..len]);
                    table.insert(entry.th32ProcessID, (entry.th32ParentProcessID, image));
                    entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
                    if Process32NextW(snapshot, &mut entry).is_err() {
                        break;
                    }
                }
            }
            let _ = CloseHandle(snapshot);
        }
        table
    }

    /// The full image path of `pid`, or `None` when it cannot be opened.
    fn image_path(pid: u32) -> Option<PathBuf> {
        // SAFETY: no pointer arguments; the handle is closed below.
        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.ok()?;
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        // SAFETY: `buf` holds `len` u16s, and the call writes at most that.
        let ok = unsafe { QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len) };
        // SAFETY: closing a handle this function opened, exactly once.
        unsafe {
            let _ = CloseHandle(handle);
        }
        ok.ok()?;
        Some(PathBuf::from(String::from_utf16_lossy(&buf[..len as usize])))
    }

    struct Search {
        own_pid: u32,
        own_image: PathBuf,
        found: Option<HWND>,
    }

    /// Restores and raises a visible top-level window of another process
    /// running this same executable -- the instance that holds the mutex.
    /// A launch the human made (the Start menu, a pinned icon) carries the
    /// foreground right, so `SetForegroundWindow` is allowed to act on it.
    pub fn raise_running_window() {
        let Ok(own_image) = std::env::current_exe() else { return };
        let mut search = Search { own_pid: std::process::id(), own_image, found: None };
        // SAFETY: `search` outlives the enumeration, which is synchronous,
        // and the callback reads it only through the pointer passed here.
        unsafe {
            let _ = EnumWindows(Some(visit), LPARAM(&mut search as *mut Search as isize));
        }
        let Some(hwnd) = search.found else { return };
        // SAFETY: `hwnd` came from the enumeration just above.
        unsafe {
            if IsIconic(hwnd).as_bool() {
                let _ = ShowWindow(hwnd, SW_RESTORE);
            }
            let _ = SetForegroundWindow(hwnd);
        }
    }

    unsafe extern "system" fn visit(hwnd: HWND, lparam: LPARAM) -> BOOL {
        // SAFETY: `lparam` is the `Search` raise_running_window passed in.
        let search = unsafe { &mut *(lparam.0 as *mut Search) };
        // SAFETY: `hwnd` is the window being enumerated.
        if !unsafe { IsWindowVisible(hwnd) }.as_bool() {
            return BOOL(1);
        }
        let mut pid = 0u32;
        // SAFETY: `pid` is a live u32 for the call to write.
        unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
        if pid == 0 || pid == search.own_pid {
            return BOOL(1);
        }
        let same_exe = image_path(pid).is_some_and(|p| {
            p.to_string_lossy().eq_ignore_ascii_case(&search.own_image.to_string_lossy())
        });
        if same_exe {
            search.found = Some(hwnd);
            return BOOL(0);
        }
        BOOL(1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::BuildProfile;
    use std::collections::HashMap;

    /// The dev app and a release install must hold different locks, or
    /// whichever started second would quit into the other.
    #[test]
    fn each_build_holds_its_own_mutex() {
        assert_eq!(mutex_name(BuildProfile::Release), "Local\\gavin-app");
        assert_eq!(mutex_name(BuildProfile::Dev), "Local\\gavin-app-dev");
    }

    #[test]
    fn the_launch_log_is_per_build_beside_the_daemon_log() {
        let dir = Path::new("/data/gavin");
        assert_eq!(launch_log_path(dir, BuildProfile::Release), dir.join("second-launch.log"));
        assert_eq!(launch_log_path(dir, BuildProfile::Dev), dir.join("second-launch-dev.log"));
    }

    fn table(rows: &[(u32, u32, &str)]) -> HashMap<u32, (u32, String)> {
        rows.iter().map(|&(pid, ppid, image)| (pid, (ppid, image.to_string()))).collect()
    }

    #[test]
    fn the_chain_names_every_process_above_the_launch() {
        let t = table(&[
            (40, 30, "Gavin.exe"),
            (30, 20, "node.exe"),
            (20, 10, "sh.exe"),
            (10, 4, "gavin-daemon.exe"),
            (4, 0, "System"),
        ]);
        let chain = ancestor_chain(40, &t, 6);
        let images: Vec<&str> = chain.iter().map(|a| a.image.as_str()).collect();
        assert_eq!(images, ["node.exe", "sh.exe", "gavin-daemon.exe", "System"]);
    }

    #[test]
    fn the_chain_stops_at_an_exited_parent_a_cycle_and_the_cap() {
        // 30's parent is gone: Windows does not reparent, so the pid names nothing.
        let gone = table(&[(40, 30, "Gavin.exe"), (30, 99, "node.exe")]);
        assert_eq!(ancestor_chain(40, &gone, 6), vec![Ancestor { pid: 30, image: "node.exe".into() }]);
        // A recycled pid can point back down the chain.
        let cycle = table(&[(40, 30, "Gavin.exe"), (30, 20, "a.exe"), (20, 30, "b.exe")]);
        assert_eq!(ancestor_chain(40, &cycle, 6).len(), 2);
        let deep = table(&[(5, 4, "e"), (4, 3, "d"), (3, 2, "c"), (2, 1, "b"), (1, 7, "a"), (7, 0, "z")]);
        assert_eq!(ancestor_chain(5, &deep, 2).len(), 2);
        assert!(ancestor_chain(5, &HashMap::new(), 6).is_empty());
    }

    #[test]
    fn a_launch_line_says_who_asked_on_one_line() {
        let line = launch_line(
            1_700_000_000,
            &["C:\\Gavin\\Gavin.exe".to_string()],
            Some(Path::new("C:\\work")),
            &[Ancestor { pid: 30, image: "node.exe".into() }, Ancestor { pid: 20, image: "sh.exe".into() }],
        );
        assert_eq!(
            line,
            "1700000000 refused second launch: args [\"C:\\\\Gavin\\\\Gavin.exe\"], cwd C:\\work, started by node.exe (30) <- sh.exe (20)"
        );
        assert!(!line.contains('\n'));
        assert!(launch_line(0, &[], None, &[]).ends_with("cwd ?, started by unknown"));
    }
}
