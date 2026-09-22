//! The one network call behind the turn verdict.
//!
//! The policy, the question set and the thresholds all live in
//! `app/src/lib/agents/turnVerdict.ts`, where they can be argued with in
//! a unit test. This module exists for the two things that CANNOT live
//! there, and both are about the key:
//!
//! **The key never reaches the frontend.** It is read here, on demand,
//! from `config.json` (which `config::save` writes 0600 for this
//! reason), handed to curl through a config on STDIN, and never
//! returned, never logged, never cached. The Settings panel is told
//! whether a key is SET -- a boolean -- and nothing else. That is the
//! same discipline `agent_usage.rs` holds for the agent CLIs' OAuth
//! tokens, and this module reuses that module's `run_curl` rather than
//! growing a second copy of it: a rule about argv is only a rule while
//! there is exactly one place that runs the process.
//!
//! **The address is ours, not the caller's.** `TYPESAFE_URL` is a
//! constant here and is deliberately NOT taken from the request the
//! frontend hands over. A host command that POSTs a bearer token to
//! whatever URL it is given is a credential-exfiltration primitive
//! wearing the costume of a parameter; the frontend chooses the
//! QUESTIONS, and the host chooses where they go.
//!
//! curl rather than an HTTP crate, for the reason `agent_usage.rs` gives:
//! the workspace has no TLS stack at all, and one authenticated POST does
//! not justify pulling rustls into a Tauri host that already shells out
//! to git.

use std::time::{Duration, Instant};

use crate::agent_usage::{run_curl, split_status};

/// TypeSafe's System One endpoint. The authority; `turnVerdict.ts`
/// carries the same string as documentation of where a screen goes, and
/// never sends it.
const TYPESAFE_URL: &str = "https://api.typesafe.ai/v1/systemone";

/// The whole budget for a verdict, retry included.
///
/// Two seconds against a measured ~0.7s p50. This is not a performance
/// knob: the verdict is taken at the moment a quiet session would be
/// called idle, and a rail's agent step waits on it. The feature's
/// promise is that it can only refine today's answer, and an answer that
/// arrives after the rail has moved on refines nothing -- so the budget
/// is what turns "slow" into "absent", which the caller already knows how
/// to handle.
const TOTAL_BUDGET: Duration = Duration::from_millis(2_000);

/// The least time worth starting a second attempt in. Below this the
/// retry would be spent on a `max-time` that expires before TLS finishes,
/// which is a worse outcome than reporting the first failure: it burns
/// the remaining budget and reports the same nothing.
const MIN_RETRY: Duration = Duration::from_millis(500);

/// What the Settings panel is allowed to know.
///
/// `has_key`, never the key. A boolean cannot be copied out of a
/// devtools console, pasted into a bug report, or persisted by a store
/// that happens to serialise itself.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TypeSafeSettings {
    /// Whether the human has turned the second opinion on. False unless
    /// they did: the request sends a session's screen tail to a third
    /// party, so this cannot be something discovered after the fact.
    pub enabled: bool,
    pub has_key: bool,
}

fn settings_from(config_dir: &std::path::Path) -> TypeSafeSettings {
    let cfg = crate::config::load(config_dir).ok().and_then(|c| c.typesafe);
    TypeSafeSettings {
        enabled: cfg.as_ref().and_then(|t| t.enabled).unwrap_or(false),
        has_key: cfg
            .as_ref()
            .and_then(|t| t.api_key.as_deref())
            .is_some_and(|k| !k.trim().is_empty()),
    }
}

/// Whether the verdict is on, and whether it has a key to pay with.
#[tauri::command]
pub fn typesafe_settings(app_handle: tauri::AppHandle) -> Result<TypeSafeSettings, String> {
    let dir = config_dir(&app_handle)?;
    Ok(settings_from(&dir))
}

/// Turn the second opinion on or off.
#[tauri::command]
pub fn set_typesafe_enabled(
    app_handle: tauri::AppHandle,
    enabled: bool,
) -> Result<TypeSafeSettings, String> {
    let dir = config_dir(&app_handle)?;
    write_typesafe(&dir, |t| t.enabled = Some(enabled))?;
    Ok(settings_from(&dir))
}

/// Store a key, or clear it.
///
/// An empty or whitespace-only string CLEARS rather than storing a key
/// that cannot work -- that is what emptying the field in Settings means,
/// and storing "" would leave `has_key` true against a key no request
/// could use.
#[tauri::command]
pub fn set_typesafe_api_key(
    app_handle: tauri::AppHandle,
    key: String,
) -> Result<TypeSafeSettings, String> {
    let trimmed = key.trim().to_string();
    if !trimmed.is_empty() {
        // Refused here rather than at the request, so the human finds out
        // while they are looking at the field. See `header_safe` for why
        // these two characters in particular.
        header_safe(&trimmed)?;
    }
    let dir = config_dir(&app_handle)?;
    write_typesafe(&dir, |t| {
        t.api_key = if trimmed.is_empty() { None } else { Some(trimmed.clone()) }
    })?;
    Ok(settings_from(&dir))
}

