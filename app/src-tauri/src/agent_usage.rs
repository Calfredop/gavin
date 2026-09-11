//! Reading an agent's SUBSCRIPTION limits -- the windows the account is
//! spending against, not the tokens one conversation burned.
//!
//! Which agents can be asked at all, and by what route, is the profile
//! table's answer (`agent_setup::UsageProbe`); this module only carries
//! the routes out. Custom is the only profile with no route, and the
//! honest report there is `Unsupported`, never an invented bar. A stock
//! CLI whose route could not answer (no login, no Go subscription, a
//! consumer Gemini account) is `Unavailable` -- a different sentence.
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
// `rename_all_fields` as well as `rename_all`: on an enum the latter
// renames the VARIANTS and leaves every struct-variant field in
// snake_case, so `observed_at` reached `agentUsage.ts` as `undefined`
// and every projection read NaN for its sample time.
#[serde(tag = "state", rename_all = "camelCase", rename_all_fields = "camelCase")]
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
    /// The profile has no route at all (`custom`). Terminal: nothing
    /// about retrying changes it.
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
        UsageProbe::CursorSession => cursor_usage(now),
        UsageProbe::GeminiCodeAssist => gemini_usage(now),
        UsageProbe::OpencodeGo => opencode_go_usage(now),
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

fn window(id: &str, label: &str, used_percent: f64, resets_at: Option<i64>) -> UsageWindow {
    UsageWindow {
        id: id.to_string(),
        label: label.to_string(),
        used_percent,
        resets_at,
    }
}

fn nonempty(s: &str) -> Option<String> {
    let t = s.trim();
    if t.is_empty() {
        None
    } else {
        Some(t.to_string())
    }
}

fn percent_from_ratio(used: f64, limit: f64) -> Option<f64> {
    if !used.is_finite() || !limit.is_finite() || limit <= 0.0 || used < 0.0 {
        return None;
    }
    Some(100.0 * used / limit)
}

fn number_field(obj: &serde_json::Value, key: &str) -> Option<f64> {
    obj.get(key).and_then(as_percent)
}

/// JWT-style base64url, no padding. Decode is how `sub` comes out of
/// Cursor's session token; encode exists so tests can mint a payload.
#[cfg(test)]
fn b64url_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::new();
    let mut i = 0;
    while i < bytes.len() {
        let b0 = bytes[i];
        let b1 = if i + 1 < bytes.len() { bytes[i + 1] } else { 0 };
        let b2 = if i + 2 < bytes.len() { bytes[i + 2] } else { 0 };
        let n = ((b0 as u32) << 16) | ((b1 as u32) << 8) | (b2 as u32);
        out.push(TABLE[((n >> 18) & 63) as usize] as char);
        out.push(TABLE[((n >> 12) & 63) as usize] as char);
        if i + 1 < bytes.len() {
            out.push(TABLE[((n >> 6) & 63) as usize] as char);
        }
        if i + 2 < bytes.len() {
            out.push(TABLE[(n & 63) as usize] as char);
        }
        i += 3;
    }
    out
}

fn b64url_decode(input: &str) -> Option<Vec<u8>> {
    let mut acc = 0u32;
    let mut bits = 0;
    let mut out = Vec::new();
    for c in input.bytes() {
        if c == b'=' {
            break;
        }
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'-' | b'+' => 62,
            b'_' | b'/' => 63,
            _ => return None,
        } as u32;
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    Some(out)
}

fn jwt_sub(token: &str) -> Option<String> {
    let payload = token.split('.').nth(1)?;
    let json = String::from_utf8(b64url_decode(payload)?).ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&json).ok()?;
    nonempty(parsed.get("sub")?.as_str()?)
}

fn cursor_cookie(token: &str) -> Option<String> {
    let sub = jwt_sub(token)?;
    Some(format!("{sub}%3A%3A{token}"))
}

fn decode_vscdb_value(raw: &str) -> String {
    if raw.contains('\0') {
        raw.chars().filter(|c| *c != '\0').collect::<String>().trim().to_string()
    } else {
        raw.trim().to_string()
    }
}

// ---- Cursor -----------------------------------------------------------------

const CURSOR_USAGE_URL: &str = "https://cursor.com/api/usage-summary";

/// Cursor Agent writes the same JWT the dashboard cookie is made from
/// into the macOS Keychain under `cursor-access-token` (verified
/// 2026-09-11). Off macOS, and when the Keychain is empty, the Cursor
/// app's `state.vscdb` holds the same value at
/// `cursorAuth/accessToken`.
fn cursor_token() -> Option<String> {
    nonempty(&keychain_secret("cursor-access-token").unwrap_or_default())
        .or_else(cursor_token_from_vscdb)
}

