# A Device holds two keys: a Noise key and a hardware key

The remote-access design (`docs/security/05-remote-access.md` §8) requires that a Device's key cannot be copied off the phone. It also fixes the channel as Noise over Curve25519 (`trust::NOISE_PARAMS`), and the iOS Secure Enclave only holds P-256 keys, so on iOS no single key can meet both requirements. We decided that each Device holds two keys:

- **The Noise static key (X25519)** encrypts and authenticates the channel. It is a software key kept in the platform keystore, marked as usable on this device only.
- **A hardware-bound P-256 key** proves the connection comes from the phone itself. It lives in the Secure Enclave on iOS, and in StrongBox, or failing that the TEE-backed Keystore, on Android. The Device registers it at pairing, and after every Noise handshake it signs the handshake hash with it. The daemon refuses the connection until that signature checks out against the key in the trust store.

A copied Noise key therefore gets an attacker nothing.

The hardware key signs only after the phone confirms the user is present, with a biometric or the phone's passcode. That makes it the enforcement of the Unlock (ADR 0004): no connection exists without an authentication since the Companion last came to the foreground. The phone's hardware enforces that, and the daemon verifies it.

One install holds one pair of keys for every Workstation it pairs with, so "Device" means the same install on every Workstation. Revoking a Device on one Workstation, and "Revoke all" rotating that Workstation's own key, leave the other Workstations untouched. Android handles keys the same way, even though its TEE can hold X25519, so that there is one code path and one trust-store shape.

## Considered options

- **The software Noise key alone.** §8 rejects it, because anyone with brief access to an unlocked phone can copy it.
- **Noise over P-256.** The Noise specification does not define it and `snow` does not implement it.

## Consequences

- The pairing payload gains the hardware public key.
- `devices.sqlite` gains a column for it. This needs an `ALTER TABLE ... ADD COLUMN` migration; changing `CREATE TABLE IF NOT EXISTS` alone would never reach an existing database.
- Phase 3 adds one message after the `IK` handshake: the signature over the handshake hash.
- The pairing format can change for free now, because no Device has ever paired over a real transport.
