//! What GitHub says about the pull request for a branch, read with `gh`.
//!
//! One probe, two readers: the rail header's PR chips and the scheduler's
//! `pr` step both take their answer from here. That is the whole reason
//! this is host-side rather than a `gh` running in the step's own shell --
//! a poller for the chips and a second poller for the verdict would be
//! two things able to disagree about the same pull request, and the one
//! the human is looking at is not the one the rail is deciding on.
//!
//! Reading only. Nothing here opens, closes, approves or merges a PR:
//! merging stays the human's action, and a probe that could change the
//! thing it observes is a probe nobody can leave running.

use std::collections::HashMap;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Long enough for a cold `gh` to authenticate and answer, short enough
/// that a hung network does not hold a poll slot for a minute. The Git
/// tab's own read-only ceiling is 10s (git/run.rs); this doubles it
/// because every call here crosses the network, which none of those do.
const GH_TIMEOUT: Duration = Duration::from_secs(20);

/// The floor between two real calls for the same branch. The poll asks
/// far more often than this -- every reader that wakes asks -- and this
/// is what turns that into one request a minute per rail rather than one
/// per store emission. GitHub's REST budget is 5000/hour, so a human
/// watching six rails spends about 1% of it.
const MIN_INTERVAL_SECS: i64 = 60;

/// How long a failure is believed before gavin tries again. Shorter than
/// the freshness floor on purpose: a `gh` that failed because the laptop
/// was asleep should recover on the next poll, not a minute later. The
/// two rates the floor exists to limit are successful calls.
const ERROR_INTERVAL_SECS: i64 = 20;

/// The fields one call asks for. Deliberately one call and not two: `gh
/// pr checks` and `gh pr view` would be two round trips describing the
/// same PR at two instants, and a chip row that mixed them could show a
/// green check rollup beside a review decision from thirty seconds ago.
const PR_FIELDS: &str =
    "number,url,title,state,isDraft,headRefName,reviewDecision,mergeable,createdAt,statusCheckRollup";

/// Where `gh` is looked for when it is not on PATH.
///
/// A Finder-launched app inherits the stripped login PATH, which has
/// /usr/bin (where git lives, so the Git tab has never needed this) and
/// not /opt/homebrew/bin (where gh lives on every Apple-silicon machine
/// that installed it the usual way). Running under `npm run tauri dev`
/// the PATH is the terminal's and everything works -- which is exactly
/// how this ships broken and is only found in the bundle.
const GH_FALLBACKS: [&str; 3] = ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh"];

/// One CI check as the chips and the retry prompt need it. A rollup entry
/// is either a check run or a commit status and the two spell their
/// verdict differently; both are normalised into `state` here so nothing
/// downstream has to know which it was looking at.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrCheck {
    pub name: String,
    /// "success" | "failure" | "pending" | "skipped" | "cancelled" |
    /// "unknown". Lower case, so the TS side matches on one spelling.
    pub state: String,
    /// The run's own page, for a human who wants the log. Empty when the
    /// rollup did not carry one.
    pub url: String,
}

/// What one probe came back with.
///
/// A tagged union rather than an `Option`, on the same reasoning
/// `UsageReport` gives: "this checkout has no PR for that branch", "gh is
/// not installed" and "gh could not reach GitHub" are three different
/// sentences to put in front of somebody, and a step must not treat the
/// last one the way it treats the first.
#[derive(Clone, serde::Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum PrReport {
    /// A pull request exists and this is it.
    Ready {
        number: i64,
        url: String,
        title: String,
        /// "OPEN" | "CLOSED" | "MERGED", as GitHub spells it.
        pr_state: String,
        is_draft: bool,
        /// "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | "", the
        /// last meaning the repo asks for no review at all. Empty rather
        /// than null so the TS side has one falsy spelling to test.
        review_decision: String,
        /// "MERGEABLE" | "CONFLICTING" | "UNKNOWN".
        mergeable: String,
        /// When GitHub says the PR was opened, epoch seconds, or 0 when
        /// it did not say. Load-bearing rather than decorative: an EMPTY
        /// check rollup means "this repo runs no CI" and also "GitHub has
        /// not registered the workflow runs yet", and the only thing
        /// telling those apart is how new the PR is (see the grace period
        /// in pullRequest.ts). Reading a seconds-old empty rollup as a
        /// pass advances the rail past CI that had not started.
        created_at: i64,
        checks: Vec<PrCheck>,
        /// Epoch seconds when this was actually read from GitHub. The age
        /// the chips show, and it is the READ instant rather than the
        /// cache hit -- a cached answer wearing a fresh timestamp is a
        /// lie about how much the human can trust it.
        observed_at: i64,
        cached: bool,
    },
    /// `gh` answered and there is no pull request for that branch. Not an
    /// error: it is the state every branch starts in, and it is what a
    /// wait step waits through before `builtin:open-pr` has run.
    None,
    /// `gh` is not installed, or not on a PATH this process can see.
    /// Terminal: polling again will not install it.
    Missing { reason: String },
    /// There is a `gh` and it could not answer -- offline, unauthenticated,
    /// not a GitHub remote, rate-limited. Retryable, unlike `Missing`.
    Unavailable { reason: String },
}