#[cfg(target_os = "macos")]
fn keychain_secret(service: &str) -> Option<String> {
    Command::new("security")
        .args(["find-generic-password", "-s", service, "-w"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
}

#[cfg(not(target_os = "macos"))]
fn keychain_secret(_service: &str) -> Option<String> {
    None
}

fn cursor_token_from_vscdb() -> Option<String> {
    let path = cursor_state_vscdb()?;
    if !path.exists() {
        return None;
    }
    let path_str = path.to_str()?;
    let output = Command::new(crate::program::resolve_or_name("sqlite3"))
        .args([
            "-readonly",
            "-batch",
            path_str,
            "SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken' LIMIT 1;",
        ])
        .output()
        .ok()
        .or_else(|| {
            Command::new(crate::program::resolve_or_name("sqlite3"))
                .args([
                    "-batch",
                    path_str,
                    "SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken' LIMIT 1;",
                ])
                .output()
                .ok()
        })?;
    if !output.status.success() {
        return None;
    }
    nonempty(&decode_vscdb_value(&String::from_utf8_lossy(&output.stdout)))
}

fn cursor_state_vscdb() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        return Some(
            home_dir()?
                .join("Library")
                .join("Application Support")
                .join("Cursor")
                .join("User")
                .join("globalStorage")
                .join("state.vscdb"),
        );
    }
    #[cfg(target_os = "windows")]
    {
        let appdata = std::env::var_os("APPDATA")?;
        return Some(
            PathBuf::from(appdata)
                .join("Cursor")
                .join("User")
                .join("globalStorage")
                .join("state.vscdb"),
        );
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Some(
            home_dir()?
                .join(".config")
                .join("Cursor")
                .join("User")
                .join("globalStorage")
                .join("state.vscdb"),
        )
    }
}

fn cursor_usage(now: i64) -> (UsageReport, Option<i64>) {
    let token = match cursor_token() {
        Some(t) => t,
        None => {
            return (
                UsageReport::Unavailable {
                    reason: "gavin could not find Cursor's login — run `agent` and sign in"
                        .to_string(),
                    retry_after: None,
                },
                None,
            )
        }
    };
    let cookie = match cursor_cookie(&token) {
        Some(c) => c,
        None => {
            return (
                UsageReport::Unavailable {
                    reason: "Cursor's login is not a session gavin can read — run `agent` and sign in"
                        .to_string(),
                    retry_after: None,
                },
                None,
            )
        }
    };
    if cookie.contains('"') || cookie.contains('\n') {
        return (
            UsageReport::Unavailable {
                reason: "Cursor's login is not a session gavin can read — run `agent` and sign in"
                    .to_string(),
                retry_after: None,
            },
            None,
        );
    }
    let config = format!(
        "url = \"{CURSOR_USAGE_URL}\"\n\
         header = \"Cookie: WorkosCursorSessionToken={cookie}\"\n\
         header = \"Accept: application/json\"\n\
         silent\n\
         show-error\n\
         max-time = \"{TIMEOUT_SECS}\"\n\
         write-out = \"\\n%{{http_code}}\"\n"
    );
    http_probe_result(run_curl(&config), now, parse_cursor, "Cursor's login is not valid any more — run `agent` and sign in", "the Cursor usage endpoint")
}

/// `GET https://cursor.com/api/usage-summary` (verified 2026-09-11
/// against a live Pro session). Auto / API / Total percents live on
/// `individualUsage.plan`; a billing-cycle end is the shared reset;
/// uncapped on-demand is not a window.
fn parse_cursor(body: &str, now: i64) -> Option<UsageReport> {
    let parsed: serde_json::Value = serde_json::from_str(body).ok()?;
    let resets_at = parsed.get("billingCycleEnd").and_then(as_epoch_secs);
    if resets_at.is_some_and(|t| t <= now) {
        return None;
    }
    let individual = parsed.get("individualUsage");
    let plan = individual.and_then(|u| u.get("plan"));
    let mut windows = Vec::new();

    let mut total = plan.and_then(|p| p.get("totalPercentUsed").and_then(as_percent));
    if total.is_none() {
        if let Some(p) = plan {
            total = match (number_field(p, "used"), number_field(p, "limit")) {
                (Some(used), Some(limit)) => percent_from_ratio(used, limit),
                _ => None,
            };
        }
    }
    if total.is_none() {
        if let Some(overall) = individual.and_then(|u| u.get("overall")) {
            total = match (number_field(overall, "used"), number_field(overall, "limit")) {
                (Some(used), Some(limit)) => percent_from_ratio(used, limit),
                _ => None,
            };
        }
    }
    if total.is_none() {
        if let Some(pooled) = parsed.get("teamUsage").and_then(|u| u.get("pooled")) {
            total = match (number_field(pooled, "used"), number_field(pooled, "limit")) {
                (Some(used), Some(limit)) => percent_from_ratio(used, limit),
                _ => None,
            };
        }
    }
    if let Some(pct) = total {
        windows.push(window("total", "Total", pct, resets_at));
    }
    if let Some(pct) = plan.and_then(|p| p.get("autoPercentUsed").and_then(as_percent)) {
        windows.push(window("auto", "Auto", pct, resets_at));
    }
    if let Some(pct) = plan.and_then(|p| p.get("apiPercentUsed").and_then(as_percent)) {
        windows.push(window("api", "API", pct, resets_at));
    }
    if let Some(od) = individual.and_then(|u| u.get("onDemand")) {
        if od.get("enabled").and_then(|v| v.as_bool()) == Some(true) {
            if let Some(pct) = match (number_field(od, "used"), number_field(od, "limit")) {
                (Some(used), Some(limit)) => percent_from_ratio(used, limit),
                _ => None,
            } {
                windows.push(window("on_demand", "On-demand", pct, resets_at));
            }
        }
    }
    if windows.is_empty() {
        return None;
    }
    let plan_name = parsed
        .get("membershipType")
        .and_then(|v| v.as_str())
        .and_then(nonempty);
    Some(UsageReport::Ready { windows, plan: plan_name, observed_at: now, cached: false })
}

