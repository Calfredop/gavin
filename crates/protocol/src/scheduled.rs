//! Scheduled tasks (v77, ADR 0010): a copy of a task card that runs
//! unattended on a schedule of its own, off the board.
//!
//! Pure: the daemon reads the copies off disk and keeps their run state in
//! `kanban.sqlite`; this module is only the shapes both ends agree on and
//! the one-line `schedule:` rule each of them parses.
//!
//! The rule is written on the copy's frontmatter as one line of
//! `key=value` tokens:
//!
//! ```text
//! schedule: at=2026-10-21T09:00 every=2h runs=5
//! schedule: at=2026-10-21T09:00 every=1d runs=inf
//! schedule: at=2026-10-21T09:00
//! ```
//!
//! `at` is a wall-clock time on the machine that fires it, with no zone:
//! the human picked it in their own day, and a zone written into a
//! committed file would be some other machine's. `every` is a whole number
//! of minutes (`m`), hours (`h`), days (`d`) or weeks (`w`), at least one
//! minute. `runs` is how many fires the schedule has, or `inf`. With no
//! `every` it is a single shot and `runs` can only be 1; with one and no
//! `runs` it repeats indefinitely.
//!
//! Where the next fire falls is the app's to work out -- it is the one
//! that knows the local calendar -- on a fixed grid from `at`, never a
//! countdown from the last run.

use serde::{Deserialize, Serialize};

/// The unit of a repeating schedule's interval.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IntervalUnit {
    Minutes,
    Hours,
    Days,
    Weeks,
}

impl IntervalUnit {
    fn suffix(self) -> char {
        match self {
            IntervalUnit::Minutes => 'm',
            IntervalUnit::Hours => 'h',
            IntervalUnit::Days => 'd',
            IntervalUnit::Weeks => 'w',
        }
    }

    fn from_suffix(c: char) -> Option<Self> {
        match c {
            'm' => Some(IntervalUnit::Minutes),
            'h' => Some(IntervalUnit::Hours),
            'd' => Some(IntervalUnit::Days),
            'w' => Some(IntervalUnit::Weeks),
            _ => None,
        }
    }
}

/// "every N units".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Every {
    pub n: u32,
    pub unit: IntervalUnit,
}

/// A parsed `schedule:` line.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleRule {
    /// The first fire, `YYYY-MM-DDTHH:MM`, machine-local.
    pub at: String,
    /// None for a single shot.
    pub every: Option<Every>,
    /// How many fires in all; None is indefinite. Always `Some(1)` for a
    /// single shot.
    pub runs: Option<u32>,
}

/// The most fires a counted schedule may ask for. Far beyond any
/// schedule a person means, and well inside what the claim's counter and
/// a slot index hold.
pub const MAX_RUNS: u32 = 1_000_000;

/// The longest interval: a hundred years of weeks would overflow nothing,
/// but a number this large is a typo, not a schedule.
pub const MAX_EVERY: u32 = 100_000;

impl ScheduleRule {
    /// Parses a `schedule:` value. The error is a sentence for the human.
    pub fn parse(line: &str) -> Result<Self, String> {
        let mut at: Option<String> = None;
        let mut every: Option<Every> = None;
        let mut runs: Option<Option<u32>> = None;
        for token in line.split_whitespace() {
            let Some((key, value)) = token.split_once('=') else {
                return Err(format!("\"{token}\" is not key=value"));
            };
            match key {
                "at" => {
                    if at.is_some() {
                        return Err("at= is given twice".into());
                    }
                    parse_at(value)?;
                    at = Some(value.to_string());
                }
                "every" => {
                    if every.is_some() {
                        return Err("every= is given twice".into());
                    }
                    every = Some(parse_every(value)?);
                }
                "runs" => {
                    if runs.is_some() {
                        return Err("runs= is given twice".into());
                    }
                    runs = Some(parse_runs(value)?);
                }
                other => return Err(format!("unknown schedule key \"{other}\"")),
            }
        }
        let Some(at) = at else {
            return Err("a schedule needs a start (at=YYYY-MM-DDTHH:MM)".into());
        };
        let runs = match (every, runs) {
            (None, None) | (None, Some(Some(1))) => Some(1),
            (None, Some(_)) => {
                return Err("a schedule with no every= runs once (runs=1)".into());
            }
            (Some(_), None) => None,
            (Some(_), Some(r)) => r,
        };
        Ok(ScheduleRule { at, every, runs })
    }