fn now_secs() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

// ---- The cache --------------------------------------------------------------

struct Entry {
    report: PrReport,
    /// When the probe last actually RAN, which paces calls -- distinct
    /// from the report's `observed_at`, which is when its data was true.
    fetched_at: i64,
}

/// Keyed by checkout AND branch: one rail's worktree can be asked about a
/// branch it is not on (the chips read the rail's BINDING, which is what
/// the human bound rather than what git happens to have checked out).
#[derive(Default)]
pub struct PrCache(Mutex<HashMap<String, Entry>>);

impl PrCache {
    pub fn new() -> Self {
        Self::default()
    }
}

// ---- Running gh -------------------------------------------------------------

struct Run {
    stdout: String,
    stderr: String,
    code: i32,
}

/// The `gh` to run: the one on PATH if there is one, else the first
/// well-known location that exists. Resolved per call rather than once,
/// because "I have just installed gh" must not need an app restart.
fn gh_binary() -> String {
    // PATH first: a machine with two gh installs should use the one its
    // shell would, and the fallbacks are a rescue rather than a policy.
    if on_path("gh") {
        return "gh".to_string();
    }
    for path in GH_FALLBACKS {
        if Path::new(path).is_file() {
            return path.to_string();
        }
    }
    // Nothing found. Spawning it anyway is deliberate: the NotFound arm
    // of the spawn below is the single place this turns into the
    // `Missing` report, so there is one spelling of "there is no gh".
    "gh".to_string()
}

fn on_path(name: &str) -> bool {
    std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).any(|dir| dir.join(name).is_file()))
        .unwrap_or(false)
}

/// Runs `gh` in `cwd` with the pipes drained on threads -- the same
/// deadlock avoidance git/run.rs documents: a child that fills a pipe
/// buffer blocks forever if the parent waits before reading, and a PR
/// with two hundred checks fills one.
fn run_gh(cwd: &str, args: &[&str]) -> Result<Run, String> {
    if !Path::new(cwd).is_dir() {
        return Err(format!("directory not found: {cwd}"));
    }
    let bin = gh_binary();
    let mut child = Command::new(&bin)
        .args(args)
        .current_dir(cwd)
        // gh prompts for auth when it has none and a tty; there is no tty
        // here, but a child that decides to ask anyway must hit EOF
        // rather than block until the deadline.
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // gh colours and boxes its output when it thinks a human is
        // reading. Nothing here parses that, but an error message quoted
        // into a chip must not arrive full of escape sequences.
        .env("NO_COLOR", "1")
        .env("GH_PROMPT_DISABLED", "1")
        .spawn()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                GH_NOT_FOUND.to_string()
            } else {
                format!("failed to run gh: {e}")
            }
        })?;

    let mut out_pipe = child.stdout.take().ok_or("stdout unavailable")?;
    let mut err_pipe = child.stderr.take().ok_or("stderr unavailable")?;
    let (out_tx, out_rx) = std::sync::mpsc::channel();
    let (err_tx, err_rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = out_pipe.read_to_end(&mut buf);
        let _ = out_tx.send(String::from_utf8_lossy(&buf).into_owned());
    });
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = err_pipe.read_to_end(&mut buf);
        let _ = err_tx.send(String::from_utf8_lossy(&buf).into_owned());
    });

    let deadline = Instant::now() + GH_TIMEOUT;
    let code = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.code().unwrap_or(-1),
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!("gh timed out after {}s", GH_TIMEOUT.as_secs()));
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(e) => return Err(format!("failed to wait for gh: {e}")),
        }
    };
    Ok(Run {
        stdout: out_rx.recv().unwrap_or_default(),
        stderr: err_rx.recv().unwrap_or_default(),
        code,
    })
}

