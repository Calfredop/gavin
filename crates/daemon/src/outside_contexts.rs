//! Machine-local registration of outside contexts.
//!
//! `.gavin-root/config.toml`'s `extra_contexts` ships with the repository.
//! Honouring that list as a registration would let a cloned repo name
//! another workspace's `.gavin` folder and hand its cards to every agent
//! that calls `ScanGavinRoot` / `gavin_get_tree` (audit fingerprint
//! `scan_root:repo-committed-extra-contexts-disclosed-to-agent`).
//!
//! The human's registration path is `AddExternalGavinContext`. That is
//! the only writer of this store. A value that arrived with a clone, a
//! colleague's commit or a git pull stays inert until the same path
//! runs on this machine.
//!
//! The list lives in `devices.sqlite` — shared by the release and dev
//! daemons the way the trust store itself is — not in `registry*.sqlite`,
//! which splits per build. Under `cfg(test)` the free functions keep an
//! in-memory map instead, so unit tests never touch the developer's real
//! store; the SQLite path is exercised through `TrustStore` and the
//! `pre_v*` migration test below.

use rusqlite::{params, Connection};
use std::path::Path;
#[cfg(test)]
use std::collections::{BTreeMap, BTreeSet};
#[cfg(test)]
use std::sync::Mutex;
#[cfg(not(test))]
use std::path::PathBuf;

/// Schema fragment owned by this module. `TrustStore::open` runs it on
/// every open so an existing `devices.sqlite` gains the table; the free
/// functions run it too when they open the file themselves.
pub const CREATE_TABLE_SQL: &str = "CREATE TABLE IF NOT EXISTS registered_outside_contexts (
                root_path TEXT NOT NULL,
                folder_path TEXT NOT NULL,
                PRIMARY KEY (root_path, folder_path)
            )";

pub fn ensure_table(conn: &Connection) -> anyhow::Result<()> {
    conn.execute_batch(CREATE_TABLE_SQL)?;
    Ok(())
}

fn root_key(root: &Path) -> String {
    match protocol::canonical_path(root) {
        Ok(p) => p.to_string_lossy().into_owned(),
        Err(_) => {
            let trimmed = root.to_string_lossy();
            let trimmed = trimmed.trim_end_matches(['/', '\\']);
            if trimmed.is_empty() {
                root.to_string_lossy().into_owned()
            } else {
                trimmed.to_string()
            }
        }
    }
}

fn folder_key(folder: &Path) -> String {
    folder.to_string_lossy().into_owned()
}

#[cfg(not(test))]
fn devices_db_path() -> anyhow::Result<PathBuf> {
    Ok(protocol::app_support_dir()?.join("devices.sqlite"))
}

#[cfg(not(test))]
fn open_conn() -> anyhow::Result<Connection> {
    let path = devices_db_path()?;
    let conn = Connection::open(&path)?;
    ensure_table(&conn)?;
    Ok(conn)
}

fn list_from_conn(conn: &Connection, root: &Path) -> anyhow::Result<Vec<String>> {
    let key = root_key(root);
    let mut stmt = conn.prepare(
        "SELECT folder_path FROM registered_outside_contexts WHERE root_path = ?1 ORDER BY folder_path",
    )?;
    let rows = stmt.query_map(params![key], |row| row.get::<_, String>(0))?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

fn insert_conn(conn: &Connection, root: &Path, folder: &Path) -> anyhow::Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO registered_outside_contexts (root_path, folder_path) VALUES (?1, ?2)",
        params![root_key(root), folder_key(folder)],
    )?;
    Ok(())
}

fn delete_conn(conn: &Connection, root: &Path, folder: &Path) -> anyhow::Result<()> {
    conn.execute(
        "DELETE FROM registered_outside_contexts WHERE root_path = ?1 AND folder_path = ?2",
        params![root_key(root), folder_key(folder)],
    )?;
    Ok(())
}

#[cfg(test)]
static MEMORY: Mutex<BTreeMap<String, BTreeSet<String>>> = Mutex::new(BTreeMap::new());

