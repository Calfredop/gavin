//! Asking the OS whether a process gavin once launched is still there.
//!
//! Recovery's epoch (`SessionRecord::generation`) can prove a row came
//! from a daemon lifetime that has ended. It cannot prove anything about
//! the PROCESS that row named: killing the daemon reaches a child only as
//! the SIGHUP a closing PTY master sends, and a child that ignores SIGHUP
//! survives, reparented to init. The epoch describes a daemon lifetime;
//! this module describes a process, which is the question recovery
//! actually needs answered.
//!
//! Everything here fails toward "gone". A probe that cannot get a
//! straight answer -- no such pid, a zombie, a platform with no
//! implementation, a syscall that errors -- returns `None`, because the
//! consequence of a false "gone" is the behaviour gavin already had,
//! while the consequence of a false "alive" is telling the human a
//! stranger's process is their agent, and offering to kill it.

use serde::{Deserialize, Serialize};

#[cfg(windows)]
use windows::Win32::Foundation::{FILETIME, STILL_ACTIVE};
#[cfg(windows)]
use windows::Win32::Security::{
    EqualSid, GetLengthSid, GetTokenInformation, TokenUser, PSID, TOKEN_QUERY, TOKEN_USER,
};
#[cfg(windows)]
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
#[cfg(windows)]
use windows::Win32::System::ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
#[cfg(windows)]
use windows::Win32::System::Threading::{
    GetExitCodeProcess, GetProcessTimes, OpenProcess, OpenProcessToken, TerminateProcess,
    PROCESS_ACCESS_RIGHTS, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE,
};

/// A pid together with enough to tell it apart from a later process that
/// inherited that number.
///
/// The start time is the whole point. A pid is a recycled number: on
/// macOS they wrap at 99999 and a busy machine gets there in hours, so
/// "pid 4172 exists" is not evidence that pid 4172 is the agent gavin
/// spawned three days ago. The pair is what makes an identity -- for a
/// false match, an unrelated process would have to hold that exact pid
/// AND have started in the same microsecond as the one that is gone.
///
/// It is one type rather than two loose columns so that a half-known
/// process cannot be built: a pid with no start time is not an identity,
/// and the registry turns that case into `None` rather than into a handle
/// nothing can check.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProcessHandle {
    pub pid: u32,
    /// Microseconds since the epoch, as the kernel recorded them when the
    /// process started. An i64 rather than a SystemTime because it
    /// round-trips through a SQLite INTEGER column unchanged.
    pub started_at_us: i64,
}

/// A handle to the live process with this pid, or `None` when there
/// isn't one.
///
/// `None` covers every shade of "no process to talk about": the pid is
/// unused, it belongs to another user (so it is not ours and never was),
/// or it names a zombie -- a reaped-but-unwaited corpse is not something
/// that can still be editing a checkout, and offering to kill it would be
/// theatre.
#[cfg(target_os = "macos")]
pub fn identify(pid: u32) -> Option<ProcessHandle> {
    // proc_pidinfo(PROC_PIDTBSDINFO) rather than sysctl(KERN_PROC_PID):
    // both are in libSystem and readable for a same-uid process, but this
    // one hands back a documented, flat `proc_bsdinfo` instead of
    // `kinfo_proc`, whose start time hides inside an anonymous union
    // (`p_un.__p_starttime`) that has moved between SDKs.
    const SIZE: u32 = std::mem::size_of::<libc::proc_bsdinfo>() as u32;
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    // SAFETY: `info` is a live, correctly-sized, correctly-aligned
    // `proc_bsdinfo`, and SIZE is its own size -- the kernel writes at
    // most that many bytes into it. The call has no other side effects.
    let written = unsafe {
        libc::proc_pidinfo(
            pid as i32,
            libc::PROC_PIDTBSDINFO,
            0,
            &mut info as *mut libc::proc_bsdinfo as *mut libc::c_void,
            SIZE as i32,
        )
    };
    // A short (or zero, or negative) return is the "no such process, or
    // not one you may look at" answer. Insisting on the FULL struct is
    // deliberate: a partial write would leave `pbi_start_tvsec` as the
    // zero this was initialised with, which reads as a real start time at
    // the epoch and would match nothing -- correct by luck rather than by
    // construction.
    if written != SIZE as i32 {
        return None;
    }
    // The kernel was asked about `pid`; disbelieving the answer costs one
    // comparison and closes the door on a future SDK reordering the
    // struct under us.
    if info.pbi_pid != pid {
        return None;
    }
    if info.pbi_status == libc::SZOMB as u32 {
        return None;
    }
    Some(ProcessHandle {
        pid,
        started_at_us: info.pbi_start_tvsec as i64 * 1_000_000 + info.pbi_start_tvusec as i64,
    })
}

/// The same question of `/proc`, which answers it in one file.
///
/// `/proc/<pid>/stat` carries both halves of the identity: the state (so
/// a zombie can be refused, as on macOS) and `starttime`, the boot-
/// relative tick count that makes a pid an identity. Boot-relative is
/// not directly comparable to anything -- a handle stored before a
/// reboot must not match a pid after one -- so it is turned into an
/// absolute stamp with `/proc/stat`'s `btime`, giving the same units the
/// macOS arm records.
///
/// The uid check is what libproc gives macOS for free: `proc_pidinfo`
/// refuses another user's process, while `/proc` is world-readable. Same
/// rule on both, then -- a process that is not ours is not one gavin
/// spawned, and `terminate` would only earn an EPERM for asking.
#[cfg(target_os = "linux")]
pub fn identify(pid: u32) -> Option<ProcessHandle> {
    let stat = read_proc_stat(pid)?;
    if stat.state == 'Z' {
        return None;
    }
    if !owned_by_us(pid) {
        return None;
    }
    Some(ProcessHandle { pid, started_at_us: absolute_start_us(stat.starttime_ticks)? })
}

