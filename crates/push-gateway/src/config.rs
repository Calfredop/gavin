//! Configuration, from `GAVIN_PUSH_*` environment variables. Every one is
//! documented in `docs/push-gateway.md`; keep the two in step.

use crate::apns::{self, Apns, ApnsConfig};
use crate::clock::Clock;
use crate::fcm::{self, Fcm, FcmConfig, ServiceAccount};
use crate::gateway::Settings;
use crate::jwt;
use crate::log::Log;
use crate::rate::RateLimit;
use crate::sender::{DryRun, Live, Sender};
use anyhow::{bail, Context, Result};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub const LISTEN: &str = "GAVIN_PUSH_LISTEN";
pub const DATA_DIR: &str = "GAVIN_PUSH_DATA_DIR";
pub const PERMISSION_KEY_FILE: &str = "GAVIN_PUSH_PERMISSION_KEY_FILE";
pub const PERMISSION_TTL_DAYS: &str = "GAVIN_PUSH_PERMISSION_TTL_DAYS";
pub const RATE_BURST: &str = "GAVIN_PUSH_RATE_BURST";
pub const RATE_PER_HOUR: &str = "GAVIN_PUSH_RATE_PER_HOUR";
pub const DELIVERY: &str = "GAVIN_PUSH_DELIVERY";
pub const APNS_KEY_FILE: &str = "GAVIN_PUSH_APNS_KEY_FILE";
pub const APNS_KEY_ID: &str = "GAVIN_PUSH_APNS_KEY_ID";
pub const APNS_TEAM_ID: &str = "GAVIN_PUSH_APNS_TEAM_ID";
pub const APNS_TOPIC: &str = "GAVIN_PUSH_APNS_TOPIC";
pub const FCM_SERVICE_ACCOUNT_FILE: &str = "GAVIN_PUSH_FCM_SERVICE_ACCOUNT_FILE";

const KNOWN: &[&str] = &[
    LISTEN,
    DATA_DIR,
    PERMISSION_KEY_FILE,
    PERMISSION_TTL_DAYS,
    RATE_BURST,
    RATE_PER_HOUR,
    DELIVERY,
    APNS_KEY_FILE,
    APNS_KEY_ID,
    APNS_TEAM_ID,
    APNS_TOPIC,
    FCM_SERVICE_ACCOUNT_FILE,
];

#[derive(Debug, PartialEq, Eq)]
pub struct Config {
    pub listen: SocketAddr,
    pub data_dir: PathBuf,
    pub permission_key_file: PathBuf,
    pub permission_ttl_days: u64,
    pub rate: RateLimit,
    pub delivery: Delivery,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Delivery {
    /// Apple and Google, each only if its credentials are set.
    Live { apns: Option<ApnsFiles>, fcm: Option<PathBuf> },
    /// Nothing leaves the gateway.
    DryRun,
}

#[derive(Debug, PartialEq, Eq)]
pub struct ApnsFiles {
    pub key_file: PathBuf,
    pub key_id: String,
    pub team_id: String,
    pub topic: String,
}

impl Config {
    /// A misspelt variable would otherwise be silently ignored, and a
    /// missing credential only shows up as a platform nobody can register.
    pub fn check_names(names: impl Iterator<Item = String>) -> Result<()> {
        let unknown: Vec<String> =
            names.filter(|n| n.starts_with("GAVIN_PUSH_") && !KNOWN.contains(&n.as_str())).collect();
        if !unknown.is_empty() {
            bail!("unknown configuration: {} (see docs/push-gateway.md)", unknown.join(", "));
        }
        Ok(())
    }

