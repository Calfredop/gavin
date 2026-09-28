//! Handing ciphertext to Apple or Google.

use crate::apns::Apns;
use crate::fcm::Fcm;
use crate::log::Log;
use crate::store::Platform;
use std::future::Future;
use std::pin::Pin;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// Which APNs environment issued an iOS token: a development-signed build
/// gets its tokens from the sandbox, and a token only works against the
/// environment that issued it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ApnsEnvironment {
    Production,
    Development,
}

impl ApnsEnvironment {
    pub fn as_str(self) -> &'static str {
        match self {
            ApnsEnvironment::Production => "production",
            ApnsEnvironment::Development => "development",
        }
    }

    pub fn parse(text: &str) -> Option<ApnsEnvironment> {
        match text {
            "production" => Some(ApnsEnvironment::Production),
            "development" => Some(ApnsEnvironment::Development),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub enum Target<'a> {
    Apns { token: &'a str, environment: ApnsEnvironment },
    Fcm { token: &'a str },
}

impl Target<'_> {
    pub fn platform(&self) -> Platform {
        match self {
            Target::Apns { .. } => Platform::Ios,
            Target::Fcm { .. } => Platform::Android,
        }
    }
}

/// What Apple or Google made of a push. Every reason is their reason
/// CODE (`BadDeviceToken`, `UNAVAILABLE`, `timeout`), never a message
/// body and never a URL.
#[derive(Debug, PartialEq, Eq)]
pub enum Delivery {
    Delivered,
    /// The token is dead; stop using it until the Device registers another.
    TokenGone(String),
    /// Refused for good: sending the same push again cannot help.
    Rejected(String),
    /// Worth trying again later: throttled, down, or our credentials failed.
    Unavailable(String),
}

pub trait Sender: Send + Sync {
    fn supports(&self, platform: Platform) -> bool;
    fn send<'a>(&'a self, target: Target<'a>, ciphertext: &'a [u8]) -> BoxFuture<'a, Delivery>;
}

/// The real thing: APNs for iOS, FCM for Android, each only when its
/// credentials are configured.
pub struct Live {
    pub apns: Option<Apns>,
    pub fcm: Option<Fcm>,
}

impl Sender for Live {
    fn supports(&self, platform: Platform) -> bool {
        match platform {
            Platform::Ios => self.apns.is_some(),
            Platform::Android => self.fcm.is_some(),
        }
    }

    fn send<'a>(&'a self, target: Target<'a>, ciphertext: &'a [u8]) -> BoxFuture<'a, Delivery> {
        Box::pin(async move {
            match target {
                Target::Apns { token, environment } => match &self.apns {
                    Some(apns) => apns.send(token, environment, ciphertext).await,
                    None => Delivery::Rejected("apns-not-configured".into()),
                },
                Target::Fcm { token } => match &self.fcm {
                    Some(fcm) => fcm.send(token, ciphertext).await,
                    None => Delivery::Rejected("fcm-not-configured".into()),
                },
            }
        })
    }
}

/// Verifies and accounts for everything, delivers nothing: the gateway
/// the local dev stack runs, which never contacts Apple or Google.
pub struct DryRun {
    pub log: Log,
}

impl Sender for DryRun {
    fn supports(&self, _: Platform) -> bool {
        true
    }

    fn send<'a>(&'a self, target: Target<'a>, ciphertext: &'a [u8]) -> BoxFuture<'a, Delivery> {
        Box::pin(async move {
            self.log.info(format!(
                "dry run: would send {} bytes to {}",
                ciphertext.len(),
                target.platform().as_str()
            ));
            Delivery::Delivered
        })
    }
}

/// A reqwest error, as a reason code. Its Display is off limits: it
/// carries the URL, and an APNs URL carries the push token.
pub fn transport_reason(e: &reqwest::Error) -> String {
    if e.is_timeout() {
        "timeout"
    } else if e.is_connect() {
        "connect"
    } else if e.is_decode() {
        "decode"
    } else {
        "transport"
    }
    .to_string()
}

/// Apple's or Google's reason code, kept to the characters a code is made
/// of, so an unexpected response body cannot put anything else in the log.
pub fn reason_code(text: &str) -> String {
    let code: String = text
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        .take(64)
        .collect();
    if code.is_empty() {
        "unknown".into()
    } else {
        code
    }
}

/// The client both senders use. APNs speaks only HTTP/2, which rustls
/// negotiates by ALPN; ring is installed as rustls' provider first because
/// reqwest is built without one of its own (see Cargo.toml).
pub fn http_client() -> reqwest::Client {
    let _ = rustls::crypto::ring::default_provider().install_default();
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .expect("building the HTTP client")
}