/// The fields of `/proc/<pid>/stat` this module reads, already past the
/// one parse that is easy to get wrong.
#[cfg(target_os = "linux")]
struct ProcStat {
    state: char,
    /// utime + stime, in clock ticks.
    cpu_ticks: u64,
    /// Field 22: ticks since boot at which the process started.
    starttime_ticks: u64,
    /// Field 24: resident set size, in PAGES.
    rss_pages: u64,
}

#[cfg(target_os = "linux")]
fn read_proc_stat(pid: u32) -> Option<ProcStat> {
    parse_proc_stat(&std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?)
}

/// Splits `/proc/<pid>/stat` at the LAST `)`, not on whitespace.
///
/// Field 2 is the executable name in parentheses and is neither escaped
/// nor length-limited in a way that helps: `sh -c 'exec -a "a) b" sleep 5'`
/// is a legal process name, and so is one containing a newline. Scanning
/// from the left is the classic bug -- it shifts every subsequent field
/// by however many spaces the name held, so `starttime` reads as
/// something else entirely and every identity silently stops matching.
/// The kernel guarantees exactly one `)` after the name at the end of
/// field 2, so the last one in the line is that one.
#[cfg(target_os = "linux")]
fn parse_proc_stat(line: &str) -> Option<ProcStat> {
    let rest = &line[line.rfind(')')? + 1..];
    // Field N of the file is index N-3 here: the split begins at field 3.
    let f: Vec<&str> = rest.split_whitespace().collect();
    let at = |n: usize| f.get(n - 3).copied();
    let num = |n: usize| at(n)?.parse::<u64>().ok();
    Some(ProcStat {
        state: at(3)?.chars().next()?,
        cpu_ticks: num(14)?.saturating_add(num(15)?),
        starttime_ticks: num(22)?,
        rss_pages: num(24)?,
    })
}

/// Clock ticks since boot, as microseconds since the epoch.
///
/// `btime` is read once and cached: it is a constant for the life of the
/// kernel, and a value that drifted between two reads of the same
/// process would make its identity look changed -- i.e. permanently
/// "gone", which is the failure this whole module is built to avoid.
#[cfg(target_os = "linux")]
fn absolute_start_us(ticks: u64) -> Option<i64> {
    static BOOT_TIME_S: std::sync::OnceLock<Option<i64>> = std::sync::OnceLock::new();
    let boot = (*BOOT_TIME_S.get_or_init(|| {
        let stat = std::fs::read_to_string("/proc/stat").ok()?;
        stat.lines().find_map(|l| l.strip_prefix("btime ")?.trim().parse::<i64>().ok())
    }))?;
    Some(boot * 1_000_000 + (ticks as i64) * 1_000_000 / clock_ticks_per_second())
}

/// `USER_HZ`, which is 100 on every mainstream build and is still read
/// rather than assumed -- it is a compile-time kernel choice, and
/// hardcoding it would misreport CPU on a kernel built at 250 or 1000
/// with nothing to show for it but plausible-looking numbers (the same
/// shape as the mach-timebase bug on the macOS side).
#[cfg(target_os = "linux")]
fn clock_ticks_per_second() -> i64 {
    static HZ: std::sync::OnceLock<i64> = std::sync::OnceLock::new();
    *HZ.get_or_init(|| {
        // SAFETY: sysconf takes a name and returns a long; no pointers.
        let hz = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
        if hz > 0 {
            hz
        } else {
            100
        }
    })
}

#[cfg(target_os = "linux")]
fn page_size() -> u64 {
    static SIZE: std::sync::OnceLock<u64> = std::sync::OnceLock::new();
    *SIZE.get_or_init(|| {
        // SAFETY: as above.
        let size = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
        if size > 0 {
            size as u64
        } else {
            4096
        }
    })
}

#[cfg(target_os = "linux")]
fn owned_by_us(pid: u32) -> bool {
    use std::os::unix::fs::MetadataExt;
    // SAFETY: geteuid cannot fail and takes no arguments.
    let me = unsafe { libc::geteuid() };
    std::fs::metadata(format!("/proc/{pid}")).map(|m| m.uid() == me).unwrap_or(false)
}

/// The same two questions of Win32, which needs a handle to answer
/// either.
///
/// `PROCESS_QUERY_LIMITED_INFORMATION` rather than
/// `PROCESS_QUERY_INFORMATION`: it is the narrower right, it is enough
/// for `GetProcessTimes`, `GetExitCodeProcess` and `OpenProcessToken`,
/// and -- unlike the wider one -- it is granted for a process running as
/// another user at a different integrity level, which is what lets the
/// uid check below be a check rather than an accident of the open
/// failing.
///
/// The start time comes back as a FILETIME, 100-nanosecond ticks since
/// 1601, and is converted to the microseconds-since-1970 the other two
/// platforms record. Same identity, same column, same comparison.
#[cfg(windows)]
pub fn identify(pid: u32) -> Option<ProcessHandle> {
    let process = OwnedProcess::open(pid, PROCESS_QUERY_LIMITED_INFORMATION)?;
    if !process.is_running() {
        return None;
    }
    if !process.owned_by_us() {
        return None;
    }
    Some(ProcessHandle { pid, started_at_us: process.times()?.created_us })
}

/// Every other platform. Answering "gone" is the honest placeholder: it
/// makes recovery behave exactly as it did before this module existed,
/// rather than inventing a liveness claim from nothing.
#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
pub fn identify(_pid: u32) -> Option<ProcessHandle> {
    None
}

/// A process handle that closes itself, and the four questions this
/// module asks through one.
///
/// One type rather than four functions that each open and close: every
/// probe here needs the handle for two calls at least (liveness and
/// times, identity and termination), and a leaked handle in a daemon
/// that polls on a timer is a slow-motion resource exhaustion rather
/// than a visible bug.
#[cfg(windows)]
struct OwnedProcess(windows::Win32::Foundation::HANDLE);

#[cfg(windows)]
struct ProcessTimes {
    /// Microseconds since the Unix epoch, from the creation FILETIME.
    created_us: i64,
    /// Kernel plus user, in microseconds. A cumulative total, like every
    /// other arm of `usage`.
    cpu_us: u64,
}