/// A quotation mark or a newline in the key would end the quoted value in
/// curl's config and let the rest of the string be read as further
/// OPTIONS -- another `url`, another `header`, an `output` path. A key is
/// not supposed to contain either, so refusing is free; the same check
/// guards `agent_usage.rs`'s `gemini_post`.
fn header_safe(key: &str) -> Result<(), String> {
    if key.contains('"') || key.contains('\n') || key.contains('\r') {
        return Err("A TypeSafe API key cannot contain a quotation mark or a line break.".into())
    }
    Ok(())
}

fn config_dir(app_handle: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    app_handle.path().app_config_dir().map_err(|e| e.to_string())
}

/// Read, change, write -- the whole of this feature's persistence.
///
/// Deliberately NOT through `persist_workspaces`: see
/// `AppConfig::typesafe`. That function rebuilds the config from the
/// app's in-memory mirror, and the key is never in it.
fn write_typesafe(
    config_dir: &std::path::Path,
    change: impl FnOnce(&mut crate::config::TypeSafeConfig),
) -> Result<(), String> {
    let mut cfg = crate::config::load(config_dir).map_err(|e| e.to_string())?;
    let mut typesafe = cfg.typesafe.take().unwrap_or_default();
    change(&mut typesafe);
    cfg.typesafe = Some(typesafe);
    crate::config::save(config_dir, &cfg).map_err(|e| e.to_string())
}

/// One verdict.
///
/// `async`, and it matters: a synchronous `#[tauri::command]` runs on the
/// thread that draws the window, so a two-second budget would be two
/// seconds of frozen UI -- on a transition that happens every time any
/// agent anywhere goes quiet. The blocking curl call goes to the blocking
/// pool from here.
///
/// `request` is the body `turnVerdict.ts` built: the model, the state and
/// the seven questions. It crosses as an opaque value because the
/// questions are frozen wording measured against a pinned model, and a
/// Rust-side copy of them is a second place for that wording to drift.
///
/// Every failure is an `Err` with a sentence in it, and the caller treats
/// all of them alike -- see the null contract in `turnVerdict.ts`.
#[tauri::command]
pub async fn typesafe_verdict(
    app_handle: tauri::AppHandle,
    request: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let dir = config_dir(&app_handle)?;
    tauri::async_runtime::spawn_blocking(move || verdict_blocking(&dir, &request))
        .await
        .map_err(|e| format!("the verdict request did not run: {e}"))?
}

fn verdict_blocking(
    config_dir: &std::path::Path,
    request: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let cfg = crate::config::load(config_dir)
        .map_err(|e| e.to_string())?
        .typesafe
        .unwrap_or_default();
    if cfg.enabled != Some(true) {
        return Err("the TypeSafe turn verdict is off".into());
    }
    let key = cfg
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|k| !k.is_empty())
        .ok_or("no TypeSafe API key is set")?;
    header_safe(key)?;

    let payload = serde_json::to_string(request).map_err(|e| e.to_string())?;
    let deadline = Instant::now() + TOTAL_BUDGET;

    let (body, status) = post(key, &payload, deadline)?;
    // One retry, and only for the two statuses that say "ask again": a
    // rate limit and an overload are the API telling gavin the request
    // was fine. Every other status is an answer, and repeating a bad
    // request inside a 2s budget spends the remainder learning nothing.
    let (body, status) = if matches!(status, 429 | 529) && Instant::now() + MIN_RETRY < deadline {
        post(key, &payload, deadline)?
    } else {
        (body, status)
    };

    if status != 200 {
        return Err(format!("TypeSafe answered {status}"));
    }
    serde_json::from_str(&body).map_err(|e| format!("TypeSafe sent something unreadable: {e}"))
}

