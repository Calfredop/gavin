//! The Relay's wire contract: what a Workstation and a Device say to the
//! Relay before it starts copying bytes between them.
//!
//! The Relay carries traffic it cannot read (`CONTEXT.md`), so there is
//! very little here, and all of it is about being matched up: who may
//! connect (the admission token), who is looking for whom (the rendezvous
//! id), and which stream a Workstation is picking up. Everything after
//! that is Noise ciphertext the Relay copies verbatim.
//!
//! It lives in this crate, with no operating-system part to it, because
//! three programs are written against it and must agree byte for byte:
//! the Relay, the daemon that dials it, and the Companion core -- which is
//! built for `wasm32-unknown-unknown`.
//!
//! **The first frame.** Every WebSocket to the Relay opens with one TEXT
//! frame, a `RelayHello`. The admission token rides in that frame rather
//! than in a header or in the URL, for two reasons. A webview's
//! `WebSocket` cannot set a request header, so a header would shut out the
//! one client the Relay exists for. And a token in a URL is a token in
//! every reverse proxy's access log. It also leaves the Relay URL opaque:
//! it is dialled exactly as the human typed it, whatever path their proxy
//! mounts the Relay under.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// The version every `RelayHello` names. A Relay that does not speak it
/// answers `Refused { reason: Version }` rather than guessing.
pub const RELAY_WIRE_VERSION: u32 = 1;

/// The largest first frame the Relay reads. A hello is a token, two ids
/// and a label; four kilobytes is room for a long token and nothing else.
pub const MAX_HELLO_BYTES: usize = 4096;

/// The largest WebSocket message the Relay copies, and the largest either
/// end sends. One frame of the Device wire is at most 65537 bytes; this
/// is room for one and no more than that.
pub const MAX_STREAM_MESSAGE_BYTES: usize = 128 * 1024;

/// The purpose of a stream that runs the pairing handshake. A label to
/// the Relay, which forwards it without reading it, so a purpose added
/// later needs no Relay release.
pub const PURPOSE_PAIR: &str = "pair";

/// The longest purpose label the Relay will forward.
pub const MAX_PURPOSE_BYTES: usize = 32;

/// The domain separator for `rendezvous_id`, with a version in it for the
/// reason `pairing_sas`'s has one: a change to the derivation is then a
/// different id rather than the same id meaning two things.
const RENDEZVOUS_CONTEXT: &[u8] = b"gavin-relay-rendezvous-v1";

/// Where a Workstation and its Devices meet on a Relay.
///
/// ```text
/// id = hex(SHA-256("gavin-relay-rendezvous-v1" || workstation static public key))
/// ```
///
/// A hash of the key rather than the key, so the Relay's operator is not
/// handed the one value a Device pins. It is stable for as long as the
/// key is, which is what lets a Device find its Workstation again, and it
/// changes when "Revoke all" rotates the key, which is what strands every
/// Device that pinned the old one.
///
/// It proves nothing. Anyone admitted to the Relay can register under any
/// id; what they cannot do is complete the Noise handshake, because the
/// Device pinned the Workstation's key. A Relay that matches the wrong two
/// parties causes a failed handshake, never a wrong answer.
pub fn rendezvous_id(workstation_public_key: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(RENDEZVOUS_CONTEXT);
    h.update(workstation_public_key);
    crate::hex_encode(&h.finalize())
}

/// Whether `s` has the shape of a rendezvous id: 64 lowercase hex digits.
pub fn is_rendezvous_id(s: &str) -> bool {
    is_lower_hex(s, 64)
}

/// Whether `s` has the shape of a stream id: 32 lowercase hex digits.
pub fn is_stream_id(s: &str) -> bool {
    is_lower_hex(s, 32)
}

