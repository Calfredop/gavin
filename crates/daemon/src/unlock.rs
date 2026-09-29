//! The Device's proof: what the daemon checks after every handshake.
//!
//! ADR 0001 gives a Device two keys. Its Noise key runs the handshake and
//! is software, because the hardware a phone has cannot hold one. Its
//! hardware key is P-256, cannot be copied off the phone, and signs only
//! while the phone is unlocked and its owner has been present -- so a
//! signature by it, over this handshake, is what says the phone itself is
//! on the other end and that someone unlocked it (ADR 0004). A copy of
//! the Noise key, on its own, completes a handshake and gets no further.
//!
//! **The daemon verifies and nothing else does.** A Companion that has
//! been tampered with can skip its own checks; it cannot make the
//! hardware sign, and it cannot make this function return `Ok`.
//!
//! **What is verified** is ECDSA over SHA-256 of
//! `device_wire::unlock_message(handshake hash)`, the signature in ASN.1
//! DER and the key as an uncompressed SEC1 point: what iOS's
//! `ecdsaSignatureMessageX962SHA256` and Android's `SHA256withECDSA`
//! produce (`docs/research/2026-09-28-companion-device-keys.md`). `ring`
//! does the arithmetic, and is in the daemon already under the TLS that
//! carries the dial to the Relay.

use protocol::device_wire::{self, UnlockProof, HARDWARE_KEY_BYTES};
use ring::signature::{UnparsedPublicKey, ECDSA_P256_SHA256_ASN1};

/// The longest signature read. A DER signature over P-256 is at most 72
/// bytes; anything longer is not one, and is not handed to the verifier
/// to find that out.
const MAX_SIGNATURE_BYTES: usize = 80;

/// Whether `key` has the shape of a hardware public key. Whether it is a
/// point on the curve is the verifier's to say, and it says so by
/// refusing every signature made with one that is not.
fn checked_key(key: &[u8]) -> anyhow::Result<()> {
    if key.len() != HARDWARE_KEY_BYTES || key[0] != 0x04 {
        anyhow::bail!(
            "gavin-daemon: a hardware key is the {HARDWARE_KEY_BYTES} bytes of an uncompressed \
             P-256 point, and this one is {} bytes",
            key.len()
        );
    }
    Ok(())
}

/// Whether `signature` is `hardware_key`'s, over the handshake whose hash
/// is `handshake_hash`.
pub fn verify(hardware_key: &[u8], handshake_hash: &[u8], signature: &[u8]) -> anyhow::Result<()> {
    checked_key(hardware_key)?;
    if signature.is_empty() || signature.len() > MAX_SIGNATURE_BYTES {
        anyhow::bail!("gavin-daemon: the device's signature is not one");
    }
    UnparsedPublicKey::new(&ECDSA_P256_SHA256_ASN1, hardware_key)
        .verify(&device_wire::unlock_message(handshake_hash), signature)
        .map_err(|_| {
            anyhow::anyhow!(
                "gavin-daemon: the device's signature does not verify against its hardware key"
            )
        })
}

fn read(payload: &[u8]) -> anyhow::Result<(UnlockProof, Vec<u8>)> {
    let proof = UnlockProof::from_bytes(payload)
        .map_err(|_| anyhow::anyhow!("gavin-daemon: the device sent no proof of its hardware key"))?;
    let signature = protocol::hex_decode(&proof.signature)
        .map_err(|_| anyhow::anyhow!("gavin-daemon: the device's signature is not one"))?;
    Ok((proof, signature))
}

/// A pairing's proof: the hardware key the Device is registering, once
/// the Device has shown it holds it.
///
/// The signature is checked against the key the proof itself carries.
/// That proves nothing about whose key it is -- the human comparing six
/// digits is what ties this handshake to the phone in their hand -- and
/// everything about whether the key can be used: a key that does not
/// parse, or that the Device cannot sign with, is refused here, before
/// the desk is asked about a Device that could never connect.
pub fn registering(payload: &[u8], handshake_hash: &[u8]) -> anyhow::Result<Vec<u8>> {
    let (proof, signature) = read(payload)?;
    let key = proof
        .hardware_key
        .as_deref()
        .ok_or_else(|| anyhow::anyhow!("gavin-daemon: the device registered no hardware key"))?;
    let key = protocol::hex_decode(key)
        .map_err(|_| anyhow::anyhow!("gavin-daemon: the device's hardware key is not hex"))?;
    verify(&key, handshake_hash, &signature)?;
    Ok(key)
}

