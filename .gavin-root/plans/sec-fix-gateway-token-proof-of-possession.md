---
kind: task
title: "[sec] Unauthenticated Push gateway registration of a known push token deletes the victim Device and cancels all its Workstations' permissions"
status: To Do
priority: low
complexity: complex
---
Fix a low-severity finding from the 2026-10-15 security audit (run-1). Fingerprint: `push-gateway:store.rs:retire_token_holders:unauthenticated-token-claim-evicts-device`.

Full record: `findings.json` in `~/security-audit-skill/gavin/run-1/`, outside this repo. The audit card is `review-security-audit-2026-10-15.md`.

## What is wrong

POST /v1/devices requires no credential. If the posted APNs/FCM token matches one another Device holds, Store::insert_device deletes that Device, and the delete cascades to every send permission it minted. Each of the victim's Workstations then gets 401 permission_cancelled, and its daemon drops the stored permission. The victim's own device secret now gets device_unauthorized. The attacker's new Device owns the token, so permissions the attacker mints deliver to the victim's phone. The phone cannot decrypt them, so its Notification Service Extension shows the fixed placeholder. The victim recovers only when the shell next runs registerToken, gets device_unauthorized and registers again (which evicts the attacker in turn). It then has to hand new permissions to every Workstation. The attacker can repeat the claim at will. An attacker-owned Device reaches the same deletion through the authenticated PUT /v1/devices/{id}/token by naming the victim's token.

## Root cause

Two paths call retire_token_holders (store.rs:273-279), which runs DELETE FROM devices WHERE platform=?1 AND token=?2 AND id != ?3. Neither path has proof that the caller holds the token. The first is the unauthenticated register path (gateway.rs:118-127 -> store.rs:131-134). The second is replace_token, which authenticates only the caller's own Device (gateway.rs:131-145 -> store.rs:179-182). Before the delete, the only checks are that the sender supports the platform and the token's shape, with iOS hex lowercased (gateway.rs:255-283). The design assumes the only party that presents an existing token is a reinstall on the same phone (store.rs:128-130; docs/push-gateway.md:48-51). Nothing enforces that assumption, and a push token is an identifier, not a secret.

## The invariant to enforce

Only a party that proves authority over a Device can remove its registration and permissions. That proof is its device secret, or proof that it holds the push token, such as echoing a nonce delivered by a verification push. A new registration must not displace the existing holder until it proves it holds the token.

## Trace (lines as of 2026-10-16; re-read before editing)

- `crates/push-gateway/src/http.rs:25` (router): POST /v1/devices is routed to register with no authentication layer. The only layers are request logging and a 16 KiB body limit.
- `crates/push-gateway/src/http.rs:58` (register): The body's platform, token and environment are passed straight to Gateway::register. No Authorization header is read.
- `crates/push-gateway/src/gateway.rs:120` (Gateway::register): registration() (lines 255-283) checks only that the sender supports the platform and the token's shape. It lowercases iOS hex, so 'AB..' and 'ab..' are the same token.
- `crates/push-gateway/src/store.rs:134` (Store::insert_device): retire_token_holders runs inside the insert transaction, before the new row is inserted.
- `crates/push-gateway/src/store.rs:275` (retire_token_holders): DELETE FROM devices WHERE platform = ?1 AND token = ?2 AND id != ?3 removes the victim's row. ON DELETE CASCADE (store.rs:118, with foreign_keys ON at store.rs:104) removes every permission it minted.
- `crates/push-gateway/src/gateway.rs:192` (Gateway::push): Pushes from the victim's Workstations now find no permission row and are refused with permission_cancelled.
- `crates/daemon/src/server.rs:3772` (SessionManager::push_companion_notify): map_reply turns permission_cancelled into DropPermission (companion_push.rs:202-203), and the daemon calls trust.clear_send_permission. That Workstation stays silent until the phone hands it a new permission.

## Fix

Stop letting an unproven claim displace an existing token holder. Hold a new registration, or a replaced token, as pending, and send a verification push carrying a random nonce to that token. Retire the other holders only after the new Device echoes the nonce, authenticated with its own new secret. Until then the pending row holds no deliverable token, and the existing holder keeps delivering. As a minimum interim fix, stop cascade-deleting: clear the old holder's token (as clear_token already does) and keep its row and permissions. Its next PUT /token then restores delivery with no new hand-overs to its Workstations. Add an api.rs regression test asserting that registering a token another Device holds, without proof, leaves that Device's permissions answering 202. The same rule applies to the authenticated replace_token path.

`crates/push-gateway/src/store.rs`, as a sketch only:

```
// insert_device / replace_token: do not delete other holders on an unproven claim.
// Store the claimed token in a `pending_token` column (plus a `token_nonce_hash`),
// leave `token` NULL until `confirm_token(id, nonce)` succeeds, and only then:
fn retire_token_holders(tx: &rusqlite::Transaction, keep: Id, reg: &Registration) -> Result<()> {
    // Proven claim only: called from confirm_token, never from insert_device/replace_token.
    tx.execute(
        "UPDATE devices SET token = NULL WHERE platform = ?1 AND token = ?2 AND id != ?3",
        params![reg.platform.as_str(), reg.token, keep.to_string()],
    )?;
    Ok(())
}
// plus, in Store::init beside CREATE TABLE (an existing database needs the ALTERs, duplicate-column errors swallowed):
// ALTER TABLE devices ADD COLUMN pending_token TEXT; ALTER TABLE devices ADD COLUMN token_nonce_hash BLOB;
```

## Done when

- The fix enforces the invariant above at the last trusted decision point, not in a caller.
- The regression cases named in the fix are tests in the touched crate or module, and they fail before the change.
- The checks in CLAUDE.md pass for every part you touched.
- The audit reproduction no longer works. It is the record's `execution` field in `findings.json`.
- Follow the CLAUDE.md traps that apply: a new SQLite column needs its own `ALTER TABLE`, a widened request needs a compat-gate entry, and you commit only your own files.
