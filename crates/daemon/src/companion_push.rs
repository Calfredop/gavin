//! Post sealed Companion notifications to the Push gateway.
//!
//! The daemon holds the Device's notification key and send permission; it
//! never holds Apple's or Google's credentials (docs/push-gateway.md).
//! This module seals each event, POSTs the raw ciphertext with the
//! permission as a Bearer token, and maps the gateway's refusal codes.

use crate::notify_crypto::{
    self, NotifyOp, NotifyPlaintext, NotifyTarget, NOTIFICATION_KEY_LEN,
};
use std::io::Read;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

/// One event the desk asked the daemon to push.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CompanionPushEvent {
    Notify {
        id: String,
        kind: String,
        text: String,
        workspace_id: String,
        target: NotifyTarget,
    },
    Resolve {
        id: String,
    },
}

/// What the trust store must supply for one Device before a push can leave.
#[derive(Debug, Clone)]
pub struct DevicePushCreds {
    pub device_id: String,
    pub notification_key: Vec<u8>,
    pub send_permission: String,
    /// Next counter to seal with; bumped after each successful post.
    pub next_counter: u64,
}

/// Outcome of posting one sealed payload.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PushOutcome {
    Accepted,
    /// Drop the stored permission; the Device will mint a new one.
    DropPermission { code: String },
    /// Keep the permission; try again later.
    RetryLater { code: String, retry_after_secs: Option<u64> },
    /// Upstream refused this push for good; do not retry it.
    Rejected { code: String },
}

/// Where posts go. Real traffic uses HTTPS; tests inject a fake.
pub trait PushTransport: Send + Sync {
    fn post_ciphertext(
        &self,
        gateway_url: &str,
        permission: &str,
        ciphertext: &[u8],
    ) -> Result<TransportReply, String>;
}

#[derive(Debug, Clone)]
pub struct TransportReply {
    pub status: u16,
    pub retry_after_secs: Option<u64>,
    pub error_code: Option<String>,
}

/// The production transport: `ureq` over TLS.
pub struct UreqTransport;

impl PushTransport for UreqTransport {
    fn post_ciphertext(
        &self,
        gateway_url: &str,
        permission: &str,
        ciphertext: &[u8],
    ) -> Result<TransportReply, String> {
        let url = format!("{}/v1/push", gateway_url.trim_end_matches('/'));
        let response = ureq::post(&url)
            // A gateway that does not answer must not hold the push
            // worker, and every batch queued behind it, for good.
            .timeout(std::time::Duration::from_secs(15))
            .set("Authorization", &format!("Bearer {permission}"))
            .set("Content-Type", "application/octet-stream")
            .send_bytes(ciphertext);
        // ureq answers a 4xx or 5xx as an error that still carries the
        // response: the gateway's refusal code is in it, and `map_reply`
        // is what decides whether the permission is dropped.
        let response = match response {
            Ok(response) => response,
            Err(ureq::Error::Status(_, response)) => response,
            Err(e) => return Err(e.to_string()),
        };
        let status = response.status();
        let retry_after_secs = response
            .header("Retry-After")
            .and_then(|v| v.parse().ok());
        let error_code = if status == 202 {
            None
        } else {
            read_error_code(response)
        };
        Ok(TransportReply { status, retry_after_secs, error_code })
    }
}

fn read_error_code(response: ureq::Response) -> Option<String> {
    let mut body = String::new();
    let _ = response.into_reader().take(4096).read_to_string(&mut body);
    serde_json::from_str::<serde_json::Value>(&body)
        .ok()
        .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(str::to_owned))
}

/// Recorded by the in-memory fake used in Seam 1.
#[derive(Debug, Clone)]
pub struct RecordedPush {
    pub permission: String,
    pub ciphertext: Vec<u8>,
}

