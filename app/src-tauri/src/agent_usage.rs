//! Reading an agent's SUBSCRIPTION limits -- the windows the account is
//! spending against, not the tokens one conversation burned.
//!
//! Which agents can be asked at all, and by what route, is the profile
//! table's answer (`agent_setup::UsageProbe`); this module only carries
//! the two routes out. Three of the five profiles expose nothing, and
//! the honest report for those is `Unsupported`, never an invented bar.
//!
//! Two constraints shape everything below.
//!
//! **The Anthropic endpoint rate-limits its own callers, hard.** Without
//! a `claude-code/<version>` user-agent it lands in a bucket that answers
//! 429 for hours (anthropics/claude-code#30930, #31021, #31637). So the
//! probe sends one, caches every answer, refuses to call more often than
//! `MIN_INTERVAL`, and backs off on its own when told to. A usage panel
//! that polls per render is exactly how you lose the endpoint.
//!
//! **The token never leaves this file.** It is read on demand, handed to
//! curl through a config on STDIN rather than argv -- `ps` shows the
//! command line of every process on the machine -- and never logged,
//! never cached, never returned to the frontend. The only thing that
//! crosses back is percentages and reset instants.
//!
//! curl rather than an HTTP crate is deliberate: the workspace has no TLS
//! stack at all, and one authenticated GET does not justify pulling
//! rustls or native-tls into a Tauri host that already shells out to git.

use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::agent_setup::{profile_by_id, UsageProbe};

/// Anthropic's own usage endpoint, which every Claude Code client reads.
const ANTHROPIC_USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";

/// The beta gate the endpoint requires; without it the request is
/// refused rather than rate-limited.
const OAUTH_BETA: &str = "oauth-2025-04-20";

/// The shortest gap between two REAL calls for the same profile. Inside
/// it a caller gets the cached answer and its age instead.
///
/// Two minutes is not a performance tuning knob: a 5-hour window moves
/// by a third of a percent in that time, so nothing is lost, and the
/// endpoint punishes eagerness with hours of 429s. The panel is expected
/// to be open while somebody watches a rail, which is precisely the
/// situation a per-render fetch would ruin.
const MIN_INTERVAL_SECS: i64 = 120;

/// How long a 429 parks the probe for. Deliberately much longer than
/// `MIN_INTERVAL_SECS`: the reports describe a bucket that stays angry
/// for hours once tripped, so the recovery from hitting it is to stop
/// asking, not to ask more politely.
const BACKOFF_SECS: i64 = 900;

/// How long curl may take before the probe gives up. A usage panel that
/// hangs on a dead network is worse than one that says it could not
/// reach the endpoint.
const TIMEOUT_SECS: u32 = 10;

// ---- The report -------------------------------------------------------------

/// One limit window, normalised across routes. Anthropic calls it
/// `five_hour`/`utilization`, codex calls it `primary`/`used_percent`;
/// the frontend should have to learn neither.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    /// Stable id, keyed on by `agentUsage.ts`.
    pub id: String,
    /// What to call it in the panel.
    pub label: String,
    /// 0-100, and deliberately NOT clamped at the top: a spend limit can
    /// legitimately exceed 100, and flattening that to "full" would hide
    /// the one case where the number matters most.
    pub used_percent: f64,
    /// Epoch SECONDS when this window resets, or `None` when the route
    /// did not say. Absolute, never a duration: a duration computed here
    /// is wrong the moment the machine sleeps, and sleeping through a
    /// reset is the case this whole card exists for.
    pub resets_at: Option<i64>,
}

/// What a probe came back with. A tagged union rather than an
/// `Option<Vec<_>>` because "this agent cannot be asked" and "this agent
/// could not be reached" are different sentences to put in front of
/// somebody, and only one of them is worth retrying.
#[derive(Clone, serde::Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum UsageReport {
    /// Real numbers. `observedAt` is when the DATA was true, which for a
    /// file-backed route is the event's own timestamp and not the moment
    /// gavin read it -- a stale reading with an honest age is useful, a
    /// stale reading wearing a fresh timestamp is a lie.
    Ready {
        windows: Vec<UsageWindow>,
        plan: Option<String>,
        observed_at: i64,
        /// Whether this came from the cache rather than a fresh call.
        cached: bool,
    },
    /// The profile has no route at all (gemini, cursor, opencode,
    /// custom). Terminal: nothing about retrying changes it.
    Unsupported,
    /// There is a route and it did not answer. `retryAfter` is set when
    /// gavin has parked itself, so the panel can say when it will look
    /// again instead of implying the user should keep pressing.
    Unavailable {
        reason: String,
        retry_after: Option<i64>,
    },
}

