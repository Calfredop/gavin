//! The gateway's database: registered Devices and their live permissions.
//!
//! A Device row is the stable thing a permission points at, and its push
//! token is a column that changes underneath it -- which is why a
//! replaced token keeps every permission working. A permission row's
//! existence is what "not cancelled" means: cancelling deletes it.
//!
//! A claimed token sits in `pending_token` until the Device proves it
//! holds that token (echoing a nonce the gateway pushed to it). Only
//! then does `token` become deliverable and other holders of the same
//! token lose theirs. An unproven claim never deletes another Device.
//!
//! One connection behind a mutex, every statement a primary-key lookup,
//! never held across an await.

use crate::id::Id;
use crate::sender::{ApnsEnvironment, Target};
use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;
use std::sync::Mutex;

const SCHEMA_VERSION: i64 = 2;

pub struct Store {
    conn: Mutex<Connection>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Platform {
    Ios,
    Android,
}

impl Platform {
    pub fn as_str(self) -> &'static str {
        match self {
            Platform::Ios => "ios",
            Platform::Android => "android",
        }
    }

    pub fn parse(text: &str) -> Option<Platform> {
        match text {
            "ios" => Some(Platform::Ios),
            "android" => Some(Platform::Android),
            _ => None,
        }
    }
}

/// Where a Device's pushes go: its platform, its token and (on iOS) which
/// APNs environment issued that token.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Registration {
    pub platform: Platform,
    pub token: String,
    pub environment: ApnsEnvironment,
}

pub struct DeviceRow {
    pub secret_hash: [u8; 32],
    pub platform: Platform,
    pub environment: ApnsEnvironment,
    /// None until the Device has confirmed a pending claim, or once Apple
    /// or Google said the token is gone, until it confirms another.
    pub token: Option<String>,
    /// A claim waiting on proof of possession. None when there is none.
    pub pending: Option<Registration>,
    pub token_nonce_hash: Option<[u8; 32]>,
}

impl DeviceRow {
    pub fn target(&self) -> Option<Target<'_>> {
        let token = self.token.as_deref()?;
        Some(match self.platform {
            Platform::Ios => Target::Apns { token, environment: self.environment },
            Platform::Android => Target::Fcm { token },
        })
    }

}