/// A fake gateway: accepts any permission not in `cancelled`, returns 202,
/// and keeps every body so a test can decrypt it.
#[allow(dead_code)] // exercised from `#[cfg(test)]` modules and Seam 1.
pub struct FakeGateway {
    pub cancelled: Mutex<std::collections::HashSet<String>>,
    pub posts: Mutex<Vec<RecordedPush>>,
}

impl FakeGateway {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            cancelled: Mutex::new(std::collections::HashSet::new()),
            posts: Mutex::new(Vec::new()),
        })
    }

    pub fn cancel(&self, permission: &str) {
        self.cancelled.lock().unwrap().insert(permission.to_string());
    }

    pub fn posts(&self) -> Vec<RecordedPush> {
        self.posts.lock().unwrap().clone()
    }
}

impl PushTransport for FakeGateway {
    fn post_ciphertext(
        &self,
        _gateway_url: &str,
        permission: &str,
        ciphertext: &[u8],
    ) -> Result<TransportReply, String> {
        if self.cancelled.lock().unwrap().contains(permission) {
            return Ok(TransportReply {
                status: 401,
                retry_after_secs: None,
                error_code: Some("permission_cancelled".into()),
            });
        }
        if ciphertext.is_empty() || ciphertext.len() > 2048 {
            return Ok(TransportReply {
                status: if ciphertext.is_empty() { 400 } else { 413 },
                retry_after_secs: None,
                error_code: Some(if ciphertext.is_empty() {
                    "empty_payload".into()
                } else {
                    "payload_too_large".into()
                }),
            });
        }
        self.posts.lock().unwrap().push(RecordedPush {
            permission: permission.to_string(),
            ciphertext: ciphertext.to_vec(),
        });
        Ok(TransportReply {
            status: 202,
            retry_after_secs: None,
            error_code: None,
        })
    }
}

impl PushTransport for Arc<FakeGateway> {
    fn post_ciphertext(
        &self,
        gateway_url: &str,
        permission: &str,
        ciphertext: &[u8],
    ) -> Result<TransportReply, String> {
        (**self).post_ciphertext(gateway_url, permission, ciphertext)
    }
}

