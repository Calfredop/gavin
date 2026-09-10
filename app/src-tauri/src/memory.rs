//! What the MACHINE is costing, as opposed to what one session is.
//!
//! `crates/daemon/src/proc.rs` already answers "what does this session's
//! process tree occupy" -- that is the per-row figure the task manager
//! draws. This module answers the question nothing in gavin could ask
//! before: how much memory the machine has left, and how much of it is
//! being held by something gavin did not launch.
//!
//! It exists because eleven rails at once put 50 GB on a 32 GB Mac and
//! the machine reset under the thrash. Gavin's own per-session cost is
//! small; the weight was eleven agent process trees, each with its MCP
//! servers, its builds and its test runs -- plus a watchman server
//! holding a root per checkout, including checkouts gavin had already
//! deleted.
//!
//! Three rules shape everything below.
//!
//! **Raw values cross the wire, not judgements.** `pressure_level` is
//! the kernel's own 1/2/4, not the words normal/warn/critical. The
//! interpretation lives in `memory.ts` beside every other sentence the
//! gate speaks, so there is exactly one place that decides what "warn"
//! means and it is the one with the tests.
//!
//! **Never start a watchman server.** Every watchman subcommand starts
//! one if none is running -- including `watch-list`, which reads. So the
//! pid is established FIRST, by reading the state directory's pidfile
//! and probing that process, and the CLI is only ever invoked once a
//! server is known to be alive. A probe that spawned the thing it is
//! measuring would be the memory bug it exists to find.
//!
//! **Everything fails toward "nothing to say".** A sysctl that errors, a
//! pidfile that is not there, a CLI that times out: all of them produce
//! an absent figure rather than a zero. A measured zero and an
//! unmeasured one look identical on screen and only one of them is a
//! reason to hold a launch.

use std::io::Read;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// How long the watchman CLI may take before the probe gives up. It is
/// polled on a timer beside a UI that has to stay responsive, and a
/// watchman that is wedged is exactly the case where the poll must not
/// wedge with it.
const WATCHMAN_TIMEOUT_SECS: u32 = 5;

/// One reading of the machine's memory.
///
/// `supported: false` is the whole of the non-macOS answer: every figure
/// below is then a zero nobody measured, and `memory.ts` turns that into
/// "pressure normal, estimate unavailable" rather than into "0 bytes
/// free", which would hold every launch on a platform gavin cannot
/// measure at all.
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemMemory {
    pub supported: bool,
    /// `hw.memsize` -- what the machine physically has.
    pub total_bytes: u64,
    /// `kern.memorystatus_level`, the kernel's own percentage of memory
    /// it considers free. Not derived from page counts: the kernel's
    /// figure already accounts for what it is prepared to reclaim, and a
    /// count of free pages on a Mac reads near zero at all times.
    pub free_percent: f64,
    /// `kern.memorystatus_vm_pressure_level`, raw: 1 normal, 2 warn, 4
    /// critical. Zero means the sysctl did not answer, which is not the
    /// same as normal and is why this is not a bool.
    pub pressure_level: i32,
    /// `vm.swapusage`'s used figure. Swap is the half of the reboot this
    /// module exists for -- 50 GB on a 32 GB machine was RAM plus swap,
    /// and the free percentage alone never showed it coming.
    pub swap_used_bytes: u64,
    /// Epoch milliseconds when this sample was taken, so a stale reading
    /// can be recognised as one rather than trusted as current.
    pub sampled_at_ms: i64,
}

impl SystemMemory {
    /// The answer for a platform with no probe: nothing measured, and
    /// said so. Only the non-macOS build calls it outside the tests, so
    /// macOS compiles it as dead code rather than losing the test that
    /// pins its shape.
    #[allow(dead_code)]
    fn unsupported() -> Self {
        Self {
            supported: false,
            total_bytes: 0,
            free_percent: 0.0,
            pressure_level: 0,
            swap_used_bytes: 0,
            sampled_at_ms: now_ms(),
        }
    }
}

