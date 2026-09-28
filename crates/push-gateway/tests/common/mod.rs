//! Seam 4's harness: the real gateway, serving its real HTTP API on a
//! loopback port, with its real APNs and FCM senders pointed at a fake
//! Apple and a fake Google. The fakes check what the real services check
//! -- the ES256 provider token, the RS256 assertion, the bearer token --
//! and record every push they are handed, so a test asserts exactly what
//! Apple or Google would have received.
#![allow(dead_code)]

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use gavin_push_gateway::apns::{Apns, ApnsConfig};
use gavin_push_gateway::clock::ManualClock;
use gavin_push_gateway::fcm::{Fcm, FcmConfig, ServiceAccount};
use gavin_push_gateway::log::{CapturedLog, Log};
use gavin_push_gateway::permission::PermissionKey;
use gavin_push_gateway::sender::Live;
use gavin_push_gateway::store::Store;
use gavin_push_gateway::{serve, Gateway, Settings};
use ring::rand::SystemRandom;
use ring::signature::{
    EcdsaKeyPair, KeyPair, RsaKeyPair, UnparsedPublicKey, ECDSA_P256_SHA256_FIXED, ECDSA_P256_SHA256_FIXED_SIGNING,
    RSA_PKCS1_2048_8192_SHA256,
};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

pub const TOPIC: &str = "dev.gavin.companion";
const APNS_KEY_ID: &str = "KEY1234567";
const APNS_TEAM_ID: &str = "TEAM123456";
const FCM_PROJECT: &str = "gavin-test";
const FCM_CLIENT_EMAIL: &str = "gateway@gavin-test.example";
const FCM_ACCESS_TOKEN: &str = "fake-access-token";

// ---------------------------------------------------------------- Apple

#[derive(Clone, Debug)]
pub struct ApnsRequest {
    pub environment: &'static str,
    pub token: String,
    pub topic: String,
    pub push_type: String,
    pub priority: String,
    pub body_len: usize,
    pub body: Value,
}

pub struct FakeApple {
    public_key: Vec<u8>,
    requests: Mutex<Vec<ApnsRequest>>,
    answers: Mutex<HashMap<String, (u16, &'static str)>>,
}

impl FakeApple {
    pub fn requests(&self) -> Vec<ApnsRequest> {
        self.requests.lock().unwrap().clone()
    }

    /// Answer every push to `token` with this status and reason.
    pub fn answer(&self, token: &str, status: u16, reason: &'static str) {
        self.answers.lock().unwrap().insert(token.to_string(), (status, reason));
    }

    fn verify_provider_token(&self, headers: &HeaderMap) -> bool {
        let Some(jwt) = header(headers, "authorization").and_then(|v| v.strip_prefix("bearer ").map(str::to_owned))
        else {
            return false;
        };
        let Some((input, signature)) = jwt.rsplit_once('.') else { return false };
        let Some((head, claims)) = input.split_once('.') else { return false };
        let (Some(head), Some(claims)) = (decode_json(head), decode_json(claims)) else { return false };
        let Ok(signature) = URL_SAFE_NO_PAD.decode(signature) else { return false };
        head["alg"] == "ES256"
            && head["kid"] == APNS_KEY_ID
            && claims["iss"] == APNS_TEAM_ID
            && claims["iat"].is_u64()
            && UnparsedPublicKey::new(&ECDSA_P256_SHA256_FIXED, &self.public_key)
                .verify(input.as_bytes(), &signature)
                .is_ok()
    }
}

async fn apple_production(State(apple): State<Arc<FakeApple>>, Path(token): Path<String>, headers: HeaderMap, body: Bytes) -> Response {
    apple_push(apple, "production", token, headers, body)
}

async fn apple_development(State(apple): State<Arc<FakeApple>>, Path(token): Path<String>, headers: HeaderMap, body: Bytes) -> Response {
    apple_push(apple, "development", token, headers, body)
}

fn apple_push(apple: Arc<FakeApple>, environment: &'static str, token: String, headers: HeaderMap, body: Bytes) -> Response {
    if !apple.verify_provider_token(&headers) {
        return (StatusCode::FORBIDDEN, Json(json!({"reason": "InvalidProviderToken"}))).into_response();
    }
    apple.requests.lock().unwrap().push(ApnsRequest {
        environment,
        token: token.clone(),
        topic: header(&headers, "apns-topic").unwrap_or_default(),
        push_type: header(&headers, "apns-push-type").unwrap_or_default(),
        priority: header(&headers, "apns-priority").unwrap_or_default(),
        body_len: body.len(),
        body: serde_json::from_slice(&body).expect("APNs body is JSON"),
    });
    match apple.answers.lock().unwrap().get(&token) {
        Some((status, reason)) => {
            (StatusCode::from_u16(*status).unwrap(), Json(json!({"reason": reason}))).into_response()
        }
        None => StatusCode::OK.into_response(),
    }
}

// ---------------------------------------------------------------- Google

#[derive(Clone, Debug)]
pub struct FcmRequest {
    pub body_len: usize,
    pub body: Value,
}

pub struct FakeGoogle {
    public_key: Vec<u8>,
    token_uri: Mutex<String>,
    pub token_exchanges: AtomicUsize,
    requests: Mutex<Vec<FcmRequest>>,
    answers: Mutex<HashMap<String, (u16, &'static str, &'static str)>>,
}

impl FakeGoogle {
    pub fn requests(&self) -> Vec<FcmRequest> {
        self.requests.lock().unwrap().clone()
    }

