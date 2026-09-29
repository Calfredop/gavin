use crate::CoreError;

/// Randomness the core's caller drew from its host, handed in as bytes.
///
/// Bytes rather than a callback for two reasons. The shell's random
/// source is the webview's, which is not a thing that can cross into a
/// WASM module as a `Send + Sync` object; thirty-two bytes can. And a
/// handshake built from a known pool is reproducible, so its tests pin
/// real values instead of asserting that something happened.
///
/// A pool is spent as it is read and never refilled or stretched. One
/// that runs out is `CoreError::Entropy`.
pub struct Entropy {
    pool: Vec<u8>,
}

/// How much a pairing handshake draws: one ephemeral key.
pub const PAIRING_ENTROPY: usize = 32;

/// How much a connection handshake draws: one ephemeral key.
pub const CONNECT_ENTROPY: usize = 32;

/// How much generating the Device's static key draws.
pub const KEY_ENTROPY: usize = 32;

impl Entropy {
    /// `bytes` must come from a cryptographic random source -- in the
    /// shell, `crypto.getRandomValues`.
    pub fn from_bytes(bytes: Vec<u8>) -> Self {
        Self { pool: bytes }
    }

    pub fn remaining(&self) -> usize {
        self.pool.len()
    }

    /// Fills `dest` from the front of the pool, or fails without
    /// writing anything.
    pub fn take(&mut self, dest: &mut [u8]) -> Result<(), CoreError> {
        if dest.len() > self.pool.len() {
            return Err(CoreError::Entropy);
        }
        let rest = self.pool.split_off(dest.len());
        dest.copy_from_slice(&self.pool);
        self.pool.fill(0);
        self.pool = rest;
        Ok(())
    }
}

impl Drop for Entropy {
    fn drop(&mut self) {
        self.pool.fill(0);
    }
}

/// Never the bytes: a pool that reached a log is a key that did.
impl std::fmt::Debug for Entropy {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Entropy").field("remaining", &self.pool.len()).finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_pool_is_read_from_the_front_and_spent() {
        let mut entropy = Entropy::from_bytes((0u8..8).collect());
        let mut first = [0u8; 3];
        entropy.take(&mut first).unwrap();
        assert_eq!(first, [0, 1, 2]);
        assert_eq!(entropy.remaining(), 5);

        let mut second = [0u8; 5];
        entropy.take(&mut second).unwrap();
        assert_eq!(second, [3, 4, 5, 6, 7], "bytes already handed out must not come back");
        assert_eq!(entropy.remaining(), 0);
    }

    #[test]
    fn a_pool_that_runs_out_fails_without_writing() {
        let mut entropy = Entropy::from_bytes(vec![9; 4]);
        let mut dest = [0u8; 5];
        assert_eq!(entropy.take(&mut dest), Err(CoreError::Entropy));
        assert_eq!(dest, [0u8; 5], "a short pool must not half-fill a key");
        assert_eq!(entropy.remaining(), 4, "and must not be spent by the attempt");
    }

    #[test]
    fn a_pool_does_not_print_its_bytes() {
        let entropy = Entropy::from_bytes(vec![0xab; 32]);
        let shown = format!("{entropy:?}");
        assert!(shown.contains("32"), "{shown}");
        assert!(!shown.contains("171") && !shown.to_lowercase().contains("ab,"), "{shown}");
    }
}
