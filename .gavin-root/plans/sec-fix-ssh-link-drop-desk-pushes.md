---
kind: task
title: "[sec] An ssh host's Relay, direct-listener and pairing pushes reach the desk's Remote-access and Devices screens as the local Workstation's own state"
status: To Do
priority: low
complexity: simple
labels: security, ready-for-agent
---
Fix a needs-validation lead from the 2026-10-15 security audit (run-1). It is not confirmed: the audit traced it in source but could not observe the desktop half (the Tauri relay thread and the Svelte listeners) run end to end; only the host daemon's half was observed. The failing regression test below is the proof — write it first and watch it fail. If it already passes before any change, the lead is wrong: record why under a dated "## Comments" heading and move the card to Done with no code change. Fingerprint: `ssh-link:remote-device-pushes-relayed-as-local-desk-state:app/src-tauri/src/session.rs/attach_and_relay`.

Full record: `NEEDS-VALIDATION.md` in `~/security-audit-skill/gavin/run-1/`, outside this repo. The audit card is `review-security-audit-2026-10-15.md`.

## What is wrong

An ssh workspace link opens two connections to the host's daemon through `gavin-daemon bridge` and presents both as role app with the banner's token. The streaming one says ConnectionKind::Push, so the host daemon registers it for device pushes. From then on the host's push_to_apps fan-out writes the link every RelayStateChanged, DirectStateChanged, DeskRelayStateChanged and DevicePairingRequested, plus DeviceConnected, DeviceDisconnected, DeviceRefusalChanged and DevicePresenceChanged. That was observed locally against a real host daemon through `gavin-daemon bridge --no-spawn`.

On the desktop the link's reader is the shared attach_and_relay with RelayOwner::Remote. Its match emits these pushes under the same Tauri event names the local daemon's relay uses, and never looks at `owner`. The Remote-access section of Settings and the shared devices stores replace the Relay, direct and desk-Relay state with the host's payload. The Devices panel hands the host's pairing request to the local pairing prompt. The design comment above the remote-access commands says the opposite must hold: these surfaces answer for the LOCAL daemon only, because "a wrong answer there is invisible". The request side keeps that rule (confirm_pairing uses the local CommandConnection); the push side does not.

Effects:

- With an honest host, toggling remote access on the host overwrites what the desk shows. The section does not re-read while it holds a value, so the desk can show remote access off or failed while it is on locally, or the reverse, until the local daemon next changes its own state.
- A hostile or compromised host daemon can write DevicePairingRequested whenever it likes. While a local QR offer is on screen, the first request to arrive takes the single first-wins slot in pairingRequested. The real phone's request is then ignored and the human is shown digits that match no phone. Confirming sends ConfirmPairing for an unknown device_id to the local daemon, which has no such pending handshake, so nothing is enrolled. The result is a denial of local pairing, not an enrolment.
- forwarding::emit also offers each of these events on the desk's forwarding connection, so a local Device listening for one of them would hear the host's state as this desk's.

No authority gain was found. The impact is the integrity of the security-status UI and a denial of local pairing.

## Root cause

attach_and_relay (app/src-tauri/src/session.rs) applies one push table to every RelayOwner. The desk-scoped device and remote-access pushes are not dropped when the owner is RelayOwner::Remote. A contributing cause: the link declares its streaming connection ConnectionKind::Push, which asks the host for device pushes the link has no use for.

## The invariant to enforce

The Remote-access and Devices surfaces show only the local daemon's state. A push that describes a daemon's own Relay dial, direct listener, desk Relay, pairing handshake or paired Devices is forwarded only from RelayOwner::Local. Pushes about a host's sessions and workspaces (trees, session owners, PTY size, browser frames and the rest) keep flowing from a link as they do today.

## Trace (lines as of 2026-10-16; re-read before editing)