fn now_secs() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

// ---- The cache --------------------------------------------------------------

struct Entry {
    report: UsageReport,
    /// When the probe last actually RAN, which paces calls. Distinct
    /// from the report's `observed_at`, which is when its data was true.
    fetched_at: i64,
    /// Set by a 429: no real call before this instant.
    parked_until: Option<i64>,
}

#[derive(Default)]
pub struct UsageCache(Mutex<HashMap<String, Entry>>);

impl UsageCache {
    pub fn new() -> Self {
        Self::default()
    }
}

// ---- The command ------------------------------------------------------------

/// Read one profile's limits, honouring the cache and the backoff.
///
/// `force` is the panel's explicit refresh. It skips the freshness floor
/// but NOT the 429 park: a human pressing refresh cannot un-anger the
/// endpoint, and letting them try is how a park becomes permanent.
#[tauri::command]
pub fn agent_usage(
    cache: tauri::State<'_, UsageCache>,
    profile_id: String,
    force: bool,
) -> UsageReport {
    let probe = match profile_by_id(&profile_id).usage_probe {
        Some(p) => p,
        None => return UsageReport::Unsupported,
    };
    let now = now_secs();

    {
        let map = cache.0.lock().unwrap();
        if let Some(entry) = map.get(&profile_id) {
            if let Some(until) = entry.parked_until {
                if now < until {
                    return UsageReport::Unavailable {
                        reason: "the usage endpoint rate-limited gavin".to_string(),
                        retry_after: Some(until),
                    };
                }
            }
            let fresh = now - entry.fetched_at < MIN_INTERVAL_SECS;
            if fresh && !force {
                return entry.report.clone().as_cached();
            }
        }
    }

    let (report, park) = match probe {
        UsageProbe::AnthropicOauth => anthropic_usage(now),
        // No home means no rollout files to read, which is the same
        // "nothing measured yet" the missing-directory arm reports.
        UsageProbe::CodexRollout => {
            (codex_usage(&codex_sessions_dir().unwrap_or_default()), None)
        }
    };

    let mut map = cache.0.lock().unwrap();
    map.insert(
        profile_id,
        Entry { report: report.clone(), fetched_at: now, parked_until: park },
    );
    report
}

impl UsageReport {
    fn as_cached(self) -> Self {
        match self {
            UsageReport::Ready { windows, plan, observed_at, .. } => {
                UsageReport::Ready { windows, plan, observed_at, cached: true }
            }
            other => other,
        }
    }
}

// ---- Claude Code ------------------------------------------------------------

/// The CLI's own version, for the user-agent the endpoint wants. Best
/// effort: a plausible fallback beats no header at all, since it is the
/// SHAPE of the user-agent that selects the generous bucket.
fn claude_version() -> String {
    // Resolved rather than named: on Windows `claude` is an npm shim and
    // `CreateProcess` will not start it without the extension (see
    // `program`). A miss leaves the fallback version below, which is the
    // same answer this already gave for a machine with no CLI.
    Command::new(crate::program::resolve_or_name("claude"))
        .arg("--version")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| {
            String::from_utf8_lossy(&o.stdout)
                .split_whitespace()
                .next()
                .filter(|v| v.chars().next().is_some_and(|c| c.is_ascii_digit()))
                .map(|v| v.to_string())
        })
        .unwrap_or_else(|| "2.0.0".to_string())
}

/// The OAuth token, from the Keychain first and the file second -- the
/// order Claude Code itself resolves them in on macOS, so gavin reads
/// whichever one is actually current.
///
/// Returns the secret; every caller must keep it out of argv, logs and
/// anything that crosses to the frontend.
fn claude_token() -> Option<String> {
    let path = home_dir()?.join(".claude").join(".credentials.json");
    token_from_credentials(&credentials_blob(keychain_credentials(), &path)?)
}

/// Which of the two sources actually answers.
///
/// A function of its inputs so the precedence is testable without a
/// Keychain: which source wins is a decision, and the file arm is the
/// ONLY arm off macOS, where nothing would otherwise exercise it.
fn credentials_blob(keychain: Option<String>, file: &Path) -> Option<String> {
    match keychain {
        Some(raw) => Some(raw),
        None => std::fs::read_to_string(file).ok(),
    }
}

