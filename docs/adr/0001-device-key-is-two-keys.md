# A Device holds two keys: a Noise key and a hardware key

The remote-access design (`docs/security/05-remote-access.md` §8) requires that a Device's key cannot be copied off the phone. It also fixes the channel as Noise over Curve25519 (`trust::NOISE_PARAMS`), and the iOS Secure Enclave only holds P-256 keys, so on iOS no single key can meet both requirements. We decided that each Device holds two keys:

- **The Noise static key (X25519)** encrypts and authenticates the channel. It is a software key kept in the platform keystore, marked as usable on this device only.
- **A hardware-bound P-256 key** proves the connection comes from the phone itself. It lives in the Secure Enclave on iOS, and in StrongBox, or failing that the TEE-backed Keystore, on Android. The Device registers it at pairing, and after every Noise handshake it signs the handshake hash with it. The daemon refuses the connection until that signature checks out against the key in the trust store.

A copied Noise key therefore gets an attacker nothing.

The hardware key signs only after the phone confirms the user is present, with a biometric or the phone's passcode, and never while the phone is locked. That makes it the enforcement of the Unlock (ADR 0004), in two halves:

- **The hardware half.** The phone's hardware guarantees that every connection follows a recent authentication. On iOS that is the authentication held in the context the shell keeps from its Unlock. On Android it is any authentication on the phone within the key's auth window, and unlocking the lock screen also opens that window.
- **The shell's half.** "Since the Companion last came to the foreground" is not something either platform's hardware can know. The shell supplies it by dropping that context, or forgetting that window, when it goes to the background.

The daemon verifies the signature. Code running inside the Companion on an unlocked phone could skip the shell's half, but not the hardware's. The exact key parameters are in `docs/research/2026-09-28-companion-device-keys.md`.

One install holds one pair of keys for every Workstation it pairs with, so "Device" means the same install on every Workstation. Revoking a Device on one Workstation, and "Revoke all" rotating that Workstation's own key, leave the other Workstations untouched. Android handles keys the same way, even though its TEE can hold X25519, so that there is one code path and one trust-store shape.

## Considered options

- **The software Noise key alone.** §8 rejects it, because anyone with brief access to an unlocked phone can copy it.
- **Noise over P-256.** The Noise specification does not define it and `snow` does not implement it.
- **One hardware signature per Unlock, certifying an in-memory session key that signs each connection.** Rejected: code in the app could copy that key and connect from anywhere until it expired, whereas a hardware signature is only ever made on the phone.

## Consequences

- The pairing payload gains the hardware public key.
- `devices.sqlite` gains a column for it. This needs an `ALTER TABLE ... ADD COLUMN` migration; changing `CREATE TABLE IF NOT EXISTS` alone would never reach an existing database.
- Phase 3 adds one message after the `IK` handshake: the signature over the handshake hash.
- **The pairing code covers the handshake, not the keys.** The six digits are derived from the pairing handshake's hash (`protocol::pairing_sas`, v2), so a pairing made with a copy of the Noise key shows other digits than the owner's phone does, whichever hardware key it registers. Registering the hardware key at pairing is only as strong as the human's comparison, and that comparison has to be of something an attacker with the Noise key cannot reproduce. The Device also shows its code only after the Workstation acknowledges its proof (`PairingAck`), and the desk says when a pairing is for a Device it already trusts.
- The pairing format can change for free now, because no Device has ever paired over a real transport.
- **On Android, pairing also sends the hardware key's attestation chain.** A release daemon refuses a key unless it attests TEE or StrongBox under Google's hardware roots. iOS offers no attestation for such a key, so there the daemon relies on the shell's claim.
- **iOS keeps keychain items across an uninstall.** The shell therefore deletes its keys on its first launch; otherwise a reinstall would silently be the old Device.
- **No Simulator or emulator can hold a presence-gated hardware key.** Debug builds use a software key marked as such, and only a debug daemon accepts it.
