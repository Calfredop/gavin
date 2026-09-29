---
order: 30720
kind: task
title: Companion 31: confirming a pairing takes the desk's own confirmation
status: To Do
parent: companion.md
priority: high
complexity: moderate
---
Blocked by: companion-10-pair-through-relay.md. Must land before companion-12-daemon-forwards-commands.md gives the Remote role any reach.

Part of `companion.md`. Found while building ticket 10. Read `app/src-tauri/src/confirm_gate.rs`, `app/src/lib/guards/commandGate.test.ts` (the block on `confirm_pairing`) and `docs/security/05-remote-access.md` §3 first.

## The problem

`confirm_pairing` is an ordinary Tauri command: any script running in the app's own origin can invoke it. `commandGate.test.ts` records why that was acceptable in phase 2 — "phase 2 ships no transport at all, so today nothing can reach the state this command settles" — and says what would stand in the way once there was one: the six-digit code.

Ticket 10 shipped the transport, and the six-digit code only protects a confirmation that a human makes. A script in the page can now do the whole ceremony with nobody looking:

1. `set_remote_access(true, <a Relay it chose>, <a token it chose>)` — the daemon dials it.
2. `begin_pairing()` — the QR string, secret included, is returned to the script.
3. Hand that string to a Device of the attacker's, which pairs through the Relay.
4. Listen for `device-pairing-requested` and call `confirm_pairing(deviceId)`.

Today the row that results can do nothing: there is no connection handshake yet (ticket 11) and the Remote role refuses every request (until ticket 12). After ticket 12 it is full control of the Workstation.

The same script can read the Relay's admission token, because `begin_pairing` returns the QR string and the QR carries it. That is what the QR is for, so the token is not a secret from the page; ticket 10 closed the other route to it (a changed Relay URL forgets the stored token, so `set_remote_access` cannot redirect it to a listener of the script's).

## What to build

- Put `confirm_pairing` behind the confirmation gate, with the `device_id` AND the six digits as the subject, so a token minted for one pairing cannot confirm another.
- Decide, and record in `commandGate.test.ts`, whether `begin_pairing` and `set_remote_access` stay ordinary. `set_remote_access` choosing the Relay is step 1 above.
- `confirm_gate.rs` says plainly what it does not stop: a script that knows gavin can open and answer a confirmation itself, because the prompt is drawn by the page. Closing that needs the confirmation drawn by the host, in a surface the page cannot script. Say in the card's result whether pairing is the case that justifies building it; if it is not built here, file it.

## Acceptance criteria

- [ ] `confirm_pairing` without a token minted for that `device_id` and code is refused by the host (tested)
- [ ] `commandGate.test.ts` classifies `confirm_pairing` as gated, with the reasoning, and restates the reasoning for the commands left ordinary
- [ ] The Settings pairing flow still pairs the test Device (`crates/daemon/tests/device_wire.rs` is the daemon half; the app half is a static pre-flight)
- [ ] `docs/security/06-companion.md` (ticket 08) names this threat, or this card files the note for it
