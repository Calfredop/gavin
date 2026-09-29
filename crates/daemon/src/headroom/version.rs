//! Which Headroom gavin will start: the floor, the pin, and the state a
//! found version lands in.
//!
//! Gavin depends on Headroom's CLI flags, environment names, HTTP
//! endpoints and URL conventions, and Headroom is pre-1.0 and released
//! roughly weekly. So there are two lines. The FLOOR is the oldest
//! version gavin will execute at all; the PIN is the one it installs and
//! was tested against. Anything above the pin still runs -- refusing a
//! newer Headroom would break the human's own upgrade -- but it says so.

use std::fmt;

/// The oldest Headroom gavin will start.
///
/// 0.38.0 is where PR #3556 moved per-request state into context-local
/// storage, which is the fix for #3549: state leaking between two
/// compressions running at once. A fleet is nothing but concurrent
/// compressions, so below this line one agent's tool output can reach
/// another agent's model.
pub const FLOOR: Version = Version::release(0, 38, 0);

/// The Headroom gavin installs, and the one the concurrency probe and
/// the recipe tests were run against. Moving it re-runs both.
pub const PIN: Version = Version::release(0, 39, 1);

/// A Headroom version: three numbers, and whether anything followed
/// them.
///
/// The ordering is derived, so the field order IS the rule: the three
/// numbers decide, and between two versions with the same numbers the
/// pre-release is the older one. `0.38.0rc1` is below the floor, which
/// is the point of carrying the flag at all -- a release candidate of
/// the fix is not the fix.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct Version {
    major: u32,
    minor: u32,
    patch: u32,
    /// False for `rc`, `a`, `b` and `.dev` builds. Ordered last and
    /// false-first, so a pre-release sorts under its own release.
    released: bool,
    /// What followed the numbers, kept only so the version reads back
    /// the way Headroom printed it.
    suffix: Suffix,
}

/// A pre-release tag, held inline so `Version` stays `Copy`. Compared
/// but never decisive in practice: two pre-releases of one version are
/// both below every line gavin draws.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct Suffix {
    bytes: [u8; Suffix::MAX],
    len: u8,
}

impl Suffix {
    const MAX: usize = 16;
    const NONE: Suffix = Suffix { bytes: [0; Suffix::MAX], len: 0 };

    fn new(text: &str) -> Option<Suffix> {
        if text.len() > Suffix::MAX || !text.is_ascii() {
            return None;
        }
        let mut bytes = [0; Suffix::MAX];
        bytes[..text.len()].copy_from_slice(text.as_bytes());
        Some(Suffix { bytes, len: text.len() as u8 })
    }

    fn as_str(&self) -> &str {
        std::str::from_utf8(&self.bytes[..self.len as usize]).unwrap_or("")
    }
}

impl Version {
    pub const fn release(major: u32, minor: u32, patch: u32) -> Version {
        Version { major, minor, patch, released: true, suffix: Suffix::NONE }
    }

    /// `X.Y.Z`, optionally followed by a PEP 440 pre-release tag
    /// (`rc1`, `a2`, `b1`, `.dev3`). Anything else is not a version
    /// gavin can place against the floor, and is refused rather than
    /// guessed at.
    pub fn parse(text: &str) -> Option<Version> {
        let mut parts = text.trim().splitn(3, '.');
        let major = parts.next()?.parse().ok()?;
        let minor = parts.next()?.parse().ok()?;
        let rest = parts.next()?;
        let digits = rest.chars().take_while(char::is_ascii_digit).count();
        if digits == 0 {
            return None;
        }
        let patch = rest[..digits].parse().ok()?;
        let tail = &rest[digits..];
        if tail.is_empty() {
            return Some(Version::release(major, minor, patch));
        }
        let tag = tail.trim_start_matches('.');
        let named = ["rc", "a", "b", "dev"].iter().any(|kind| {
            tag.strip_prefix(kind)
                .is_some_and(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()))
        });
        if !named {
            return None;
        }
        Some(Version { major, minor, patch, released: false, suffix: Suffix::new(tail)? })
    }

    /// The same three numbers, as a release. What "above the pin" is
    /// measured on: `0.40.0rc1` is past 0.39.1 whatever follows it.
    fn numbers(self) -> (u32, u32, u32) {
        (self.major, self.minor, self.patch)
    }
}

impl fmt::Display for Version {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}.{}.{}{}", self.major, self.minor, self.patch, self.suffix.as_str())
    }
}

/// The version in what `headroom --version` printed: a line reading
/// `headroom, version X.Y.Z`.
///
/// Searched for by line rather than taken from the first one, because a
/// Python CLI can print a warning ahead of its own output. And matched
/// on the whole prefix, because `headroom` is a name other programs can
/// have -- one that answers `--version` some other way is not this
/// Headroom.
pub fn read_version_output(stdout: &str) -> Option<Version> {
    stdout
        .lines()
        .find_map(|line| line.trim().strip_prefix("headroom, version "))
        .and_then(Version::parse)
}

/// Where a Headroom stands. There is no "asserted": gavin has to execute
/// it, and the human's word does not name a file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    /// Found at or above the floor.
    Verified { newer_than_tested: bool },
    /// Found below the floor. Gavin will not start it.
    TooOld,
    /// Not found.
    Absent,
    /// Not on this platform, with the reason.
    Unavailable(&'static str),
}

impl State {
    /// The word `HeadroomStatus.state` carries.
    pub fn id(self) -> &'static str {
        match self {
            State::Verified { .. } => "verified",
            State::TooOld => "too-old",
            State::Absent => "absent",
            State::Unavailable(_) => "unavailable",
        }
    }

    pub fn startable(self) -> bool {
        matches!(self, State::Verified { .. })
    }
}