- `app/src-tauri/src/session.rs:3370` (app_handshake_stream): The link's streaming connection says Hello role app with the banner token and ConnectionKind::Push. Reached through app_handshake_with_token (session.rs:3406) from remote::establish (remote.rs:196).
- `crates/daemon/src/server.rs:8139` (serve_connection Hello, on the host): role App plus takes_device_pushes (protocol lib.rs:2526, true for None and Push) registers the link with register_app_connection (server.rs:2601).
- `crates/daemon/src/server.rs:2249` (set_relay_state, and set_direct_state at 2268, set_desk_relay_state at 2289): Each pushes its state to every registered app connection; DevicePairingRequested is pushed the same way at 3493. push_to_apps (2869) has no notion of which connection is a desk sitting at that host and which is another machine's ssh link.
- `app/src-tauri/src/remote.rs:1161` (link attach): Calls attach_and_relay with RelayOwner::Remote { host, link_id }.
- `app/src-tauri/src/session.rs:5555` (attach_and_relay relay thread): DevicePairingRequested is emitted as device-pairing-requested. Lines 5565-5634 emit device-connected, device-disconnected, device-refusal-changed, device-presence-changed, relay-state-changed, direct-state-changed and desk-relay-state-changed the same way. `owner` is used only by RelayOwner::lost (enum at 5390).
- `app/src-tauri/src/forwarding.rs:228` (emit): Emits to every webview and also offers the event on the forwarding connection.
- `app/src/lib/core/GlobalSettingsView.svelte:638` (onMount listeners): relay-state-changed, direct-state-changed (642) and desk-relay-state-changed (648) replace the section's state. devicesState.ts:205-206 does the same for the shared relay and direct stores.
- `app/src/lib/core/DevicesPanel.svelte:112` (device-pairing-requested listener): Hands the payload to pairingRequested (remoteAccess.ts:187, first-wins from the offer phase) and askPairing.
- `app/src-tauri/src/session.rs:3443` (design comment above the remote-access commands): States that these requests and pushes must be the local daemon's and nothing else's.

## What the audit could not observe

- The desktop half was not built or run, so the display effect is traced in source only. The match arms carry no owner check, which leaves little doubt.
- The host half was observed: a sandboxed host daemon sent RelayStateChanged dialling, failed and not_wanted to a role-app Push connection opened through `gavin-daemon bridge --no-spawn`.
- A forged pairing push needs a hostile or compromised host daemon on an ssh host the human linked, arriving while a local QR offer is on screen.

## Fix

Drop the desk-scoped pushes in attach_and_relay when the owner is RelayOwner::Remote. Put the decision in a small pure function so it is testable without an AppHandle, for example `fn forwarded_from(owner: &RelayOwner, resp: &Response) -> bool`, true for every push from Local and false from Remote for DevicePairingRequested, DeviceConnected, DeviceDisconnected, DeviceRefusalChanged, DevicePresenceChanged, RelayStateChanged, DirectStateChanged and DeskRelayStateChanged. Have the relay loop `continue` when it is false.

Do not change the link's ConnectionKind to stop the pushes at the host. The same Push connection carries the host-session pushes the desk does need (SessionOwnerChanged, PtySizeBorrowed, SessionDeskInput, GavinTreeChanged), and the host daemon counts the link as a live app connection in other decisions. Narrowing that is a separate design question.

Regression tests, in session.rs's test module:

- `a_hosts_device_and_remote_access_pushes_are_not_forwarded`: for each of the eight variants, `forwarded_from(&RelayOwner::Remote { .. }, &resp)` is false, and `forwarded_from(&RelayOwner::Local, &resp)` is true.
- `a_hosts_session_pushes_are_still_forwarded`: GavinTreeChanged, SessionOwnerChanged and PtySizeBorrowed from Remote stay true.
- If the relay thread can be driven over a Stream pair with a mock app (the validation plan's shape), also assert that writing `{"type":"RelayStateChanged","state":{"state":"not_wanted"}}` and `{"type":"DevicePairingRequested","device_id":"d-host","name":"x","sas":"000000"}` from the fake host side emits neither relay-state-changed nor device-pairing-requested.

## Done when

- The fix enforces the invariant above at the last trusted decision point, not in a caller.
- The regression cases named in the fix are tests in the touched crate or module, and they fail before the change.
- The checks in CLAUDE.md pass for every part you touched.
- The regression test fails before the change and passes after it.
- Follow the CLAUDE.md traps that apply: a new SQLite column needs its own `ALTER TABLE`, a widened request needs a compat-gate entry, and you commit only your own files.
