//! `gavin-relay`: the Relay, as a program.
//!
//! Configured from the environment and nothing else, because where it
//! runs is a container, and a container's configuration is its
//! environment:
//!
//! | variable | meaning |
//! |---|---|
//! | `GAVIN_RELAY_LISTEN` | the address to bind; `0.0.0.0:8443` when unset |
//! | `GAVIN_RELAY_TOKENS` | the admission tokens, separated by commas |
//! | `GAVIN_RELAY_TOKENS_FILE` | a file of admission tokens, one a line |
//! | `GAVIN_RELAY_TLS_CERT` | the certificate chain, PEM |
//! | `GAVIN_RELAY_TLS_KEY` | its private key, PEM |
//! | `GAVIN_RELAY_TLS_TERMINATED=1` | something in front of the Relay does TLS |
//!
//! It will not start without an admission token, and it will not start
//! without TLS unless it is told that TLS is someone else's: a Relay that
//! came up in the clear because a variable was misspelt would carry every
//! admission token in the clear too.

use gavin_relay::server::{serve, Limits, RelayConfig, Tls};
use std::net::SocketAddr;

const DEFAULT_LISTEN: &str = "0.0.0.0:8443";

fn var(name: &str) -> Option<String> {
    std::env::var(name).ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

fn tokens() -> anyhow::Result<Vec<String>> {
    let mut tokens: Vec<String> = Vec::new();
    if let Some(list) = var("GAVIN_RELAY_TOKENS") {
        tokens.extend(list.split(',').map(|t| t.trim().to_string()));
    }
    if let Some(path) = var("GAVIN_RELAY_TOKENS_FILE") {
        let file = std::fs::read_to_string(&path)
            .map_err(|e| anyhow::anyhow!("gavin-relay: could not read {path}: {e}"))?;
        tokens.extend(file.lines().map(|t| t.trim().to_string()));
    }
    tokens.retain(|t| !t.is_empty());
    Ok(tokens)
}

fn tls() -> anyhow::Result<Option<Tls>> {
    let read = |path: &str| {
        std::fs::read(path).map_err(|e| anyhow::anyhow!("gavin-relay: could not read {path}: {e}"))
    };
    match (var("GAVIN_RELAY_TLS_CERT"), var("GAVIN_RELAY_TLS_KEY")) {
        (Some(cert), Some(key)) => Ok(Some(Tls {
            certificate_chain_pem: read(&cert)?,
            private_key_pem: read(&key)?,
        })),
        (None, None) if var("GAVIN_RELAY_TLS_TERMINATED").as_deref() == Some("1") => Ok(None),
        (None, None) => anyhow::bail!(
            "gavin-relay: no certificate is set — set GAVIN_RELAY_TLS_CERT and GAVIN_RELAY_TLS_KEY, or GAVIN_RELAY_TLS_TERMINATED=1 if a proxy in front of the Relay terminates TLS"
        ),
        _ => anyhow::bail!(
            "gavin-relay: GAVIN_RELAY_TLS_CERT and GAVIN_RELAY_TLS_KEY go together — one is set and the other is not"
        ),
    }
}

fn config() -> anyhow::Result<RelayConfig> {
    let listen = var("GAVIN_RELAY_LISTEN").unwrap_or_else(|| DEFAULT_LISTEN.to_string());
    let listen: SocketAddr = listen
        .parse()
        .map_err(|e| anyhow::anyhow!("gavin-relay: GAVIN_RELAY_LISTEN is not an address ({listen}): {e}"))?;
    Ok(RelayConfig { listen, tokens: tokens()?, tls: tls()?, limits: Limits::default() })
}

/// Ctrl-C at a terminal, SIGTERM from a container runtime.
async fn stopped() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        match signal(SignalKind::terminate()) {
            Ok(mut terminate) => {
                tokio::select! {
                    _ = tokio::signal::ctrl_c() => {}
                    _ = terminate.recv() => {}
                }
            }
            Err(_) => {
                let _ = tokio::signal::ctrl_c().await;
            }
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

fn main() -> anyhow::Result<()> {
    if let Some(arg) = std::env::args().nth(1) {
        anyhow::bail!(
            "gavin-relay: unknown argument {arg:?} — the Relay takes no arguments and is configured from the environment (GAVIN_RELAY_LISTEN, GAVIN_RELAY_TOKENS, GAVIN_RELAY_TLS_CERT, GAVIN_RELAY_TLS_KEY)"
        );
    }
    let config = config()?;
    // Before the port is bound, and before anything is printed.
    config.validate()?;
    let runtime = tokio::runtime::Builder::new_multi_thread().enable_all().build()?;
    runtime.block_on(async move {
        let listener = tokio::net::TcpListener::bind(config.listen).await.map_err(|e| {
            anyhow::anyhow!("gavin-relay: could not bind {}: {e}", config.listen)
        })?;
        println!(
            "gavin-relay listening on {} ({})",
            listener.local_addr()?,
            if config.tls.is_some() { "TLS" } else { "TLS terminated in front" }
        );
        serve(listener, config, stopped()).await
    })
}
