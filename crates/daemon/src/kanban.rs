use protocol::{Board, CardRun, CardSession, Column, Label};
use rusqlite::{params, Connection};

/// The three canonical statuses (D6's vocabulary). Permanent: the board
/// UI never deletes them, and get_board re-adds any that went missing --
/// so "permanent" holds even against an older board or a stale client,
/// not just the current UI.
const PERMANENT_COLUMNS: [&str; 3] = ["To Do", "In Progress", "Done"];

/// Wall-clock seconds, for the run history's own timestamps. Saturated
/// at 0 rather than propagating an error: a clock set before 1970 is not
/// a reason to refuse a card launch.
fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Mirrors the frontend's slugStatus: lowercase, every run of
/// non-alphanumerics collapsed to one "-", trimmed.
fn column_slug(name: &str) -> String {
    let mut out = String::new();
    let mut last_dash = true;
    for c in name.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    out.trim_matches('-').to_string()
}

pub struct KanbanStore {
    conn: Connection,
}

impl KanbanStore {
    pub fn open(path: &std::path::Path) -> anyhow::Result<Self> {
        let conn = Connection::open(path)?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS kanban_boards (
                workspace_id TEXT PRIMARY KEY
            );
            CREATE TABLE IF NOT EXISTS kanban_columns (
                id TEXT PRIMARY KEY,
                workspace_id TEXT NOT NULL,
                name TEXT NOT NULL,
                position INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS kanban_labels (
                id TEXT PRIMARY KEY,
                workspace_id TEXT NOT NULL,
                name TEXT NOT NULL,
                color TEXT NOT NULL
            );
            -- The card model made every card a file (card-model spec §1,
            -- C5: dev-state wipe, no migration): SQLite keeps only the
            -- column and label vocabularies. Leftover card tables from
            -- earlier builds are dropped outright.
            CREATE TABLE IF NOT EXISTS card_sessions (
                workspace_id TEXT NOT NULL,
                path TEXT NOT NULL,
                session_id TEXT NOT NULL,
                cwd TEXT NOT NULL,
                command TEXT,
                -- v21: the agent CLI's own conversation id for this run,
                -- and the directory it was LAUNCHED in (`cwd` above
                -- follows OSC 7 and drifts the moment the agent `cd`s).
                -- Both nullable: a profile with no verified resume argv
                -- records neither.
                conversation_id TEXT,
                launch_cwd TEXT,
                -- v22: how many times gavin resumed this run BY ITSELF.
                -- The budget for unattended recovery, on disk because an
                -- app reload and a daemon restart are the conditions it
                -- runs under -- an in-memory counter would reset on the
                -- very events it is supposed to survive.
                resume_attempts INTEGER,
                -- v26: the commit this run's checkout was on when the
                -- agent started. The baseline the Changes view diffs
                -- against and the commit a discard resets to; nullable
                -- because a run outside a repo, on an unborn HEAD, or
                -- launched against a daemon that could not store it has
                -- none -- an absent baseline, never an empty diff.
                base_sha TEXT,
                PRIMARY KEY (workspace_id, path)
            );
            -- v27: the run history `card_sessions` above cannot keep.
            -- That table is upserted by (workspace_id, path), so it holds
            -- the LIVE binding and the previous run is gone the instant
            -- the next one launches. This one is append-only: a row per
            -- session a card was ever bound to, opened and closed by the
            -- daemon off the links and exits it already sees.
            --
            -- Its own started_at/ended_at rather than a join onto the
            -- registry: the registry's `started_at_us` is a process start
            -- time kept as a pid-reuse guard, not a wall clock, and it
            -- has no end time at all.
            CREATE TABLE IF NOT EXISTS card_runs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                workspace_id TEXT NOT NULL,
                path TEXT NOT NULL,
                session_id TEXT NOT NULL,
                command TEXT,
                conversation_id TEXT,
                launch_cwd TEXT,
                base_sha TEXT,
                started_at INTEGER NOT NULL,
                ended_at INTEGER,
                exit_code INTEGER,
                -- running | exited | replaced | unlinked | abandoned.
                -- Never null. An end nobody observed is spelled
                -- `abandoned`, which is a fact about the daemon, not an
                -- absence of one about the run.
                outcome TEXT NOT NULL,
                resume_attempts INTEGER
            );
            CREATE INDEX IF NOT EXISTS card_runs_by_card
                ON card_runs (workspace_id, path, id);
            CREATE INDEX IF NOT EXISTS card_runs_by_session
                ON card_runs (session_id);
            DROP TABLE IF EXISTS kanban_card_labels;
            DROP TABLE IF EXISTS kanban_cards;",
        )?;
        // The two v21 columns above only reach a database created by
        // this build: `CREATE TABLE IF NOT EXISTS` is a no-op against the
        // card_sessions every existing install already has, and
        // `read_board` selects both by name -- so without this the board
        // stops loading entirely ("no such column: conversation_id") the
        // moment a v21 daemon opens a v20 file. Same swallow-the-duplicate
        // idiom as registry.rs: SQLite has no ADD COLUMN IF NOT EXISTS,
        // and re-running one is a plain error, not a corruption risk.
        for stmt in [
            "ALTER TABLE card_sessions ADD COLUMN conversation_id TEXT",
            "ALTER TABLE card_sessions ADD COLUMN launch_cwd TEXT",
            "ALTER TABLE card_sessions ADD COLUMN resume_attempts INTEGER",
            "ALTER TABLE card_sessions ADD COLUMN base_sha TEXT",
        ] {
            let _ = conn.execute(stmt, []);
        }
        // Every run still open belongs to a daemon that is gone: this
        // runs once per process, before any launch of this lifetime has
        // reached the store, so an open row here is by construction one
        // this process inherited. `ended_at` stays NULL rather than being
        // back-filled with now() -- the run ended when its daemon did,
        // and nobody watched that happen.
        conn.execute(
            "UPDATE card_runs SET outcome = 'abandoned' WHERE ended_at IS NULL AND outcome = 'running'",
            [],
        )?;
        Ok(Self { conn })
    }

    /// If this workspace has never had a board (no `kanban_boards` row),
    /// seeds and persists the default three-column board before reading --
    /// so this call is always idempotent, and every response is
    /// well-formed. Existence is tracked via `kanban_boards`, a dedicated
    /// marker table, rather than "zero columns": a user can legitimately
    /// delete every column of a board they've actually used, and that
    /// must not look like "never touched" and get silently reseeded.
    pub fn get_board(&mut self, workspace_id: &str) -> anyhow::Result<Board> {
        let exists: bool = self.conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM kanban_boards WHERE workspace_id = ?1)",
            params![workspace_id],
            |row| row.get(0),
        )?;
        if !exists {
            let default_columns = vec![
                Column { id: uuid::Uuid::new_v4().to_string(), name: "To Do".to_string(), position: 0 },
                Column { id: uuid::Uuid::new_v4().to_string(), name: "In Progress".to_string(), position: 1 },
                Column { id: uuid::Uuid::new_v4().to_string(), name: "Done".to_string(), position: 2 },
            ];
            self.replace_board(workspace_id, &default_columns, &[])?;
        }
        let mut board = self.read_board(workspace_id)?;
        let present: std::collections::HashSet<String> =
            board.columns.iter().map(|c| column_slug(&c.name)).collect();
        let missing: Vec<&str> = PERMANENT_COLUMNS
            .iter()
            .copied()
            .filter(|name| !present.contains(&column_slug(name)))
            .collect();
        if !missing.is_empty() {
            for name in missing {
                board.columns.push(Column {
                    id: uuid::Uuid::new_v4().to_string(),
                    name: name.to_string(),
                    position: board.columns.len() as i64,
                });
            }
            self.replace_board(workspace_id, &board.columns, &board.labels)?;
            board = self.read_board(workspace_id)?;
        }
        Ok(board)
    }

    fn read_board(&self, workspace_id: &str) -> anyhow::Result<Board> {
        let mut labels = Vec::new();
        {
            let mut stmt = self
                .conn
                .prepare("SELECT id, name, color FROM kanban_labels WHERE workspace_id = ?1")?;
            let rows = stmt.query_map(params![workspace_id], |row| {
                Ok(Label { id: row.get(0)?, name: row.get(1)?, color: row.get(2)? })
            })?;
            for row in rows {
                labels.push(row?);
            }
        }

        let mut columns = Vec::new();
        {
            let mut stmt = self.conn.prepare(
                "SELECT id, name, position FROM kanban_columns WHERE workspace_id = ?1 ORDER BY position",
            )?;
            let rows = stmt.query_map(params![workspace_id], |row| {
                Ok(Column { id: row.get(0)?, name: row.get(1)?, position: row.get(2)? })
            })?;
            for row in rows {
                columns.push(row?);
            }
        }

        let mut card_sessions = Vec::new();
        {
            let mut stmt = self.conn.prepare(
                "SELECT path, session_id, cwd, command, conversation_id, launch_cwd, resume_attempts, base_sha \
                 FROM card_sessions WHERE workspace_id = ?1",
            )?;
            let rows = stmt.query_map(params![workspace_id], |row| {
                Ok(CardSession {
                    path: row.get(0)?,
                    session_id: row.get(1)?,
                    cwd: row.get(2)?,
                    command: row.get(3)?,
                    conversation_id: row.get(4)?,
                    launch_cwd: row.get(5)?,
                    resume_attempts: row.get::<_, Option<i64>>(6)?.map(|v| v.max(0) as u32),
                    base_sha: row.get(7)?,
                })
            })?;
            for row in rows {
                card_sessions.push(row?);
            }
        }

        Ok(Board { columns, labels, card_sessions })
    }

    /// Deletes every `kanban_*` row for `workspace_id` except the
    /// `kanban_boards` marker itself -- shared by `replace_board` (which
    /// re-inserts fresh rows right after) and `delete_board` (which also
    /// removes the marker, right after calling this).
    fn delete_content_rows(tx: &rusqlite::Transaction, workspace_id: &str) -> anyhow::Result<()> {
        tx.execute("DELETE FROM kanban_columns WHERE workspace_id = ?1", params![workspace_id])?;
        tx.execute("DELETE FROM kanban_labels WHERE workspace_id = ?1", params![workspace_id])?;
        Ok(())
    }

    /// Wholesale replace: deletes every existing row for `workspace_id`
    /// and re-inserts everything from `columns`/`labels`, in one
    /// transaction so a mid-write failure can never leave a half-deleted
    /// board.
    pub fn replace_board(&mut self, workspace_id: &str, columns: &[Column], labels: &[Label]) -> anyhow::Result<()> {
        let tx = self.conn.transaction()?;
        tx.execute("INSERT OR IGNORE INTO kanban_boards (workspace_id) VALUES (?1)", params![workspace_id])?;
        Self::delete_content_rows(&tx, workspace_id)?;

        for label in labels {
            tx.execute(
                "INSERT INTO kanban_labels (id, workspace_id, name, color) VALUES (?1, ?2, ?3, ?4)",
                params![label.id, workspace_id, label.name, label.color],
            )?;
        }
        for column in columns {
            tx.execute(
                "INSERT INTO kanban_columns (id, workspace_id, name, position) VALUES (?1, ?2, ?3, ?4)",
                params![column.id, workspace_id, column.name, column.position],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// The session currently bound to one card, if any. Read on its own
    /// rather than off `get_board` because a claim (`ClaimCardForSession`)
    /// only has to know whether somebody else already owns this one card,
    /// and building the whole board to answer that reads every column,
    /// label and binding the workspace has.
    pub fn card_session(
        &self,
        workspace_id: &str,
        path: &str,
    ) -> anyhow::Result<Option<CardSession>> {
        let mut stmt = self.conn.prepare(
            "SELECT path, session_id, cwd, command, conversation_id, launch_cwd, resume_attempts, base_sha
             FROM card_sessions WHERE workspace_id = ?1 AND path = ?2",
        )?;
        let mut rows = stmt.query_map(params![workspace_id, path], |row| {
            Ok(CardSession {
                path: row.get(0)?,
                session_id: row.get(1)?,
                cwd: row.get(2)?,
                command: row.get(3)?,
                conversation_id: row.get(4)?,
                launch_cwd: row.get(5)?,
                resume_attempts: row.get::<_, Option<i64>>(6)?.map(|v| v.max(0) as u32),
                    base_sha: row.get(7)?,
            })
        })?;
        Ok(rows.next().transpose()?)
    }

    /// Upserts a card file's live session binding (card-model spec §3) --
    /// runtime state keyed by (workspace, path), never written to files.
    pub fn link_card_session(
        &mut self,
        workspace_id: &str,
        path: &str,
        session_id: &str,
        cwd: &str,
        command: Option<&str>,
        conversation_id: Option<&str>,
        launch_cwd: Option<&str>,
        resume_attempts: Option<u32>,
        base_sha: Option<&str>,
    ) -> anyhow::Result<()> {
        self.record_run_for_link(
            workspace_id,
            path,
            session_id,
            command,
            conversation_id,
            launch_cwd,
            resume_attempts,
            base_sha,
        )?;
        self.conn.execute(
            "INSERT INTO card_sessions (workspace_id, path, session_id, cwd, command, conversation_id, launch_cwd, resume_attempts, base_sha)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(workspace_id, path) DO UPDATE SET
               session_id = excluded.session_id, cwd = excluded.cwd, command = excluded.command,
               conversation_id = excluded.conversation_id, launch_cwd = excluded.launch_cwd,
               resume_attempts = excluded.resume_attempts, base_sha = excluded.base_sha",
            params![
                workspace_id,
                path,
                session_id,
                cwd,
                command,
                conversation_id,
                launch_cwd,
                resume_attempts.map(i64::from),
                base_sha
            ],
        )?;
        Ok(())
    }

    /// The run-history half of `link_card_session` (v27).
    ///
    /// A link is one of two things and the session id is what tells them
    /// apart. A DIFFERENT session is a new run: whatever was open for
    /// this card is `replaced` -- which is the truth of what the upsert
    /// below does to it -- and a fresh row opens. The SAME session is the
    /// same run, re-stated: a resume budget spent, an id learned late.
    /// That must UPDATE the row, or every auto-resume would file a run
    /// the human never started.
    ///
    /// A row this session left `abandoned` is reopened rather than
    /// duplicated. Abandoned means "the daemon that was watching went
    /// away", and a session that links again is the same work still
    /// going -- filing a second row for it would turn every daemon
    /// restart into a phantom run.
    #[allow(clippy::too_many_arguments)]
    fn record_run_for_link(
        &mut self,
        workspace_id: &str,
        path: &str,
        session_id: &str,
        command: Option<&str>,
        conversation_id: Option<&str>,
        launch_cwd: Option<&str>,
        resume_attempts: Option<u32>,
        base_sha: Option<&str>,
    ) -> anyhow::Result<()> {
        let tx = self.conn.transaction()?;
        let existing: Option<i64> = tx
            .query_row(
                "SELECT id FROM card_runs
                 WHERE workspace_id = ?1 AND path = ?2 AND session_id = ?3
                   AND outcome IN ('running', 'abandoned')
                 ORDER BY id DESC LIMIT 1",
                params![workspace_id, path, session_id],
                |row| row.get(0),
            )
            .ok();
        match existing {
            Some(id) => {
                tx.execute(
                    "UPDATE card_runs SET command = ?2, conversation_id = ?3, launch_cwd = ?4,
                       base_sha = ?5, resume_attempts = ?6, outcome = 'running',
                       ended_at = NULL, exit_code = NULL
                     WHERE id = ?1",
                    params![
                        id,
                        command,
                        conversation_id,
                        launch_cwd,
                        base_sha,
                        resume_attempts.map(i64::from)
                    ],
                )?;
            }
            None => {
                tx.execute(
                    "UPDATE card_runs SET outcome = 'replaced', ended_at = ?3
                     WHERE workspace_id = ?1 AND path = ?2 AND outcome = 'running'",
                    params![workspace_id, path, now_secs()],
                )?;
                tx.execute(
                    "INSERT INTO card_runs (workspace_id, path, session_id, command, conversation_id,
                       launch_cwd, base_sha, started_at, outcome, resume_attempts)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'running', ?9)",
                    params![
                        workspace_id,
                        path,
                        session_id,
                        command,
                        conversation_id,
                        launch_cwd,
                        base_sha,
                        now_secs(),
                        resume_attempts.map(i64::from)
                    ],
                )?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// Every run this card has had, NEWEST FIRST. Ordered by id rather
    /// than `started_at`: a relaunch can land in the same second as the
    /// run it replaced, and the row id is the only total order there is.
    pub fn card_runs(&self, workspace_id: &str, path: &str) -> anyhow::Result<Vec<CardRun>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, path, session_id, command, conversation_id, launch_cwd, base_sha,
                    started_at, ended_at, exit_code, outcome, resume_attempts
             FROM card_runs WHERE workspace_id = ?1 AND path = ?2 ORDER BY id DESC",
        )?;
        let rows = stmt.query_map(params![workspace_id, path], |row| {
            Ok(CardRun {
                id: row.get(0)?,
                path: row.get(1)?,
                session_id: row.get(2)?,
                command: row.get(3)?,
                conversation_id: row.get(4)?,
                launch_cwd: row.get(5)?,
                base_sha: row.get(6)?,
                started_at: row.get(7)?,
                ended_at: row.get(8)?,
                exit_code: row.get(9)?,
                outcome: row.get(10)?,
                resume_attempts: row.get::<_, Option<i64>>(11)?.map(|v| v.max(0) as u32),
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    /// Closes whatever run a session was the run OF, wherever it was
    /// bound. Called from the one place that runs for both a natural exit
    /// and a kill, so the row is closed by the same event that already
    /// tells the app the session is gone -- rather than by a sweep that
    /// would have to guess.
    ///
    /// Keyed on the session alone: the daemon watching a PTY die knows
    /// which session it was and nothing about which card, and a session
    /// bound to two cards ended for both of them.
    pub fn finish_runs_for_session(&mut self, session_id: &str, exit_code: Option<i32>) -> anyhow::Result<()> {
        self.conn.execute(
            "UPDATE card_runs SET outcome = 'exited', ended_at = ?2, exit_code = ?3
             WHERE session_id = ?1 AND outcome = 'running'",
            params![session_id, now_secs(), exit_code],
        )?;
        Ok(())
    }

    /// Downgrades runs that still CLAIM to be running but whose session
    /// is gone.
    ///
    /// The pump closes a run where it already reports `SessionExited`,
    /// which is the right seam for every session the app has attached --
    /// but the pump only exists while something is attached, so a session
    /// that ends unattached leaves its row open with nobody to close it.
    /// `abandoned` is exactly that state, and it is the same word the
    /// reopen sweep uses, so the vocabulary stays at five outcomes rather
    /// than growing a sixth for a difference the reader cannot act on.
    ///
    /// `ended_at` is left alone: nobody watched these end, and now() is
    /// the time somebody LOOKED, which is not the same fact.
    pub fn abandon_runs_for_sessions(&mut self, session_ids: &[String]) -> anyhow::Result<()> {
        let tx = self.conn.transaction()?;
        for id in session_ids {
            tx.execute(
                "UPDATE card_runs SET outcome = 'abandoned' WHERE session_id = ?1 AND outcome = 'running'",
                params![id],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Closes a card's open run because its BINDING went away -- an
    /// unlink, a delete, an archive. Distinct from `exited` on purpose:
    /// the session may well still be running, and a history that called
    /// this an exit would be inventing one.
    fn finish_runs_for_card(&mut self, workspace_id: Option<&str>, path: &str) -> anyhow::Result<()> {
        match workspace_id {
            Some(ws) => self.conn.execute(
                "UPDATE card_runs SET outcome = 'unlinked', ended_at = ?3
                 WHERE workspace_id = ?1 AND path = ?2 AND outcome = 'running'",
                params![ws, path, now_secs()],
            )?,
            None => self.conn.execute(
                "UPDATE card_runs SET outcome = 'unlinked', ended_at = ?2
                 WHERE path = ?1 AND outcome = 'running'",
                params![path, now_secs()],
            )?,
        };
        Ok(())
    }

    /// Removes a deleted card's bindings in EVERY workspace.
    pub fn unlink_card_session_all(&mut self, path: &str) -> anyhow::Result<()> {
        self.finish_runs_for_card(None, path)?;
        self.conn.execute("DELETE FROM card_sessions WHERE path = ?1", params![path])?;
        Ok(())
    }

    /// Re-keys a card's bindings in EVERY workspace after its file moved
    /// (archived into `plans/done/`, or back out). The binding belongs to
    /// the card, not to the path it happened to have when the agent
    /// started; losing it would orphan a live session on the Agents page.
    /// A destination row that somehow already exists wins -- the same
    /// last-write-wins the upsert in `link_card_session` has.
    pub fn rename_card_path(&mut self, old_path: &str, new_path: &str) -> anyhow::Result<()> {
        self.conn.execute(
            "UPDATE OR REPLACE card_sessions SET path = ?2 WHERE path = ?1",
            params![old_path, new_path],
        )?;
        // The history follows the card for the same reason the binding
        // does: it belongs to the card, not to the path the card had
        // while the agent was running. A card archived into `plans/done/`
        // that lost its runs would look like one nobody ever worked.
        // Plain UPDATE, not OR REPLACE: run rows have no uniqueness to
        // collide on, and two cards' histories merging is the correct
        // outcome when their files did.
        self.conn.execute(
            "UPDATE card_runs SET path = ?2 WHERE path = ?1",
            params![old_path, new_path],
        )?;
        Ok(())
    }

    /// Removes a binding; absent is a no-op.
    pub fn unlink_card_session(&mut self, workspace_id: &str, path: &str) -> anyhow::Result<()> {
        self.finish_runs_for_card(Some(workspace_id), path)?;
        self.conn.execute(
            "DELETE FROM card_sessions WHERE workspace_id = ?1 AND path = ?2",
            params![workspace_id, path],
        )?;
        Ok(())
    }

    /// Cascade-deletes a workspace's entire board, including the
    /// existence marker -- unlike `replace_board`, nothing is re-inserted,
    /// so a later `get_board` for this `workspace_id` reseeds fresh
    /// defaults rather than returning an empty board.
    pub fn delete_board(&mut self, workspace_id: &str) -> anyhow::Result<()> {
        let tx = self.conn.transaction()?;
        Self::delete_content_rows(&tx, workspace_id)?;
        tx.execute("DELETE FROM kanban_boards WHERE workspace_id = ?1", params![workspace_id])?;
        tx.commit()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn label(id: &str, name: &str) -> Label {
        Label { id: id.to_string(), name: name.to_string(), color: "#ff0000".to_string() }
    }

    fn column(id: &str, name: &str, position: i64) -> Column {
        Column { id: id.to_string(), name: name.to_string(), position }
    }

    // --- the run history (v27) ---------------------------------------
    //
    // Every test here exists because `card_sessions` cannot answer the
    // question: it is upserted by (workspace_id, path), so the run it
    // holds is always the last one and never the history.

    fn link(store: &mut KanbanStore, path: &str, session: &str) {
        store
            .link_card_session("ws-1", path, session, "/p", Some("claude"), Some("conv-1"), Some("/p"), None, None)
            .unwrap();
    }

    fn store() -> (tempfile::TempDir, KanbanStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = KanbanStore::open(&dir.path().join("kanban.sqlite")).unwrap();
        (dir, store)
    }

    #[test]
    fn a_card_with_no_runs_reports_an_empty_history_rather_than_erroring() {
        let (_dir, store) = store();
        assert!(store.card_runs("ws-1", "/p/t.md").unwrap().is_empty());
    }

    /// The whole point of the table. Three launches used to leave one
    /// `card_sessions` row; they leave three runs.
    #[test]
    fn every_launch_of_a_card_keeps_its_own_run_newest_first() {
        let (_dir, mut store) = store();
        link(&mut store, "/p/t.md", "s-1");
        link(&mut store, "/p/t.md", "s-2");
        link(&mut store, "/p/t.md", "s-3");

        let runs = store.card_runs("ws-1", "/p/t.md").unwrap();

        assert_eq!(
            runs.iter().map(|r| r.session_id.as_str()).collect::<Vec<_>>(),
            vec!["s-3", "s-2", "s-1"],
            "newest first"
        );
        assert_eq!(runs[0].outcome, "running");
        assert_eq!(runs[1].outcome, "replaced", "the launch that took the binding ended the run that had it");
        assert_eq!(runs[2].outcome, "replaced");
        assert_eq!(store.card_runs("ws-1", "/p/t.md").unwrap().len(), 3);
    }

    /// A relink of the SAME session is the same run re-stated -- an
    /// auto-resume spending its budget, an id learned late. Filing a
    /// second row for it would invent a run the human never started.
    #[test]
    fn relinking_the_same_session_updates_its_run_instead_of_opening_another() {
        let (_dir, mut store) = store();
        link(&mut store, "/p/t.md", "s-1");
        store
            .link_card_session("ws-1", "/p/t.md", "s-1", "/p", Some("claude"), Some("conv-1"), Some("/p"), Some(2), Some("abc"))
            .unwrap();

        let runs = store.card_runs("ws-1", "/p/t.md").unwrap();

        assert_eq!(runs.len(), 1, "one session is one run, however often it is linked");
        assert_eq!(runs[0].resume_attempts, Some(2));
        assert_eq!(runs[0].base_sha.as_deref(), Some("abc"));
    }

    #[test]
    fn a_session_exiting_closes_its_run_with_the_exit_code() {
        let (_dir, mut store) = store();
        link(&mut store, "/p/t.md", "s-1");

        store.finish_runs_for_session("s-1", Some(0)).unwrap();

        let runs = store.card_runs("ws-1", "/p/t.md").unwrap();
        assert_eq!(runs[0].outcome, "exited");
        assert_eq!(runs[0].exit_code, Some(0));
        assert!(runs[0].ended_at.is_some());
        assert!(runs[0].ended_at.unwrap() >= runs[0].started_at);
    }

    /// `unlinked` rather than `exited`: the session may well still be
    /// running, and a history that called this an exit would be
    /// inventing one.
    #[test]
    fn unlinking_a_card_closes_its_run_without_claiming_the_session_exited() {
        let (_dir, mut store) = store();
        link(&mut store, "/p/t.md", "s-1");

        store.unlink_card_session("ws-1", "/p/t.md").unwrap();

        let runs = store.card_runs("ws-1", "/p/t.md").unwrap();
        assert_eq!(runs.len(), 1, "the run survives the binding it outlived");
        assert_eq!(runs[0].outcome, "unlinked");
        assert_eq!(runs[0].exit_code, None);
    }

    #[test]
    fn deleting_a_card_everywhere_closes_the_runs_it_had() {
        let (_dir, mut store) = store();
        link(&mut store, "/p/t.md", "s-1");

        store.unlink_card_session_all("/p/t.md").unwrap();

        assert_eq!(store.card_runs("ws-1", "/p/t.md").unwrap()[0].outcome, "unlinked");
    }

    /// The history belongs to the CARD, not to the path it had while the
    /// agent ran. A card archived into `plans/done/` that lost its runs
    /// would read as one nobody ever worked -- and archiving is what
    /// happens to every card that was.
    #[test]
    fn a_cards_runs_follow_its_file_when_it_moves() {
        let (_dir, mut store) = store();
        link(&mut store, "/p/plans/t.md", "s-1");

        store.rename_card_path("/p/plans/t.md", "/p/plans/done/t.md").unwrap();

        assert!(store.card_runs("ws-1", "/p/plans/t.md").unwrap().is_empty());
        let moved = store.card_runs("ws-1", "/p/plans/done/t.md").unwrap();
        assert_eq!(moved.len(), 1);
        assert_eq!(moved[0].path, "/p/plans/done/t.md");
    }

    /// A run still open when the store is reopened belonged to a daemon
    /// that is gone. `abandoned`, not `exited` -- and `ended_at` stays
    /// None, because nobody watched it end and now() would be a lie.
    #[test]
    fn a_run_left_open_by_a_dead_daemon_reads_as_abandoned_with_no_end_time() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("kanban.sqlite");
        {
            let mut first = KanbanStore::open(&file).unwrap();
            link(&mut first, "/p/t.md", "s-1");
        }

        let second = KanbanStore::open(&file).unwrap();

        let runs = second.card_runs("ws-1", "/p/t.md").unwrap();
        assert_eq!(runs[0].outcome, "abandoned");
        assert_eq!(runs[0].ended_at, None);
    }

    /// ...and a session that links again after that restart is the same
    /// work still going. Duplicating its row would turn every daemon
    /// restart into a phantom run.
    #[test]
    fn a_session_that_links_again_after_a_restart_reopens_its_run() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("kanban.sqlite");
        {
            let mut first = KanbanStore::open(&file).unwrap();
            link(&mut first, "/p/t.md", "s-1");
        }
        let mut second = KanbanStore::open(&file).unwrap();

        link(&mut second, "/p/t.md", "s-1");

        let runs = second.card_runs("ws-1", "/p/t.md").unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].outcome, "running");
    }

    #[test]
    fn one_cards_runs_are_not_another_cards() {
        let (_dir, mut store) = store();
        link(&mut store, "/p/a.md", "s-1");
        link(&mut store, "/p/b.md", "s-2");

        assert_eq!(store.card_runs("ws-1", "/p/a.md").unwrap().len(), 1);
        assert_eq!(store.card_runs("ws-1", "/p/b.md").unwrap()[0].session_id, "s-2");
    }

    /// The v27 table reaches a database created before it, which
    /// `CREATE TABLE IF NOT EXISTS` in `open` handles -- unlike a COLUMN
    /// added the same way, which would never arrive (see the v21 ALTERs
    /// above and the test below them).
    #[test]
    fn the_run_history_table_is_created_in_a_database_that_predates_it() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("kanban.sqlite");
        {
            let conn = Connection::open(&file).unwrap();
            conn.execute_batch(
                "CREATE TABLE kanban_boards (workspace_id TEXT PRIMARY KEY);
                 INSERT INTO kanban_boards VALUES ('ws-1');",
            )
            .unwrap();
        }

        let mut store = KanbanStore::open(&file).unwrap();
        link(&mut store, "/p/t.md", "s-1");

        assert_eq!(store.card_runs("ws-1", "/p/t.md").unwrap().len(), 1);
    }

    #[test]
    fn get_board_seeds_the_default_three_columns_on_first_access() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = KanbanStore::open(&dir.path().join("kanban.sqlite")).unwrap();

        let board = store.get_board("ws-1").unwrap();

        assert_eq!(board.columns.len(), 3);
        assert_eq!(board.columns[0].name, "To Do");
        assert_eq!(board.columns[1].name, "In Progress");
        assert_eq!(board.columns[2].name, "Done");
        assert!(board.labels.is_empty());
    }

    // Permanent columns come back (above), but the marker-table rule they
    // ride on still holds for everything else: an edited board is never
    // RESEEDED wholesale -- custom columns survive, kept permanent ones
    // keep their identity, and nothing is duplicated.
    #[test]
    fn get_board_does_not_reseed_over_an_edited_board() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = KanbanStore::open(&dir.path().join("kanban.sqlite")).unwrap();
        let first = store.get_board("ws-1").unwrap();
        let kept = first.columns[0].clone(); // "To Do", with its original id
        store
            .replace_board("ws-1", &[kept.clone(), column("custom", "Blocked", 1)], &[])
            .unwrap();

        let second = store.get_board("ws-1").unwrap();

        assert_eq!(second.columns[0].id, kept.id, "the kept column keeps its identity, not a fresh seed");
        assert_eq!(
            second.columns.iter().filter(|c| c.name == "To Do").count(),
            1,
            "a kept permanent column must never be duplicated"
        );
        assert!(second.columns.iter().any(|c| c.name == "Blocked"), "custom columns survive an edit");
    }

    // Storage-level replace semantics, read back through read_board so
    // get_board's permanent-column restoration can't mask them.
    #[test]
    fn replace_board_replaces_rather_than_appends() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = KanbanStore::open(&dir.path().join("kanban.sqlite")).unwrap();
        store.replace_board("ws-1", &[column("c1", "First", 0)], &[]).unwrap();

        store.replace_board("ws-1", &[column("c2", "Second", 0)], &[]).unwrap();

        let stored = store.read_board("ws-1").unwrap();
        assert_eq!(stored.columns.len(), 1);
        assert_eq!(stored.columns[0].id, "c2");
    }

    #[test]
    fn labels_persist_and_replace() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = KanbanStore::open(&dir.path().join("kanban.sqlite")).unwrap();
        store.replace_board("ws-1", &[column("c1", "To Do", 0)], &[label("l1", "urgent")]).unwrap();

        let board = store.get_board("ws-1").unwrap();
        assert_eq!(board.labels.len(), 1);
        assert_eq!(board.labels[0].name, "urgent");
    }

    #[test]
    fn boards_for_different_workspaces_are_independent() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = KanbanStore::open(&dir.path().join("kanban.sqlite")).unwrap();
        store.replace_board("ws-1", &[column("c1", "Only in ws-1", 0)], &[]).unwrap();

        let ws2_board = store.get_board("ws-2").unwrap();

        assert_eq!(ws2_board.columns.len(), 3, "ws-2 has never been touched, so it gets its own fresh default seed");
        assert_eq!(ws2_board.columns[0].name, "To Do");
    }

    #[test]
    fn delete_board_removes_everything_and_a_later_get_board_reseeds_fresh_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = KanbanStore::open(&dir.path().join("kanban.sqlite")).unwrap();
        store
            .replace_board("ws-1", &[column("c1", "To Do", 0)], &[label("l1", "urgent")])
            .unwrap();

        store.delete_board("ws-1").unwrap();

        let board = store.get_board("ws-1").unwrap();
        assert_eq!(board.columns.len(), 3, "a fresh default seed, not the deleted board's leftovers");
        assert!(board.labels.is_empty());
    }

    #[test]
    fn card_sessions_upsert_unlink_and_ride_the_board() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = KanbanStore::open(&dir.path().join("kanban.sqlite")).unwrap();
        store.link_card_session("ws-1", "/p/t.md", "s-1", "/p", Some("claude 'x'"), None, None, None, None).unwrap();
        store.link_card_session("ws-1", "/p/t.md", "s-2", "/p", None, None, None, None, None).unwrap(); // upsert replaces
        store.link_card_session("ws-2", "/p/t.md", "s-9", "/p", None, None, None, None, None).unwrap(); // other workspace

        let board = store.get_board("ws-1").unwrap();
        assert_eq!(board.card_sessions.len(), 1);
        assert_eq!(board.card_sessions[0].session_id, "s-2");
        assert_eq!(board.card_sessions[0].command, None);

        store.unlink_card_session("ws-1", "/p/t.md").unwrap();
        store.unlink_card_session("ws-1", "/p/absent.md").unwrap(); // no-op
        assert!(store.get_board("ws-1").unwrap().card_sessions.is_empty());
        assert_eq!(store.get_board("ws-2").unwrap().card_sessions.len(), 1);
    }

    /// The budget is the one field a resume WRITES rather than merely
    /// carries, so it has to survive the upsert that replaces the
    /// session id -- that upsert IS what a resume performs.
    #[test]
    fn the_resume_budget_rides_the_binding_through_a_resume() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = KanbanStore::open(&dir.path().join("kanban.sqlite")).unwrap();
        store
            .link_card_session("ws-1", "/p/t.md", "s-1", "/p", None, Some("conv-1"), Some("/p"), None, None)
            .unwrap();
        assert_eq!(store.get_board("ws-1").unwrap().card_sessions[0].resume_attempts, None);

        // The resume: same conversation, new session, one attempt spent.
        store
            .link_card_session("ws-1", "/p/t.md", "s-2", "/p", None, Some("conv-1"), Some("/p"), Some(1), None)
            .unwrap();
        let cs = store.get_board("ws-1").unwrap().card_sessions;
        assert_eq!(cs[0].session_id, "s-2");
        assert_eq!(cs[0].resume_attempts, Some(1));

        // And a fresh launch spends it back down: a new conversation is a
        // new run, so the budget it carries is a new budget.
        store
            .link_card_session("ws-1", "/p/t.md", "s-3", "/p", None, Some("conv-2"), Some("/p"), Some(0), None)
            .unwrap();
        assert_eq!(store.get_board("ws-1").unwrap().card_sessions[0].resume_attempts, Some(0));
    }

    /// The baseline is written once, at launch, and then has to survive
    /// every later write to the same row -- a resume, a rename, a claim.
    /// It is unrecoverable if lost: nothing afterwards can say where a
    /// run began.
    #[test]
    fn the_baseline_rides_the_binding_and_is_replaced_only_by_a_fresh_launch() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = KanbanStore::open(&dir.path().join("kanban.sqlite")).unwrap();
        let base = "1111111111111111111111111111111111111111";
        store
            .link_card_session("ws-1", "/p/t.md", "s-1", "/p", None, Some("conv-1"), Some("/p"), Some(0), Some(base))
            .unwrap();
        assert_eq!(store.get_board("ws-1").unwrap().card_sessions[0].base_sha.as_deref(), Some(base));

        // A resume: same run, same baseline, new session.
        store
            .link_card_session("ws-1", "/p/t.md", "s-2", "/p", None, Some("conv-1"), Some("/p"), Some(1), Some(base))
            .unwrap();
        assert_eq!(store.get_board("ws-1").unwrap().card_sessions[0].base_sha.as_deref(), Some(base));

        // A re-launch: a new run, so a new baseline -- the checkout has
        // moved on and diffing against where the LAST run started would
        // credit this one with the previous one's work.
        let later = "2222222222222222222222222222222222222222";
        store
            .link_card_session("ws-1", "/p/t.md", "s-3", "/p", None, Some("conv-2"), Some("/p"), Some(0), Some(later))
            .unwrap();
        let cs = store.card_session("ws-1", "/p/t.md").unwrap().unwrap();
        assert_eq!(cs.base_sha.as_deref(), Some(later));
        assert_eq!(cs.session_id, "s-3");
    }

    /// Every other test here opens a database this build created, which
    /// is why the missing v21 ALTER survived: `CREATE TABLE IF NOT
    /// EXISTS` hands a fresh file the new columns and hides the fact
    /// that an existing one never gets them. This test starts from the
    /// v20 shape on purpose -- against the unmigrated table `read_board`
    /// fails outright with "no such column: conversation_id", taking the
    /// whole board down, not just the two new fields.
    #[test]
    fn opening_a_pre_v21_database_migrates_card_sessions() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("kanban.sqlite");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE kanban_boards (workspace_id TEXT PRIMARY KEY);
                 CREATE TABLE card_sessions (
                     workspace_id TEXT NOT NULL,
                     path TEXT NOT NULL,
                     session_id TEXT NOT NULL,
                     cwd TEXT NOT NULL,
                     command TEXT,
                     PRIMARY KEY (workspace_id, path)
                 );
                 INSERT INTO kanban_boards VALUES ('ws-1');
                 INSERT INTO card_sessions VALUES ('ws-1', '/p/t.md', 's-1', '/p', NULL);",
            )
            .unwrap();
        }

        let mut store = KanbanStore::open(&path).unwrap();
        let sessions = store.get_board("ws-1").unwrap().card_sessions;

        assert_eq!(sessions.len(), 1, "the pre-existing link survives the migration");
        assert_eq!(sessions[0].session_id, "s-1");
        assert_eq!(sessions[0].conversation_id, None, "a row written before v21 has no conversation");
        assert_eq!(sessions[0].launch_cwd, None);
        // v22's column rides the same list, and for the same reason: a
        // run that predates the budget has never been resumed, which is
        // what an absent count has to read as.
        assert_eq!(sessions[0].resume_attempts, None);
        // v26's column rides the same list. A run from before the
        // baseline existed has none, which every surface has to read as
        // "nobody recorded where this started" -- never as "it changed
        // nothing".
        assert_eq!(sessions[0].base_sha, None);

        // Idempotent: the ALTERs run on every open, and the second one
        // must swallow the duplicate rather than fail the open.
        drop(store);
        let mut reopened = KanbanStore::open(&path).unwrap();
        assert_eq!(reopened.get_board("ws-1").unwrap().card_sessions.len(), 1);
    }

    #[test]
    fn rename_card_path_follows_a_moved_card_across_workspaces() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = KanbanStore::open(&dir.path().join("kanban.sqlite")).unwrap();
        store.link_card_session("ws-1", "/p/plans/t.md", "s-1", "/p", None, None, None, None, None).unwrap();
        store.link_card_session("ws-2", "/p/plans/t.md", "s-2", "/p", None, None, None, None, None).unwrap();
        store.link_card_session("ws-1", "/p/plans/other.md", "s-3", "/p", None, None, None, None, None).unwrap();

        store.rename_card_path("/p/plans/t.md", "/p/plans/done/t.md").unwrap();

        let ws1 = store.get_board("ws-1").unwrap().card_sessions;
        let moved = ws1.iter().find(|cs| cs.session_id == "s-1").unwrap();
        assert_eq!(moved.path, "/p/plans/done/t.md");
        let untouched = ws1.iter().find(|cs| cs.session_id == "s-3").unwrap();
        assert_eq!(untouched.path, "/p/plans/other.md");
        assert_eq!(store.get_board("ws-2").unwrap().card_sessions[0].path, "/p/plans/done/t.md");
    }

    #[test]
    fn unlink_all_clears_a_path_across_workspaces() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = KanbanStore::open(&dir.path().join("kanban.sqlite")).unwrap();
        store.link_card_session("ws-1", "/p/t.md", "s-1", "/p", None, None, None, None, None).unwrap();
        store.link_card_session("ws-2", "/p/t.md", "s-2", "/p", None, None, None, None, None).unwrap();
        store.link_card_session("ws-1", "/p/other.md", "s-3", "/p", None, None, None, None, None).unwrap();

        store.unlink_card_session_all("/p/t.md").unwrap();

        assert!(store.get_board("ws-1").unwrap().card_sessions.iter().all(|cs| cs.path != "/p/t.md"));
        assert!(store.get_board("ws-2").unwrap().card_sessions.is_empty());
        assert_eq!(store.get_board("ws-1").unwrap().card_sessions.len(), 1);
    }

    #[test]
    fn get_board_restores_missing_permanent_columns_and_keeps_order() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = KanbanStore::open(&dir.path().join("kanban.sqlite")).unwrap();
        // A board that kept only a renamed-order "done" plus a custom one.
        store
            .replace_board("ws-1", &[column("c1", "done", 0), column("c2", "Blocked", 1)], &[])
            .unwrap();

        let board = store.get_board("ws-1").unwrap();

        let names: Vec<&str> = board.columns.iter().map(|c| c.name.as_str()).collect();
        // The surviving "done" counts (slug match) and keeps its place;
        // only the genuinely absent ones are appended.
        assert_eq!(names, vec!["done", "Blocked", "To Do", "In Progress"]);
        assert_eq!(board.columns.iter().map(|c| c.position).collect::<Vec<_>>(), vec![0, 1, 2, 3]);

        // Idempotent: a second read adds nothing.
        assert_eq!(store.get_board("ws-1").unwrap().columns.len(), 4);
    }

    #[test]
    fn store_survives_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("kanban.sqlite");
        {
            let mut store = KanbanStore::open(&db_path).unwrap();
            store.replace_board("ws-1", &[column("c1", "Persisted", 0)], &[]).unwrap();
        }
        let mut store = KanbanStore::open(&db_path).unwrap();
        let board = store.get_board("ws-1").unwrap();
        assert_eq!(board.columns[0].name, "Persisted");
    }

    #[test]
    fn open_drops_leftover_card_tables_from_earlier_builds() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("kanban.sqlite");
        // A database from before the card model, cards and all.
        {
            let conn = Connection::open(&db_path).unwrap();
            conn.execute_batch(
                "CREATE TABLE kanban_boards (workspace_id TEXT PRIMARY KEY);
                 CREATE TABLE kanban_columns (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, name TEXT NOT NULL, position INTEGER NOT NULL);
                 CREATE TABLE kanban_cards (id TEXT PRIMARY KEY, column_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL, priority TEXT NOT NULL, position INTEGER NOT NULL);
                 CREATE TABLE kanban_labels (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, name TEXT NOT NULL, color TEXT NOT NULL);
                 CREATE TABLE kanban_card_labels (card_id TEXT NOT NULL, label_id TEXT NOT NULL, PRIMARY KEY (card_id, label_id));
                 INSERT INTO kanban_cards VALUES ('card-1', 'c1', 'Old', '', 'none', 0);",
            )
            .unwrap();
        }

        let store = KanbanStore::open(&db_path).unwrap();
        let count: i64 = store
            .conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='table' AND name IN ('kanban_cards','kanban_card_labels')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 0, "leftover card tables must be dropped (C5 wipe)");
        // And re-opening stays fine.
        assert!(KanbanStore::open(&db_path).is_ok());
    }
}