/// Why Headroom cannot run on this platform, or `None` where it can.
///
/// v1 is macOS on Apple Silicon and Linux. Takes the platform as
/// arguments -- `std::env::consts::OS` and `ARCH` -- so every row can be
/// tested from one machine.
pub fn platform_unavailable(os: &str, arch: &str) -> Option<&'static str> {
    match (os, arch) {
        ("windows", _) => Some(
            "Headroom is not available on Windows yet: its proxy has an open outage there.",
        ),
        ("macos", "x86_64") => Some(
            "Headroom is not available on Intel Macs yet: its onnxruntime dependency ships no Intel Mac wheels.",
        ),
        _ => None,
    }
}

/// The state table. The platform outranks whatever was found: a
/// Headroom on a machine gavin cannot run it on is still unavailable.
pub fn state_for(unavailable: Option<&'static str>, found: Option<Version>) -> State {
    if let Some(reason) = unavailable {
        return State::Unavailable(reason);
    }
    match found {
        None => State::Absent,
        Some(version) if version < FLOOR => State::TooOld,
        Some(version) => State::Verified { newer_than_tested: version.numbers() > PIN.numbers() },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(text: &str) -> Version {
        Version::parse(text).unwrap_or_else(|| panic!("{text} should parse"))
    }

    #[test]
    fn the_floor_and_the_pin_are_the_ones_the_spec_names() {
        assert_eq!(FLOOR.to_string(), "0.38.0");
        assert_eq!(PIN.to_string(), "0.39.1");
        assert!(FLOOR <= PIN, "a pin below the floor would install a version gavin refuses to start");
    }

    #[test]
    fn version_output_is_read_in_the_shape_headroom_prints_it() {
        assert_eq!(read_version_output("headroom, version 0.39.1\n"), Some(v("0.39.1")));
        // A warning printed ahead of the line must not hide it.
        assert_eq!(
            read_version_output("UserWarning: something\nheadroom, version 0.38.0\n"),
            Some(v("0.38.0"))
        );
        assert_eq!(read_version_output(""), None);
        assert_eq!(read_version_output("headroom 0.39.1"), None);
        // Another program that happens to be called headroom.
        assert_eq!(read_version_output("Headroom Audio Tools v3\n"), None);
    }

    #[test]
    fn a_pre_release_sorts_below_the_release_it_precedes() {
        assert!(v("0.38.0rc1") < v("0.38.0"));
        assert!(v("0.38.0.dev3") < v("0.38.0"));
        assert!(v("0.37.9") < v("0.38.0rc1"));
        assert_eq!(v("0.38.0rc1").to_string(), "0.38.0rc1");
    }

    #[test]
    fn a_version_that_is_not_three_numbers_does_not_parse() {
        for text in ["", "0.39", "v0.39.1", "0.x.1", "latest", "0.39.1.2.3.4"] {
            assert_eq!(Version::parse(text), None, "{text:?}");
        }
    }

    /// The state table, at, below and above both lines.
    #[test]
    fn the_state_table_is_right_at_below_and_above_the_floor_and_the_pin() {
        let verified = |newer| State::Verified { newer_than_tested: newer };
        let rows = [
            ("0.37.9", State::TooOld),
            ("0.38.0rc1", State::TooOld),
            ("0.38.0", verified(false)),
            ("0.38.5", verified(false)),
            ("0.39.0", verified(false)),
            ("0.39.1", verified(false)),
            ("0.39.2", verified(true)),
            ("0.40.0", verified(true)),
            ("1.0.0", verified(true)),
        ];
        for (found, expected) in rows {
            assert_eq!(state_for(None, Some(v(found))), expected, "{found}");
        }
        assert_eq!(state_for(None, None), State::Absent);
    }

    /// A release candidate of the version AFTER the pin is newer than
    /// tested, not the pin.
    #[test]
    fn a_pre_release_above_the_pin_is_newer_than_tested() {
        assert_eq!(
            state_for(None, Some(v("0.40.0rc1"))),
            State::Verified { newer_than_tested: true }
        );
    }

    #[test]
    fn an_unavailable_platform_outranks_anything_found_on_it() {
        let reason = platform_unavailable("macos", "x86_64").unwrap();
        assert_eq!(state_for(Some(reason), Some(v("0.39.1"))), State::Unavailable(reason));
        assert_eq!(state_for(Some(reason), None), State::Unavailable(reason));
    }

    #[test]
    fn intel_macs_and_windows_are_unavailable_and_say_why() {
        assert!(platform_unavailable("macos", "x86_64").unwrap().contains("Intel"));
        assert!(platform_unavailable("windows", "x86_64").unwrap().contains("Windows"));
        assert!(platform_unavailable("windows", "aarch64").unwrap().contains("Windows"));
        assert_eq!(platform_unavailable("macos", "aarch64"), None);
        assert_eq!(platform_unavailable("linux", "x86_64"), None);
        assert_eq!(platform_unavailable("linux", "aarch64"), None);
    }

    #[test]
    fn every_state_has_the_word_the_wire_carries() {
        assert_eq!(State::Verified { newer_than_tested: false }.id(), "verified");
        assert_eq!(State::Verified { newer_than_tested: true }.id(), "verified");
        assert_eq!(State::TooOld.id(), "too-old");
        assert_eq!(State::Absent.id(), "absent");
        assert_eq!(State::Unavailable("x").id(), "unavailable");
    }

    #[test]
    fn only_a_verified_headroom_may_be_started() {
        assert!(State::Verified { newer_than_tested: false }.startable());
        assert!(State::Verified { newer_than_tested: true }.startable());
        assert!(!State::TooOld.startable());
        assert!(!State::Absent.startable());
        assert!(!State::Unavailable("x").startable());
    }
}