/// A connection's proof, against the key the Device registered when it
/// paired.
///
/// A key the proof brought with it is not looked at. What a connection
/// is judged against is the trust store's row, which a human confirmed;
/// a connection that could name its own key would be judged against
/// whatever it liked.
pub fn connecting(payload: &[u8], handshake_hash: &[u8], registered: &[u8]) -> anyhow::Result<()> {
    let (_, signature) = read(payload)?;
    verify(registered, handshake_hash, &signature)
}

/// A P-256 key in memory and what it signs, for the tests that stand in
/// for a Device.
#[cfg(test)]
pub(crate) mod testing {
    use ring::signature::{EcdsaKeyPair, KeyPair, ECDSA_P256_SHA256_ASN1_SIGNING};

    pub(crate) struct HardwareKey {
        pair: EcdsaKeyPair,
    }

    impl HardwareKey {
        pub(crate) fn generate() -> Self {
            let rng = ring::rand::SystemRandom::new();
            let pkcs8 =
                EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_ASN1_SIGNING, &rng).unwrap();
            let pair =
                EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_ASN1_SIGNING, pkcs8.as_ref(), &rng)
                    .unwrap();
            Self { pair }
        }

        pub(crate) fn public(&self) -> Vec<u8> {
            self.pair.public_key().as_ref().to_vec()
        }

        /// The signature over the handshake whose hash is `hash`.
        pub(crate) fn sign(&self, hash: &[u8]) -> Vec<u8> {
            self.sign_message(&protocol::device_wire::unlock_message(hash))
        }

        /// The signature over `message` as it stands: what the hardware
        /// does with what the Companion core hands it.
        pub(crate) fn sign_message(&self, message: &[u8]) -> Vec<u8> {
            let rng = ring::rand::SystemRandom::new();
            self.pair.sign(&rng, message).unwrap().as_ref().to_vec()
        }

        /// The proof a Device sends when it pairs.
        pub(crate) fn registering(&self, hash: &[u8]) -> Vec<u8> {
            protocol::device_wire::UnlockProof {
                signature: protocol::hex_encode(&self.sign(hash)),
                hardware_key: Some(protocol::hex_encode(&self.public())),
            }
            .to_bytes()
        }

        /// The proof a Device sends when it connects.
        pub(crate) fn connecting(&self, hash: &[u8]) -> Vec<u8> {
            protocol::device_wire::UnlockProof {
                signature: protocol::hex_encode(&self.sign(hash)),
                hardware_key: None,
            }
            .to_bytes()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::testing::HardwareKey;
    use super::*;

    const HASH: [u8; 32] = [0x5a; 32];

    #[test]
    fn a_signature_by_the_registered_key_verifies() {
        let key = HardwareKey::generate();
        assert_eq!(key.public().len(), HARDWARE_KEY_BYTES);
        verify(&key.public(), &HASH, &key.sign(&HASH)).unwrap();
        // ECDSA is randomised: a second signature is another signature,
        // and verifies as well.
        assert_ne!(key.sign(&HASH), key.sign(&HASH));
        verify(&key.public(), &HASH, &key.sign(&HASH)).unwrap();
    }

    /// A copy of the Noise key on another phone: that phone has a
    /// hardware key, and it is not the one that was registered.
    #[test]
    fn a_signature_by_another_key_is_refused() {
        let registered = HardwareKey::generate();
        let another = HardwareKey::generate();
        let err = verify(&registered.public(), &HASH, &another.sign(&HASH)).unwrap_err();
        assert!(err.to_string().contains("does not verify"), "{err}");
    }

    /// A signature recorded from one connection and sent on another.
    #[test]
    fn a_signature_over_another_handshake_is_refused() {
        let key = HardwareKey::generate();
        let recorded = key.sign(&[0x5b; 32]);
        assert!(verify(&key.public(), &HASH, &recorded).is_err());
    }

    /// The key signs the handshake hash under this wire's own prefix.
    /// A signature the same key made over the bare hash -- for something
    /// else that asked it to -- is not a proof.
    #[test]
    fn a_signature_over_the_bare_hash_is_refused() {
        use ring::signature::{EcdsaKeyPair, KeyPair, ECDSA_P256_SHA256_ASN1_SIGNING};
        let rng = ring::rand::SystemRandom::new();
        let pkcs8 = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_ASN1_SIGNING, &rng).unwrap();
        let pair =
            EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_ASN1_SIGNING, pkcs8.as_ref(), &rng)
                .unwrap();
        let bare = pair.sign(&rng, &HASH).unwrap();
        assert!(verify(pair.public_key().as_ref(), &HASH, bare.as_ref()).is_err());
    }

    #[test]
    fn a_signature_altered_or_cut_short_is_refused() {
        let key = HardwareKey::generate();
        let signature = key.sign(&HASH);
        for at in [0usize, 5, signature.len() - 1] {
            let mut altered = signature.clone();
            altered[at] ^= 0x01;
            assert!(verify(&key.public(), &HASH, &altered).is_err(), "altered at byte {at}");
        }
        assert!(verify(&key.public(), &HASH, &signature[..signature.len() - 1]).is_err());
        assert!(verify(&key.public(), &HASH, &[]).is_err());
        assert!(verify(&key.public(), &HASH, &vec![0x30; MAX_SIGNATURE_BYTES + 1]).is_err());
    }

    #[test]
    fn a_key_that_is_not_a_point_is_refused() {
        let key = HardwareKey::generate();
        let signature = key.sign(&HASH);

        // The right shape, and not on the curve.
        let mut off_curve = key.public();
        off_curve[64] ^= 0x01;
        assert!(verify(&off_curve, &HASH, &signature).is_err());

        // Not the right shape at all.
        let mut compressed = vec![0x02];
        compressed.extend_from_slice(&key.public()[1..33]);
        for wrong in [Vec::new(), compressed, key.public()[..64].to_vec(), vec![0x04; 66]] {
            let err = verify(&wrong, &HASH, &signature).unwrap_err();
            assert!(err.to_string().contains("uncompressed"), "{err}");
        }
    }

    #[test]
    fn a_pairing_registers_the_key_it_proves() {
        let key = HardwareKey::generate();
        assert_eq!(registering(&key.registering(&HASH), &HASH).unwrap(), key.public());
    }

    #[test]
    fn a_pairing_that_names_no_key_or_proves_another_is_refused() {
        let key = HardwareKey::generate();
        let another = HardwareKey::generate();

        let err = registering(&key.connecting(&HASH), &HASH).unwrap_err();
        assert!(err.to_string().contains("registered no hardware key"), "{err}");

        // A key the Device does not hold: someone else's public key,
        // under a signature of the Device's own.
        let claimed = UnlockProof {
            signature: protocol::hex_encode(&key.sign(&HASH)),
            hardware_key: Some(protocol::hex_encode(&another.public())),
        };
        assert!(registering(&claimed.to_bytes(), &HASH).is_err());

        let unreadable = UnlockProof {
            signature: protocol::hex_encode(&key.sign(&HASH)),
            hardware_key: Some("not hex".into()),
        };
        assert!(registering(&unreadable.to_bytes(), &HASH).is_err());
    }

    /// A Device that skipped the proof and sent its first request in the
    /// proof's place.
    #[test]
    fn what_is_not_a_proof_is_refused_by_name() {
        let key = HardwareKey::generate();
        for payload in [&b""[..], b"not json", br#"{"type":"ListSessions"}"#] {
            for err in [
                registering(payload, &HASH).unwrap_err(),
                connecting(payload, &HASH, &key.public()).unwrap_err(),
            ] {
                assert!(err.to_string().contains("sent no proof"), "{err}");
            }
        }
        let unsigned = br#"{"signature":"zz"}"#;
        assert!(connecting(unsigned, &HASH, &key.public()).is_err());
    }

    #[test]
    fn a_connection_is_judged_against_the_registered_key() {
        let registered = HardwareKey::generate();
        connecting(&registered.connecting(&HASH), &HASH, &registered.public()).unwrap();

        // A connection that names a key of its own, and signs with it:
        // what it names is not what it is judged against.
        let another = HardwareKey::generate();
        assert!(connecting(&another.registering(&HASH), &HASH, &registered.public()).is_err());
        // Naming one does no harm to a proof that is otherwise good.
        connecting(&registered.registering(&HASH), &HASH, &registered.public()).unwrap();
    }
}