fn is_lower_hex(s: &str, len: usize) -> bool {
    s.len() == len && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// The first frame on every connection to the Relay.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "role", rename_all = "kebab-case")]
pub enum RelayHello {
    /// A daemon registering its Workstation. The connection stays open
    /// and carries only `RelayReply::Incoming` announcements; no traffic
    /// is ever copied over it.
    Workstation { v: u32, token: String, rendezvous: String },
    /// A Device asking to be carried to the Workstation at `rendezvous`.
    Device { v: u32, token: String, rendezvous: String, purpose: String },
    /// A daemon picking up the stream an `Incoming` announced. A second
    /// connection rather than traffic multiplexed over the first, so the
    /// Relay's whole job stays "copy one socket to another".
    Stream { v: u32, token: String, rendezvous: String, stream: String },
    /// A role a newer peer sent. Deserialize-only, and a value rather
    /// than a parse error so the Relay can refuse it by name.
    #[serde(other)]
    Unknown,
}

impl RelayHello {
    pub fn workstation(token: &str, rendezvous: &str) -> Self {
        Self::Workstation {
            v: RELAY_WIRE_VERSION,
            token: token.to_string(),
            rendezvous: rendezvous.to_string(),
        }
    }

    pub fn device(token: &str, rendezvous: &str, purpose: &str) -> Self {
        Self::Device {
            v: RELAY_WIRE_VERSION,
            token: token.to_string(),
            rendezvous: rendezvous.to_string(),
            purpose: purpose.to_string(),
        }
    }

    pub fn stream(token: &str, rendezvous: &str, stream: &str) -> Self {
        Self::Stream {
            v: RELAY_WIRE_VERSION,
            token: token.to_string(),
            rendezvous: rendezvous.to_string(),
            stream: stream.to_string(),
        }
    }

    /// The version, token and rendezvous id every known role carries, or
    /// `None` for a role this build has never heard of.
    pub fn admission(&self) -> Option<(u32, &str, &str)> {
        match self {
            Self::Workstation { v, token, rendezvous }
            | Self::Device { v, token, rendezvous, .. }
            | Self::Stream { v, token, rendezvous, .. } => Some((*v, token, rendezvous)),
            Self::Unknown => None,
        }
    }

    /// The exact text of the frame.
    pub fn to_frame(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }

    pub fn from_frame(text: &str) -> anyhow::Result<Self> {
        Ok(serde_json::from_str(text)?)
    }
}

/// What the Relay says back, in TEXT frames.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum RelayReply {
    /// To a Workstation: registered. To a Device or a stream: the other
    /// end is there, and every frame from here on is BINARY and copied.
    Ready,
    /// To a Workstation: a Device is waiting on `stream`.
    Incoming { stream: String, purpose: String },
    /// The connection is about to be closed, and why.
    Refused { reason: RefusalReason },
    /// A reply a newer Relay sent.
    #[serde(other)]
    Unknown,
}

impl RelayReply {
    pub fn to_frame(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }

    pub fn from_frame(text: &str) -> anyhow::Result<Self> {
        Ok(serde_json::from_str(text)?)
    }
}

/// Why the Relay refused a connection.
///
/// Said to the peer rather than kept to the Relay's log, because each one
/// is a different thing for the Companion to tell the human: a wrong
/// token is a Relay they must be admitted to, and `Offline` is a
/// Workstation that is asleep or has remote access turned off.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RefusalReason {
    /// No admission token, or one the Relay does not hold.
    Admission,
    /// No Workstation is registered under that rendezvous id.
    Offline,
    /// A Workstation is registered and none picked the stream up in time.
    Unclaimed,
    /// No such stream: it was picked up already, or it lapsed.
    Gone,
    /// The Relay is holding as much as it will for this rendezvous id.
    Busy,
    /// The first frame was not a hello.
    Malformed,
    /// The hello named a version or a role this Relay does not speak.
    Version,
    /// A reason a newer Relay sent.
    #[serde(other)]
    Unknown,
}