    /// The line `parse` reads back to this rule.
    pub fn to_line(&self) -> String {
        let mut line = format!("at={}", self.at);
        if let Some(every) = self.every {
            line.push_str(&format!(" every={}{}", every.n, every.unit.suffix()));
            match self.runs {
                Some(n) => line.push_str(&format!(" runs={n}")),
                None => line.push_str(" runs=inf"),
            }
        }
        line
    }

    /// Whether `fire_count` fires have used the schedule up.
    pub fn completed(&self, fire_count: u32) -> bool {
        self.runs.is_some_and(|n| fire_count >= n)
    }

    /// The start as (year, month, day, hour, minute).
    pub fn start(&self) -> (i32, u32, u32, u32, u32) {
        parse_at(&self.at).expect("a parsed rule's at= is valid")
    }
}

fn parse_at(value: &str) -> Result<(i32, u32, u32, u32, u32), String> {
    let bad = || format!("\"{value}\" is not a start time (YYYY-MM-DDTHH:MM)");
    let b = value.as_bytes();
    if b.len() != 16
        || b[4] != b'-'
        || b[7] != b'-'
        || b[10] != b'T'
        || b[13] != b':'
        || ![0..4, 5..7, 8..10, 11..13, 14..16]
            .into_iter()
            .all(|r| b[r].iter().all(u8::is_ascii_digit))
    {
        return Err(bad());
    }
    let num = |r: std::ops::Range<usize>| value[r].parse::<u32>().map_err(|_| bad());
    let (y, mo, d, h, mi) = (num(0..4)?, num(5..7)?, num(8..10)?, num(11..13)?, num(14..16)?);
    if !(1..=12).contains(&mo) || d == 0 || d > days_in_month(y as i32, mo) || h > 23 || mi > 59 {
        return Err(bad());
    }
    Ok((y as i32, mo, d, h, mi))
}

