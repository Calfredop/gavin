//! The Companion core: the Device's half of the wire, as logic.
//!
//! Everything here that must match the daemon byte for byte -- the Noise
//! handshake, the framing, the padding, the six-digit code -- has one
//! implementation, and this crate is it
//! (`docs/superpowers/specs/2026-09-27-companion-design.md`, "The
//! Companion core"). It is built two ways: to `wasm32-unknown-unknown` for
//! the Companion shell, and natively, with the `test-device` feature, as
//! the test Device that drives a real daemon through a real Relay.
//!
//! **It does no I/O.** A `PairingClient` is handed the bytes that arrived
//! and hands back the bytes to send, so the transport is its caller's: a
//! webview's `WebSocket` in the shell, a blocking socket in the test
//! Device. That is what lets one implementation run in both.
//!
//! **It draws no randomness of its own.** A build for
//! `wasm32-unknown-unknown` has no OS random source, and a fallback that
//! made one up would be a weak key nobody chose. The caller supplies
//! `Entropy`; when it runs out, that is an error.

mod entropy;
mod error;
mod keys;
mod noise;
pub mod pairing;
#[cfg(feature = "test-device")]
pub mod test_device;

pub use entropy::{Entropy, KEY_ENTROPY, PAIRING_ENTROPY};
pub use error::CoreError;
pub use keys::DeviceKeys;