#[cfg(windows)]
impl OwnedProcess {
    fn open(pid: u32, rights: PROCESS_ACCESS_RIGHTS) -> Option<OwnedProcess> {
        // SAFETY: no pointer arguments; the handle is owned from here.
        let handle = unsafe { OpenProcess(rights, false, pid) }.ok()?;
        if handle.is_invalid() {
            return None;
        }
        Some(OwnedProcess(handle))
    }

    /// Whether the process has not yet exited.
    ///
    /// `GetExitCodeProcess` reports `STILL_ACTIVE` (259) for a live
    /// process -- and, famously, for one that exited WITH 259. That
    /// ambiguity cannot mislead this module: a false "alive" here is
    /// still checked against the recorded creation time by
    /// `still_running`, and a process that exited cannot have the same
    /// creation time as whatever now holds its pid. The alternative,
    /// `WaitForSingleObject`, needs SYNCHRONIZE access, which is a wider
    /// right for no gain.
    fn is_running(&self) -> bool {
        let mut code: u32 = 0;
        // SAFETY: `code` is a live u32 and the handle is ours.
        let ok = unsafe { GetExitCodeProcess(self.0, &mut code) }.is_ok();
        ok && code == STILL_ACTIVE.0 as u32
    }

    fn times(&self) -> Option<ProcessTimes> {
        let mut created = FILETIME::default();
        let mut exited = FILETIME::default();
        let mut kernel = FILETIME::default();
        let mut user = FILETIME::default();
        // SAFETY: four live FILETIMEs, all four written by the call.
        unsafe {
            GetProcessTimes(self.0, &mut created, &mut exited, &mut kernel, &mut user).ok()?;
        }
        Some(ProcessTimes {
            created_us: filetime_to_unix_us(&created)?,
            cpu_us: (filetime_ticks(&kernel) + filetime_ticks(&user)) / 10,
        })
    }

    /// Whether this process runs as the user gavin does.
    ///
    /// The Windows half of `owned_by_us`: `proc_pidinfo` refuses another
    /// user's process outright on macOS and `/proc` is world-readable on
    /// Linux, while here the answer depends on privilege -- an elevated
    /// daemon CAN open a stranger's process, and would then offer to
    /// kill it as if it were the agent gavin spawned. `false` on any
    /// failure, which is the "not ours" direction, and the safe one.
    fn owned_by_us(&self) -> bool {
        let Some(theirs) = self.user_sid() else { return false };
        let Some(ours) = current_user_sid() else { return false };
        // SAFETY: both buffers outlive the call and hold real SIDs.
        unsafe { EqualSid(PSID(theirs.as_ptr() as *mut _), PSID(ours.as_ptr() as *mut _)) }.is_ok()
    }

    /// This process's token user SID, as the bytes the token wrote.
    ///
    /// The buffer is returned rather than the `PSID`, because that
    /// pointer points INTO it: handing back the pointer alone would be a
    /// dangling read the moment the vector dropped.
    fn user_sid(&self) -> Option<Vec<u8>> {
        unsafe {
            let mut token = windows::Win32::Foundation::HANDLE::default();
            OpenProcessToken(self.0, TOKEN_QUERY, &mut token).ok()?;
            let token = OwnedProcess(token);
            let mut needed: u32 = 0;
            // The documented two-call shape: the first fails with
            // ERROR_INSUFFICIENT_BUFFER and fills in the size.
            let _ = GetTokenInformation(token.0, TokenUser, None, 0, &mut needed);
            if needed == 0 {
                return None;
            }
            let mut buf = vec![0u8; needed as usize];
            GetTokenInformation(
                token.0,
                TokenUser,
                Some(buf.as_mut_ptr() as *mut core::ffi::c_void),
                needed,
                &mut needed,
            )
            .ok()?;
            let user = &*(buf.as_ptr() as *const TOKEN_USER);
            let sid = user.User.Sid;
            if sid.is_invalid() {
                return None;
            }
            // Copy the SID out of the token's buffer into one whose
            // lifetime the caller controls.
            let len = GetLengthSid(sid) as usize;
            let mut out = vec![0u8; len];
            std::ptr::copy_nonoverlapping(sid.0 as *const u8, out.as_mut_ptr(), len);
            Some(out)
        }
    }
}

