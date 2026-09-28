//! The gateway's database: registered Devices and their live permissions.
//!
//! A Device row is the stable thing a permission points at, and its push
//! token is a column that changes underneath it -- which is why a
//! replaced token keeps every permission working. A permission row's
//! existence is what "not cancelled" means: cancelling deletes it.
//!
//! One connection behind a mutex, every statement a primary-key lookup,
//! never held across an await.

use crate::id::Id;
use crate::sender::{ApnsEnvironment, Target};
use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;
use std::sync::Mutex;

const SCHEMA_VERSION: i64 = 1;

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
    /// None once Apple or Google said the token is gone, until the Device
    /// registers a new one.
    pub token: Option<String>,
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
        conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;
        Ok(Store { conn: Mutex::new(conn) })
    }

    /// Adds a Device. A token belongs to one Device: any older Device
    /// holding the same one is an earlier install on the same phone, which
    /// can no longer decrypt anything, so it goes -- permissions and all.
    pub fn insert_device(&self, id: Id, secret_hash: &[u8; 32], reg: &Registration, now_s: u64) -> Result<()> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        retire_token_holders(&tx, id, reg)?;
        tx.execute(
            "INSERT INTO devices (id, platform, environment, token, secret_hash, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
            params![
                id.to_string(),
                reg.platform.as_str(),
                reg.environment.as_str(),
                reg.token,
                &secret_hash[..],
                now_s as i64
            ],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn device(&self, id: Id) -> Result<Option<DeviceRow>> {
        let conn = self.conn.lock().unwrap();
        let row = conn
            .query_row(
                "SELECT secret_hash, platform, environment, token FROM devices WHERE id = ?1",
                params![id.to_string()],
                |row| {
                    Ok((
                        row.get::<_, Vec<u8>>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Option<String>>(3)?,
                    ))
                },
            )
            .optional()?;
        let Some((hash, platform, environment, token)) = row else {
            return Ok(None);
        };
        Ok(Some(DeviceRow {
            secret_hash: hash.try_into().ok().context("a stored secret hash is not 32 bytes")?,
            platform: Platform::parse(&platform).context("a stored platform is unknown")?,
            environment: ApnsEnvironment::parse(&environment).context("a stored environment is unknown")?,
            token,
        }))
    }

    /// Points a Device at a newer token. Its permissions are untouched.
    pub fn replace_token(&self, id: Id, reg: &Registration, now_s: u64) -> Result<()> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        retire_token_holders(&tx, id, reg)?;
        tx.execute(
            "UPDATE devices SET token = ?2, environment = ?3, updated_at = ?4 WHERE id = ?1",
            params![id.to_string(), reg.token, reg.environment.as_str(), now_s as i64],
        )?;
        tx.commit()?;
        Ok(())
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

fn retire_token_holders(tx: &rusqlite::Transaction, keep: Id, reg: &Registration) -> Result<()> {
    tx.execute(
        "DELETE FROM devices WHERE platform = ?1 AND token = ?2 AND id != ?3",
        params![reg.platform.as_str(), reg.token, keep.to_string()],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ios(token: &str) -> Registration {
        Registration { platform: Platform::Ios, token: token.into(), environment: ApnsEnvironment::Production }
    }

    #[test]
    fn prune_takes_expired_permissions_then_idle_devices_without_any() {
        let store = Store::open_in_memory().unwrap();
        let (idle, busy) = (Id::random(), Id::random());
        store.insert_device(idle, &[0; 32], &ios("aa"), 100).unwrap();
        store.insert_device(busy, &[0; 32], &ios("bb"), 100).unwrap();
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
            store.insert_device(device, &[1; 32], &ios("cc"), 1).unwrap();
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
}
