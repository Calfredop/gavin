use crate::{noise, CoreError, Entropy};

/// The Device's Noise static key pair (ADR 0001): an X25519 key that
/// encrypts and authenticates the channel.
///
/// One pair per install, shared by every Workstation the Device pairs
/// with, so "my iPhone" is the same Device on each of them. The core
/// generates it and hands it back; keeping it -- in the platform
/// keystore, usable on this device only -- is the shell's.
///
/// This is one of the Device's two keys. The other, the hardware-bound
/// P-256 key that signs each connection, never enters this crate: it
/// cannot leave the hardware that holds it.
#[derive(Clone, PartialEq, Eq)]
pub struct DeviceKeys {
    pub private: Vec<u8>,
    pub public: Vec<u8>,
}

impl DeviceKeys {
    /// A fresh key pair, drawn from `entropy`.
    pub fn generate(entropy: Entropy) -> Result<Self, CoreError> {
        let keypair = noise::builder(noise::pairing_params()?, entropy)
            .generate_keypair()
            .map_err(noise::handshake_error)?;
        Ok(Self { private: keypair.private.clone(), public: keypair.public.clone() })
    }

    /// The key pair for a private key the shell kept.
    pub fn from_private(private: &[u8]) -> Result<Self, CoreError> {
        Ok(Self { private: private.to_vec(), public: noise::public_key_for(private)? })
    }
}

impl Drop for DeviceKeys {
    fn drop(&mut self) {
        self.private.fill(0);
    }
}

/// The public half only.
impl std::fmt::Debug for DeviceKeys {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DeviceKeys")
            .field("public", &protocol::hex_encode(&self.public))
            .finish_non_exhaustive()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_key_pair_is_thirty_two_bytes_each_and_comes_from_the_entropy() {
        let a = DeviceKeys::generate(Entropy::from_bytes(vec![1; 32])).unwrap();
        let b = DeviceKeys::generate(Entropy::from_bytes(vec![2; 32])).unwrap();
        assert_eq!(a.private.len(), 32);
        assert_eq!(a.public.len(), 32);
        assert_ne!(a.public, a.private);
        assert_ne!(a.public, b.public, "different entropy must give a different key");
        assert_eq!(
            a,
            DeviceKeys::generate(Entropy::from_bytes(vec![1; 32])).unwrap(),
            "and the same entropy the same key"
        );
    }

    /// RFC 7748 §6.1's first test vector: a private key and the public
    /// key it must produce. What this pins is that the core's keys are
    /// X25519 keys the daemon's `snow` reads the same way.
    #[test]
    fn a_kept_private_key_gives_back_its_public_key() {
        let private = protocol::hex_decode(
            "77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a",
        )
        .unwrap();
        let keys = DeviceKeys::from_private(&private).unwrap();
        assert_eq!(
            protocol::hex_encode(&keys.public),
            "8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a"
        );

        let generated = DeviceKeys::generate(Entropy::from_bytes(vec![7; 32])).unwrap();
        assert_eq!(DeviceKeys::from_private(&generated.private).unwrap(), generated);
    }

    #[test]
    fn a_key_of_the_wrong_length_is_refused() {
        assert!(matches!(DeviceKeys::from_private(&[1; 31]), Err(CoreError::Offer(_))));
    }

    #[test]
    fn entropy_that_runs_out_is_an_error_not_a_weak_key() {
        assert_eq!(
            DeviceKeys::generate(Entropy::from_bytes(vec![1; 31])),
            Err(CoreError::Entropy)
        );
        assert_eq!(DeviceKeys::generate(Entropy::from_bytes(Vec::new())), Err(CoreError::Entropy));
    }

    #[test]
    fn a_key_pair_does_not_print_its_private_half() {
        let keys = DeviceKeys::generate(Entropy::from_bytes(vec![5; 32])).unwrap();
        let shown = format!("{keys:?}");
        assert!(shown.contains(&protocol::hex_encode(&keys.public)), "{shown}");
        assert!(!shown.contains(&protocol::hex_encode(&keys.private)), "{shown}");
        assert!(!shown.contains("private"), "{shown}");
    }
}
