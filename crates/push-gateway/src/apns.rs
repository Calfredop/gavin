//! Apple Push Notification service, token-based.
//!
//! Every push is an alert with `mutable-content`, so iOS wakes the
//! Companion's Notification Service Extension, which decrypts `c` and
//! replaces the placeholder text before anything reaches the screen. The
//! placeholder is what shows if the extension cannot run in time, which
//! is why it says nothing about the Workstation.

use crate::clock::Clock;
use crate::jwt;
use crate::sender::{http_client, reason_code, transport_reason, ApnsEnvironment, Delivery};
use anyhow::{Context, Result};
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use ring::rand::SystemRandom;
use ring::signature::{EcdsaKeyPair, ECDSA_P256_SHA256_FIXED_SIGNING};
use serde_json::json;
use std::sync::{Arc, Mutex};

pub const PRODUCTION_URL: &str = "https://api.push.apple.com";
pub const DEVELOPMENT_URL: &str = "https://api.sandbox.push.apple.com";

pub const PLACEHOLDER_TITLE: &str = "Gavin";
pub const PLACEHOLDER_BODY: &str = "Something on your Workstation changed.";

/// Apple refuses a provider token refreshed more than once in 20 minutes
/// and one older than an hour.
const PROVIDER_TOKEN_REUSE_S: u64 = 40 * 60;
/// How long APNs keeps trying a phone that is offline.
const EXPIRY_S: u64 = 24 * 60 * 60;

pub struct ApnsConfig {
    /// The `.p8` signing key, as PKCS#8 DER.
    pub key_pkcs8: Vec<u8>,
    pub key_id: String,
    pub team_id: String,
    /// The Companion's bundle id.
    pub topic: String,
    pub production_url: String,
    pub development_url: String,
}

pub struct Apns {
    config: ApnsConfig,
    key: EcdsaKeyPair,
    client: reqwest::Client,
    clock: Arc<dyn Clock>,
    provider_token: Mutex<Option<(String, u64)>>,
}

impl Apns {
    pub fn new(config: ApnsConfig, clock: Arc<dyn Clock>) -> Result<Apns> {
        let key = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &config.key_pkcs8, &SystemRandom::new())
            .map_err(|e| anyhow::anyhow!("the APNs key is not a P-256 PKCS#8 key: {e}"))?;
        Ok(Apns { config, key, client: http_client(), clock, provider_token: Mutex::new(None) })
    }

    fn provider_token(&self) -> Result<String> {
        let now = self.clock.now_s();
        let mut cached = self.provider_token.lock().unwrap();
        if let Some((token, minted)) = cached.as_ref() {
            if now < minted + PROVIDER_TOKEN_REUSE_S {
                return Ok(token.clone());
            }
        }
        let token = jwt::es256(
            &self.key,
            &json!({"alg": "ES256", "kid": self.config.key_id}),
            &json!({"iss": self.config.team_id, "iat": now}),
        )
        .context("signing the APNs provider token")?;
        *cached = Some((token.clone(), now));
        Ok(token)
    }

    pub async fn send(&self, token: &str, environment: ApnsEnvironment, ciphertext: &[u8]) -> Delivery {
        let provider_token = match self.provider_token() {
            Ok(t) => t,
            Err(_) => return Delivery::Unavailable("provider-token".into()),
        };
        let base = match environment {
            ApnsEnvironment::Production => &self.config.production_url,
            ApnsEnvironment::Development => &self.config.development_url,
        };
        let body = json!({
            "aps": {
                "alert": {"title": PLACEHOLDER_TITLE, "body": PLACEHOLDER_BODY},
                "mutable-content": 1,
                "sound": "default",
            },
            "c": STANDARD.encode(ciphertext),
        });
        let response = self
            .client
            .post(format!("{base}/3/device/{token}"))
            .header("authorization", format!("bearer {provider_token}"))
            .header("apns-topic", &self.config.topic)
            .header("apns-push-type", "alert")
            .header("apns-priority", "10")
            .header("apns-expiration", (self.clock.now_s() + EXPIRY_S).to_string())
            .json(&body)
            .send()
            .await;
        let response = match response {
            Ok(r) => r,
            Err(e) => return Delivery::Unavailable(transport_reason(&e)),
        };
        let status = response.status().as_u16();
        if status == 200 {
            return Delivery::Delivered;
        }
        let reason = response
            .json::<serde_json::Value>()
            .await
            .ok()
            .and_then(|v| v.get("reason").and_then(|r| r.as_str()).map(reason_code))
            .unwrap_or_else(|| format!("http-{status}"));
        match status {
            410 => Delivery::TokenGone(reason),
            400 if reason == "BadDeviceToken" => Delivery::TokenGone(reason),
            403 => {
                // An expired or refused provider token: mint a fresh one
                // next time instead of failing every push for 40 minutes.
                *self.provider_token.lock().unwrap() = None;
                Delivery::Unavailable(reason)
            }
            429 | 500..=599 => Delivery::Unavailable(reason),
            _ => Delivery::Rejected(reason),
        }
    }
}