/// A live watchman server and what it is holding.
///
/// `None` from `watchman_status` means there is no server, which is the
/// ordinary case on a machine that never installed one -- and is
/// deliberately not the same as a server holding zero roots.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchmanStatus {
    pub pid: u32,
    /// The server's whole process tree, the same walk a session's figure
    /// comes from -- watchman forks per-root workers, and the parent
    /// alone understates what it costs.
    pub rss_bytes: u64,
    /// `watchman watch-list`'s raw stdout, parsed by `memory.ts`. Empty
    /// when the CLI could not be run or did not answer.
    pub roots_json: String,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ---- sysctl -----------------------------------------------------------------

/// One `sysctlbyname` read into a value of exactly its own size.
///
/// Generic over the destination rather than typed per call because the
/// three shapes wanted here (u64, i32, `xsw_usage`) differ only in size,
/// and insisting the kernel wrote the FULL struct is what makes a short
/// answer a `None` instead of a half-filled value that reads as data.
#[cfg(target_os = "macos")]
fn sysctl<T: Copy>(name: &str) -> Option<T> {
    let cname = std::ffi::CString::new(name).ok()?;
    let mut value: T = unsafe { std::mem::zeroed() };
    let mut size = std::mem::size_of::<T>();
    // SAFETY: `value` is a live, correctly-aligned T and `size` is its
    // own size, so the kernel cannot write past it. The name is a
    // NUL-terminated C string that outlives the call.
    let rc = unsafe {
        libc::sysctlbyname(
            cname.as_ptr(),
            &mut value as *mut T as *mut libc::c_void,
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    if rc != 0 || size != std::mem::size_of::<T>() {
        return None;
    }
    Some(value)
}

/// `vm.swapusage`'s layout, as `<sys/sysctl.h>` declares it. Declared
/// here rather than taken from libc because the crate does not expose
/// `xsw_usage`, and the two fields this reads (total and used) have been
/// at the front of it since the struct existed.
#[cfg(target_os = "macos")]
#[repr(C)]
#[derive(Clone, Copy)]
struct XswUsage {
    #[allow(dead_code)]
    xsu_total: u64,
    #[allow(dead_code)]
    xsu_avail: u64,
    xsu_used: u64,
    #[allow(dead_code)]
    xsu_pagesize: u32,
    /// `boolean_t`, which is an `int` on macOS -- four bytes, not one.
    /// Getting that wrong shortens the struct, `sysctl` refuses the
    /// short read, and swap reads as zero for ever; the size test below
    /// is what catches it.
    #[allow(dead_code)]
    xsu_encrypted: u32,
}

/// This machine's memory, now.
#[tauri::command]
#[cfg(target_os = "macos")]
pub fn system_memory() -> SystemMemory {
    let total = sysctl::<u64>("hw.memsize").unwrap_or(0);
    // The level is an int percentage. Absent (a kernel that does not
    // publish it) reads as 0 free rather than as a fabricated number,
    // and `memory.ts` only spends it when `supported` and `total` are
    // both real.
    let free_percent = sysctl::<i32>("kern.memorystatus_level").unwrap_or(0) as f64;
    let pressure_level = sysctl::<i32>("kern.memorystatus_vm_pressure_level").unwrap_or(0);
    let swap_used_bytes = sysctl::<XswUsage>("vm.swapusage").map(|s| s.xsu_used).unwrap_or(0);
    SystemMemory {
        // `hw.memsize` is the one figure with no honest fallback: a
        // machine reporting no memory at all is a failed probe, not a
        // measurement, and every sentence downstream divides by it.
        supported: total > 0,
        total_bytes: total,
        free_percent,
        pressure_level,
        swap_used_bytes,
        sampled_at_ms: now_ms(),
    }
}

#[tauri::command]
#[cfg(not(target_os = "macos"))]
pub fn system_memory() -> SystemMemory {
    SystemMemory::unsupported()
}

// ---- watchman ---------------------------------------------------------------

/// Where watchman parks its pidfile for this user.
///
/// `$XDG_STATE_HOME` when it is set (watchman honours it), else
/// `~/.local/state`. The `<user>-state` directory name is watchman's own
/// convention and the reason this cannot simply glob for a file called
/// `pid`.
fn watchman_pid_file() -> Option<PathBuf> {
    let user = std::env::var("USER").ok().filter(|u| !u.is_empty())?;
    let state = match std::env::var("XDG_STATE_HOME") {
        Ok(dir) if !dir.is_empty() => PathBuf::from(dir),
        _ => PathBuf::from(std::env::var("HOME").ok()?).join(".local").join("state"),
    };
    Some(state.join("watchman").join(format!("{user}-state")).join("pid"))
}

/// The pid a watchman pidfile names.
///
/// Split out from the file read so the parse is testable without a
/// watchman on the machine: the contents are a decimal pid, sometimes
/// with a trailing newline, and a file that holds anything else is a
/// file this must decline rather than guess at.
fn parse_pid(contents: &str) -> Option<u32> {
    let pid: u32 = contents.trim().parse().ok()?;
    // Zero is not a pid, and `kill(0, ...)` means "every process in my
    // group" -- a number this module must never hand onward.
    (pid > 0).then_some(pid)
}

/// A live watchman server's pid, or `None`.
///
/// The pidfile first, because it costs one read and is where watchman
/// itself looks. `pgrep` second, for a server started by tooling that
/// pointed its state directory somewhere else -- it lists processes and
/// starts nothing, which is the property that matters here.
#[cfg(target_os = "macos")]
fn watchman_pid() -> Option<u32> {
    if let Some(pid) = watchman_pid_file()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|c| parse_pid(&c))
    {
        if process_rss(pid).is_some() {
            return Some(pid);
        }
    }
    let out = crate::program::command("/usr/bin/pgrep").arg("-x").arg("watchman").output().ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8_lossy(&out.stdout).lines().find_map(|l| parse_pid(l))
}

#[cfg(not(target_os = "macos"))]
fn watchman_pid() -> Option<u32> {
    None
}

/// One process's resident bytes, or `None` when there is no such
/// process. The same `proc_pidinfo` read `crates/daemon/src/proc.rs`
/// makes, kept here rather than imported because the Tauri host does not
/// depend on the daemon crate.
#[cfg(target_os = "macos")]
fn process_rss(pid: u32) -> Option<u64> {
    const SIZE: u32 = std::mem::size_of::<libc::proc_taskinfo>() as u32;
    let mut info: libc::proc_taskinfo = unsafe { std::mem::zeroed() };
    // SAFETY: `info` is a live, correctly-sized, correctly-aligned
    // `proc_taskinfo` and SIZE is its own size, so the kernel writes at
    // most that many bytes into it.
    let written = unsafe {
        libc::proc_pidinfo(
            pid as i32,
            libc::PROC_PIDTASKINFO,
            0,
            &mut info as *mut libc::proc_taskinfo as *mut libc::c_void,
            SIZE as i32,
        )
    };
    (written == SIZE as i32).then_some(info.pti_resident_size)
}

/// The pids one process started. Bounded by the caller; watchman's own
/// fan-out is one worker per root, so this never walks deep.
#[cfg(target_os = "macos")]
fn child_pids(pid: u32) -> Vec<u32> {
    let mut buf = vec![0i32; 256];
    // SAFETY: the buffer is 256 live i32s and the size argument is its
    // length in BYTES, so the kernel cannot write past it.
    let count = unsafe {
        libc::proc_listchildpids(
            pid as i32,
            buf.as_mut_ptr() as *mut libc::c_void,
            (buf.len() * std::mem::size_of::<i32>()) as libc::c_int,
        )
    };
    // proc_listchildpids returns a COUNT of pids, not a byte length --
    // the same trap proc.rs documents. Zero covers both "no children"
    // and "the call failed", and an empty list is right for both.
    if count <= 0 {
        return Vec::new();
    }
    buf.truncate((count as usize).min(buf.len()));
    buf.into_iter().filter(|p| *p > 0).map(|p| p as u32).collect()
}

/// Watchman's whole tree, in bytes. One level of children is enough:
/// watchman forks workers directly off the server and they fork nothing.
#[cfg(target_os = "macos")]
fn watchman_rss(pid: u32) -> u64 {
    let mut total = process_rss(pid).unwrap_or(0);
    for child in child_pids(pid) {
        total = total.saturating_add(process_rss(child).unwrap_or(0));
    }
    total
}

/// Where watchman lands when it is not on a GUI app's PATH.
///
/// A Tauri process inherits launchd's PATH (`/usr/bin:/bin:/usr/sbin:
/// /sbin`), and watchman installs to Homebrew's prefix on both
/// architectures. The same fallback list `agent_models::opencode_binary`
/// keeps, for the same reason: a probe that reported "no watchman"
/// because it could not find the binary would be indistinguishable from
/// one reporting the truth.
const WATCHMAN_FALLBACKS: [&str; 2] = ["/opt/homebrew/bin/watchman", "/usr/local/bin/watchman"];

fn watchman_binary() -> Option<String> {
    if let Some(path) = std::env::var_os("PATH") {
        if std::env::split_paths(&path).any(|dir| dir.join("watchman").is_file()) {
            return Some("watchman".to_string());
        }
    }
    WATCHMAN_FALLBACKS
        .iter()
        .find(|c| std::path::Path::new(c).is_file())
        .map(|c| (*c).to_string())
}

/// Runs one watchman subcommand, to a deadline, and only ever when a
/// server is already known to be alive.
///
/// `--no-spawn --no-local` is belt and braces on top of that: it tells
/// the client to fail rather than start a server if the one this module
/// found has gone away between the probe and the call. There is no
/// `timeout(1)` on macOS, so the deadline is enforced here -- and stdout
/// is drained on a thread, the same deadlock avoidance
/// `agent_models::run` documents: a child that fills the pipe buffer
/// blocks forever if the parent waits before reading.
fn watchman_command(args: &[&str]) -> Option<String> {
    let bin = watchman_binary()?;
    let mut child = crate::program::command(bin)
        .arg("--no-spawn")
        .arg("--no-local")
        .args(args)
        // A GUI app's cwd is whatever it was launched with, and
        // watchman resolves a relative root against it. Everything this
        // module passes is absolute; the temp dir makes that explicit.
        .current_dir(std::env::temp_dir())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut pipe = child.stdout.take()?;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = pipe.read_to_end(&mut buf);
        let _ = tx.send(String::from_utf8_lossy(&buf).into_owned());
    });
    let deadline = std::time::Instant::now() + Duration::from_secs(WATCHMAN_TIMEOUT_SECS as u64);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    return None;
                }
                break;
            }
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(_) => return None,
        }
    }
    rx.recv_timeout(Duration::from_secs(2)).ok()
}