fn http_probe_result(
    output: Result<String, String>,
    now: i64,
    parse: fn(&str, i64) -> Option<UsageReport>,
    auth_reason: &str,
    endpoint: &str,
) -> (UsageReport, Option<i64>) {
    let output = match output {
        Ok(o) => o,
        Err(e) => return (UsageReport::Unavailable { reason: e, retry_after: None }, None),
    };
    let (body, status) = split_status(&output);
    match status {
        200 => match parse(body, now) {
            Some(report) => (report, None),
            None => (
                UsageReport::Unavailable {
                    reason: format!("{endpoint} answered in a shape gavin does not recognise"),
                    retry_after: None,
                },
                None,
            ),
        },
        401 | 403 => {
            (UsageReport::Unavailable { reason: auth_reason.to_string(), retry_after: None }, None)
        }
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
                reason: format!("{endpoint} answered {other}"),
                retry_after: None,
            },
            None,
        ),
    }
}

// ---- Gemini CLI -------------------------------------------------------------

/// Gemini CLI's installed-app OAuth client. Public on purpose: Google
/// documents that an installed application's client secret is not a
/// secret (the same constants live in gemini-cli's oauth2.ts).
const GEMINI_OAUTH_CLIENT_ID: &str =
    "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com";
const GEMINI_OAUTH_CLIENT_SECRET: &str = "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";
const GEMINI_TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const GEMINI_QUOTA_URL: &str = "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota";
const GEMINI_ASSIST_URL: &str = "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist";

#[derive(Debug, PartialEq)]
struct GeminiCreds {
    access: String,
    refresh: Option<String>,
    expiry_ms: Option<i64>,
}

fn gemini_creds(raw: &str) -> Option<GeminiCreds> {
    let parsed: serde_json::Value = serde_json::from_str(raw).ok()?;
    let access = nonempty(parsed.get("access_token")?.as_str()?)?;
    let refresh = parsed.get("refresh_token").and_then(|v| v.as_str()).and_then(nonempty);
    let expiry_ms = parsed.get("expiry_date").and_then(|v| v.as_i64());
    Some(GeminiCreds { access, refresh, expiry_ms })
}

fn gemini_creds_path() -> Option<PathBuf> {
    Some(home_dir()?.join(".gemini").join("oauth_creds.json"))
}

fn gemini_tier_index(model: &str) -> Option<usize> {
    let m = model.to_ascii_lowercase();
    if m.contains("flash-lite") || m.contains("flash_lite") {
        Some(2)
    } else if m.contains("flash") {
        Some(1)
    } else if m.contains("pro") {
        Some(0)
    } else {
        None
    }
}

/// Remaining fraction is how much quota is LEFT (0-1). The panel draws
/// used percent, so invert. One bar per tier, the worst model in it --
/// the same collapse Gemini's own `/model` display does.
fn parse_gemini(body: &str, now: i64) -> Option<UsageReport> {
    let parsed: serde_json::Value = serde_json::from_str(body).ok()?;
    let buckets = parsed.get("buckets")?.as_array()?;
    const TIERS: [(&str, &str); 3] = [("pro", "Pro"), ("flash", "Flash"), ("flash-lite", "Lite")];
    let mut best: [Option<(f64, Option<i64>)>; 3] = [None, None, None];
    for bucket in buckets {
        let model = bucket.get("modelId").and_then(|v| v.as_str()).unwrap_or("");
        let Some(idx) = gemini_tier_index(model) else { continue };
        let remaining = bucket.get("remainingFraction").and_then(as_percent)?;
        if remaining > 1.0 {
            continue;
        }
        let used = ((1.0 - remaining) * 100.0).max(0.0);
        let resets_at = bucket.get("resetTime").and_then(as_epoch_secs);
        if resets_at.is_some_and(|t| t <= now) {
            continue;
        }
        match best[idx] {
            Some((prev, _)) if prev >= used => {}
            _ => best[idx] = Some((used, resets_at)),
        }
    }
    let mut windows = Vec::new();
    for (i, (id, label)) in TIERS.iter().enumerate() {
        if let Some((pct, resets_at)) = best[i] {
            windows.push(window(id, label, pct, resets_at));
        }
    }
    if windows.is_empty() {
        return None;
    }
    Some(UsageReport::Ready { windows, plan: None, observed_at: now, cached: false })
}

