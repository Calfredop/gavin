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

/// Gavin is a macOS app (`protocol::app_support_dir` resolves under
/// `~/Library/Application Support`), so there is no second platform to be
/// correct on yet. Answering "gone" everywhere else is the honest
/// placeholder: it makes recovery behave exactly as it did before this
/// module existed, rather than inventing a liveness claim from nothing.
#[cfg(not(target_os = "macos"))]
pub fn identify(_pid: u32) -> Option<ProcessHandle> {
    None
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

/// Asks a surviving process to stop, politely.
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

#[cfg(not(target_os = "macos"))]
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

#[cfg(not(target_os = "macos"))]
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
        let mut child = std::process::Command::new("/bin/sh").args(["-c", "exit 0"]).spawn().unwrap();
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
        let mut child = std::process::Command::new("/bin/sh").args(["-c", "sleep 5"]).spawn().unwrap();
        let kids = children(std::process::id());
        assert!(kids.contains(&child.id()), "{kids:?} should contain {}", child.id());
        child.kill().ok();
        child.wait().ok();
    }

    #[test]
    fn children_of_a_leaf_is_empty() {
        let mut child = std::process::Command::new("/bin/sh").args(["-c", "sleep 5"]).spawn().unwrap();
        assert_eq!(children(child.id()), Vec::<u32>::new());
        child.kill().ok();
        child.wait().ok();
    }

    #[test]
    fn tree_usage_counts_the_root_and_what_it_started() {
        // `exec` would replace the shell and leave one process; without
        // it /bin/sh forks, so the tree is genuinely two deep.
        let mut child = std::process::Command::new("/bin/sh")
            .args(["-c", "/bin/sleep 5; true"])
            .spawn()
            .unwrap();
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
        let mut child = std::process::Command::new("/bin/sh").args(["-c", "sleep 30"]).spawn().unwrap();
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
        let mut child = std::process::Command::new("/bin/sh")
            .args(["-c", "exit 0"])
            .spawn()
            .unwrap();
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
        let mut child = std::process::Command::new("/bin/sh")
            .args(["-c", "trap '' HUP; sleep 30"])
            .spawn()
            .unwrap();
        let handle = identify(child.id()).expect("the child must be visible");

        assert!(terminate(handle), "a matching live process is signalled");
        child.wait().unwrap();

        assert!(
            !terminate(handle),
            "a process that has already gone is reported as such, not signalled again"
        );
    }
}
