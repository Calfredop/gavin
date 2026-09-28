# One Unlock gives full control; only managing Devices stays at the desk

`docs/security/05-remote-access.md` rests on one promise: the Remote role cannot start anything. Typing needed a per-session grant issued at the desk, and running a card was left for a later design. We dropped that promise.

A Device that holds an Unlock may do everything the Workstation's desktop app can do: read, type into any session, run cards, start rails, configure and destroy. The one exception is Trust (pairing, revoking Devices, remote-access settings), which stays on the Workstation. The model is a laptop's: authenticate once, then work, until the lid closes.

- **The Unlock is one biometric or the phone's passcode.**
- **It lasts until the Companion goes to the background or the phone locks.** Brief interruptions, such as Control Center or a call banner, do not end it.
- **It is enforced per connection.** The Device's hardware key signs only after user presence (ADR 0001), the daemon verifies that signature, and the Companion drops its connections when the Unlock ends.

## Considered options

- **Phase 5 as designed.** Desk-issued typing grants and no remote starts. Rejected, because the reason to reach for the phone is to act on something while away from the desk.
- **Banking-app confirmation.** One Unlock for reading and light writes, plus a fresh authentication for each start, configure or destroy. Rejected as friction: the human wanted a laptop's model, not a payment flow's.

## Consequences

- A phone taken while unlocked, with the Companion in the foreground, has full control until it locks or the app is backgrounded.
- Because the passcode is an accepted fallback, anyone who knows the phone's passcode can Unlock.
- Pairing requires a hardware keystore and a set phone passcode.
- The §6 capability table and the phase 4/5 split in `05-remote-access.md` no longer describe the design (see also ADR 0003).
