//! Soft `RLIMIT_NOFILE` for processes launched like a GUI app.
//!
//! On macOS, `launchctl limit maxfiles` ships a soft ceiling of 256. A
//! Finder-launched gavin-daemon inherits that, and each live session
//! holds several PTY master FDs on top of sockets, SQLite and watchers.
//! `openpty` then fails with EMFILE ("Too many open files") long before
//! the daemon's own session ceiling can refuse with a named error.
//!
//! Raising the soft limit to a fixed generous floor (capped by the hard
//! limit a non-root process cannot exceed) is the whole of this module.
//! Windows and wasm have nothing to do: their handle budgets are not the
//! same soft-256 trap, and wasm cannot open PTYs at all.

/// Soft floor we aim for. Comfortably above macOS's launchd default of
/// 256, under the historical macOS `OPEN_MAX` of 10240 that older kernels
/// refused to go past, and enough for the daemon's session ceiling
/// (`MAX_LIVE_SESSIONS` = 256) plus sockets, SQLite, Relay and watchers.
pub const RAISE_SOFT_NOFILE: u64 = 8192;

/// Raise this process's soft `RLIMIT_NOFILE` toward [`RAISE_SOFT_NOFILE`],
/// without ever lowering it and without touching the hard limit.
///
/// Failures are silent: a setrlimit the OS refuses leaves the limit where
/// it was, and the caller keeps going — the session ceiling and the
/// EMFILE-named refusal are the backstop, not a panic at startup.
pub fn raise_soft_nofile() {
    #[cfg(all(unix, feature = "os"))]
    raise_soft_nofile_unix();
}

#[cfg(all(unix, feature = "os"))]
fn raise_soft_nofile_unix() {
    let mut lim = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
    // SAFETY: `lim` is a live, correctly-sized `rlimit`; getrlimit only
    // writes into it.
    if unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut lim) } != 0 {
        eprintln!(
            "gavin: getrlimit(RLIMIT_NOFILE) failed: {}",
            std::io::Error::last_os_error()
        );
        return;
    }
    let soft_before = lim.rlim_cur;
    let hard = lim.rlim_max;
    let want = if hard == libc::RLIM_INFINITY {
        RAISE_SOFT_NOFILE as libc::rlim_t
    } else {
        (RAISE_SOFT_NOFILE as libc::rlim_t).min(hard)
    };
    if soft_before >= want {
        return;
    }
    lim.rlim_cur = want;
    // SAFETY: soft <= hard (we capped want), and we only raise soft.
    if unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &lim) } != 0 {
        eprintln!(
            "gavin: could not raise soft RLIMIT_NOFILE from {soft_before} to {want}: {}",
            std::io::Error::last_os_error()
        );
        return;
    }
    // One line on the daemon log / host stderr so a soft-256 relapse is
    // visible without attaching a debugger: Finder-launched processes
    // start at 256, and "dup of fd 252 failed" is what that looks like.
    eprintln!("gavin: soft RLIMIT_NOFILE raised from {soft_before} to {want}");
}

#[cfg(all(test, unix, feature = "os"))]
mod tests {
    use super::*;

    fn current_nofile() -> (u64, u64) {
        let mut lim = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
        // SAFETY: `lim` is a live, correctly-sized `rlimit`.
        let rc = unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut lim) };
        assert_eq!(rc, 0, "getrlimit RLIMIT_NOFILE");
        let soft = lim.rlim_cur as u64;
        let hard = if lim.rlim_max == libc::RLIM_INFINITY {
            u64::MAX
        } else {
            lim.rlim_max as u64
        };
        (soft, hard)
    }

    /// Restores soft `RLIMIT_NOFILE` on drop so a lowered soft limit
    /// cannot leave the suite under a tight ceiling.
    struct SoftNofileGuard {
        previous: libc::rlimit,
    }

    impl SoftNofileGuard {
        fn lower_soft_to(soft: u64) -> Option<Self> {
            let mut lim = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
            if unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut lim) } != 0 {
                return None;
            }
            let previous = lim;
            let hard = if lim.rlim_max == libc::RLIM_INFINITY {
                u64::MAX
            } else {
                lim.rlim_max as u64
            };
            if hard < soft {
                return None;
            }
            lim.rlim_cur = soft as libc::rlim_t;
            if unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &lim) } != 0 {
                return None;
            }
            Some(Self { previous })
        }
    }

    impl Drop for SoftNofileGuard {
        fn drop(&mut self) {
            let _ = unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &self.previous) };
        }
    }

    #[test]
    fn raise_soft_nofile_lifts_a_mac_style_256_soft_limit() {
        let Some(_guard) = SoftNofileGuard::lower_soft_to(256) else {
            // Hard limit below 256, or setrlimit refused: nothing to prove.
            return;
        };
        let (soft_before, _) = current_nofile();
        assert_eq!(soft_before, 256, "guard should have pinned soft at 256");

        raise_soft_nofile();

        let (soft, hard) = current_nofile();
        let expect = RAISE_SOFT_NOFILE.min(hard);
        assert!(
            soft >= expect,
            "soft RLIMIT_NOFILE should be at least {expect} after raise, got soft={soft} hard={hard}"
        );
    }

    #[test]
    fn raise_soft_nofile_never_lowers_an_already_high_soft_limit() {
        raise_soft_nofile();
        let (soft_before, _) = current_nofile();
        raise_soft_nofile();
        let (soft_after, _) = current_nofile();
        assert!(
            soft_after >= soft_before,
            "second raise must not lower soft ({soft_before} -> {soft_after})"
        );
    }
}
