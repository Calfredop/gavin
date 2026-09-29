//! The three things the daemon asks a running Headroom.
//!
//! `/readyz` for readiness, `/health` to recognise a proxy after a
//! crash, and `/stats` for the lifetime total, what one session saved,
//! and whether it has reached Headroom at all. All three are loopback
//! GETs with short deadlines: the supervisor asks on every tick, and a
//! proxy that does not answer in a second is not ready in any sense that
//! matters to an agent about to be pointed at it.
//!
//! The shapes below were read off Headroom 0.39.1 itself, and are pinned
//! with the version.

use super::launch::HOST;
use std::io::Read;
use std::time::Duration;

/// What `/health` says its `service` is. The name is the check: any
/// HTTP server can answer 200 on a port.
pub const SERVICE: &str = "headroom-proxy";

const CONNECT_TIMEOUT: Duration = Duration::from_millis(500);
const READ_TIMEOUT: Duration = Duration::from_secs(3);
/// `/stats` is megabytes on a proxy that has been up for weeks (it
/// carries request history), and one number of it is read.
const MAX_BODY_BYTES: u64 = 32 * 1024 * 1024;

/// The part of `/health` that identifies a proxy.
///
/// `config.pid` is in the same reply and is deliberately not read. The
/// process is identified by the pid and start time the daemon recorded
/// when it spawned it; the proxy's own account of its pid differs from
/// that whenever the located file is a wrapper that starts Python as a
/// child, and a check that refuses gavin's own Headroom costs every
/// compressed agent a dropped request at every daemon restart.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Health {
    pub service: String,
    pub version: String,
}

fn get(port: u16, path: &str) -> Option<(u16, String)> {
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(CONNECT_TIMEOUT)
        .timeout(READ_TIMEOUT)
        // A loopback call must never leave through the human's proxy.
        .try_proxy_from_env(false)
        .build();
    let response = match agent.get(&format!("http://{HOST}:{port}{path}")).call() {
        Ok(response) => response,
        Err(ureq::Error::Status(code, _)) => return Some((code, String::new())),
        Err(_) => return None,
    };
    let status = response.status();
    let mut body = String::new();
    response.into_reader().take(MAX_BODY_BYTES).read_to_string(&mut body).ok()?;
    Some((status, body))
}

/// Whether Headroom says it will take traffic. A cold compression model
/// does not fail this -- the proxy is ready before the model is -- which
/// is one reason setup prefetches it.
pub fn ready(port: u16) -> bool {
    matches!(get(port, "/readyz"), Some((200, _)))
}

pub fn health(port: u16) -> Option<Health> {
    match get(port, "/health")? {
        (200, body) => read_health(&body),
        _ => None,
    }
}

/// What Headroom saved one session, as its `/stats` reports it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SessionSavings {
    pub tokens_saved: u64,
    /// The requests Headroom saw tagged with the session.
    pub requests: u64,
}

/// The session's entry in `/stats`' per-project savings, or `None` when
/// Headroom did not answer or has no entry for it.
///
/// No entry is not a saving of zero. Headroom 0.39.1 keeps at most 50
/// projects and evicts the one that saved least whenever a new one
/// arrives (`savings_tracker.py`, `DEFAULT_MAX_PROJECTS`), so a session
/// that is missing may have sent nothing, or may have been pushed out.
/// The same eviction resets a session that comes back, which is why an
/// entry can undercount in a busy fleet.
pub fn session_savings(port: u16, session_id: &str) -> Option<SessionSavings> {
    match get(port, "/stats")? {
        (200, body) => read_session_savings(&body, session_id),
        _ => None,
    }
}

/// How many sessions Headroom 0.39.1 keeps in `per_project` before it
/// evicts one (`savings_tracker.py`, `DEFAULT_MAX_PROJECTS`), for a
/// `/stats` that does not say. Pinned with the version; the reply's own
/// `persistent_savings.projects_limit` wins when it is there.
pub const DEFAULT_PROJECTS_LIMIT: u64 = 50;

/// What `/stats` says of one session's requests, with what it takes to
/// believe an absence.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProjectView {
    /// The requests Headroom counted under the session's tag, or `None`
    /// when it has no entry for it.
    pub requests: Option<u64>,
    /// How many sessions `per_project` holds right now.
    pub kept: u64,
    /// How many it holds before it evicts the one that saved least.
    pub limit: u64,
}

/// The session's place in `/stats`' per-project map, or `None` when
/// Headroom did not answer, or answered with something that is not a
/// map of projects.
pub fn project_view(port: u16, session_id: &str) -> Option<ProjectView> {
    match get(port, "/stats")? {
        (200, body) => read_project_view(&body, session_id),
        _ => None,
    }
}

pub fn lifetime_tokens_saved(port: u16) -> Option<u64> {
    match get(port, "/stats")? {
        (200, body) => read_lifetime_tokens_saved(&body),
        _ => None,
    }
}

