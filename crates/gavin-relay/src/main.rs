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
//! | `GAVIN_RELAY_EXIT_WITH_STDIN=1` | read commands from stdin, and stop when it closes |
//! | `GAVIN_RELAY_CONNECTIONS` | sockets open at once; `4096` when unset |
//! | `GAVIN_RELAY_CONNECTIONS_PER_SOURCE` | sockets open at once from one address, before TLS; `64` when unset |
//! | `GAVIN_RELAY_REGISTRATIONS_PER_TOKEN` | Workstation registrations one admission token may hold; `32` when unset |
//! | `GAVIN_RELAY_REGISTRATIONS_PER_RENDEZVOUS` | registrations under one rendezvous id; `4` when unset |
//! | `GAVIN_RELAY_WAITING_PER_RENDEZVOUS` | Devices waiting under one rendezvous id; `16` when unset |
//! | `GAVIN_RELAY_BYTES_PER_STREAM` | bytes one joined stream may copy; `0` (no budget) when unset |
//!
//! The last one is for the daemon that runs this Mac's own Relay
//! (`crates/daemon/src/desk_relay.rs`). It holds the other end of the
//! pipe, so a daemon that dies, however it dies, takes its Relay with it
//! instead of leaving the port held. A line `reload` on that pipe reads
//! the admission tokens again, from `GAVIN_RELAY_TOKENS_FILE` and
//! `GAVIN_RELAY_TOKENS`, without dropping any stream already carried.
//! That is how the desk rotates its token.
//!
//! It will not start without an admission token, and it will not start
//! without TLS unless it is told that TLS is someone else's: a Relay that
//! came up in the clear because a variable was misspelt would carry every
//! admission token in the clear too.

use gavin_relay::server::{serve_with, AdmissionTokens, Limits, RelayConfig, Tls};
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

fn usize_var(name: &str, default: usize) -> anyhow::Result<usize> {
    match var(name) {
        None => Ok(default),
        Some(raw) => raw.parse().map_err(|e| {
            anyhow::anyhow!("gavin-relay: {name} is not an integer ({raw}): {e}")
        }),
    }
}

fn u64_var(name: &str, default: u64) -> anyhow::Result<u64> {
    match var(name) {
        None => Ok(default),
        Some(raw) => raw
            .parse()
            .map_err(|e| anyhow::anyhow!("gavin-relay: {name} is not an integer ({raw}): {e}")),
    }
}

fn limits() -> anyhow::Result<Limits> {
    let defaults = Limits::default();
    Ok(Limits {
        connections: usize_var("GAVIN_RELAY_CONNECTIONS", defaults.connections)?,
        connections_per_source: usize_var(
            "GAVIN_RELAY_CONNECTIONS_PER_SOURCE",
            defaults.connections_per_source,
        )?,
        registrations_per_token: usize_var(
            "GAVIN_RELAY_REGISTRATIONS_PER_TOKEN",
            defaults.registrations_per_token,
        )?,
        registrations_per_rendezvous: usize_var(
            "GAVIN_RELAY_REGISTRATIONS_PER_RENDEZVOUS",
            defaults.registrations_per_rendezvous,
        )?,
        waiting_per_rendezvous: usize_var(
            "GAVIN_RELAY_WAITING_PER_RENDEZVOUS",
            defaults.waiting_per_rendezvous,
        )?,
        bytes_per_stream: u64_var("GAVIN_RELAY_BYTES_PER_STREAM", defaults.bytes_per_stream)?,
        ..defaults
    })
}

fn config() -> anyhow::Result<RelayConfig> {
    let listen = var("GAVIN_RELAY_LISTEN").unwrap_or_else(|| DEFAULT_LISTEN.to_string());
    let listen: SocketAddr = listen
        .parse()
        .map_err(|e| anyhow::anyhow!("gavin-relay: GAVIN_RELAY_LISTEN is not an address ({listen}): {e}"))?;
    Ok(RelayConfig { listen, tokens: tokens()?, tls: tls()?, limits: limits()? })
}

/// With `GAVIN_RELAY_EXIT_WITH_STDIN=1`, reads stdin a line at a time on
/// a thread of its own: `reload` replaces `admission` with the tokens read
/// again, and the end of stdin is what the receiver hears. Without it,
/// nothing is read and the receiver never hears.
///
/// A thread rather than a blocking task, which the runtime would wait on
/// at shutdown for as long as stdin stayed open.
fn commands(admission: AdmissionTokens) -> tokio::sync::oneshot::Receiver<()> {
    let (closed, gone) = tokio::sync::oneshot::channel::<()>();
    if var("GAVIN_RELAY_EXIT_WITH_STDIN").as_deref() != Some("1") {
        // Kept, so the receiver waits for good rather than hearing a drop.
        std::mem::forget(closed);
        return gone;
    }
    let reading = std::thread::Builder::new().name("stdin".into()).spawn(move || {
        use std::io::BufRead;
        for line in std::io::stdin().lock().lines() {
            let Ok(line) = line else { break };
            if line.trim() != "reload" {
                eprintln!("gavin-relay: unknown command on stdin: {:?}", line.trim());
                continue;
            }
            match tokens().and_then(|tokens| admission.replace(&tokens)) {
                Ok(()) => println!("gavin-relay: admission tokens read again"),
                // The tokens held are kept: a Relay that dropped to none
                // would refuse everyone, the desk included.
                Err(e) => eprintln!("{e} — keeping the tokens held"),
            }
        }
        let _ = closed.send(());
    });
    if let Err(e) = reading {
        eprintln!("gavin-relay: could not read stdin: {e}");
    }
    gone
}

/// Resolves when `gone` is heard: the daemon that started this one has
/// closed its end of stdin.
async fn parent_gone(gone: tokio::sync::oneshot::Receiver<()>) {
    let _ = gone.await;
}

/// Ctrl-C at a terminal, SIGTERM from a container runtime, or the daemon
/// that started this one gone.
async fn stopped(gone: tokio::sync::oneshot::Receiver<()>) {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        match signal(SignalKind::terminate()) {
            Ok(mut terminate) => {
                tokio::select! {
                    _ = tokio::signal::ctrl_c() => {}
                    _ = terminate.recv() => {}
                    _ = parent_gone(gone) => {}
                }
            }
            Err(_) => {
                tokio::select! {
                    _ = tokio::signal::ctrl_c() => {}
                    _ = parent_gone(gone) => {}
                }
            }
        }
    }
    #[cfg(not(unix))]
    {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = parent_gone(gone) => {}
        }
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
    let admission = AdmissionTokens::of(&config)?;
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
        let gone = commands(admission.clone());
        serve_with(listener, config, admission, stopped(gone)).await
    })
}
