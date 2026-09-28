//! The Push gateway: the publisher's service that delivers the
//! Companion's end-to-end encrypted notifications through Apple and
//! Google, and the only holder of the publisher's push credentials.
//!
//! A Device registers its push token and mints one signed send permission
//! per Workstation. A Workstation's daemon posts ciphertext with that
//! permission; the gateway checks it, rate-limits the Device, and hands
//! the bytes to APNs or FCM untouched. It never sees plaintext and never
//! logs a payload. `docs/push-gateway.md` documents the API and the
//! configuration.

pub mod apns;
pub mod clock;
pub mod config;
pub mod fcm;
pub mod gateway;
pub mod http;
pub mod id;
pub mod jwt;
pub mod log;
pub mod permission;
pub mod rate;
pub mod sender;
pub mod store;

pub use gateway::{Gateway, Settings};

use std::future::Future;
use std::sync::Arc;

/// Serves the API on `listener` until `shutdown` resolves, then finishes
/// the requests in flight.
pub async fn serve(
    listener: tokio::net::TcpListener,
    gateway: Arc<Gateway>,
    shutdown: impl Future<Output = ()> + Send + 'static,
) -> std::io::Result<()> {
    axum::serve(listener, http::router(gateway)).with_graceful_shutdown(shutdown).await
}