    /// Answer every push to `token` with this status, gRPC status and
    /// FcmError code.
    pub fn answer(&self, token: &str, status: u16, grpc: &'static str, error_code: &'static str) {
        self.answers.lock().unwrap().insert(token.to_string(), (status, grpc, error_code));
    }
}

async fn google_token(State(google): State<Arc<FakeGoogle>>, body: Bytes) -> Response {
    let form = String::from_utf8(body.to_vec()).unwrap();
    let field = |name: &str| {
        form.split('&').find_map(|pair| pair.split_once('=').filter(|(k, _)| *k == name).map(|(_, v)| v.to_string()))
    };
    let grant_ok = field("grant_type").as_deref() == Some("urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer");
    let assertion = field("assertion").unwrap_or_default();
    let verified = (|| {
        let (input, signature) = assertion.rsplit_once('.')?;
        let (head, claims) = input.split_once('.')?;
        let (head, claims) = (decode_json(head)?, decode_json(claims)?);
        let signature = URL_SAFE_NO_PAD.decode(signature).ok()?;
        UnparsedPublicKey::new(&RSA_PKCS1_2048_8192_SHA256, &google.public_key)
            .verify(input.as_bytes(), &signature)
            .ok()?;
        let iat = claims["iat"].as_u64()?;
        (head["alg"] == "RS256"
            && claims["iss"] == FCM_CLIENT_EMAIL
            && claims["scope"] == "https://www.googleapis.com/auth/firebase.messaging"
            && claims["aud"] == *google.token_uri.lock().unwrap()
            && claims["exp"].as_u64()? == iat + 3600)
            .then_some(())
    })()
    .is_some();
    if !(grant_ok && verified) {
        return (StatusCode::BAD_REQUEST, Json(json!({"error": "invalid_grant"}))).into_response();
    }
    google.token_exchanges.fetch_add(1, Ordering::SeqCst);
    Json(json!({"access_token": FCM_ACCESS_TOKEN, "expires_in": 3599, "token_type": "Bearer"})).into_response()
}

async fn google_send(State(google): State<Arc<FakeGoogle>>, Path(rest): Path<String>, headers: HeaderMap, body: Bytes) -> Response {
    if rest != format!("{FCM_PROJECT}/messages:send") {
        return StatusCode::NOT_FOUND.into_response();
    }
    if header(&headers, "authorization").as_deref() != Some(&format!("Bearer {FCM_ACCESS_TOKEN}")) {
        return (StatusCode::UNAUTHORIZED, Json(json!({"error": {"status": "UNAUTHENTICATED"}}))).into_response();
    }
    let parsed: Value = serde_json::from_slice(&body).expect("FCM body is JSON");
    let token = parsed["message"]["token"].as_str().unwrap_or_default().to_string();
    google.requests.lock().unwrap().push(FcmRequest { body_len: body.len(), body: parsed });
    match google.answers.lock().unwrap().get(&token) {
        Some((status, grpc, code)) => (
            StatusCode::from_u16(*status).unwrap(),
            Json(json!({"error": {
                "code": status,
                "message": "fake",
                "status": grpc,
                "details": [{"@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", "errorCode": code}],
            }})),
        )
            .into_response(),
        None => Json(json!({"name": format!("projects/{FCM_PROJECT}/messages/1")})).into_response(),
    }
}

// ---------------------------------------------------------------- harness

pub struct Options {
    pub settings: Settings,
    pub apns: bool,
    pub fcm: bool,
    /// Where the APNs development environment is, instead of the fake.
    pub apns_development_url: Option<String>,
}

impl Default for Options {
    fn default() -> Options {
        Options { settings: Settings::default(), apns: true, fcm: true, apns_development_url: None }
    }
}

pub struct Harness {
    pub url: String,
    pub http: reqwest::Client,
    pub clock: Arc<ManualClock>,
    pub log: Arc<CapturedLog>,
    pub apple: Arc<FakeApple>,
    pub google: Arc<FakeGoogle>,
}

#[derive(Clone, Debug)]
pub struct Device {
    pub id: String,
    pub secret: String,
}

#[derive(Clone, Debug)]
pub struct Granted {
    pub id: String,
    pub permission: String,
    pub expires_at: u64,
}

/// A response, read to the end.
pub struct Answer {
    pub status: u16,
    pub retry_after: Option<String>,
    pub body: Value,
}

impl Answer {
    pub fn error(&self) -> &str {
        self.body["error"].as_str().unwrap_or("")
    }
}

impl Harness {
    pub async fn start() -> Harness {
        Harness::start_with(Options::default()).await
    }

