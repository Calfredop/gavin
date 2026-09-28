//! The HTTP API. `docs/push-gateway.md` is its reference; keep the two
//! in step.

use crate::gateway::{Gateway, Refusal};
use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, MatchedPath, Path, Request, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post, put};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;
use std::time::Instant;

/// Far above anything a real request needs; the push route has its own,
/// tighter limit (`MAX_CIPHERTEXT`) with its own answer.
const BODY_LIMIT: usize = 16 * 1024;

type Shared = State<Arc<Gateway>>;

pub fn router(gateway: Arc<Gateway>) -> Router {
    Router::new()
        .route("/v1/devices", post(register))
        .route("/v1/devices/{device_id}", delete(unregister))
        .route("/v1/devices/{device_id}/token", put(replace_token))
        .route("/v1/devices/{device_id}/permissions", post(grant))
        .route("/v1/devices/{device_id}/permissions/{permission_id}", delete(cancel))
        .route("/v1/push", post(push))
        .route("/healthz", get(|| async { "ok\n" }))
        .fallback(|| async { refusal(StatusCode::NOT_FOUND, "not_found") })
        .layer(middleware::from_fn_with_state(gateway.clone(), log_request))
        .layer(DefaultBodyLimit::max(BODY_LIMIT))
        .with_state(gateway)
}

#[derive(Deserialize)]
struct RegisterBody {
    platform: String,
    token: String,
    #[serde(default)]
    environment: Option<String>,
}

#[derive(Deserialize)]
struct TokenBody {
    token: String,
    #[serde(default)]
    environment: Option<String>,
}

async fn register(State(gw): Shared, body: Bytes) -> Response {
    let body: RegisterBody = match parse(&body) {
        Ok(b) => b,
        Err(refused) => return refused.into_response(),
    };
    match gw.register(&body.platform, &body.token, body.environment.as_deref()) {
        Ok(r) => (
            StatusCode::CREATED,
            Json(json!({"device_id": r.device_id.to_string(), "device_secret": r.device_secret})),
        )
            .into_response(),
        Err(refused) => refused.into_response(),
    }
}

async fn replace_token(State(gw): Shared, Path(device): Path<String>, headers: HeaderMap, body: Bytes) -> Response {
    let body: TokenBody = match parse(&body) {
        Ok(b) => b,
        Err(refused) => return refused.into_response(),
    };
    no_content(gw.replace_token(&device, bearer(&headers), &body.token, body.environment.as_deref()))
}

async fn unregister(State(gw): Shared, Path(device): Path<String>, headers: HeaderMap) -> Response {
    no_content(gw.unregister(&device, bearer(&headers)))
}

async fn grant(State(gw): Shared, Path(device): Path<String>, headers: HeaderMap) -> Response {
    match gw.grant(&device, bearer(&headers)) {
        Ok(g) => (
            StatusCode::CREATED,
            Json(json!({
                "permission_id": g.permission_id.to_string(),
                "permission": g.permission,
                "expires_at": g.expires_at,
            })),
        )
            .into_response(),
        Err(refused) => refused.into_response(),
    }
}

async fn cancel(
    State(gw): Shared,
    Path((device, permission)): Path<(String, String)>,
    headers: HeaderMap,
) -> Response {
    no_content(gw.cancel(&device, bearer(&headers), &permission))
}

/// The body IS the ciphertext, raw bytes of any content type: nothing
/// here parses it, so nothing here can alter it.
async fn push(State(gw): Shared, headers: HeaderMap, body: Bytes) -> Response {
    match gw.push(bearer(&headers), &body).await {
        Ok(()) => StatusCode::ACCEPTED.into_response(),
        Err(refused) => refused.into_response(),
    }
}

impl IntoResponse for Refusal {
    fn into_response(self) -> Response {
        let status = match self {
            Refusal::BadRequest(_) => StatusCode::BAD_REQUEST,
            Refusal::DeviceUnauthorized
            | Refusal::PermissionInvalid
            | Refusal::PermissionExpired
            | Refusal::PermissionCancelled => StatusCode::UNAUTHORIZED,
            Refusal::PlatformUnavailable => StatusCode::UNPROCESSABLE_ENTITY,
            Refusal::TooManyPermissions => StatusCode::CONFLICT,
            Refusal::PermissionNotFound | Refusal::DeviceUnreachable => StatusCode::NOT_FOUND,
            Refusal::PayloadTooLarge => StatusCode::PAYLOAD_TOO_LARGE,
            Refusal::RateLimited { .. } => StatusCode::TOO_MANY_REQUESTS,
            Refusal::UpstreamRejected => StatusCode::BAD_GATEWAY,
            Refusal::UpstreamUnavailable => StatusCode::SERVICE_UNAVAILABLE,
            Refusal::Internal => StatusCode::INTERNAL_SERVER_ERROR,
        };
        let mut response = refusal(status, self.code());
        if let Refusal::RateLimited { retry_after_s } = self {
            response.headers_mut().insert(header::RETRY_AFTER, HeaderValue::from(retry_after_s));
        }
        response
    }
}

fn refusal(status: StatusCode, code: &str) -> Response {
    (status, Json(json!({"error": code}))).into_response()
}

fn no_content(result: Result<(), Refusal>) -> Response {
    match result {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(refused) => refused.into_response(),
    }
}

/// JSON parsed by hand rather than by axum's extractor, so a malformed
/// body gets the same `{"error": ...}` shape as every other refusal
/// instead of serde's message, which quotes the body back.
fn parse<T: for<'de> Deserialize<'de>>(body: &[u8]) -> Result<T, Refusal> {
    serde_json::from_slice(body).map_err(|_| Refusal::BadRequest("bad_json"))
}

fn bearer(headers: &HeaderMap) -> Option<&str> {
    let value = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let (scheme, credential) = value.split_once(' ')?;
    scheme.eq_ignore_ascii_case("bearer").then(|| credential.trim())
}

/// One line per request: method, ROUTE template (never the raw path),
/// status and time. Health checks are left out; they would drown the rest.
async fn log_request(State(gw): Shared, request: Request, next: Next) -> Response {
    let method = request.method().clone();
    let route = request.extensions().get::<MatchedPath>().map(|p| p.as_str().to_owned());
    let started = Instant::now();
    let response = next.run(request).await;
    if route.as_deref() != Some("/healthz") {
        gw.log().info(format!(
            "{method} {} {} {}ms",
            route.as_deref().unwrap_or("-"),
            response.status().as_u16(),
            started.elapsed().as_millis()
        ));
    }
    response
}