    /// Reads the configuration through `var`, which stands in for the
    /// environment. An empty value counts as unset, the way a compose file's
    /// `VAR=` line means it.
    pub fn from_env(var: impl Fn(&str) -> Option<String>) -> Result<Config> {
        let get = |name: &str| var(name).filter(|v| !v.trim().is_empty());
        let number = |name: &str, default: u64| -> Result<u64> {
            match get(name) {
                None => Ok(default),
                Some(v) => v.trim().parse().with_context(|| format!("{name} is not a whole number: {v:?}")),
            }
        };

        let listen = get(LISTEN).unwrap_or_else(|| "0.0.0.0:8080".into());
        let listen = listen.parse().with_context(|| format!("{LISTEN} is not an address:port: {listen:?}"))?;
        let data_dir = PathBuf::from(get(DATA_DIR).unwrap_or_else(|| "/data".into()));
        let permission_key_file =
            get(PERMISSION_KEY_FILE).map(PathBuf::from).unwrap_or_else(|| data_dir.join("permission.key"));
        let permission_ttl_days = number(PERMISSION_TTL_DAYS, 90)?;
        if permission_ttl_days == 0 {
            bail!("{PERMISSION_TTL_DAYS} must be at least 1");
        }
        let burst = number(RATE_BURST, 30)?;
        let per_hour = number(RATE_PER_HOUR, 240)?;
        if burst == 0 || per_hour == 0 || burst > u64::from(u32::MAX) || per_hour > 3_600_000 {
            bail!("{RATE_BURST} must be at least 1 and {RATE_PER_HOUR} between 1 and 3600000");
        }
        let rate = RateLimit::per_hour(burst as u32, per_hour as u32);

        let delivery = match get(DELIVERY).as_deref().map(str::trim) {
            None | Some("live") => {
                let apns = apns_files(&get)?;
                let fcm = get(FCM_SERVICE_ACCOUNT_FILE).map(PathBuf::from);
                if apns.is_none() && fcm.is_none() {
                    bail!(
                        "live delivery needs APNs credentials ({APNS_KEY_FILE} and friends), \
                         {FCM_SERVICE_ACCOUNT_FILE}, or both; set {DELIVERY}=dry-run to deliver nothing"
                    );
                }
                Delivery::Live { apns, fcm }
            }
            Some("dry-run") => Delivery::DryRun,
            Some(other) => bail!("{DELIVERY} must be live or dry-run, not {other:?}"),
        };

        Ok(Config { listen, data_dir, permission_key_file, permission_ttl_days, rate, delivery })
    }

    pub fn db_path(&self) -> PathBuf {
        self.data_dir.join("push-gateway.sqlite")
    }

    pub fn settings(&self) -> Settings {
        Settings { permission_ttl_s: self.permission_ttl_days * 24 * 60 * 60, rate: self.rate, ..Settings::default() }
    }

