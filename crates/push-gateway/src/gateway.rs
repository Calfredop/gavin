//! What the gateway does, free of HTTP: register a Device, mint and cancel
//! its send permissions, and deliver a Workstation's ciphertext.

use crate::clock::Clock;
use crate::id::{new_secret, random_bytes, same_hash, secret_hash, Id};
use crate::log::Log;
use crate::permission::{Claims, PermissionKey};
use crate::rate::{Limiter, RateLimit};
use crate::sender::{ApnsEnvironment, Delivery, PushBody, Sender};
use crate::store::{ConfirmOutcome, DeviceRow, Platform, Registration, Store};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use std::sync::Arc;

/// The most ciphertext one push may carry. APNs and FCM both cap a
/// payload at 4096 bytes; base64 plus the APNs envelope leaves this with
/// room to spare, and it is eight of the Companion's 256-byte padding
/// buckets.
pub const MAX_CIPHERTEXT: usize = 2048;

#[derive(Clone, Copy, Debug)]
pub struct Settings {
    pub permission_ttl_s: u64,
    pub rate: RateLimit,
    /// Live permissions one Device may hold: one per Workstation, with a
    /// wide margin, so a Device cannot grow the database without bound.
    pub max_permissions_per_device: u64,
}

impl Default for Settings {
    fn default() -> Settings {
        Settings {
            // The trust store's unseen-Device expiry: a Device the
            // Workstation stops seeing stops being notified at the same time.
            permission_ttl_s: 90 * 24 * 60 * 60,
            rate: RateLimit::per_hour(30, 240),
            max_permissions_per_device: 64,
        }
    }
}

/// Why a request was refused. `code` is the machine-readable word the
/// HTTP layer answers with; the Device and the daemon branch on it.
#[derive(Debug, PartialEq, Eq)]
pub enum Refusal {
    BadRequest(&'static str),
    DeviceUnauthorized,
    PlatformUnavailable,
    TooManyPermissions,
    /// The Device has not yet echoed the verification nonce for its
    /// pending token, so it may not mint permissions or deliver.
    TokenUnconfirmed,
    PermissionNotFound,
    PermissionInvalid,
    PermissionExpired,
    PermissionCancelled,
    PayloadTooLarge,
    RateLimited { retry_after_s: u64 },
    DeviceUnreachable,
    UpstreamRejected,
    UpstreamUnavailable,
    Internal,
}

impl Refusal {
    pub fn code(&self) -> &'static str {
        match self {
            Refusal::BadRequest(code) => code,
            Refusal::DeviceUnauthorized => "device_unauthorized",
            Refusal::PlatformUnavailable => "platform_unavailable",
            Refusal::TooManyPermissions => "too_many_permissions",
            Refusal::TokenUnconfirmed => "token_unconfirmed",
            Refusal::PermissionNotFound => "permission_not_found",
            Refusal::PermissionInvalid => "permission_invalid",
            Refusal::PermissionExpired => "permission_expired",
            Refusal::PermissionCancelled => "permission_cancelled",
            Refusal::PayloadTooLarge => "payload_too_large",
            Refusal::RateLimited { .. } => "rate_limited",
            Refusal::DeviceUnreachable => "device_unreachable",
            Refusal::UpstreamRejected => "upstream_rejected",
            Refusal::UpstreamUnavailable => "upstream_unavailable",
            Refusal::Internal => "internal",
        }
    }
}

pub struct Registered {
    pub device_id: Id,
    pub device_secret: String,
    /// Present only when the sender cannot deliver a real verification
    /// push (dry-run): the Device confirms with this nonce over HTTP.
    pub verification_nonce: Option<String>,
}

pub struct TokenReplaced {
    pub verification_nonce: Option<String>,
}

pub struct Granted {
    pub permission_id: Id,
    pub permission: String,
    pub expires_at: u64,
}

pub struct Gateway {
    store: Store,
    key: PermissionKey,
    limiter: Limiter,
    sender: Box<dyn Sender>,
    clock: Arc<dyn Clock>,
    log: Log,
    settings: Settings,
}

