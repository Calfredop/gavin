use anyhow::{Context, Result};
use gavin_push_gateway::clock::{Clock, SystemClock};
use gavin_push_gateway::config::{self, Config};
use gavin_push_gateway::log::Log;
use gavin_push_gateway::permission::PermissionKey;
use gavin_push_gateway::store::Store;
use gavin_push_gateway::{serve, Gateway};
use std::process::ExitCode;
use std::sync::Arc;
use std::time::Duration;

#[tokio::main]
async fn main() -> ExitCode {
    let log = Log::stderr();
    match run(&log).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            log.info(format!("gavin-push-gateway: {e:#}"));
            ExitCode::FAILURE
        }
    }
}

async fn run(log: &Log) -> Result<()> {
    Config::check_names(std::env::vars_os().filter_map(|(name, _)| name.into_string().ok()))?;
    let config = Config::from_env(|name| std::env::var(name).ok())?;
    let clock: Arc<dyn Clock> = Arc::new(SystemClock);

    let store = Store::open(&config.db_path())?;
    let key = PermissionKey::load_or_create(&config.permission_key_file)?;
    let sender = config.sender(clock.clone(), log.clone())?;
    let settings = config.settings();
    let gateway = Arc::new(Gateway::new(store, key, sender, clock, log.clone(), settings));

    let listener = tokio::net::TcpListener::bind(config.listen)
        .await
        .with_context(|| format!("binding {}", config.listen))?;
    log.info(format!(
        "gavin-push-gateway {} listening on {}: {}, permissions last {} days, {} pushes per device at once then one every {}s",
        env!("CARGO_PKG_VERSION"),
        config.listen,
        match &config.delivery {
            config::Delivery::DryRun => "dry run (delivers nothing)".to_string(),
            config::Delivery::Live { apns, fcm } => format!(
                "APNs {}, FCM {}",
                if apns.is_some() { "on" } else { "off" },
                if fcm.is_some() { "on" } else { "off" }
            ),
        },
        config.permission_ttl_days,
        settings.rate.burst,
        settings.rate.interval_ms / 1000,
    ));

    let pruning = gateway.clone();
    tokio::spawn(async move {
        let mut hourly = tokio::time::interval(Duration::from_secs(60 * 60));
        loop {
            hourly.tick().await;
            pruning.prune();
        }
    });

    serve(listener, gateway, shutdown()).await.context("serving")?;
    log.info("gavin-push-gateway stopped");
    Ok(())
}

/// Ctrl-C, or the SIGTERM `docker stop` sends.
async fn shutdown() {
    let interrupt = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut term) => {
                term.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        _ = interrupt => {}
        _ = terminate => {}
    }
}
