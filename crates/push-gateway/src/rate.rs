//! The per-Device rate limit.
//!
//! Keyed by Device, not by permission: a Device paired with five
//! Workstations gets one allowance between them, so a compromised
//! Workstation holding a valid permission can spend that Device's
//! allowance and no more. It is checked only after a permission verifies,
//! so nobody without one can spend a Device's allowance at all.
//!
//! A generic cell rate algorithm: `burst` pushes at once, then one every
//! `interval`. Each Device costs one timestamp. It lives in memory, so a
//! restart forgets it, and the gateway runs as a single instance.

use crate::id::Id;
use std::collections::HashMap;
use std::sync::Mutex;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RateLimit {
    pub burst: u32,
    pub interval_ms: u64,
}

impl RateLimit {
    pub fn per_hour(burst: u32, per_hour: u32) -> RateLimit {
        RateLimit { burst: burst.max(1), interval_ms: 3_600_000 / u64::from(per_hour.max(1)) }
    }
}

pub struct Limiter {
    limit: RateLimit,
    /// The theoretical arrival time of each Device's next push.
    next: Mutex<HashMap<Id, u64>>,
}

impl Limiter {
    pub fn new(limit: RateLimit) -> Limiter {
        Limiter { limit, next: Mutex::new(HashMap::new()) }
    }

    /// Spends one push of this Device's allowance, or says how many
    /// milliseconds until one is available.
    pub fn take(&self, device: Id, now_ms: u64) -> Result<(), u64> {
        let tolerance = u64::from(self.limit.burst - 1) * self.limit.interval_ms;
        let mut next = self.next.lock().unwrap();
        let tat = next.get(&device).copied().unwrap_or(0).max(now_ms);
        if tat - now_ms > tolerance {
            return Err(tat - now_ms - tolerance);
        }
        next.insert(device, tat + self.limit.interval_ms);
        Ok(())
    }

    /// Forgets every Device whose allowance is full again: for those, no
    /// entry and an old entry mean the same thing.
    pub fn prune(&self, now_ms: u64) {
        self.next.lock().unwrap().retain(|_, tat| *tat > now_ms);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_burst_then_one_per_interval() {
        let limiter = Limiter::new(RateLimit { burst: 3, interval_ms: 1000 });
        let device = Id::random();
        for _ in 0..3 {
            assert_eq!(limiter.take(device, 10_000), Ok(()));
        }
        assert_eq!(limiter.take(device, 10_000), Err(1000));
        assert_eq!(limiter.take(device, 10_999), Err(1));
        assert_eq!(limiter.take(device, 11_000), Ok(()));
        assert_eq!(limiter.take(device, 11_000), Err(1000));
    }

    #[test]
    fn devices_do_not_share_an_allowance() {
        let limiter = Limiter::new(RateLimit { burst: 1, interval_ms: 1000 });
        let (a, b) = (Id::random(), Id::random());
        assert_eq!(limiter.take(a, 0), Ok(()));
        assert!(limiter.take(a, 0).is_err());
        assert_eq!(limiter.take(b, 0), Ok(()));
    }

    #[test]
    fn a_quiet_device_gets_its_whole_burst_back_and_is_pruned() {
        let limiter = Limiter::new(RateLimit { burst: 2, interval_ms: 1000 });
        let device = Id::random();
        limiter.take(device, 0).unwrap();
        limiter.take(device, 0).unwrap();
        limiter.prune(1_000);
        assert_eq!(limiter.next.lock().unwrap().len(), 1);
        limiter.prune(2_000);
        assert!(limiter.next.lock().unwrap().is_empty());
        assert_eq!(limiter.take(device, 2_000), Ok(()));
        assert_eq!(limiter.take(device, 2_000), Ok(()));
    }

    #[test]
    fn per_hour_never_divides_by_zero() {
        assert_eq!(RateLimit::per_hour(0, 0), RateLimit { burst: 1, interval_ms: 3_600_000 });
        assert_eq!(RateLimit::per_hour(30, 240), RateLimit { burst: 30, interval_ms: 15_000 });
    }
}