impl Gateway {
    pub fn new(
        store: Store,
        key: PermissionKey,
        sender: Box<dyn Sender>,
        clock: Arc<dyn Clock>,
        log: Log,
        settings: Settings,
    ) -> Gateway {
        Gateway { store, key, limiter: Limiter::new(settings.rate), sender, clock, log, settings }
    }

    pub fn log(&self) -> &Log {
        &self.log
    }

    pub async fn register(
        &self,
        platform: &str,
        token: &str,
        environment: Option<&str>,
    ) -> Result<Registered, Refusal> {
        let platform = Platform::parse(platform).ok_or(Refusal::BadRequest("unknown_platform"))?;
        let registration = self.registration(platform, token, environment)?;
        let (device_id, device_secret) = (Id::random(), new_secret());
        let (nonce, nonce_hash) = verification_nonce();
        self.store
            .insert_device(device_id, &secret_hash(&device_secret), &registration, &nonce_hash, self.clock.now_s())
            .map_err(|e| self.internal("register", e))?;
        if let Err(refused) = self.send_verification(&registration, &nonce).await {
            let _ = self.store.delete_device(device_id);
            return Err(refused);
        }
        self.log.info(format!("device {device_id} registered ({}); token pending confirmation", platform.as_str()));
        Ok(Registered {
            device_id,
            device_secret,
            verification_nonce: self.sender.reveals_verification_nonce().then_some(nonce),
        })
    }

    /// A newer token for the same Device. The live token keeps delivering
    /// until the Device confirms the pending claim; permissions are
    /// untouched either way.
    pub async fn replace_token(
        &self,
        device: &str,
        secret: Option<&str>,
        token: &str,
        environment: Option<&str>,
    ) -> Result<TokenReplaced, Refusal> {
        let (id, row) = self.authenticate(device, secret)?;
        let registration = self.registration(row.platform, token, environment)?;
        let (nonce, nonce_hash) = verification_nonce();
        self.store
            .replace_token(id, &registration, &nonce_hash, self.clock.now_s())
            .map_err(|e| self.internal("replace token", e))?;
        self.send_verification(&registration, &nonce).await?;
        self.log.info(format!("device {id} claimed a new token; pending confirmation"));
        Ok(TokenReplaced { verification_nonce: self.sender.reveals_verification_nonce().then_some(nonce) })
    }

    /// Whether this Device still has a pending token claim.
    pub fn token_pending(&self, device: &str, secret: Option<&str>) -> Result<bool, Refusal> {
        let (_, row) = self.authenticate(device, secret)?;
        Ok(row.pending.is_some())
    }

    /// Echoes the nonce from the verification push. Only then does the
    /// pending claim become the live token, and only then do other
    /// holders of that token lose theirs.
    pub fn confirm_token(&self, device: &str, secret: Option<&str>, nonce: &str) -> Result<(), Refusal> {
        let (id, _) = self.authenticate(device, secret)?;
        if nonce.is_empty() || nonce.len() > 128 {
            return Err(Refusal::BadRequest("bad_nonce"));
        }
        let hash = secret_hash(nonce);
        match self.store.confirm_token(id, &hash, self.clock.now_s()).map_err(|e| self.internal("confirm token", e))? {
            ConfirmOutcome::Confirmed => {
                self.log.info(format!("device {id} confirmed its token"));
                Ok(())
            }
            ConfirmOutcome::UnknownDevice => Err(Refusal::DeviceUnauthorized),
            ConfirmOutcome::NothingPending => Err(Refusal::BadRequest("nothing_pending")),
            // Same shape as a wrong secret: guessing nonces should not
            // tell the caller whether a claim is waiting.
            ConfirmOutcome::BadNonce => Err(Refusal::DeviceUnauthorized),
        }
    }

    pub fn unregister(&self, device: &str, secret: Option<&str>) -> Result<(), Refusal> {
        let (id, _) = self.authenticate(device, secret)?;
        self.store.delete_device(id).map_err(|e| self.internal("unregister", e))?;
        self.log.info(format!("device {id} unregistered"));
        Ok(())
    }