    pub async fn start_with(options: Options) -> Harness {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let rng = SystemRandom::new();
        let apns_pkcs8 = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &rng).unwrap();
        let apns_key = EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, apns_pkcs8.as_ref(), &rng).unwrap();
        let rsa_der = STANDARD
            .decode(include_str!("../fixtures/fcm-test-rsa-key.pkcs8.b64").replace('\n', ""))
            .unwrap();
        let rsa_key = RsaKeyPair::from_pkcs8(&rsa_der).unwrap();

        let apple = Arc::new(FakeApple {
            public_key: apns_key.public_key().as_ref().to_vec(),
            requests: Mutex::default(),
            answers: Mutex::default(),
        });
        let apple_url = listen(
            Router::new()
                .route("/3/device/{token}", post(apple_production))
                .route("/development/3/device/{token}", post(apple_development))
                .with_state(apple.clone()),
        )
        .await;

        let google = Arc::new(FakeGoogle {
            public_key: rsa_key.public_key().as_ref().to_vec(),
            token_uri: Mutex::default(),
            token_exchanges: AtomicUsize::new(0),
            requests: Mutex::default(),
            answers: Mutex::default(),
        });
        let google_url = listen(
            Router::new()
                .route("/token", post(google_token))
                .route("/v1/projects/{*rest}", post(google_send))
                .with_state(google.clone()),
        )
        .await;
        let token_uri = format!("{google_url}/token");
        *google.token_uri.lock().unwrap() = token_uri.clone();

        let clock = Arc::new(ManualClock::at_ms(1_800_000_000_000));
        let log = Arc::new(CapturedLog::default());
        let apns = options.apns.then(|| {
            Apns::new(
                ApnsConfig {
                    key_pkcs8: apns_pkcs8.as_ref().to_vec(),
                    key_id: APNS_KEY_ID.into(),
                    team_id: APNS_TEAM_ID.into(),
                    topic: TOPIC.into(),
                    production_url: apple_url.clone(),
                    development_url: options
                        .apns_development_url
                        .clone()
                        .unwrap_or_else(|| format!("{apple_url}/development")),
                },
                clock.clone(),
            )
            .unwrap()
        });
        let fcm = options.fcm.then(|| {
            let pem = format!(
                "-----BEGIN PRIVATE KEY-----\n{}\n-----END PRIVATE KEY-----\n",
                STANDARD.encode(&rsa_der)
            );
            Fcm::new(
                FcmConfig {
                    account: ServiceAccount {
                        project_id: FCM_PROJECT.into(),
                        private_key: pem,
                        client_email: FCM_CLIENT_EMAIL.into(),
                        token_uri,
                        private_key_id: Some("key-1".into()),
                    },
                    send_base_url: google_url.clone(),
                },
                clock.clone(),
            )
            .unwrap()
        });
        let gateway = Gateway::new(
            Store::open_in_memory().unwrap(),
            PermissionKey::random(),
            Box::new(Live { apns, fcm }),
            clock.clone(),
            Log::new(log.clone()),
            options.settings,
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(serve(listener, Arc::new(gateway), std::future::pending()));

        Harness { url, http: reqwest::Client::new(), clock, log, apple, google }
    }