impl Store {
    pub fn open(path: &Path) -> Result<Store> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
        }
        // Push tokens and secret hashes: readable by the gateway's user
        // only. SQLite gives its -wal and -shm files the database's mode.
        #[cfg(unix)]
        if !path.exists() {
            use std::os::unix::fs::OpenOptionsExt;
            std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(path)
                .with_context(|| format!("creating {}", path.display()))?;
        }
        let conn = Connection::open(path).with_context(|| format!("opening {}", path.display()))?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        Store::init(conn)
    }

    pub fn open_in_memory() -> Result<Store> {
        Store::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> Result<Store> {
        // Per connection, not per database: without it the cascade that
        // takes a Device's permissions with it never fires.
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS devices (
                 id          TEXT PRIMARY KEY,
                 platform    TEXT NOT NULL,
                 environment TEXT NOT NULL,
                 token       TEXT,
                 secret_hash BLOB NOT NULL,
                 created_at  INTEGER NOT NULL,
                 updated_at  INTEGER NOT NULL
             );
             CREATE UNIQUE INDEX IF NOT EXISTS devices_token ON devices(platform, token);
             CREATE TABLE IF NOT EXISTS permissions (
                 id         TEXT PRIMARY KEY,
                 device_id  TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
                 created_at INTEGER NOT NULL,
                 expires_at INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS permissions_device ON permissions(device_id);",
        )?;
        // `ALTER TABLE ADD COLUMN` has no IF NOT EXISTS in SQLite; a
        // duplicate-column error is swallowed so an existing database
        // gains the pending-claim columns and a fresh one (CREATE TABLE
        // above already has the base) reaches the same shape.
        for stmt in [
            "ALTER TABLE devices ADD COLUMN pending_token TEXT",
            "ALTER TABLE devices ADD COLUMN pending_environment TEXT",
            "ALTER TABLE devices ADD COLUMN token_nonce_hash BLOB",
        ] {
            let _ = conn.execute(stmt, []);
        }
        conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;
        Ok(Store { conn: Mutex::new(conn) })
    }

    /// Adds a Device with a pending token claim. The live `token` stays
    /// NULL until `confirm_token` proves possession; other holders are
    /// left alone until then.
    pub fn insert_device(
        &self,
        id: Id,
        secret_hash: &[u8; 32],
        reg: &Registration,
        nonce_hash: &[u8; 32],
        now_s: u64,
    ) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO devices (
                 id, platform, environment, token, secret_hash,
                 pending_token, pending_environment, token_nonce_hash,
                 created_at, updated_at
             ) VALUES (?1, ?2, ?3, NULL, ?4, ?5, ?6, ?7, ?8, ?8)",
            params![
                id.to_string(),
                reg.platform.as_str(),
                reg.environment.as_str(),
                &secret_hash[..],
                reg.token,
                reg.environment.as_str(),
                &nonce_hash[..],
                now_s as i64
            ],
        )?;
        Ok(())
    }

    pub fn device(&self, id: Id) -> Result<Option<DeviceRow>> {
        let conn = self.conn.lock().unwrap();
        let row = conn
            .query_row(
                "SELECT secret_hash, platform, environment, token,
                        pending_token, pending_environment, token_nonce_hash
                 FROM devices WHERE id = ?1",
                params![id.to_string()],
                |row| {
                    Ok((
                        row.get::<_, Vec<u8>>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, Option<String>>(5)?,
                        row.get::<_, Option<Vec<u8>>>(6)?,
                    ))
                },
            )
            .optional()?;
        let Some((hash, platform, environment, token, pending_token, pending_environment, nonce_hash)) = row else {
            return Ok(None);
        };
        let platform = Platform::parse(&platform).context("a stored platform is unknown")?;
        let environment = ApnsEnvironment::parse(&environment).context("a stored environment is unknown")?;
        let pending = match (pending_token, pending_environment) {
            (Some(token), Some(env)) => Some(Registration {
                platform,
                token,
                environment: ApnsEnvironment::parse(&env).context("a stored pending environment is unknown")?,
            }),
            (None, None) => None,
            _ => anyhow::bail!("a Device's pending claim is half set"),
        };
        let token_nonce_hash = match nonce_hash {
            None => None,
            Some(bytes) => Some(bytes.try_into().ok().context("a stored token nonce hash is not 32 bytes")?),
        };
        Ok(Some(DeviceRow {
            secret_hash: hash.try_into().ok().context("a stored secret hash is not 32 bytes")?,
            platform,
            environment,
            token,
            pending,
            token_nonce_hash,
        }))
    }

    /// Holds a newer token claim as pending. The live token (and every
    /// permission) stays until `confirm_token` proves possession.
    pub fn replace_token(&self, id: Id, reg: &Registration, nonce_hash: &[u8; 32], now_s: u64) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE devices SET pending_token = ?2, pending_environment = ?3,
                 token_nonce_hash = ?4, updated_at = ?5 WHERE id = ?1",
            params![
                id.to_string(),
                reg.token,
                reg.environment.as_str(),
                &nonce_hash[..],
                now_s as i64
            ],
        )?;
        Ok(())
    }

    /// Promotes a pending claim after the Device echoed the nonce. Other
    /// holders of the same live token lose the token (their rows and
    /// permissions stay); rival pending claims on it are dropped.
    pub fn confirm_token(&self, id: Id, nonce_hash: &[u8; 32], now_s: u64) -> Result<ConfirmOutcome> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        let row = tx
            .query_row(
                "SELECT platform, pending_token, pending_environment, token_nonce_hash
                 FROM devices WHERE id = ?1",
                params![id.to_string()],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, Option<Vec<u8>>>(3)?,
                    ))
                },
            )
            .optional()?;
        let Some((platform, pending_token, pending_environment, stored_hash)) = row else {
            return Ok(ConfirmOutcome::UnknownDevice);
        };
        let (Some(token), Some(environment), Some(stored)) = (pending_token, pending_environment, stored_hash) else {
            return Ok(ConfirmOutcome::NothingPending);
        };
        let stored: [u8; 32] = stored.try_into().ok().context("a stored token nonce hash is not 32 bytes")?;
        if stored != *nonce_hash {
            return Ok(ConfirmOutcome::BadNonce);
        }
        let platform = Platform::parse(&platform).context("a stored platform is unknown")?;
        let reg = Registration {
            platform,
            token: token.clone(),
            environment: ApnsEnvironment::parse(&environment).context("a stored pending environment is unknown")?,
        };
        retire_token_holders(&tx, id, &reg)?;
        tx.execute(
            "UPDATE devices SET token = ?2, environment = ?3,
                 pending_token = NULL, pending_environment = NULL, token_nonce_hash = NULL,
                 updated_at = ?4 WHERE id = ?1",
            params![id.to_string(), reg.token, reg.environment.as_str(), now_s as i64],
        )?;
        // Rival Devices that were also waiting on this token lose their claim.
        tx.execute(
            "UPDATE devices SET pending_token = NULL, pending_environment = NULL, token_nonce_hash = NULL
             WHERE platform = ?1 AND pending_token = ?2 AND id != ?3",
            params![reg.platform.as_str(), reg.token, id.to_string()],
        )?;
        tx.commit()?;
        Ok(ConfirmOutcome::Confirmed)
    }

    /// Forgets a token Apple or Google reported gone -- unless the Device
    /// registered a newer one while that push was in flight.
    pub fn clear_token(&self, id: Id, token: &str) -> Result<()> {
        self.conn.lock().unwrap().execute(
            "UPDATE devices SET token = NULL WHERE id = ?1 AND token = ?2",
            params![id.to_string(), token],
        )?;
        Ok(())
    }

    pub fn delete_device(&self, id: Id) -> Result<bool> {
        let deleted = self
            .conn
            .lock()
            .unwrap()
            .execute("DELETE FROM devices WHERE id = ?1", params![id.to_string()])?;
        Ok(deleted > 0)
    }

    pub fn permission_count(&self, device: Id, now_s: u64) -> Result<u64> {
        let count: i64 = self.conn.lock().unwrap().query_row(
            "SELECT COUNT(*) FROM permissions WHERE device_id = ?1 AND expires_at > ?2",
            params![device.to_string(), now_s as i64],
            |row| row.get(0),
        )?;
        Ok(count as u64)
    }

    pub fn insert_permission(&self, id: Id, device: Id, now_s: u64, expires_at: u64) -> Result<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO permissions (id, device_id, created_at, expires_at) VALUES (?1, ?2, ?3, ?4)",
            params![id.to_string(), device.to_string(), now_s as i64, expires_at as i64],
        )?;
        conn.execute(
            "UPDATE devices SET updated_at = ?2 WHERE id = ?1",
            params![device.to_string(), now_s as i64],
        )?;
        Ok(())
    }

    /// The Device a live permission belongs to; None once it is cancelled.
    pub fn permission_device(&self, id: Id) -> Result<Option<Id>> {
        let device: Option<String> = self
            .conn
            .lock()
            .unwrap()
            .query_row(
                "SELECT device_id FROM permissions WHERE id = ?1",
                params![id.to_string()],
                |row| row.get(0),
            )
            .optional()?;
        Ok(device.as_deref().and_then(Id::parse))
    }

    /// Cancels one of this Device's permissions. False when it has none by
    /// that id, which includes another Device's.
    pub fn delete_permission(&self, device: Id, id: Id) -> Result<bool> {
        let deleted = self.conn.lock().unwrap().execute(
            "DELETE FROM permissions WHERE id = ?1 AND device_id = ?2",
            params![id.to_string(), device.to_string()],
        )?;
        Ok(deleted > 0)
    }

    /// Drops expired permissions, then Devices with none left that have
    /// not registered a token or minted a permission for `idle_s`.
    /// Returns (permissions, devices) removed.
    pub fn prune(&self, now_s: u64, idle_s: u64) -> Result<(usize, usize)> {
        let conn = self.conn.lock().unwrap();
        let permissions =
            conn.execute("DELETE FROM permissions WHERE expires_at <= ?1", params![now_s as i64])?;
        let devices = conn.execute(
            "DELETE FROM devices WHERE updated_at <= ?1
               AND NOT EXISTS (SELECT 1 FROM permissions WHERE permissions.device_id = devices.id)",
            params![now_s.saturating_sub(idle_s) as i64],
        )?;
        Ok((permissions, devices))
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum ConfirmOutcome {
    Confirmed,
    UnknownDevice,
    NothingPending,
    BadNonce,
}

/// Proven claim only: called from `confirm_token`, never from
/// `insert_device` / `replace_token`. Clears the live token on every other
/// Device that held it; their rows and permissions stay.
fn retire_token_holders(tx: &rusqlite::Transaction, keep: Id, reg: &Registration) -> Result<()> {
    tx.execute(
        "UPDATE devices SET token = NULL WHERE platform = ?1 AND token = ?2 AND id != ?3",
        params![reg.platform.as_str(), reg.token, keep.to_string()],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::id::secret_hash;

    fn ios(token: &str) -> Registration {
        Registration { platform: Platform::Ios, token: token.into(), environment: ApnsEnvironment::Production }
    }

    fn nonce(n: u8) -> [u8; 32] {
        [n; 32]
    }

    #[test]
    fn prune_takes_expired_permissions_then_idle_devices_without_any() {
        let store = Store::open_in_memory().unwrap();
        let (idle, busy) = (Id::random(), Id::random());
        store.insert_device(idle, &[0; 32], &ios("aa"), &nonce(1), 100).unwrap();
        store.confirm_token(idle, &nonce(1), 100).unwrap();
        store.insert_device(busy, &[0; 32], &ios("bb"), &nonce(2), 100).unwrap();
        store.confirm_token(busy, &nonce(2), 100).unwrap();
        let (expired, live) = (Id::random(), Id::random());
        store.insert_permission(expired, idle, 100, 200).unwrap();
        store.insert_permission(live, busy, 100, 10_000).unwrap();

        assert_eq!(store.prune(150, 1_000).unwrap(), (0, 0));
        // The expired permission goes; its Device is not idle long enough yet.
        assert_eq!(store.prune(1_000, 1_000).unwrap(), (1, 0));
        assert_eq!(store.permission_device(expired).unwrap(), None);
        // Now it is; the Device with a live permission stays however old.
        assert_eq!(store.prune(1_200, 1_000).unwrap(), (0, 1));
        assert!(store.device(idle).unwrap().is_none());
        assert_eq!(store.permission_device(live).unwrap(), Some(busy));
    }

    #[test]
    fn a_file_database_keeps_its_rows_across_a_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("data").join("gateway.sqlite");
        let (device, permission) = (Id::random(), Id::random());
        {
            let store = Store::open(&path).unwrap();
            store.insert_device(device, &[1; 32], &ios("cc"), &nonce(3), 1).unwrap();
            store.confirm_token(device, &nonce(3), 1).unwrap();
            store.insert_permission(permission, device, 1, 99).unwrap();
        }
        let store = Store::open(&path).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |name: &str| std::fs::metadata(path.with_file_name(name)).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode("gateway.sqlite"), 0o600);
            assert_eq!(mode("gateway.sqlite-wal"), 0o600);
        }
        assert_eq!(store.permission_device(permission).unwrap(), Some(device));
        assert_eq!(store.device(device).unwrap().unwrap().token.as_deref(), Some("cc"));
        // The cascade still fires on a reopened connection.
        store.delete_device(device).unwrap();
        assert_eq!(store.permission_device(permission).unwrap(), None);
    }

    #[test]
    fn an_existing_database_gains_the_pending_columns() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("old.sqlite");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE devices (
                     id TEXT PRIMARY KEY, platform TEXT NOT NULL, environment TEXT NOT NULL,
                     token TEXT, secret_hash BLOB NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
                 );
                 CREATE UNIQUE INDEX devices_token ON devices(platform, token);
                 CREATE TABLE permissions (
                     id TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
                     created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
                 );",
            )
            .unwrap();
            conn.execute(
                "INSERT INTO devices (id, platform, environment, token, secret_hash, created_at, updated_at)
                 VALUES ('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'ios', 'production', 'oldtoken', ?1, 1, 1)",
                params![&secret_hash("s")[..]],
            )
            .unwrap();
        }
        let store = Store::open(&path).unwrap();
        let id = Id::parse("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa").unwrap();
        let row = store.device(id).unwrap().unwrap();
        assert_eq!(row.token.as_deref(), Some("oldtoken"));
        assert!(row.pending.is_none());
        store.replace_token(id, &ios("newtoken"), &nonce(9), 2).unwrap();
        assert_eq!(store.confirm_token(id, &nonce(9), 2).unwrap(), ConfirmOutcome::Confirmed);
        assert_eq!(store.device(id).unwrap().unwrap().token.as_deref(), Some("newtoken"));
    }

    #[test]
    fn confirming_a_claim_clears_other_holders_tokens_not_their_rows() {
        let store = Store::open_in_memory().unwrap();
        let (victim, claimant) = (Id::random(), Id::random());
        let permission = Id::random();
        store.insert_device(victim, &[1; 32], &ios("same"), &nonce(1), 1).unwrap();
        store.confirm_token(victim, &nonce(1), 1).unwrap();
        store.insert_permission(permission, victim, 1, 99).unwrap();

        store.insert_device(claimant, &[2; 32], &ios("same"), &nonce(2), 2).unwrap();
        // Unproven: victim still holds the token and its permission.
        assert_eq!(store.device(victim).unwrap().unwrap().token.as_deref(), Some("same"));
        assert_eq!(store.permission_device(permission).unwrap(), Some(victim));
        assert!(store.device(claimant).unwrap().unwrap().token.is_none());

        assert_eq!(store.confirm_token(claimant, &nonce(2), 3).unwrap(), ConfirmOutcome::Confirmed);
        assert!(store.device(victim).unwrap().unwrap().token.is_none());
        assert_eq!(store.permission_device(permission).unwrap(), Some(victim));
        assert_eq!(store.device(claimant).unwrap().unwrap().token.as_deref(), Some("same"));
    }
}
