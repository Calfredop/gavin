//! Time, behind a trait so the suites can move it: a permission's expiry
//! and the per-Device rate limit are both questions about the clock, and a
//! test that slept through either would be the slowest thing in the tree.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

pub trait Clock: Send + Sync {
    /// Milliseconds since the Unix epoch.
    fn now_ms(&self) -> u64;

    fn now_s(&self) -> u64 {
        self.now_ms() / 1000
    }
}

pub struct SystemClock;

impl Clock for SystemClock {
    fn now_ms(&self) -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    }
}

/// A clock that only moves when told to.
pub struct ManualClock(AtomicU64);

impl ManualClock {
    pub fn at_ms(ms: u64) -> ManualClock {
        ManualClock(AtomicU64::new(ms))
    }

    pub fn advance_ms(&self, ms: u64) {
        self.0.fetch_add(ms, Ordering::SeqCst);
    }

    pub fn advance_s(&self, s: u64) {
        self.advance_ms(s * 1000);
    }
}

impl Clock for ManualClock {
    fn now_ms(&self) -> u64 {
        self.0.load(Ordering::SeqCst)
    }
}
