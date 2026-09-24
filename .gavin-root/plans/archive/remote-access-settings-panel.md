---
order: 21504
kind: task
title: Remote access: the Settings section — toggle, relay URL, Pair a device, device list, Revoke all
status: Done
parent: feat-remote-access-phase-2.md
complexity: complex
---
Third task of [feat-remote-access-phase-2](./feat-remote-access-phase-2.md), after [the handshake and its protocol](./remote-access-pairing-handshake.md); read that card, the two tasks before it and `docs/security/05-remote-access.md` §3 first. This is a rendered surface: build it with tests on the pure module plus a static pre-flight, and leave the visual check to the owner (CLAUDE.md).

**Host side** (`app/src-tauri`): commands for `BeginPairing`, `ConfirmPairing`, `RejectPairing`, `ListDevices`, `RevokeDevice`, `RevokeAllDevices` and `SetRemoteAccess`, registered in `lib.rs` (the `commandGate` test asserts the TS classification names every command `lib.rs` registers — add them there too) and routed through `session.rs`'s gated request path; the three pushes forwarded to the frontend as events, the way the `remote-link-*` events are.

**Frontend**: the logic in a plain module (`app/src/lib/core/remoteAccess.ts`, unit-tested), the `.svelte` a thin template over it, in the app-level Settings view (`GlobalSettingsView.svelte`, and the settings sections table so search finds it):

- **Remote access** toggle and a relay URL field → `SetRemoteAccess`. The section's own copy says that with no transport yet nothing listens or dials: "on" records the choice for a phone app that does not exist yet.
- **Pair a device** → `BeginPairing`; draw the QR from the payload as inline SVG (no CDN, and no new dependency unless a tiny pure-JS encoder is justified — say why in the commit), with the two-minute countdown; on `DevicePairingRequested` show the device name and the six-digit SAS with Confirm / Reject through `askConfirm` (buttons name the action, never "OK"; Reject keeps focus so Enter cannot confirm a code nobody compared).
- **Device list** from `ListDevices`: name, role, paired-at, last-seen; greyed with "re-pair to use" past ninety days; Revoke per row behind a `danger` confirm.
- **Revoke all devices** — a `danger` confirm whose text says it rotates the daemon key and every phone must pair again; the one-button answer to a lost phone, and the pairing dialog says so.
- **Gating**: every control above is a `featureBlockedReason` consumer of `FEATURE_MIN_VERSION.remoteAccess` — a greyed section naming the daemon version it needs, the way the other gated surfaces do. Without this the entry the handshake task added is a dead gate.

Tests: the module's state transitions (offer → requested → confirmed / rejected / expired), the gate copy, and a surfaces test that greps the committed source for the strings the section relies on (the pattern the `*Surfaces.test.ts` files use). `cd app && npm test && npm run check && npm run build`; `cargo test -p app`. Commit only the files you touched.
