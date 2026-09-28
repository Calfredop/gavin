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
use std::process::{Command, Stdio};
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
///
/// macOS only, like its one caller. `USER` and `HOME` are the unix
/// spellings -- Windows sets `USERNAME` and `USERPROFILE` and neither of
/// these -- so off macOS this can only ever answer `None`, and gating it
/// says so once here instead of leaving a function that looks portable
/// and is not.
#[cfg(target_os = "macos")]
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
/// found has gone away between the probe and the call.
fn watchman_command(args: &[&str]) -> Option<String> {
    let bin = watchman_binary()?;
    let mut command = crate::program::command(bin);
    command
        .arg("--no-spawn")
        .arg("--no-local")
        .args(args)
        // A GUI app's cwd is whatever it was launched with, and
        // watchman resolves a relative root against it. Everything this
        // module passes is absolute; the temp dir makes that explicit.
        .current_dir(std::env::temp_dir());
    stdout_by_deadline(command, Duration::from_secs(WATCHMAN_TIMEOUT_SECS as u64))
}

/// A command's stdout once it exits successfully; `None` when it cannot
/// start, exits non-zero, or is still running at `timeout`, and is then
/// killed.
///
/// There is no `timeout(1)` on macOS, so the deadline is enforced here.
/// stdout is drained on a thread, the same deadlock avoidance
/// `agent_models::run` documents: a child that fills the pipe buffer
/// blocks forever if the parent waits before reading. And the drain IS
/// the wait. The pipe reaches end-of-file when the child exits, so the
/// answer arrives the moment it does, where a `try_wait` loop learned of
/// it on its next 50 ms turn: `watch-list` measured 217 ms median that
/// way and 186 ms this one, against the same server.
/// The `wait` after it only reaps: the watchman CLI holds its stdout until
/// it exits, and under `--no-spawn` starts nothing that could inherit it.
fn stdout_by_deadline(mut command: Command, timeout: Duration) -> Option<String> {
    let mut child = command
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
        let _ = tx.send(buf);
    });
    let Ok(stdout) = rx.recv_timeout(timeout) else {
        let _ = child.kill();
        let _ = child.wait();
        return None;
    };
    child
        .wait()
        .ok()?
        .success()
        .then(|| String::from_utf8_lossy(&stdout).into_owned())
}

/// The live watchman server, or `None` when there is not one.
///
/// Called on the same timer as `system_memory`. The pid probe is two
/// syscalls; the CLI call only happens once that probe has said there is
/// something to ask.
///
/// `async` + `spawn_blocking`: that CLI call is 170-200 ms, and the
/// whole deadline when watchman is wedged. As a plain `fn` it ran on the
/// main thread every 30 s per window -- 0.2-1.2 s of frozen window a
/// minute, measured. A pool that could not run the read has nothing to
/// report, the same `None` as every other failure here.
#[tauri::command]
pub async fn watchman_status() -> Option<WatchmanStatus> {
    tauri::async_runtime::spawn_blocking(read_watchman).await.ok().flatten()
}