pub const GH_NOT_FOUND: &str = "gh was not found on PATH";

/// Whether `gh`'s complaint is "there is no PR for this branch" rather
/// than a fault. gh exits 1 for both, and only its message tells them
/// apart -- so this matches on the message, and anything unrecognised
/// stays an error. Reading an unknown failure as "no PR" would make a
/// wait step wait forever on a repo it cannot reach.
fn is_no_pr(stderr: &str) -> bool {
    let said = stderr.to_ascii_lowercase();
    said.contains("no pull requests found") || said.contains("no open pull requests found")
}

// ---- Parsing ----------------------------------------------------------------

/// One rollup entry's verdict, normalised. GitHub sends check runs with a
/// `conclusion` (once they finish) and a `status` (before that), and
/// commit statuses with a `state` instead; all three are folded here so
/// no reader has to know which shape it received.
fn check_state(entry: &serde_json::Value) -> String {
    // A commit status: `state` is SUCCESS / FAILURE / PENDING / ERROR.
    if let Some(state) = entry.get("state").and_then(|v| v.as_str()) {
        return match state.to_ascii_uppercase().as_str() {
            "SUCCESS" => "success",
            "FAILURE" | "ERROR" => "failure",
            "PENDING" | "EXPECTED" => "pending",
            _ => "unknown",
        }
        .to_string();
    }
    // A check run that has finished carries a conclusion; one still going
    // carries only a status, and "no conclusion yet" is `pending` rather
    // than `unknown` -- the difference between "still running" and
    // "gavin does not understand this", which the chips draw apart.
    let conclusion = entry.get("conclusion").and_then(|v| v.as_str()).unwrap_or("");
    if conclusion.is_empty() {
        let status = entry.get("status").and_then(|v| v.as_str()).unwrap_or("");
        return match status.to_ascii_uppercase().as_str() {
            "COMPLETED" => "unknown",
            "" => "unknown",
            _ => "pending",
        }
        .to_string();
    }
    match conclusion.to_ascii_uppercase().as_str() {
        "SUCCESS" | "NEUTRAL" => "success",
        "FAILURE" | "TIMED_OUT" | "ACTION_REQUIRED" | "STARTUP_FAILURE" => "failure",
        "CANCELLED" | "STALE" => "cancelled",
        "SKIPPED" => "skipped",
        _ => "unknown",
    }
    .to_string()
}

/// `2026-09-03T12:34:56Z` as epoch seconds, or 0.
///
/// Hand-rolled rather than a dependency: GitHub emits exactly one shape
/// here (UTC, `Z`-suffixed, second precision) and this crate carries no
/// date library. Anything else -- an offset, a missing field, a value
/// that is not a number -- answers 0, which every caller already has to
/// handle as "GitHub did not say".
fn parse_rfc3339(text: &str) -> i64 {
    let bytes = text.as_bytes();
    if bytes.len() < 19 || bytes[4] != b'-' || bytes[7] != b'-' || bytes[10] != b'T' {
        return 0;
    }
    let num = |from: usize, to: usize| text[from..to].parse::<i64>().ok();
    let (Some(year), Some(month), Some(day)) = (num(0, 4), num(5, 7), num(8, 10)) else {
        return 0;
    };
    let (Some(hour), Some(minute), Some(second)) = (num(11, 13), num(14, 16), num(17, 19)) else {
        return 0;
    };
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return 0;
    }
    // Howard Hinnant's days_from_civil: the standard branch-free civil
    // calendar conversion, valid for any proleptic Gregorian date.
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    days * 86_400 + hour * 3_600 + minute * 60 + second
}

fn check_name(entry: &serde_json::Value) -> String {
    // `name` on a check run, `context` on a commit status.
    entry
        .get("name")
        .and_then(|v| v.as_str())
        .or_else(|| entry.get("context").and_then(|v| v.as_str()))
        .unwrap_or("check")
        .to_string()
}

fn check_url(entry: &serde_json::Value) -> String {
    for key in ["detailsUrl", "targetUrl", "url"] {
        if let Some(url) = entry.get(key).and_then(|v| v.as_str()) {
            if !url.is_empty() {
                return url.to_string();
            }
        }
    }
    String::new()
}