/// The live watchman server, or `None` when there is not one.
///
/// Called on the same timer as `system_memory`. The pid probe is two
/// syscalls; the CLI call only happens once that probe has said there is
/// something to ask.
#[tauri::command]
pub fn watchman_status() -> Option<WatchmanStatus> {
    let pid = watchman_pid()?;
    #[cfg(target_os = "macos")]
    let rss_bytes = watchman_rss(pid);
    #[cfg(not(target_os = "macos"))]
    let rss_bytes = 0;
    Some(WatchmanStatus {
        pid,
        rss_bytes,
        roots_json: watchman_command(&["watch-list"]).unwrap_or_default(),
    })
}

/// Tells a live watchman to stop watching a root.
///
/// The reason this is a command at all: watchman keeps a deleted root's
/// whole tree in memory for five days unless it is told to drop it, so a
/// worktree gavin removes goes on costing memory long after the
/// directory is gone. Called from `git::worktree_remove` and from the
/// sessions manager's "Drop roots".
///
/// A machine with no server is a silent success: there is nothing
/// holding the root, which is the state the caller wanted.
#[tauri::command]
pub fn watchman_forget(root: String) -> Result<(), String> {
    if watchman_pid().is_none() {
        return Ok(());
    }
    forget_root(&root);
    Ok(())
}

