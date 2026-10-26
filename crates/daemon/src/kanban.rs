use protocol::shell_writes::{RootFiles, ShellWrites};
use protocol::{ActivityRun, ActivityRunKind, Board, CardRun, CardSession, Column, Label, RunSavings};
use protocol::scheduled::{FireClaim, ScheduledFire};
use protocol::workspace_log::{LogCategory, LogCursor, LogEntry, LogKind, LogPayload};
use rusqlite::{params, Connection};

/// The three canonical statuses (D6's vocabulary). Permanent: the board
/// UI never deletes them, and get_board re-adds any that went missing --
/// so "permanent" holds even against an older board or a stale client,
/// not just the current UI.
const PERMANENT_COLUMNS: [&str; 3] = ["To Do", "In Progress", "Done"];

/// Wall-clock seconds, for the run history's own timestamps. Saturated
/// at 0 rather than propagating an error: a clock set before 1970 is not
/// a reason to refuse a card launch.
pub(crate) fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// How long a shell call's record is kept (`shell_writes`). Long past the
/// point it can still be read: it only means anything beside the run's
/// transcript, and Claude Code deletes those after 30 days unless told
/// otherwise. Without a bound the table would grow by a row per shell
/// call for as long as gavin is installed.
const SHELL_WRITES_KEPT_SECS: i64 = 90 * 24 * 60 * 60;

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
    /// Workspace log entries written since the server last took them, so
    /// it can push them to the app watching each workspace (v79). Filled
    /// by every write that journals, drained by `take_log_appended`.
    log_appended: Vec<LogEntry>,
}

/// How long a claimed fire may wait for its launch to be recorded before
/// it stops counting as a run going. A headless launch is recorded within
/// a second or two; this only covers an app that died in between.
const SCHEDULED_LAUNCH_GRACE_SECS: i64 = 120;

/// Fire rows kept per Scheduled task. The count lives in
/// `scheduled_tasks`; these only feed the list, which shows twenty.
const SCHEDULED_FIRES_KEPT: i64 = 200;

/// One `ClaimScheduledFire`, with what the daemon read off the copy.
pub struct ScheduledClaim {
    pub path: String,
    /// The copy's `schedule:` line now; None for an unscheduled task.
    pub schedule: Option<String>,
    /// The rule's run count; None is indefinite.
    pub runs: Option<u32>,
    pub paused: bool,
    /// The grid slot that came due; None for a Run now.
    pub slot: Option<u64>,
    pub skip_reason: Option<String>,
    pub report_path: String,
    pub now: i64,
}

fn fire_from_row(row: &rusqlite::Row) -> rusqlite::Result<ScheduledFire> {
    Ok(ScheduledFire {
        id: row.get(0)?,
        slot: row.get::<_, Option<i64>>(1)?.map(|s| s.max(0) as u64),
        at: row.get(2)?,
        outcome: row.get(3)?,
        skip_reason: row.get(4)?,
        session_id: row.get(5)?,
        exit_code: row.get(6)?,
        ended_at: row.get(7)?,
        report_path: row.get(8)?,
        headline: None,
        has_report: false,
        has_raw: false,
    })
}