fn gemini_usage(now: i64) -> (UsageReport, Option<i64>) {
    let path = match gemini_creds_path() {
        Some(p) if p.exists() => p,
        _ => {
            return (
                UsageReport::Unavailable {
                    reason: "gavin could not find Gemini CLI's login — run `gemini` and sign in"
                        .to_string(),
                    retry_after: None,
                },
                None,
            )
        }
    };
    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(_) => {
            return (
                UsageReport::Unavailable {
                    reason: "gavin could not read Gemini CLI's login — run `gemini` and sign in"
                        .to_string(),
                    retry_after: None,
                },
                None,
            )
        }
    };
    let creds = match gemini_creds(&raw) {
        Some(c) => c,
        None => {
            return (
                UsageReport::Unavailable {
                    reason: "Gemini CLI's login is not a session gavin can read — run `gemini` and sign in"
                        .to_string(),
                    retry_after: None,
                },
                None,
            )
        }
    };
    let expired = creds.expiry_ms.is_some_and(|ms| ms <= now * 1000);
    let access = if expired {
        match gemini_refresh(creds.refresh.as_deref()) {
            Some(t) => t,
            None => {
                return (
                    UsageReport::Unavailable {
                        reason: "Gemini CLI's login is not valid any more — run `gemini` and sign in"
                            .to_string(),
                        retry_after: None,
                    },
                    None,
                )
            }
        }
    } else {
        creds.access.clone()
    };

    let (body, status, park) = match gemini_post(GEMINI_QUOTA_URL, &access, "{}") {
        Ok(v) => v,
        Err(e) => return (UsageReport::Unavailable { reason: e, retry_after: None }, None),
    };
    match status {
        200 => match parse_gemini(&body, now) {
            Some(report) => (report, None),
            None => (
                UsageReport::Unavailable {
                    reason: "the Gemini usage endpoint answered in a shape gavin does not recognise"
                        .to_string(),
                    retry_after: None,
                },
                None,
            ),
        },
        401 if !expired => {
            // Access token looked current and was rejected; one refresh
            // then retry, rather than telling the user to sign in for a
            // clock skew.
            let Some(token) = gemini_refresh(creds.refresh.as_deref()) else {
                return (
                    UsageReport::Unavailable {
                        reason: "Gemini CLI's login is not valid any more — run `gemini` and sign in"
                            .to_string(),
                        retry_after: None,
                    },
                    None,
                );
            };
            match gemini_post(GEMINI_QUOTA_URL, &token, "{}") {
                Ok((body, 200, _)) => match parse_gemini(&body, now) {
                    Some(report) => (report, None),
                    None => (
                        UsageReport::Unavailable {
                            reason: "the Gemini usage endpoint answered in a shape gavin does not recognise"
                                .to_string(),
                            retry_after: None,
                        },
                        None,
                    ),
                },
                Ok((_, 429, park)) => gemini_rate_limited(now, park),
                Ok(_) | Err(_) => (
                    UsageReport::Unavailable {
                        reason: "Gemini CLI's login is not valid any more — run `gemini` and sign in"
                            .to_string(),
                        retry_after: None,
                    },
                    None,
                ),
            }
        }
        401 | 403 => (
            UsageReport::Unavailable {
                reason: gemini_denied_reason(&access, &body),
                retry_after: None,
            },
            None,
        ),
        429 => gemini_rate_limited(now, park),
        other => (
            UsageReport::Unavailable {
                reason: format!("the Gemini usage endpoint answered {other}"),
                retry_after: None,
            },
            None,
        ),
    }
}

fn gemini_rate_limited(now: i64, park: Option<i64>) -> (UsageReport, Option<i64>) {
    let until = park.unwrap_or(now + BACKOFF_SECS);
    (
        UsageReport::Unavailable {
            reason: "the usage endpoint rate-limited gavin".to_string(),
            retry_after: Some(until),
        },
        Some(until),
    )
}