/// The same drop, for callers inside Rust that must not fail because of
/// it -- `worktree_remove` has already removed the worktree by the time
/// it gets here, and a watchman that will not answer is not a reason to
/// report the removal as failed.
pub fn forget_root(root: &str) {
    if watchman_pid().is_none() {
        return;
    }
    // `--` so a root path that begins with a dash is a path and not a
    // flag, the same end-of-options discipline the git helpers follow.
    let _ = watchman_command(&["watch-del", "--", root]);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_plain_pid() {
        assert_eq!(parse_pid("4172"), Some(4172));
    }

    /// Watchman writes the file with a trailing newline.
    #[test]
    fn parses_a_pid_with_a_newline() {
        assert_eq!(parse_pid("4172\n"), Some(4172));
    }

    /// A file holding anything else is declined rather than guessed at:
    /// the consequence of a wrong pid here is attributing a stranger's
    /// memory to watchman and offering to drop its roots.
    #[test]
    fn refuses_a_pid_file_that_is_not_a_pid() {
        assert_eq!(parse_pid(""), None);
        assert_eq!(parse_pid("not-a-pid"), None);
        assert_eq!(parse_pid("12 34"), None);
    }

    /// Zero is not a process, and it is the argument that makes `kill`
    /// mean "my whole process group".
    #[test]
    fn refuses_pid_zero() {
        assert_eq!(parse_pid("0"), None);
    }

    /// The pidfile lives under the state directory, in watchman's own
    /// `<user>-state` folder -- the reason this cannot just look for a
    /// file called `pid`.
    #[test]
    fn pid_file_sits_under_the_user_state_directory() {
        let path = watchman_pid_file().expect("USER and HOME are set in a test run");
        let text = path.to_string_lossy();
        assert!(text.ends_with("-state/pid"), "unexpected pidfile path: {text}");
        assert!(text.contains("/watchman/"), "unexpected pidfile path: {text}");
    }

    /// The unsupported answer must be recognisable AS unsupported rather
    /// than as a machine with no memory: every sentence downstream keys
    /// off the flag, not off the zeroes.
    #[test]
    fn unsupported_is_flagged_not_zeroed_into_data() {
        let m = SystemMemory::unsupported();
        assert!(!m.supported);
        assert_eq!(m.pressure_level, 0);
    }

    /// The one test that talks to the kernel: on a Mac these four
    /// sysctls exist, and a probe that silently returned `unsupported`
    /// on the platform it was written for would pass every other test
    /// here.
    #[cfg(target_os = "macos")]
    #[test]
    fn system_memory_reads_a_real_sample() {
        let m = system_memory();
        assert!(m.supported, "hw.memsize should answer on macOS");
        assert!(m.total_bytes > (1u64 << 30), "a Mac has more than a gigabyte");
        assert!(m.free_percent >= 0.0 && m.free_percent <= 100.0);
        // 1, 2 or 4 -- never 0, which is this module's word for "the
        // sysctl did not answer".
        assert!(
            matches!(m.pressure_level, 1 | 2 | 4),
            "unexpected pressure level {}",
            m.pressure_level
        );
        assert!(m.sampled_at_ms > 0);
    }

    /// The swap struct is declared here rather than imported, so its
    /// size is the one thing that can silently go wrong: a mismatch
    /// makes `sysctl` refuse the read and swap read as zero forever.
    #[cfg(target_os = "macos")]
    #[test]
    fn swap_usage_struct_matches_the_kernel() {
        assert!(
            sysctl::<XswUsage>("vm.swapusage").is_some(),
            "vm.swapusage refused the read -- XswUsage's size no longer matches"
        );
    }
}