fn days_in_month(year: i32, month: u32) -> u32 {
    match month {
        2 if (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

fn parse_every(value: &str) -> Result<Every, String> {
    let bad = || format!("\"{value}\" is not an interval (a number then m, h, d or w)");
    let unit = value.chars().last().and_then(IntervalUnit::from_suffix).ok_or_else(bad)?;
    let digits = &value[..value.len() - 1];
    if digits.is_empty() || !digits.bytes().all(|c| c.is_ascii_digit()) {
        return Err(bad());
    }
    let n: u32 = digits.parse().map_err(|_| bad())?;
    if n == 0 {
        return Err("the interval must be at least one minute".into());
    }
    if n > MAX_EVERY {
        return Err(bad());
    }
    Ok(Every { n, unit })
}

fn parse_runs(value: &str) -> Result<Option<u32>, String> {
    if value == "inf" {
        return Ok(None);
    }
    let bad = || format!("\"{value}\" is not a run count (a number, or inf)");
    if value.is_empty() || !value.bytes().all(|c| c.is_ascii_digit()) {
        return Err(bad());
    }
    let n: u32 = value.parse().map_err(|_| bad())?;
    if n == 0 || n > MAX_RUNS {
        return Err(bad());
    }
    Ok(Some(n))
}

/// A run report's stamp, `YYYYMMDD-HHMMSS` in the firing machine's local
/// time: what the report's file is named, so the folder lists in run
/// order. The app supplies it, since it is the end that knows the local
/// clock; the daemon refuses anything else rather than build a path from it.
pub fn valid_report_stamp(stamp: &str) -> bool {
    let b = stamp.as_bytes();
    b.len() == 15
        && b[8] == b'-'
        && b[..8].iter().all(u8::is_ascii_digit)
        && b[9..].iter().all(u8::is_ascii_digit)
}

/// The result headline of a Run report: its first line, when that is a
/// `#` heading, without the marks. None for a report that opens with
/// anything else -- the contract asks for the heading first, and a line
/// picked from further down would be a guess at what the run concluded.
pub fn report_headline(markdown: &str) -> Option<String> {
    let first = markdown.lines().find(|l| !l.trim().is_empty())?.trim();
    let text = first.strip_prefix('#')?.trim_start_matches('#').trim();
    (!text.is_empty()).then(|| text.chars().take(300).collect())
}

/// One Scheduled task: its copy on disk and its run state.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledTask {
    /// The copy's file, `.gavin-root/scheduled/<name>.md`.
    pub path: String,
    /// The file name's stem; what its reports' folder is named.
    pub name: String,
    pub title: String,
    #[serde(default)]
    pub agent: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    #[serde(default)]
    pub complexity: Option<String>,
    /// The file name of the card it was copied from, for display. The
    /// card may since have moved, been archived, or gone.
    #[serde(default)]
    pub from: Option<String>,
    /// The `schedule:` line as written; None for a task that was
    /// unscheduled and keeps only Run now.
    #[serde(default)]
    pub schedule: Option<String>,
    /// `schedule` parsed; None when it is absent or unreadable.
    #[serde(default)]
    pub rule: Option<ScheduleRule>,
    /// Why `schedule` could not be read, when it could not.
    #[serde(default)]
    pub schedule_error: Option<String>,
    pub paused: bool,
    /// The prompt: everything after the frontmatter.
    pub body: String,
    /// Fires counted against `rule.runs`, launched and skipped alike.
    /// "Run now" never counts. Zero again once the schedule is changed.
    pub fire_count: u32,
    /// The grid slot of the last counted fire; the next is past it.
    #[serde(default)]
    pub last_slot: Option<u64>,
    /// Newest first, at most [`FIRES_LISTED`].
    pub fires: Vec<ScheduledFire>,
}

/// How many fires a task's listing carries -- the same number of reports
/// the folder keeps.
pub const FIRES_LISTED: usize = 20;

/// One fire of a Scheduled task, or one "Run now".
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledFire {
    pub id: i64,
    /// The grid slot this fire claimed; None for a "Run now".
    #[serde(default)]
    pub slot: Option<u64>,
    /// When it was claimed, epoch seconds.
    pub at: i64,
    /// `launching` (claimed, its session not yet recorded), `running`,
    /// `exited`, `skipped` (with `skip_reason`), `failed` (the launch
    /// itself failed, with `skip_reason` saying why) or `abandoned` (it
    /// ended and nobody watched).
    pub outcome: String,
    #[serde(default)]
    pub skip_reason: Option<String>,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub exit_code: Option<i32>,
    #[serde(default)]
    pub ended_at: Option<i64>,
    /// Where the run was asked to write its Run report.
    #[serde(default)]
    pub report_path: Option<String>,
    /// The report's `#` headline, when it exists and opens with one.
    #[serde(default)]
    pub headline: Option<String>,
    pub has_report: bool,
    /// Whether the session's saved terminal text exists.
    pub has_raw: bool,
}

/// The answer to `ClaimScheduledFire`: whether this daemon won the fire,
/// and if it did, which row it is and where its report goes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FireClaim {
    pub claimed: bool,
    #[serde(default)]
    pub fire_id: Option<i64>,
    /// The fire's number among counted fires (1-based), or None for a
    /// "Run now".
    #[serde(default)]
    pub fire_number: Option<u32>,
    #[serde(default)]
    pub report_path: Option<String>,
    /// Recorded as skipped, by the daemon or with the reason the app
    /// handed in: claimed, but nothing is to be launched.
    #[serde(default)]
    pub skipped: Option<String>,
    /// Why the claim was refused, when it was.
    #[serde(default)]
    pub why: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_single_shot_is_a_start_alone() {
        let rule = ScheduleRule::parse("at=2026-10-21T09:00").unwrap();
        assert_eq!(rule, ScheduleRule { at: "2026-10-21T09:00".into(), every: None, runs: Some(1) });
        assert_eq!(rule.to_line(), "at=2026-10-21T09:00");
        assert_eq!(ScheduleRule::parse("runs=1 at=2026-10-21T09:00").unwrap(), rule);
    }

    #[test]
    fn a_repeat_has_an_interval_and_a_count_or_none() {
        let rule = ScheduleRule::parse("at=2026-10-21T09:00 every=2h runs=5").unwrap();
        assert_eq!(rule.every, Some(Every { n: 2, unit: IntervalUnit::Hours }));
        assert_eq!(rule.runs, Some(5));
        assert_eq!(rule.to_line(), "at=2026-10-21T09:00 every=2h runs=5");

        let forever = ScheduleRule::parse("every=1w at=2026-10-21T09:00").unwrap();
        assert_eq!(forever.runs, None);
        assert_eq!(forever.to_line(), "at=2026-10-21T09:00 every=1w runs=inf");
        assert_eq!(ScheduleRule::parse(&forever.to_line()).unwrap(), forever);
        assert_eq!(
            ScheduleRule::parse("at=2026-10-21T09:00 every=30m runs=inf").unwrap().runs,
            None
        );
    }

    #[test]
    fn completion_counts_fires_against_runs() {
        let rule = ScheduleRule::parse("at=2026-10-21T09:00 every=2m runs=3").unwrap();
        assert!(!rule.completed(2));
        assert!(rule.completed(3));
        let once = ScheduleRule::parse("at=2026-10-21T09:00").unwrap();
        assert!(!once.completed(0));
        assert!(once.completed(1));
        assert!(!ScheduleRule::parse("at=2026-10-21T09:00 every=1d").unwrap().completed(u32::MAX));
    }

    #[test]
    fn malformed_rules_are_refused_with_a_reason() {
        for bad in [
            "",
            "every=2h",
            "at=2026-10-21 09:00",
            "at=2026-13-01T09:00",
            "at=2026-02-30T09:00",
            "at=2026-10-21T24:00",
            "at=2026-10-21T09:00 every=0m",
            "at=2026-10-21T09:00 every=2",
            "at=2026-10-21T09:00 every=2s",
            "at=2026-10-21T09:00 every=-2h",
            "at=2026-10-21T09:00 runs=3",
            "at=2026-10-21T09:00 every=1h runs=0",
            "at=2026-10-21T09:00 every=1h runs=many",
            "at=2026-10-21T09:00 at=2026-10-22T09:00",
            "at=2026-10-21T09:00 cron=*",
            "at=2026-10-21T09:00 junk",
        ] {
            assert!(ScheduleRule::parse(bad).is_err(), "{bad:?} parsed");
        }
        assert!(ScheduleRule::parse("at=2028-02-29T09:00").is_ok(), "leap day");
    }

    #[test]
    fn the_start_reads_back_as_numbers() {
        let rule = ScheduleRule::parse("at=2026-10-21T09:05").unwrap();
        assert_eq!(rule.start(), (2026, 10, 21, 9, 5));
    }

    #[test]
    fn report_stamps_are_digits_in_one_shape() {
        assert!(valid_report_stamp("20261021-090500"));
        for bad in ["2026102-090500", "20261021_090500", "20261021-0905000", "../../etc-passwd", "2026102a-090500"] {
            assert!(!valid_report_stamp(bad), "{bad}");
        }
    }

    #[test]
    fn a_headline_is_the_opening_heading_only() {
        assert_eq!(report_headline("# Tests green\n\nDid things").as_deref(), Some("Tests green"));
        assert_eq!(report_headline("\n\n## Nothing to do  \n").as_deref(), Some("Nothing to do"));
        assert_eq!(report_headline("Did things\n# Late heading"), None);
        assert_eq!(report_headline("#\n"), None);
        assert_eq!(report_headline(""), None);
    }
}