/// `gh`'s JSON turned into a report, or an `Unavailable` naming what it
/// could not read. Split out from the call so the shapes GitHub actually
/// sends are testable without a network.
pub fn parse_pr_json(raw: &str, now: i64) -> PrReport {
    let value: serde_json::Value = match serde_json::from_str(raw) {
        Ok(v) => v,
        Err(e) => return PrReport::Unavailable { reason: format!("gh returned unreadable JSON: {e}") },
    };
    // gh answers a branch with no PR as an empty array on some paths and
    // an error on others; both mean the same thing.
    if value.as_array().is_some_and(|a| a.is_empty()) || value.is_null() {
        return PrReport::None;
    }
    // `--json` on a single PR gives an object; be tolerant of the array
    // shape a list query would give, and take the first.
    let pr = value.as_array().and_then(|a| a.first()).unwrap_or(&value);
    let number = match pr.get("number").and_then(|v| v.as_i64()) {
        Some(n) => n,
        None => return PrReport::None,
    };
    let str_at = |key: &str| pr.get(key).and_then(|v| v.as_str()).unwrap_or("").to_string();
    let checks = pr
        .get("statusCheckRollup")
        .and_then(|v| v.as_array())
        .map(|entries| {
            entries
                .iter()
                .map(|entry| PrCheck {
                    name: check_name(entry),
                    state: check_state(entry),
                    url: check_url(entry),
                })
                .collect()
        })
        .unwrap_or_default();
    PrReport::Ready {
        number,
        url: str_at("url"),
        title: str_at("title"),
        pr_state: str_at("state"),
        is_draft: pr.get("isDraft").and_then(|v| v.as_bool()).unwrap_or(false),
        review_decision: str_at("reviewDecision"),
        created_at: parse_rfc3339(&str_at("createdAt")),
        // GitHub stopped computing `mergeable` eagerly; UNKNOWN is a real
        // answer meaning "ask again", not a parse failure.
        mergeable: {
            let said = str_at("mergeable");
            if said.is_empty() { "UNKNOWN".to_string() } else { said }
        },
        checks,
        observed_at: now,
        cached: false,
    }
}

// ---- The command ------------------------------------------------------------

/// The pull request for `branch` in the checkout at `cwd`.
///
/// `force` skips the freshness floor for a human who pressed refresh. It
/// cannot skip the timeout or make an unauthenticated `gh` answer, and it
/// is deliberately not what the scheduler passes: a rail polling a PR
/// every tick would be a rail hammering GitHub.
#[tauri::command]
pub fn pr_status(
    cache: tauri::State<'_, PrCache>,
    cwd: String,
    branch: String,
    force: bool,
) -> PrReport {
    let key = format!("{cwd}\u{0}{branch}");
    let now = now_secs();

    {
        let map = cache.0.lock().unwrap();
        if let Some(entry) = map.get(&key) {
            // A failure is believed for a shorter time than a success:
            // see ERROR_INTERVAL_SECS. `Missing` is terminal and honours
            // the long floor -- gh does not appear while the app runs.
            let floor = match entry.report {
                PrReport::Unavailable { .. } => ERROR_INTERVAL_SECS,
                _ => MIN_INTERVAL_SECS,
            };
            if now - entry.fetched_at < floor && !force {
                return entry.report.clone().as_cached();
            }
        }
    }

    let report = probe(&cwd, &branch, now);
    let mut map = cache.0.lock().unwrap();
    map.insert(key, Entry { report: report.clone(), fetched_at: now });
    report
}

fn probe(cwd: &str, branch: &str, now: i64) -> PrReport {
    if branch.trim().is_empty() {
        return PrReport::None;
    }
    // The branch is passed as its own argv element, never interpolated
    // into a string: a branch name is human-typed and git allows a great
    // deal in one.
    let run = match run_gh(cwd, &["pr", "view", branch, "--json", PR_FIELDS]) {
        Ok(run) => run,
        Err(e) if e == GH_NOT_FOUND => return PrReport::Missing { reason: e },
        Err(e) => return PrReport::Unavailable { reason: e },
    };
    if run.code != 0 {
        if is_no_pr(&run.stderr) {
            return PrReport::None;
        }
        let said = run.stderr.trim();
        let reason = if said.is_empty() {
            format!("gh exited with code {}", run.code)
        } else {
            // One line: this lands in a chip's tooltip, and gh's auth
            // error is a paragraph with a URL and a suggestion.
            said.lines().next().unwrap_or(said).to_string()
        };
        return PrReport::Unavailable { reason };
    }
    parse_pr_json(&run.stdout, now)
}

