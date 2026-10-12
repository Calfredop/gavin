//! The CDP proxy every session's Playwright MCP connects through.
//!
//! The endpoint `gavin-mcp playwright` hands `--cdp-endpoint` is this, not
//! Chromium's own port, for three reasons the spike measured:
//!
//! - **The lazy launch.** Claude Code starts every MCP server when the
//!   agent starts, so only a proxy can launch the browser on the first
//!   `browser_*` call.
//! - **Crash recovery.** A browser that crashed comes back on a new port,
//!   which an MCP started with the old one never learns.
//! - **Following the agent.** A tab select (`Page.bringToFront`) is seen
//!   by no CDP client but the one that sent it, so the screencast can
//!   follow the agent's tab only by reading the MCP's commands.
//!
//! One listener per daemon, on loopback. Each session gets a path holding
//! a secret: `/devtools/browser/<secret>`. Anything else is answered 404.

use std::collections::{HashMap, HashSet};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tungstenite::Message;

use super::ws;

const UPSTREAM_DIAL: Duration = Duration::from_secs(5);

/// The path prefix a session's endpoint lives under: Chromium's own
/// spelling, so the endpoint reads like the browser it stands for.
pub const PATH_PREFIX: &str = "/devtools/browser/";

/// The secret a request path names, when it names one.
pub fn secret_of(path: &str) -> Option<&str> {
    path.strip_prefix(PATH_PREFIX).filter(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// What one MCP connection's traffic says about which tab its agent is
/// on. Fed every message in both directions; answers with the target to
/// follow when a message moves the agent.
///
/// CDP session ids are per websocket, so each proxied connection keeps
/// its own map from session to target, learned from the browser's
/// `Target.attachedToTarget` events.
#[derive(Default)]
pub struct Tap {
    targets: HashMap<String, String>,
    creating: HashSet<u64>,
}

/// The browser-to-MCP messages worth parsing are small; a screenshot or
/// a snapshot can be megabytes, and is skipped unread.
const SMALL: usize = 64 * 1024;

impl Tap {
    /// A command from the MCP.
    pub fn command(&mut self, text: &str) -> Option<String> {
        let message: serde_json::Value = serde_json::from_str(text).ok()?;
        let method = message.get("method")?.as_str()?;
        if method == "Target.createTarget" {
            if let Some(id) = message.get("id").and_then(|id| id.as_u64()) {
                self.creating.insert(id);
            }
            return None;
        }
        if !acts(method) {
            return None;
        }
        let session = message.get("sessionId")?.as_str()?;
        self.targets.get(session).cloned()
    }

    /// A message from the browser.
    pub fn event(&mut self, text: &str) -> Option<String> {
        if text.len() > SMALL {
            return None;
        }
        if text.contains("\"Target.attachedToTarget\"") || text.contains("\"Target.detachedFromTarget\"") {
            let message: serde_json::Value = serde_json::from_str(text).ok()?;
            let params = message.get("params")?;
            let session = params.get("sessionId")?.as_str()?.to_string();
            match message.get("method")?.as_str()? {
                "Target.attachedToTarget" => {
                    let target = params.get("targetInfo")?.get("targetId")?.as_str()?;
                    self.targets.insert(session, target.to_string());
                }
                _ => {
                    self.targets.remove(&session);
                }
            }
            return None;
        }
        if self.creating.is_empty() || !text.contains("\"targetId\"") {
            return None;
        }
        let message: serde_json::Value = serde_json::from_str(text).ok()?;
        let id = message.get("id")?.as_u64()?;
        if !self.creating.remove(&id) {
            return None;
        }
        Some(message.get("result")?.get("targetId")?.as_str()?.to_string())
    }
}

/// The commands that say which tab the agent is acting on: a select, a
/// navigation, and input. Everything else Playwright sends -- the
/// evaluations and the domain enables it runs on every page it attaches
/// to -- says nothing about where the agent is.
fn acts(method: &str) -> bool {
    matches!(method, "Page.bringToFront" | "Page.navigate" | "Page.reload" | "Page.navigateToHistoryEntry")
        || method.starts_with("Input.")
}

/// What the proxy needs from the browser module.
pub trait Sessions: Send + Sync + 'static {
    type Session: Send + Sync + 'static;
    /// The session a secret belongs to.
    fn by_secret(&self, secret: &str) -> Option<Arc<Self::Session>>;
    /// This session's browser, launched if it is not running.
    fn ensure_running(&self, session: &Arc<Self::Session>) -> Result<String, String>;
    /// The agent moved to `target`.
    fn follow(&self, session: &Arc<Self::Session>, target: String);
}

/// Binds the listener and serves it on a thread of its own.
pub fn start<S: Sessions>(sessions: Arc<S>) -> std::io::Result<SocketAddr> {
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    let addr = listener.local_addr()?;
    std::thread::Builder::new().name("browser-proxy".into()).spawn(move || {
        for conn in listener.incoming() {
            let Ok(conn) = conn else { continue };
            let sessions = Arc::clone(&sessions);
            let _ = std::thread::Builder::new().name("browser-proxy-conn".into()).spawn(move || {
                if let Err(e) = serve(conn, &sessions) {
                    eprintln!("gavin-daemon: browser proxy: {e}");
                }
            });
        }
    })?;
    Ok(addr)
}

fn serve<S: Sessions>(conn: TcpStream, sessions: &Arc<S>) -> anyhow::Result<()> {
    let (mut client, session) = ws::accept(conn, |path| secret_of(path).and_then(|s| sessions.by_secret(s)))?;
    let url = match sessions.ensure_running(&session) {
        Ok(url) => url,
        Err(reason) => {
            // The MCP shows the close reason as its tool error. A close
            // frame's reason is at most 123 bytes.
            let reason: String = reason.chars().take(120).collect();
            let _ = client.write.close(Some(tungstenite::protocol::CloseFrame {
                code: tungstenite::protocol::frame::coding::CloseCode::Error,
                reason: reason.into(),
            }));
            let _ = client.write.flush();
            return Ok(());
        }
    };
    let mut upstream = match ws::connect(&url, UPSTREAM_DIAL) {
        Ok(upstream) => upstream,
        Err(e) => {
            ws::shut(&client.shut);
            return Err(e);
        }
    };

    let tap = Arc::new(Mutex::new(Tap::default()));
    let client_shut = client.shut.try_clone()?;
    let upstream_shut = upstream.shut.try_clone()?;

    // MCP -> browser on a thread of its own; browser -> MCP here.
    let to_browser = {
        let tap = Arc::clone(&tap);
        let sessions = Arc::clone(sessions);
        let session = Arc::clone(&session);
        let mut from_client = client.read;
        let mut to_upstream = upstream.write;
        let (client_shut, upstream_shut) = (client_shut.try_clone()?, upstream_shut.try_clone()?);
        std::thread::Builder::new().name("browser-proxy-up".into()).spawn(move || {
            loop {
                let message = match from_client.read() {
                    Ok(message) => message,
                    Err(_) => break,
                };
                if let Message::Text(text) = &message {
                    let moved = tap.lock().unwrap().command(text.as_str());
                    if let Some(target) = moved {
                        sessions.follow(&session, target);
                    }
                }
                let closing = matches!(message, Message::Close(_));
                if to_upstream.send(message).is_err() || closing {
                    break;
                }
            }
            ws::shut(&client_shut);
            ws::shut(&upstream_shut);
        })?
    };

    loop {
        let message = match upstream.read.read() {
            Ok(message) => message,
            Err(_) => break,
        };
        if let Message::Text(text) = &message {
            let created = tap.lock().unwrap().event(text.as_str());
            if let Some(target) = created {
                sessions.follow(&session, target);
            }
        }
        let closing = matches!(message, Message::Close(_));
        if client.write.send(message).is_err() || closing {
            break;
        }
    }
    ws::shut(&client_shut);
    ws::shut(&upstream_shut);
    let _ = to_browser.join();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn attached(session: &str, target: &str) -> String {
        serde_json::json!({
            "method": "Target.attachedToTarget",
            "params": { "sessionId": session, "targetInfo": { "targetId": target, "type": "page" }, "waitingForDebugger": false }
        })
        .to_string()
    }

    #[test]
    fn a_select_navigation_or_input_moves_the_follow_to_that_sessions_target() {
        let mut tap = Tap::default();
        assert_eq!(tap.event(&attached("S0", "T0")), None);
        assert_eq!(tap.event(&attached("S1", "T1")), None);
        let cmd = |method: &str, session: &str| {
            serde_json::json!({ "id": 9, "method": method, "params": {}, "sessionId": session }).to_string()
        };
        assert_eq!(tap.command(&cmd("Page.bringToFront", "S0")), Some("T0".into()));
        assert_eq!(tap.command(&cmd("Page.navigate", "S1")), Some("T1".into()));
        assert_eq!(tap.command(&cmd("Input.dispatchMouseEvent", "S0")), Some("T0".into()));
        // What Playwright runs on every page it attaches to says nothing.
        assert_eq!(tap.command(&cmd("Runtime.evaluate", "S1")), None);
        assert_eq!(tap.command(&cmd("Page.enable", "S1")), None);
        // A session the browser never announced is nobody's.
        assert_eq!(tap.command(&cmd("Page.navigate", "S9")), None);
    }

    #[test]
    fn a_new_tab_is_followed_from_the_reply_to_its_create() {
        let mut tap = Tap::default();
        let create = r#"{"id":41,"method":"Target.createTarget","params":{"url":"about:blank"}}"#;
        assert_eq!(tap.command(create), None);
        assert_eq!(tap.event(r#"{"id":40,"result":{"targetId":"OTHER"}}"#), None);
        assert_eq!(tap.event(r#"{"id":41,"result":{"targetId":"NEW"}}"#), Some("NEW".into()));
        // Answered once.
        assert_eq!(tap.event(r#"{"id":41,"result":{"targetId":"NEW"}}"#), None);
    }

    #[test]
    fn a_detached_session_stops_naming_its_target() {
        let mut tap = Tap::default();
        tap.event(&attached("S0", "T0"));
        tap.event(r#"{"method":"Target.detachedFromTarget","params":{"sessionId":"S0","targetId":"T0"}}"#);
        assert_eq!(
            tap.command(r#"{"id":1,"method":"Page.bringToFront","params":{},"sessionId":"S0"}"#),
            None
        );
    }

    #[test]
    fn a_large_message_is_not_parsed() {
        let mut tap = Tap::default();
        tap.command(r#"{"id":7,"method":"Target.createTarget","params":{}}"#);
        let huge = format!(r#"{{"id":7,"result":{{"targetId":"T","data":"{}"}}}}"#, "A".repeat(SMALL));
        assert_eq!(tap.event(&huge), None);
    }

    #[test]
    fn only_a_hex_secret_under_the_prefix_is_a_secret() {
        assert_eq!(secret_of("/devtools/browser/0a1b2c"), Some("0a1b2c"));
        assert_eq!(secret_of("/devtools/browser/"), None);
        assert_eq!(secret_of("/devtools/browser/../x"), None);
        assert_eq!(secret_of("/json/version"), None);
    }
}
