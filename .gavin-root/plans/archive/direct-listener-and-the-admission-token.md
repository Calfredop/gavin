---
kind: task
title: Direct listener and the admission token
parent: companion-local-relay-and-direct-without-collision.md
---
Read the parent card, `companion-local-relay-and-direct-without-collision.md`: its "Decisions to settle first" notes, and the answer under "should the direct listener require the admission token (amends ADR 0009), or stay Noise-only?". If it is still unanswered, stop and say so. This covers the parent's §2.2, §2.3 and §2.4.

**If the answer is to stay Noise-only:** amend ADR 0009 (`docs/adr/0009-a-device-can-reach-its-workstation-directly.md`) with a considered option, "An admission token on the direct path". Record why it was rejected:
- The listener's `verdict` (`direct.rs`) already refuses any hello that does not name this Workstation's rendezvous id, a hash of the key the QR carries.
- The core sends an empty token to direct addresses on purpose (`companion-core` `pairing::dials`): a LAN address the Mac has since given up could belong to anyone.

Then tick §2.2 and §2.3 on the parent with a pointer to the ADR, tick §2.4 as "no wire change", and stop.

**If the token is required (either variant):**
- Amend ADR 0009 first, with the reasoning on the parent card.
- **Listener.** `verdict` compares the hello's token with the stored `relay_admission` in constant time whenever the desk holds one, and refuses a mismatch as `RefusalReason::Admission`. Before any state is touched, as the rest of `verdict` is. For the per-phone variant, the desk records which Devices were paired after the change.
- **Core.** Send the token on direct dials only once the shell checks the pin natively: the nested task "Companion shell: trust the direct listener's pinned certificate natively" under `companion-direct-listener.md`. Check whether it has landed. Until it has, sending the token to a direct address hands it to whoever holds that address.
- **QR and phone (§2.3).** The QR carries the token once, for both paths. The phone's `relayAdmission` (`app/companion-shell/src/shell/hub/paired.ts`) becomes the token for both, and `readRecord` keeps reading records saved before the change. Another session edited `paired.ts` for the long-press removal; if its changes are still uncommitted, merge with them and do not overwrite them.
- **Compat (§2.4).** The phone keeps pairing with a desk one version behind. A widened request needs a `PROTOCOL_VERSION` bump, a `FEATURE_MIN_VERSION` entry and a `featureBlockedReason` consumer on every surface that sends it (CLAUDE.md).
- **Tests.** In `crates/daemon/tests/device_wire.rs`, a Device connects direct with the token, is refused without it, and is refused with a wrong one.

Tick §2.2 to §2.4 on the parent when done.