#[cfg(windows)]
impl Drop for OwnedProcess {
    fn drop(&mut self) {
        // SAFETY: the handle is ours and is closed exactly once.
        unsafe {
            let _ = windows::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

/// The daemon's own user SID, read once.
///
/// Once because it cannot change for the life of the process, and
/// because `owned_by_us` runs per pid inside a tree walk that is already
/// capped at `MAX_TREE_PROCESSES`.
#[cfg(windows)]
fn current_user_sid() -> Option<&'static Vec<u8>> {
    static SID: std::sync::OnceLock<Option<Vec<u8>>> = std::sync::OnceLock::new();
    SID.get_or_init(|| {
        // SAFETY: GetCurrentProcess returns a pseudo-handle that needs
        // no close; wrapping it here would close it, so it is used raw.
        let me = OwnedProcess(unsafe { windows::Win32::System::Threading::GetCurrentProcess() });
        let sid = me.user_sid();
        // Do NOT close the pseudo-handle.
        std::mem::forget(me);
        sid
    })
    .as_ref()
}

/// FILETIME as its raw 100-nanosecond tick count.
#[cfg(windows)]
fn filetime_ticks(ft: &FILETIME) -> u64 {
    ((ft.dwHighDateTime as u64) << 32) | ft.dwLowDateTime as u64
}

/// A creation FILETIME as microseconds since the Unix epoch.
///
/// FILETIME counts 100-nanosecond ticks from 1601-01-01; the Unix epoch
/// is 11644473600 seconds later, which is the constant below in the same
/// units. `None` for a stamp before 1970, which no live process has and
/// which would otherwise become a negative identity that matches
/// nothing.
#[cfg(windows)]
fn filetime_to_unix_us(ft: &FILETIME) -> Option<i64> {
    const EPOCH_DIFFERENCE_TICKS: u64 = 116_444_736_000_000_000;
    let ticks = filetime_ticks(ft);
    if ticks < EPOCH_DIFFERENCE_TICKS {
        return None;
    }
    Some(((ticks - EPOCH_DIFFERENCE_TICKS) / 10) as i64)
}

/// Whether the process this handle names is still the one it named.
///
/// The reuse guard, stated as one function so every caller asks the same
/// question: the pid must still be live AND still be the same incarnation
/// of that number. A mismatch is "gone", the safe direction. A row that
/// never recorded a handle at all -- everything written before v21 --
/// never reaches here, because the registry hands back `None` for it, and
/// "unknown" must read as gone for the same reason.
pub fn still_running(handle: ProcessHandle) -> bool {
    identify(handle.pid) == Some(handle)
}

/// Asks a surviving process to stop, politely -- where the OS has a way
/// to ask. See the Windows arm below, which does not.
///
/// SIGTERM, not SIGKILL: an orphaned agent is mid-conversation with a
/// checkout open, and the graceful path lets it flush whatever it was
/// writing. Nothing here escalates to SIGKILL afterwards -- a process
/// that ignores SIGTERM has said something, and silently overruling it
/// would make a button labelled "end this" do more than it says.
///
/// The identity is re-checked HERE rather than trusted from whenever it
/// was recorded, because the gap between detecting an orphan and a human
/// deciding to end it is unbounded: the orphan can exit in that window
/// and its pid be handed to something else. `false` means the process was
/// already gone, or was never the one recorded -- either way nothing was
/// signalled.
#[cfg(unix)]
pub fn terminate(handle: ProcessHandle) -> bool {
    if !still_running(handle) {
        return false;
    }
    // SAFETY: `kill` with a plain signal number and no pointer arguments.
    // The pid was just confirmed to name a live, same-identity process;
    // the worst a race here can do is signal a pid that exited in the
    // microseconds since, which is the ESRCH the return value reports.
    unsafe { libc::kill(handle.pid as i32, libc::SIGTERM) == 0 }
}

/// The same button on Windows, where the polite half of the contract
/// above does not exist.
///
/// There is no SIGTERM. `TerminateProcess` is unconditional: the process
/// stops where it is, its buffers are not flushed, its atexit handlers
/// do not run, and an agent mid-write leaves a half-written file. The
/// documented alternatives are all worse or not applicable -- a console
/// CTRL_BREAK event needs the target to share this process's console and
/// would reach every other child in it, and posting WM_CLOSE needs a
/// message loop a CLI does not have. So the honest statement is that
/// this is the abrupt one, and the copy on the button that calls it says
/// so rather than promising a graceful stop it cannot deliver.
///
/// The identity re-check is the same as on unix and matters more here,
/// because what follows it cannot be survived.
#[cfg(windows)]
pub fn terminate(handle: ProcessHandle) -> bool {
    if !still_running(handle) {
        return false;
    }
    let Some(process) = OwnedProcess::open(handle.pid, PROCESS_TERMINATE) else { return false };
    // SAFETY: the handle is ours and no pointer arguments are passed.
    // The exit code is the one Windows itself uses for a process killed
    // from Task Manager.
    unsafe { TerminateProcess(process.0, 1) }.is_ok()
}

/// What one process is costing right now: the two numbers a task manager
/// is actually asked for.
///
/// CPU is a cumulative TOTAL, not a rate, and that is deliberate. A rate
/// needs two readings and an interval, and the only honest interval is
/// the one between the samples the caller actually took -- so the daemon
/// reports the counter and lets the poller divide. A daemon that computed
/// the rate itself would have to keep a per-caller baseline, and two
/// clients polling at different periods would each corrupt the other's.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Usage {
    /// Physical memory this process currently occupies, in bytes.
    pub rss_bytes: u64,
    /// User + system CPU time consumed since the process started, in
    /// microseconds. Monotonic for a given process, which is what makes
    /// the difference between two samples a meaningful numerator.
    pub cpu_time_us: u64,
}

/// This process's memory and CPU total, or `None` when there is nothing
/// to measure.
///
/// `None` for the same reasons `identify` returns it -- no such pid,
/// another user's, a short read -- because the two are asked in sequence
/// and an answer that is missing at either step means the same thing:
/// there are no figures to show for this row.
#[cfg(target_os = "macos")]
pub fn usage(pid: u32) -> Option<Usage> {
    const SIZE: u32 = std::mem::size_of::<libc::proc_taskinfo>() as u32;
    let mut info: libc::proc_taskinfo = unsafe { std::mem::zeroed() };
    // SAFETY: `info` is a live, correctly-sized, correctly-aligned
    // `proc_taskinfo`, and SIZE is its own size -- the kernel writes at
    // most that many bytes into it. The call has no other side effects.
    let written = unsafe {
        libc::proc_pidinfo(
            pid as i32,
            libc::PROC_PIDTASKINFO,
            0,
            &mut info as *mut libc::proc_taskinfo as *mut libc::c_void,
            SIZE as i32,
        )
    };
    if written != SIZE as i32 {
        return None;
    }
    Some(Usage {
        rss_bytes: info.pti_resident_size,
        cpu_time_us: ticks_to_micros(info.pti_total_user.saturating_add(info.pti_total_system)),
    })
}

/// The kernel's ratio of nanoseconds to mach absolute-time ticks, read
/// once.
///
/// `pti_total_user` and `pti_total_system` are in MACH ABSOLUTE TIME,
/// not nanoseconds. On Intel Macs the timebase is 1:1 and the two are
/// the same number, which is why treating them as nanoseconds is such a
/// common belief -- htop's darwin backend divides them down as if they
/// were. On Apple Silicon the ratio is 125/3, so a raw tick count read
/// as nanoseconds understates CPU time by a factor of forty-one: three
/// processes pinning a core each measured as 7%.
#[cfg(target_os = "macos")]
fn timebase() -> (u64, u64) {
    static TIMEBASE: std::sync::OnceLock<(u64, u64)> = std::sync::OnceLock::new();
    *TIMEBASE.get_or_init(|| {
        let mut info = libc::mach_timebase_info { numer: 0, denom: 0 };
        // SAFETY: a live, correctly-sized `mach_timebase_info` is the
        // only argument; the call has no other side effects.
        let ok = unsafe { libc::mach_timebase_info(&mut info) } == 0;
        // 1:1 is the honest fallback for a kernel that will not answer:
        // it is what every Intel Mac reports, and it makes the figures
        // wrong on Apple Silicon in the direction that under-reports
        // rather than inventing load.
        if !ok || info.numer == 0 || info.denom == 0 {
            (1, 1)
        } else {
            (info.numer as u64, info.denom as u64)
        }
    })
}

#[cfg(target_os = "macos")]
fn ticks_to_micros(ticks: u64) -> u64 {
    let (numer, denom) = timebase();
    // u128 for the multiply: a process running for weeks reaches ~1e15
    // ticks, and 125x that would clear u64's range with nothing to say
    // about it.
    ((ticks as u128 * numer as u128) / (denom as u128 * 1_000)) as u64
}

/// Both figures out of the same `/proc/<pid>/stat` the identity came
/// from -- one read rather than a second from `statm`, which reports the
/// same RSS in the same pages.
#[cfg(target_os = "linux")]
pub fn usage(pid: u32) -> Option<Usage> {
    let stat = read_proc_stat(pid)?;
    Some(Usage {
        rss_bytes: stat.rss_pages.saturating_mul(page_size()),
        cpu_time_us: stat.cpu_ticks.saturating_mul(1_000_000) / clock_ticks_per_second() as u64,
    })
}

/// Working set for memory, kernel + user for CPU -- one handle, two
/// calls.
///
/// WorkingSetSize is the figure Task Manager shows as "Memory (active
/// private working set)"'s parent quantity and the closest analogue to
/// the RSS the other two arms report: resident pages, not the address
/// space reservation `PagefileUsage` describes.
#[cfg(windows)]
pub fn usage(pid: u32) -> Option<Usage> {
    let process = OwnedProcess::open(pid, PROCESS_QUERY_LIMITED_INFORMATION)?;
    if !process.is_running() || !process.owned_by_us() {
        return None;
    }
    let mut counters = PROCESS_MEMORY_COUNTERS {
        cb: std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
        ..Default::default()
    };
    // SAFETY: `counters` is a live, correctly-sized PROCESS_MEMORY_COUNTERS
    // and `cb` is its own size, which is what bounds the write.
    unsafe {
        GetProcessMemoryInfo(process.0, &mut counters, counters.cb).ok()?;
    }
    Some(Usage {
        rss_bytes: counters.WorkingSetSize as u64,
        cpu_time_us: process.times()?.cpu_us,
    })
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
pub fn usage(_pid: u32) -> Option<Usage> {
    None
}

/// The pids this process started, or an empty list when it started none
/// (and when the platform cannot say).
#[cfg(target_os = "macos")]
pub fn children(pid: u32) -> Vec<u32> {
    // The return value is a COUNT of pids, not a byte length -- libproc's
    // proc_listchildpids divides by sizeof(int) before handing it back,
    // unlike proc_listpids, which does not. Reading it as bytes silently
    // returns a quarter of the children, which looks like a working
    // function and reports a fraction of what a session costs.
    //
    // A count that exactly fills the buffer may be a truncation, so the
    // capacity doubles rather than guessing once. It starts well above a
    // realistic fan-out, so the common case is a single syscall.
    let mut capacity = 64usize;
    loop {
        let mut buf = vec![0i32; capacity];
        // SAFETY: the buffer is `capacity` live i32s and the size argument
        // is its length in bytes, so the kernel cannot write past it.
        let count = unsafe {
            libc::proc_listchildpids(
                pid as i32,
                buf.as_mut_ptr() as *mut libc::c_void,
                (capacity * std::mem::size_of::<i32>()) as libc::c_int,
            )
        };
        // Zero is both "no children" and "the call failed" -- libproc
        // collapses them -- and an empty list is the right answer to both.
        if count <= 0 {
            return Vec::new();
        }
        let count = count as usize;
        if count >= capacity && capacity < MAX_TREE_PROCESSES {
            capacity *= 2;
            continue;
        }
        buf.truncate(count.min(capacity));
        return buf.into_iter().filter(|p| *p > 0).map(|p| p as u32).collect();
    }
}

/// `/proc/<pid>/task/<tid>/children`, per thread, with a full `/proc`
/// scan behind it.
///
/// That file needs `CONFIG_PROC_CHILDREN`, which Ubuntu and Fedora both
/// ship enabled -- but a kernel without it would make this return an
/// empty list for every process, and `tree_usage` would then report the
/// root alone: a session whose agent is pinning four cores measured as
/// one idle shell. The fallback costs a directory listing and answers
/// the same question from `ppid`, which no kernel option can remove.
#[cfg(target_os = "linux")]
pub fn children(pid: u32) -> Vec<u32> {
    let Ok(tasks) = std::fs::read_dir(format!("/proc/{pid}/task")) else {
        return Vec::new();
    };
    let mut found = Vec::new();
    let mut have_file = false;
    for task in tasks.flatten() {
        let Ok(line) = std::fs::read_to_string(task.path().join("children")) else { continue };
        have_file = true;
        found.extend(line.split_whitespace().filter_map(|p| p.parse::<u32>().ok()));
    }
    if have_file {
        found.sort_unstable();
        found.dedup();
        return found;
    }
    children_by_ppid(pid)
}

/// Field 4 of every `/proc/<pid>/stat`, for a kernel with no `children`
/// file. Same last-`)` parse as everywhere else.
#[cfg(target_os = "linux")]
fn children_by_ppid(parent: u32) -> Vec<u32> {
    let Ok(entries) = std::fs::read_dir("/proc") else { return Vec::new() };
    entries
        .flatten()
        .filter_map(|e| e.file_name().to_str()?.parse::<u32>().ok())
        .filter(|pid| {
            std::fs::read_to_string(format!("/proc/{pid}/stat"))
                .ok()
                .and_then(|line| {
                    let rest = &line[line.rfind(')')? + 1..];
                    rest.split_whitespace().nth(1)?.parse::<u32>().ok()
                })
                .is_some_and(|ppid| ppid == parent)
        })
        .collect()
}

/// A whole-system snapshot, filtered by parent pid -- Windows keeps no
/// per-process child list to ask for.
///
/// `th32ParentProcessID` is recorded once, at creation, and is NEVER
/// cleared: when a parent exits, its pid is free for reuse and every one
/// of its orphans still names it. So a snapshot filtered by ppid alone
/// will hand back strangers the moment a pid wraps, which on a busy
/// Windows box is hours. Each candidate's creation time is therefore
/// checked to be LATER than the parent's -- a child cannot predate the
/// process that started it -- which is the same reuse guard
/// `ProcessHandle` applies, spent here on the walk instead of on a
/// stored pair.
#[cfg(windows)]
pub fn children(pid: u32) -> Vec<u32> {
    let Some(parent) = OwnedProcess::open(pid, PROCESS_QUERY_LIMITED_INFORMATION) else {
        return Vec::new();
    };
    let Some(parent_times) = parent.times() else { return Vec::new() };
    // SAFETY: no pointer arguments; the returned handle is closed below.
    let Ok(snapshot) = (unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }) else {
        return Vec::new();
    };
    let snapshot = OwnedProcess(snapshot);
    let mut entry = PROCESSENTRY32W {
        dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    let mut out = Vec::new();
    // SAFETY: `entry` is live and its dwSize is set, as both calls require.
    unsafe {
        if Process32FirstW(snapshot.0, &mut entry).is_err() {
            return out;
        }
        loop {
            if entry.th32ParentProcessID == pid && entry.th32ProcessID != pid {
                let child = entry.th32ProcessID;
                let born_after = OwnedProcess::open(child, PROCESS_QUERY_LIMITED_INFORMATION)
                    .and_then(|c| c.times())
                    .is_some_and(|t| t.created_us >= parent_times.created_us);
                if born_after {
                    out.push(child);
                }
            }
            if out.len() >= MAX_TREE_PROCESSES {
                break;
            }
            entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
            if Process32NextW(snapshot.0, &mut entry).is_err() {
                break;
            }
        }
    }
    out
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
pub fn children(_pid: u32) -> Vec<u32> {
    Vec::new()
}

/// The ceiling on how much of the process tree one sample walks.
///
/// A build or a test run under an agent can fan out wide, and this is
/// called on a timer while a modal is open: an unbounded walk would turn
/// a runaway subprocess tree into a stalled daemon. Truncating overstates
/// nothing -- the figures come out low, and low is the direction that
/// cannot alarm someone into killing the wrong thing.
const MAX_TREE_PROCESSES: usize = 512;

/// What a session is costing: the process in its PTY plus everything that
/// process started.
///
/// The tree, not the root alone, because the root is usually the cheap
/// half. `sh -c` execs the agent in place, so the pid IS the agent -- but
/// an agent's real cost is the language server, the MCP servers and the
/// build it spawned, and a task manager that reported 0.2% for a session
/// pinning four cores would be worse than showing nothing.
///
/// Identity-guarded at the root, like every other read here: a recycled
/// pid must not have a stranger's memory footprint attributed to a
/// session, next to a button that kills it. Descendants are trusted from
/// the walk itself -- they were reached FROM a verified root, within one
/// sample, which is a tighter window than any stored pair could offer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TreeUsage {
    pub rss_bytes: u64,
    pub cpu_time_us: u64,
    /// How many processes those two figures actually cover, so a caller
    /// can tell "one quiet shell" from "the walk found nothing".
    pub process_count: u32,
}

pub fn tree_usage(root: ProcessHandle) -> Option<TreeUsage> {
    if !still_running(root) {
        return None;
    }
    let mut total = TreeUsage { rss_bytes: 0, cpu_time_us: 0, process_count: 0 };
    let mut queue = vec![root.pid];
    let mut seen = std::collections::HashSet::from([root.pid]);
    while let Some(pid) = queue.pop() {
        // A process that exited between being listed and being read
        // contributes nothing rather than aborting the sample: half a
        // tree measured is the honest answer for a tree that is half
        // gone.
        if let Some(u) = usage(pid) {
            total.rss_bytes = total.rss_bytes.saturating_add(u.rss_bytes);
            total.cpu_time_us = total.cpu_time_us.saturating_add(u.cpu_time_us);
            total.process_count += 1;
        }
        if seen.len() >= MAX_TREE_PROCESSES {
            continue;
        }
        for child in children(pid) {
            // `seen` guards against a pid appearing twice in one walk --
            // impossible in a real tree, but this walks a table that can
            // change under it, and a loop here would hang the daemon.
            if seen.len() < MAX_TREE_PROCESSES && seen.insert(child) {
                queue.push(child);
            }
        }
    }
    Some(total)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A process that starts nothing of its own and stays alive for
    /// `seconds`.
    ///
    /// Two spellings for one shape, because the shapes really do differ:
    /// `sh -c 'sleep 5'` is a SINGLE simple command, so the shell execs
    /// sleep in its own place and the result is one process -- while
    /// `cmd /C` has no exec to do that with and would always leave a
    /// parent behind. So on Windows the sleeper is spawned directly, and
    /// it is `ping` because `timeout` refuses to run with redirected
    /// input, which is exactly how a test harness runs it.
    fn spawn_leaf(seconds: u32) -> std::process::Child {
        #[cfg(unix)]
        {
            std::process::Command::new("/bin/sh")
                .args(["-c", &format!("sleep {seconds}")])
                .spawn()
                .unwrap()
        }
        #[cfg(windows)]
        {
            std::process::Command::new("ping")
                .args(["-n", &(seconds + 1).to_string(), "127.0.0.1"])
                .stdout(std::process::Stdio::null())
                .spawn()
                .unwrap()
        }
    }

    /// A process that DOES start something: the two-deep tree
    /// `tree_usage` and `children` are about.
    fn spawn_parent(seconds: u32) -> std::process::Child {
        #[cfg(unix)]
        {
            // No `exec`, and a second command after it, so the shell has
            // to stay and wait.
            std::process::Command::new("/bin/sh")
                .args(["-c", &format!("/bin/sleep {seconds}; true")])
                .spawn()
                .unwrap()
        }
        #[cfg(windows)]
        {
            std::process::Command::new("cmd")
                .args(["/C", &format!("ping -n {} 127.0.0.1 > nul", seconds + 1)])
                .spawn()
                .unwrap()
        }
    }

    /// A process that is already over by the time it is looked at.
    fn spawn_exiting() -> std::process::Child {
        #[cfg(unix)]
        {
            std::process::Command::new("/bin/sh").args(["-c", "exit 0"]).spawn().unwrap()
        }
        #[cfg(windows)]
        {
            std::process::Command::new("cmd").args(["/C", "exit 0"]).spawn().unwrap()
        }
    }

    #[test]
    fn usage_reports_real_figures_for_the_running_process() {
        let u = usage(std::process::id()).expect("the test process must be measurable");
        assert!(u.rss_bytes > 0, "a running process occupies memory");
        // The suite has already done work by the time this runs, and the
        // counter is cumulative, so it cannot legitimately be zero.
        assert!(u.cpu_time_us > 0, "a running process has burned CPU time");
    }

    #[test]
    fn usage_has_nothing_to_say_about_a_dead_pid() {
        let mut child = spawn_exiting();
        let pid = child.id();
        child.wait().unwrap();
        assert_eq!(usage(pid), None);
    }

    #[test]
    fn cpu_time_is_in_the_unit_it_says_it_is() {
        // The test the units bug needed. `pti_total_*` are MACH ABSOLUTE
        // TIME, not nanoseconds -- 1:1 on Intel, 125:3 on Apple Silicon
        // -- so reading them as nanoseconds understates CPU by 41x on
        // this machine, and every figure still looks plausible.
        //
        // Burning a known amount of wall clock in ONE busy thread makes
        // the two comparable: a thread that never sleeps consumes very
        // close to one CPU-microsecond per wall-clock microsecond.
        let start = std::time::Instant::now();
        let before = usage(std::process::id()).unwrap().cpu_time_us;
        let mut spin = 0u64;
        while start.elapsed() < std::time::Duration::from_millis(300) {
            for i in 0..10_000u64 {
                spin = spin.wrapping_add(i);
            }
        }
        std::hint::black_box(spin);
        let burned = usage(std::process::id()).unwrap().cpu_time_us - before;
        let elapsed = start.elapsed().as_micros() as u64;

        // A wide band on purpose: the suite runs this in parallel with
        // other tests, so the process as a whole may burn MORE than one
        // core's worth, and the scheduler may give this thread less than
        // all of one. Any unit error is off by 24x or 41x and lands
        // nowhere near it.
        //
        // The floor is an eighth rather than a half because the share
        // this thread gets is set by how loaded the machine is, and a
        // full `cargo test --workspace` on a 10-core box has been
        // measured handing it 42%. An eighth still sits five times above
        // the 41x understatement the assertion exists to catch, so the
        // headroom is bought from slack, not from the test's meaning.
        assert!(
            burned > elapsed / 8,
            "burned {burned}us of CPU over {elapsed}us of spinning -- the counter is not in microseconds"
        );
        assert!(
            burned < elapsed * 20,
            "burned {burned}us of CPU over {elapsed}us -- implausibly high for one spinning thread"
        );
    }

    #[test]
    fn cpu_time_only_climbs() {
        // The property the whole rate calculation rests on: two samples
        // of one process are subtractable in one direction only.
        let first = usage(std::process::id()).unwrap().cpu_time_us;
        let mut spin = 0u64;
        for i in 0..2_000_000u64 {
            spin = spin.wrapping_add(i);
        }
        std::hint::black_box(spin);
        let second = usage(std::process::id()).unwrap().cpu_time_us;
        assert!(second >= first, "{second} came after {first}");
    }

    #[test]
    fn children_finds_a_process_this_one_started() {
        let mut child = spawn_leaf(5);
        let kids = children(std::process::id());
        assert!(kids.contains(&child.id()), "{kids:?} should contain {}", child.id());
        child.kill().ok();
        child.wait().ok();
    }

    #[test]
    fn children_of_a_leaf_is_empty() {
        let mut child = spawn_leaf(5);
        assert_eq!(children(child.id()), Vec::<u32>::new());
        child.kill().ok();
        child.wait().ok();
    }

    #[test]
    fn tree_usage_counts_the_root_and_what_it_started() {
        let mut child = spawn_parent(5);
        let handle = identify(child.id()).expect("the child must be visible");
        // The grandchild is spawned asynchronously by the shell; give it
        // a moment to exist before asking how many processes there are.
        std::thread::sleep(std::time::Duration::from_millis(300));
        let tree = tree_usage(handle).expect("a live root has a tree");
        assert!(tree.process_count >= 2, "root plus its child, got {}", tree.process_count);
        assert!(tree.rss_bytes > 0);
        child.kill().ok();
        child.wait().ok();
    }

    #[test]
    fn tree_usage_refuses_a_pid_whose_identity_does_not_match() {
        // Same guard as `terminate`, and for the same reason one level
        // down: the figures appear in a row that carries a kill button,
        // so attributing a stranger's memory to a session is how someone
        // ends the wrong process.
        let live = identify(std::process::id()).unwrap();
        assert_eq!(tree_usage(ProcessHandle { started_at_us: 1, ..live }), None);
    }

    #[test]
    fn tree_usage_of_a_gone_process_is_none() {
        let mut child = spawn_leaf(30);
        let handle = identify(child.id()).unwrap();
        child.kill().unwrap();
        child.wait().unwrap();
        assert_eq!(tree_usage(handle), None);
    }

    #[test]
    fn identifies_this_very_process() {
        let me = std::process::id();
        let handle = identify(me).expect("the running test process must be visible to the probe");
        assert_eq!(handle.pid, me);
        assert!(handle.started_at_us > 0, "a live process has a real start time");
    }

    #[test]
    fn the_same_process_reports_a_stable_identity() {
        // The guard is only worth anything if the recorded value still
        // matches later -- a start time that drifted between reads would
        // make every probe a mismatch, i.e. permanently "gone".
        let me = std::process::id();
        assert_eq!(identify(me), identify(me));
    }

    #[test]
    fn a_dead_pid_is_gone() {
        let mut child = spawn_exiting();
        let pid = child.id();
        child.wait().unwrap();
        // Waited on, so it is not even a zombie any more.
        assert_eq!(identify(pid), None);
    }

    #[test]
    fn still_running_holds_for_a_live_process_at_its_recorded_identity() {
        let handle = identify(std::process::id()).unwrap();
        assert!(still_running(handle));
    }

    #[test]
    fn a_recycled_pid_does_not_pass_as_the_process_that_had_it() {
        // The whole reason the start time is stored. This pid IS alive --
        // it is us -- so a probe that only asked "does this number exist"
        // would say yes and report a stranger's process as a surviving
        // agent.
        let live = identify(std::process::id()).unwrap();
        for drift in [-1, 1] {
            assert!(!still_running(ProcessHandle {
                started_at_us: live.started_at_us + drift,
                ..live
            }));
        }
    }

    #[test]
    fn terminate_refuses_a_pid_whose_identity_does_not_match() {
        // The destructive case, and the reason `terminate` re-probes
        // rather than trusting the stored pair: the pid here is the test
        // runner itself, so a bug that got past this would kill the suite
        // rather than fail it.
        let live = identify(std::process::id()).unwrap();
        assert!(!terminate(ProcessHandle { started_at_us: 1, ..live }));
    }

    #[test]
    fn terminate_signals_a_process_that_matches_and_reports_a_gone_one() {
        // The unix sleeper ignores SIGHUP deliberately: nothing here
        // sends one, and a process that died of the PTY closing instead
        // of of this call would make the test pass for the wrong reason.
        // Windows has no HUP to ignore, so the plain sleeper is the same
        // subject there.
        #[cfg(unix)]
        let mut child = std::process::Command::new("/bin/sh")
            .args(["-c", "trap '' HUP; sleep 30"])
            .spawn()
            .unwrap();
        #[cfg(windows)]
        let mut child = spawn_leaf(30);
        let handle = identify(child.id()).expect("the child must be visible");

        assert!(terminate(handle), "a matching live process is signalled");
        child.wait().unwrap();

        assert!(
            !terminate(handle),
            "a process that has already gone is reported as such, not signalled again"
        );
    }

    /// The one parse that has no macOS counterpart, and the one place a
    /// silent field shift would hide: every figure this module reports
    /// comes out of this line.
    #[cfg(target_os = "linux")]
    mod linux_stat {
        use super::*;

        /// Fields 1..=24 of a real `/proc/<pid>/stat`, with the comm
        /// field substituted in. Everything after 24 is elided -- the
        /// parse never looks past it.
        fn stat_line(comm: &str) -> String {
            let mut fields = vec!["4172".to_string(), format!("({comm})"), "S".to_string()];
            // 4..=24, with the four the parse actually reads pinned to
            // recognisable values.
            for n in 4..=24u32 {
                fields.push(
                    match n {
                        14 => 700,   // utime ticks
                        15 => 300,   // stime ticks
                        22 => 90_000, // starttime ticks
                        24 => 512,   // rss pages
                        _ => 0,
                    }
                    .to_string(),
                );
            }
            fields.join(" ")
        }

        #[test]
        fn a_comm_full_of_parens_and_spaces_does_not_shift_the_fields() {
            // `exec -a` lets any process call itself this, and a
            // left-to-right scan would read `starttime` out of the NAME.
            for comm in ["sleep", "a) b", "((", "node (worker) 3", ") ) )"] {
                let stat = parse_proc_stat(&stat_line(comm)).expect(comm);
                assert_eq!(stat.state, 'S', "{comm}");
                assert_eq!(stat.cpu_ticks, 1000, "{comm}");
                assert_eq!(stat.starttime_ticks, 90_000, "{comm}");
                assert_eq!(stat.rss_pages, 512, "{comm}");
            }
        }

        #[test]
        fn a_truncated_or_shapeless_line_is_no_answer_rather_than_a_guess() {
            assert!(parse_proc_stat("").is_none());
            assert!(parse_proc_stat("4172 (sleep) S 1 0").is_none());
            assert!(parse_proc_stat("no parens here at all").is_none());
        }

        #[test]
        fn the_start_time_is_absolute_and_ahead_of_boot() {
            // Boot-relative ticks would compare equal across a reboot,
            // which is exactly the false "alive" the identity exists to
            // prevent. Anchored to btime, a live process's stamp has to
            // sit between boot and now.
            let me = identify(std::process::id()).unwrap();
            let now_us = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_micros() as i64;
            let boot_us = absolute_start_us(0).unwrap();
            assert!(me.started_at_us >= boot_us, "{} < boot {boot_us}", me.started_at_us);
            assert!(me.started_at_us <= now_us, "{} > now {now_us}", me.started_at_us);
        }

        #[test]
        fn another_users_process_is_not_ours() {
            // pid 1 is root's on every Linux the app will run on, and
            // this is the guard libproc gives macOS for free.
            if unsafe { libc::geteuid() } == 0 {
                return; // running as root: everything is ours, nothing to prove
            }
            assert_eq!(identify(1), None);
        }

        #[test]
        fn the_ppid_fallback_finds_the_same_children_as_the_kernel_file() {
            // The fallback only runs on a kernel without
            // CONFIG_PROC_CHILDREN, which is not the one CI uses -- so
            // it is checked here against the file it stands in for,
            // rather than never being executed at all.
            let mut child =
                spawn_leaf(5);
            let mut by_ppid = children_by_ppid(std::process::id());
            by_ppid.sort_unstable();
            assert!(by_ppid.contains(&child.id()), "{by_ppid:?} should contain {}", child.id());
            assert_eq!(by_ppid, children(std::process::id()));
            child.kill().ok();
            child.wait().ok();
        }
    }
}