fn read_health(body: &str) -> Option<Health> {
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    Some(Health {
        service: value.get("service")?.as_str()?.to_string(),
        version: value.get("version")?.as_str()?.to_string(),
    })
}

/// `persistent_savings.lifetime.tokens_saved`: what Headroom has saved
/// since its state directory was created. Tokens -- gavin computes no
/// dollar cost anywhere, and the dollar fields beside this one are left
/// unread.
fn read_lifetime_tokens_saved(body: &str) -> Option<u64> {
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    value.get("persistent_savings")?.get("lifetime")?.get("tokens_saved")?.as_u64()
}

/// `savings.per_project.<session id>`: a compressed session is tagged
/// with its gavin session id as Headroom's project (`compress.rs`), and
/// Headroom keys its per-project savings by that tag. Tokens only, like
/// the lifetime total.
fn read_session_savings(body: &str, session_id: &str) -> Option<SessionSavings> {
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    let entry = value.get("savings")?.get("per_project")?.get(session_id)?;
    Some(SessionSavings {
        tokens_saved: entry.get("tokens_saved")?.as_u64()?,
        requests: entry.get("requests")?.as_u64()?,
    })
}

/// `savings.per_project`, read for one session: its request count when
/// it has an entry, and the map's size beside its limit, which is what
/// says whether a missing entry was ever there (`reach.rs`).
fn read_project_view(body: &str, session_id: &str) -> Option<ProjectView> {
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    let projects = value.get("savings")?.get("per_project")?.as_object()?;
    let limit = value
        .get("persistent_savings")
        .and_then(|persistent| persistent.get("projects_limit"))
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(DEFAULT_PROJECTS_LIMIT);
    Some(ProjectView {
        requests: projects.get(session_id).and_then(|entry| entry.get("requests")?.as_u64()),
        kept: projects.len() as u64,
        limit,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;

    /// `/health` from Headroom 0.39.1 on 2026-09-29, trimmed to the keys
    /// around the ones read.
    const HEALTH_0_39_1: &str = r#"{"service":"headroom-proxy","status":"healthy","ready":true,
        "version":"0.39.1","timestamp":"2026-09-29T01:27:08.417314Z","uptime_seconds":4.503,
        "checks":{"startup":{"enabled":true,"ready":true,"status":"healthy","error":null},
        "kompress":{"enabled":true,"ready":false,"status":"degraded","optional":true,"backend":null}},
        "rust_core":"loaded",
        "config":{"backend":"anthropic","optimize":true,"cache":true,"memory":false,"learn":false,
        "savings_profile":"coding","pid":39205}}"#;

    /// `/stats`' `savings` and `persistent_savings` from the same run,
    /// with a total and one session's entry put in. A project entry
    /// carries the keys `_projects_snapshot_locked` gives it in 0.39.1.
    const STATS_0_39_1: &str = r#"{"summary":{},
        "savings":{"total_tokens":182044,
        "per_project":{"0b6c4a52-7f0e-4d0c-9a53-3f6f0c1f2a11":{"requests":37,"tokens_saved":41200,
        "compression_savings_usd":0.12,"total_input_tokens":250000,"total_input_cost_usd":0.75,
        "last_activity_at":"2026-09-29T01:40:00Z","savings_percent":14.15}},
        "by_source":[],"by_layer":{}},
        "persistent_savings":{"schema_version":6,
        "storage_path":"/state/headroom/proxy_savings.json",
        "lifetime":{"requests":41,"tokens_saved":182044,"compression_savings_usd":0.55,
        "savings_basis":"unknown","total_input_tokens":903112},
        "display_session":{"requests":3,"tokens_saved":912},
        "projects":{},"projects_limit":50,"by_model":{}},"config":{}}"#;

    const SESSION: &str = "0b6c4a52-7f0e-4d0c-9a53-3f6f0c1f2a11";

    #[test]
    fn health_is_read_in_the_shape_the_pinned_headroom_answers() {
        assert_eq!(
            read_health(HEALTH_0_39_1),
            Some(Health { service: "headroom-proxy".into(), version: "0.39.1".into() })
        );
    }

    #[test]
    fn a_body_that_is_not_headrooms_health_is_no_health() {
        for body in ["", "OK", "<html>404</html>", r#"{"status":"ok"}"#, r#"{"service":7,"version":"1"}"#]
        {
            assert_eq!(read_health(body), None, "{body:?}");
        }
    }

    #[test]
    fn the_lifetime_total_is_tokens_from_persistent_savings() {
        assert_eq!(read_lifetime_tokens_saved(STATS_0_39_1), Some(182_044));
        assert_eq!(read_lifetime_tokens_saved(r#"{"persistent_savings":{}}"#), None);
        assert_eq!(read_lifetime_tokens_saved("not json"), None);
    }

    #[test]
    fn a_sessions_savings_are_its_per_project_entry() {
        assert_eq!(
            read_session_savings(STATS_0_39_1, SESSION),
            Some(SessionSavings { tokens_saved: 41_200, requests: 37 })
        );
    }

    /// Absent is not zero: the session may have sent nothing, or been
    /// evicted from a full map.
    #[test]
    fn a_session_headroom_has_no_entry_for_has_no_savings() {
        assert_eq!(read_session_savings(STATS_0_39_1, "some-other-session"), None);
        assert_eq!(read_session_savings(r#"{"savings":{}}"#, SESSION), None);
        assert_eq!(read_session_savings(r#"{"persistent_savings":{}}"#, SESSION), None);
        assert_eq!(read_session_savings("not json", SESSION), None);
        let half = format!(r#"{{"savings":{{"per_project":{{"{SESSION}":{{"tokens_saved":5}}}}}}}}"#);
        assert_eq!(read_session_savings(&half, SESSION), None, "both numbers or neither");
    }

    #[test]
    fn a_sessions_reach_is_its_request_count_beside_the_maps_size_and_limit() {
        assert_eq!(
            read_project_view(STATS_0_39_1, SESSION),
            Some(ProjectView { requests: Some(37), kept: 1, limit: 50 })
        );
        assert_eq!(
            read_project_view(STATS_0_39_1, "a-session-that-sent-nothing"),
            Some(ProjectView { requests: None, kept: 1, limit: 50 })
        );
    }

    /// The limit is Headroom's own word when it gives one, and the pinned
    /// version's when it does not.
    #[test]
    fn the_limit_is_read_from_the_reply_and_otherwise_is_the_pinned_one() {
        let said = r#"{"savings":{"per_project":{}},"persistent_savings":{"projects_limit":7}}"#;
        assert_eq!(read_project_view(said, SESSION), Some(ProjectView { requests: None, kept: 0, limit: 7 }));
        let unsaid = r#"{"savings":{"per_project":{}}}"#;
        assert_eq!(
            read_project_view(unsaid, SESSION),
            Some(ProjectView { requests: None, kept: 0, limit: DEFAULT_PROJECTS_LIMIT })
        );
    }

    /// No map at all is no answer -- not "absent from an empty map",
    /// which would read as a session that sent nothing.
    #[test]
    fn a_reply_with_no_per_project_map_says_nothing_about_a_session() {
        for body in ["not json", r#"{"savings":{}}"#, r#"{"savings":{"per_project":[]}}"#, "{}"] {
            assert_eq!(read_project_view(body, SESSION), None, "{body}");
        }
    }

    /// A server that answers each path with a fixed status and body,
    /// for as many requests as the test makes.
    fn serve(routes: Vec<(&'static str, u16, &'static str)>) -> u16 {
        let listener = TcpListener::bind((HOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut request_line = String::new();
                if reader.read_line(&mut request_line).is_err() {
                    continue;
                }
                let mut header = String::new();
                while reader.read_line(&mut header).is_ok_and(|n| n > 0) && header.trim() != "" {
                    header.clear();
                }
                let path = request_line.split_whitespace().nth(1).unwrap_or("/");
                let (status, body) = routes
                    .iter()
                    .find(|(route, _, _)| *route == path)
                    .map(|(_, status, body)| (*status, *body))
                    .unwrap_or((404, "{}"));
                let _ = write!(
                    stream,
                    "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
            }
        });
        port
    }

    #[test]
    fn a_proxy_is_ready_only_when_readyz_answers_200() {
        let ready_port = serve(vec![("/readyz", 200, r#"{"ready":true}"#)]);
        let loading_port = serve(vec![("/readyz", 503, r#"{"ready":false}"#)]);
        assert!(ready(ready_port));
        assert!(!ready(loading_port));
    }

    #[test]
    fn nothing_listening_is_not_ready_and_has_no_health() {
        // Bound and dropped: a port the OS just confirmed is free.
        let port = TcpListener::bind((HOST, 0)).unwrap().local_addr().unwrap().port();
        assert!(!ready(port));
        assert_eq!(health(port), None);
        assert_eq!(lifetime_tokens_saved(port), None);
        assert_eq!(session_savings(port, SESSION), None);
        assert_eq!(project_view(port, SESSION), None);
    }

    #[test]
    fn health_and_stats_are_read_over_the_wire() {
        let port = serve(vec![("/health", 200, HEALTH_0_39_1), ("/stats", 200, STATS_0_39_1)]);
        assert_eq!(health(port).unwrap().version, "0.39.1");
        assert_eq!(lifetime_tokens_saved(port), Some(182_044));
        assert_eq!(session_savings(port, SESSION), Some(SessionSavings { tokens_saved: 41_200, requests: 37 }));
        assert_eq!(project_view(port, SESSION), Some(ProjectView { requests: Some(37), kept: 1, limit: 50 }));
    }

    /// Something else on the port: it answers, and it is not Headroom.
    #[test]
    fn a_stranger_on_the_port_has_no_health() {
        let port = serve(vec![("/health", 200, r#"{"status":"ok"}"#)]);
        assert_eq!(health(port), None);
    }
}
