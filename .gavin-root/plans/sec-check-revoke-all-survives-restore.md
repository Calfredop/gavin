---
kind: task
title: "[sec-check] Revoke all does not survive a restore of devices.sqlite: the rotated Workstation key and the revoked rows roll back together"
status: To Do
priority: low
complexity: moderate
labels: security, ready-for-human
---
Decide, then fix or close, a needs-validation lead from the 2026-10-15 security audit (run-1). It is not confirmed: the audit reproduced the rollback at the store level in a sandbox, but could not observe whether the owner's backups include the gavin data directory or whether such a restore ever follows a Revoke all. Fingerprint: `daemon-trust-static-key-colocated-with-device-rows-restore`.

Full record: `NEEDS-VALIDATION.md` in `~/security-audit-skill/gavin/run-1/`, outside this repo. The audit card is `review-security-audit-2026-10-15.md`.

## What is wrong

The design doc and three code comments say "Revoke all devices" cuts off every paired phone even if the trust store is later restored from a backup, because the Workstation's Noise static key rotates and each phone pinned the old one. But the daemon keeps that static key pair as `trust_meta` rows in the same `devices.sqlite` as the device rows. revoke_all_at marks the rows revoked and writes the new key pair into that same file. Restore a copy of `devices.sqlite` from before the revocation (a Time Machine or Migration Assistant restore of ~/Library/Application Support/gavin, or a manual copy) and the old private key and the unrevoked rows come back together; ensure_static_keypair keeps the restored key on open.

A sandboxed run showed this end to end at the store level (debug daemon at v75, scratch HOME, no network): the static public key changed from K0 to K1 on RevokeAllDevices, and after the backup was copied back, ListDevices showed the dummy device with revokedAt null and stale false, and the key was K0 again. A lost or stolen phone revoked through Revoke all can then complete its pinned IK handshake again and be admitted with the Remote role.

Three limits apply. The phone's hardware-key proof still needs the phone unlocked with its owner present (ADR 0004). The restored row must be under 90 days unseen (STALE_AFTER_DAYS). And the Relay dial or direct listener settings have to come back from the same restore. The design doc rejects `config.json` as the trust store because "a stale copy restored over a newer one is a silent re-pair of a revoked phone"; the chosen store has the same property for a restore of the whole file. Nothing in the repository excludes the directory from backup.

## Trace (lines as of 2026-10-16; re-read before editing)

- `crates/daemon/src/remote.rs:755` (serve_device): A Device stream from the Relay dial or the direct listener reaches the responder; the revoked phone still holds its pinned Workstation key and its own Noise key.
- `crates/daemon/src/pairing.rs:220` (ResponderKeys::from_store): The responder answers the IK handshake with whatever key pair `devices.sqlite` holds now.
- `crates/daemon/src/trust.rs:80` (META_PRIVATE_KEY / META_PUBLIC_KEY, 80-81): The static key pair is two `trust_meta` rows in the same file as the devices table.
- `crates/daemon/src/trust.rs:1047` (revoke_all_at): Sets revoked_at_us on every row and calls write_fresh_keypair (616) in the same database. Its doc comment (1034-1042) claims the rotation holds "even if the store is somehow restored from a backup".
- `crates/daemon/src/trust.rs:609` (ensure_static_keypair, called from TrustStore::open at 493 via line 540): Keeps any existing pair and mints one only if a half is missing. Nothing outside the file is consulted.
- `crates/daemon/src/trust.rs:1124` (admit → judge at 1158): Called from remote.rs:769. A restored row has revoked_at_us NULL, so it is Admitted while under 90 days unseen (is_stale_at, 294) and holding a hardware key.
- The same claim in `crates/daemon/src/server.rs:2171-2173` (RevokeAll::new_public_key) and `:3900-3907` (revoke_all_devices), and in `docs/security/05-remote-access.md:267-268`. The same section says the key "lives in the same file" (212) and rejects config.json for its restore behaviour (216-218); open question 10 (1097-1099) defers Keychain custody.

## What the audit could not observe

- Whether ~/Library/Application Support/gavin (or `%LOCALAPPDATA%\gavin`, or the Linux data directory) is in the owner's backups, and whether a restore of it happens after a Revoke all. That is the owner's configuration and lifecycle.
- A full IK handshake plus hardware proof by the test Device against the restored daemon with the K0 pin. The store-level rollback was observed; admission was traced.

## The decision

- [ ] Decision: How should Revoke all hold against a restore of devices.sqlite?
  Options: A) Anchor the rotation outside the file (an OS keystore item holding the current static public key or a rotation epoch), and refuse to serve Devices when the file disagrees with it. B) Exclude devices.sqlite from backups, so a restore brings back no trust store and every phone pairs again. C) Accept the residual, and correct the design doc and the code comments that claim otherwise.

## After the answer

- **A.** On macOS a generic-password Keychain item the daemon creates and reads without a prompt, holding the static public key (not secret, so there is no custody question; the private key stays in the file). Revoke all updates it after the file. On open, a file whose public key differs from the anchor is treated as a restore from before a rotation: the daemon refuses every Device until the owner re-pairs or explicitly adopts the file's key from the desk. Both daemons share the store, so both read the same item. Linux and Windows need their own anchor (Secret Service may be absent on an ssh host; DPAPI or Credential Manager on Windows); say per OS what holds. Write down the limit: the login keychain is itself in a full-system Time Machine backup, so A covers a restore of the gavin folder or the file, not a restore of the whole account. Regression test in trust.rs, with the anchor behind a trait so the test supplies one: open, revoke_all, copy the pre-revocation file back, reopen, and expect admit to refuse the restored row. It fails today.
- **B.** Mark `devices.sqlite` excluded from backup on every open (macOS: `NSURLIsExcludedFromBackupKey` or the sticky `com.apple.metadata:com_apple_backup_excludeItem` attribute `tmutil addexclusion` sets; it does not need to cover the other databases). Windows and Linux have no standard mark; say so. A restore then yields a fresh store: every Device pairs again, which is the safe direction. It does not stop a manual copy or a direct Mac-to-Mac migration, so the comments still need C's correction for those. Regression test: a macOS-only test that the file carries the exclusion after TrustStore::open.
- **C.** Replace the claim in `docs/security/05-remote-access.md:267-268`, `trust.rs:1034-1042`, and `server.rs:2171-2173` and `:3900-3907` with what is true, and add the residual to 05 §3: "Revoke all rotates the Workstation's static key inside devices.sqlite, the same file as the Device rows. Restoring a copy of that file from before the Revoke all brings back the old key and the unrevoked rows together, and a revoked phone that is unlocked by its owner can connect again for up to 90 days after it was last seen. After restoring the gavin data folder from a backup, run Revoke all again."

## Done when

- The decision above is ticked, with the chosen option and the reason under a dated "## Comments" heading.
- For A or B: the regression case named for that option is a test in `crates/daemon`, it fails before the change and passes after it, and the checks in CLAUDE.md pass for every part you touched.
- Whatever the option, no doc or comment still says the rotation survives a restore it does not survive.
- You commit only your own files.