/// One POST, bounded by what is left of the budget.
///
/// Every part of it travels on STDIN -- `-K -` makes curl read its whole
/// option set from there -- so neither the key nor the screen tail is
/// ever visible in `ps`.
fn post(key: &str, payload: &str, deadline: Instant) -> Result<(String, u16), String> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return Err("the verdict ran out of time".into());
    }
    // curl's config parser unescapes `\\` and `\"` inside a quoted value,
    // so JSON's own backslashes have to survive one more round. A newline
    // inside the screen tail is already `\n` in the JSON and becomes
    // `\\n` here, which curl hands back as `\n` -- the two-character
    // escape the JSON wanted, not a line break that would end the value.
    let escaped = payload.replace('\\', "\\\\").replace('"', "\\\"");
    let config = format!(
        "url = \"{TYPESAFE_URL}\"\n\
         request = \"POST\"\n\
         header = \"Authorization: Bearer {key}\"\n\
         header = \"Content-Type: application/json\"\n\
         header = \"Accept: application/json\"\n\
         data = \"{escaped}\"\n\
         silent\n\
         show-error\n\
         max-time = \"{secs:.3}\"\n\
         write-out = \"\\n%{{http_code}}\"\n",
        secs = remaining.as_secs_f64(),
    );
    let output = run_curl(&config)?;
    let (body, status) = split_status(&output);
    Ok((body.to_string(), status))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_key_with_a_quote_or_a_newline_is_refused() {
        // Not fussiness: a quotation mark ends the value in curl's config
        // and everything after it is read as further options.
        assert!(header_safe("sk-ts-ordinary-key").is_ok());
        assert!(header_safe("sk\"\nurl = \"http://evil").is_err());
        assert!(header_safe("sk-ts\nheader = \"X: y").is_err());
        assert!(header_safe("sk-ts\rheader = \"X: y").is_err());
    }

    #[test]
    fn settings_report_a_key_without_carrying_it() {
        let dir = tempfile::tempdir().unwrap();
        write_typesafe(dir.path(), |t| {
            t.enabled = Some(true);
            t.api_key = Some("sk-ts-secret".into());
        })
        .unwrap();
        let s = settings_from(dir.path());
        assert!(s.enabled);
        assert!(s.has_key);
        // The struct that crosses to the frontend has no field that could
        // carry the key, which is the guarantee -- not that this instance
        // happens not to.
        let json = serde_json::to_string(&s).unwrap();
        assert!(!json.contains("sk-ts-secret"), "the key must not cross to the frontend: {json}");
        assert_eq!(json, r#"{"enabled":true,"hasKey":true}"#);
    }

    #[test]
    fn a_blank_key_clears_rather_than_storing_an_unusable_one() {
        let dir = tempfile::tempdir().unwrap();
        write_typesafe(dir.path(), |t| t.api_key = Some("sk-ts-old".into())).unwrap();
        assert!(settings_from(dir.path()).has_key);
        // What emptying the Settings field means. Storing "" would leave
        // `has_key` true against a key no request could use.
        let trimmed = "   ".trim().to_string();
        write_typesafe(dir.path(), |t| {
            t.api_key = if trimmed.is_empty() { None } else { Some(trimmed.clone()) }
        })
        .unwrap();
        assert!(!settings_from(dir.path()).has_key);
    }

    #[test]
    fn the_verdict_is_off_until_it_is_turned_on() {
        // The design rule, pinned: a config nobody has touched sends
        // nothing anywhere, and neither does one with a key but no
        // consent.
        let dir = tempfile::tempdir().unwrap();
        let untouched = settings_from(dir.path());
        assert!(!untouched.enabled);
        assert!(!untouched.has_key);
        assert!(verdict_blocking(dir.path(), &serde_json::json!({})).is_err());

        write_typesafe(dir.path(), |t| t.api_key = Some("sk-ts-key".into())).unwrap();
        let err = verdict_blocking(dir.path(), &serde_json::json!({})).unwrap_err();
        assert!(err.contains("off"), "a key alone must not turn it on: {err}");
    }

    #[test]
    fn an_enabled_verdict_with_no_key_asks_for_one_rather_than_calling() {
        let dir = tempfile::tempdir().unwrap();
        write_typesafe(dir.path(), |t| t.enabled = Some(true)).unwrap();
        let err = verdict_blocking(dir.path(), &serde_json::json!({})).unwrap_err();
        assert!(err.contains("key"), "expected a missing-key error, got {err}");
    }

    /// The settings survive an ordinary workspace save, which rebuilds
    /// `AppConfig` from the app's in-memory mirror and knows nothing
    /// about this field.
    ///
    /// The exact failure `AppConfig::typesafe`'s doc comment is about: it
    /// is the one app-wide field `persist_workspaces` does not take as an
    /// argument, so it is carried forward from the file instead, and this
    /// is what says the carry actually happens.
    #[test]
    fn a_workspace_save_does_not_wipe_the_key() {
        let dir = tempfile::tempdir().unwrap();
        write_typesafe(dir.path(), |t| {
            t.enabled = Some(true);
            t.api_key = Some("sk-ts-survives".into());
        })
        .unwrap();

        let data = crate::session::WorkspacesData {
            workspaces: vec![],
            active_workspace_id: None,
            removed_workspaces: vec![],
        };
        crate::session::persist_workspaces(
            dir.path(),
            &data,
            Default::default(),
            Default::default(),
            Default::default(),
            Default::default(),
            None,
            Default::default(),
            None,
            None,
            None,
            Default::default(),
            crate::config::AgentDefaultsConfig::default(),
            crate::config::GitTrackingDefault::default(),
            crate::config::RequireReviewDefault::default(),
            None,
            None,
        )
        .unwrap();

        let after = settings_from(dir.path());
        assert!(after.enabled, "the toggle must survive a workspace save");
        assert!(after.has_key, "the key must survive a workspace save");
    }
}