fn read_watchman() -> Option<WatchmanStatus> {
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
///
/// `async` + `spawn_blocking` for the same reason as `watchman_status`:
/// Drop roots calls it once per root, one after another, and each is a
/// CLI round trip the main thread used to sit through.
#[tauri::command]
pub async fn watchman_forget(root: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || forget_root(&root))
        .await
        .map_err(|e| format!("the watchman drop did not run: {e}"))
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

// ---- Gavin itself -----------------------------------------------------------

/// What Gavin is holding on its own, before anything runs in a session.
///
/// The task manager's rows are the daemon's sessions, and on a busy
/// machine they are nearly all of it -- which is exactly why this has to
/// be stated separately: "Gavin is using 20 GB" was 17 GB of session
/// trees, and nothing on screen could say how much of the rest was the
/// app.
///
/// Physical footprint, not resident size: the figure Activity Monitor's
/// Memory column shows, and the one that counts compressed pages. The
/// difference is not a rounding error here -- the webview measured
/// 181 MB resident against a 1000 MB footprint -- so resident size would
/// understate the one part of Gavin that is big.
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GavinMemory {
    /// This process: the Tauri host.
    pub app_bytes: u64,
    /// The WebKit helpers drawing this app's windows -- web content, GPU,
    /// networking. `None` when this macOS will not say which helpers are
    /// whose, which is "not measured", never "none running".
    pub interface_bytes: Option<u64>,
    pub interface_processes: u32,
    /// The local daemon's own process, without the sessions it hosts --
    /// those are the rows. `None` when no connection names a live
    /// gavin-daemon.
    pub daemon_bytes: Option<u64>,
    pub sampled_at_ms: i64,
}

/// Gavin's own memory, or `None` off macOS.
///
/// `async` + `spawn_blocking`: the helper lookup walks the process table,
/// and a plain command would do that on the thread that draws the window.
#[tauri::command]
pub async fn gavin_memory(app: tauri::AppHandle) -> Option<GavinMemory> {
    tauri::async_runtime::spawn_blocking(move || measure_gavin(std::process::id(), daemon_pid(&app)))
        .await
        .ok()
        .flatten()
}

/// The pid serving the app's command connection, read off the
/// connection itself -- the kernel's `server_pid`, the same answer
/// Restart daemon aims its fallback with, so this names the daemon THIS
/// app is talking to (the dev and release daemons run side by side)
/// without dialling it again. The lane records it whenever it is put on
/// a connection, since its worker thread owns the stream.
fn daemon_pid(app: &tauri::AppHandle) -> Option<u32> {
    use tauri::Manager;
    app.try_state::<crate::session::CommandConnection>()?.server_pid()
}

/// A WebKit helper process, by the name macOS gives every one of them:
/// `com.apple.WebKit.WebContent`, `.GPU`, `.Networking`.
fn is_webkit_helper(name: &str) -> bool {
    name.starts_with("com.apple.WebKit.")
}

/// A pid the connection named is only measured as the daemon while it
/// still IS one: a pid read at connect time can outlive the process it
/// named, and a figure for whatever inherited it would be the wrong
/// process under the daemon's name.
fn is_daemon_name(name: &str) -> bool {
    name == "gavin-daemon"
}

#[cfg(target_os = "macos")]
fn measure_gavin(own: u32, daemon: Option<u32>) -> Option<GavinMemory> {
    let app_bytes = footprint(own)?;
    let helpers = interface_pids(own);
    let (interface_bytes, interface_processes) = match &helpers {
        Some(pids) => {
            let sizes: Vec<u64> = pids.iter().filter_map(|&pid| footprint(pid)).collect();
            (Some(sizes.iter().sum()), sizes.len() as u32)
        }
        None => (None, 0),
    };
    let daemon_bytes = daemon
        .filter(|&pid| pid != own && process_name(pid).is_some_and(|n| is_daemon_name(&n)))
        .and_then(footprint);
    Some(GavinMemory {
        app_bytes,
        interface_bytes,
        interface_processes,
        daemon_bytes,
        sampled_at_ms: now_ms(),
    })
}

/// Off macOS there is no footprint to read and no helper to find; the
/// line is simply not drawn, the same answer `system_memory` gives.
#[cfg(not(target_os = "macos"))]
fn measure_gavin(_own: u32, _daemon: Option<u32>) -> Option<GavinMemory> {
    None
}

/// One process's physical footprint -- `ri_phys_footprint`, what
/// `footprint(1)` and Activity Monitor report.
#[cfg(target_os = "macos")]
fn footprint(pid: u32) -> Option<u64> {
    let mut info: libc::rusage_info_v2 = unsafe { std::mem::zeroed() };
    // SAFETY: `info` is a live, correctly-aligned `rusage_info_v2`, and
    // RUSAGE_INFO_V2 is the flavour that tells the kernel to write
    // exactly that struct.
    let rc = unsafe {
        libc::proc_pid_rusage(
            pid as i32,
            libc::RUSAGE_INFO_V2,
            &mut info as *mut libc::rusage_info_v2 as *mut libc::rusage_info_t,
        )
    };
    (rc == 0).then_some(info.ri_phys_footprint)
}

/// A process's name as `proc_name` gives it -- the long form, so
/// `com.apple.WebKit.WebContent` arrives whole rather than cut at
/// sixteen characters.
#[cfg(target_os = "macos")]
fn process_name(pid: u32) -> Option<String> {
    let mut buf = [0u8; 256];
    // SAFETY: the buffer is 256 live bytes and the size argument is its
    // length, so the kernel cannot write past it.
    let len = unsafe { libc::proc_name(pid as i32, buf.as_mut_ptr() as *mut libc::c_void, buf.len() as u32) };
    if len <= 0 {
        return None;
    }
    Some(String::from_utf8_lossy(&buf[..(len as usize).min(buf.len())]).into_owned())
}

/// When a process started, to the microsecond.
#[cfg(target_os = "macos")]
fn start_time(pid: u32) -> Option<(u64, u64)> {
    const SIZE: i32 = std::mem::size_of::<libc::proc_bsdinfo>() as i32;
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    // SAFETY: `info` is a live, correctly-sized `proc_bsdinfo` and SIZE
    // is its own size.
    let written = unsafe {
        libc::proc_pidinfo(
            pid as i32,
            libc::PROC_PIDTBSDINFO,
            0,
            &mut info as *mut libc::proc_bsdinfo as *mut libc::c_void,
            SIZE,
        )
    };
    (written == SIZE).then_some((info.pbi_start_tvsec, info.pbi_start_tvusec))
}

/// Every pid on the machine. `proc_listallpids` answers a COUNT, and the
/// table can grow between sizing the buffer and filling it, so the
/// buffer carries headroom and the answer is trusted only up to its
/// length.
#[cfg(target_os = "macos")]
fn all_pids() -> Vec<u32> {
    // SAFETY: a null buffer of size zero asks only for the count.
    let count = unsafe { libc::proc_listallpids(std::ptr::null_mut(), 0) };
    if count <= 0 {
        return Vec::new();
    }
    let mut buf = vec![0i32; count as usize + 64];
    // SAFETY: the buffer is `buf.len()` live i32s and the size argument
    // is its length in bytes.
    let filled = unsafe {
        libc::proc_listallpids(
            buf.as_mut_ptr() as *mut libc::c_void,
            (buf.len() * std::mem::size_of::<i32>()) as libc::c_int,
        )
    };
    if filled <= 0 {
        return Vec::new();
    }
    buf.truncate((filled as usize).min(buf.len()));
    buf.into_iter().filter(|p| *p > 0).map(|p| p as u32).collect()
}

/// The process macOS holds responsible for `pid`, or `None` when the
/// lookup is not there.
///
/// `responsibility_get_pid_responsible_for_pid` is libSystem's, and
/// private -- Activity Monitor uses it to put an app's helpers under the
/// app. Resolved with `dlsym` rather than linked: a macOS that drops it
/// then costs the interface figure, where a linked symbol would cost the
/// app its launch.
#[cfg(target_os = "macos")]
fn responsible_pid(pid: u32) -> Option<u32> {
    use std::sync::OnceLock;
    type Lookup = unsafe extern "C" fn(libc::pid_t) -> libc::pid_t;
    static LOOKUP: OnceLock<Option<Lookup>> = OnceLock::new();
    let lookup = (*LOOKUP.get_or_init(|| {
        // SAFETY: RTLD_DEFAULT searches the images already loaded, and the
        // name is a NUL-terminated literal.
        let sym = unsafe { libc::dlsym(libc::RTLD_DEFAULT, c"responsibility_get_pid_responsible_for_pid".as_ptr()) };
        // SAFETY: the symbol is libSystem's `pid_t f(pid_t)`, the only
        // shape it has ever had.
        (!sym.is_null()).then(|| unsafe { std::mem::transmute::<*mut libc::c_void, Lookup>(sym) })
    }))?;
    // SAFETY: a plain call on a pid; an unknown pid answers -1.
    let responsible = unsafe { lookup(pid as libc::pid_t) };
    (responsible > 0).then_some(responsible as u32)
}

/// The WebKit helpers drawing this app's windows.
///
/// They are not our children: launchd starts them as XPC services, so
/// the tree walk the rows use can never reach them. What ties them to
/// the app is RESPONSIBILITY -- they answer to the same process the app
/// does (itself, when launched from the Dock; the terminal, for a dev
/// build started from one). Another app's helpers answer to that app,
/// which is what keeps Fork's or Safari's out.
///
/// Started no earlier than the app, for the one case responsibility
/// cannot split: a dev build shares its terminal with anything else
/// launched from there, and a helper older than this process cannot be
/// one of its own. A second WebKit app started later from the same
/// terminal would still be counted -- a dev-build-only overcount.
///
/// `None` when the responsibility lookup is unavailable, so the line can
/// say "not measured" instead of an interface of zero.
#[cfg(target_os = "macos")]
fn interface_pids(own: u32) -> Option<Vec<u32>> {
    let answers_to = responsible_pid(own)?;
    let born = start_time(own)?;
    Some(
        all_pids()
            .into_iter()
            .filter(|&pid| pid != own)
            .filter(|&pid| process_name(pid).is_some_and(|n| is_webkit_helper(&n)))
            .filter(|&pid| responsible_pid(pid) == Some(answers_to))
            .filter(|&pid| start_time(pid).is_some_and(|t| t >= born))
            .collect(),
    )
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
    ///
    /// Gated with the function it exercises: `USER`/`HOME` are unix
    /// variables and the asserted `-state/pid` is a forward slash
    /// `PathBuf::join` never produces on Windows, so this describes a
    /// macOS path and nothing else.
    #[cfg(target_os = "macos")]
    #[test]
    fn pid_file_sits_under_the_user_state_directory() {
        let path = watchman_pid_file().expect("USER and HOME are set in a test run");
        let text = path.to_string_lossy();
        assert!(text.ends_with("-state/pid"), "unexpected pidfile path: {text}");
        assert!(text.contains("/watchman/"), "unexpected pidfile path: {text}");
    }

    /// The drain is the wait, so it must still bring back all of a
    /// child's stdout -- past a pipe buffer too, where waiting on the
    /// exit before reading would deadlock.
    #[cfg(unix)]
    #[test]
    fn stdout_by_deadline_returns_everything_the_child_wrote() {
        let mut sh = crate::program::command("/bin/sh");
        sh.args(["-c", "head -c 200000 /dev/zero | tr '\\0' x"]);
        let out = stdout_by_deadline(sh, Duration::from_secs(10)).expect("sh exits 0");
        assert_eq!(out.len(), 200_000);
    }

    /// A non-zero exit is no answer, whatever the child printed first.
    #[cfg(unix)]
    #[test]
    fn stdout_by_deadline_refuses_a_failed_exit() {
        let mut sh = crate::program::command("/bin/sh");
        sh.args(["-c", "echo partial; exit 3"]);
        assert_eq!(stdout_by_deadline(sh, Duration::from_secs(10)), None);
    }

    /// A child still running at the deadline answers `None` AT the
    /// deadline, not when it would have finished: a wedged watchman is
    /// the case where the poll must not wedge with it.
    #[cfg(unix)]
    #[test]
    fn stdout_by_deadline_kills_a_child_that_overruns() {
        let started = std::time::Instant::now();
        let mut sleep = crate::program::command("/bin/sleep");
        sleep.arg("30");
        assert_eq!(stdout_by_deadline(sleep, Duration::from_millis(200)), None);
        assert!(started.elapsed() < Duration::from_secs(5), "waited {:?}", started.elapsed());
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

    #[test]
    fn recognises_the_webkit_helpers_by_name() {
        assert!(is_webkit_helper("com.apple.WebKit.WebContent"));
        assert!(is_webkit_helper("com.apple.WebKit.GPU"));
        assert!(is_webkit_helper("com.apple.WebKit.Networking"));
        assert!(!is_webkit_helper("Gavin"));
        assert!(!is_webkit_helper("com.apple.WebKitten"));
    }

    #[test]
    fn only_a_gavin_daemon_is_measured_as_the_daemon() {
        assert!(is_daemon_name("gavin-daemon"));
        assert!(!is_daemon_name("gavin-mcp"));
        assert!(!is_daemon_name("zsh"));
    }

    /// The live read: this process has a footprint, and the kernel hands
    /// it over without privileges -- which a probe that silently answered
    /// `None` on its own platform would never show.
    #[cfg(target_os = "macos")]
    #[test]
    fn measures_its_own_footprint() {
        let m = measure_gavin(std::process::id(), None).expect("a Mac measures its own process");
        assert!(m.app_bytes > 0);
        assert_eq!(m.daemon_bytes, None);
        assert!(m.sampled_at_ms > 0);
    }

    /// A pid the connection named is measured as the daemon only while
    /// it still is one. This test binary is not, so it is refused.
    #[cfg(target_os = "macos")]
    #[test]
    fn refuses_a_pid_that_is_not_a_daemon() {
        let own = std::process::id();
        let parent = std::os::unix::process::parent_id();
        assert_eq!(measure_gavin(own, Some(parent)).and_then(|m| m.daemon_bytes), None);
        assert_eq!(measure_gavin(own, Some(own)).and_then(|m| m.daemon_bytes), None);
    }

    /// A test binary draws nothing, so it owns no WebKit helper. The
    /// responsibility lookup must still be THERE -- `None` would mean the
    /// interface figure is unmeasurable on this macOS -- and any WebKit
    /// app launched from the same terminal before this test is kept out
    /// by the start-time rule.
    #[cfg(target_os = "macos")]
    #[test]
    fn a_process_without_a_window_owns_no_webkit_helper() {
        assert_eq!(interface_pids(std::process::id()), Some(Vec::new()));
    }
}
