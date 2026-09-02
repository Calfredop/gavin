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

#[cfg(test)]
mod tests {
    use super::*;

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
