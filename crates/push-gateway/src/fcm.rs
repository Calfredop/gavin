//! Firebase Cloud Messaging, HTTP v1.
//!
//! Every push is a data message and nothing else: no `notification`
//! block, so Android never draws anything by itself and the Companion's
//! messaging service decrypts `c` before it posts a notification.

use crate::clock::Clock;
use crate::jwt;
use crate::sender::{http_client, reason_code, transport_reason, Delivery};
use anyhow::{bail, Context, Result};
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use ring::signature::RsaKeyPair;
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;

pub const SEND_BASE_URL: &str = "https://fcm.googleapis.com";
const SCOPE: &str = "https://www.googleapis.com/auth/firebase.messaging";
/// Refresh an access token this long before Google says it expires.
const ACCESS_TOKEN_MARGIN_S: u64 = 5 * 60;
const TTL: &str = "86400s";

/// The fields of a Google service account key file the gateway reads.
#[derive(Deserialize)]
pub struct ServiceAccount {
    pub project_id: String,
    pub private_key: String,
    pub client_email: String,
    #[serde(default = "default_token_uri")]
    pub token_uri: String,
    #[serde(default)]
    pub private_key_id: Option<String>,
}

fn default_token_uri() -> String {
    "https://oauth2.googleapis.com/token".into()
}

pub struct FcmConfig {
    pub account: ServiceAccount,
    pub send_base_url: String,
}

pub struct Fcm {
    config: FcmConfig,
    key: RsaKeyPair,
    client: reqwest::Client,
    clock: Arc<dyn Clock>,
    /// (access token, expires at). An async mutex so a burst of pushes
    /// after expiry waits on one token exchange instead of starting many.
    access: tokio::sync::Mutex<Option<(String, u64)>>,
}

#[derive(Deserialize)]
struct TokenResponse {
    access_token: String,
    expires_in: u64,
}

impl Fcm {
    pub fn new(config: FcmConfig, clock: Arc<dyn Clock>) -> Result<Fcm> {
        let project = &config.account.project_id;
        if project.is_empty() || !project.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
            bail!("the service account's project_id is not a Firebase project id");
        }
        let der = jwt::pkcs8_from_pem(&config.account.private_key).context("the service account's private_key")?;
        let key = RsaKeyPair::from_pkcs8(&der)
            .map_err(|e| anyhow::anyhow!("the service account's private_key is not an RSA PKCS#8 key: {e}"))?;
        Ok(Fcm { config, key, client: http_client(), clock, access: tokio::sync::Mutex::new(None) })
    }

    async fn access_token(&self) -> Result<String, Delivery> {
        let now = self.clock.now_s();
        let mut access = self.access.lock().await;
        if let Some((token, expires_at)) = access.as_ref() {
            if now + ACCESS_TOKEN_MARGIN_S < *expires_at {
                return Ok(token.clone());
            }
        }
        let account = &self.config.account;
        let mut header = json!({"alg": "RS256", "typ": "JWT"});
        if let Some(kid) = &account.private_key_id {
            header["kid"] = json!(kid);
        }
        let assertion = jwt::rs256(
            &self.key,
            &header,
            &json!({
                "iss": account.client_email,
                "scope": SCOPE,
                "aud": account.token_uri,
                "iat": now,
                "exp": now + 3600,
            }),
        )
        .map_err(|_| Delivery::Unavailable("assertion".into()))?;
        let response = self
            .client
            .post(&account.token_uri)
            .form(&[("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer"), ("assertion", &assertion)])
            .send()
            .await
            .map_err(|e| Delivery::Unavailable(format!("oauth-{}", transport_reason(&e))))?;
        let status = response.status().as_u16();
        if status != 200 {
            return Err(Delivery::Unavailable(format!("oauth-http-{status}")));
        }
        let token: TokenResponse =
            response.json().await.map_err(|_| Delivery::Unavailable("oauth-decode".into()))?;
        *access = Some((token.access_token.clone(), now + token.expires_in));
        Ok(token.access_token)
    }

    pub async fn send(&self, token: &str, ciphertext: &[u8]) -> Delivery {
        let access_token = match self.access_token().await {
            Ok(t) => t,
            Err(delivery) => return delivery,
        };
        let body = json!({
            "message": {
                "token": token,
                "data": {"c": STANDARD.encode(ciphertext)},
                "android": {"priority": "HIGH", "ttl": TTL},
            }
        });
        let response = self
            .client
            .post(format!(
                "{}/v1/projects/{}/messages:send",
                self.config.send_base_url, self.config.account.project_id
            ))
            .bearer_auth(access_token)
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
        let error = response.json::<serde_json::Value>().await.ok();
        let error = error.as_ref().and_then(|v| v.get("error"));
        // FcmError's errorCode is the precise one (UNREGISTERED,
        // SENDER_ID_MISMATCH); the gRPC status is the fallback.
        let code = error
            .and_then(|e| e.get("details"))
            .and_then(|d| d.as_array())
            .and_then(|details| details.iter().find_map(|d| d.get("errorCode").and_then(|c| c.as_str())))
            .or_else(|| error.and_then(|e| e.get("status")).and_then(|s| s.as_str()))
            .map(reason_code)
            .unwrap_or_else(|| format!("http-{status}"));
        match status {
            404 => Delivery::TokenGone(code),
            _ if code == "UNREGISTERED" => Delivery::TokenGone(code),
            401 => {
                *self.access.lock().await = None;
                Delivery::Unavailable(code)
            }
            429 | 500..=599 => Delivery::Unavailable(code),
            _ => Delivery::Rejected(code),
        }
    }
}