    /// Mints a send permission for the Device to hand one Workstation.
    /// Refused until the Device has confirmed a deliverable token, so a
    /// free registration of a random token never earns an allowance.
    pub fn grant(&self, device: &str, secret: Option<&str>) -> Result<Granted, Refusal> {
        let (id, row) = self.authenticate(device, secret)?;
        if row.token.is_none() {
            return Err(Refusal::TokenUnconfirmed);
        }
        let now = self.clock.now_s();
        let live = self.store.permission_count(id, now).map_err(|e| self.internal("grant", e))?;
        if live >= self.settings.max_permissions_per_device {
            return Err(Refusal::TooManyPermissions);
        }
        let claims = Claims { permission: Id::random(), device: id, expires_at: now + self.settings.permission_ttl_s };
        self.store
            .insert_permission(claims.permission, id, now, claims.expires_at)
            .map_err(|e| self.internal("grant", e))?;
        self.log.info(format!("device {id} granted permission {}", claims.permission));
        Ok(Granted { permission_id: claims.permission, permission: self.key.sign(&claims), expires_at: claims.expires_at })
    }

    pub fn cancel(&self, device: &str, secret: Option<&str>, permission: &str) -> Result<(), Refusal> {
        let (id, _) = self.authenticate(device, secret)?;
        let permission = Id::parse(permission).ok_or(Refusal::PermissionNotFound)?;
        if !self.store.delete_permission(id, permission).map_err(|e| self.internal("cancel", e))? {
            return Err(Refusal::PermissionNotFound);
        }
        self.log.info(format!("device {id} cancelled permission {permission}"));
        Ok(())
    }

    /// Delivers a Workstation's ciphertext to the Device its permission
    /// names. The bytes are handed to the sender exactly as they arrived;
    /// nothing here reads, logs or keeps them.
    pub async fn push(&self, permission: Option<&str>, ciphertext: &[u8]) -> Result<(), Refusal> {
        // The signature first: a guessed or edited permission costs no
        // database read and no rate-limit entry.
        let claims = permission.and_then(|p| self.key.verify(p)).ok_or(Refusal::PermissionInvalid)?;
        let now_ms = self.clock.now_ms();
        if claims.expires_at <= now_ms / 1000 {
            return Err(Refusal::PermissionExpired);
        }
        match self.store.permission_device(claims.permission).map_err(|e| self.internal("push", e))? {
            None => return Err(Refusal::PermissionCancelled),
            Some(device) if device != claims.device => return Err(Refusal::PermissionInvalid),
            Some(_) => {}
        }
        if ciphertext.is_empty() {
            return Err(Refusal::BadRequest("empty_payload"));
        }
        if ciphertext.len() > MAX_CIPHERTEXT {
            return Err(Refusal::PayloadTooLarge);
        }
        let device = claims.device;
        if let Err(wait_ms) = self.limiter.take(device, now_ms) {
            self.log.info(format!("push on permission {} to device {device}: rate limited", claims.permission));
            return Err(Refusal::RateLimited { retry_after_s: wait_ms.div_ceil(1000).max(1) });
        }
        let row = self
            .store
            .device(device)
            .map_err(|e| self.internal("push", e))?
            // Unregistered between the two reads: its permissions went with it.
            .ok_or(Refusal::PermissionCancelled)?;
        let Some(target) = row.target() else {
            return Err(Refusal::DeviceUnreachable);
        };
        let platform = target.platform().as_str();
        let what = format!("push on permission {} to {platform} device {device}", claims.permission);
        match self.sender.send(target, PushBody::Ciphertext(ciphertext)).await {
            Delivery::Delivered => {
                self.log.info(format!("{what}: delivered, {} bytes", ciphertext.len()));
                Ok(())
            }
            Delivery::TokenGone(reason) => {
                if let Some(token) = &row.token {
                    self.store.clear_token(device, token).map_err(|e| self.internal("push", e))?;
                }
                self.log.info(format!("{what}: token gone ({reason}); waiting for the device to register a new one"));
                Err(Refusal::DeviceUnreachable)
            }
            Delivery::Rejected(reason) => {
                self.log.info(format!("{what}: rejected ({reason})"));
                Err(Refusal::UpstreamRejected)
            }
            Delivery::Unavailable(reason) => {
                self.log.info(format!("{what}: unavailable ({reason})"));
                Err(Refusal::UpstreamUnavailable)
            }
        }
    }