/// 403 on retrieveUserQuota is the common case for consumer Google
/// accounts after Google shut down Code Assist OAuth for them
/// (2026-06-18). loadCodeAssist then names UNSUPPORTED_CLIENT; saying
/// "sign in" would send the user around a loop that cannot work.
fn gemini_denied_reason(access: &str, quota_body: &str) -> String {
    let subscription = quota_body.contains("SUBSCRIPTION_REQUIRED")
        || quota_body.contains("You do not have a valid license");
    let assist = gemini_post(
        GEMINI_ASSIST_URL,
        access,
        r#"{"metadata":{"ideType":"IDE_UNSPECIFIED","pluginType":"GEMINI"}}"#,
    )
    .ok();
    let unsupported = assist
        .as_ref()
        .map(|(body, _, _)| body.contains("UNSUPPORTED_CLIENT"))
        .unwrap_or(false);
    if unsupported || subscription {
        "this Gemini login has no Code Assist quota gavin can read — Google no longer publishes it for consumer accounts"
            .to_string()
    } else {
        "Gemini CLI's login is not valid any more — run `gemini` and sign in".to_string()
    }
}

fn gemini_refresh(refresh: Option<&str>) -> Option<String> {
    let refresh = refresh?;
    let form = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("client_id", GEMINI_OAUTH_CLIENT_ID)
        .append_pair("client_secret", GEMINI_OAUTH_CLIENT_SECRET)
        .append_pair("refresh_token", refresh)
        .append_pair("grant_type", "refresh_token")
        .finish();
    let config = format!(
        "url = \"{GEMINI_TOKEN_URL}\"\n\
         request = \"POST\"\n\
         header = \"Content-Type: application/x-www-form-urlencoded\"\n\
         data = \"{form}\"\n\
         silent\n\
         show-error\n\
         max-time = \"{TIMEOUT_SECS}\"\n\
         write-out = \"\\n%{{http_code}}\"\n"
    );
    let output = run_curl(&config).ok()?;
    let (body, status) = split_status(&output);
    if status != 200 {
        return None;
    }
    let parsed: serde_json::Value = serde_json::from_str(body).ok()?;
    nonempty(parsed.get("access_token")?.as_str()?)
}

fn gemini_post(url: &str, access: &str, json: &str) -> Result<(String, u16, Option<i64>), String> {
    if access.contains('"') || access.contains('\n') {
        return Err("Gemini CLI's login is not a session gavin can read".to_string());
    }
    let escaped = json.replace('\\', "\\\\").replace('"', "\\\"");
    let config = format!(
        "url = \"{url}\"\n\
         request = \"POST\"\n\
         header = \"Authorization: Bearer {access}\"\n\
         header = \"Content-Type: application/json\"\n\
         data = \"{escaped}\"\n\
         silent\n\
         show-error\n\
         max-time = \"{TIMEOUT_SECS}\"\n\
         write-out = \"\\n%{{http_code}}\"\n"
    );
    let output = run_curl(&config)?;
    let (body, status) = split_status(&output);
    let park = if status == 429 { Some(now_secs() + BACKOFF_SECS) } else { None };
    Ok((body.to_string(), status, park))
}

// ---- OpenCode Go ------------------------------------------------------------

const OPENCODE_GO_USAGE_URL: &str = "https://opencode.ai/zen/go/v1/usage";

fn opencode_auth_path() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("OPENCODE_DATA_DIR") {
        if !dir.is_empty() {
            return Some(PathBuf::from(dir).join("auth.json"));
        }
    }
    if let Some(xdg) = std::env::var_os("XDG_DATA_HOME") {
        if !xdg.is_empty() {
            return Some(PathBuf::from(xdg).join("opencode").join("auth.json"));
        }
    }
    Some(home_dir()?.join(".local").join("share").join("opencode").join("auth.json"))
}

fn opencode_go_key(raw: &str) -> Option<String> {
    let parsed: serde_json::Value = serde_json::from_str(raw).ok()?;
    if let Some(key) = parsed.pointer("/opencode-go/key").and_then(|v| v.as_str()) {
        return nonempty(key);
    }
    let accounts = parsed.get("accounts")?.as_array()?;
    for account in accounts {
        if account.get("id").and_then(|v| v.as_str()) == Some("opencode-go") {
            if let Some(key) = account.get("key").and_then(|v| v.as_str()) {
                return nonempty(key);
            }
        }
    }
    None
}

fn parse_opencode_go(body: &str, now: i64) -> Option<UsageReport> {
    let parsed: serde_json::Value = serde_json::from_str(body).ok()?;
    let usage = parsed.get("usage")?;
    let mut windows = Vec::new();
    for (key, label) in [("rolling", "5-hour"), ("weekly", "Weekly"), ("monthly", "Monthly")] {
        let Some(obj) = usage.get(key) else { continue };
        let Some(pct) = obj.get("percent").and_then(as_percent) else { continue };
        let resets_at = obj
            .get("resetsAt")
            .or_else(|| obj.get("resets_at"))
            .and_then(as_epoch_secs);
        if resets_at.is_some_and(|t| t <= now) {
            continue;
        }
        windows.push(window(key, label, pct, resets_at));
    }
    if windows.is_empty() {
        return None;
    }
    Some(UsageReport::Ready {
        windows,
        plan: Some("go".to_string()),
        observed_at: now,
        cached: false,
    })
}