impl std::fmt::Display for RefusalReason {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            RefusalReason::Admission => "the Relay did not accept the admission token",
            RefusalReason::Offline => "no Workstation is connected to the Relay under that key",
            RefusalReason::Unclaimed => "the Workstation did not pick the connection up",
            RefusalReason::Gone => "the Relay no longer holds that connection",
            RefusalReason::Busy => "the Relay is holding too many connections for this Workstation",
            RefusalReason::Malformed => "the Relay could not read the first frame",
            RefusalReason::Version => "the Relay does not speak this version",
            RefusalReason::Unknown => "the Relay refused the connection",
        })
    }
}

/// A Relay URL, read far enough to decide whether it may be dialled.
///
/// The URL itself stays opaque -- it is dialled as typed -- and this type
/// holds the three facts a dial needs out of it: whether the leg is TLS,
/// which host to verify the certificate against, and whether that host is
/// on this machine or this network.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelayUrl {
    /// The URL as typed, trimmed.
    pub url: String,
    /// `wss://`.
    pub secure: bool,
    /// The host, without the brackets an IPv6 literal is written in.
    pub host: String,
    pub port: u16,
    /// Loopback, a private or link-local address, or a `.local` name.
    /// Decided from the text alone: nothing is resolved.
    pub local: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RelayUrlError {
    /// No `scheme://` at all.
    NoScheme,
    /// A scheme that is not `ws` or `wss`.
    Scheme(String),
    NoHost,
    /// A host that is not a host name, an IPv4 address or a bracketed
    /// IPv6 address -- or that a webview's URL parser would read as a
    /// different one.
    Host,
    Port,
    /// `user:password@host`. The admission token has its own field.
    Credentials,
    /// `ws://` to a host that is not on this machine or this network.
    PlainToPublicHost,
}

impl std::fmt::Display for RelayUrlError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RelayUrlError::NoScheme => {
                write!(f, "a Relay URL starts with wss:// (or ws:// for a Relay on this network)")
            }
            RelayUrlError::Scheme(s) => {
                write!(f, "a Relay URL starts with wss:// or ws://, not {s}://")
            }
            RelayUrlError::NoHost => write!(f, "the Relay URL names no host"),
            RelayUrlError::Host => write!(
                f,
                "the Relay URL's host is not a host name or an address — letters, digits, dots and hyphens, or an address written plainly"
            ),
            RelayUrlError::Port => write!(f, "the Relay URL's port is not a number from 1 to 65535"),
            RelayUrlError::Credentials => write!(
                f,
                "the Relay URL must not carry a user or password — the admission token has its own field"
            ),
            RelayUrlError::PlainToPublicHost => write!(
                f,
                "ws:// would send the admission token unencrypted — use wss:// for a Relay that is not on this machine or this network"
            ),
        }
    }
}

impl std::error::Error for RelayUrlError {}

impl RelayUrl {
    /// Reads `url` and decides whether it may be dialled.
    ///
    /// `wss://` is accepted for any host. `ws://` is accepted only for a
    /// host on this machine or this network, which is what a Relay in a
    /// local development stack is: the traffic inside is end-to-end
    /// encrypted either way, but the admission token and the rendezvous
    /// id travel in the first frame, and over a plain leg anyone on the
    /// path reads both.
    pub fn parse(url: &str) -> Result<Self, RelayUrlError> {
        let url = url.trim();
        let (scheme, rest) = url.split_once("://").ok_or(RelayUrlError::NoScheme)?;
        let secure = match scheme.to_ascii_lowercase().as_str() {
            "wss" => true,
            "ws" => false,
            other => return Err(RelayUrlError::Scheme(other.to_string())),
        };
        let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
        if authority.contains('@') {
            return Err(RelayUrlError::Credentials);
        }
        let (host, port, address) = if let Some(bracketed) = authority.strip_prefix('[') {
            let (host, after) = bracketed.split_once(']').ok_or(RelayUrlError::NoHost)?;
            if host.is_empty() {
                return Err(RelayUrlError::NoHost);
            }
            let address: std::net::Ipv6Addr = host.parse().map_err(|_| RelayUrlError::Host)?;
            let port = match after {
                "" => None,
                p => Some(p.strip_prefix(':').ok_or(RelayUrlError::Port)?),
            };
            (host, port, Some(std::net::IpAddr::V6(address)))
        } else {
            let (host, port) = match authority.rsplit_once(':') {
                Some((host, port)) => (host, Some(port)),
                None => (authority, None),
            };
            if host.is_empty() {
                return Err(RelayUrlError::NoHost);
            }
            (host, port, name_or_ipv4(host)?.map(std::net::IpAddr::V4))
        };
        let port = match port {
            None => {
                if secure {
                    443
                } else {
                    80
                }
            }
            Some(p) => port_number(p).ok_or(RelayUrlError::Port)?,
        };
        let local = match address {
            Some(address) => address_is_local(address),
            None => name_is_local(host),
        };
        if !secure && !local {
            return Err(RelayUrlError::PlainToPublicHost);
        }
        Ok(Self { url: url.to_string(), secure, host: host.to_string(), port, local })
    }
}

