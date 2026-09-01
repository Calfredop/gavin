use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum SessionStatus {
    Idle,
    Working,
    WaitingForInput,
    Exited,
}

impl SessionStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            SessionStatus::Idle => "idle",
            SessionStatus::Working => "working",
            SessionStatus::WaitingForInput => "waiting_for_input",
            SessionStatus::Exited => "exited",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s {
            "working" => SessionStatus::Working,
            "waiting_for_input" => SessionStatus::WaitingForInput,
            "exited" => SessionStatus::Exited,
            _ => SessionStatus::Idle,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SessionRecord {
    pub id: String,
    pub workspace_path: String,
    pub cwd: String,
    pub command: Option<String>,
    pub status: SessionStatus,
    pub restored: bool,
    /// The daemon lifetime that CREATED this session (see
    /// `Registry::open`). Written by the registry, never by the caller:
    /// only the lifetime doing the inserting can be creating a session,
    /// so `insert` stamps its own and ignores whatever is in here.
    ///
    /// This is the epoch recovery reads. A row whose generation is below
    /// the open registry's is one this process INHERITED -- its daemon is
    /// gone, and with it every PTY master it held, so nothing is hosting
    /// that session any more. A row at the current generation is one this
    /// very process is hosting. That distinction used to be implicit in
    /// "recover() runs once, before the socket is bound"; naming it means
    /// a consumer can be told rather than left to infer it.
    pub generation: i64,
    /// This row's process was killed with a previous daemon and the
    /// command it carried was deliberately NOT re-run: what occupies the
    /// session now is a bare shell in the same cwd. Set by `recover`,
    /// never cleared -- see `mark_interrupted`.
    pub interrupted: bool,
}

pub struct Registry {
    conn: Connection,
    generation: i64,
}

impl Registry {
    /// Opening the registry BEGINS a daemon lifetime: the stored
    /// generation is bumped once, here, so every row already in the table
    /// is stamped with an older one. That is what makes "this row is from
    /// a previous lifetime, its process is gone" a fact the daemon can
    /// state instead of infer.
    ///
    /// The bump is unconditional and happens before anything reads the
    /// table, so a crash mid-lifetime is indistinguishable from a clean
    /// exit -- which is the point. A clean-shutdown marker would have to
    /// be WRITTEN on the way out, and the failures this exists for (a
    /// power cut, a SIGTERM with no handler) are exactly the ones that
    /// never reach that code.
    pub fn open(path: &std::path::Path) -> anyhow::Result<Self> {
        let conn = Connection::open(path)?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                workspace_path TEXT NOT NULL,
                cwd TEXT NOT NULL,
                command TEXT,
                status TEXT NOT NULL DEFAULT 'idle',
                restored INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS registry_meta (
                key TEXT PRIMARY KEY,
                value INTEGER NOT NULL
            )",
        )?;
        // Migrations for a database written before v20. `ALTER TABLE ADD
        // COLUMN` has no IF NOT EXISTS in SQLite, and re-running it is a
        // plain error rather than a corruption risk, so the duplicate is
        // swallowed rather than probed for with a pragma.
        //
        // generation DEFAULT 0 is deliberate: every pre-existing row
        // predates the counter, and 0 is below the first generation this
        // open() writes, so a legacy row reads as inherited -- which it
        // is.
        for stmt in [
            "ALTER TABLE sessions ADD COLUMN generation INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE sessions ADD COLUMN interrupted INTEGER NOT NULL DEFAULT 0",
        ] {
            let _ = conn.execute(stmt, []);
        }
        let previous: i64 = conn
            .query_row(
                "SELECT value FROM registry_meta WHERE key = 'generation'",
                [],
                |row| row.get(0),
            )
            .unwrap_or(0);
        let generation = previous + 1;
        conn.execute(
            "INSERT INTO registry_meta (key, value) VALUES ('generation', ?1)
             ON CONFLICT(key) DO UPDATE SET value = ?1",
            params![generation],
        )?;
        Ok(Self { conn, generation })
    }

    /// The lifetime this registry was opened in. Rows below it are
    /// inherited; rows at it belong to this process.
    pub fn generation(&self) -> i64 {
        self.generation
    }

    pub fn insert(&self, record: &SessionRecord) -> anyhow::Result<()> {
        self.conn.execute(
            "INSERT INTO sessions (id, workspace_path, cwd, command, status, restored, generation, interrupted)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                record.id,
                record.workspace_path,
                record.cwd,
                record.command,
                record.status.as_str(),
                record.restored as i64,
                // Stamped, not taken from the record: see SessionRecord::generation.
                self.generation,
                record.interrupted as i64,
            ],
        )?;
        Ok(())
    }

    /// Records that this row's process died with a previous daemon and
    /// its command was not re-run.
    ///
    /// One-way, unlike `restored`, which `write_input` clears the moment
    /// the human types. Typing into the bare shell recovery left behind
    /// does not make the interrupted run un-interrupted -- the agent that
    /// was working is still gone, and the card, step or commit record
    /// bound to this id is still describing work nothing is doing. The
    /// human resolves that by resuming (a NEW session, a new binding), not
    /// by pressing a key.
    pub fn mark_interrupted(&self, id: &str) -> anyhow::Result<()> {
        self.conn
            .execute("UPDATE sessions SET interrupted = 1 WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn update_status(&self, id: &str, status: SessionStatus) -> anyhow::Result<()> {
        self.conn.execute(
            "UPDATE sessions SET status = ?1 WHERE id = ?2",
            params![status.as_str(), id],
        )?;
        Ok(())
    }

    pub fn mark_restored(&self, id: &str) -> anyhow::Result<()> {
        self.conn
            .execute("UPDATE sessions SET restored = 1 WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn clear_restored(&self, id: &str) -> anyhow::Result<()> {
        self.conn
            .execute("UPDATE sessions SET restored = 0 WHERE id = ?1 AND restored = 1", params![id])?;
        Ok(())
    }

    pub fn remove(&self, id: &str) -> anyhow::Result<()> {
        self.conn.execute("DELETE FROM sessions WHERE id = ?1", params![id])?;
        Ok(())
    }

    pub fn list(&self) -> anyhow::Result<Vec<SessionRecord>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, workspace_path, cwd, command, status, restored, generation, interrupted FROM sessions",
        )?;
        let rows = stmt.query_map([], |row| {
            let status_str: String = row.get(4)?;
            let restored: i64 = row.get(5)?;
            let interrupted: i64 = row.get(7)?;
            Ok(SessionRecord {
                id: row.get(0)?,
                workspace_path: row.get(1)?,
                cwd: row.get(2)?,
                command: row.get(3)?,
                status: SessionStatus::from_str(&status_str),
                restored: restored != 0,
                generation: row.get(6)?,
                interrupted: interrupted != 0,
            })
        })?;
        let mut result = Vec::new();
        for row in rows {
            result.push(row?);
        }
        Ok(result)
    }

    pub fn update_cwd(&self, id: &str, cwd: &str) -> anyhow::Result<()> {
        self.conn.execute(
            "UPDATE sessions SET cwd = ?1 WHERE id = ?2",
            params![cwd, id],
        )?;
        Ok(())
    }

    pub fn get(&self, id: &str) -> anyhow::Result<Option<SessionRecord>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, workspace_path, cwd, command, status, restored, generation, interrupted FROM sessions WHERE id = ?1",
        )?;
        let mut rows = stmt.query_map(params![id], |row| {
            let status_str: String = row.get(4)?;
            let restored: i64 = row.get(5)?;
            let interrupted: i64 = row.get(7)?;
            Ok(SessionRecord {
                id: row.get(0)?,
                workspace_path: row.get(1)?,
                cwd: row.get(2)?,
                command: row.get(3)?,
                status: SessionStatus::from_str(&status_str),
                restored: restored != 0,
                generation: row.get(6)?,
                interrupted: interrupted != 0,
            })
        })?;
        match rows.next() {
            Some(row) => Ok(Some(row?)),
            None => Ok(None),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_record(id: &str) -> SessionRecord {
        SessionRecord {
            id: id.to_string(),
            workspace_path: "/tmp/ws".to_string(),
            cwd: "/tmp/ws".to_string(),
            command: None,
            status: SessionStatus::Idle,
            restored: false,
            // Ignored on insert -- the registry stamps its own (see
            // SessionRecord::generation).
            generation: 0,
            interrupted: false,
        }
    }

    #[test]
    fn insert_and_list_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(&dir.path().join("registry.sqlite")).unwrap();
        registry.insert(&test_record("s1")).unwrap();

        let sessions = registry.list().unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].id, "s1");
        assert_eq!(sessions[0].status, SessionStatus::Idle);
        assert_eq!(sessions[0].restored, false);
    }

    #[test]
    fn update_status_persists() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(&dir.path().join("registry.sqlite")).unwrap();
        registry.insert(&test_record("s1")).unwrap();

        registry.update_status("s1", SessionStatus::Working).unwrap();

        let sessions = registry.list().unwrap();
        assert_eq!(sessions[0].status, SessionStatus::Working);
    }

    #[test]
    fn mark_restored_persists() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(&dir.path().join("registry.sqlite")).unwrap();
        registry.insert(&test_record("s1")).unwrap();

        registry.mark_restored("s1").unwrap();

        let sessions = registry.list().unwrap();
        assert_eq!(sessions[0].restored, true);
    }

    #[test]
    fn clear_restored_persists() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(&dir.path().join("registry.sqlite")).unwrap();
        registry.insert(&test_record("s1")).unwrap();
        registry.mark_restored("s1").unwrap();

        registry.clear_restored("s1").unwrap();

        let sessions = registry.list().unwrap();
        assert_eq!(sessions[0].restored, false);
    }

    #[test]
    fn clear_restored_on_an_already_clear_record_is_a_harmless_no_op() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(&dir.path().join("registry.sqlite")).unwrap();
        registry.insert(&test_record("s1")).unwrap();

        registry.clear_restored("s1").unwrap();

        let sessions = registry.list().unwrap();
        assert_eq!(sessions[0].restored, false);
    }

    #[test]
    fn remove_deletes_record() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(&dir.path().join("registry.sqlite")).unwrap();
        registry.insert(&test_record("s1")).unwrap();

        registry.remove("s1").unwrap();

        assert_eq!(registry.list().unwrap().len(), 0);
    }

    #[test]
    fn registry_survives_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("registry.sqlite");
        {
            let registry = Registry::open(&db_path).unwrap();
            registry.insert(&test_record("s1")).unwrap();
        }
        let registry = Registry::open(&db_path).unwrap();
        let sessions = registry.list().unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].id, "s1");
    }

    #[test]
    fn update_cwd_persists() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(&dir.path().join("registry.sqlite")).unwrap();
        registry.insert(&test_record("s1")).unwrap();

        registry.update_cwd("s1", "/Users/alice/new-project").unwrap();

        let sessions = registry.list().unwrap();
        assert_eq!(sessions[0].cwd, "/Users/alice/new-project");
    }

    #[test]
    fn opening_the_registry_bumps_the_generation_every_time() {
        // The whole epoch rests on this: opening IS a daemon lifetime, so
        // two opens of one file are two lifetimes even when nothing in
        // between wrote a thing.
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("registry.sqlite");
        let first = Registry::open(&db_path).unwrap().generation();
        let second = Registry::open(&db_path).unwrap().generation();
        let third = Registry::open(&db_path).unwrap().generation();
        assert_eq!((first, second, third), (1, 2, 3));
    }

    #[test]
    fn a_row_reads_as_inherited_by_the_next_lifetime_and_owned_by_its_own() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("registry.sqlite");
        {
            let registry = Registry::open(&db_path).unwrap();
            registry.insert(&test_record("s1")).unwrap();
            let mine = &registry.list().unwrap()[0];
            assert_eq!(mine.generation, registry.generation(), "its own lifetime hosts it");
        }
        let next = Registry::open(&db_path).unwrap();
        let inherited = &next.list().unwrap()[0];
        assert!(
            inherited.generation < next.generation(),
            "a row from a previous lifetime must read as inherited: {inherited:?} vs generation {}",
            next.generation()
        );
    }

    #[test]
    fn insert_stamps_the_registrys_own_generation_over_whatever_the_caller_put_there() {
        // Only the lifetime doing the inserting can be creating a
        // session, so a caller cannot claim a row for another one.
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(&dir.path().join("registry.sqlite")).unwrap();
        let mut record = test_record("s1");
        record.generation = 999;
        registry.insert(&record).unwrap();

        assert_eq!(registry.list().unwrap()[0].generation, registry.generation());
    }

    #[test]
    fn mark_interrupted_persists_and_survives_a_reopen() {
        // Unlike `restored`, nothing clears this -- so it has to still be
        // true for the lifetime after the one that set it, which is where
        // every consumer reads it.
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("registry.sqlite");
        {
            let registry = Registry::open(&db_path).unwrap();
            registry.insert(&test_record("s1")).unwrap();
            registry.mark_interrupted("s1").unwrap();
            assert_eq!(registry.list().unwrap()[0].interrupted, true);
        }
        let registry = Registry::open(&db_path).unwrap();
        assert_eq!(registry.list().unwrap()[0].interrupted, true);
    }

    #[test]
    fn writing_input_clears_restored_but_never_interrupted() {
        // The asymmetry that keeps every surface honest: typing into the
        // bare shell recovery left behind dismisses the badge, and does
        // not make the run that was killed un-killed.
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(&dir.path().join("registry.sqlite")).unwrap();
        registry.insert(&test_record("s1")).unwrap();
        registry.mark_restored("s1").unwrap();
        registry.mark_interrupted("s1").unwrap();

        registry.clear_restored("s1").unwrap();

        let record = registry.get("s1").unwrap().unwrap();
        assert_eq!(record.restored, false);
        assert_eq!(record.interrupted, true);
    }

    #[test]
    fn a_fresh_record_is_neither_interrupted_nor_from_an_earlier_generation() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(&dir.path().join("registry.sqlite")).unwrap();
        registry.insert(&test_record("s1")).unwrap();

        let record = registry.get("s1").unwrap().unwrap();
        assert_eq!(record.interrupted, false);
        assert_eq!(record.generation, registry.generation());
    }

    #[test]
    fn a_pre_v20_database_migrates_with_its_rows_reading_as_inherited() {
        // The upgrade path: a registry.sqlite written before the epoch
        // existed has neither column and no meta table. Its rows predate
        // every generation this counter will ever issue, and 0 < 1 is
        // what makes them read as inherited on the very first open --
        // which is the truth, since the daemon that wrote them is gone.
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("registry.sqlite");
        {
            let conn = Connection::open(&db_path).unwrap();
            conn.execute_batch(
                "CREATE TABLE sessions (
                    id TEXT PRIMARY KEY,
                    workspace_path TEXT NOT NULL,
                    cwd TEXT NOT NULL,
                    command TEXT,
                    status TEXT NOT NULL DEFAULT 'idle',
                    restored INTEGER NOT NULL DEFAULT 0
                );
                INSERT INTO sessions (id, workspace_path, cwd, command, status, restored)
                VALUES ('old', '/tmp/ws', '/tmp/ws', 'claude prompt', 'working', 0)",
            )
            .unwrap();
        }

        let registry = Registry::open(&db_path).unwrap();
        let record = registry.get("old").unwrap().unwrap();
        assert_eq!(record.generation, 0);
        assert!(record.generation < registry.generation());
        assert_eq!(record.interrupted, false);
        assert_eq!(record.command.as_deref(), Some("claude prompt"));
    }

    #[test]
    fn get_returns_the_matching_record_or_none() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(&dir.path().join("registry.sqlite")).unwrap();
        registry.insert(&test_record("s1")).unwrap();

        let found = registry.get("s1").unwrap();
        assert_eq!(found.map(|r| r.id), Some("s1".to_string()));

        let missing = registry.get("does-not-exist").unwrap();
        assert!(missing.is_none());
    }
}