impl PrReport {
    fn as_cached(self) -> Self {
        match self {
            PrReport::Ready {
                number,
                url,
                title,
                pr_state,
                is_draft,
                review_decision,
                mergeable,
                created_at,
                checks,
                observed_at,
                ..
            } => PrReport::Ready {
                number,
                url,
                title,
                pr_state,
                is_draft,
                review_decision,
                mergeable,
                created_at,
                checks,
                observed_at,
                cached: true,
            },
            other => other,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ready(report: &PrReport) -> (&Vec<PrCheck>, &str) {
        match report {
            PrReport::Ready { checks, review_decision, .. } => (checks, review_decision),
            _ => panic!("expected Ready"),
        }
    }

    #[test]
    fn parses_a_check_run_rollup() {
        let raw = r#"{
          "number": 42, "url": "https://example.test/pr/42", "title": "Add a thing",
          "state": "OPEN", "isDraft": false, "reviewDecision": "REVIEW_REQUIRED",
          "mergeable": "MERGEABLE",
          "statusCheckRollup": [
            {"name": "build", "status": "COMPLETED", "conclusion": "SUCCESS",
             "detailsUrl": "https://example.test/build"},
            {"name": "test", "status": "IN_PROGRESS", "conclusion": ""}
          ]
        }"#;
        let report = parse_pr_json(raw, 100);
        let (checks, decision) = ready(&report);
        assert_eq!(decision, "REVIEW_REQUIRED");
        assert_eq!(checks.len(), 2);
        assert_eq!(checks[0].state, "success");
        assert_eq!(checks[0].url, "https://example.test/build");
        // Still going, NOT "unknown": the chips draw the two apart.
        assert_eq!(checks[1].state, "pending");
    }

    /// A commit status spells its verdict in `state` and its name in
    /// `context`; both shapes arrive in the same array.
    #[test]
    fn parses_a_commit_status_rollup() {
        let raw = r#"{
          "number": 7, "statusCheckRollup": [
            {"context": "ci/legacy", "state": "FAILURE", "targetUrl": "https://example.test/x"}
          ]
        }"#;
        let report = parse_pr_json(raw, 0);
        let (checks, _) = ready(&report);
        assert_eq!(checks[0].name, "ci/legacy");
        assert_eq!(checks[0].state, "failure");
        assert_eq!(checks[0].url, "https://example.test/x");
    }

    /// A PR with no CI at all is Ready with no checks -- distinctly not
    /// an error, and not `None` either.
    #[test]
    fn a_pr_with_no_checks_is_ready() {
        let report = parse_pr_json(r#"{"number": 3}"#, 0);
        let (checks, _) = ready(&report);
        assert!(checks.is_empty());
    }

    #[test]
    fn an_empty_array_is_no_pr() {
        assert!(matches!(parse_pr_json("[]", 0), PrReport::None));
        assert!(matches!(parse_pr_json("null", 0), PrReport::None));
    }

    #[test]
    fn unreadable_json_is_unavailable_not_none() {
        // The distinction the whole union exists for: a wait step waits
        // through `None` and stops for `Unavailable`.
        assert!(matches!(parse_pr_json("not json", 0), PrReport::Unavailable { .. }));
    }

    #[test]
    fn reads_githubs_timestamps() {
        assert_eq!(parse_rfc3339("1970-01-01T00:00:00Z"), 0);
        assert_eq!(parse_rfc3339("2026-09-03T12:34:56Z"), 1_788_438_896);
        // Anything gavin cannot read is 0, which every caller treats as
        // "GitHub did not say" rather than as the epoch.
        assert_eq!(parse_rfc3339(""), 0);
        assert_eq!(parse_rfc3339("yesterday"), 0);
        assert_eq!(parse_rfc3339("2026-13-03T12:34:56Z"), 0);
    }

    #[test]
    fn no_pr_is_told_apart_from_a_real_failure() {
        assert!(is_no_pr("no pull requests found for branch \"feat/x\""));
        assert!(!is_no_pr("gh: To use GitHub CLI in a GitHub Actions workflow, set the GH_TOKEN"));
        assert!(!is_no_pr("could not resolve to a Repository"));
    }
}
