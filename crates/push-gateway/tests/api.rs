//! Seam 4: the Push gateway's HTTP API, driven from outside, with a fake
//! Apple and a fake Google on the other side (see `common`).

mod common;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use common::{android_token, ios_token, Harness, Options, TOPIC};
use gavin_push_gateway::clock::Clock;
use gavin_push_gateway::gateway::MAX_CIPHERTEXT;
use gavin_push_gateway::id::Id;
use gavin_push_gateway::permission::{Claims, PermissionKey};
use gavin_push_gateway::rate::RateLimit;
use gavin_push_gateway::Settings;
use serde_json::json;
use std::sync::atomic::Ordering;

/// Every byte value, and not valid UTF-8: anything that decoded, trimmed
/// or re-encoded the ciphertext on the way through would show.
fn ciphertext() -> Vec<u8> {
    (0..=255u8).chain((0..=255u8).rev()).collect()
}

// ------------------------------------------------ refused permissions

#[tokio::test(flavor = "multi_thread")]
async fn a_missing_forged_or_edited_permission_is_refused() {
    let h = Harness::start().await;
    let device = h.register_ios(&ios_token(1)).await;
    let granted = h.grant(&device).await;

    // The same claims, signed by a key that is not this gateway's.
    let foreign = PermissionKey::random().sign(&Claims {
        permission: Id::parse(&granted.id).unwrap(),
        device: Id::parse(&device.id).unwrap(),
        expires_at: u64::MAX,
    });
    let (signed, tag) = granted.permission.rsplit_once('.').unwrap();
    let flipped = if tag.starts_with('A') { "B" } else { "A" };
    let edited_tag = format!("{signed}.{flipped}{}", &tag[1..]);

    let missing = h.call("POST", "/v1/push", None, Some(b"x".to_vec())).await;
    assert_eq!((missing.status, missing.error()), (401, "permission_invalid"));
    for permission in ["", "garbage", "v1.AAAA.AAAA", foreign.as_str(), edited_tag.as_str()] {
        let answer = h.push(permission, &ciphertext()).await;
        assert_eq!((answer.status, answer.error()), (401, "permission_invalid"), "{permission:?}");
    }
    assert!(h.apple.requests().is_empty());

    // The genuine one still works.
    assert_eq!(h.push(&granted.permission, &ciphertext()).await.status, 202);
}

