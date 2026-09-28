//! The two JSON Web Tokens the gateway signs: ES256 for APNs' provider
//! token, RS256 for the assertion Google trades for an access token.
//! Hand-rolled over ring because these two are all it ever needs.

use anyhow::{anyhow, Context, Result};
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use ring::rand::SystemRandom;
use ring::signature::{EcdsaKeyPair, RsaKeyPair, RSA_PKCS1_SHA256};
use serde_json::Value;

/// The DER inside a PKCS#8 PEM (`-----BEGIN PRIVATE KEY-----`): an APNs
/// `.p8` file, or a Google service account's `private_key`.
pub fn pkcs8_from_pem(pem: &str) -> Result<Vec<u8>> {
    const BEGIN: &str = "-----BEGIN PRIVATE KEY-----";
    const END: &str = "-----END PRIVATE KEY-----";
    let start = pem.find(BEGIN).context("no BEGIN PRIVATE KEY line (a PKCS#8 PEM is expected)")? + BEGIN.len();
    let stop = pem[start..].find(END).context("no END PRIVATE KEY line")? + start;
    let body: String = pem[start..stop].chars().filter(|c| !c.is_whitespace()).collect();
    STANDARD.decode(body).context("the PEM body is not base64")
}

fn signing_input(header: &Value, claims: &Value) -> String {
    format!(
        "{}.{}",
        URL_SAFE_NO_PAD.encode(header.to_string()),
        URL_SAFE_NO_PAD.encode(claims.to_string())
    )
}

pub fn es256(key: &EcdsaKeyPair, header: &Value, claims: &Value) -> Result<String> {
    let input = signing_input(header, claims);
    let signature = key
        .sign(&SystemRandom::new(), input.as_bytes())
        .map_err(|_| anyhow!("ES256 signing failed"))?;
    Ok(format!("{input}.{}", URL_SAFE_NO_PAD.encode(signature.as_ref())))
}

pub fn rs256(key: &RsaKeyPair, header: &Value, claims: &Value) -> Result<String> {
    let input = signing_input(header, claims);
    let mut signature = vec![0u8; key.public().modulus_len()];
    key.sign(&RSA_PKCS1_SHA256, &SystemRandom::new(), input.as_bytes(), &mut signature)
        .map_err(|_| anyhow!("RS256 signing failed"))?;
    Ok(format!("{input}.{}", URL_SAFE_NO_PAD.encode(signature)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ring::signature::{
        KeyPair, UnparsedPublicKey, ECDSA_P256_SHA256_FIXED, ECDSA_P256_SHA256_FIXED_SIGNING,
    };
    use serde_json::json;

    #[test]
    fn an_es256_token_verifies_with_the_public_key() {
        let rng = SystemRandom::new();
        let pkcs8 = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &rng).unwrap();
        let pem = format!(
            "-----BEGIN PRIVATE KEY-----\n{}\n-----END PRIVATE KEY-----\n",
            STANDARD.encode(pkcs8.as_ref())
        );
        let key =
            EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &pkcs8_from_pem(&pem).unwrap(), &rng)
                .unwrap();
        let token = es256(&key, &json!({"alg": "ES256"}), &json!({"iss": "T"})).unwrap();
        let (input, signature) = token.rsplit_once('.').unwrap();
        UnparsedPublicKey::new(&ECDSA_P256_SHA256_FIXED, key.public_key().as_ref())
            .verify(input.as_bytes(), &URL_SAFE_NO_PAD.decode(signature).unwrap())
            .unwrap();
    }

    #[test]
    fn a_pem_that_is_not_pkcs8_is_refused() {
        assert!(pkcs8_from_pem("-----BEGIN EC PRIVATE KEY-----\nAAAA\n-----END EC PRIVATE KEY-----").is_err());
        assert!(pkcs8_from_pem("-----BEGIN PRIVATE KEY-----\n!!\n-----END PRIVATE KEY-----").is_err());
    }
}