/// A port as it is written: decimal digits and nothing else, from 1 to
/// 65535. `str::parse` would take a leading `+`, which no URL parser
/// does.
fn port_number(text: &str) -> Option<u16> {
    if text.is_empty() || !text.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    text.parse::<u16>().ok().filter(|n| *n != 0)
}

/// An unbracketed host: the IPv4 address it is, `None` for a name, or
/// the refusal for something that is neither.
///
/// A name is letters, digits, dots and hyphens, in labels none of which
/// is empty; one trailing dot is allowed. Anything else -- an
/// underscore, a percent sign, a backslash, a character outside ASCII,
/// an unbracketed IPv6 address -- is refused rather than passed on,
/// because what it would be passed on to is a second URL parser with
/// its own opinion of where the host ends.
///
/// A host that ENDS in a number is an IPv4 address to a webview's
/// parser, which reads `010.0.0.1` as octal, `0x7f.0.0.1` as hex and
/// `2130706433` as one 32-bit number. So it has to be an address written
/// plainly -- four decimal parts, no leading zero -- or it is refused:
/// two parsers must not be able to read one host as two.
fn name_or_ipv4(host: &str) -> Result<Option<std::net::Ipv4Addr>, RelayUrlError> {
    if !host.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-') {
        return Err(RelayUrlError::Host);
    }
    let name = host.strip_suffix('.').unwrap_or(host);
    if name.split('.').any(str::is_empty) {
        return Err(RelayUrlError::Host);
    }
    let last = name.rsplit('.').next().unwrap_or(name);
    let numeric = last.bytes().all(|b| b.is_ascii_digit())
        || last.len() >= 2 && last[..2].eq_ignore_ascii_case("0x");
    if numeric {
        return host.parse().map(Some).map_err(|_| RelayUrlError::Host);
    }
    Ok(None)
}

fn address_is_local(address: std::net::IpAddr) -> bool {
    match address {
        std::net::IpAddr::V4(v4) => {
            let [a, b, ..] = v4.octets();
            v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                // Tailscale hands these out, and encrypts what travels
                // to them.
                || (a == 100 && (64..128).contains(&b))
        }
        std::net::IpAddr::V6(v6) => {
            let first = v6.segments()[0];
            v6.is_loopback() || (first & 0xffc0) == 0xfe80 || (first & 0xfe00) == 0xfc00
        }
    }
}

/// A name is local only when it says so itself (`localhost`, `.local`);
/// any other name is public, because resolving it would make the answer
/// depend on whoever answers DNS.
fn name_is_local(name: &str) -> bool {
    let name = name.strip_suffix('.').unwrap_or(name).to_ascii_lowercase();
    name == "localhost" || name.ends_with(".localhost") || name.ends_with(".local")
}

