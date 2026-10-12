//! The Relay, and what dials it.
//!
//! The Relay is the server that carries encrypted traffic between a
//! Workstation and its Devices without being able to read it
//! (`CONTEXT.md`). Both ends dial out to it, so nothing is
//! port-forwarded; it admits the ones that hold its admission token,
//! matches a Device to its Workstation by rendezvous id, and from then on
//! copies bytes (`docs/security/05-remote-access.md` §5).
//!
//! It is trusted for nothing. What travels through it is a Noise channel
//! whose keys it never held, so a Relay that drops, replays or alters
//! traffic causes a failed connection and never a wrong answer.
//!
//! What it says to its peers before the copy starts is
//! `protocol::relay`, which is the contract three programs are written
//! against. This crate is two of them: `server` is the Relay, and
//! `client` is the blocking dial the daemon and the test Device share.
//! `direct` is the Relay deleted (ADR 0009): a daemon answering a Device
//! itself, and the pinned dial the test Device makes to it.

#[cfg(feature = "client")]
pub mod client;
#[cfg(feature = "client")]
pub mod direct;
#[cfg(feature = "server")]
pub mod server;

/// The rustls provider every TLS configuration in this crate is built
/// from, named rather than left to the process default: with two
/// providers compiled in -- which a sibling crate's features can bring
/// about -- rustls has no default to pick and panics instead.
#[cfg(any(feature = "client", feature = "server"))]
pub(crate) fn tls_provider() -> std::sync::Arc<rustls::crypto::CryptoProvider> {
    std::sync::Arc::new(rustls::crypto::ring::default_provider())
}