/// Folders the human registered for this root on this machine.
pub fn registered_outside_contexts(root: &Path) -> Vec<String> {
    #[cfg(test)]
    {
        let key = root_key(root);
        MEMORY
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&key)
            .map(|set| set.iter().cloned().collect())
            .unwrap_or_default()
    }
    #[cfg(not(test))]
    {
        match open_conn().and_then(|conn| list_from_conn(&conn, root)) {
            Ok(rows) => rows,
            Err(e) => {
                eprintln!("outside_contexts: could not read registrations: {e}");
                Vec::new()
            }
        }
    }
}

/// Records that the human registered `folder` for `root` on this machine.
pub fn register_outside_context(root: &Path, folder: &Path) -> anyhow::Result<()> {
    #[cfg(test)]
    {
        let key = root_key(root);
        MEMORY
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entry(key)
            .or_default()
            .insert(folder_key(folder));
        return Ok(());
    }
    #[cfg(not(test))]
    {
        let conn = open_conn()?;
        insert_conn(&conn, root, folder)
    }
}

/// Drops the machine-local registration. Absent rows are a no-op.
pub fn unregister_outside_context(root: &Path, folder: &Path) -> anyhow::Result<()> {
    #[cfg(test)]
    {
        let key = root_key(root);
        if let Some(set) = MEMORY.lock().unwrap_or_else(|e| e.into_inner()).get_mut(&key) {
            set.remove(&folder_key(folder));
        }
        return Ok(());
    }
    #[cfg(not(test))]
    {
        let conn = open_conn()?;
        delete_conn(&conn, root, folder)
    }
}

/// Direct SQLite helpers for the migration case: they always hit the
/// connection they are given, never the in-memory map used by the free
/// functions under `cfg(test)`.
#[cfg(test)]
fn list_for_conn(conn: &Connection, root: &Path) -> anyhow::Result<Vec<String>> {
    list_from_conn(conn, root)
}

#[cfg(test)]
fn register_for_conn(conn: &Connection, root: &Path, folder: &Path) -> anyhow::Result<()> {
    insert_conn(conn, root, folder)
}

#[cfg(test)]
fn unregister_for_conn(conn: &Connection, root: &Path, folder: &Path) -> anyhow::Result<()> {
    delete_conn(conn, root, folder)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::trust::TrustStore;

    #[test]
    fn a_devices_database_from_before_outside_contexts_gains_the_table() {
        // New TABLE, not a column: `CREATE TABLE IF NOT EXISTS` reaches an
        // existing file. Built with the schema from before this table
        // existed, then opened — the registration path must work on that
        // pre-existing store (CLAUDE.md trap, table form).
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("devices.sqlite");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE devices (
                    device_id TEXT PRIMARY KEY,
                    public_key BLOB NOT NULL,
                    name TEXT NOT NULL,
                    role TEXT NOT NULL DEFAULT 'remote',
                    created_at_us INTEGER NOT NULL,
                    last_seen_at_us INTEGER NOT NULL
                );
                CREATE TABLE trust_meta (key TEXT PRIMARY KEY, value BLOB NOT NULL)",
            )
            .unwrap();
        }

        {
            // Open (and drop) so the migration runs; then use a raw
            // connection the way production free functions do.
            let _store = TrustStore::open(&path).unwrap();
        }
        let conn = Connection::open(&path).unwrap();
        let root = dir.path().join("ws");
        let folder = dir.path().join("lib");
        register_for_conn(&conn, &root, &folder).unwrap();
        let listed = list_for_conn(&conn, &root).unwrap();
        assert_eq!(listed, vec![folder.to_string_lossy().into_owned()]);
    }

    #[test]
    fn register_is_idempotent_and_unregister_clears() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("devices.sqlite");
        {
            let _store = TrustStore::open(&path).unwrap();
        }
        let conn = Connection::open(&path).unwrap();
        let root = dir.path().join("ws");
        let folder = dir.path().join("lib");
        register_for_conn(&conn, &root, &folder).unwrap();
        register_for_conn(&conn, &root, &folder).unwrap();
        assert_eq!(list_for_conn(&conn, &root).unwrap().len(), 1);
        unregister_for_conn(&conn, &root, &folder).unwrap();
        assert!(list_for_conn(&conn, &root).unwrap().is_empty());
        unregister_for_conn(&conn, &root, &folder).unwrap();
    }
}
