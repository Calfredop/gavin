use crate::proc::ProcessHandle;
use protocol::QueuedInput;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::os::unix::fs::PermissionsExt;

/// Tightens a database file to owner-only (0600), matching the socket
/// beside it (`server::bind_server`) and the app-support directory around
/// it (`main`). Same-user reading is the accepted boundary here (see
/// `docs/security`), so this closes the one gap left: a `registry.sqlite`,
/// `kanban.sqlite` or `orchestration.sqlite` created at the OS default
/// (0644 under a typical umask) is readable by every other account on the
/// machine.
///
/// Called on every open, not just the first that creates the file, and
/// there is no on-disk marker for a file mode the way there is for a
/// schema version -- so reasserting the mode unconditionally is the whole
/// migration for a database written before this existed.
pub fn secure_db_file(path: &std::path::Path) -> anyhow::Result<()> {
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    Ok(())
}

/// The daemon's clock, in microseconds since the epoch.
///
/// Saturates at 0 rather than panicking on a pre-epoch clock: a machine
/// whose date is wrong should not take the daemon down, and a timestamp
/// only ever decorates a queued follow-up ("waiting 4m") -- ordering is
/// the list's job, never this number's.
fn now_us() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_micros() as i64)
        .unwrap_or(0)
}

/// Rebuilds a handle from the pair of nullable columns that store one.
///
/// Both or neither: a pid with no start time is not an identity, and the
/// only safe reading of a half-written pair is "unknown", which every
/// caller then treats as gone. Stated once here so no read site can
/// invent the lenient version.
fn handle_from(pid: Option<i64>, started_at_us: Option<i64>) -> Option<ProcessHandle> {
    match (pid, started_at_us) {
        (Some(pid), Some(started_at_us)) if pid > 0 => Some(ProcessHandle {
            pid: pid as u32,
            started_at_us,
        }),
        _ => None,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum SessionStatus {
    Idle,
    Working,
    WaitingForInput,
    Exited,
    /// The agent stopped because something BROKE, not because its turn
    /// ended. A live process at a prompt, exactly like `Idle` -- and the
    /// whole reason this variant exists is that those two were
    /// indistinguishable, so a rail marked a step done on work that never
    /// happened. See `server.rs`'s failure detection.
    Failed,
    /// A status string this build does not recognise -- written by a
    /// NEWER daemon into the same registry, and read back here.
    ///
    /// Deliberately not `Idle`, which is what the old fallback did. For
    /// this feature that default was exactly backwards: `idle` is the one
    /// value that marks rail steps DONE, so a future "the agent broke"
    /// status persisted by a v22 daemon and read by this one would
    /// advance a rail on the strength of not being understood. Unknown
    /// means unknown, and every consumer that treats it as anything else
    /// has to say so.
    Unknown,
}

impl SessionStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            SessionStatus::Idle => "idle",
            SessionStatus::Working => "working",
            SessionStatus::WaitingForInput => "waiting_for_input",
            SessionStatus::Exited => "exited",
            SessionStatus::Failed => "failed",
            // Round-trips as itself rather than as any real status: a row
            // this build could not read must not be REWRITTEN as one it
            // invented, or the newer daemon that wrote it loses the fact
            // on the way back.
            SessionStatus::Unknown => "unknown",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s {
            "idle" => SessionStatus::Idle,
            "working" => SessionStatus::Working,
            "waiting_for_input" => SessionStatus::WaitingForInput,
            "exited" => SessionStatus::Exited,
            "failed" => SessionStatus::Failed,
            _ => SessionStatus::Unknown,
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
    /// gone, and with it every PTY master it held, so nothing gavin hosts
    /// is running that session any more. A row at the current generation
    /// is one this very process is hosting. That distinction used to be
    /// implicit in "recover() runs once, before the socket is bound";
    /// naming it means a consumer can be told rather than left to infer
    /// it.
    ///
    /// What it does NOT say -- and what this comment used to claim by
    /// running "nothing is hosting that session" one clause too far --
    /// is that the session's PROCESS is gone. It isn't necessarily.
    /// Closing a PTY master reaches the child only as a SIGHUP, and a
    /// child that ignores SIGHUP survives it, reparented to init
    /// (verified under a temp $HOME; see `proc`). The epoch describes a
    /// daemon lifetime and cannot answer a question about a process even
    /// in principle, which is why `process` below exists: recovery
    /// probes rather than infers.
    pub generation: i64,
    /// This row's process was killed with a previous daemon and the
    /// command it carried was deliberately NOT re-run: what occupies the
    /// session now is a bare shell in the same cwd. Set by `recover`,
    /// never cleared -- see `mark_interrupted`.
    ///
    /// "Was killed" is what the daemon INTENDED, not what it verified.
    /// `orphan` is the verified half.
    pub interrupted: bool,
    /// The OS process currently sitting in this session's PTY, as far as
    /// the daemon that spawned it knows.
    ///
    /// Written by whoever spawns -- `create_session` for a new session,
    /// `recover` for the bare shell it puts in an inherited one -- which
    /// is why, unlike `generation`, this one IS taken from the record
    /// rather than stamped: only the caller holds the `Child`.
    ///
    /// `None` for every row written before v21. That reads as "no
    /// identity to check", never as "no process", and the two must not
    /// be confused: an unknown process is exactly the one a probe must
    /// refuse to make claims about.
    pub process: Option<ProcessHandle>,
    /// A process from a PREVIOUS daemon lifetime that recovery probed and
    /// found still alive: nothing gavin hosts is running it, and it is
    /// still in the checkout.
    ///
    /// Distinct from `process` because both can be true of one row at
    /// once -- after recovery the row's `process` is the bare shell the
    /// human is looking at, while this is the agent still editing files
    /// behind it. Persisted rather than kept in memory for the same
    /// reason `interrupted` is: the app learns it on Attach, which
    /// happens once per app process, so a frontend reload must not lose
    /// it -- and neither must a SECOND daemon restart, which is why
    /// `recover` re-probes an existing value instead of overwriting it
    /// blind.
    pub orphan: Option<ProcessHandle>,
    /// Why this session is `Failed`, in one sentence -- the profile's own
    /// error line, or the sleep the daemon watched it through. Persisted
    /// beside the status because the reason travels as a PUSH, and a
    /// frontend reload that lost it would leave a red session with
    /// nothing to say for itself (the same baseline hole cwd and status
    /// were already fixed for).
    ///
    /// Written and cleared together with the status by
    /// `update_status_with_reason`, so the two can never disagree.
    pub failure_reason: Option<String>,
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
            );
            -- v26: follow-ups the human wrote for a busy session, held
            -- here until it goes idle. In the registry rather than a
            -- store of its own because the row this hangs off is a
            -- session, and `remove` below has to be able to take the
            -- queue with it in the same transaction-free breath.
            --
            -- `position` is a sparse ordering, not an index: nothing
            -- renumbers on a delete, and `set_queued_inputs` rewrites
            -- the whole run. The reader orders by it and by rowid, so
            -- two rows that somehow share a position still come back in
            -- a stable, repeatable order rather than an arbitrary one.
            CREATE TABLE IF NOT EXISTS queued_inputs (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                text TEXT NOT NULL,
                created_at_us INTEGER NOT NULL,
                position INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS queued_inputs_by_session
                ON queued_inputs (session_id, position)",
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
        // The four v21 columns are NULLable with no default, unlike the
        // v20 pair above: 0 is a meaningful generation and a meaningful
        // `interrupted`, but there is no pid that means "we never
        // recorded one". NULL is that value, and `handle_from` turns it
        // into the `None` every probe reads as gone.
        for stmt in [
            "ALTER TABLE sessions ADD COLUMN generation INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE sessions ADD COLUMN interrupted INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE sessions ADD COLUMN pid INTEGER",
            "ALTER TABLE sessions ADD COLUMN started_at_us INTEGER",
            "ALTER TABLE sessions ADD COLUMN orphan_pid INTEGER",
            "ALTER TABLE sessions ADD COLUMN orphan_started_at_us INTEGER",
            // v21. Nullable rather than defaulted: no reason is exactly
            // what a session that has not failed has.
            "ALTER TABLE sessions ADD COLUMN failure_reason TEXT",
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
        secure_db_file(path)?;
        Ok(Self { conn, generation })
    }

    /// The lifetime this registry was opened in. Rows below it are
    /// inherited; rows at it belong to this process.
    pub fn generation(&self) -> i64 {
        self.generation
    }

    pub fn insert(&self, record: &SessionRecord) -> anyhow::Result<()> {
        self.conn.execute(
            "INSERT INTO sessions (id, workspace_path, cwd, command, status, restored, generation, interrupted, pid, started_at_us, failure_reason)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
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
                // Taken from the record, unlike `generation`: the caller
                // is the one holding the Child it just spawned.
                record.process.map(|p| p.pid as i64),
                record.process.map(|p| p.started_at_us),
                record.failure_reason,
            ],
        )?;
        Ok(())
    }

    /// Repoints a row at the process now sitting in its PTY.
    ///
    /// `recover` is the only caller that needs it: the row arrives
    /// carrying the previous lifetime's process, that value is what the
    /// orphan probe reads, and once the bare shell is spawned the row has
    /// to describe the shell instead. Writing the pair together (rather
    /// than offering a pid setter) is what keeps a half-identity
    /// unrepresentable.
    pub fn set_process(&self, id: &str, process: Option<ProcessHandle>) -> anyhow::Result<()> {
        self.conn.execute(
            "UPDATE sessions SET pid = ?1, started_at_us = ?2 WHERE id = ?3",
            params![process.map(|p| p.pid as i64), process.map(|p| p.started_at_us), id],
        )?;
        Ok(())
    }

    /// Records -- or clears -- the surviving process this session left
    /// behind.
    ///
    /// `Some` comes from `recover` finding a previous lifetime's process
    /// still alive. `None` comes from the human ending it, or from
    /// `recover` re-probing a previously recorded orphan and finding it
    /// gone. Clearing has to be as easy as setting: an orphan that
    /// exited on its own must stop being reported, or the app would offer
    /// to kill a process that no longer exists.
    pub fn set_orphan(&self, id: &str, orphan: Option<ProcessHandle>) -> anyhow::Result<()> {
        self.conn.execute(
            "UPDATE sessions SET orphan_pid = ?1, orphan_started_at_us = ?2 WHERE id = ?3",
            params![orphan.map(|p| p.pid as i64), orphan.map(|p| p.started_at_us), id],
        )?;
        Ok(())
    }

    /// `end_orphan`'s write: clears the orphan record and reaps this
    /// session's queued follow-ups together, in one transaction.
    ///
    /// Confirming the leftover process is gone is confirming the
    /// conversation it belonged to is over -- a follow-up still held for
    /// it can never be delivered into anything real, so letting it survive
    /// this call would be the same plaintext-retention bug the orphan
    /// clear is fixing, just one column over.
    pub fn clear_orphan_and_reap_queue(&mut self, id: &str) -> anyhow::Result<()> {
        let tx = self.conn.transaction()?;
        tx.execute(
            "UPDATE sessions SET orphan_pid = NULL, orphan_started_at_us = NULL WHERE id = ?1",
            params![id],
        )?;
        tx.execute("DELETE FROM queued_inputs WHERE session_id = ?1", params![id])?;
        tx.commit()?;
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

    /// Any status OTHER than `Failed` clears the failure reason with it.
    /// A session that started talking again, exited, or was asked a
    /// question is no longer describable by the last thing that broke,
    /// and a stale reason on a live session is worse than none: it is the
    /// text every surface would show.
    pub fn update_status(&self, id: &str, status: SessionStatus) -> anyhow::Result<()> {
        self.conn.execute(
            "UPDATE sessions SET status = ?1, failure_reason = NULL WHERE id = ?2",
            params![status.as_str(), id],
        )?;
        Ok(())
    }

    /// The `Failed` counterpart: status and reason written together, so
    /// no reader can ever see one without the other.
    pub fn update_status_failed(&self, id: &str, reason: &str) -> anyhow::Result<()> {
        self.conn.execute(
            "UPDATE sessions SET status = ?1, failure_reason = ?2 WHERE id = ?3",
            params![SessionStatus::Failed.as_str(), reason, id],
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
        // The queue goes with the session. A follow-up outliving the
        // session it was written for is not a message waiting to be
        // delivered -- it is a message that can never be delivered, and
        // keeping it would put an undeliverable row in front of the
        // human on every listing forever. Session ids are uuids, so it
        // cannot be inherited by a later session either.
        self.conn.execute("DELETE FROM queued_inputs WHERE session_id = ?1", params![id])?;
        Ok(())
    }

    /// Appends a follow-up to this session's queue and hands back the
    /// row as stored.
    ///
    /// The position is `max + 1` over this session's rows rather than a
    /// count: `set_queued_inputs` leaves gaps and delivery removes from
    /// the front, so a count would collide with a row that is still
    /// there.
    pub fn queue_input(&self, session_id: &str, text: &str) -> anyhow::Result<QueuedInput> {
        let next: i64 = self
            .conn
            .query_row(
                "SELECT COALESCE(MAX(position), -1) + 1 FROM queued_inputs WHERE session_id = ?1",
                params![session_id],
                |row| row.get(0),
            )
            .unwrap_or(0);
        let queued = QueuedInput {
            id: uuid::Uuid::new_v4().to_string(),
            session_id: session_id.to_string(),
            text: text.to_string(),
            created_at_us: now_us(),
        };
        self.conn.execute(
            "INSERT INTO queued_inputs (id, session_id, text, created_at_us, position)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![queued.id, queued.session_id, queued.text, queued.created_at_us, next],
        )?;
        Ok(queued)
    }

    /// Every session's pending follow-ups, in delivery order -- the
    /// answer to `ListQueuedInputs`.
    pub fn queued_inputs(&self) -> anyhow::Result<Vec<QueuedInput>> {
        self.read_queued("SELECT id, session_id, text, created_at_us FROM queued_inputs ORDER BY session_id, position, rowid", params![])
    }

    /// One session's pending follow-ups, in delivery order.
    pub fn queued_inputs_for(&self, session_id: &str) -> anyhow::Result<Vec<QueuedInput>> {
        self.read_queued(
            "SELECT id, session_id, text, created_at_us FROM queued_inputs
             WHERE session_id = ?1 ORDER BY position, rowid",
            params![session_id],
        )
    }

    fn read_queued(
        &self,
        sql: &str,
        args: impl rusqlite::Params,
    ) -> anyhow::Result<Vec<QueuedInput>> {
        let mut stmt = self.conn.prepare(sql)?;
        let rows = stmt.query_map(args, |row| {
            Ok(QueuedInput {
                id: row.get(0)?,
                session_id: row.get(1)?,
                text: row.get(2)?,
                created_at_us: row.get(3)?,
            })
        })?;
        let mut result = Vec::new();
        for row in rows {
            result.push(row?);
        }
        Ok(result)
    }

    /// Rewrites this session's queue to exactly `ids`, in that order.
    /// Anything of this session's the caller did not name is deleted --
    /// that is how a cancel and a clear are expressed.
    ///
    /// An id belonging to a DIFFERENT session is ignored rather than
    /// stolen: the `session_id` guard on the update is what stops a
    /// client that muddled two lists from silently moving one human's
    /// follow-up onto another agent.
    pub fn set_queued_inputs(&self, session_id: &str, ids: &[String]) -> anyhow::Result<()> {
        for (position, id) in ids.iter().enumerate() {
            self.conn.execute(
                "UPDATE queued_inputs SET position = ?1 WHERE id = ?2 AND session_id = ?3",
                params![position as i64, id, session_id],
            )?;
        }
        // Everything of this session's that survived the caller's list
        // goes. Done AFTER the repositioning, and by exclusion rather
        // than by diffing what was read a moment ago, so a follow-up
        // queued between the client's read and this write is dropped
        // exactly once instead of being left behind at a stale position.
        let mut sql = String::from("DELETE FROM queued_inputs WHERE session_id = ?1");
        if !ids.is_empty() {
            sql.push_str(" AND id NOT IN (");
            for i in 0..ids.len() {
                if i > 0 {
                    sql.push(',');
                }
                sql.push_str(&format!("?{}", i + 2));
            }
            sql.push(')');
        }
        let mut args: Vec<&dyn rusqlite::ToSql> = vec![&session_id];
        for id in ids {
            args.push(id);
        }
        self.conn.execute(&sql, args.as_slice())?;
        Ok(())
    }

    /// Removes one queued follow-up and hands it back -- the read and
    /// the delete together, because a delivery that read the head and
    /// then failed to remove it would deliver the same message on every
    /// subsequent idle.
    ///
    /// `None` when this session's queue does not hold that id, which is
    /// what makes a double delivery a no-op instead of a second paste.
    pub fn take_queued_input(
        &self,
        session_id: &str,
        queued_id: &str,
    ) -> anyhow::Result<Option<QueuedInput>> {
        let found = self
            .read_queued(
                "SELECT id, session_id, text, created_at_us FROM queued_inputs
                 WHERE session_id = ?1 AND id = ?2",
                params![session_id, queued_id],
            )?
            .into_iter()
            .next();
        let Some(queued) = found else { return Ok(None) };
        let removed = self.conn.execute(
            "DELETE FROM queued_inputs WHERE id = ?1 AND session_id = ?2",
            params![queued_id, session_id],
        )?;
        // Someone else took it between the read and the delete. Saying
        // so is what keeps two deliveries racing on one session from
        // both pasting the same follow-up.
        if removed == 0 {
            return Ok(None);
        }
        Ok(Some(queued))
    }


    pub fn list(&self) -> anyhow::Result<Vec<SessionRecord>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, workspace_path, cwd, command, status, restored, generation, interrupted, pid, started_at_us, orphan_pid, orphan_started_at_us, failure_reason FROM sessions",
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
                process: handle_from(row.get(8)?, row.get(9)?),
                orphan: handle_from(row.get(10)?, row.get(11)?),
                failure_reason: row.get(12)?,
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
            "SELECT id, workspace_path, cwd, command, status, restored, generation, interrupted, pid, started_at_us, orphan_pid, orphan_started_at_us, failure_reason FROM sessions WHERE id = ?1",
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
                process: handle_from(row.get(8)?, row.get(9)?),
                orphan: handle_from(row.get(10)?, row.get(11)?),
                failure_reason: row.get(12)?,
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
            process: None,
            orphan: None,
            failure_reason: None,
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

    fn mode_of(path: &std::path::Path) -> u32 {
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    #[test]
    fn a_freshly_opened_database_is_owner_only() {
        // R7: the socket beside it is 0600 (`bind_server`); the database
        // must match rather than be readable by every other account on
        // the machine.
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("registry.sqlite");

        Registry::open(&db_path).unwrap();

        assert_eq!(mode_of(&db_path), 0o600);
    }

    #[test]
    fn opening_a_database_already_at_0644_tightens_it_to_0600() {
        // The upgrade path: a file this fix predates sits on disk at the
        // OS default. There is no schema version for a file mode, so the
        // only migration is reasserting it on every open.
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("registry.sqlite");
        {
            let conn = Connection::open(&db_path).unwrap();
            conn.execute_batch("CREATE TABLE sessions (id TEXT PRIMARY KEY)").unwrap();
        }
        std::fs::set_permissions(&db_path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(mode_of(&db_path), 0o644, "the file must start out loose for this test to mean anything");

        Registry::open(&db_path).unwrap();

        assert_eq!(mode_of(&db_path), 0o600);
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

    fn handle(pid: u32, started_at_us: i64) -> ProcessHandle {
        ProcessHandle { pid, started_at_us }
    }

    #[test]
    fn a_process_handle_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(&dir.path().join("registry.sqlite")).unwrap();
        let mut record = test_record("s1");
        record.process = Some(handle(4172, 1_756_800_000_123_456));

        registry.insert(&record).unwrap();

        assert_eq!(registry.get("s1").unwrap().unwrap().process, record.process);
    }

    #[test]
    fn a_row_that_recorded_no_process_reads_back_as_none() {
        // Every row written before v21, and every session whose child was
        // already gone before its pid could be read. `None` is the value
        // every probe treats as gone.
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(&dir.path().join("registry.sqlite")).unwrap();
        registry.insert(&test_record("s1")).unwrap();

        let record = registry.get("s1").unwrap().unwrap();
        assert_eq!(record.process, None);
        assert_eq!(record.orphan, None);
    }

    #[test]
    fn set_process_repoints_a_row_without_touching_its_orphan() {
        // What recovery does: the row arrives naming the process that
        // died with the last daemon, the orphan probe reads that, and
        // then the row has to name the bare shell instead. Losing the
        // orphan in the process would undo the entire point.
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(&dir.path().join("registry.sqlite")).unwrap();
        let mut record = test_record("s1");
        record.process = Some(handle(100, 111));
        registry.insert(&record).unwrap();
        registry.set_orphan("s1", Some(handle(100, 111))).unwrap();

        registry.set_process("s1", Some(handle(200, 222))).unwrap();

        let after = registry.get("s1").unwrap().unwrap();
        assert_eq!(after.process, Some(handle(200, 222)));
        assert_eq!(after.orphan, Some(handle(100, 111)));
    }

    #[test]
    fn set_orphan_clears_as_easily_as_it_sets() {
        // An orphan that exited on its own, or that the human ended, must
        // stop being reported -- otherwise the app keeps offering to kill
        // a process that is not there.
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(&dir.path().join("registry.sqlite")).unwrap();
        registry.insert(&test_record("s1")).unwrap();

        registry.set_orphan("s1", Some(handle(4172, 999))).unwrap();
        assert_eq!(registry.get("s1").unwrap().unwrap().orphan, Some(handle(4172, 999)));

        registry.set_orphan("s1", None).unwrap();
        assert_eq!(registry.get("s1").unwrap().unwrap().orphan, None);
    }

    #[test]
    fn clear_orphan_and_reap_queue_clears_both_together() {
        // R7: a follow-up queued for the conversation an orphan belonged
        // to can never reach it once that orphan is confirmed gone -- the
        // clear and the reap are one fact, not two calls that might drift.
        let dir = tempfile::tempdir().unwrap();
        let mut registry = Registry::open(&dir.path().join("registry.sqlite")).unwrap();
        registry.insert(&test_record("s1")).unwrap();
        registry.set_orphan("s1", Some(handle(4172, 999))).unwrap();
        registry.queue_input("s1", "pasted while busy").unwrap();

        registry.clear_orphan_and_reap_queue("s1").unwrap();

        assert_eq!(registry.get("s1").unwrap().unwrap().orphan, None);
        assert!(registry.queued_inputs_for("s1").unwrap().is_empty());
    }

    #[test]
    fn a_half_written_handle_reads_as_unknown_rather_than_as_a_pid() {
        // The lenient reading -- "we have a pid, close enough" -- is what
        // would put an unverifiable number behind a kill button. A pid
        // with no start time cannot be matched against anything, so the
        // only safe value is None.
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("registry.sqlite");
        let registry = Registry::open(&db_path).unwrap();
        registry.insert(&test_record("s1")).unwrap();
        registry
            .conn
            .execute("UPDATE sessions SET pid = 4172 WHERE id = 's1'", [])
            .unwrap();

        assert_eq!(registry.get("s1").unwrap().unwrap().process, None);
    }

    #[test]
    fn a_database_written_before_v21_gains_the_columns_without_losing_its_rows() {
        // The migration, exercised the way it will actually run: a table
        // created by an older daemon, reopened by this one.
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
                INSERT INTO sessions (id, workspace_path, cwd, command)
                VALUES ('old-1', '/tmp/ws', '/tmp/ws', 'claude')",
            )
            .unwrap();
        }

        let registry = Registry::open(&db_path).unwrap();

        let record = registry.get("old-1").unwrap().unwrap();
        assert_eq!(record.command.as_deref(), Some("claude"));
        assert_eq!(record.process, None, "an unmigrated row knows no process");
        assert_eq!(record.orphan, None);
    }

    fn queue_texts(registry: &Registry, session_id: &str) -> Vec<String> {
        registry
            .queued_inputs_for(session_id)
            .unwrap()
            .into_iter()
            .map(|q| q.text)
            .collect()
    }

    #[test]
    fn queued_follow_ups_come_back_in_the_order_they_were_written() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(&dir.path().join("registry.sqlite")).unwrap();
        registry.insert(&test_record("s1")).unwrap();

        registry.queue_input("s1", "first").unwrap();
        registry.queue_input("s1", "second").unwrap();
        registry.queue_input("s1", "third").unwrap();

        assert_eq!(queue_texts(&registry, "s1"), ["first", "second", "third"]);
    }

    #[test]
    fn a_queue_is_per_session_and_the_global_read_carries_every_one() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(&dir.path().join("registry.sqlite")).unwrap();
        registry.insert(&test_record("s1")).unwrap();
        registry.insert(&test_record("s2")).unwrap();

        registry.queue_input("s1", "for one").unwrap();
        registry.queue_input("s2", "for two").unwrap();

        assert_eq!(queue_texts(&registry, "s1"), ["for one"]);
        assert_eq!(queue_texts(&registry, "s2"), ["for two"]);
        // ListQueuedInputs is what a reloaded frontend re-reads, so it
        // has to answer for sessions whose tabs it has not attached yet.
        assert_eq!(registry.queued_inputs().unwrap().len(), 2);
    }

    #[test]
    fn setting_the_queue_reorders_what_it_names_and_drops_what_it_does_not() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(&dir.path().join("registry.sqlite")).unwrap();
        registry.insert(&test_record("s1")).unwrap();
        let a = registry.queue_input("s1", "a").unwrap();
        let b = registry.queue_input("s1", "b").unwrap();
        let c = registry.queue_input("s1", "c").unwrap();

        // The drag and the cancel in one write, which is the whole
        // reason there is one writer: "c, a" says both that c leads now
        // and that b is gone.
        registry.set_queued_inputs("s1", &[c.id.clone(), a.id.clone()]).unwrap();

        assert_eq!(queue_texts(&registry, "s1"), ["c", "a"]);
        assert!(
            registry.queued_inputs().unwrap().iter().all(|q| q.id != b.id),
            "an entry the caller did not name is deleted, not left at a stale position"
        );
    }

    #[test]
    fn an_empty_set_clears_the_queue() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(&dir.path().join("registry.sqlite")).unwrap();
        registry.insert(&test_record("s1")).unwrap();
        registry.queue_input("s1", "a").unwrap();
        registry.queue_input("s1", "b").unwrap();

        registry.set_queued_inputs("s1", &[]).unwrap();

        assert!(queue_texts(&registry, "s1").is_empty());
    }

    #[test]
    fn setting_one_sessions_queue_cannot_move_another_sessions_entry() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(&dir.path().join("registry.sqlite")).unwrap();
        registry.insert(&test_record("s1")).unwrap();
        registry.insert(&test_record("s2")).unwrap();
        registry.queue_input("s1", "mine").unwrap();
        let theirs = registry.queue_input("s2", "theirs").unwrap();

        // A client that muddled two lists. The foreign id is ignored;
        // "s1 now holds nothing I named" still empties s1, and s2's
        // follow-up is untouched rather than stolen.
        registry.set_queued_inputs("s1", &[theirs.id.clone()]).unwrap();

        assert!(queue_texts(&registry, "s1").is_empty());
        assert_eq!(queue_texts(&registry, "s2"), ["theirs"]);
    }

    #[test]
    fn taking_a_follow_up_removes_it_and_taking_it_twice_yields_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(&dir.path().join("registry.sqlite")).unwrap();
        registry.insert(&test_record("s1")).unwrap();
        let a = registry.queue_input("s1", "a").unwrap();
        registry.queue_input("s1", "b").unwrap();

        let taken = registry.take_queued_input("s1", &a.id).unwrap();
        assert_eq!(taken.map(|q| q.text), Some("a".to_string()));
        assert_eq!(queue_texts(&registry, "s1"), ["b"]);

        // The double-delivery guard: two idle transitions racing on one
        // session must not paste the same follow-up twice.
        assert!(registry.take_queued_input("s1", &a.id).unwrap().is_none());
    }

    #[test]
    fn taking_a_named_follow_up_skips_the_head() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(&dir.path().join("registry.sqlite")).unwrap();
        registry.insert(&test_record("s1")).unwrap();
        registry.queue_input("s1", "a").unwrap();
        let b = registry.queue_input("s1", "b").unwrap();

        // "Send now" on the second entry: one request, rather than a
        // reorder racing a send.
        let taken = registry.take_queued_input("s1", &b.id).unwrap();

        assert_eq!(taken.map(|q| q.text), Some("b".to_string()));
        assert_eq!(queue_texts(&registry, "s1"), ["a"]);
    }

    #[test]
    fn reading_an_empty_queue_is_an_empty_list_not_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(&dir.path().join("registry.sqlite")).unwrap();
        registry.insert(&test_record("s1")).unwrap();

        // What every idle transition on a session nobody queued
        // anything for hits, which is nearly all of them.
        assert!(registry.queued_inputs_for("s1").unwrap().is_empty());
        assert!(registry.take_queued_input("s1", "nothing").unwrap().is_none());
    }

    #[test]
    fn queueing_after_a_delivery_does_not_reuse_the_delivered_position() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(&dir.path().join("registry.sqlite")).unwrap();
        registry.insert(&test_record("s1")).unwrap();
        let a = registry.queue_input("s1", "a").unwrap();
        registry.queue_input("s1", "b").unwrap();

        // Delivery removes from the FRONT, so a position derived from a
        // count would land on top of "b" and make the order arbitrary.
        registry.take_queued_input("s1", &a.id).unwrap();
        registry.queue_input("s1", "c").unwrap();

        assert_eq!(queue_texts(&registry, "s1"), ["b", "c"]);
    }

    #[test]
    fn removing_a_session_takes_its_queue_with_it() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(&dir.path().join("registry.sqlite")).unwrap();
        registry.insert(&test_record("s1")).unwrap();
        registry.insert(&test_record("s2")).unwrap();
        registry.queue_input("s1", "goes").unwrap();
        registry.queue_input("s2", "stays").unwrap();

        registry.remove("s1").unwrap();

        // Not tidiness: a follow-up whose session is gone can never be
        // delivered, and would sit in every listing forever.
        assert!(queue_texts(&registry, "s1").is_empty());
        assert_eq!(queue_texts(&registry, "s2"), ["stays"]);
    }

    #[test]
    fn killing_a_session_leaves_no_queued_rows_behind() {
        // R7: `KillSession` reaches this through `forget_session` ->
        // `remove`, and is exactly the path a security review has to
        // trust -- pasted text must not outlive the session it was typed
        // for by sitting in the database under an id nothing hosts any
        // more.
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(&dir.path().join("registry.sqlite")).unwrap();
        registry.insert(&test_record("s1")).unwrap();
        registry.queue_input("s1", "pasted secret").unwrap();

        registry.remove("s1").unwrap();

        assert!(registry.queued_inputs().unwrap().is_empty());
    }

    #[test]
    fn a_queue_survives_the_registry_being_reopened() {
        // The whole reason the queue lives in the daemon: the human
        // queues a follow-up BECAUSE the agent will be busy a while, and
        // an app they close in the meantime must not take it with them.
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("registry.sqlite");
        {
            let registry = Registry::open(&db_path).unwrap();
            registry.insert(&test_record("s1")).unwrap();
            registry.queue_input("s1", "still here").unwrap();
        }

        let registry = Registry::open(&db_path).unwrap();

        assert_eq!(queue_texts(&registry, "s1"), ["still here"]);
    }

    #[test]
    fn a_database_written_before_v26_gains_the_queue_table() {
        // The trap this exists for: `CREATE TABLE IF NOT EXISTS` is a
        // no-op against a database that already has the OTHER tables, so
        // a new table has to be proved against a real older DB rather
        // than against the fresh tempdir every other test here uses.
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
                CREATE TABLE registry_meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
                INSERT INTO sessions (id, workspace_path, cwd, command)
                VALUES ('old-1', '/tmp/ws', '/tmp/ws', 'claude')",
            )
            .unwrap();
        }

        let registry = Registry::open(&db_path).unwrap();
        registry.queue_input("old-1", "works on an old db").unwrap();

        assert_eq!(queue_texts(&registry, "old-1"), ["works on an old db"]);
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