impl KanbanStore {
    pub fn open(path: &std::path::Path) -> anyhow::Result<Self> {
        let mut conn = Connection::open(path)?;
        // The dev and release daemons share this file, and a Scheduled
        // task's fire claim takes a write lock across both: the loser of
        // that race has to wait its turn, not fail with SQLITE_BUSY.
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
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
                resume_attempts INTEGER,
                -- v49: what Headroom saved this run, snapshotted from
                -- its /stats when the session ended. Both NULL for a run
                -- that was not compressed or whose snapshot could not be
                -- taken, and written together or not at all.
                headroom_tokens_saved INTEGER,
                headroom_requests INTEGER
            );
            CREATE INDEX IF NOT EXISTS card_runs_by_card
                ON card_runs (workspace_id, path, id);
            CREATE INDEX IF NOT EXISTS card_runs_by_session
                ON card_runs (session_id);
            -- v78: the activity calendar reads a workspace's runs by the
            -- time they started. An index reaches the table every install
            -- already has from right here, which a column would not: this
            -- statement runs on every open, against an old file too.
            CREATE INDEX IF NOT EXISTS card_runs_by_time
                ON card_runs (workspace_id, started_at);
            -- v72: what each shell call of an agent wrote, as its CLI's
            -- hook saw it (`gavin-mcp shell-writes`). Keyed by the CLI's
            -- OWN ids -- the conversation and the call -- rather than by
            -- a session or a card: those are the two the transcript
            -- carries, and the Review tab matches each record to the
            -- command it watched. `paths` is a JSON array relative to
            -- `root`; an empty one is a call watched that wrote nothing.
            CREATE TABLE IF NOT EXISTS shell_writes (
                conversation_id TEXT NOT NULL,
                tool_call_id TEXT NOT NULL,
                root TEXT NOT NULL,
                paths TEXT NOT NULL,
                recorded_at INTEGER NOT NULL,
                PRIMARY KEY (conversation_id, tool_call_id)
            );
            CREATE INDEX IF NOT EXISTS shell_writes_by_age
                ON shell_writes (recorded_at);
            -- v77: Scheduled tasks' run state (ADR 0010). The copies
            -- are files; what they have DONE is here, keyed by the
            -- copy's path. `schedule` is the line the count was kept
            -- against: a copy whose line no longer matches it starts
            -- again from nothing, however the line was changed.
            CREATE TABLE IF NOT EXISTS scheduled_tasks (
                path TEXT PRIMARY KEY,
                schedule TEXT NOT NULL,
                fire_count INTEGER NOT NULL,
                last_slot INTEGER
            );
            -- One row per fire, and per Run now (`slot` NULL). Claimed
            -- inside one IMMEDIATE transaction, so of two daemons sharing
            -- this file only one ever writes a given slot.
            CREATE TABLE IF NOT EXISTS scheduled_fires (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                path TEXT NOT NULL,
                slot INTEGER,
                at INTEGER NOT NULL,
                -- launching | running | exited | skipped | failed | abandoned
                outcome TEXT NOT NULL,
                skip_reason TEXT,
                session_id TEXT,
                exit_code INTEGER,
                ended_at INTEGER,
                report_path TEXT
            );
            CREATE INDEX IF NOT EXISTS scheduled_fires_by_task
                ON scheduled_fires (path, id);
            CREATE INDEX IF NOT EXISTS scheduled_fires_by_session
                ON scheduled_fires (session_id);
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
            // v49's snapshot, for the same reason: every install already
            // has a card_runs, and `card_runs` below selects both.
            "ALTER TABLE card_runs ADD COLUMN headroom_tokens_saved INTEGER",
            "ALTER TABLE card_runs ADD COLUMN headroom_requests INTEGER",
        ] {
            let _ = conn.execute(stmt, []);
        }
        // v79: the Workspace log, and its one-time copy of `card_runs`.
        // After the ALTERs: the copy reads the table they widen.
        crate::workspace_log::migrate(&mut conn)?;
        conn.execute_batch(crate::reflog::SCHEMA)?;
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
        conn.execute(
            "DELETE FROM shell_writes WHERE recorded_at < ?1",
            params![now_secs() - SHELL_WRITES_KEPT_SECS],
        )?;
        Ok(Self { conn, log_appended: Vec::new() })
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

        // Every binding WITHOUT its command (v43). The command is an
        // agent's whole prompt -- most of this reply's bytes, growing with
        // every run, and re-read on every tree push -- while exactly one
        // action reads it, one card at a time (`card_session` below). Not
        // selected at all, so it is never even copied out of SQLite.
        let mut card_sessions = Vec::new();
        {
            let mut stmt = self.conn.prepare(
                "SELECT path, session_id, cwd, conversation_id, launch_cwd, resume_attempts, base_sha, \
                        command IS NOT NULL AND trim(command) <> '' \
                 FROM card_sessions WHERE workspace_id = ?1",
            )?;
            let rows = stmt.query_map(params![workspace_id], |row| {
                Ok(CardSession {
                    path: row.get(0)?,
                    session_id: row.get(1)?,
                    cwd: row.get(2)?,
                    command: None,
                    // Whether it HAS one, which is a bit rather than a
                    // prompt: what the board needs to offer Re-launch
                    // only where there is a launch to replay.
                    replayable: Some(row.get(7)?),
                    conversation_id: row.get(3)?,
                    launch_cwd: row.get(4)?,
                    resume_attempts: row.get::<_, Option<i64>>(5)?.map(|v| v.max(0) as u32),
                    base_sha: row.get(6)?,
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

    /// The session currently bound to one card, if any, command
    /// included -- the one read that carries it (`GetCardSession`).
    /// Also read on its own rather than off `get_board` by a claim
    /// (`ClaimCardForSession`), which only has to know whether somebody
    /// else already owns this one card: building the whole board to
    /// answer that reads every column, label and binding the workspace
    /// has.
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
            let command: Option<String> = row.get(3)?;
            Ok(CardSession {
                path: row.get(0)?,
                session_id: row.get(1)?,
                cwd: row.get(2)?,
                replayable: Some(command.as_deref().is_some_and(|c| !c.trim().is_empty())),
                command,
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
                let started_at = now_secs();
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
                        started_at,
                        resume_attempts.map(i64::from)
                    ],
                )?;
                // A new row is a new run, and only a new row: the
                // re-statement above is the same run said again.
                let payload = crate::workspace_log::run_payload(
                    path,
                    crate::workspace_log::card_title_on_disk(path),
                    command,
                    session_id,
                );
                let entry = crate::workspace_log::append(&tx, workspace_id, started_at, LogKind::RunStarted, &payload)?;
                tx.commit()?;
                self.log_appended.push(entry);
                return Ok(());
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
                    started_at, ended_at, exit_code, outcome, resume_attempts,
                    headroom_tokens_saved, headroom_requests
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
                headroom_tokens_saved: row.get::<_, Option<i64>>(12)?.map(|v| v.max(0) as u64),
                headroom_requests: row.get::<_, Option<i64>>(13)?.map(|v| v.max(0) as u64),
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    /// This workspace's card runs that STARTED in `[since, until)`, oldest
    /// first, for the activity calendar (v78). Read through
    /// `card_runs_by_time`, whose rowid tail is the id tiebreak for two
    /// runs opened in the same second. The outcome is the row's own; the
    /// caller reconciles a `running` claim, as `card_runs` does.
    pub fn activity_runs(&self, workspace_id: &str, since: i64, until: i64) -> anyhow::Result<Vec<ActivityRun>> {
        let mut stmt = self.conn.prepare(
            "SELECT path, session_id, command, started_at, ended_at, exit_code, outcome
             FROM card_runs
             WHERE workspace_id = ?1 AND started_at >= ?2 AND started_at < ?3
             ORDER BY started_at, id",
        )?;
        let rows = stmt.query_map(params![workspace_id, since, until], |row| {
            Ok(ActivityRun {
                kind: ActivityRunKind::Card,
                workspace_id: workspace_id.to_string(),
                path: Some(row.get(0)?),
                tool_id: None,
                session_id: row.get(1)?,
                command: row.get(2)?,
                started_at: row.get(3)?,
                ended_at: row.get(4)?,
                exit_code: row.get(5)?,
                outcome: row.get(6)?,
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// Keeps what one shell call wrote. A second record for the same call
    /// replaces the first: one call has one before and one after.
    pub fn record_shell_writes(
        &self,
        conversation_id: &str,
        tool_call_id: &str,
        root: &str,
        paths: &[String],
    ) -> anyhow::Result<()> {
        self.conn.execute(
            "INSERT OR REPLACE INTO shell_writes (conversation_id, tool_call_id, root, paths, recorded_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![conversation_id, tool_call_id, root, serde_json::to_string(paths)?, now_secs()],
        )?;
        Ok(())
    }

    /// Every shell call recorded for a conversation, folded into the
    /// calls and the files under each root (`ShellWrites`'s note says
    /// why). Calls and roots in the order they were recorded; a row whose
    /// paths do not parse counts as watched and writing nothing rather
    /// than failing the whole read.
    pub fn shell_writes(&self, conversation_id: &str) -> anyhow::Result<ShellWrites> {
        let mut stmt = self.conn.prepare(
            "SELECT tool_call_id, root, paths FROM shell_writes
             WHERE conversation_id = ?1 ORDER BY recorded_at, rowid",
        )?;
        let rows = stmt.query_map(params![conversation_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))
        })?;
        let mut out = ShellWrites::default();
        for row in rows {
            let (call, root, paths) = row?;
            out.calls.push(call);
            let paths: Vec<String> = serde_json::from_str(&paths).unwrap_or_default();
            if paths.is_empty() {
                continue;
            }
            let at = match out.files.iter().position(|f| f.root == root) {
                Some(at) => at,
                None => {
                    out.files.push(RootFiles { root, paths: Vec::new() });
                    out.files.len() - 1
                }
            };
            let known = &mut out.files[at].paths;
            for path in paths {
                if !known.contains(&path) {
                    known.push(path);
                }
            }
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
        let ended_at = now_secs();
        let tx = self.conn.transaction()?;
        let closing: Vec<(String, String, Option<String>)> = tx
            .prepare(
                "SELECT workspace_id, path, command FROM card_runs
                 WHERE session_id = ?1 AND outcome = 'running' ORDER BY id",
            )?
            .query_map(params![session_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect::<Result<_, _>>()?;
        tx.execute(
            "UPDATE card_runs SET outcome = 'exited', ended_at = ?2, exit_code = ?3
             WHERE session_id = ?1 AND outcome = 'running'",
            params![session_id, ended_at, exit_code],
        )?;
        let mut entries = Vec::new();
        for (workspace_id, path, command) in closing {
            let payload = LogPayload {
                exit_code,
                ..crate::workspace_log::run_payload(
                    &path,
                    crate::workspace_log::card_title_on_disk(&path),
                    command.as_deref(),
                    session_id,
                )
            };
            entries.push(crate::workspace_log::append(&tx, &workspace_id, ended_at, LogKind::RunFinished, &payload)?);
        }
        tx.commit()?;
        self.log_appended.extend(entries);
        Ok(())
    }

    // ---- The Workspace log (v79) ------------------------------------------

    /// Appends one entry, to be pushed with the rest.
    pub fn append_log(
        &mut self,
        workspace_id: &str,
        at: i64,
        kind: LogKind,
        payload: &LogPayload,
    ) -> anyhow::Result<LogEntry> {
        let entry = crate::workspace_log::append(&self.conn, workspace_id, at, kind, payload)?;
        self.log_appended.push(entry.clone());
        Ok(entry)
    }

    /// Diffs one scan of a workspace's cards against the last and appends
    /// what changed. See `workspace_log::journal_cards`.
    pub fn journal_cards(
        &mut self,
        workspace_id: &str,
        scan: &crate::workspace_log::CardScan,
        noticed_on_start: bool,
    ) -> anyhow::Result<()> {
        let entries =
            crate::workspace_log::journal_cards(&mut self.conn, workspace_id, scan, now_secs(), noticed_on_start)?;
        self.log_appended.extend(entries);
        Ok(())
    }

    /// Reads a workspace's new reflog lines into its log. See
    /// `reflog::sync`.
    pub fn sync_reflogs(&mut self, workspace_id: &str, sources: &[crate::reflog::Source]) -> anyhow::Result<()> {
        let entries = crate::reflog::sync(&mut self.conn, workspace_id, sources)?;
        self.log_appended.extend(entries);
        Ok(())
    }

    /// Entries written since the last call, oldest first.
    pub fn take_log_appended(&mut self) -> Vec<LogEntry> {
        std::mem::take(&mut self.log_appended)
    }

    pub fn workspace_log(
        &self,
        workspace_id: &str,
        before: Option<LogCursor>,
        limit: u32,
        categories: &[LogCategory],
        search: Option<&str>,
    ) -> anyhow::Result<(Vec<LogEntry>, bool)> {
        crate::workspace_log::page(&self.conn, workspace_id, before, limit, categories, search)
    }

    pub fn clear_workspace_log(&mut self, workspace_id: &str, older_than: Option<i64>) -> anyhow::Result<u64> {
        crate::workspace_log::clear(&self.conn, workspace_id, older_than)
    }

    /// Writes what Headroom saved a session onto every run it was the
    /// run OF (v49). Called once, when the session has ended.
    ///
    /// Keyed on the session and not on the outcome, unlike
    /// `finish_runs_for_session`: a run that was `replaced` or `unlinked`
    /// while its session carried on is still that session's run, and
    /// the saving is the session's. A session bound to two cards puts
    /// the same snapshot on both rows; a sum counts the session once.
    ///
    /// A row with no end is given one: now, when the session was seen to
    /// end. That row is one a `CardRuns` read abandoned in the moment
    /// between a kill and its teardown -- the kill had already dropped
    /// the registry row the sweep reads -- and `finish_runs_for_session`
    /// closes only `running` rows. Left without an end, its snapshot
    /// would be kept and never counted: `savings_since` places a run at
    /// its end. `abandon_runs_for_sessions` leaves the end alone because
    /// nobody watched those sessions end; this one was watched, which is
    /// how it came to be snapshotted. A row that has an end keeps it.
    pub fn record_savings_for_session(
        &mut self,
        session_id: &str,
        tokens_saved: u64,
        requests: u64,
    ) -> anyhow::Result<()> {
        self.conn.execute(
            "UPDATE card_runs SET headroom_tokens_saved = ?2, headroom_requests = ?3,
                    ended_at = COALESCE(ended_at, ?4)
             WHERE session_id = ?1",
            params![
                session_id,
                i64::try_from(tokens_saved).unwrap_or(i64::MAX),
                i64::try_from(requests).unwrap_or(i64::MAX),
                now_secs()
            ],
        )?;
        Ok(())
    }

    /// Every run with a snapshot that ended at or after `since`, oldest
    /// first, across every card and workspace: what the hub sums into a
    /// limit window. A run is placed at its end because that is when
    /// its snapshot was taken.
    pub fn savings_since(&self, since: i64) -> anyhow::Result<Vec<RunSavings>> {
        let mut stmt = self.conn.prepare(
            "SELECT workspace_id, path, session_id, started_at, ended_at,
                    headroom_tokens_saved, headroom_requests
             FROM card_runs
             WHERE headroom_tokens_saved IS NOT NULL AND ended_at >= ?1
             ORDER BY id",
        )?;
        let rows = stmt.query_map(params![since], |row| {
            Ok(RunSavings {
                workspace_id: row.get(0)?,
                path: row.get(1)?,
                session_id: row.get(2)?,
                started_at: row.get(3)?,
                ended_at: row.get(4)?,
                tokens_saved: row.get::<_, i64>(5)?.max(0) as u64,
                requests: row.get::<_, Option<i64>>(6)?.unwrap_or(0).max(0) as u64,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
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
    /// unlink. Distinct from `exited` on purpose: the session may well
    /// still be running, and a history that called this an exit would be
    /// inventing one.
    fn finish_runs_for_card(&mut self, workspace_id: &str, path: &str) -> anyhow::Result<()> {
        self.conn.execute(
            "UPDATE card_runs SET outcome = 'unlinked', ended_at = ?3
             WHERE workspace_id = ?1 AND path = ?2 AND outcome = 'running'",
            params![workspace_id, path, now_secs()],
        )?;
        Ok(())
    }

    /// Removes every trace of a DELETED card from this store, in every
    /// workspace: its live bindings and the whole run history behind
    /// them.
    ///
    /// Removed, not closed -- the one place that treats a run this way.
    /// `unlink_card_session` marks a run `unlinked` and keeps the row
    /// because the card is still there to show it: the detail modal
    /// reads a card's history by path. A deleted card has no modal and
    /// never will, so those rows are unreachable prose about work
    /// nobody can look up -- and the path keying them is one a new card
    /// can take tomorrow, which would hand it somebody else's runs.
    pub fn purge_card(&mut self, path: &str) -> anyhow::Result<()> {
        let tx = self.conn.transaction()?;
        tx.execute("DELETE FROM card_sessions WHERE path = ?1", params![path])?;
        tx.execute("DELETE FROM card_runs WHERE path = ?1", params![path])?;
        tx.commit()?;
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

    /// An agent self-reporting its own CLI's conversation id after the
    /// fact (`gavin_name_session`'s second argument), for a profile that
    /// cannot have one minted at launch the way Claude Code's is
    /// (codex/gemini/opencode -- `agent-session-id-self-report.md`).
    /// Keyed by `session_id` alone: the caller only knows its own gavin
    /// tab/PTY session id, never the (workspace_id, path) pair, and a
    /// session is bound to at most one card at a time. Returns whether a
    /// row was updated -- a session with no bound card is a no-op, there
    /// is nothing yet to link it to, not an error.
    pub fn set_conversation_id_for_session(
        &mut self,
        session_id: &str,
        conversation_id: &str,
    ) -> anyhow::Result<bool> {
        let updated = self.conn.execute(
            "UPDATE card_sessions SET conversation_id = ?1 WHERE session_id = ?2",
            params![conversation_id, session_id],
        )?;
        Ok(updated > 0)
    }

    /// Removes a binding; absent is a no-op.
    pub fn unlink_card_session(&mut self, workspace_id: &str, path: &str) -> anyhow::Result<()> {
        self.finish_runs_for_card(workspace_id, path)?;
        self.conn.execute(
            "DELETE FROM card_sessions WHERE workspace_id = ?1 AND path = ?2",
            params![workspace_id, path],
        )?;
        Ok(())
    }

    /// A Scheduled task's count as it stands against `schedule`, the
    /// line on its copy now: `(fire_count, last_slot)`, or nothing yet
    /// when the line changed since the count was kept.
    pub fn scheduled_state(&self, path: &str, schedule: &str) -> anyhow::Result<(u32, Option<u64>)> {
        let row: Option<(String, i64, Option<i64>)> = self
            .conn
            .query_row(
                "SELECT schedule, fire_count, last_slot FROM scheduled_tasks WHERE path = ?1",
                params![path],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .ok();
        Ok(match row {
            Some((kept, count, slot)) if kept == schedule => {
                (count.max(0) as u32, slot.map(|s| s.max(0) as u64))
            }
            _ => (0, None),
        })
    }

    /// A task's fires, newest first, at most `limit`. Headline and file
    /// facts are left for the caller, which owns the files.
    pub fn scheduled_fires(&self, path: &str, limit: usize) -> anyhow::Result<Vec<ScheduledFire>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, slot, at, outcome, skip_reason, session_id, exit_code, ended_at, report_path
             FROM scheduled_fires WHERE path = ?1 ORDER BY id DESC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![path, limit as i64], fire_from_row)?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn scheduled_fire(&self, id: i64) -> anyhow::Result<Option<(String, ScheduledFire)>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, slot, at, outcome, skip_reason, session_id, exit_code, ended_at, report_path, path
             FROM scheduled_fires WHERE id = ?1",
        )?;
        let mut rows = stmt.query_map(params![id], |row| Ok((row.get::<_, String>(9)?, fire_from_row(row)?)))?;
        Ok(rows.next().transpose()?)
    }

    /// Claims one fire, atomically across every daemon on this file (see
    /// `ScheduledClaim`). Refusals are answers, not errors.
    pub fn claim_scheduled_fire(&mut self, claim: &ScheduledClaim) -> anyhow::Result<FireClaim> {
        let refused = |why: &str| FireClaim {
            claimed: false,
            fire_id: None,
            fire_number: None,
            report_path: None,
            skipped: None,
            why: Some(why.to_string()),
        };
        let tx = self.conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        // A claim whose launch was never recorded -- the app went away
        // between the two -- would read as a run going forever.
        tx.execute(
            "UPDATE scheduled_fires SET outcome = 'abandoned'
             WHERE path = ?1 AND outcome = 'launching' AND at < ?2",
            params![claim.path, claim.now - SCHEDULED_LAUNCH_GRACE_SECS],
        )?;
        let busy: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM scheduled_fires
                           WHERE path = ?1 AND outcome IN ('launching', 'running'))",
            params![claim.path],
            |row| row.get(0),
        )?;
        let Some(slot) = claim.slot else {
            if busy {
                return Ok(refused("a run of this task is already going"));
            }
            tx.execute(
                "INSERT INTO scheduled_fires (path, slot, at, outcome, report_path)
                 VALUES (?1, NULL, ?2, 'launching', ?3)",
                params![claim.path, claim.now, claim.report_path],
            )?;
            let id = tx.last_insert_rowid();
            tx.commit()?;
            return Ok(FireClaim {
                claimed: true,
                fire_id: Some(id),
                fire_number: None,
                report_path: Some(claim.report_path.clone()),
                skipped: None,
                why: None,
            });
        };
        let Some(schedule) = claim.schedule.as_deref() else {
            return Ok(refused("this task has no schedule"));
        };
        if claim.paused {
            return Ok(refused("this task is paused"));
        }
        let kept: Option<(String, i64, Option<i64>)> = tx
            .query_row(
                "SELECT schedule, fire_count, last_slot FROM scheduled_tasks WHERE path = ?1",
                params![claim.path],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .ok();
        let (count, last_slot) = match kept {
            Some((line, count, slot)) if line == schedule => (count.max(0) as u32, slot),
            _ => (0, None),
        };
        if claim.runs.is_some_and(|n| count >= n) {
            return Ok(refused("this task's schedule is completed"));
        }
        let slot = i64::try_from(slot).unwrap_or(i64::MAX);
        if last_slot.is_some_and(|last| last >= slot) {
            return Ok(refused("that fire was already claimed"));
        }
        let skipped = claim
            .skip_reason
            .clone()
            .or_else(|| busy.then(|| "the previous run was still going".to_string()));
        match &skipped {
            Some(reason) => tx.execute(
                "INSERT INTO scheduled_fires (path, slot, at, outcome, skip_reason, ended_at)
                 VALUES (?1, ?2, ?3, 'skipped', ?4, ?3)",
                params![claim.path, slot, claim.now, reason],
            )?,
            None => tx.execute(
                "INSERT INTO scheduled_fires (path, slot, at, outcome, report_path)
                 VALUES (?1, ?2, ?3, 'launching', ?4)",
                params![claim.path, slot, claim.now, claim.report_path],
            )?,
        };
        let id = tx.last_insert_rowid();
        tx.execute(
            "INSERT INTO scheduled_tasks (path, schedule, fire_count, last_slot) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(path) DO UPDATE SET
               schedule = excluded.schedule, fire_count = excluded.fire_count, last_slot = excluded.last_slot",
            params![claim.path, schedule, count + 1, slot],
        )?;
        // Bounded: an every-minute task runs for as long as gavin is
        // installed. The count is kept above; the rows only feed the list.
        tx.execute(
            "DELETE FROM scheduled_fires WHERE path = ?1 AND id NOT IN
               (SELECT id FROM scheduled_fires WHERE path = ?1 ORDER BY id DESC LIMIT ?2)",
            params![claim.path, SCHEDULED_FIRES_KEPT],
        )?;
        tx.commit()?;
        Ok(FireClaim {
            claimed: true,
            fire_id: Some(id),
            fire_number: Some(count + 1),
            report_path: skipped.is_none().then(|| claim.report_path.clone()),
            skipped,
            why: None,
        })
    }

    /// What became of a claimed fire's launch. Returns the fire's task
    /// path and report path, or None for a fire that is no longer
    /// `launching` -- recorded already, or given up on.
    pub fn record_scheduled_launch(
        &mut self,
        fire_id: i64,
        session_id: Option<&str>,
        error: Option<&str>,
    ) -> anyhow::Result<Option<(String, Option<String>)>> {
        let row: Option<(String, Option<String>)> = self
            .conn
            .query_row(
                "SELECT path, report_path FROM scheduled_fires WHERE id = ?1 AND outcome = 'launching'",
                params![fire_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .ok();
        if row.is_none() {
            return Ok(None);
        }
        match (session_id, error) {
            (Some(session), None) => self.conn.execute(
                "UPDATE scheduled_fires SET outcome = 'running', session_id = ?2 WHERE id = ?1",
                params![fire_id, session],
            )?,
            (_, error) => self.conn.execute(
                "UPDATE scheduled_fires SET outcome = 'failed', skip_reason = ?2, ended_at = ?3 WHERE id = ?1",
                params![fire_id, error.unwrap_or("the run could not be started"), now_secs()],
            )?,
        };
        Ok(row)
    }

    /// Closes the scheduled run a session was, when it exits. Returns the
    /// report paths of the fires it closed, for the terminal to be saved
    /// beside them.
    pub fn finish_scheduled_for_session(
        &mut self,
        session_id: &str,
        exit_code: Option<i32>,
    ) -> anyhow::Result<Vec<String>> {
        let mut stmt = self.conn.prepare(
            "SELECT report_path FROM scheduled_fires
             WHERE session_id = ?1 AND outcome = 'running' AND report_path IS NOT NULL",
        )?;
        let reports = stmt.query_map(params![session_id], |row| row.get(0))?.collect::<Result<Vec<String>, _>>()?;
        drop(stmt);
        self.conn.execute(
            "UPDATE scheduled_fires SET outcome = 'exited', ended_at = ?2, exit_code = ?3
             WHERE session_id = ?1 AND outcome = 'running'",
            params![session_id, now_secs(), exit_code],
        )?;
        Ok(reports)
    }

    /// Fires that claim to be running in a session that is gone: over,
    /// at a time nobody recorded (`abandon_runs_for_sessions`' reading).
    pub fn abandon_scheduled_fires(&mut self, ids: &[i64]) -> anyhow::Result<()> {
        let tx = self.conn.transaction()?;
        for id in ids {
            tx.execute(
                "UPDATE scheduled_fires SET outcome = 'abandoned' WHERE id = ?1 AND outcome = 'running'",
                params![id],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Every trace of a deleted Scheduled task.
    pub fn purge_scheduled(&mut self, path: &str) -> anyhow::Result<()> {
        let tx = self.conn.transaction()?;
        tx.execute("DELETE FROM scheduled_tasks WHERE path = ?1", params![path])?;
        tx.execute("DELETE FROM scheduled_fires WHERE path = ?1", params![path])?;
        tx.commit()?;
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

    // --- the activity calendar's window (v78) -------------------------

    fn insert_run(store: &KanbanStore, workspace: &str, session: &str, started_at: i64, ended_at: Option<i64>, outcome: &str) {
        store
            .conn
            .execute(
                "INSERT INTO card_runs (workspace_id, path, session_id, command, started_at, ended_at, outcome)
                 VALUES (?1, '/p/t.md', ?2, 'claude', ?3, ?4, ?5)",
                params![workspace, session, started_at, ended_at, outcome],
            )
            .unwrap();
    }

    /// `since` is in the window and `until` is not, so two adjacent
    /// windows count a run on their shared edge once. A run still open
    /// is in it by its start, with no end.
    #[test]
    fn activity_runs_are_one_workspaces_runs_started_inside_the_window_oldest_first() {
        let (_dir, mut store) = store();
        insert_run(&store, "ws-1", "late", 150, None, "running");
        insert_run(&store, "ws-1", "before", 99, Some(120), "exited");
        insert_run(&store, "ws-1", "edge", 100, Some(130), "exited");
        insert_run(&store, "ws-1", "after", 200, Some(210), "exited");
        insert_run(&store, "ws-2", "other", 120, Some(125), "exited");

        let runs = store.activity_runs("ws-1", 100, 200).unwrap();

        assert_eq!(runs.iter().map(|r| r.session_id.as_str()).collect::<Vec<_>>(), vec!["edge", "late"]);
        assert!(runs.iter().all(|r| r.kind == ActivityRunKind::Card && r.workspace_id == "ws-1"));
        assert_eq!(runs[0].path.as_deref(), Some("/p/t.md"));
        assert_eq!(runs[0].tool_id, None);
        assert_eq!((runs[1].ended_at, runs[1].outcome.as_str()), (None, "running"));
        assert_eq!(store.activity_runs("ws-2", 0, i64::MAX).unwrap().len(), 1);
        assert!(store.activity_runs("ws-nobody", 0, i64::MAX).unwrap().is_empty());

        store.finish_runs_for_session("late", Some(3)).unwrap();
        let late = store.activity_runs("ws-1", 150, 151).unwrap().remove(0);
        assert_eq!((late.outcome.as_str(), late.exit_code), ("exited", Some(3)), "a crash is told from a finish");
    }

    /// The index has to reach a database that already has `card_runs`,
    /// and the read has to use it: a year of runs is read on every
    /// calendar open.
    #[test]
    fn opening_a_pre_v78_database_indexes_card_runs_by_time() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("kanban.sqlite");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE card_runs (
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
                     outcome TEXT NOT NULL,
                     resume_attempts INTEGER,
                     headroom_tokens_saved INTEGER,
                     headroom_requests INTEGER
                 );
                 INSERT INTO card_runs (workspace_id, path, session_id, started_at, ended_at, outcome)
                 VALUES ('ws-1', '/p/t.md', 's-old', 10, 20, 'exited');",
            )
            .unwrap();
        }

        let store = KanbanStore::open(&path).unwrap();

        assert_eq!(store.activity_runs("ws-1", 0, 100).unwrap().len(), 1, "the old run is in the window");
        let plan: String = store
            .conn
            .prepare(
                "EXPLAIN QUERY PLAN SELECT path FROM card_runs
                 WHERE workspace_id = 'ws-1' AND started_at >= 0 AND started_at < 100
                 ORDER BY started_at, id",
            )
            .unwrap()
            .query_map([], |row| row.get::<_, String>(3))
            .unwrap()
            .map(Result::unwrap)
            .collect::<Vec<_>>()
            .join("; ");
        assert!(plan.contains("card_runs_by_time"), "the window read is indexed: {plan}");
        assert!(!plan.contains("TEMP B-TREE"), "and needs no sort of its own: {plan}");
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

    /// Unlinking keeps the run; DELETING the card takes it. The row is
    /// keyed by a path that no longer names anything, and the only
    /// surface that reads it is the card's own detail modal.
    #[test]
    fn deleting_a_card_everywhere_takes_the_runs_it_had() {
        let (_dir, mut store) = store();
        link(&mut store, "/p/t.md", "s-1");

        store.purge_card("/p/t.md").unwrap();

        assert!(store.card_runs("ws-1", "/p/t.md").unwrap().is_empty());
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

    // --- shell writes (v72) -------------------------------------------

    fn paths(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn a_conversations_shell_writes_fold_into_its_calls_and_each_file_once() {
        let (_dir, store) = store();
        store.record_shell_writes("c-1", "t-1", "/r", &paths(&["a.ts", "b.ts"])).unwrap();
        // Watched, wrote nothing: still a call.
        store.record_shell_writes("c-1", "t-2", "/r", &[]).unwrap();
        store.record_shell_writes("c-1", "t-3", "/r", &paths(&["b.ts", "c.ts"])).unwrap();
        store.record_shell_writes("c-1", "t-4", "/wt", &paths(&["a.ts"])).unwrap();
        // Another conversation's call is not this one's.
        store.record_shell_writes("c-2", "t-9", "/r", &paths(&["z.ts"])).unwrap();

        let writes = store.shell_writes("c-1").unwrap();
        assert_eq!(writes.calls, paths(&["t-1", "t-2", "t-3", "t-4"]));
        assert_eq!(
            writes.files,
            vec![
                RootFiles { root: "/r".into(), paths: paths(&["a.ts", "b.ts", "c.ts"]) },
                RootFiles { root: "/wt".into(), paths: paths(&["a.ts"]) },
            ]
        );
        assert_eq!(store.shell_writes("nobody").unwrap(), ShellWrites::default());
    }

    #[test]
    fn recording_a_call_twice_keeps_the_second_record() {
        let (_dir, store) = store();
        store.record_shell_writes("c-1", "t-1", "/r", &paths(&["a.ts"])).unwrap();
        store.record_shell_writes("c-1", "t-1", "/r", &paths(&["b.ts"])).unwrap();
        let writes = store.shell_writes("c-1").unwrap();
        assert_eq!(writes.calls, paths(&["t-1"]));
        assert_eq!(writes.files, vec![RootFiles { root: "/r".into(), paths: paths(&["b.ts"]) }]);
    }

    /// Every install already has a kanban.sqlite, built by a daemon that
    /// never heard of this table, and every test above opens a fresh one.
    /// A TABLE does reach an old file through `CREATE TABLE IF NOT
    /// EXISTS` (a column would not); this proves it against the v71
    /// schema, rows and all, and that the age bound prunes on open.
    #[test]
    fn opening_a_pre_v72_database_adds_the_shell_writes_table() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("kanban.sqlite");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE kanban_boards (workspace_id TEXT PRIMARY KEY);
                 CREATE TABLE card_runs (
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
                     outcome TEXT NOT NULL,
                     resume_attempts INTEGER,
                     headroom_tokens_saved INTEGER,
                     headroom_requests INTEGER
                 );
                 INSERT INTO card_runs (workspace_id, path, session_id, conversation_id, started_at,
                     ended_at, exit_code, outcome)
                 VALUES ('ws-1', '/p/t.md', 's-old', 'c-old', 10, 20, 0, 'exited');",
            )
            .unwrap();
        }

        let store = KanbanStore::open(&path).unwrap();
        assert_eq!(store.card_runs("ws-1", "/p/t.md").unwrap().len(), 1, "the old rows survive");
        assert_eq!(store.shell_writes("c-old").unwrap(), ShellWrites::default(), "an older run has no record");
        store.record_shell_writes("c-new", "t-1", "/r", &paths(&["a.ts"])).unwrap();
        // A record older than the bound, as one written months ago.
        store
            .conn
            .execute(
                "INSERT INTO shell_writes (conversation_id, tool_call_id, root, paths, recorded_at)
                 VALUES ('c-new', 't-0', '/r', '[\"old.ts\"]', ?1)",
                params![now_secs() - SHELL_WRITES_KEPT_SECS - 60],
            )
            .unwrap();
        assert_eq!(store.shell_writes("c-new").unwrap().calls, paths(&["t-0", "t-1"]));

        drop(store);
        let reopened = KanbanStore::open(&path).unwrap();
        assert_eq!(reopened.shell_writes("c-new").unwrap().calls, paths(&["t-1"]), "pruned on open");
    }

    // --- the Workspace log (v79) ----------------------------------------

    fn log_kinds(store: &KanbanStore, workspace: &str) -> Vec<(LogKind, i64)> {
        let (entries, _) = store.workspace_log(workspace, None, 500, &[], None).unwrap();
        entries.into_iter().rev().map(|e| (e.kind, e.at)).collect()
    }

    /// The log is a new TABLE, which reaches an old file by itself; what
    /// has to be proved is the one-time copy. Against the v78 schema with
    /// runs in it: each run becomes a started entry and each watched exit
    /// a finished one, at their own times, a card on disk lends its title
    /// -- and a reopen copies nothing again, even after a clear.
    #[test]
    fn opening_a_pre_v79_database_copies_card_runs_into_the_log_once() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("kanban.sqlite");
        let card = dir.path().join("t.md");
        std::fs::write(&card, "---\ntitle: [feat] On disk\n---\n").unwrap();
        let card = card.to_string_lossy().to_string();
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE kanban_boards (workspace_id TEXT PRIMARY KEY);
                 CREATE TABLE card_runs (
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
                     outcome TEXT NOT NULL,
                     resume_attempts INTEGER,
                     headroom_tokens_saved INTEGER,
                     headroom_requests INTEGER
                 );",
            )
            .unwrap();
            conn.execute(
                "INSERT INTO card_runs (workspace_id, path, session_id, command, started_at, ended_at, exit_code, outcome)
                 VALUES ('ws-1', ?1, 's-1', 'claude x', 10, 20, 0, 'exited'),
                        ('ws-1', '/gone/u.md', 's-2', NULL, 30, 40, NULL, 'replaced'),
                        ('ws-2', '/gone/v.md', 's-3', 'codex', 50, NULL, NULL, 'running')",
                params![card],
            )
            .unwrap();
        }

        let mut store = KanbanStore::open(&path).unwrap();
        assert_eq!(
            log_kinds(&store, "ws-1"),
            vec![(LogKind::RunStarted, 10), (LogKind::RunFinished, 20), (LogKind::RunStarted, 30)],
            "a replaced run's end is not an exit"
        );
        assert_eq!(log_kinds(&store, "ws-2"), vec![(LogKind::RunStarted, 50)]);
        let (entries, _) = store.workspace_log("ws-1", None, 10, &[], None).unwrap();
        let finished = entries.iter().find(|e| e.kind == LogKind::RunFinished).unwrap();
        assert_eq!(finished.payload.card_title.as_deref(), Some("[feat] On disk"));
        assert_eq!(finished.payload.agent.as_deref(), Some("claude"));
        assert_eq!(finished.payload.exit_code, Some(0));
        let gone = entries.iter().find(|e| e.at == 30).unwrap();
        assert_eq!((gone.payload.card_title.as_deref(), gone.payload.card_file.as_deref()), (None, Some("u.md")));
        assert!(store.take_log_appended().is_empty(), "a copy is history, not news to push");

        assert_eq!(store.clear_workspace_log("ws-1", None).unwrap(), 3);
        drop(store);
        let reopened = KanbanStore::open(&path).unwrap();
        assert!(log_kinds(&reopened, "ws-1").is_empty(), "never copied twice");
        assert_eq!(log_kinds(&reopened, "ws-2").len(), 1);
    }

    #[test]
    fn a_run_is_journaled_when_it_starts_and_when_it_exits_and_a_restatement_is_not() {
        let (_dir, mut store) = store();
        link(&mut store, "/p/t.md", "s-1");
        // The same session linked again: a resume budget spent, not a run.
        link(&mut store, "/p/t.md", "s-1");
        store.finish_runs_for_session("s-1", Some(3)).unwrap();
        let kinds: Vec<LogKind> = log_kinds(&store, "ws-1").into_iter().map(|(k, _)| k).collect();
        assert_eq!(kinds, vec![LogKind::RunStarted, LogKind::RunFinished]);
        let pushed = store.take_log_appended();
        assert_eq!(pushed.len(), 2);
        assert_eq!(pushed[1].payload.exit_code, Some(3));
        assert_eq!(pushed[1].payload.agent.as_deref(), Some("claude"));
        assert_eq!(pushed[1].payload.card_file.as_deref(), Some("t.md"));
        assert!(store.take_log_appended().is_empty());
        // A session that ends with no run open logs nothing.
        store.finish_runs_for_session("s-1", Some(0)).unwrap();
        assert!(store.take_log_appended().is_empty());
    }

    #[test]
    fn clearing_older_than_keeps_newer_entries_and_every_card_run() {
        let (_dir, mut store) = store();
        link(&mut store, "/p/t.md", "s-1");
        store.finish_runs_for_session("s-1", Some(0)).unwrap();
        let now = now_secs();
        store.append_log("ws-1", now - 400 * 86_400, LogKind::CardCreated, &LogPayload::default()).unwrap();
        store.append_log("ws-1", now - 40 * 86_400, LogKind::CardMoved, &LogPayload::default()).unwrap();
        store.append_log("ws-2", now - 400 * 86_400, LogKind::CardCreated, &LogPayload::default()).unwrap();

        assert_eq!(store.clear_workspace_log("ws-1", Some(now - 30 * 86_400)).unwrap(), 2);
        let left: Vec<LogKind> = log_kinds(&store, "ws-1").into_iter().map(|(k, _)| k).collect();
        assert_eq!(left, vec![LogKind::RunStarted, LogKind::RunFinished]);
        assert_eq!(log_kinds(&store, "ws-2").len(), 1, "another workspace's log is its own");

        assert_eq!(store.clear_workspace_log("ws-1", None).unwrap(), 2);
        assert!(log_kinds(&store, "ws-1").is_empty());
        assert_eq!(store.card_runs("ws-1", "/p/t.md").unwrap().len(), 1, "card_runs is never touched");
    }

    // --- savings (v49) -------------------------------------------------

    /// Moves a run's end to a known second, so a window can be drawn
    /// around it.
    fn end_at(store: &KanbanStore, session: &str, ended_at: i64) {
        store
            .conn
            .execute("UPDATE card_runs SET ended_at = ?2 WHERE session_id = ?1", params![session, ended_at])
            .unwrap();
    }

    #[test]
    fn a_snapshot_lands_on_the_run_and_an_unsnapshotted_run_keeps_none() {
        let (_dir, mut store) = store();
        link(&mut store, "/p/a.md", "s-compressed");
        link(&mut store, "/p/b.md", "s-plain");
        store.finish_runs_for_session("s-compressed", Some(0)).unwrap();
        store.finish_runs_for_session("s-plain", Some(0)).unwrap();

        store.record_savings_for_session("s-compressed", 41_200, 37).unwrap();

        let compressed = &store.card_runs("ws-1", "/p/a.md").unwrap()[0];
        assert_eq!(compressed.headroom_tokens_saved, Some(41_200));
        assert_eq!(compressed.headroom_requests, Some(37));
        let plain = &store.card_runs("ws-1", "/p/b.md").unwrap()[0];
        assert_eq!(plain.headroom_tokens_saved, None, "no snapshot is not a saving of zero");
        assert_eq!(plain.headroom_requests, None);
    }

    /// The row a relaunch superseded is still the old session's run, and
    /// that session's saving is recorded when IT ends, later.
    #[test]
    fn a_snapshot_reaches_a_run_its_card_already_let_go_of() {
        let (_dir, mut store) = store();
        link(&mut store, "/p/t.md", "s-1");
        link(&mut store, "/p/t.md", "s-2");

        store.record_savings_for_session("s-1", 900, 4).unwrap();

        let runs = store.card_runs("ws-1", "/p/t.md").unwrap();
        assert_eq!(runs[1].session_id, "s-1");
        assert_eq!(runs[1].outcome, "replaced");
        assert_eq!(runs[1].headroom_tokens_saved, Some(900));
        assert_eq!(runs[0].headroom_tokens_saved, None, "the run that replaced it has its own session");
    }

    #[test]
    fn savings_since_lists_snapshots_by_where_their_run_ended() {
        let (_dir, mut store) = store();
        for (path, session) in [("/p/a.md", "s-early"), ("/p/b.md", "s-late"), ("/p/c.md", "s-plain")] {
            link(&mut store, path, session);
            store.finish_runs_for_session(session, Some(0)).unwrap();
        }
        link(&mut store, "/p/d.md", "s-live");
        store.record_savings_for_session("s-early", 100, 1).unwrap();
        store.record_savings_for_session("s-late", 2_000, 9).unwrap();
        end_at(&store, "s-early", 1_000);
        end_at(&store, "s-late", 5_000);
        end_at(&store, "s-plain", 5_000);

        let runs = store.savings_since(4_000).unwrap();

        assert_eq!(runs.len(), 1, "one run ended in the window with a snapshot: {runs:?}");
        assert_eq!(runs[0].session_id, "s-late");
        assert_eq!(runs[0].workspace_id, "ws-1");
        assert_eq!(runs[0].path, "/p/b.md");
        assert_eq!(runs[0].ended_at, Some(5_000));
        assert_eq!(runs[0].tokens_saved, 2_000);
        assert_eq!(runs[0].requests, 9);
        assert_eq!(store.savings_since(0).unwrap().len(), 2, "the open run and the plain one never count");
    }

    /// A `CardRuns` read that lands between a kill and its teardown
    /// abandons the run with no end, and the teardown's close skips it.
    /// Its snapshot still arrives, and has to be countable: it is given
    /// the end the sweep left out. A run that has an end keeps it.
    #[test]
    fn a_snapshot_on_a_run_abandoned_mid_kill_gives_it_an_end_and_keeps_every_other_end() {
        let (_dir, mut store) = store();
        link(&mut store, "/p/a.md", "s-killed");
        link(&mut store, "/p/b.md", "s-exited");
        store.abandon_runs_for_sessions(&["s-killed".to_string()]).unwrap();
        store.finish_runs_for_session("s-killed", Some(-1)).unwrap();
        store.finish_runs_for_session("s-exited", Some(0)).unwrap();
        end_at(&store, "s-exited", 1_000);
        let before = now_secs();

        store.record_savings_for_session("s-killed", 41_200, 37).unwrap();
        store.record_savings_for_session("s-exited", 900, 4).unwrap();

        let killed = &store.card_runs("ws-1", "/p/a.md").unwrap()[0];
        assert_eq!(killed.outcome, "abandoned", "the snapshot does not rewrite how the run ended");
        assert!(killed.ended_at.is_some_and(|at| at >= before), "{killed:?}");
        let exited = &store.card_runs("ws-1", "/p/b.md").unwrap()[0];
        assert_eq!(exited.ended_at, Some(1_000), "an end already written is kept");
        let counted: Vec<String> =
            store.savings_since(before).unwrap().into_iter().map(|run| run.session_id).collect();
        assert_eq!(counted, ["s-killed"]);
    }

    /// Every install already has a `card_runs` from v27, and `CREATE
    /// TABLE IF NOT EXISTS` never gives it the v49 columns. Without the
    /// ALTERs the run history stops loading entirely ("no such column:
    /// headroom_tokens_saved"), and every test above opens a file this
    /// build created, which is exactly why none of them can see it.
    #[test]
    fn opening_a_pre_v49_database_migrates_card_runs() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("kanban.sqlite");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE card_runs (
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
                     outcome TEXT NOT NULL,
                     resume_attempts INTEGER
                 );
                 INSERT INTO card_runs (workspace_id, path, session_id, command, started_at,
                     ended_at, exit_code, outcome)
                 VALUES ('ws-1', '/p/t.md', 's-old', 'claude', 10, 20, 0, 'exited');",
            )
            .unwrap();
        }

        let mut store = KanbanStore::open(&path).unwrap();
        let runs = store.card_runs("ws-1", "/p/t.md").unwrap();
        assert_eq!(runs.len(), 1, "the run from before v49 survives the migration");
        assert_eq!(runs[0].headroom_tokens_saved, None, "a run from before v49 has no snapshot");
        assert_eq!(runs[0].headroom_requests, None);

        store.record_savings_for_session("s-old", 5, 1).unwrap();
        assert_eq!(store.card_runs("ws-1", "/p/t.md").unwrap()[0].headroom_tokens_saved, Some(5));
        assert_eq!(store.savings_since(0).unwrap().len(), 1);

        // Idempotent: the ALTERs run on every open, and the second must
        // swallow the duplicate rather than fail the open.
        drop(store);
        let reopened = KanbanStore::open(&path).unwrap();
        assert_eq!(reopened.card_runs("ws-1", "/p/t.md").unwrap()[0].headroom_requests, Some(1));
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

    /// The board read's size cliff (v43). A protocol line is capped at
    /// `MAX_LINE_BYTES`, and a board that carried every binding's launch
    /// prompt crossed it at a few hundred runs -- after which the board,
    /// `gavin_get_board` and `gavin_get_orchestration` all stopped
    /// loading. Here the commands alone are well past the cap, and the
    /// board must still be one small line whose size does not depend on
    /// them at all.
    #[test]
    fn a_board_of_bindings_with_huge_commands_serialises_without_them() {
        const BINDINGS: usize = 400;
        let prompt = "p".repeat(4 * 1024);
        assert!((BINDINGS * prompt.len()) as u64 > protocol::MAX_LINE_BYTES, "the commands alone must be past the cap");

        let board_line = |command: Option<&str>| {
            let (_dir, mut store) = store();
            for i in 0..BINDINGS {
                let path = format!("/work/repo/.gavin-root/plans/card-{i:03}.md");
                store
                    .link_card_session(
                        "ws-1",
                        &path,
                        &format!("00000000-0000-0000-0000-{i:012}"),
                        "/work/repo",
                        command,
                        Some(&format!("11111111-1111-1111-1111-{i:012}")),
                        Some("/work/repo"),
                        Some(0),
                        Some("f75db30f75db30f75db30f75db30f75db30f75db"),
                    )
                    .unwrap();
            }
            let board = store.get_board("ws-1").unwrap();
            assert_eq!(board.card_sessions.len(), BINDINGS);
            let mut line = Vec::new();
            protocol::write_message(
                &mut line,
                &protocol::Response::Board {
                    columns: board.columns,
                    labels: board.labels,
                    card_sessions: board.card_sessions,
                },
            )
            .unwrap();
            line.len()
        };

        // Against a short command rather than none: whether a binding HAS
        // one is on the board (`replayable`), how long it is must not be.
        let with_prompts = board_line(Some(&prompt));
        assert_eq!(with_prompts, board_line(Some("claude 'x'")), "the board's size depends on its commands");
        // ~330 bytes a binding with realistic paths and ids: 400 of them is
        // an eighth of the cap, where the commands alone were 1.6 MiB.
        assert!(with_prompts < 400 * BINDINGS, "{with_prompts} bytes for {BINDINGS} bindings");
    }

    /// The one read that still carries the command: Re-launch replays it.
    #[test]
    fn a_single_binding_read_keeps_its_command() {
        let (_dir, mut store) = store();
        store
            .link_card_session("ws-1", "/p/t.md", "s-1", "/p", Some("claude 'x'"), Some("conv-1"), Some("/p"), Some(1), None)
            .unwrap();

        assert_eq!(store.get_board("ws-1").unwrap().card_sessions[0].command, None);
        let bound = store.card_session("ws-1", "/p/t.md").unwrap().unwrap();
        assert_eq!(bound.command.as_deref(), Some("claude 'x'"));
        assert_eq!(bound.conversation_id.as_deref(), Some("conv-1"));
        assert_eq!(store.card_session("ws-1", "/p/unbound.md").unwrap(), None);
        assert_eq!(store.card_session("ws-2", "/p/t.md").unwrap(), None);
    }

    /// A binding with no launch -- a session that claimed the card over
    /// MCP, or was linked while already running -- re-launched as a bare
    /// login shell bound to the card. The board says which bindings have
    /// something to replay, without carrying what it is.
    #[test]
    fn the_board_says_which_bindings_have_a_launch_to_replay() {
        let (_dir, mut store) = store();
        store.link_card_session("ws-1", "/p/a.md", "s-1", "/p", Some("claude 'x'"), None, None, None, None).unwrap();
        store.link_card_session("ws-1", "/p/b.md", "s-2", "/p", None, None, None, None, None).unwrap();
        store.link_card_session("ws-1", "/p/c.md", "s-3", "/p", Some("  "), None, None, None, None).unwrap();

        let board = store.get_board("ws-1").unwrap();
        let replayable = |path: &str| {
            let binding = board.card_sessions.iter().find(|cs| cs.path == path).unwrap();
            assert_eq!(binding.command, None, "the board read carries no command");
            binding.replayable
        };
        assert_eq!(replayable("/p/a.md"), Some(true));
        assert_eq!(replayable("/p/b.md"), Some(false));
        assert_eq!(replayable("/p/c.md"), Some(false));
        // The single read agrees with the board.
        assert_eq!(store.card_session("ws-1", "/p/a.md").unwrap().unwrap().replayable, Some(true));
        assert_eq!(store.card_session("ws-1", "/p/b.md").unwrap().unwrap().replayable, Some(false));
    }

    #[test]
    fn a_self_reported_conversation_id_lands_on_the_bound_card() {
        let (_dir, mut store) = store();
        store.link_card_session("ws-1", "/p/t.md", "s-1", "/p", None, None, None, None, None).unwrap();

        let updated = store.set_conversation_id_for_session("s-1", "rollout-abc123").unwrap();
        assert!(updated);

        let session = store.card_session("ws-1", "/p/t.md").unwrap().unwrap();
        assert_eq!(session.conversation_id, Some("rollout-abc123".to_string()));
    }

    #[test]
    fn a_conversation_id_for_an_unbound_session_is_a_no_op() {
        let (_dir, mut store) = store();
        let updated = store.set_conversation_id_for_session("s-nobody", "rollout-abc123").unwrap();
        assert!(!updated);
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
    fn purge_clears_a_path_across_workspaces() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = KanbanStore::open(&dir.path().join("kanban.sqlite")).unwrap();
        store.link_card_session("ws-1", "/p/t.md", "s-1", "/p", None, None, None, None, None).unwrap();
        store.link_card_session("ws-2", "/p/t.md", "s-2", "/p", None, None, None, None, None).unwrap();
        store.link_card_session("ws-1", "/p/other.md", "s-3", "/p", None, None, None, None, None).unwrap();

        store.purge_card("/p/t.md").unwrap();

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

    fn claim(path: &str, slot: Option<u64>) -> ScheduledClaim {
        ScheduledClaim {
            path: path.to_string(),
            schedule: Some("at=2026-10-21T09:00 every=2m runs=3".to_string()),
            runs: Some(3),
            paused: false,
            slot,
            skip_reason: None,
            report_path: format!("/r/runs/t/{}.md", slot.unwrap_or(99)),
            now: now_secs(),
        }
    }

    /// The dev and release daemons share kanban.sqlite: two handles on one
    /// file are two daemons, and one slot is fired by exactly one of them.
    #[test]
    fn a_fire_is_claimed_once_across_two_daemons_on_one_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("kanban.sqlite");
        let mut dev = KanbanStore::open(&path).unwrap();
        let mut release = KanbanStore::open(&path).unwrap();
        let won = dev.claim_scheduled_fire(&claim("/t.md", Some(4))).unwrap();
        assert!(won.claimed);
        assert_eq!(won.fire_number, Some(1));
        assert_eq!(won.report_path.as_deref(), Some("/r/runs/t/4.md"));
        let lost = release.claim_scheduled_fire(&claim("/t.md", Some(4))).unwrap();
        assert!(!lost.claimed, "{lost:?}");
        // Nor a slot behind it, which a lagging clock would compute.
        assert!(!release.claim_scheduled_fire(&claim("/t.md", Some(3))).unwrap().claimed);
        assert_eq!(release.scheduled_state("/t.md", "at=2026-10-21T09:00 every=2m runs=3").unwrap(), (1, Some(4)));
    }

    #[test]
    fn a_fire_while_the_last_run_is_going_is_skipped_and_counted() {
        let (_dir, mut store) = store();
        let first = store.claim_scheduled_fire(&claim("/t.md", Some(0))).unwrap();
        store.record_scheduled_launch(first.fire_id.unwrap(), Some("s-1"), None).unwrap();
        let second = store.claim_scheduled_fire(&claim("/t.md", Some(1))).unwrap();
        assert!(second.claimed);
        assert_eq!(second.skipped.as_deref(), Some("the previous run was still going"));
        assert_eq!(second.report_path, None);
        // A skip the app decided counts too.
        let mut walled = claim("/t.md", Some(2));
        walled.skip_reason = Some("paused for the usage limit".into());
        let third = store.claim_scheduled_fire(&walled).unwrap();
        assert_eq!(third.skipped.as_deref(), Some("paused for the usage limit"));
        assert_eq!(third.fire_number, Some(3));
        let fourth = store.claim_scheduled_fire(&claim("/t.md", Some(3))).unwrap();
        assert_eq!(fourth.why.as_deref(), Some("this task's schedule is completed"));

        let fires = store.scheduled_fires("/t.md", 20).unwrap();
        assert_eq!(fires.iter().map(|f| f.outcome.as_str()).collect::<Vec<_>>(), ["skipped", "skipped", "running"]);
        assert_eq!(store.finish_scheduled_for_session("s-1", Some(0)).unwrap(), ["/r/runs/t/0.md"]);
        let fires = store.scheduled_fires("/t.md", 20).unwrap();
        assert_eq!(fires[2].outcome, "exited");
        assert_eq!(fires[2].exit_code, Some(0));
    }

    #[test]
    fn run_now_never_counts_and_never_runs_twice_at_once() {
        let (_dir, mut store) = store();
        let now = store.claim_scheduled_fire(&claim("/t.md", None)).unwrap();
        assert!(now.claimed);
        assert_eq!(now.fire_number, None);
        assert_eq!(store.scheduled_state("/t.md", "at=2026-10-21T09:00 every=2m runs=3").unwrap(), (0, None));
        assert!(!store.claim_scheduled_fire(&claim("/t.md", None)).unwrap().claimed, "one at a time");
        store.record_scheduled_launch(now.fire_id.unwrap(), None, Some("no agent")).unwrap();
        let fires = store.scheduled_fires("/t.md", 20).unwrap();
        assert_eq!(fires[0].outcome, "failed");
        assert_eq!(fires[0].skip_reason.as_deref(), Some("no agent"));
        assert!(store.claim_scheduled_fire(&claim("/t.md", None)).unwrap().claimed);
    }

    #[test]
    fn a_paused_unscheduled_or_rescheduled_task_claims_accordingly() {
        let (_dir, mut store) = store();
        let mut paused = claim("/t.md", Some(0));
        paused.paused = true;
        assert_eq!(store.claim_scheduled_fire(&paused).unwrap().why.as_deref(), Some("this task is paused"));
        let mut none = claim("/t.md", Some(0));
        none.schedule = None;
        assert!(!store.claim_scheduled_fire(&none).unwrap().claimed);
        // Paused or not, Run now still runs.
        let mut paused_now = claim("/t.md", None);
        paused_now.paused = true;
        assert!(store.claim_scheduled_fire(&paused_now).unwrap().claimed);
        store.purge_scheduled("/t.md").unwrap();

        let mut once = claim("/t.md", Some(0));
        once.schedule = Some("at=2026-10-21T09:00".into());
        once.runs = Some(1);
        once.skip_reason = Some("x".into());
        assert!(store.claim_scheduled_fire(&once).unwrap().claimed);
        assert!(!store.claim_scheduled_fire(&once).unwrap().claimed);
        // The human moved the start: the count begins again.
        once.schedule = Some("at=2026-10-22T09:00".into());
        assert!(store.claim_scheduled_fire(&once).unwrap().claimed);
        assert_eq!(store.scheduled_state("/t.md", "at=2026-10-22T09:00").unwrap(), (1, Some(0)));
    }

    #[test]
    fn a_launch_never_recorded_stops_blocking_after_its_grace() {
        let (_dir, mut store) = store();
        let mut old = claim("/t.md", Some(0));
        old.now -= SCHEDULED_LAUNCH_GRACE_SECS + 5;
        store.claim_scheduled_fire(&old).unwrap();
        let next = store.claim_scheduled_fire(&claim("/t.md", Some(1))).unwrap();
        assert!(next.claimed);
        assert_eq!(next.skipped, None);
        assert_eq!(store.scheduled_fires("/t.md", 20).unwrap()[1].outcome, "abandoned");
    }

    /// The tables are new, so `CREATE TABLE IF NOT EXISTS` is what reaches
    /// an existing file -- proved against one built with the v76 schema.
    #[test]
    fn opening_a_pre_v77_database_adds_the_scheduled_tables() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("kanban.sqlite");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE kanban_boards (workspace_id TEXT PRIMARY KEY);
                 CREATE TABLE shell_writes (
                     conversation_id TEXT NOT NULL,
                     tool_call_id TEXT NOT NULL,
                     root TEXT NOT NULL,
                     paths TEXT NOT NULL,
                     recorded_at INTEGER NOT NULL,
                     PRIMARY KEY (conversation_id, tool_call_id)
                 );",
            )
            .unwrap();
        }
        let mut store = KanbanStore::open(&path).unwrap();
        assert!(store.scheduled_fires("/t.md", 20).unwrap().is_empty());
        assert!(store.claim_scheduled_fire(&claim("/t.md", Some(0))).unwrap().claimed);
        drop(store);
        let reopened = KanbanStore::open(&path).unwrap();
        assert_eq!(reopened.scheduled_fires("/t.md", 20).unwrap().len(), 1);
    }
}