fn map_reply(reply: TransportReply) -> PushOutcome {
    if reply.status == 202 {
        return PushOutcome::Accepted;
    }
    let code = reply.error_code.unwrap_or_else(|| format!("http_{}", reply.status));
    match code.as_str() {
        "permission_invalid" | "permission_expired" | "permission_cancelled" => {
            PushOutcome::DropPermission { code }
        }
        "rate_limited" | "upstream_unavailable" | "device_unreachable" => {
            PushOutcome::RetryLater {
                code,
                retry_after_secs: reply.retry_after_secs,
            }
        }
        _ => PushOutcome::Rejected { code },
    }
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn plaintext_for(event: &CompanionPushEvent) -> NotifyPlaintext {
    match event {
        CompanionPushEvent::Notify {
            id,
            kind,
            text,
            workspace_id,
            target,
        } => NotifyPlaintext {
            op: NotifyOp::Notify,
            id: id.clone(),
            kind: Some(kind.clone()),
            text: Some(text.clone()),
            workspace_id: Some(workspace_id.clone()),
            target: Some(target.clone()),
        },
        CompanionPushEvent::Resolve { id } => NotifyPlaintext {
            op: NotifyOp::Resolve,
            id: id.clone(),
            kind: None,
            text: None,
            workspace_id: None,
            target: None,
        },
    }
}

/// Seal and post one event for one Device. On `Accepted`, the caller must
/// persist `creds.next_counter + 1`.
pub fn push_one<T: PushTransport + ?Sized>(
    transport: &T,
    gateway_url: &str,
    creds: &DevicePushCreds,
    event: &CompanionPushEvent,
) -> Result<PushOutcome, String> {
    if creds.notification_key.len() != NOTIFICATION_KEY_LEN {
        return Err(format!(
            "notification key for {} is {} bytes, want {NOTIFICATION_KEY_LEN}",
            creds.device_id,
            creds.notification_key.len()
        ));
    }
    if creds.send_permission.is_empty() {
        return Err(format!("device {} has no send permission", creds.device_id));
    }
    let sealed = notify_crypto::seal(
        &creds.notification_key,
        creds.next_counter,
        now_secs(),
        &plaintext_for(event),
    )
    .map_err(|e| e.to_string())?;
    let reply = transport.post_ciphertext(gateway_url, &creds.send_permission, &sealed)?;
    Ok(map_reply(reply))
}

/// Seal and post every event to every Device that still has a permission.
/// Returns per-device outcomes; the caller persists counter bumps and
/// clears dropped permissions.
pub fn push_all<T: PushTransport + ?Sized>(
    transport: &T,
    gateway_url: &str,
    devices: &mut [DevicePushCreds],
    events: &[CompanionPushEvent],
) -> Vec<(String, PushOutcome)> {
    let mut out = Vec::new();
    for device in devices.iter_mut() {
        for event in events {
            match push_one(transport, gateway_url, device, event) {
                Ok(outcome) => {
                    if outcome == PushOutcome::Accepted {
                        device.next_counter = device.next_counter.saturating_add(1);
                    }
                    let drop = matches!(outcome, PushOutcome::DropPermission { .. });
                    out.push((device.device_id.clone(), outcome));
                    if drop {
                        device.send_permission.clear();
                        break;
                    }
                }
                Err(e) => {
                    out.push((
                        device.device_id.clone(),
                        PushOutcome::Rejected { code: e },
                    ));
                    break;
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::notify_crypto::open;

    fn key() -> Vec<u8> {
        (0u8..32).collect()
    }

    fn creds(permission: &str, counter: u64) -> DevicePushCreds {
        DevicePushCreds {
            device_id: "dev-1".into(),
            notification_key: key(),
            send_permission: permission.into(),
            next_counter: counter,
        }
    }

    fn asking() -> CompanionPushEvent {
        CompanionPushEvent::Notify {
            id: "session:s1".into(),
            kind: "asking".into(),
            text: "feat-x: which migration?".into(),
            workspace_id: "ws".into(),
            target: NotifyTarget::Session {
                session_id: "s1".into(),
            },
        }
    }

    #[test]
    fn seam_daemon_posts_ciphertext_that_decrypts_to_the_item() {
        let gateway = FakeGateway::new();
        let mut devices = [creds("perm-a", 1)];
        let outcomes = push_all(gateway.as_ref(), "http://push.test", &mut devices, &[asking()]);
        assert_eq!(outcomes, vec![("dev-1".into(), PushOutcome::Accepted)]);
        assert_eq!(devices[0].next_counter, 2);

        let posts = gateway.posts();
        assert_eq!(posts.len(), 1);
        assert_eq!(posts[0].permission, "perm-a");
        let opened = open(&key(), &posts[0].ciphertext).unwrap();
        assert_eq!(opened.counter, 1);
        assert_eq!(opened.body.op, NotifyOp::Notify);
        assert_eq!(opened.body.id, "session:s1");
        assert_eq!(opened.body.text.as_deref(), Some("feat-x: which migration?"));
        assert_eq!(
            opened.body.target,
            Some(NotifyTarget::Session {
                session_id: "s1".into()
            })
        );
    }

    #[test]
    fn cancelling_one_workstations_permission_leaves_the_other_working() {
        let gateway = FakeGateway::new();
        gateway.cancel("perm-a");

        let mut devices = [
            DevicePushCreds {
                device_id: "phone".into(),
                notification_key: key(),
                send_permission: "perm-a".into(),
                next_counter: 1,
            },
            DevicePushCreds {
                device_id: "tablet".into(),
                notification_key: {
                    let mut k = key();
                    k[0] ^= 0xff;
                    k
                },
                send_permission: "perm-b".into(),
                next_counter: 1,
            },
        ];
        // Two Workstations' permissions on one Device is the product case;
        // here two Devices stand in for two Workstation send permissions
        // held by the same phone, which is what cancel-one silences.
        let outcomes = push_all(gateway.as_ref(), "http://push.test", &mut devices, &[asking()]);
        assert_eq!(
            outcomes,
            vec![
                (
                    "phone".into(),
                    PushOutcome::DropPermission {
                        code: "permission_cancelled".into()
                    }
                ),
                ("tablet".into(), PushOutcome::Accepted),
            ]
        );
        assert!(devices[0].send_permission.is_empty());
        assert_eq!(devices[1].send_permission, "perm-b");
        assert_eq!(gateway.posts().len(), 1);
        assert_eq!(gateway.posts()[0].permission, "perm-b");
    }

    /// The live transport, against a gateway that refuses: ureq answers a
    /// 4xx as an error, and the refusal's code has to come out of it, or
    /// a cancelled permission is never dropped.
    #[test]
    fn the_live_transport_reads_the_gateways_refusal() {
        let gateway = testing::Gateway::answering(401, r#"{"error":"permission_cancelled"}"#);
        let reply = UreqTransport.post_ciphertext(&gateway.url(), "perm-x", b"sealed").unwrap();
        assert_eq!(reply.status, 401);
        assert_eq!(reply.error_code.as_deref(), Some("permission_cancelled"));
        assert_eq!(
            map_reply(reply),
            PushOutcome::DropPermission { code: "permission_cancelled".into() }
        );
        let posted = gateway.posts();
        assert_eq!(posted.len(), 1);
        assert_eq!(posted[0].permission, "perm-x");
        assert_eq!(posted[0].ciphertext, b"sealed");
    }

    #[test]
    fn the_live_transport_reads_an_accepted_push() {
        let gateway = testing::Gateway::answering(202, "");
        let reply = UreqTransport.post_ciphertext(&gateway.url(), "perm-x", b"sealed").unwrap();
        assert_eq!(map_reply(reply), PushOutcome::Accepted);
    }
}

/// A Push gateway on loopback for the live transport's tests: plain
/// HTTP, every `POST /v1/push` answered the same way and recorded.
#[cfg(test)]
pub(crate) mod testing {
    use super::RecordedPush;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};

    pub struct Gateway {
        port: u16,
        posts: Arc<Mutex<Vec<RecordedPush>>>,
    }

    impl Gateway {
        pub fn answering(status: u16, body: &'static str) -> Gateway {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            let posts = Arc::new(Mutex::new(Vec::new()));
            let recorded = Arc::clone(&posts);
            std::thread::spawn(move || {
                for stream in listener.incoming() {
                    let Ok(mut stream) = stream else { return };
                    let mut reader = BufReader::new(stream.try_clone().unwrap());
                    let mut length = 0usize;
                    let mut permission = String::new();
                    loop {
                        let mut line = String::new();
                        if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                            break;
                        }
                        let lower = line.to_ascii_lowercase();
                        if let Some(v) = lower.strip_prefix("content-length:") {
                            length = v.trim().parse().unwrap_or(0);
                        }
                        if lower.starts_with("authorization:") {
                            permission = line["authorization:".len()..].trim().trim_start_matches("Bearer ").to_string();
                        }
                    }
                    let mut ciphertext = vec![0u8; length];
                    let _ = reader.read_exact(&mut ciphertext);
                    recorded.lock().unwrap().push(RecordedPush { permission, ciphertext });
                    let _ = write!(
                        stream,
                        "HTTP/1.1 {status} X\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                }
            });
            Gateway { port, posts }
        }

        pub fn url(&self) -> String {
            format!("http://127.0.0.1:{}", self.port)
        }

        pub fn posts(&self) -> Vec<RecordedPush> {
            self.posts.lock().unwrap().clone()
        }
    }
}
