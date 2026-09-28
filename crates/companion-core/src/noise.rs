//! `snow`, wired to randomness the caller supplied.
//!
//! snow asks a resolver for its primitives and for its random source. The
//! primitives are snow's own pure-Rust ones. The random source is the
//! `Entropy` a caller handed in: this crate is built without snow's
//! `use-getrandom`, so there is no other for it to fall back to.

use crate::{CoreError, Entropy};
use snow::params::{CipherChoice, DHChoice, HashChoice, NoiseParams};
use snow::resolvers::{CryptoResolver, DefaultResolver};
use snow::types::{Cipher, Dh, Hash, Random};
use std::sync::Mutex;

struct PoolRandom(Entropy);

impl Random for PoolRandom {
    fn try_fill_bytes(&mut self, dest: &mut [u8]) -> Result<(), snow::Error> {
        self.0.take(dest).map_err(|_| snow::Error::Rng)
    }
}

/// Hands the pool to the first thing that asks and nothing to the
/// second: a handshake draws from one random source, and a pool shared by
/// two would be one whose bytes each could not account for.
struct HostResolver {
    entropy: Mutex<Option<Entropy>>,
}

impl CryptoResolver for HostResolver {
    fn resolve_rng(&self) -> Option<Box<dyn Random>> {
        let entropy = self.entropy.lock().ok()?.take()?;
        Some(Box::new(PoolRandom(entropy)))
    }

    fn resolve_dh(&self, choice: &DHChoice) -> Option<Box<dyn Dh>> {
        DefaultResolver.resolve_dh(choice)
    }

    fn resolve_hash(&self, choice: &HashChoice) -> Option<Box<dyn Hash>> {
        DefaultResolver.resolve_hash(choice)
    }

    fn resolve_cipher(&self, choice: &CipherChoice) -> Option<Box<dyn Cipher>> {
        DefaultResolver.resolve_cipher(choice)
    }
}

pub(crate) fn pairing_params() -> Result<NoiseParams, CoreError> {
    protocol::PAIRING_NOISE_PARAMS
        .parse()
        .map_err(|e| CoreError::Handshake(format!("bad Noise parameters: {e:?}")))
}

/// A builder for `params` whose only random source is `entropy`.
pub(crate) fn builder<'a>(params: NoiseParams, entropy: Entropy) -> snow::Builder<'a> {
    snow::Builder::with_resolver(
        params,
        Box::new(HostResolver { entropy: Mutex::new(Some(entropy)) }),
    )
}

/// The public half of an X25519 private key.
pub(crate) fn public_key_for(private: &[u8]) -> Result<Vec<u8>, CoreError> {
    let params = pairing_params()?;
    let mut dh = DefaultResolver
        .resolve_dh(&params.dh)
        .ok_or_else(|| CoreError::Handshake("no X25519 implementation".into()))?;
    if private.len() != dh.priv_len() {
        return Err(CoreError::Offer(format!(
            "a Device key is {} bytes, not {}",
            dh.priv_len(),
            private.len()
        )));
    }
    dh.set(private);
    Ok(dh.pubkey().to_vec())
}

/// How a snow error is said. Through `Debug`, because without snow's
/// `std` feature -- the WASM build -- its `Error` is not a
/// `std::error::Error`.
pub(crate) fn handshake_error(e: snow::Error) -> CoreError {
    match e {
        snow::Error::Rng => CoreError::Entropy,
        other => CoreError::Handshake(format!("{other:?}")),
    }
}