fn opencode_go_usage(now: i64) -> (UsageReport, Option<i64>) {
    let path = match opencode_auth_path() {
        Some(p) if p.exists() => p,
        _ => {
            return (
                UsageReport::Unavailable {
                    reason: "gavin could not find an OpenCode Go login — OpenCode's own limits only exist on the Go plan"
                        .to_string(),
                    retry_after: None,
                },
                None,
            )
        }
    };
    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(_) => {
            return (
                UsageReport::Unavailable {
                    reason: "gavin could not read OpenCode's login".to_string(),
                    retry_after: None,
                },
                None,
            )
        }
    };
    let key = match opencode_go_key(&raw) {
        Some(k) => k,
        None => {
            return (
                UsageReport::Unavailable {
                    reason: "gavin could not find an OpenCode Go login — OpenCode's own limits only exist on the Go plan; BYO keys have none gavin can read"
                        .to_string(),
                    retry_after: None,
                },
                None,
            )
        }
    };
    if key.contains('"') || key.contains('\n') {
        return (
            UsageReport::Unavailable {
                reason: "OpenCode's Go login is not a key gavin can send".to_string(),
                retry_after: None,
            },
            None,
        );
    }
    let config = format!(
        "url = \"{OPENCODE_GO_USAGE_URL}\"\n\
         header = \"Authorization: Bearer {key}\"\n\
         header = \"Accept: application/json\"\n\
         silent\n\
         show-error\n\
         max-time = \"{TIMEOUT_SECS}\"\n\
         write-out = \"\\n%{{http_code}}\"\n"
    );
    let output = match run_curl(&config) {
        Ok(o) => o,
        Err(e) => return (UsageReport::Unavailable { reason: e, retry_after: None }, None),
    };
    let (body, status) = split_status(&output);
    match status {
        200 => match parse_opencode_go(body, now) {
            Some(report) => (report, None),
            None => (
                UsageReport::Unavailable {
                    reason: "the OpenCode usage endpoint answered in a shape gavin does not recognise"
                        .to_string(),
                    retry_after: None,
                },
                None,
            ),
        },
        401 => (
            UsageReport::Unavailable {
                reason: "OpenCode's Go login is not valid any more — run `/connect` in opencode and sign in to OpenCode Go"
                    .to_string(),
                retry_after: None,
            },
            None,
        ),
        403 => (
            UsageReport::Unavailable {
                reason: "this OpenCode account has no Go subscription — OpenCode's own limits only exist on the Go plan"
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
                reason: format!("the OpenCode usage endpoint answered {other}"),
                retry_after: None,
            },
            None,
        ),
    }
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

    /// The frontend reads `observedAt` and `retryAfter`, so the report has
    /// to spell them that way.
    ///
    /// Not a style guard: serde's container-level `rename_all` renames an
    /// enum's VARIANTS, never the fields of its struct variants, so a
    /// tagged report is the one shape where `rename_all = "camelCase"`
    /// looks applied and is not. A snake_case `observed_at` reaching
    /// `agentUsage.ts` is `undefined` there, which becomes a NaN sample
    /// timestamp, which makes every poll look like a new limit window --
    /// the projection then says "measuring" for the life of the app and
    /// never once draws a burn rate.
    #[test]
    fn a_report_serialises_the_field_names_the_frontend_reads() {
        let ready = UsageReport::Ready {
            windows: vec![UsageWindow {
                id: "five_hour".to_string(),
                label: "5-hour".to_string(),
                used_percent: 35.0,
                resets_at: Some(1_789_125_600),
            }],
            plan: Some("max".to_string()),
            observed_at: 1_789_100_000,
            cached: false,
        };
        let json = serde_json::to_value(&ready).expect("serialises");
        assert_eq!(json["state"], "ready");
        assert_eq!(json["observedAt"], 1_789_100_000);
        assert!(json.get("observed_at").is_none());
        assert_eq!(json["windows"][0]["usedPercent"], 35.0);

        let parked = UsageReport::Unavailable {
            reason: "the usage endpoint rate-limited gavin".to_string(),
            retry_after: Some(1_789_101_000),
        };
        let json = serde_json::to_value(&parked).expect("serialises");
        assert_eq!(json["retryAfter"], 1_789_101_000);
        assert!(json.get("retry_after").is_none());
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
    /// Custom is the only remaining `None`: every stock CLI now has a
    /// verified route, even if that route often answers Unavailable
    /// (Gemini consumer OAuth, OpenCode without Go).
    #[test]
    fn profiles_without_a_route_are_unsupported() {
        assert!(profile_by_id("custom").usage_probe.is_none());
        for id in ["claude-code", "codex", "gemini", "cursor", "opencode"] {
            assert!(profile_by_id(id).usage_probe.is_some(), "{id} has no probe");
        }
    }

    /// The cookie is `sub%3A%3Ajwt`, not the JWT alone. A request that
    /// sends only the token gets 204 from /api/auth/me and an empty
    /// usage-summary -- which would look like "no usage" rather than
    /// "not signed in".
    #[test]
    fn cursor_cookie_is_sub_then_the_jwt() {
        let token = fake_jwt(r#"{"sub":"user_01ABC","type":"session"}"#);
        assert_eq!(cursor_cookie(&token), Some(format!("user_01ABC%3A%3A{token}")));
        assert_eq!(jwt_sub("not-a-jwt"), None);
        assert_eq!(jwt_sub("a.%%%notbase64%%%.c"), None);
    }

    /// Live shape, 2026-09-11: Auto/API/Total percents on
    /// `individualUsage.plan`, billing cycle end as the shared reset,
    /// membershipType as the plan name. Percents are already 0-100
    /// (including values below 1.0, which mean 0.x percent, not
    /// fractions).
    #[test]
    fn cursor_windows_come_from_usage_summary_plan() {
        let now = 1_000_000;
        let body = r#"{
            "billingCycleEnd": "2026-10-02T14:11:55.000Z",
            "membershipType": "pro",
            "individualUsage": {
                "plan": {
                    "autoPercentUsed": 23.5,
                    "apiPercentUsed": 0,
                    "totalPercentUsed": 41.2
                },
                "onDemand": { "enabled": true, "used": 12, "limit": null }
            }
        }"#;
        let report = parse_cursor(body, now).expect("parses");
        let w = windows(&report);
        assert_eq!(w.len(), 3);
        assert_eq!(w[0].id, "total");
        assert_eq!(w[0].label, "Total");
        assert_eq!(w[0].used_percent, 41.2);
        assert_eq!(w[1].id, "auto");
        assert_eq!(w[1].used_percent, 23.5);
        assert_eq!(w[2].id, "api");
        assert_eq!(w[2].used_percent, 0.0);
        let end = parse_rfc3339("2026-10-02T14:11:55.000Z");
        assert_eq!(w[0].resets_at, end);
        assert!(matches!(&report, UsageReport::Ready { plan, .. } if plan.as_deref() == Some("pro")));
    }

    /// On-demand with no cap is not a window: drawing 0% would claim
    /// unlimited spend is empty quota. A capped on-demand row is a
    /// real limit and must show.
    #[test]
    fn cursor_on_demand_is_a_window_only_when_capped() {
        let now = 1_000_000;
        let capped = r#"{
            "billingCycleEnd": "2026-10-02T14:11:55.000Z",
            "individualUsage": {
                "plan": { "totalPercentUsed": 10.0 },
                "onDemand": { "enabled": true, "used": 250, "limit": 1000 }
            }
        }"#;
        let report = parse_cursor(capped, now).expect("parses");
        let w = windows(&report);
        let od = w.iter().find(|x| x.id == "on_demand").expect("capped on-demand");
        assert_eq!(od.label, "On-demand");
        assert_eq!(od.used_percent, 25.0);
    }

    /// Enterprise/team accounts report a personal cap under
    /// `individualUsage.overall` and no `plan` percents. A parser that
    /// only knows `plan` would show empty quota, which is how CodexBar
    /// used to read 100% remaining on those accounts.
    #[test]
    fn cursor_enterprise_overall_is_the_total_window() {
        let now = 1_000_000;
        let body = r#"{
            "billingCycleEnd": "2026-10-02T14:11:55.000Z",
            "membershipType": "enterprise",
            "individualUsage": {
                "overall": { "enabled": true, "used": 7384, "limit": 10000 }
            }
        }"#;
        let report = parse_cursor(body, now).expect("parses");
        let w = windows(&report);
        assert_eq!(w.len(), 1);
        assert_eq!(w[0].id, "total");
        assert!((w[0].used_percent - 73.84).abs() < 0.001);
    }

    #[test]
    fn a_cursor_cycle_that_has_already_reset_is_not_a_ready_report() {
        let now = parse_rfc3339("2026-09-11T00:00:00Z").unwrap();
        let body = r#"{
            "billingCycleEnd": "2020-01-01T00:00:00Z",
            "individualUsage": { "plan": { "totalPercentUsed": 96.0 } }
        }"#;
        assert!(parse_cursor(body, now).is_none());
        assert!(parse_cursor("{}", now).is_none());
    }

    /// Cursor.app stores the JWT as UTF-16LE in state.vscdb on some
    /// builds. Leaving the NULs in would make jwt_sub miss `sub` and
    /// every probe fail closed as "not signed in".
    #[test]
    fn vscdb_utf16_nuls_are_stripped() {
        let raw: String = "eyJ".chars().flat_map(|c| [c, '\0']).collect();
        assert_eq!(decode_vscdb_value(&raw), "eyJ");
        assert_eq!(decode_vscdb_value("eyJhbGciOi"), "eyJhbGciOi");
    }

    /// Cloud Code Assist buckets carry remainingFraction (left, 0-1)
    /// per model. The panel wants used percent, and one bar per tier
    /// (the worst model in that tier), matching what /model shows.
    #[test]
    fn gemini_buckets_collapse_to_pro_flash_and_lite() {
        let now = 1_000_000;
        let body = r#"{
            "buckets": [
                { "modelId": "gemini-3.1-pro-preview", "remainingFraction": 0.25, "resetTime": "2026-09-12T02:00:00Z", "tokenType": "REQUESTS" },
                { "modelId": "gemini-3-pro", "remainingFraction": 0.40, "resetTime": "2026-09-12T02:00:00Z" },
                { "modelId": "gemini-3-flash", "remainingFraction": 0.5, "resetTime": "2026-09-12T03:00:00Z" },
                { "modelId": "gemini-3-flash-lite", "remainingFraction": 1.0, "resetTime": "2026-09-12T03:00:00Z" }
            ]
        }"#;
        let report = parse_gemini(body, now).expect("parses");
        let w = windows(&report);
        assert_eq!(w.iter().map(|x| x.id.as_str()).collect::<Vec<_>>(), ["pro", "flash", "flash-lite"]);
        assert_eq!(w[0].used_percent, 75.0);
        assert_eq!(w[1].used_percent, 50.0);
        assert_eq!(w[2].used_percent, 0.0);
        assert_eq!(w[0].resets_at, parse_rfc3339("2026-09-12T02:00:00Z"));
    }

    #[test]
    fn gemini_omits_buckets_with_no_remaining_fraction() {
        let body = r#"{"buckets":[{"modelId":"gemini-3-pro"}]}"#;
        assert!(parse_gemini(body, 1_000_000).is_none());
        assert!(parse_gemini("{}", 1_000_000).is_none());
    }

    #[test]
    fn gemini_creds_yield_the_tokens_and_expiry() {
        let raw = r#"{"access_token":"ya29.a","refresh_token":"1//r","expiry_date":1700000000000}"#;
        let creds = gemini_creds(raw).expect("parses");
        assert_eq!(creds.access, "ya29.a");
        assert_eq!(creds.refresh.as_deref(), Some("1//r"));
        assert_eq!(creds.expiry_ms, Some(1_700_000_000_000));
        assert_eq!(gemini_creds(r#"{"other":1}"#), None);
        assert_eq!(gemini_creds(r#"{"access_token":"  "}"#), None);
    }

    /// OpenCode Go's official usage API: rolling / weekly / monthly
    /// percents with resetsAt. Same window labels as Claude and Codex
    /// for the 5-hour and weekly rows.
    #[test]
    fn opencode_go_windows_come_from_the_usage_object() {
        let now = 1_000_000;
        let body = r#"{
            "usage": {
                "rolling": { "percent": 12.5, "resetsAt": "2026-09-11T22:00:00Z" },
                "weekly": { "percent": 40.0, "resetsAt": "2026-09-15T00:00:00Z" },
                "monthly": { "percent": 55.0, "resetsAt": "2026-10-01T00:00:00Z" }
            }
        }"#;
        let report = parse_opencode_go(body, now).expect("parses");
        let w = windows(&report);
        assert_eq!(w.len(), 3);
        assert_eq!(w[0].id, "rolling");
        assert_eq!(w[0].label, "5-hour");
        assert_eq!(w[0].used_percent, 12.5);
        assert_eq!(w[1].id, "weekly");
        assert_eq!(w[2].id, "monthly");
        assert_eq!(w[0].resets_at, parse_rfc3339("2026-09-11T22:00:00Z"));
        assert!(matches!(&report, UsageReport::Ready { plan, .. } if plan.as_deref() == Some("go")));
    }

    #[test]
    fn opencode_go_key_reads_both_auth_json_shapes() {
        assert_eq!(
            opencode_go_key(r#"{"opencode-go":{"type":"api","key":"sk-go"}}"#).as_deref(),
            Some("sk-go")
        );
        assert_eq!(
            opencode_go_key(r#"{"accounts":[{"id":"opencode-go","key":"sk-list"}]}"#).as_deref(),
            Some("sk-list")
        );
        assert_eq!(opencode_go_key(r#"{"openrouter":{"key":"sk-or"}}"#), None);
        assert_eq!(opencode_go_key("not json"), None);
    }

    fn fake_jwt(payload: &str) -> String {
        format!("eyJhbGciOiJub25l.{}.sig", super::b64url_encode(payload.as_bytes()))
    }
}
