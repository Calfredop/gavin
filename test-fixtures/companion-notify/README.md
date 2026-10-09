# Companion notifications, sealed and opened

`cases.json` is one table read by three suites:

- `crates/daemon/src/notify_crypto.rs` — the daemon's seal, the format every
  push carries. Each case that says what it was `sealed_from` is sealed again
  there with that nonce, and must come out as `c` byte for byte;
- `app/companion-shell/ios/App/NotificationService/NotifyOpen.swift` — the iOS
  Notification Service Extension's open, run over the table by
  `app/companion-shell/scripts/notify-fixture.sh` (macOS only: it needs
  `swiftc` and CryptoKit), which `app/companion-shell/src/shell/push/fixture.test.ts`
  runs;
- `app/companion-shell/src/shell/push/decrypt.test.ts` — `deepLinkFor` and
  `readNotifyLink`, where tapping a notification lands.

The seal and the open are two implementations of one format, in two
languages, and nothing but this file says they agree: a case added here is
asserted on every side.

Each case has the Workstation's notification `key` (hex) and `c`, the
ciphertext as the push's `c` field carries it (standard base64: nonce, then
ciphertext and tag). Then either `opens` — the counter, the issue time and the
JSON body the opener must read — or `refuse`, the name of the reason it must
give (`decrypt`, `truncated`, `version`, `malformed`). `link` is where a tap
lands, for the table's one `workstation`: a refusal lands on the hub.

`sealed_from` is optional: a `body` sealed as the daemon seals it, raw `json`
(with an optional `version`) put in the daemon's header and padding, or a raw
`plaintext_hex`. When the seal changes, the Rust test names each stale `c`
with the value it now seals to.