/// Whether `host` is this machine or this network, judged from its text:
/// nothing is resolved. `host` is as `RelayUrl::host` holds it, an IPv6
/// address without its brackets.
pub fn host_is_local(host: &str) -> bool {
    if let Ok(address) = host.parse::<std::net::IpAddr>() {
        return address_is_local(address);
    }
    matches!(name_or_ipv4(host), Ok(None)) && name_is_local(host)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Pinned, so the Companion's implementer has a vector to check
    /// theirs against and a change to the derivation fails here rather
    /// than stranding every paired Device.
    #[test]
    fn the_rendezvous_id_is_pinned() {
        let id = rendezvous_id(&[1u8; 32]);
        assert_eq!(id, "d62ba7f7ac687465375ba5d00082d915d580d9c50a45ae444312d8b5bfecc37b");
        assert!(is_rendezvous_id(&id));
        assert_ne!(id, rendezvous_id(&[2u8; 32]), "the id must depend on the key");
        assert_ne!(
            id,
            crate::hex_encode(&Sha256::digest([1u8; 32])),
            "the context string must be part of the digest"
        );
    }

    #[test]
    fn an_id_is_judged_by_its_shape() {
        assert!(is_rendezvous_id(&"a0".repeat(32)));
        assert!(!is_rendezvous_id(&"A0".repeat(32)), "uppercase is a different string");
        assert!(!is_rendezvous_id(&"a0".repeat(31)));
        assert!(!is_rendezvous_id(&"g0".repeat(32)));
        assert!(is_stream_id(&"0f".repeat(16)));
        assert!(!is_stream_id(&"0f".repeat(32)));
    }

    #[test]
    fn a_hello_round_trips_in_kebab_case() {
        let r = "ab".repeat(32);
        let s = "cd".repeat(16);
        for (hello, role) in [
            (RelayHello::workstation("t", &r), "workstation"),
            (RelayHello::device("t", &r, PURPOSE_PAIR), "device"),
            (RelayHello::stream("t", &r, &s), "stream"),
        ] {
            let v: serde_json::Value = serde_json::from_str(&hello.to_frame()).unwrap();
            assert_eq!(v["role"], role);
            assert_eq!(v["v"], RELAY_WIRE_VERSION);
            assert_eq!(v["token"], "t");
            assert_eq!(v["rendezvous"], r.as_str());
            assert_eq!(serde_json::from_value::<RelayHello>(v).unwrap(), hello);
            assert_eq!(hello.admission(), Some((RELAY_WIRE_VERSION, "t", r.as_str())));
        }
        let device: serde_json::Value =
            serde_json::from_str(&RelayHello::device("t", &r, PURPOSE_PAIR).to_frame()).unwrap();
        assert_eq!(device["purpose"], "pair");
    }

    #[test]
    fn a_role_this_build_has_never_heard_of_is_a_value() {
        let hello: RelayHello =
            serde_json::from_str(r#"{"role":"observer","v":2,"token":"t"}"#).unwrap();
        assert_eq!(hello, RelayHello::Unknown);
        assert_eq!(hello.admission(), None);
    }

    #[test]
    fn a_reply_round_trips_in_kebab_case() {
        assert_eq!(RelayReply::Ready.to_frame(), r#"{"type":"ready"}"#);
        let incoming =
            RelayReply::Incoming { stream: "cd".repeat(16), purpose: PURPOSE_PAIR.into() };
        assert_eq!(serde_json::from_str::<RelayReply>(&incoming.to_frame()).unwrap(), incoming);
        assert_eq!(
            RelayReply::Refused { reason: RefusalReason::Admission }.to_frame(),
            r#"{"type":"refused","reason":"admission"}"#
        );
    }

    #[test]
    fn a_reply_this_build_has_never_heard_of_is_a_value() {
        assert_eq!(
            serde_json::from_str::<RelayReply>(r#"{"type":"throttled","for":30}"#).unwrap(),
            RelayReply::Unknown
        );
        assert_eq!(
            serde_json::from_str::<RelayReply>(r#"{"type":"refused","reason":"quota"}"#).unwrap(),
            RelayReply::Refused { reason: RefusalReason::Unknown }
        );
    }

    #[test]
    fn a_secure_url_is_accepted_for_any_host() {
        let url = RelayUrl::parse("  wss://relay.example/gavin  ").unwrap();
        assert_eq!(url.url, "wss://relay.example/gavin");
        assert!(url.secure);
        assert_eq!(url.host, "relay.example");
        assert_eq!(url.port, 443);
        assert!(!url.local);

        let url = RelayUrl::parse("WSS://relay.example:8443").unwrap();
        assert_eq!((url.host.as_str(), url.port), ("relay.example", 8443));
    }

    #[test]
    fn a_plain_url_to_a_public_host_is_refused() {
        for url in ["ws://relay.example/gavin", "ws://8.8.8.8:9000", "ws://[2001:db8::1]:9000"] {
            assert_eq!(RelayUrl::parse(url), Err(RelayUrlError::PlainToPublicHost), "{url}");
        }
        assert!(
            RelayUrlError::PlainToPublicHost.to_string().contains("wss://"),
            "the refusal has to say what to type instead"
        );
    }

    #[test]
    fn a_plain_url_to_loopback_or_a_private_address_is_accepted() {
        for (url, host, port) in [
            ("ws://127.0.0.1:9000", "127.0.0.1", 9000),
            ("ws://localhost:9000/relay", "localhost", 9000),
            ("ws://192.168.1.20:9000", "192.168.1.20", 9000),
            ("ws://10.0.0.4", "10.0.0.4", 80),
            ("ws://172.20.1.1:1", "172.20.1.1", 1),
            ("ws://100.100.4.2:9000", "100.100.4.2", 9000),
            ("ws://[::1]:9000", "::1", 9000),
            ("ws://[fe80::1]", "fe80::1", 80),
            ("ws://[fd12:3456::1]:9000", "fd12:3456::1", 9000),
            ("ws://studio.local:9000", "studio.local", 9000),
        ] {
            let parsed = RelayUrl::parse(url).unwrap_or_else(|e| panic!("{url}: {e}"));
            assert!(!parsed.secure, "{url}");
            assert!(parsed.local, "{url}");
            assert_eq!((parsed.host.as_str(), parsed.port), (host, port), "{url}");
        }
        // The edges of the ranges, which is where a mask goes wrong.
        assert!(!host_is_local("172.32.0.1"));
        assert!(!host_is_local("100.128.0.1"));
        assert!(!host_is_local("100.63.255.255"));
        assert!(!host_is_local("localhost.example.com"));
        assert!(!host_is_local("notlocal"));
    }

    #[test]
    fn a_url_with_no_scheme_or_another_scheme_is_refused() {
        assert_eq!(RelayUrl::parse("relay.example"), Err(RelayUrlError::NoScheme));
        assert_eq!(RelayUrl::parse(""), Err(RelayUrlError::NoScheme));
        assert_eq!(
            RelayUrl::parse("https://relay.example"),
            Err(RelayUrlError::Scheme("https".into()))
        );
        assert_eq!(RelayUrl::parse("wss://"), Err(RelayUrlError::NoHost));
        assert_eq!(RelayUrl::parse("wss:///path"), Err(RelayUrlError::NoHost));
        assert_eq!(RelayUrl::parse("wss://relay.example:0"), Err(RelayUrlError::Port));
        assert_eq!(RelayUrl::parse("wss://relay.example:99999"), Err(RelayUrlError::Port));
        assert_eq!(RelayUrl::parse("wss://relay.example:abc"), Err(RelayUrlError::Port));
        assert_eq!(RelayUrl::parse("wss://[::1"), Err(RelayUrlError::NoHost));
        assert_eq!(RelayUrl::parse("wss://[::1]9000"), Err(RelayUrlError::Port));
        // `str::parse` takes a sign; a URL does not.
        assert_eq!(RelayUrl::parse("wss://relay.example:+443"), Err(RelayUrlError::Port));
    }

    /// The name `cases.json` gives each refusal.
    fn name_of(e: &RelayUrlError) -> &'static str {
        match e {
            RelayUrlError::NoScheme => "no-scheme",
            RelayUrlError::Scheme(_) => "scheme",
            RelayUrlError::NoHost => "no-host",
            RelayUrlError::Host => "host",
            RelayUrlError::Port => "port",
            RelayUrlError::Credentials => "credentials",
            RelayUrlError::PlainToPublicHost => "plain-to-public-host",
        }
    }

    /// The table this rule shares with its mirror in the app
    /// (`test-fixtures/relay-urls/README.md`). The Settings field's hint
    /// is written from a second implementation, in another language, and
    /// what keeps the two saying the same thing about every URL is that
    /// both are held to this one file.
    #[test]
    fn every_case_in_the_shared_table_is_judged_as_the_table_says() {
        let cases: Vec<serde_json::Value> =
            serde_json::from_str(include_str!("../../../test-fixtures/relay-urls/cases.json"))
                .unwrap();
        assert!(cases.len() > 90, "the table has shrunk to {} cases", cases.len());

        let mut refusals = std::collections::BTreeSet::new();
        for case in &cases {
            let url = case["url"].as_str().unwrap();
            let judged = RelayUrl::parse(url);
            match (case.get("dial"), case.get("refuse")) {
                (Some(dial), None) => {
                    let parsed = judged.unwrap_or_else(|e| panic!("{url:?} was refused: {e}"));
                    assert_eq!(parsed.url, url.trim(), "{url:?}");
                    assert_eq!(parsed.secure, dial["secure"].as_bool().unwrap(), "{url:?}");
                    assert_eq!(parsed.host, dial["host"].as_str().unwrap(), "{url:?}");
                    assert_eq!(u64::from(parsed.port), dial["port"].as_u64().unwrap(), "{url:?}");
                    assert_eq!(parsed.local, dial["local"].as_bool().unwrap(), "{url:?}");
                }
                (None, Some(why)) => {
                    let why = why.as_str().unwrap();
                    refusals.insert(why.to_string());
                    match judged {
                        Err(e) => assert_eq!(name_of(&e), why, "{url:?}: {e}"),
                        Ok(parsed) => panic!("{url:?} would be dialled ({parsed:?}), not {why}"),
                    }
                }
                _ => panic!("{url:?} must say exactly one of dial and refuse"),
            }
        }
        // Every refusal there is has a case, so one that was added
        // without being put in the table fails here.
        let every: Vec<&str> = vec![
            "credentials", "host", "no-host", "no-scheme", "plain-to-public-host", "port", "scheme",
        ];
        assert_eq!(refusals.iter().map(String::as_str).collect::<Vec<_>>(), every);
    }

    /// A webview's URL parser is not this one. It reads `010.0.0.1` as
    /// octal and dials 8.0.0.1, reads `2130706433` as 127.0.0.1, and reads
    /// a backslash as a slash -- so a host this rule called local, or a
    /// name, could be dialled as something else by the Companion. A host
    /// two parsers could read two ways is refused rather than judged.
    #[test]
    fn a_host_two_parsers_could_read_two_ways_is_refused() {
        for url in [
            "ws://010.0.0.1:9000",
            "wss://2130706433",
            "wss://0x7f.0.0.1",
            "ws://evil.example\\x.local",
            "ws://[fe80::1%en0]",
        ] {
            assert_eq!(RelayUrl::parse(url), Err(RelayUrlError::Host), "{url}");
        }
    }

    /// The admission token has a field of its own; a URL that carries a
    /// credential is one that ends up in a log with it.
    #[test]
    fn a_url_carrying_credentials_is_refused() {
        assert_eq!(
            RelayUrl::parse("wss://token@relay.example"),
            Err(RelayUrlError::Credentials)
        );
        // An `@` in the PATH is not a credential.
        assert!(RelayUrl::parse("wss://relay.example/@gavin").is_ok());
    }
}