    /// Hourly housekeeping: expired permissions, long-idle Devices with
    /// none left, and rate-limit entries that have refilled.
    pub fn prune(&self) {
        let now_ms = self.clock.now_ms();
        self.limiter.prune(now_ms);
        match self.store.prune(now_ms / 1000, self.settings.permission_ttl_s) {
            Ok((0, 0)) => {}
            Ok((permissions, devices)) => {
                self.log.info(format!("pruned {permissions} expired permissions and {devices} idle devices"))
            }
            Err(e) => self.log.info(format!("pruning failed: {e:#}")),
        }
    }

    async fn send_verification(&self, reg: &Registration, nonce: &str) -> Result<(), Refusal> {
        let target = match reg.platform {
            Platform::Ios => crate::sender::Target::Apns { token: &reg.token, environment: reg.environment },
            Platform::Android => crate::sender::Target::Fcm { token: &reg.token },
        };
        match self.sender.send(target, PushBody::Verification(nonce)).await {
            Delivery::Delivered => Ok(()),
            Delivery::TokenGone(reason) => {
                self.log.info(format!("verification push: token gone ({reason})"));
                Err(Refusal::DeviceUnreachable)
            }
            Delivery::Rejected(reason) => {
                self.log.info(format!("verification push: rejected ({reason})"));
                Err(Refusal::UpstreamRejected)
            }
            Delivery::Unavailable(reason) => {
                self.log.info(format!("verification push: unavailable ({reason})"));
                Err(Refusal::UpstreamUnavailable)
            }
        }
    }

    fn registration(&self, platform: Platform, token: &str, environment: Option<&str>) -> Result<Registration, Refusal> {
        if !self.sender.supports(platform) {
            return Err(Refusal::PlatformUnavailable);
        }
        let (token, environment) = match platform {
            // Hex, so the token is safe in the APNs URL it becomes part of;
            // lowercased, so one token has one spelling in the unique index.
            Platform::Ios => {
                if !(16..=256).contains(&token.len()) || !token.bytes().all(|b| b.is_ascii_hexdigit()) {
                    return Err(Refusal::BadRequest("bad_token"));
                }
                let environment = match environment {
                    None => ApnsEnvironment::Production,
                    Some(e) => ApnsEnvironment::parse(e).ok_or(Refusal::BadRequest("unknown_environment"))?,
                };
                (token.to_ascii_lowercase(), environment)
            }
            // An APNs environment means nothing to FCM.
            Platform::Android => {
                if !(16..=512).contains(&token.len())
                    || !token.bytes().all(|b| b.is_ascii_alphanumeric() || b"_-:".contains(&b))
                {
                    return Err(Refusal::BadRequest("bad_token"));
                }
                (token.to_string(), ApnsEnvironment::Production)
            }
        };
        Ok(Registration { platform, token, environment })
    }

    /// The Device a request names, if its secret matches. An unknown
    /// Device and a wrong secret are refused alike.
    fn authenticate(&self, device: &str, secret: Option<&str>) -> Result<(Id, DeviceRow), Refusal> {
        let id = Id::parse(device).ok_or(Refusal::DeviceUnauthorized)?;
        let secret = secret.ok_or(Refusal::DeviceUnauthorized)?;
        let row = self
            .store
            .device(id)
            .map_err(|e| self.internal("authenticate", e))?
            .ok_or(Refusal::DeviceUnauthorized)?;
        if !same_hash(&row.secret_hash, &secret_hash(secret)) {
            return Err(Refusal::DeviceUnauthorized);
        }
        Ok((id, row))
    }

    fn internal(&self, what: &str, e: anyhow::Error) -> Refusal {
        self.log.info(format!("{what} failed: {e:#}"));
        Refusal::Internal
    }
}

fn verification_nonce() -> (String, [u8; 32]) {
    let nonce = URL_SAFE_NO_PAD.encode(random_bytes::<32>());
    let hash = secret_hash(&nonce);
    (nonce, hash)
}