    pub async fn call(&self, method: &str, path: &str, bearer: Option<&str>, body: Option<Vec<u8>>) -> Answer {
        let mut request = self.http.request(method.parse().unwrap(), format!("{}{path}", self.url));
        if let Some(bearer) = bearer {
            request = request.bearer_auth(bearer);
        }
        if let Some(body) = body {
            request = request.body(body);
        }
        let response = request.send().await.unwrap();
        let status = response.status().as_u16();
        let retry_after = response.headers().get("retry-after").map(|v| v.to_str().unwrap().to_string());
        let bytes = response.bytes().await.unwrap();
        let body = if bytes.is_empty() { Value::Null } else { serde_json::from_slice(&bytes).unwrap_or(Value::Null) };
        Answer { status, retry_after, body }
    }

    pub async fn try_register(&self, body: Value) -> Answer {
        self.call("POST", "/v1/devices", None, Some(body.to_string().into_bytes())).await
    }

    pub async fn register(&self, body: Value) -> Device {
        let answer = self.try_register(body).await;
        assert_eq!(answer.status, 201, "{:?}", answer.body);
        Device {
            id: answer.body["device_id"].as_str().unwrap().into(),
            secret: answer.body["device_secret"].as_str().unwrap().into(),
        }
    }

    pub async fn register_ios(&self, token: &str) -> Device {
        self.register(json!({"platform": "ios", "token": token})).await
    }

    pub async fn register_android(&self, token: &str) -> Device {
        self.register(json!({"platform": "android", "token": token})).await
    }

    pub async fn replace_token(&self, device: &Device, body: Value) -> Answer {
        self.call("PUT", &format!("/v1/devices/{}/token", device.id), Some(&device.secret), Some(body.to_string().into_bytes()))
            .await
    }

    pub async fn try_grant(&self, device: &Device) -> Answer {
        self.call("POST", &format!("/v1/devices/{}/permissions", device.id), Some(&device.secret), None).await
    }

    pub async fn grant(&self, device: &Device) -> Granted {
        let answer = self.try_grant(device).await;
        assert_eq!(answer.status, 201, "{:?}", answer.body);
        Granted {
            id: answer.body["permission_id"].as_str().unwrap().into(),
            permission: answer.body["permission"].as_str().unwrap().into(),
            expires_at: answer.body["expires_at"].as_u64().unwrap(),
        }
    }

    pub async fn cancel(&self, device: &Device, secret: &str, permission_id: &str) -> Answer {
        self.call("DELETE", &format!("/v1/devices/{}/permissions/{permission_id}", device.id), Some(secret), None)
            .await
    }

    pub async fn unregister(&self, device: &Device) -> Answer {
        self.call("DELETE", &format!("/v1/devices/{}", device.id), Some(&device.secret), None).await
    }

    pub async fn push(&self, permission: &str, ciphertext: &[u8]) -> Answer {
        self.call("POST", "/v1/push", Some(permission), Some(ciphertext.to_vec())).await
    }
}

/// A 64-hex-digit APNs token, distinct per `n`.
pub fn ios_token(n: u8) -> String {
    format!("{n:02x}").repeat(32)
}

/// An FCM-shaped token, distinct per `n`.
pub fn android_token(n: u8) -> String {
    format!("f{n:03}:APA91b{}", "Xy_-".repeat(36))
}

async fn listen(router: Router) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    url
}

fn header(headers: &HeaderMap, name: &str) -> Option<String> {
    headers.get(name).and_then(|v| v.to_str().ok()).map(str::to_owned)
}

fn decode_json(part: &str) -> Option<Value> {
    serde_json::from_slice(&URL_SAFE_NO_PAD.decode(part).ok()?).ok()
}