#[tokio::test(flavor = "multi_thread")]
async fn an_expired_permission_is_refused() {
    let h = Harness::start_with(Options {
        settings: Settings { permission_ttl_s: 3600, ..Settings::default() },
        ..Options::default()
    })
    .await;
    let device = h.register_ios(&ios_token(1)).await;
    let granted = h.grant(&device).await;
    assert_eq!(granted.expires_at, h.clock.now_s() + 3600);

    h.clock.advance_s(3599);
    assert_eq!(h.push(&granted.permission, b"one").await.status, 202);
    h.clock.advance_s(1);
    let answer = h.push(&granted.permission, b"two").await;
    assert_eq!((answer.status, answer.error()), (401, "permission_expired"));
    assert_eq!(h.apple.requests().len(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_cancelled_permission_is_refused_and_the_devices_others_keep_working() {
    let h = Harness::start().await;
    let device = h.register_ios(&ios_token(1)).await;
    // One per Workstation.
    let (first, second) = (h.grant(&device).await, h.grant(&device).await);

    assert_eq!(h.cancel(&device, &device.secret, &first.id).await.status, 204);
    let answer = h.push(&first.permission, b"x").await;
    assert_eq!((answer.status, answer.error()), (401, "permission_cancelled"));
    assert_eq!(h.push(&second.permission, b"x").await.status, 202);

    let again = h.cancel(&device, &device.secret, &first.id).await;
    assert_eq!((again.status, again.error()), (404, "permission_not_found"));
}

#[tokio::test(flavor = "multi_thread")]
async fn only_the_device_itself_can_cancel_its_permission() {
    let h = Harness::start().await;
    let (owner, other) = (h.register_ios(&ios_token(1)).await, h.register_ios(&ios_token(2)).await);
    let granted = h.grant(&owner).await;

    let wrong_secret = h.cancel(&owner, &other.secret, &granted.id).await;
    assert_eq!((wrong_secret.status, wrong_secret.error()), (401, "device_unauthorized"));
    let no_secret =
        h.call("DELETE", &format!("/v1/devices/{}/permissions/{}", owner.id, granted.id), None, None).await;
    assert_eq!(no_secret.status, 401);
    let others_permission = h.cancel(&other, &other.secret, &granted.id).await;
    assert_eq!((others_permission.status, others_permission.error()), (404, "permission_not_found"));

    assert_eq!(h.push(&granted.permission, b"x").await.status, 202);
}

#[tokio::test(flavor = "multi_thread")]
async fn unregistering_a_device_cancels_every_permission_it_minted() {
    let h = Harness::start().await;
    let device = h.register_android(&android_token(1)).await;
    let (first, second) = (h.grant(&device).await, h.grant(&device).await);

    assert_eq!(h.unregister(&device).await.status, 204);
    for granted in [first, second] {
        let answer = h.push(&granted.permission, b"x").await;
        assert_eq!((answer.status, answer.error()), (401, "permission_cancelled"));
    }
    assert_eq!(h.try_grant(&device).await.status, 401);
    assert!(h.google.requests().is_empty());
}

// ------------------------------------------------ the rate limit

#[tokio::test(flavor = "multi_thread")]
async fn the_per_device_rate_limit_holds_across_its_permissions() {
    let h = Harness::start_with(Options {
        settings: Settings { rate: RateLimit { burst: 3, interval_ms: 60_000 }, ..Settings::default() },
        ..Options::default()
    })
    .await;
    let device = h.register_ios(&ios_token(1)).await;
    // Two Workstations share the one Device's allowance.
    let (a, b) = (h.grant(&device).await, h.grant(&device).await);
    let bystander = h.register_ios(&ios_token(2)).await;
    let bystander_permission = h.grant(&bystander).await;

    for permission in [&a, &b, &a] {
        assert_eq!(h.push(&permission.permission, b"x").await.status, 202);
    }
    for permission in [&a, &b] {
        let answer = h.push(&permission.permission, b"x").await;
        assert_eq!((answer.status, answer.error()), (429, "rate_limited"));
        assert_eq!(answer.retry_after.as_deref(), Some("60"));
    }
    // Another Device is untouched.
    assert_eq!(h.push(&bystander_permission.permission, b"x").await.status, 202);

    h.clock.advance_s(60);
    assert_eq!(h.push(&b.permission, b"x").await.status, 202);
    assert_eq!(h.push(&a.permission, b"x").await.status, 429);

    // Nothing refused reached Apple.
    let to_device = h.apple.requests().iter().filter(|r| r.token == ios_token(1)).count();
    assert_eq!(to_device, 4);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_refused_permission_spends_none_of_the_devices_allowance() {
    let h = Harness::start_with(Options {
        settings: Settings { rate: RateLimit { burst: 2, interval_ms: 60_000 }, ..Settings::default() },
        ..Options::default()
    })
    .await;
    let device = h.register_ios(&ios_token(1)).await;
    let granted = h.grant(&device).await;
    let forged = PermissionKey::random().sign(&Claims {
        permission: Id::parse(&granted.id).unwrap(),
        device: Id::parse(&device.id).unwrap(),
        expires_at: u64::MAX,
    });
    for _ in 0..10 {
        assert_eq!(h.push(&forged, b"x").await.status, 401);
    }
    assert_eq!(h.push(&granted.permission, b"x").await.status, 202);
    assert_eq!(h.push(&granted.permission, b"x").await.status, 202);
}

// ------------------------------------------------ byte for byte

#[tokio::test(flavor = "multi_thread")]
async fn ciphertext_reaches_apple_byte_for_byte_as_a_mutable_content_push() {
    let h = Harness::start().await;
    let device = h.register_ios(&ios_token(7)).await;
    let granted = h.grant(&device).await;

    assert_eq!(h.push(&granted.permission, &ciphertext()).await.status, 202);

    let [request] = h.apple.requests().try_into().unwrap();
    assert_eq!(request.environment, "production");
    assert_eq!(request.token, ios_token(7));
    assert_eq!(request.topic, TOPIC);
    assert_eq!(request.push_type, "alert");
    assert_eq!(request.priority, "10");
    assert_eq!(request.body["aps"]["mutable-content"], 1);
    // A placeholder the extension replaces, and nothing of the payload.
    assert!(request.body["aps"]["alert"]["body"].is_string());
    assert_eq!(STANDARD.decode(request.body["c"].as_str().unwrap()).unwrap(), ciphertext());
}

#[tokio::test(flavor = "multi_thread")]
async fn ciphertext_reaches_google_byte_for_byte_as_a_data_message() {
    let h = Harness::start().await;
    let device = h.register_android(&android_token(7)).await;
    let granted = h.grant(&device).await;

    assert_eq!(h.push(&granted.permission, &ciphertext()).await.status, 202);
    assert_eq!(h.push(&granted.permission, b"second").await.status, 202);

    let requests = h.google.requests();
    assert_eq!(requests.len(), 2);
    let message = &requests[0].body["message"];
    assert_eq!(message["token"], android_token(7));
    // A data message: no notification block for Android to draw by itself.
    assert!(message.get("notification").is_none());
    assert_eq!(message["android"]["priority"], "HIGH");
    assert_eq!(STANDARD.decode(message["data"]["c"].as_str().unwrap()).unwrap(), ciphertext());
    // One access token served both pushes.
    assert_eq!(h.google.token_exchanges.load(Ordering::SeqCst), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn the_largest_ciphertext_fits_both_services_and_one_byte_more_is_refused() {
    let h = Harness::start().await;
    let ios = h.grant(&h.register_ios(&ios_token(1)).await).await;
    let android = h.grant(&h.register_android(&android_token(1)).await).await;
    let largest = vec![0xA5u8; MAX_CIPHERTEXT];

    assert_eq!(h.push(&ios.permission, &largest).await.status, 202);
    assert_eq!(h.push(&android.permission, &largest).await.status, 202);
    // APNs and FCM both refuse a payload over 4096 bytes.
    assert!(h.apple.requests()[0].body_len <= 4096);
    assert!(h.google.requests()[0].body["message"]["data"].to_string().len() <= 4096);

    let too_large = h.push(&ios.permission, &vec![0u8; MAX_CIPHERTEXT + 1]).await;
    assert_eq!((too_large.status, too_large.error()), (413, "payload_too_large"));
    let empty = h.push(&ios.permission, b"").await;
    assert_eq!((empty.status, empty.error()), (400, "empty_payload"));
    assert_eq!(h.apple.requests().len(), 1);
}

// ------------------------------------------------ tokens

#[tokio::test(flavor = "multi_thread")]
async fn replacing_a_token_keeps_existing_permissions_working() {
    let h = Harness::start().await;
    let device = h.register_ios(&ios_token(1)).await;
    let granted = h.grant(&device).await;

    let replaced = h.replace_token(&device, json!({"token": ios_token(2)})).await;
    assert_eq!(replaced.status, 204, "{:?}", replaced.body);
    assert_eq!(h.push(&granted.permission, b"x").await.status, 202);
    // And a development build's token goes to the development environment.
    assert_eq!(h.replace_token(&device, json!({"token": ios_token(3), "environment": "development"})).await.status, 204);
    assert_eq!(h.push(&granted.permission, b"x").await.status, 202);

    let sent: Vec<_> = h.apple.requests().into_iter().map(|r| (r.token, r.environment)).collect();
    assert_eq!(sent, [(ios_token(2), "production"), (ios_token(3), "development")]);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_token_apple_reports_gone_is_not_used_again_until_the_device_replaces_it() {
    let h = Harness::start().await;
    let device = h.register_ios(&ios_token(1)).await;
    let granted = h.grant(&device).await;
    h.apple.answer(&ios_token(1), 410, "Unregistered");

    for _ in 0..2 {
        let answer = h.push(&granted.permission, b"x").await;
        assert_eq!((answer.status, answer.error()), (404, "device_unreachable"));
    }
    assert_eq!(h.apple.requests().len(), 1);

    assert_eq!(h.replace_token(&device, json!({"token": ios_token(2)})).await.status, 204);
    assert_eq!(h.push(&granted.permission, b"x").await.status, 202);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_token_google_reports_unregistered_is_forgotten() {
    let h = Harness::start().await;
    let device = h.register_android(&android_token(1)).await;
    let granted = h.grant(&device).await;
    h.google.answer(&android_token(1), 404, "NOT_FOUND", "UNREGISTERED");

    assert_eq!(h.push(&granted.permission, b"x").await.error(), "device_unreachable");
    assert_eq!(h.push(&granted.permission, b"x").await.error(), "device_unreachable");
    assert_eq!(h.google.requests().len(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_newer_device_claiming_a_token_retires_the_older_one() {
    let h = Harness::start().await;
    let old = h.register_ios(&ios_token(1)).await;
    let old_permission = h.grant(&old).await;
    // A reinstall on the same phone: a new Device, the same token.
    let new = h.register(json!({"platform": "ios", "token": ios_token(1).to_uppercase()})).await;
    let new_permission = h.grant(&new).await;

    let answer = h.push(&old_permission.permission, b"x").await;
    assert_eq!((answer.status, answer.error()), (401, "permission_cancelled"));
    assert_eq!(h.try_grant(&old).await.status, 401);
    assert_eq!(h.push(&new_permission.permission, b"x").await.status, 202);
    assert_eq!(h.apple.requests()[0].token, ios_token(1));
}

// ------------------------------------------------ upstream failures

#[tokio::test(flavor = "multi_thread")]
async fn upstream_failures_say_whether_to_try_again() {
    let h = Harness::start().await;
    let busy = h.grant(&h.register_ios(&ios_token(1)).await).await;
    let refused = h.grant(&h.register_ios(&ios_token(2)).await).await;
    let throttled = h.grant(&h.register_android(&android_token(1)).await).await;
    h.apple.answer(&ios_token(1), 503, "ServiceUnavailable");
    h.apple.answer(&ios_token(2), 400, "BadTopic");
    h.google.answer(&android_token(1), 429, "RESOURCE_EXHAUSTED", "QUOTA_EXCEEDED");

    let answer = h.push(&busy.permission, b"x").await;
    assert_eq!((answer.status, answer.error()), (503, "upstream_unavailable"));
    let answer = h.push(&refused.permission, b"x").await;
    assert_eq!((answer.status, answer.error()), (502, "upstream_rejected"));
    let answer = h.push(&throttled.permission, b"x").await;
    assert_eq!((answer.status, answer.error()), (503, "upstream_unavailable"));
    // None of these cost the Device its token.
    h.apple.answer(&ios_token(1), 200, "");
    assert_eq!(h.push(&busy.permission, b"x").await.status, 202);
}

// ------------------------------------------------ registration

#[tokio::test(flavor = "multi_thread")]
async fn registration_refuses_what_it_cannot_deliver_to() {
    let h = Harness::start().await;
    for (body, code) in [
        (json!({"platform": "windows-phone", "token": ios_token(1)}), "unknown_platform"),
        (json!({"platform": "ios", "token": "not hex at all, not at all"}), "bad_token"),
        (json!({"platform": "ios", "token": format!("{}/../../x", ios_token(1))}), "bad_token"),
        (json!({"platform": "ios", "token": "abcd"}), "bad_token"),
        (json!({"platform": "ios", "token": ios_token(1), "environment": "staging"}), "unknown_environment"),
        (json!({"platform": "android", "token": "short"}), "bad_token"),
        (json!({"platform": "android", "token": format!("{} {}", android_token(1), "space")}), "bad_token"),
        (json!({"platform": "ios"}), "bad_json"),
    ] {
        let answer = h.try_register(body.clone()).await;
        assert_eq!((answer.status, answer.error()), (400, code), "{body}");
    }
    let not_json = h.call("POST", "/v1/devices", None, Some(b"{".to_vec())).await;
    assert_eq!((not_json.status, not_json.error()), (400, "bad_json"));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_platform_without_credentials_cannot_register() {
    let h = Harness::start_with(Options { fcm: false, ..Options::default() }).await;
    let answer = h.try_register(json!({"platform": "android", "token": android_token(1)})).await;
    assert_eq!((answer.status, answer.error()), (422, "platform_unavailable"));
    h.register_ios(&ios_token(1)).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_device_cannot_mint_permissions_without_bound() {
    let h = Harness::start_with(Options {
        settings: Settings { max_permissions_per_device: 2, ..Settings::default() },
        ..Options::default()
    })
    .await;
    let device = h.register_ios(&ios_token(1)).await;
    let first = h.grant(&device).await;
    h.grant(&device).await;
    let third = h.try_grant(&device).await;
    assert_eq!((third.status, third.error()), (409, "too_many_permissions"));
    // Cancelling one makes room.
    h.cancel(&device, &device.secret, &first.id).await;
    h.grant(&device).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn health_and_unknown_routes() {
    let h = Harness::start().await;
    let health = h.http.get(format!("{}/healthz", h.url)).send().await.unwrap();
    assert_eq!(health.status(), 200);
    let unknown = h.call("GET", "/v1/nothing", None, None).await;
    assert_eq!((unknown.status, unknown.error()), (404, "not_found"));
}

// ------------------------------------------------ the log

#[tokio::test(flavor = "multi_thread")]
async fn payloads_tokens_secrets_and_permissions_never_reach_the_log() {
    let h = Harness::start_with(Options {
        settings: Settings { rate: RateLimit { burst: 2, interval_ms: 60_000 }, ..Settings::default() },
        // Nothing listens here: a transport failure, whose error text
        // would carry the URL and so the token.
        apns_development_url: Some("http://127.0.0.1:9".into()),
        ..Options::default()
    })
    .await;
    // What a careless gateway would leak, if the Companion ever sent it
    // unencrypted -- as bytes, the gateway cannot tell the difference.
    let payload = b"MARKER-agent-asks-which-migration-to-keep".to_vec();

    let ios = h.register_ios(&ios_token(1)).await;
    let android = h.register_android(&android_token(1)).await;
    let development = h
        .register(json!({"platform": "ios", "token": ios_token(3), "environment": "development"}))
        .await;
    let ios_permission = h.grant(&ios).await;
    let android_permission = h.grant(&android).await;
    let development_permission = h.grant(&development).await;

    assert_eq!(h.push(&ios_permission.permission, &payload).await.status, 202);
    assert_eq!(h.push(&android_permission.permission, &payload).await.status, 202);
    assert_eq!(h.push(&ios_permission.permission, &payload).await.status, 202);
    assert_eq!(h.push(&ios_permission.permission, &payload).await.status, 429);
    assert_eq!(h.push(&development_permission.permission, &payload).await.status, 503);
    let mut too_large = payload.repeat(60);
    too_large.truncate(MAX_CIPHERTEXT + 1);
    assert_eq!(h.push(&android_permission.permission, &too_large).await.status, 413);
    h.google.answer(&android_token(1), 500, "INTERNAL", "INTERNAL");
    assert_eq!(h.push(&android_permission.permission, &payload).await.status, 503);
    h.apple.answer(&ios_token(2), 410, "Unregistered");
    assert_eq!(h.replace_token(&ios, json!({"token": ios_token(2)})).await.status, 204);
    h.clock.advance_s(60);
    assert_eq!(h.push(&ios_permission.permission, &payload).await.status, 404);
    assert_eq!(h.push(&format!("{}x", ios_permission.permission), &payload).await.status, 401);
    assert_eq!(h.call("POST", "/v1/devices", None, Some(payload.clone())).await.status, 400);
    h.cancel(&android, &android.secret, &android_permission.id).await;

    let log = h.log.text();
    // Not vacuous: the log saw all of it.
    for expected in ["delivered", "rate limited", "connect", "token gone", "429", "413", "503", "404"] {
        assert!(log.contains(expected), "expected {expected:?} in:\n{log}");
    }
    let secret_marker = String::from_utf8(payload.clone()).unwrap();
    let forbidden = [
        secret_marker.clone(),
        secret_marker[..12].to_string(),
        STANDARD.encode(&payload),
        STANDARD.encode(&too_large)[..40].to_string(),
        ios_token(1),
        ios_token(2),
        ios_token(3),
        android_token(1),
        ios.secret.clone(),
        android.secret.clone(),
        development.secret.clone(),
        ios_permission.permission.clone(),
        android_permission.permission.clone(),
        development_permission.permission.clone(),
    ];
    for secret in forbidden {
        assert!(!log.contains(&secret), "{secret:?} leaked into the log:\n{log}");
    }
    // Every permission's payload half, too: the signed part alone names a
    // Device and an expiry.
    for p in [&ios_permission, &android_permission, &development_permission] {
        let (signed, _) = p.permission.rsplit_once('.').unwrap();
        assert!(!log.contains(signed));
    }
}