    /// Reads the credential files and builds the sender they configure.
    pub fn sender(&self, clock: Arc<dyn Clock>, log: Log) -> Result<Box<dyn Sender>> {
        let (apns, fcm) = match &self.delivery {
            Delivery::DryRun => return Ok(Box::new(DryRun { log })),
            Delivery::Live { apns, fcm } => (apns, fcm),
        };
        let apns = match apns {
            None => None,
            Some(files) => Some(Apns::new(
                ApnsConfig {
                    key_pkcs8: jwt::pkcs8_from_pem(&read(&files.key_file)?)
                        .with_context(|| format!("{APNS_KEY_FILE} ({})", files.key_file.display()))?,
                    key_id: files.key_id.clone(),
                    team_id: files.team_id.clone(),
                    topic: files.topic.clone(),
                    production_url: apns::PRODUCTION_URL.into(),
                    development_url: apns::DEVELOPMENT_URL.into(),
                },
                clock.clone(),
            )?),
        };
        let fcm = match fcm {
            None => None,
            Some(path) => {
                let account: ServiceAccount = serde_json::from_str(&read(path)?)
                    .with_context(|| format!("{FCM_SERVICE_ACCOUNT_FILE} ({}) is not a service account key", path.display()))?;
                Some(Fcm::new(FcmConfig { account, send_base_url: fcm::SEND_BASE_URL.into() }, clock)?)
            }
        };
        Ok(Box::new(Live { apns, fcm }))
    }
}

/// All four APNs variables or none of them.
fn apns_files(get: &impl Fn(&str) -> Option<String>) -> Result<Option<ApnsFiles>> {
    let values = [APNS_KEY_FILE, APNS_KEY_ID, APNS_TEAM_ID, APNS_TOPIC].map(|name| (name, get(name)));
    let missing: Vec<&str> = values.iter().filter(|(_, v)| v.is_none()).map(|(name, _)| *name).collect();
    if missing.len() == values.len() {
        return Ok(None);
    }
    if !missing.is_empty() {
        bail!("APNs is half configured: {} not set", missing.join(", "));
    }
    let [key_file, key_id, team_id, topic] = values.map(|(_, v)| v.unwrap().trim().to_string());
    Ok(Some(ApnsFiles { key_file: PathBuf::from(key_file), key_id, team_id, topic }))
}

fn read(path: &Path) -> Result<String> {
    std::fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn config(vars: &[(&str, &str)]) -> Result<Config> {
        let vars: HashMap<String, String> = vars.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        Config::from_env(|name| vars.get(name).cloned())
    }

    #[test]
    fn dry_run_needs_nothing_else_and_takes_the_defaults() {
        let c = config(&[(DELIVERY, "dry-run")]).unwrap();
        assert_eq!(c.listen, "0.0.0.0:8080".parse().unwrap());
        assert_eq!(c.db_path(), PathBuf::from("/data/push-gateway.sqlite"));
        assert_eq!(c.permission_key_file, PathBuf::from("/data/permission.key"));
        assert_eq!(c.settings().permission_ttl_s, 90 * 86_400);
        assert_eq!(c.rate, RateLimit::per_hour(30, 240));
        assert_eq!(c.delivery, Delivery::DryRun);
    }

    /// The dev stack's gateway. Its credentials are named and do not exist:
    /// were any of them read, or an Apple or Google client built from them,
    /// this would fail -- and a dry run's `send` completes with nothing
    /// listening anywhere, which a sender that dialled out could not.
    #[test]
    fn a_dry_run_builds_no_apple_or_google_client_and_sends_nothing() {
        use crate::clock::SystemClock;
        use crate::sender::{ApnsEnvironment, Delivery, Target};
        use crate::store::Platform;

        let c = config(&[
            (DELIVERY, "dry-run"),
            (APNS_KEY_FILE, "/nonexistent/apns.p8"),
            (APNS_KEY_ID, "K"),
            (APNS_TEAM_ID, "T"),
            (APNS_TOPIC, "dev.gavin.companion"),
            (FCM_SERVICE_ACCOUNT_FILE, "/nonexistent/fcm.json"),
        ])
        .unwrap();
        let sender = c.sender(Arc::new(SystemClock), Log::stderr()).expect("no credential file is read");
        assert!(sender.supports(Platform::Ios) && sender.supports(Platform::Android));

        let runtime = tokio::runtime::Builder::new_current_thread().build().unwrap();
        let apns = Target::Apns { token: "abc", environment: ApnsEnvironment::Development };
        assert_eq!(runtime.block_on(sender.send(apns, b"ciphertext")), Delivery::Delivered);
        assert_eq!(runtime.block_on(sender.send(Target::Fcm { token: "abc" }, b"ciphertext")), Delivery::Delivered);
    }

    #[test]
    fn live_delivery_without_any_credentials_is_refused() {
        let err = config(&[]).unwrap_err().to_string();
        assert!(err.contains("dry-run"), "{err}");
        assert!(config(&[(DELIVERY, "live"), (APNS_KEY_ID, "")]).is_err());
    }

    #[test]
    fn half_an_apns_configuration_is_refused() {
        let err = config(&[(APNS_KEY_FILE, "/k.p8"), (APNS_KEY_ID, "K")]).unwrap_err().to_string();
        assert!(err.contains(APNS_TEAM_ID) && err.contains(APNS_TOPIC), "{err}");
    }

    #[test]
    fn a_full_live_configuration_is_read() {
        let c = config(&[
            (LISTEN, "127.0.0.1:9000"),
            (DATA_DIR, "/srv/push"),
            (PERMISSION_TTL_DAYS, "30"),
            (RATE_BURST, "5"),
            (RATE_PER_HOUR, "60"),
            (APNS_KEY_FILE, "/run/secrets/apns.p8"),
            (APNS_KEY_ID, "ABC123"),
            (APNS_TEAM_ID, "TEAM"),
            (APNS_TOPIC, "dev.gavin.companion"),
            (FCM_SERVICE_ACCOUNT_FILE, "/run/secrets/fcm.json"),
        ])
        .unwrap();
        assert_eq!(c.listen, "127.0.0.1:9000".parse().unwrap());
        assert_eq!(c.permission_key_file, PathBuf::from("/srv/push/permission.key"));
        assert_eq!(c.settings().permission_ttl_s, 30 * 86_400);
        assert_eq!(c.rate, RateLimit { burst: 5, interval_ms: 60_000 });
        assert_eq!(
            c.delivery,
            Delivery::Live {
                apns: Some(ApnsFiles {
                    key_file: "/run/secrets/apns.p8".into(),
                    key_id: "ABC123".into(),
                    team_id: "TEAM".into(),
                    topic: "dev.gavin.companion".into(),
                }),
                fcm: Some("/run/secrets/fcm.json".into()),
            }
        );
    }

    #[test]
    fn bad_values_are_refused() {
        for vars in [
            [(DELIVERY, "dry-run"), (LISTEN, "8080")],
            [(DELIVERY, "dry-run"), (RATE_BURST, "0")],
            [(DELIVERY, "dry-run"), (RATE_PER_HOUR, "lots")],
            [(DELIVERY, "dry-run"), (PERMISSION_TTL_DAYS, "0")],
            [(DELIVERY, "sometimes"), (RATE_BURST, "1")],
        ] {
            assert!(config(&vars).is_err(), "{vars:?}");
        }
    }

    #[test]
    fn a_misspelt_variable_is_refused() {
        let names = |n: &[&str]| n.iter().map(|s| s.to_string()).collect::<Vec<_>>().into_iter();
        assert!(Config::check_names(names(&[DELIVERY, "PATH", "HOME"])).is_ok());
        let err = Config::check_names(names(&[DELIVERY, "GAVIN_PUSH_APNS_KEYID"])).unwrap_err().to_string();
        assert!(err.contains("GAVIN_PUSH_APNS_KEYID"), "{err}");
    }
}