/// The Keychain copy, on the one OS that has a Keychain.
///
/// `security(1)` is a macOS binary and there is no Linux equivalent to
/// fall back to: Claude Code stores the blob in `~/.claude/.credentials.json`
/// there, plainly, which is why `credentials_blob`'s file arm is the
/// whole story off macOS. Shelling out anyway would spend a process
/// launch per probe on a command that cannot exist -- and on a machine
/// that happened to have some unrelated `security` on PATH, would run
/// it.
#[cfg(target_os = "macos")]
fn keychain_credentials() -> Option<String> {
    Command::new("security")
        .args(["find-generic-password", "-s", "Claude Code-credentials", "-w"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
}

#[cfg(not(target_os = "macos"))]
fn keychain_credentials() -> Option<String> {
    None
}

/// Pull `claudeAiOauth.accessToken` out of a credentials blob. Split out
/// so the shape is testable without a Keychain or a real token.
fn token_from_credentials(raw: &str) -> Option<String> {
    let parsed: serde_json::Value = serde_json::from_str(raw).ok()?;
    let token = parsed.get("claudeAiOauth")?.get("accessToken")?.as_str()?;
    if token.trim().is_empty() {
        return None;
    }
    Some(token.to_string())
}

fn anthropic_usage(now: i64) -> (UsageReport, Option<i64>) {
    let token = match claude_token() {
        Some(t) => t,
        None => {
            return (
                UsageReport::Unavailable {
                    reason: "gavin could not find Claude Code's login — run `claude` and sign in"
                        .to_string(),
                    retry_after: None,
                },
                None,
            )
        }
    };

    // Every secret travels on STDIN. `-K -` makes curl read its whole
    // option set from there, so neither the token nor the URL is ever
    // visible in `ps`.
    let config = format!(
        "url = \"{ANTHROPIC_USAGE_URL}\"\n\
         header = \"Authorization: Bearer {token}\"\n\
         header = \"anthropic-beta: {OAUTH_BETA}\"\n\
         header = \"User-Agent: claude-code/{version}\"\n\
         header = \"Accept: application/json\"\n\
         silent\n\
         show-error\n\
         max-time = \"{TIMEOUT_SECS}\"\n\
         write-out = \"\\n%{{http_code}}\"\n",
        version = claude_version(),
    );

    let output = match run_curl(&config) {
        Ok(o) => o,
        Err(e) => {
            return (
                UsageReport::Unavailable { reason: e, retry_after: None },
                None,
            )
        }
    };

    let (body, status) = split_status(&output);
    match status {
        200 => match parse_anthropic(body, now) {
            Some(report) => (report, None),
            None => (
                UsageReport::Unavailable {
                    reason: "the usage endpoint answered in a shape gavin does not recognise"
                        .to_string(),
                    retry_after: None,
                },
                None,
            ),
        },
        401 | 403 => (
            UsageReport::Unavailable {
                reason: "Claude Code's login is not valid any more — run `claude` and sign in"
                    .to_string(),
                retry_after: None,
            },
            None,
        ),
        429 => {
            let until = now + BACKOFF_SECS;
            (
                UsageReport::Unavailable {
                    reason: "the usage endpoint rate-limited gavin".to_string(),
                    retry_after: Some(until),
                },
                Some(until),
            )
        }
        other => (
            UsageReport::Unavailable {
                reason: format!("the usage endpoint answered {other}"),
                retry_after: None,
            },
            None,
        ),
    }
}

fn run_curl(config: &str) -> Result<String, String> {
    // curl is a real executable on every platform gavin runs on --
    // /usr/bin/curl on unix, and shipped in System32 since Windows 10
    // 1803 -- so the only thing `resolve_or_name` adds here is the
    // `.exe`. (PowerShell's `curl` alias for `Invoke-WebRequest` is a
    // shell alias and is not what `CreateProcess` finds.) `-K -` reads
    // the config, including the header lines, from stdin on all of them.
    let mut child = Command::new(crate::program::resolve_or_name("curl"))
        .arg("-K")
        .arg("-")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("gavin could not run curl: {e}"))?;
    child
        .stdin
        .as_mut()
        .ok_or_else(|| "curl took no stdin".to_string())?
        .write_all(config.as_bytes())
        .map_err(|e| format!("gavin could not talk to curl: {e}"))?;
    let out = child.wait_with_output().map_err(|e| format!("curl did not finish: {e}"))?;
    if !out.status.success() && out.stdout.is_empty() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if err.is_empty() { "the request failed".to_string() } else { err });
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// `write-out` appends the status on its own last line, so the body is
/// everything before it.
fn split_status(output: &str) -> (&str, u16) {
    match output.rsplit_once('\n') {
        Some((body, code)) => (body, code.trim().parse().unwrap_or(0)),
        None => (output, 0),
    }
}

/// The endpoint's shape: a `five_hour` and a `seven_day` object, each
/// `{utilization, resets_at}`, plus `spend_limit` behind a gateway.
///
/// A window whose `resets_at` has already passed is DROPPED rather than
/// shown at its last value -- that is what Claude Code's own statusline
/// does, and a bar reading 96% for a window that reset an hour ago is
/// the single most misleading thing this panel could show.
fn parse_anthropic(body: &str, now: i64) -> Option<UsageReport> {
    let parsed: serde_json::Value = serde_json::from_str(body).ok()?;
    let rows: [(&str, &str); 3] = [
        ("five_hour", "5-hour"),
        ("seven_day", "Weekly"),
        ("spend_limit", "Spend"),
    ];
    let mut windows = Vec::new();
    for (key, label) in rows {
        let Some(obj) = parsed.get(key) else { continue };
        let Some(pct) = obj.get("utilization").and_then(as_percent) else { continue };
        let resets_at = obj.get("resets_at").and_then(as_epoch_secs);
        if resets_at.is_some_and(|t| t <= now) {
            continue;
        }
        windows.push(UsageWindow {
            id: key.to_string(),
            label: label.to_string(),
            used_percent: pct,
            resets_at,
        });
    }
    if windows.is_empty() {
        return None;
    }
    let plan = parsed
        .get("plan")
        .or_else(|| parsed.get("plan_type"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    Some(UsageReport::Ready { windows, plan, observed_at: now, cached: false })
}

fn as_percent(value: &serde_json::Value) -> Option<f64> {
    value.as_f64().filter(|v| v.is_finite() && *v >= 0.0)
}

/// `resets_at` arrives as epoch seconds from Anthropic and as an RFC 3339
/// string from codex, so both are accepted and normalised to seconds.
fn as_epoch_secs(value: &serde_json::Value) -> Option<i64> {
    if let Some(n) = value.as_i64() {
        // Milliseconds would put the reset ~50,000 years out; the only
        // way to tell them apart is the magnitude.
        return Some(if n > 100_000_000_000 { n / 1000 } else { n });
    }
    parse_rfc3339(value.as_str()?)
}

/// Enough RFC 3339 to read a reset instant, without a date crate. Only
/// the shape these two routes emit: `YYYY-MM-DDTHH:MM:SS` with an
/// optional fractional part and an optional `Z`/offset.
fn parse_rfc3339(text: &str) -> Option<i64> {
    let text = text.trim();
    let (date, rest) = text.split_once('T').or_else(|| text.split_once(' '))?;
    let mut date_parts = date.split('-');
    let year: i64 = date_parts.next()?.parse().ok()?;
    let month: i64 = date_parts.next()?.parse().ok()?;
    let day: i64 = date_parts.next()?.parse().ok()?;

    let time = rest.trim_end_matches('Z');
    let (time, offset) = match time.find(['+', '-']) {
        // A sign after the seconds is a UTC offset, never part of the clock.
        Some(i) if i > 0 => {
            let (t, off) = time.split_at(i);
            (t, offset_secs(off)?)
        }
        _ => (time, 0),
    };
    let mut time_parts = time.split(':');
    let hour: i64 = time_parts.next()?.parse().ok()?;
    let minute: i64 = time_parts.next()?.parse().ok()?;
    let second: i64 =
        time_parts.next().unwrap_or("0").split('.').next()?.parse().ok().unwrap_or(0);

    Some(days_from_civil(year, month, day) * 86_400 + hour * 3600 + minute * 60 + second - offset)
}

fn offset_secs(text: &str) -> Option<i64> {
    let sign = if text.starts_with('-') { -1 } else { 1 };
    let body = &text[1..];
    let (h, m) = match body.split_once(':') {
        Some((h, m)) => (h, m),
        None if body.len() == 4 => (&body[..2], &body[2..]),
        None => (body, "0"),
    };
    Some(sign * (h.parse::<i64>().ok()? * 3600 + m.parse::<i64>().ok()? * 60))
}

/// Howard Hinnant's days-from-civil. A dozen lines against a date crate
/// and a version bump for something two `resets_at` fields need.
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

// ---- Codex ------------------------------------------------------------------

use crate::home::home_dir;

/// `None` when there is no home to look under, rather than a relative
/// `.codex/sessions` -- the callers treat a missing directory as "no
/// data yet", which is the right answer, and a relative one would read
/// whatever happens to sit under the app's cwd instead.
fn codex_sessions_dir() -> Option<PathBuf> {
    Some(home_dir()?.join(".codex").join("sessions"))
}

/// The newest `token_count` event that actually carried rate limits.
///
/// Codex writes rollout files per session; a `token_count` event's
/// payload carries `rate_limits.primary`/`.secondary`. Not every one does
/// -- openai/codex#14880 reports the field null in exec mode -- so the
/// scan looks for the newest event WITH limits rather than the newest
/// event, or a stretch of headless runs would read as "no data".
fn codex_usage(sessions: &Path) -> UsageReport {
    if !sessions.exists() {
        return UsageReport::Unavailable {
            reason: "no Codex sessions on this machine yet".to_string(),
            retry_after: None,
        };
    }
    let mut files = Vec::new();
    collect_jsonl(sessions, &mut files, 0);
    // Newest first by mtime: the answer is almost always in the first
    // file, and the scan stops as soon as one yields limits.
    files.sort_by_key(|(_, mtime)| std::cmp::Reverse(*mtime));

    for (path, _) in files.iter().take(20) {
        let Ok(text) = std::fs::read_to_string(path) else { continue };
        if let Some(report) = newest_codex_limits(&text) {
            return report;
        }
    }
    UsageReport::Unavailable {
        reason: "Codex has not recorded any rate limits yet".to_string(),
        retry_after: None,
    }
}

fn collect_jsonl(dir: &Path, out: &mut Vec<(PathBuf, SystemTime)>, depth: usize) {
    if depth > 4 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_jsonl(&path, out, depth + 1);
        } else if path.extension().is_some_and(|e| e == "jsonl") {
            let mtime = entry.metadata().and_then(|m| m.modified()).unwrap_or(UNIX_EPOCH);
            out.push((path, mtime));
        }
    }
}

/// Scan one rollout file BACKWARDS for the last event carrying limits.
///
/// Split out from the file walk so the shape can be tested against a
/// literal: `{"type":"event_msg","timestamp":...,"payload":{"type":
/// "token_count","rate_limits":{"primary":{...},"secondary":{...}}}}`.
pub fn newest_codex_limits(text: &str) -> Option<UsageReport> {
    for line in text.lines().rev() {
        let Ok(record) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        if record.get("type").and_then(|v| v.as_str()) != Some("event_msg") {
            continue;
        }
        let payload = record.get("payload")?;
        if payload.get("type").and_then(|v| v.as_str()) != Some("token_count") {
            continue;
        }
        let Some(limits) = payload.get("rate_limits").filter(|v| v.is_object()) else { continue };
        // The event's own clock, not gavin's: `resets_in_seconds` counts
        // from when the line was written, so resolving it against `now`
        // would under-report the wait by however long codex has been idle.
        let observed_at = record.get("timestamp").and_then(as_epoch_secs)?;

        let mut windows = Vec::new();
        for (key, label) in [("primary", "5-hour"), ("secondary", "Weekly")] {
            let Some(obj) = limits.get(key) else { continue };
            let Some(pct) = obj.get("used_percent").and_then(as_percent) else { continue };
            let resets_at = obj
                .get("resets_at")
                .and_then(as_epoch_secs)
                .or_else(|| obj.get("resets_in_seconds").and_then(|v| v.as_f64()).map(|s| observed_at + s as i64));
            windows.push(UsageWindow {
                id: key.to_string(),
                label: label.to_string(),
                used_percent: pct,
                resets_at,
            });
        }
        if windows.is_empty() {
            continue;
        }
        let plan = payload.get("plan_type").and_then(|v| v.as_str()).map(|s| s.to_string());
        return Some(UsageReport::Ready { windows, plan, observed_at, cached: false });
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn windows(report: &UsageReport) -> &[UsageWindow] {
        match report {
            UsageReport::Ready { windows, .. } => windows,
            _ => panic!("expected a ready report"),
        }
    }

    #[test]
    fn the_credentials_file_answers_when_there_is_no_keychain() {
        // The whole of the Linux path, and the macOS not-signed-in-to-
        // the-Keychain path: `keychain_credentials()` is a compile-time
        // `None` off macOS, so the file arm is what has to fill the
        // usage panel there.
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join(".credentials.json");
        std::fs::write(&file, r#"{"claudeAiOauth":{"accessToken":"sk-from-file"}}"#).unwrap();

        let raw = credentials_blob(None, &file).expect("the file is the fallback");
        assert_eq!(token_from_credentials(&raw).as_deref(), Some("sk-from-file"));
    }

    #[test]
    fn the_keychain_wins_when_it_answers_and_a_missing_file_is_no_token() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join(".credentials.json");
        std::fs::write(&file, r#"{"claudeAiOauth":{"accessToken":"sk-stale"}}"#).unwrap();

        let raw = credentials_blob(Some(r#"{"claudeAiOauth":{"accessToken":"sk-fresh"}}"#.to_string()), &file);
        assert_eq!(token_from_credentials(&raw.unwrap()).as_deref(), Some("sk-fresh"));

        // Neither source: the panel says "run `claude` and sign in"
        // rather than sending a request with no Authorization header.
        assert_eq!(credentials_blob(None, &dir.path().join("absent.json")), None);
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn no_keychain_is_consulted_off_macos() {
        assert_eq!(keychain_credentials(), None);
    }

    #[test]
    fn credentials_yield_the_oauth_token_and_nothing_else() {
        let raw = r#"{"claudeAiOauth":{"accessToken":"sk-test","refreshToken":"r"}}"#;
        assert_eq!(token_from_credentials(raw).as_deref(), Some("sk-test"));
        assert_eq!(token_from_credentials(r#"{"other":{}}"#), None);
        assert_eq!(token_from_credentials(r#"{"claudeAiOauth":{"accessToken":"  "}}"#), None);
        assert_eq!(token_from_credentials("not json"), None);
    }

    /// The status is appended by curl's `write-out` on its own line, and
    /// a body containing newlines must not confuse the split.
    #[test]
    fn the_status_line_splits_off_the_body() {
        assert_eq!(split_status("{\"a\":1}\n200"), ("{\"a\":1}", 200));
        assert_eq!(split_status("{\n \"a\": 1\n}\n429"), ("{\n \"a\": 1\n}", 429));
        assert_eq!(split_status("no status"), ("no status", 0));
    }

    #[test]
    fn anthropic_windows_are_normalised_and_labelled() {
        let now = 1_000_000;
        let body = r#"{
            "five_hour": {"utilization": 23.5, "resets_at": 1000600},
            "seven_day": {"utilization": 41.2, "resets_at": 1200000},
            "plan": "max"
        }"#;
        let report = parse_anthropic(body, now).expect("parses");
        let w = windows(&report);
        assert_eq!(w.len(), 2);
        assert_eq!(w[0].id, "five_hour");
        assert_eq!(w[0].label, "5-hour");
        assert_eq!(w[0].used_percent, 23.5);
        assert_eq!(w[0].resets_at, Some(1_000_600));
        assert!(matches!(&report, UsageReport::Ready { plan, .. } if plan.as_deref() == Some("max")));
    }

    /// A window whose reset has passed is stale, not full. Showing its
    /// last value would tell somebody they are still capped when the
    /// window reopened an hour ago -- the exact wrong answer for a panel
    /// whose whole job is "can I start work now".
    #[test]
    fn a_window_past_its_reset_is_dropped() {
        let now = 1_000_000;
        let body = r#"{
            "five_hour": {"utilization": 96.0, "resets_at": 999000},
            "seven_day": {"utilization": 41.2, "resets_at": 1200000}
        }"#;
        let report = parse_anthropic(body, now).expect("parses");
        let w = windows(&report);
        assert_eq!(w.len(), 1);
        assert_eq!(w[0].id, "seven_day");
    }

    /// Every window expired means there is nothing to show, which must
    /// not render as an empty panel claiming zero usage.
    #[test]
    fn an_all_expired_body_is_not_a_ready_report() {
        let body = r#"{"five_hour": {"utilization": 96.0, "resets_at": 10}}"#;
        assert!(parse_anthropic(body, 1_000_000).is_none());
        assert!(parse_anthropic("{}", 1_000_000).is_none());
    }

    /// A spend limit above 100 is real and is the case that matters
    /// most; clamping it would hide an overrun.
    #[test]
    fn a_spend_limit_over_a_hundred_survives() {
        let body = r#"{"spend_limit": {"utilization": 137.5, "resets_at": 2000000}}"#;
        let report = parse_anthropic(body, 1_000_000).expect("parses");
        let w = windows(&report);
        assert_eq!(w[0].used_percent, 137.5);
        assert_eq!(w[0].label, "Spend");
    }

    #[test]
    fn codex_limits_come_from_the_newest_event_that_has_them() {
        let text = concat!(
            r#"{"type":"event_msg","timestamp":"2026-09-02T10:00:00Z","payload":{"type":"token_count","rate_limits":{"primary":{"used_percent":10.0,"resets_in_seconds":3600}}}}"#,
            "\n",
            r#"{"type":"event_msg","timestamp":"2026-09-02T11:00:00Z","payload":{"type":"token_count","rate_limits":{"primary":{"used_percent":55.5,"window_minutes":300,"resets_in_seconds":1800},"secondary":{"used_percent":12.0,"resets_at":"2026-09-05T00:00:00Z"}}}}"#,
            "\n",
            // Newer, but carries no limits -- must not mask the one above.
            r#"{"type":"event_msg","timestamp":"2026-09-02T11:30:00Z","payload":{"type":"token_count","rate_limits":null}}"#,
            "\n",
        );
        let report = newest_codex_limits(text).expect("parses");
        let w = windows(&report);
        assert_eq!(w.len(), 2);
        assert_eq!(w[0].used_percent, 55.5);
        // resets_in_seconds resolves against the EVENT's clock, not now.
        let observed = parse_rfc3339("2026-09-02T11:00:00Z").unwrap();
        assert_eq!(w[0].resets_at, Some(observed + 1800));
        assert_eq!(w[1].resets_at, parse_rfc3339("2026-09-05T00:00:00Z"));
        assert!(matches!(&report, UsageReport::Ready { observed_at, .. } if *observed_at == observed));
    }

    #[test]
    fn a_rollout_with_no_limits_anywhere_yields_nothing() {
        let text = r#"{"type":"event_msg","timestamp":"2026-09-02T11:00:00Z","payload":{"type":"token_count"}}"#;
        assert!(newest_codex_limits(text).is_none());
        assert!(newest_codex_limits("garbage\n{}\n").is_none());
    }

    #[test]
    fn rfc3339_covers_both_routes_shapes() {
        assert_eq!(parse_rfc3339("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_rfc3339("2026-09-02T11:00:00Z"), parse_rfc3339("2026-09-02T11:00:00"));
        // An offset shifts the instant, and must not be read as part of
        // the clock.
        assert_eq!(
            parse_rfc3339("2026-09-02T13:00:00+02:00"),
            parse_rfc3339("2026-09-02T11:00:00Z")
        );
        assert_eq!(
            parse_rfc3339("2026-09-02T11:00:00.123456Z"),
            parse_rfc3339("2026-09-02T11:00:00Z")
        );
        assert_eq!(parse_rfc3339("nonsense"), None);
    }

    /// Milliseconds and seconds are told apart by magnitude, because
    /// both routes have been seen emitting a bare number.
    #[test]
    fn epoch_numbers_normalise_to_seconds() {
        assert_eq!(as_epoch_secs(&serde_json::json!(1_738_425_600i64)), Some(1_738_425_600));
        assert_eq!(as_epoch_secs(&serde_json::json!(1_738_425_600_000i64)), Some(1_738_425_600));
    }

    #[test]
    fn a_missing_codex_sessions_dir_is_unavailable_not_a_panic() {
        let dir = std::env::temp_dir().join("gavin-no-such-codex-dir");
        assert!(matches!(codex_usage(&dir), UsageReport::Unavailable { .. }));
    }

    /// The profile table decides who can be asked; a profile with no
    /// route must answer `Unsupported` without any probe running.
    #[test]
    fn profiles_without_a_route_are_unsupported() {
        for id in ["gemini", "cursor", "opencode", "custom"] {
            assert!(profile_by_id(id).usage_probe.is_none(), "{id} claims a probe");
        }
    }
}
