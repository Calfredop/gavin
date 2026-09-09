use protocol::{
    default_stage_mode, ConflictNote, GroupTemplate, GroupTemplateStep, Orchestration, Rail,
    RailRun, RailTrigger, Stage, Step, StepRun, ToolDef, ToolParam, ToolRun,
};
use rusqlite::{params, Connection};
use std::collections::{HashMap, HashSet};

/// The orchestration plan (rails → stages → steps, plus the agent's
/// conflict notes) and its machine-local run state. Its own SQLite file
/// beside kanban.sqlite: two stores, two connections, no shared lock.
pub struct OrchestrationStore {
    conn: Connection,
}

impl OrchestrationStore {
    pub fn open(path: &std::path::Path) -> anyhow::Result<Self> {
        let conn = Connection::open(path)?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS orch_rails (
                id TEXT PRIMARY KEY,
                workspace_id TEXT NOT NULL,
                name TEXT NOT NULL,
                position INTEGER NOT NULL,
                worktree_path TEXT,
                branch TEXT,
                trigger_kind TEXT,
                trigger_rail TEXT,
                page_id TEXT
            );
            CREATE TABLE IF NOT EXISTS orch_stages (
                id TEXT PRIMARY KEY,
                rail_id TEXT NOT NULL,
                position INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS orch_steps (
                id TEXT PRIMARY KEY,
                stage_id TEXT NOT NULL,
                position INTEGER NOT NULL,
                card_path TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS orch_conflict_notes (
                id TEXT PRIMARY KEY,
                workspace_id TEXT NOT NULL,
                note TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS orch_conflict_note_steps (
                note_id TEXT NOT NULL,
                step_id TEXT NOT NULL,
                PRIMARY KEY (note_id, step_id)
            );
            -- Run state: machine-local, never authored by the agent. No
            -- row means idle (rail) or pending (step), so a freshly
            -- authored plan needs no run-state writes at all.
            CREATE TABLE IF NOT EXISTS orch_rail_runs (
                rail_id TEXT PRIMARY KEY,
                state TEXT NOT NULL,
                current_stage_id TEXT
            );
            CREATE TABLE IF NOT EXISTS orch_step_runs (
                step_id TEXT PRIMARY KEY,
                state TEXT NOT NULL,
                session_id TEXT,
                reason TEXT
            );
            -- The tool library (tools spec T4). workspace_id NULL means
            -- GLOBAL: every workspace on this machine sees it. Built-in
            -- tools never land here -- they are constants in the app.
            CREATE TABLE IF NOT EXISTS orch_tools (
                id TEXT PRIMARY KEY,
                workspace_id TEXT,
                name TEXT NOT NULL,
                description TEXT NOT NULL,
                kind TEXT NOT NULL,
                body TEXT NOT NULL,
                params TEXT NOT NULL,
                position INTEGER NOT NULL
            );
            -- Group templates (grouping spec G8). workspace_id NULL means
            -- GLOBAL, per orch_tools. Members are one JSON column because
            -- a template is only ever read and written whole.
            CREATE TABLE IF NOT EXISTS orch_group_templates (
                id TEXT PRIMARY KEY,
                workspace_id TEXT,
                name TEXT NOT NULL,
                description TEXT NOT NULL,
                mode TEXT NOT NULL,
                steps TEXT NOT NULL,
                position INTEGER NOT NULL
            );
            -- v30: a run of a tool launched STANDALONE from the Tools
            -- tab. Shaped like kanban.sqlite's `card_runs` and here
            -- rather than there because a tool lives here: `orch_tools`
            -- is the library these rows point into, and a run whose tool
            -- is two files away is a join nobody can make.
            --
            -- A rail's steps are NOT in this table. A step already has
            -- an `orch_step_runs` row, and filing a second record for it
            -- would double-count one piece of work on two surfaces.
            --
            -- Append-only, like card_runs: the Tools tab reads only the
            -- LAST run per tool, but keeping just that one would mean
            -- overwriting a row while its session might still be
            -- running, which is the exact bug card_runs was written to
            -- fix.
            CREATE TABLE IF NOT EXISTS tool_runs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                workspace_id TEXT NOT NULL,
                tool_id TEXT NOT NULL,
                session_id TEXT NOT NULL,
                command TEXT,
                launch_cwd TEXT,
                conversation_id TEXT,
                started_at INTEGER NOT NULL,
                ended_at INTEGER,
                exit_code INTEGER,
                -- running | passed | failed | abandoned. Never null.
                outcome TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS tool_runs_by_tool
                ON tool_runs (workspace_id, tool_id, id);
            CREATE INDEX IF NOT EXISTS tool_runs_by_session
                ON tool_runs (session_id);",
        )?;
        // orch_steps predates tool steps and is already live on disk, so
        // CREATE TABLE IF NOT EXISTS above would silently keep the old
        // shape. Add the columns idempotently instead.
        add_column_if_missing(&conn, "orch_steps", "tool_id", "TEXT")?;
        add_column_if_missing(&conn, "orch_steps", "tool_params", "TEXT")?;
        // orch_stages predates groups and is already live on disk, so the
        // CREATE TABLE above would silently keep the old shape.
        add_column_if_missing(&conn, "orch_stages", "mode", "TEXT")?;
        add_column_if_missing(&conn, "orch_stages", "name", "TEXT")?;
        // orch_rails predates branch binding for the same reason.
        add_column_if_missing(&conn, "orch_rails", "branch", "TEXT")?;
        // v21: the agent CLI's own conversation id for this run, and the
        // directory it was LAUNCHED in. Both nullable, because a profile
        // with no verified resume argv records neither and a run from
        // before v21 has neither -- and "no conversation to resume" is
        // the honest reading of an absent id, not an error.
        add_column_if_missing(&conn, "orch_step_runs", "conversation_id", "TEXT")?;
        add_column_if_missing(&conn, "orch_step_runs", "launch_cwd", "TEXT")?;
        // v22: the per-rail auto-resume opt-in, and the persisted budget
        // for the resumes it performs. The budget is on the RUN because
        // that is what it bounds -- one automatic attempt per run -- and
        // it is on DISK because an app reload and a daemon restart are
        // the conditions auto-resume exists for. Both nullable: a rail
        // authored before v22 has no opinion, which reads as off, and a
        // run that was never resumed has no count, which reads as zero.
        add_column_if_missing(&conn, "orch_rails", "auto_resume", "INTEGER")?;
        add_column_if_missing(&conn, "orch_step_runs", "resume_attempts", "INTEGER")?;
        // v35: the rail's own start condition. Two columns rather than
        // one JSON blob because a trigger is only ever a kind and at most
        // a rail NAME, and a name in a column is greppable from the
        // sqlite3 prompt when a human is asking why a rail armed itself.
        // Both nullable and read together: no kind means no trigger,
        // which is every rail written before v35.
        add_column_if_missing(&conn, "orch_rails", "trigger_kind", "TEXT")?;
        add_column_if_missing(&conn, "orch_rails", "trigger_rail", "TEXT")?;
        // v30: a tool's own working directory, for a standalone run from
        // the Tools tab. orch_tools is already live on disk in every
        // install, so the CREATE TABLE above keeps the old shape and
        // `tools()` -- which selects the column by name -- would fail the
        // whole library read with "no such column: cwd". Nullable, and
        // NULL is the honest reading: a tool authored before v30 has no
        // directory of its own and runs at the workspace root.
        add_column_if_missing(&conn, "orch_tools", "cwd", "TEXT")?;
        // v33: the tool's own glyph, named from the app's icon library.
        // Same migration for the same reason as `cwd` above -- `tools()`
        // selects it by name, so without the ALTER the first library
        // read on a v32 file fails with "no such column: icon" and takes
        // the whole library with it. NULL is the honest reading: a tool
        // authored before v33 never picked one, and draws whatever its
        // KIND draws.
        add_column_if_missing(&conn, "orch_tools", "icon", "TEXT")?;
        // Every tool run still open belongs to a daemon that is gone.
        // This runs once per process, before any launch of this lifetime
        // has reached the store, so an open row here is by construction
        // one this process inherited. `ended_at` stays NULL rather than
        // being back-filled with now(): the run ended when its daemon
        // did, and nobody watched that happen. Same sweep card_runs
        // performs on open, and for the same reason -- without it the
        // Tools tab would show a run that has been over for days as
        // still going.
        conn.execute(
            "UPDATE tool_runs SET outcome = 'abandoned'
             WHERE ended_at IS NULL AND outcome = 'running'",
            [],
        )?;
        Ok(Self { conn })
    }

    pub fn get(&self, workspace_id: &str) -> anyhow::Result<Orchestration> {
        let mut rails: Vec<Rail> = self
            .conn
            .prepare(
                "SELECT id, name, position, worktree_path, branch, auto_resume,
                        trigger_kind, trigger_rail, page_id FROM orch_rails
                 WHERE workspace_id = ?1 ORDER BY position",
            )?
            .query_map(params![workspace_id], |row| {
                // The KIND is what says a trigger exists at all: a rail
                // name with no kind is a half-written row (a hand edit,
                // an interrupted migration) and reads as no trigger,
                // which is the reading that starts nothing.
                let trigger_kind: Option<String> = row.get(6)?;
                let trigger_rail: Option<String> = row.get(7)?;
                Ok(Rail {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    position: row.get(2)?,
                    worktree_path: row.get(3)?,
                    branch: row.get(4)?,
                    // SQLite has no bool: the column is INTEGER, so it
                    // comes back as one and 0/1 is the opt-in.
                    auto_resume: row.get::<_, Option<i64>>(5)?.map(|v| v != 0),
                    trigger: trigger_kind.map(|kind| RailTrigger { kind, rail: trigger_rail }),
                    page_id: row.get(8)?,
                    stages: Vec::new(),
                })
            })?
            .collect::<Result<_, _>>()?;

        for rail in rails.iter_mut() {
            let mut stages: Vec<Stage> = self
                .conn
                .prepare(
                    "SELECT id, position, mode, name FROM orch_stages
                     WHERE rail_id = ?1 ORDER BY position",
                )?
                .query_map(params![rail.id], |row| {
                    let mode: Option<String> = row.get(2)?;
                    Ok(Stage {
                        id: row.get(0)?,
                        position: row.get(1)?,
                        // NULL is a row written before groups existed;
                        // anything unrecognised is a hand edit or a newer
                        // peer. Both degrade to the discipline every
                        // existing plan already ran under.
                        mode: match mode.as_deref() {
                            Some("sequence") => "sequence".into(),
                            _ => protocol::default_stage_mode(),
                        },
                        name: row.get(3)?,
                        steps: Vec::new(),
                    })
                })?
                .collect::<Result<_, _>>()?;
            for stage in stages.iter_mut() {
                stage.steps = self
                    .conn
                    .prepare(
                        "SELECT id, position, card_path, tool_id, tool_params FROM orch_steps
                         WHERE stage_id = ?1 ORDER BY position",
                    )?
                    .query_map(params![stage.id], |row| {
                        let tool_params: Option<String> = row.get(4)?;
                        Ok(Step {
                            id: row.get(0)?,
                            position: row.get(1)?,
                            card_path: row.get(2)?,
                            tool_id: row.get(3)?,
                            // Rows written before tool steps existed have
                            // NULL here, and a hand-corrupted value must
                            // not fail the whole read: both degrade to no
                            // overrides, which resolves to the tool's own
                            // defaults.
                            tool_params: tool_params
                                .and_then(|j| serde_json::from_str(&j).ok())
                                .unwrap_or_default(),
                        })
                    })?
                    .collect::<Result<_, _>>()?;
            }
            rail.stages = stages;
        }

        let mut conflict_notes: Vec<ConflictNote> = self
            .conn
            .prepare("SELECT id, note FROM orch_conflict_notes WHERE workspace_id = ?1 ORDER BY id")?
            .query_map(params![workspace_id], |row| {
                Ok(ConflictNote { id: row.get(0)?, note: row.get(1)?, step_ids: Vec::new() })
            })?
            .collect::<Result<_, _>>()?;
        for note in conflict_notes.iter_mut() {
            note.step_ids = self
                .conn
                .prepare("SELECT step_id FROM orch_conflict_note_steps WHERE note_id = ?1 ORDER BY step_id")?
                .query_map(params![note.id], |row| row.get(0))?
                .collect::<Result<_, _>>()?;
        }

        let rail_ids: HashSet<String> = rails.iter().map(|r| r.id.clone()).collect();
        let step_ids: HashSet<String> = rails
            .iter()
            .flat_map(|r| r.stages.iter().flat_map(|s| s.steps.iter().map(|t| t.id.clone())))
            .collect();

        let rail_runs: Vec<RailRun> = self
            .conn
            .prepare("SELECT rail_id, state, current_stage_id FROM orch_rail_runs")?
            .query_map([], |row| {
                Ok(RailRun { rail_id: row.get(0)?, state: row.get(1)?, current_stage_id: row.get(2)? })
            })?
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .filter(|r| rail_ids.contains(&r.rail_id))
            .collect();

        let step_runs: Vec<StepRun> = self
            .conn
            .prepare(
                "SELECT step_id, state, session_id, reason, conversation_id, launch_cwd, resume_attempts \
                 FROM orch_step_runs",
            )?
            .query_map([], |row| {
                Ok(StepRun {
                    step_id: row.get(0)?,
                    state: row.get(1)?,
                    session_id: row.get(2)?,
                    reason: row.get(3)?,
                    conversation_id: row.get(4)?,
                    launch_cwd: row.get(5)?,
                    resume_attempts: row.get::<_, Option<i64>>(6)?.map(|v| v.max(0) as u32),
                })
            })?
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .filter(|r| step_ids.contains(&r.step_id))
            .collect();

        Ok(Orchestration { rails, conflict_notes, rail_runs, step_runs })
    }

    /// Wholesale replace (spec O11), in one transaction. Validates
    /// first, so a refused write leaves the stored plan untouched.
    pub fn replace_plan(
        &mut self,
        workspace_id: &str,
        rails: &[Rail],
        notes: &[ConflictNote],
        // The sessions the daemon still hosts, for guard 3 below. Only
        // the caller knows this -- the store holds no PTYs.
        live_sessions: &HashSet<String>,
    ) -> anyhow::Result<()> {
        let incoming: HashSet<&str> = rails
            .iter()
            .flat_map(|r| r.stages.iter().flat_map(|s| s.steps.iter().map(|t| t.id.as_str())))
            .collect();

        // Guard 1: duplicate ids anywhere.
        let mut seen: HashSet<&str> = HashSet::new();
        for rail in rails {
            if !seen.insert(rail.id.as_str()) {
                anyhow::bail!("duplicate id {}", rail.id);
            }
            for stage in &rail.stages {
                if !seen.insert(stage.id.as_str()) {
                    anyhow::bail!("duplicate id {}", stage.id);
                }
                for step in &stage.steps {
                    if !seen.insert(step.id.as_str()) {
                        anyhow::bail!("duplicate id {}", step.id);
                    }
                }
            }
        }

        // Guard 2: a step is a card OR a tool, never both and never
        // neither -- everything downstream branches on exactly that
        // (tools spec T1), and a step that is neither would launch
        // nothing forever.
        for rail in rails {
            for stage in &rail.stages {
                for step in &stage.steps {
                    match (step.card_path.is_empty(), step.tool_id.is_some()) {
                        (true, false) => anyhow::bail!(
                            "step {} has neither a cardPath nor a toolId",
                            step.id
                        ),
                        (false, true) => anyhow::bail!(
                            "step {} has both a cardPath and a toolId — a step is one or the other",
                            step.id
                        ),
                        _ => {}
                    }
                }
            }
        }

        // Guard 3: a running step must survive the replace, or its live
        // session is orphaned. LIVE is the whole point, so the row alone
        // does not decide it: only the app writes run state, and a row it
        // left at `running` for a session that has since ended -- the app
        // quit mid-run, the rail was never re-ticked -- has nothing left
        // to orphan. Refusing on such a row would wedge the plan shut
        // forever, since the rail carrying it could then never be edited
        // or deleted. A row with no session id at all cannot be alive
        // either.
        let running: Vec<(String, String, Option<String>)> = self
            .conn
            .prepare(
                "SELECT sr.step_id, st.card_path, sr.session_id FROM orch_step_runs sr
                 JOIN orch_steps st ON st.id = sr.step_id
                 JOIN orch_stages sg ON sg.id = st.stage_id
                 JOIN orch_rails r ON r.id = sg.rail_id
                 WHERE r.workspace_id = ?1 AND sr.state = 'running'",
            )?
            .query_map(params![workspace_id], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })?
            .collect::<Result<_, _>>()?;
        for (step_id, card_path, session_id) in &running {
            if incoming.contains(step_id.as_str()) {
                continue;
            }
            let alive = session_id.as_deref().is_some_and(|id| live_sessions.contains(id));
            if alive {
                anyhow::bail!(
                    "step {step_id} ({card_path}) is running — pause or let it finish before removing it"
                );
            }
        }

        // Guard 4: every conflict note names steps in this same payload.
        for note in notes {
            for step_id in &note.step_ids {
                if !incoming.contains(step_id.as_str()) {
                    anyhow::bail!("conflict note {} names unknown step {step_id}", note.id);
                }
            }
        }

        let tx = self.conn.transaction()?;
        tx.execute(
            "DELETE FROM orch_steps WHERE stage_id IN (
                SELECT s.id FROM orch_stages s JOIN orch_rails r ON s.rail_id = r.id
                WHERE r.workspace_id = ?1)",
            params![workspace_id],
        )?;
        tx.execute(
            "DELETE FROM orch_stages WHERE rail_id IN (SELECT id FROM orch_rails WHERE workspace_id = ?1)",
            params![workspace_id],
        )?;
        tx.execute("DELETE FROM orch_rails WHERE workspace_id = ?1", params![workspace_id])?;
        tx.execute(
            "DELETE FROM orch_conflict_note_steps WHERE note_id IN (
                SELECT id FROM orch_conflict_notes WHERE workspace_id = ?1)",
            params![workspace_id],
        )?;
        tx.execute("DELETE FROM orch_conflict_notes WHERE workspace_id = ?1", params![workspace_id])?;

        for rail in rails {
            tx.execute(
                "INSERT INTO orch_rails (id, workspace_id, name, position, worktree_path, branch,
                                          auto_resume, trigger_kind, trigger_rail, page_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    rail.id,
                    workspace_id,
                    rail.name,
                    rail.position,
                    rail.worktree_path,
                    rail.branch,
                    rail.auto_resume.map(|v| i64::from(v)),
                    rail.trigger.as_ref().map(|t| t.kind.clone()),
                    rail.trigger.as_ref().and_then(|t| t.rail.clone()),
                    rail.page_id
                ],
            )?;
            for stage in &rail.stages {
                tx.execute(
                    "INSERT INTO orch_stages (id, rail_id, position, mode, name)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![stage.id, rail.id, stage.position, stage.mode, stage.name],
                )?;
                for step in &stage.steps {
                    tx.execute(
                        "INSERT INTO orch_steps (id, stage_id, position, card_path, tool_id, tool_params)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                        params![
                            step.id,
                            stage.id,
                            step.position,
                            step.card_path,
                            step.tool_id,
                            serde_json::to_string(&step.tool_params)?
                        ],
                    )?;
                }
            }
        }
        for note in notes {
            tx.execute(
                "INSERT INTO orch_conflict_notes (id, workspace_id, note) VALUES (?1, ?2, ?3)",
                params![note.id, workspace_id, note.note],
            )?;
            for step_id in &note.step_ids {
                tx.execute(
                    "INSERT INTO orch_conflict_note_steps (note_id, step_id) VALUES (?1, ?2)",
                    params![note.id, step_id],
                )?;
            }
        }

        // Orphan sweep: ids are UUIDs, so a global sweep is safe and
        // cheaper than scoping it back to this workspace.
        tx.execute("DELETE FROM orch_step_runs WHERE step_id NOT IN (SELECT id FROM orch_steps)", [])?;
        tx.execute("DELETE FROM orch_rail_runs WHERE rail_id NOT IN (SELECT id FROM orch_rails)", [])?;
        tx.commit()?;
        Ok(())
    }

    /// Every distinct card path this workspace's steps point at. Tool
    /// steps carry no card and are left out.
    pub fn step_card_paths(&self, workspace_id: &str) -> anyhow::Result<Vec<String>> {
        let paths = self
            .conn
            .prepare(
                "SELECT DISTINCT t.card_path FROM orch_steps t
                 JOIN orch_stages s ON t.stage_id = s.id
                 JOIN orch_rails r ON s.rail_id = r.id
                 WHERE r.workspace_id = ?1 AND t.card_path <> ''",
            )?
            .query_map(params![workspace_id], |row| row.get(0))?
            .collect::<Result<_, _>>()?;
        Ok(paths)
    }

    /// Every workspace with a step aimed at this card. The re-key below
    /// is deliberately global -- one card can sit on rails in more than
    /// one workspace -- so this answers who has to be told about it.
    pub fn workspaces_with_card(&self, card_path: &str) -> anyhow::Result<Vec<String>> {
        let ids = self
            .conn
            .prepare(
                "SELECT DISTINCT r.workspace_id FROM orch_steps t
                 JOIN orch_stages s ON t.stage_id = s.id
                 JOIN orch_rails r ON s.rail_id = r.id
                 WHERE t.card_path = ?1",
            )?
            .query_map(params![card_path], |row| row.get(0))?
            .collect::<Result<_, _>>()?;
        Ok(ids)
    }

    /// Re-keys every step pointing at a card whose file moved. Steps are
    /// authored against a card, not a folder, so an archived card must
    /// not read as a broken step on the rail that runs it.
    pub fn rename_card_path(&mut self, old_path: &str, new_path: &str) -> anyhow::Result<()> {
        self.conn.execute(
            "UPDATE orch_steps SET card_path = ?2 WHERE card_path = ?1",
            params![old_path, new_path],
        )?;
        Ok(())
    }

    /// Removes every step aimed at a card whose file was DELETED, the
    /// stage any of them emptied, and the run and conflict-note rows
    /// that named them. Answers how many steps went.
    ///
    /// The counterpart to `rename_card_path`: a move re-keys a step
    /// because the card is still somewhere, a delete has nothing left to
    /// point at. Left behind, the step would render as "card file is
    /// missing" on a rail forever -- a chip naming a file no restore can
    /// ever bring back.
    ///
    /// A stage left with no steps goes too, matching `removeSteps` in
    /// the app (orchestration.ts): an empty stage draws nothing in the
    /// rail grid, so one left behind is a gap the scheduler steps over
    /// and nobody can see to remove. Only the stages THIS card emptied
    /// -- an empty stage an agent authored through the MCP is not this
    /// function's to collect.
    ///
    /// Unconditional, unlike `set_orchestration`'s refusal to remove a
    /// RUNNING step. That guard can say "wait" because the human is
    /// editing a plan and the card is still on disk to come back to; by
    /// the time this runs the file is already gone, so refusing would
    /// only keep a step pointing at nothing.
    pub fn remove_card_steps(&mut self, card_path: &str) -> anyhow::Result<usize> {
        let tx = self.conn.transaction()?;
        // Read the stages BEFORE the delete: afterwards there is no row
        // left to say which ones this card was in.
        let touched: Vec<String> = tx
            .prepare("SELECT DISTINCT stage_id FROM orch_steps WHERE card_path = ?1")?
            .query_map(params![card_path], |row| row.get(0))?
            .collect::<Result<_, _>>()?;
        let removed = tx.execute("DELETE FROM orch_steps WHERE card_path = ?1", params![card_path])?;
        if removed > 0 {
            for stage_id in &touched {
                tx.execute(
                    "DELETE FROM orch_stages WHERE id = ?1
                     AND NOT EXISTS (SELECT 1 FROM orch_steps WHERE stage_id = ?1)",
                    params![stage_id],
                )?;
            }
            // The same orphan sweep set_orchestration ends with, and for
            // the same reason: ids are UUIDs, so a global sweep is safe.
            // The note-step link matters beyond tidiness -- a note naming
            // a step that no longer exists is what Guard 4 refuses on the
            // next save.
            tx.execute(
                "DELETE FROM orch_conflict_note_steps WHERE step_id NOT IN (SELECT id FROM orch_steps)",
                [],
            )?;
            tx.execute("DELETE FROM orch_step_runs WHERE step_id NOT IN (SELECT id FROM orch_steps)", [])?;
        }
        tx.commit()?;
        Ok(removed)
    }

    pub fn set_rail_run(
        &mut self,
        rail_id: &str,
        state: &str,
        current_stage_id: Option<&str>,
    ) -> anyhow::Result<()> {
        self.conn.execute(
            "INSERT INTO orch_rail_runs (rail_id, state, current_stage_id) VALUES (?1, ?2, ?3)
             ON CONFLICT(rail_id) DO UPDATE SET state = ?2, current_stage_id = ?3",
            params![rail_id, state, current_stage_id],
        )?;
        Ok(())
    }

    /// `conversation_id` and `launch_cwd` are written on the way IN and
    /// never cleared by a later write that omits them: the launch records
    /// them once, and every subsequent transition of the same step (a
    /// stall, a done) carries None. Losing them there would leave exactly
    /// the state that most needs a resume -- a stalled step -- with
    /// nothing to resume.
    pub fn set_step_run(
        &mut self,
        step_id: &str,
        state: &str,
        session_id: Option<&str>,
        reason: Option<&str>,
        conversation_id: Option<&str>,
        launch_cwd: Option<&str>,
        resume_attempts: Option<u32>,
    ) -> anyhow::Result<()> {
        self.conn.execute(
            "INSERT INTO orch_step_runs (step_id, state, session_id, reason, conversation_id, launch_cwd, resume_attempts)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(step_id) DO UPDATE SET
               state = ?2, session_id = ?3, reason = ?4,
               conversation_id = COALESCE(?5, orch_step_runs.conversation_id),
               launch_cwd = COALESCE(?6, orch_step_runs.launch_cwd),
               resume_attempts = COALESCE(?7, orch_step_runs.resume_attempts)",
            params![
                step_id,
                state,
                session_id,
                reason,
                conversation_id,
                launch_cwd,
                resume_attempts.map(i64::from)
            ],
        )?;
        Ok(())
    }

    // ---- The tool library --------------------------------------------------
    // Targeted upsert/delete rather than the plan's wholesale replace: a
    // tool outlives every arrangement that uses it (tools spec T8).

    /// This workspace's own tools plus every GLOBAL one, workspace-first
    /// so a workspace tool shadows a same-named global in the app's
    /// merge. `workspace_id IS NULL` is the global marker.
    pub fn tools(&self, workspace_id: &str) -> anyhow::Result<Vec<ToolDef>> {
        let tools = self
            .conn
            .prepare(
                "SELECT id, workspace_id, name, description, kind, body, params, position, cwd, icon
                 FROM orch_tools
                 WHERE workspace_id = ?1 OR workspace_id IS NULL
                 ORDER BY workspace_id IS NULL, position, name",
            )?
            .query_map(params![workspace_id], |row| {
                let params_json: String = row.get(6)?;
                Ok(ToolDef {
                    id: row.get(0)?,
                    workspace_id: row.get(1)?,
                    name: row.get(2)?,
                    description: row.get(3)?,
                    kind: row.get(4)?,
                    body: row.get(5)?,
                    // A tool with unreadable params is still a runnable
                    // tool; losing the whole library over one bad row is
                    // the worse failure.
                    params: serde_json::from_str::<Vec<ToolParam>>(&params_json).unwrap_or_default(),
                    position: row.get(7)?,
                    cwd: row.get(8)?,
                    icon: row.get(9)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(tools)
    }

    /// Upsert by id. Re-saving with the other `workspace_id` is how a
    /// tool moves between this-workspace and global scope, which is why
    /// the column is in the UPDATE list.
    pub fn save_tool(&mut self, tool: &ToolDef) -> anyhow::Result<()> {
        if tool.id.is_empty() {
            anyhow::bail!("a tool needs an id");
        }
        if tool.id.starts_with("builtin:") {
            anyhow::bail!("{} is a built-in tool — duplicate it instead of saving over it", tool.id);
        }
        if tool.name.trim().is_empty() {
            anyhow::bail!("a tool needs a name");
        }
        // NOT an allow-list of kinds, deliberately, and it was one until
        // 2026-09-07. The daemon does not branch on `kind` anywhere --
        // this function is the only place it reads one, and every rule
        // about what a kind DOES (an `until` step sending a rail
        // backwards, a `pr` step waiting on GitHub, a `gavin` step
        // resolving inside its own launch) lives in the app's scheduler.
        // So the list here was a second copy of a vocabulary this layer
        // does not own, and it drifted three times without anything
        // failing: `gavin` (2026-09-02), `until` and `pr` (2026-09-03)
        // and `review` (2026-09-04) each became authorable in the app
        // while this still read agent|command|script. Duplicating "Wait
        // for the pull request" and pressing Save died here, after the
        // human had typed.
        //
        // It also bought nothing. The allow-list never protected against
        // a bad body -- `command` was always on it -- and the app is
        // what refuses a body its kind cannot express (`validateTool`)
        // and what offers the chips a human picks from. Meanwhile a
        // NEWER app is a supported client: the compat band reaches back
        // to v5, so a list here refuses saves the app is entitled to
        // make. Same reasoning as `icon` one field down, and the same as
        // `ToolKind` being a raw `String` on the wire.
        //
        // An EMPTY kind is still refused: nothing means it, and the app
        // reads an unrecognised kind as a shell command line, so a blank
        // one would quietly run a prompt in a terminal.
        if tool.kind.trim().is_empty() {
            anyhow::bail!("a tool needs a kind");
        }
        // An empty string is not a directory, it is an untouched text
        // field: stored as NULL so "runs at the workspace root" has one
        // representation rather than two the readers have to agree on.
        let cwd = tool.cwd.as_deref().map(str::trim).filter(|c| !c.is_empty());
        // An empty icon is not an icon, on the same rule as `cwd`: NULL
        // is "draw whatever this tool's kind draws", and it must have one
        // spelling rather than two the readers have to agree on. The NAME
        // itself is not validated here -- the library it comes from lives
        // in the app, and a daemon that invented a rule would refuse a
        // glyph a newer app knows about.
        let icon = tool.icon.as_deref().map(str::trim).filter(|c| !c.is_empty());
        self.conn.execute(
            "INSERT INTO orch_tools (id, workspace_id, name, description, kind, body, params, position, cwd, icon)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(id) DO UPDATE SET
               workspace_id = ?2, name = ?3, description = ?4, kind = ?5,
               body = ?6, params = ?7, position = ?8, cwd = ?9, icon = ?10",
            params![
                tool.id,
                tool.workspace_id,
                tool.name,
                tool.description,
                tool.kind,
                tool.body,
                serde_json::to_string(&tool.params)?,
                tool.position,
                cwd,
                icon
            ],
        )?;
        Ok(())
    }

    /// Deleting a tool a step still references is DELIBERATELY allowed:
    /// the plan is the human's, and a step that stalls with "tool is no
    /// longer in the library" is recoverable where a refused delete or a
    /// silently gutted rail is not.
    pub fn delete_tool(&mut self, id: &str) -> anyhow::Result<()> {
        self.conn.execute("DELETE FROM orch_tools WHERE id = ?1", params![id])?;
        Ok(())
    }

    // ---- Group templates ---------------------------------------------------
    // Targeted upsert/delete, like the tool library: a template outlives
    // every arrangement that uses it.

    /// This workspace's own templates plus every GLOBAL one,
    /// workspace-first so a workspace template shadows a same-named
    /// global in the app's merge.
    pub fn group_templates(&self, workspace_id: &str) -> anyhow::Result<Vec<GroupTemplate>> {
        let templates = self
            .conn
            .prepare(
                "SELECT id, workspace_id, name, description, mode, steps, position
                 FROM orch_group_templates
                 WHERE workspace_id = ?1 OR workspace_id IS NULL
                 ORDER BY workspace_id IS NULL, position, name",
            )?
            .query_map(params![workspace_id], |row| {
                let steps_json: String = row.get(5)?;
                let mode: String = row.get(4)?;
                Ok(GroupTemplate {
                    id: row.get(0)?,
                    workspace_id: row.get(1)?,
                    name: row.get(2)?,
                    description: row.get(3)?,
                    mode: if mode == "sequence" { mode } else { default_stage_mode() },
                    // A template with unreadable members is not a
                    // template; an empty list renders as a dead row the
                    // human can delete, where a failed read would take
                    // the whole library with it.
                    steps: serde_json::from_str::<Vec<GroupTemplateStep>>(&steps_json)
                        .unwrap_or_default(),
                    position: row.get(6)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(templates)
    }

    /// Upsert by id. Re-saving with the other `workspace_id` is how a
    /// template moves between this-workspace and global scope, which is
    /// why the column is in the UPDATE list.
    pub fn save_group_template(&mut self, t: &GroupTemplate) -> anyhow::Result<()> {
        if t.id.is_empty() {
            anyhow::bail!("a group template needs an id");
        }
        if t.name.trim().is_empty() {
            anyhow::bail!("a group template needs a name");
        }
        if t.steps.is_empty() {
            anyhow::bail!("a group template needs at least one step");
        }
        if t.steps.iter().any(|s| s.tool_id.trim().is_empty()) {
            anyhow::bail!("every group template step needs a tool");
        }
        self.conn.execute(
            "INSERT INTO orch_group_templates (id, workspace_id, name, description, mode, steps, position)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(id) DO UPDATE SET
               workspace_id = ?2, name = ?3, description = ?4, mode = ?5,
               steps = ?6, position = ?7",
            params![
                t.id,
                t.workspace_id,
                t.name,
                t.description,
                t.mode,
                serde_json::to_string(&t.steps)?,
                t.position
            ],
        )?;
        Ok(())
    }

    /// Deleting a template is DELIBERATELY unconditional: a template is
    /// copied at placement, so no rail can be holding a reference to it.
    pub fn delete_group_template(&mut self, id: &str) -> anyhow::Result<()> {
        self.conn.execute("DELETE FROM orch_group_templates WHERE id = ?1", params![id])?;
        Ok(())
    }

    // ---- Standalone tool runs (v30) ----------------------------------------
    // A run of a library tool launched from the Tools tab, rather than as
    // a step on a rail. Opened by the app at launch and closed either by
    // the daemon (a shell exits, and its code is the verdict) or by the
    // app (an agent's turn ends, which no process event marks).

    /// Opens a run. Any run this session already had open is closed as
    /// `abandoned` first: one session hosts one tool run, so a second
    /// open row for it could only be a record whose end nobody saw.
    pub fn start_tool_run(
        &mut self,
        workspace_id: &str,
        tool_id: &str,
        session_id: &str,
        command: Option<&str>,
        launch_cwd: Option<&str>,
        conversation_id: Option<&str>,
    ) -> anyhow::Result<()> {
        let tx = self.conn.transaction()?;
        tx.execute(
            "UPDATE tool_runs SET outcome = 'abandoned'
             WHERE session_id = ?1 AND outcome = 'running'",
            params![session_id],
        )?;
        tx.execute(
            "INSERT INTO tool_runs (workspace_id, tool_id, session_id, command, launch_cwd,
               conversation_id, started_at, outcome)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'running')",
            params![workspace_id, tool_id, session_id, command, launch_cwd, conversation_id, now_secs()],
        )?;
        tx.commit()?;
        Ok(())
    }

    /// Records a verdict the daemon could not reach on its own -- an
    /// `agent` tool, whose session is still alive when its turn ends.
    ///
    /// Only a row that is still `running` is touched, so a later exit can
    /// never overwrite a verdict already recorded, and a second call for
    /// the same session is a no-op rather than a rewrite. `ended_at` is
    /// stamped for anything but `running`, because this caller DID watch
    /// the run end.
    pub fn set_tool_run_outcome(
        &mut self,
        session_id: &str,
        outcome: &str,
        exit_code: Option<i32>,
    ) -> anyhow::Result<()> {
        if !matches!(outcome, "running" | "passed" | "failed" | "abandoned") {
            anyhow::bail!("unknown tool run outcome {outcome}");
        }
        let ended_at = if outcome == "running" { None } else { Some(now_secs()) };
        self.conn.execute(
            "UPDATE tool_runs SET outcome = ?2, ended_at = ?3, exit_code = ?4
             WHERE session_id = ?1 AND outcome = 'running'",
            params![session_id, outcome, ended_at, exit_code],
        )?;
        Ok(())
    }

    /// Closes whatever tool run a session WAS, off the exit the daemon
    /// already watches. The counterpart to `card_runs`'
    /// `finish_runs_for_session`, and called from the same place -- the
    /// one block that runs for both a natural exit and a kill.
    ///
    /// The exit code IS the verdict for a `command` or `script` tool
    /// (tools spec T5), so it is turned into `passed`/`failed` here
    /// rather than left for a reader to interpret. An `agent` tool's row
    /// is already closed by the time its session ends -- the app filed
    /// the turn's verdict when the agent went quiet -- so this leaves it
    /// alone, exactly as the `outcome = 'running'` guard says.
    pub fn finish_tool_runs_for_session(
        &mut self,
        session_id: &str,
        exit_code: Option<i32>,
    ) -> anyhow::Result<()> {
        // An exit nobody could read a code from is not a pass. `failed`
        // rather than `abandoned`: the daemon DID watch this session
        // end, so the one thing it is not is unobserved.
        let outcome = if exit_code == Some(0) { "passed" } else { "failed" };
        self.conn.execute(
            "UPDATE tool_runs SET outcome = ?2, ended_at = ?3, exit_code = ?4
             WHERE session_id = ?1 AND outcome = 'running'",
            params![session_id, outcome, now_secs(), exit_code],
        )?;
        Ok(())
    }

    /// Downgrades tool runs that still CLAIM to be running but whose
    /// session is gone. The same sweep `card_runs` has, for the same
    /// reason: a session that ends with nothing attached has no pump to
    /// report its exit, so its row would sit open forever.
    pub fn abandon_tool_runs_for_sessions(&mut self, session_ids: &[String]) -> anyhow::Result<()> {
        let tx = self.conn.transaction()?;
        for id in session_ids {
            tx.execute(
                "UPDATE tool_runs SET outcome = 'abandoned' WHERE session_id = ?1 AND outcome = 'running'",
                params![id],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// The LAST run of each of this workspace's tools. Not a history:
    /// the Tools tab draws one chip per row and would throw the rest
    /// away, and a response that grew with every run would be paid for
    /// on every tab visit.
    ///
    /// `MAX(id)` rather than `MAX(started_at)`: two runs of one tool can
    /// land in the same second, and the row id is the only total order
    /// there is.
    pub fn tool_runs(&self, workspace_id: &str) -> anyhow::Result<Vec<ToolRun>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, tool_id, session_id, command, launch_cwd, conversation_id,
                    started_at, ended_at, exit_code, outcome
             FROM tool_runs
             WHERE id IN (
               SELECT MAX(id) FROM tool_runs WHERE workspace_id = ?1 GROUP BY tool_id
             )
             ORDER BY id DESC",
        )?;
        let rows = stmt.query_map(params![workspace_id], |row| {
            Ok(ToolRun {
                id: row.get(0)?,
                tool_id: row.get(1)?,
                session_id: row.get(2)?,
                command: row.get(3)?,
                launch_cwd: row.get(4)?,
                conversation_id: row.get(5)?,
                started_at: row.get(6)?,
                ended_at: row.get(7)?,
                exit_code: row.get(8)?,
                outcome: row.get(9)?,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }
}

/// Wall-clock epoch seconds. The registry's `started_at_us` is a process
/// start time kept as a pid-reuse guard, not a clock anyone can
/// subtract, so a run keeps its own -- the same call `kanban.rs` makes
/// for `card_runs`.
fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// `ALTER TABLE ... ADD COLUMN` is not idempotent and SQLite has no
/// `IF NOT EXISTS` for it, so ask the schema first. Cheap enough to run
/// on every open, and the only migration path that leaves an already-live
/// orchestration.sqlite intact.
fn add_column_if_missing(
    conn: &Connection,
    table: &str,
    column: &str,
    decl: &str,
) -> anyhow::Result<()> {
    let existing: HashMap<String, ()> = conn
        .prepare(&format!("PRAGMA table_info({table})"))?
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .map(|name| (name, ()))
        .collect();
    if existing.contains_key(column) {
        return Ok(());
    }
    conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column} {decl}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The sessions the daemon still hosts. Empty is the common case
    /// here: these tests store run rows without a live PTY behind them.
    fn none() -> HashSet<String> {
        HashSet::new()
    }

    fn live(ids: &[&str]) -> HashSet<String> {
        ids.iter().map(|s| (*s).to_string()).collect()
    }

    fn store() -> OrchestrationStore {
        OrchestrationStore::open(std::path::Path::new(":memory:")).unwrap()
    }

    fn rail(id: &str, steps: &[(&str, &str)]) -> Rail {
        Rail {
            id: id.into(),
            name: id.into(),
            position: 0,
            worktree_path: None,
            branch: None,
            auto_resume: None,
            trigger: None,
            page_id: None,
            stages: vec![Stage {
                id: format!("{id}-s1"),
                position: 0,
                mode: protocol::default_stage_mode(),
                name: None,
                steps: steps
                    .iter()
                    .enumerate()
                    .map(|(i, (sid, path))| Step {
                        id: (*sid).into(),
                        position: i as i64,
                        card_path: (*path).into(),
                        tool_id: None,
                        tool_params: HashMap::new(),
                    })
                    .collect(),
            }],
        }
    }

    #[test]
    fn unknown_workspace_reads_as_an_empty_orchestration() {
        let s = store();
        let o = s.get("ws-1").unwrap();
        assert!(o.rails.is_empty() && o.rail_runs.is_empty() && o.step_runs.is_empty());
    }

    #[test]
    fn replace_plan_round_trips_rails_stages_and_steps() {
        let mut s = store();
        s.replace_plan("ws-1", &[rail("r1", &[("t1", "/x/a.md")])], &[], &none()).unwrap();
        let o = s.get("ws-1").unwrap();
        assert_eq!(o.rails.len(), 1);
        assert_eq!(o.rails[0].stages[0].steps[0].card_path, "/x/a.md");
    }

    #[test]
    fn replace_plan_round_trips_stage_mode_and_name() {
        let mut r = rail("r1", &[("t1", "/x/a.md")]);
        r.stages[0].mode = "sequence".into();
        r.stages[0].name = Some("Merge and push".into());
        let mut s = store();
        s.replace_plan("ws-1", &[r], &[], &none()).unwrap();
        let o = s.get("ws-1").unwrap();
        assert_eq!(o.rails[0].stages[0].mode, "sequence");
        assert_eq!(o.rails[0].stages[0].name.as_deref(), Some("Merge and push"));
    }

    #[test]
    fn a_stage_row_written_before_v15_reads_as_parallel() {
        // The columns are added by migration, so an existing row has NULL in
        // both. NULL must read as the discipline that row actually ran under.
        let mut s = store();
        s.replace_plan("ws-1", &[rail("r1", &[("t1", "/x/a.md")])], &[], &none()).unwrap();
        let stage_id = s.get("ws-1").unwrap().rails[0].stages[0].id.clone();
        s.conn
            .execute(
                "UPDATE orch_stages SET mode = NULL, name = NULL WHERE id = ?1",
                params![stage_id],
            )
            .unwrap();
        let o = s.get("ws-1").unwrap();
        assert_eq!(o.rails[0].stages[0].mode, "parallel");
        assert_eq!(o.rails[0].stages[0].name, None);
    }

    #[test]
    fn an_unknown_stage_mode_reads_as_parallel() {
        // A hand-edited or newer-peer value must degrade to the discipline
        // every existing plan already ran under, never fail the whole read.
        let mut s = store();
        s.replace_plan("ws-1", &[rail("r1", &[("t1", "/x/a.md")])], &[], &none()).unwrap();
        let stage_id = s.get("ws-1").unwrap().rails[0].stages[0].id.clone();
        s.conn
            .execute("UPDATE orch_stages SET mode = 'lockstep' WHERE id = ?1", params![stage_id])
            .unwrap();
        assert_eq!(s.get("ws-1").unwrap().rails[0].stages[0].mode, "parallel");
    }

    #[test]
    fn rename_card_path_follows_a_moved_card_on_every_rail() {
        let mut s = store();
        s.replace_plan("ws-1", &[rail("r1", &[("t1", "/x/a.md"), ("t2", "/x/b.md")])], &[], &none()).unwrap();
        s.replace_plan("ws-2", &[rail("r2", &[("t3", "/x/a.md")])], &[], &none()).unwrap();

        s.rename_card_path("/x/a.md", "/x/done/a.md").unwrap();

        let steps = &s.get("ws-1").unwrap().rails[0].stages[0].steps;
        assert_eq!(steps[0].card_path, "/x/done/a.md");
        assert_eq!(steps[1].card_path, "/x/b.md");
        assert_eq!(s.get("ws-2").unwrap().rails[0].stages[0].steps[0].card_path, "/x/done/a.md");
    }

    #[test]
    fn remove_card_steps_takes_the_step_on_every_rail_and_leaves_the_others() {
        let mut s = store();
        s.replace_plan("ws-1", &[rail("r1", &[("t1", "/x/a.md"), ("t2", "/x/b.md")])], &[], &none()).unwrap();
        s.replace_plan("ws-2", &[rail("r2", &[("t3", "/x/a.md")])], &[], &none()).unwrap();

        assert_eq!(s.remove_card_steps("/x/a.md").unwrap(), 2);

        let steps = &s.get("ws-1").unwrap().rails[0].stages[0].steps;
        assert_eq!(steps.len(), 1);
        assert_eq!(steps[0].card_path, "/x/b.md");
        // ws-2's stage held nothing else, so the stage went with the step
        // -- but the rail itself stays: an empty rail is a real thing the
        // human made, an empty stage is not.
        let rails = s.get("ws-2").unwrap().rails;
        assert_eq!(rails.len(), 1);
        assert!(rails[0].stages.is_empty());
    }

    #[test]
    fn remove_card_steps_takes_the_run_row_and_note_link_with_the_step() {
        let mut s = store();
        s.replace_plan(
            "ws-1",
            &[rail("r1", &[("t1", "/x/a.md"), ("t2", "/x/b.md")])],
            &[ConflictNote { id: "n1".into(), note: "same file".into(), step_ids: vec!["t1".into(), "t2".into()] }],
            &none(),
        )
        .unwrap();
        s.set_step_run("t1", "running", Some("sess-1"), None, None, None, None).unwrap();

        s.remove_card_steps("/x/a.md").unwrap();

        let o = s.get("ws-1").unwrap();
        assert!(o.step_runs.iter().all(|r| r.step_id != "t1"), "the run row named a step that no longer exists");
        // Guard 4 refuses a note naming an unknown step, so a stale link
        // would wedge the very next save of this plan.
        assert_eq!(o.conflict_notes[0].step_ids, vec!["t2".to_string()]);
    }

    /// The delete is unconditional where an EDIT would be refused: by the
    /// time it runs the card's file is already gone, so keeping the step
    /// would only preserve a chip pointing at nothing.
    #[test]
    fn remove_card_steps_does_not_refuse_a_running_step() {
        let mut s = store();
        s.replace_plan("ws-1", &[rail("r1", &[("t1", "/x/a.md")])], &[], &none()).unwrap();
        s.set_step_run("t1", "running", Some("sess-1"), None, None, None, None).unwrap();

        assert_eq!(s.remove_card_steps("/x/a.md").unwrap(), 1);
        assert!(s.get("ws-1").unwrap().rails[0].stages.is_empty());
    }

    #[test]
    fn remove_card_steps_leaves_a_stage_it_did_not_empty() {
        let mut s = store();
        s.replace_plan("ws-1", &[rail("r1", &[("t1", "/x/a.md")])], &[], &none()).unwrap();

        assert_eq!(s.remove_card_steps("/x/nothing.md").unwrap(), 0);
        assert_eq!(s.get("ws-1").unwrap().rails[0].stages.len(), 1);
    }

    #[test]
    fn replace_plan_replaces_rather_than_appends_and_is_workspace_scoped() {
        let mut s = store();
        s.replace_plan("ws-1", &[rail("r1", &[("t1", "/x/a.md")])], &[], &none()).unwrap();
        s.replace_plan("ws-2", &[rail("r2", &[("t2", "/x/b.md")])], &[], &none()).unwrap();
        s.replace_plan("ws-1", &[rail("r3", &[("t3", "/x/c.md")])], &[], &none()).unwrap();
        assert_eq!(s.get("ws-1").unwrap().rails.len(), 1);
        assert_eq!(s.get("ws-1").unwrap().rails[0].id, "r3");
        assert_eq!(s.get("ws-2").unwrap().rails[0].id, "r2");
    }

    #[test]
    fn run_state_survives_a_replace_that_keeps_the_step_id() {
        let mut s = store();
        s.replace_plan("ws-1", &[rail("r1", &[("t1", "/x/a.md")])], &[], &none()).unwrap();
        s.set_step_run("t1", "done", Some("sess-1"), None, None, None, None).unwrap();
        // Same step id, moved into a differently-named rail.
        let mut moved = rail("r9", &[("t1", "/x/a.md")]);
        moved.name = "renamed".into();
        s.replace_plan("ws-1", &[moved], &[], &none()).unwrap();
        let o = s.get("ws-1").unwrap();
        assert_eq!(o.step_runs.len(), 1);
        assert_eq!(o.step_runs[0].state, "done");
        assert_eq!(o.step_runs[0].session_id.as_deref(), Some("sess-1"));
    }

    #[test]
    fn run_state_for_a_vanished_step_is_dropped() {
        let mut s = store();
        s.replace_plan("ws-1", &[rail("r1", &[("t1", "/x/a.md")])], &[], &none()).unwrap();
        s.set_step_run("t1", "done", None, None, None, None, None).unwrap();
        s.replace_plan("ws-1", &[rail("r1", &[("t2", "/x/b.md")])], &[], &none()).unwrap();
        assert!(s.get("ws-1").unwrap().step_runs.is_empty());
    }

    #[test]
    fn deleting_a_running_step_is_refused_and_changes_nothing() {
        let mut s = store();
        s.replace_plan("ws-1", &[rail("r1", &[("t1", "/x/a.md")])], &[], &none()).unwrap();
        s.set_step_run("t1", "running", Some("sess-1"), None, None, None, None).unwrap();
        let err = s
            .replace_plan("ws-1", &[rail("r1", &[("t2", "/x/b.md")])], &[], &live(&["sess-1"]))
            .unwrap_err()
            .to_string();
        assert!(err.contains("t1"), "message names the step: {err}");
        assert!(err.contains("/x/a.md"), "message names the card path: {err}");
        // The stored plan is untouched.
        assert_eq!(s.get("ws-1").unwrap().rails[0].stages[0].steps[0].id, "t1");
    }

    /// The guard exists to keep a LIVE agent from being orphaned. A row
    /// left at `running` by a session the daemon no longer hosts has
    /// nothing left to orphan, and refusing on it would wedge the plan
    /// forever: the human could never delete the rail carrying it.
    #[test]
    fn deleting_a_running_step_whose_session_is_gone_is_allowed() {
        let mut s = store();
        s.replace_plan("ws-1", &[rail("r1", &[("t1", "/x/a.md")])], &[], &none()).unwrap();
        s.set_step_run("t1", "running", Some("sess-1"), None, None, None, None).unwrap();
        s.replace_plan("ws-1", &[rail("r1", &[("t2", "/x/b.md")])], &[], &live(&["sess-9"]))
            .unwrap();
        let o = s.get("ws-1").unwrap();
        assert_eq!(o.rails[0].stages[0].steps[0].id, "t2");
        assert!(o.step_runs.is_empty(), "the stale row is swept with its step");
    }

    /// `running` with no session id at all cannot be alive either.
    #[test]
    fn deleting_a_running_step_with_no_session_is_allowed() {
        let mut s = store();
        s.replace_plan("ws-1", &[rail("r1", &[("t1", "/x/a.md")])], &[], &none()).unwrap();
        s.set_step_run("t1", "running", None, None, None, None, None).unwrap();
        s.replace_plan("ws-1", &[rail("r1", &[("t2", "/x/b.md")])], &[], &live(&["sess-1"]))
            .unwrap();
        assert_eq!(s.get("ws-1").unwrap().rails[0].stages[0].steps[0].id, "t2");
    }

    #[test]
    fn moving_a_running_step_between_rails_is_allowed() {
        let mut s = store();
        s.replace_plan("ws-1", &[rail("r1", &[("t1", "/x/a.md")])], &[], &none()).unwrap();
        s.set_step_run("t1", "running", Some("sess-1"), None, None, None, None).unwrap();
        s.replace_plan("ws-1", &[rail("r2", &[("t1", "/x/a.md")])], &[], &live(&["sess-1"])).unwrap();
        let o = s.get("ws-1").unwrap();
        assert_eq!(o.rails[0].id, "r2");
        assert_eq!(o.step_runs[0].state, "running");
    }

    #[test]
    fn duplicate_ids_are_refused() {
        let mut s = store();
        let err = s
            .replace_plan("ws-1", &[rail("r1", &[("t1", "/x/a.md"), ("t1", "/x/b.md")])], &[], &none())
            .unwrap_err()
            .to_string();
        assert!(err.contains("duplicate"), "{err}");
    }

    #[test]
    fn a_conflict_note_naming_an_unknown_step_is_refused() {
        let mut s = store();
        let note = ConflictNote { id: "n1".into(), step_ids: vec!["nope".into()], note: "x".into() };
        let err = s
            .replace_plan("ws-1", &[rail("r1", &[("t1", "/x/a.md")])], &[note], &none())
            .unwrap_err()
            .to_string();
        assert!(err.contains("nope"), "{err}");
    }

    #[test]
    fn conflict_notes_round_trip() {
        let mut s = store();
        let note = ConflictNote { id: "n1".into(), step_ids: vec!["t1".into()], note: "careful".into() };
        s.replace_plan("ws-1", &[rail("r1", &[("t1", "/x/a.md")])], &[note], &none()).unwrap();
        let o = s.get("ws-1").unwrap();
        assert_eq!(o.conflict_notes[0].note, "careful");
        assert_eq!(o.conflict_notes[0].step_ids, vec!["t1".to_string()]);
    }

    fn tool(id: &str, workspace_id: Option<&str>) -> ToolDef {
        ToolDef {
            id: id.into(),
            workspace_id: workspace_id.map(str::to_string),
            name: format!("Tool {id}"),
            description: "does a thing".into(),
            kind: "command".into(),
            body: "echo {{what}}".into(),
            params: vec![ToolParam {
                name: "what".into(),
                label: "What".into(),
                default: "hi".into(),
            }],
            position: 0,
            cwd: None,
            icon: None,
        }
    }

    fn tool_step(id: &str, tool_id: &str) -> Rail {
        Rail {
            id: "rt".into(),
            name: "rt".into(),
            position: 0,
            worktree_path: None,
            branch: None,
            auto_resume: None,
            trigger: None,
            page_id: None,
            stages: vec![Stage {
                id: "rt-s1".into(),
                position: 0,
                mode: protocol::default_stage_mode(),
                name: None,
                steps: vec![Step {
                    id: id.into(),
                    position: 0,
                    card_path: String::new(),
                    tool_id: Some(tool_id.into()),
                    tool_params: HashMap::from([("what".to_string(), "bye".to_string())]),
                }],
            }],
        }
    }

    #[test]
    fn a_tool_step_round_trips_with_its_overrides() {
        let mut s = store();
        s.replace_plan("ws-1", &[tool_step("t1", "u1")], &[], &none()).unwrap();
        let step = s.get("ws-1").unwrap().rails[0].stages[0].steps[0].clone();
        assert_eq!(step.tool_id.as_deref(), Some("u1"));
        assert_eq!(step.card_path, "");
        assert_eq!(step.tool_params.get("what").map(String::as_str), Some("bye"));
    }

    #[test]
    fn a_step_that_is_neither_a_card_nor_a_tool_is_refused() {
        let mut s = store();
        let err = s.replace_plan("ws-1", &[rail("r1", &[("t1", "")])], &[], &none()).unwrap_err().to_string();
        assert!(err.contains("neither"), "{err}");
    }

    #[test]
    fn a_step_that_is_both_a_card_and_a_tool_is_refused() {
        let mut s = store();
        let mut both = tool_step("t1", "u1");
        both.stages[0].steps[0].card_path = "/x/a.md".into();
        let err = s.replace_plan("ws-1", &[both], &[], &none()).unwrap_err().to_string();
        assert!(err.contains("both"), "{err}");
    }

    #[test]
    fn tools_returns_this_workspaces_own_plus_every_global_one() {
        let mut s = store();
        s.save_tool(&tool("u1", Some("ws-1"))).unwrap();
        s.save_tool(&tool("u2", Some("ws-2"))).unwrap();
        s.save_tool(&tool("g1", None)).unwrap();
        let ids: Vec<String> = s.tools("ws-1").unwrap().into_iter().map(|t| t.id).collect();
        assert_eq!(ids, vec!["u1".to_string(), "g1".to_string()]);
    }

    #[test]
    fn saving_a_tool_twice_upserts_and_can_change_its_scope() {
        let mut s = store();
        s.save_tool(&tool("u1", Some("ws-1"))).unwrap();
        let mut promoted = tool("u1", None);
        promoted.name = "Renamed".into();
        s.save_tool(&promoted).unwrap();
        let workspace_view = s.tools("ws-1").unwrap();
        assert_eq!(workspace_view.len(), 1);
        assert_eq!(workspace_view[0].name, "Renamed");
        assert_eq!(workspace_view[0].workspace_id, None);
        // Global now, so an unrelated workspace sees it too.
        assert_eq!(s.tools("ws-9").unwrap().len(), 1);
    }

    #[test]
    fn tool_params_round_trip_as_json() {
        let mut s = store();
        s.save_tool(&tool("u1", Some("ws-1"))).unwrap();
        let back = s.tools("ws-1").unwrap().remove(0);
        assert_eq!(back.params.len(), 1);
        assert_eq!(back.params[0].name, "what");
        assert_eq!(back.params[0].default, "hi");
    }

    #[test]
    fn a_builtin_id_cannot_be_saved_over() {
        let mut s = store();
        let err = s.save_tool(&tool("builtin:push", None)).unwrap_err().to_string();
        assert!(err.contains("built-in"), "{err}");
    }

    /// Every kind the app can author, saved and read back.
    ///
    /// This is the test that was missing while `save_tool` kept an
    /// allow-list of three: `gavin` (2026-09-02), `until` and `pr`
    /// (2026-09-03) and `review` (2026-09-04) each became authorable in
    /// the app without anything here noticing, so duplicating "Wait for
    /// the pull request" and pressing Save failed with "unknown tool
    /// kind pr" -- after the human had typed.
    #[test]
    fn every_kind_the_app_can_author_round_trips() {
        for kind in ["agent", "command", "script", "gavin", "until", "pr", "review"] {
            let mut s = store();
            let mut t = tool("u1", Some("ws-1"));
            t.kind = kind.into();
            s.save_tool(&t).unwrap_or_else(|e| panic!("saving a {kind} tool: {e}"));
            assert_eq!(s.tools("ws-1").unwrap()[0].kind, kind);
        }
    }

    /// The one thing left of the old allow-list, and the only part of it
    /// that was ever protecting anything: the app reads a kind it does
    /// not recognise as a shell command line, so a blank one would
    /// quietly run an agent prompt in a terminal.
    #[test]
    fn a_tool_with_no_kind_at_all_is_still_refused() {
        let mut s = store();
        let mut bad = tool("u1", None);
        bad.kind = "   ".into();
        let err = s.save_tool(&bad).unwrap_err().to_string();
        assert!(err.contains("kind"), "{err}");
    }

    /// A kind a NEWER app authored is stored, not refused. The compat
    /// band reaches back to v5, so an app several versions ahead of this
    /// daemon is a supported client -- and every rule about what a kind
    /// DOES lives in that app, which is the half that would know how to
    /// judge one.
    #[test]
    fn a_kind_this_daemon_has_never_heard_of_is_stored() {
        let mut s = store();
        let mut t = tool("u1", Some("ws-1"));
        t.kind = "teleport".into();
        s.save_tool(&t).unwrap();
        assert_eq!(s.tools("ws-1").unwrap()[0].kind, "teleport");
    }

    #[test]
    fn deleting_a_tool_a_step_still_uses_is_allowed_and_leaves_the_step() {
        let mut s = store();
        s.save_tool(&tool("u1", Some("ws-1"))).unwrap();
        s.replace_plan("ws-1", &[tool_step("t1", "u1")], &[], &none()).unwrap();
        s.delete_tool("u1").unwrap();
        assert!(s.tools("ws-1").unwrap().is_empty());
        assert_eq!(s.get("ws-1").unwrap().rails[0].stages[0].steps[0].tool_id.as_deref(), Some("u1"));
    }

    fn a_group_template(id: &str, workspace_id: Option<&str>) -> GroupTemplate {
        GroupTemplate {
            id: id.into(),
            workspace_id: workspace_id.map(str::to_string),
            name: "Merge and push".into(),
            description: "Land it, then push".into(),
            mode: "sequence".into(),
            steps: vec![GroupTemplateStep {
                tool_id: "builtin:push".into(),
                tool_params: HashMap::from([("remote".to_string(), "origin".to_string())]),
            }],
            position: 0,
        }
    }

    #[test]
    fn save_then_get_group_templates_round_trips() {
        let mut s = store();
        s.save_group_template(&a_group_template("g1", Some("ws-1"))).unwrap();
        let got = s.group_templates("ws-1").unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].mode, "sequence");
        assert_eq!(got[0].steps[0].tool_id, "builtin:push");
        assert_eq!(got[0].steps[0].tool_params.get("remote").map(String::as_str), Some("origin"));
    }

    #[test]
    fn a_global_template_is_visible_from_every_workspace() {
        let mut s = store();
        s.save_group_template(&a_group_template("g1", None)).unwrap();
        for ws in ["ws-1", "ws-2"] {
            assert_eq!(s.group_templates(ws).unwrap().len(), 1, "{ws}");
        }
    }

    #[test]
    fn another_workspaces_template_is_not_visible() {
        let mut s = store();
        s.save_group_template(&a_group_template("g1", Some("ws-2"))).unwrap();
        assert!(s.group_templates("ws-1").unwrap().is_empty());
    }

    #[test]
    fn re_saving_with_the_other_scope_moves_it() {
        // Re-saving with a different workspace_id is how a template changes
        // scope, exactly as it is for a tool -- so the column is in the
        // UPDATE list and this must not create a second row.
        let mut s = store();
        s.save_group_template(&a_group_template("g1", Some("ws-1"))).unwrap();
        s.save_group_template(&a_group_template("g1", None)).unwrap();
        assert_eq!(s.group_templates("ws-2").unwrap().len(), 1);
    }

    #[test]
    fn a_template_needs_a_name_and_at_least_one_step() {
        let mut s = store();
        let mut t = a_group_template("g1", Some("ws-1"));
        t.name = "   ".into();
        assert!(s.save_group_template(&t).is_err());
        let mut t = a_group_template("g2", Some("ws-1"));
        t.steps.clear();
        assert!(s.save_group_template(&t).is_err());
    }

    #[test]
    fn delete_group_template_removes_it() {
        let mut s = store();
        s.save_group_template(&a_group_template("g1", Some("ws-1"))).unwrap();
        s.delete_group_template("g1").unwrap();
        assert!(s.group_templates("ws-1").unwrap().is_empty());
    }

    /// A hand-edited or newer-peer mode must degrade to the discipline
    /// every template already carries, never fail the whole read -- same
    /// rule as a stage's own `an_unknown_stage_mode_reads_as_parallel`.
    #[test]
    fn an_unknown_group_template_mode_reads_as_parallel() {
        let mut s = store();
        s.save_group_template(&a_group_template("g1", Some("ws-1"))).unwrap();
        s.conn
            .execute("UPDATE orch_group_templates SET mode = 'lockstep' WHERE id = 'g1'", [])
            .unwrap();
        assert_eq!(s.group_templates("ws-1").unwrap()[0].mode, "parallel");
    }

    /// An unreadable `steps` JSON degrades to an empty list -- a dead row
    /// the human can delete -- rather than failing the whole library read,
    /// same rule as a tool's unreadable `params` (tools spec T4).
    #[test]
    fn a_template_with_unreadable_steps_json_degrades_to_an_empty_list() {
        let mut s = store();
        s.save_group_template(&a_group_template("g1", Some("ws-1"))).unwrap();
        s.conn
            .execute(
                "UPDATE orch_group_templates SET steps = 'not json' WHERE id = 'g1'",
                [],
            )
            .unwrap();
        let got = s.group_templates("ws-1").unwrap();
        assert_eq!(got.len(), 1);
        assert!(got[0].steps.is_empty());
    }

    // ---- The tool's own icon (v33) ----------------------------------

    #[test]
    fn a_tools_icon_round_trips() {
        let mut s = store();
        let mut t = tool("u1", Some("ws-1"));
        t.icon = Some("rocket".into());
        s.save_tool(&t).unwrap();
        assert_eq!(s.tools("ws-1").unwrap()[0].icon.as_deref(), Some("rocket"));
    }

    /// The daemon does not know what a glyph name means and deliberately
    /// does not check: the library is a curated list in the app, and a
    /// rule invented here would refuse a name a newer app knows about.
    /// The app resolves what it can and falls back to the kind's glyph
    /// for the rest.
    #[test]
    fn an_icon_name_this_daemon_has_never_heard_of_is_still_stored() {
        let mut s = store();
        let mut t = tool("u1", Some("ws-1"));
        t.icon = Some("teleporter".into());
        s.save_tool(&t).unwrap();
        assert_eq!(s.tools("ws-1").unwrap()[0].icon.as_deref(), Some("teleporter"));
    }

    /// "No icon" has to have ONE spelling, the same rule the working
    /// directory follows: every reader turns absence into "draw this
    /// tool's kind", and an empty string would be a second absence they
    /// would each have to remember.
    #[test]
    fn a_blank_icon_is_stored_as_absent() {
        let mut s = store();
        let mut t = tool("u1", Some("ws-1"));
        t.icon = Some("  ".into());
        s.save_tool(&t).unwrap();
        assert_eq!(s.tools("ws-1").unwrap()[0].icon, None);
    }

    /// Clearing the icon has to REACH the row -- `icon` is in the
    /// upsert's UPDATE list for the reason `cwd` is: a re-save that
    /// dropped the column would leave a tool wearing a glyph the human
    /// just took off it.
    #[test]
    fn clearing_an_icon_on_re_save_removes_it() {
        let mut s = store();
        let mut t = tool("u1", Some("ws-1"));
        t.icon = Some("rocket".into());
        s.save_tool(&t).unwrap();
        t.icon = None;
        s.save_tool(&t).unwrap();
        assert_eq!(s.tools("ws-1").unwrap()[0].icon, None);
    }

    /// The migration CREATE TABLE IF NOT EXISTS cannot perform, the
    /// second time around: a live orch_tools keeps its v32 shape, and
    /// `tools()` names `icon` in its SELECT -- so without the ALTER the
    /// first library read on that file fails with "no such column: icon"
    /// and takes every tool with it.
    #[test]
    fn opening_a_pre_v33_database_adds_the_tool_icon_column() {
        let dir = std::env::temp_dir().join(format!("gavin-tool-icon-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("orchestration.sqlite");
        let _ = std::fs::remove_file(&path);
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE orch_tools (
                    id TEXT PRIMARY KEY, workspace_id TEXT, name TEXT NOT NULL,
                    description TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL,
                    params TEXT NOT NULL, position INTEGER NOT NULL, cwd TEXT);",
            )
            .unwrap();
            conn.execute(
                "INSERT INTO orch_tools (id, workspace_id, name, description, kind, body, params, position)
                 VALUES ('u1','ws-1','Old','','command','echo hi','[]',0)",
                [],
            )
            .unwrap();
        }
        let s = OrchestrationStore::open(&path).unwrap();
        let tools = s.tools("ws-1").unwrap();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].icon, None);
        let _ = std::fs::remove_file(&path);
    }

    // ---- The tool's working directory and its standalone runs (v30) ----

    #[test]
    fn a_tools_working_directory_round_trips() {
        let mut s = store();
        let mut t = tool("u1", Some("ws-1"));
        t.cwd = Some("apps/web".into());
        s.save_tool(&t).unwrap();
        assert_eq!(s.tools("ws-1").unwrap()[0].cwd.as_deref(), Some("apps/web"));
    }

    /// An untouched text field is not a directory. Both spellings of "no
    /// directory" have to read back the same, or the launcher would have
    /// to resolve `""` against the root and hope.
    #[test]
    fn a_blank_working_directory_is_stored_as_absent() {
        let mut s = store();
        let mut t = tool("u1", Some("ws-1"));
        t.cwd = Some("   ".into());
        s.save_tool(&t).unwrap();
        assert_eq!(s.tools("ws-1").unwrap()[0].cwd, None);
    }

    /// Clearing the field has to REACH the row. The upsert lists `cwd`
    /// in its UPDATE for exactly this: a re-save that dropped the column
    /// would leave a tool running in a directory the human just deleted.
    #[test]
    fn clearing_a_working_directory_on_re_save_removes_it() {
        let mut s = store();
        let mut t = tool("u1", Some("ws-1"));
        t.cwd = Some("apps/web".into());
        s.save_tool(&t).unwrap();
        t.cwd = None;
        s.save_tool(&t).unwrap();
        assert_eq!(s.tools("ws-1").unwrap()[0].cwd, None);
    }

    #[test]
    fn a_workspace_with_no_tool_runs_reads_as_an_empty_list() {
        let s = store();
        assert!(s.tool_runs("ws-1").unwrap().is_empty());
    }

    #[test]
    fn starting_a_tool_run_records_the_launch() {
        let mut s = store();
        s.start_tool_run("ws-1", "builtin:push", "s-1", Some("git push"), Some("/r/app"), None)
            .unwrap();
        let runs = s.tool_runs("ws-1").unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].tool_id, "builtin:push");
        assert_eq!(runs[0].session_id, "s-1");
        assert_eq!(runs[0].command.as_deref(), Some("git push"));
        assert_eq!(runs[0].launch_cwd.as_deref(), Some("/r/app"));
        assert_eq!(runs[0].outcome, "running");
        assert_eq!(runs[0].ended_at, None);
    }

    /// The tab draws one chip per tool, so the read answers exactly
    /// that: the newest run of each tool and nothing behind it.
    #[test]
    fn tool_runs_returns_only_the_last_run_of_each_tool() {
        let mut s = store();
        s.start_tool_run("ws-1", "t-a", "s-1", None, None, None).unwrap();
        s.finish_tool_runs_for_session("s-1", Some(0)).unwrap();
        s.start_tool_run("ws-1", "t-a", "s-2", None, None, None).unwrap();
        s.start_tool_run("ws-1", "t-b", "s-3", None, None, None).unwrap();
        let runs = s.tool_runs("ws-1").unwrap();
        assert_eq!(runs.len(), 2);
        let a = runs.iter().find(|r| r.tool_id == "t-a").unwrap();
        assert_eq!(a.session_id, "s-2");
    }

    #[test]
    fn tool_runs_are_workspace_scoped() {
        let mut s = store();
        s.start_tool_run("ws-1", "t-a", "s-1", None, None, None).unwrap();
        s.start_tool_run("ws-2", "t-a", "s-2", None, None, None).unwrap();
        assert_eq!(s.tool_runs("ws-1").unwrap()[0].session_id, "s-1");
        assert_eq!(s.tool_runs("ws-2").unwrap()[0].session_id, "s-2");
    }

    /// The exit code IS a shell tool's verdict (tools spec T5), so the
    /// daemon's own hook is the whole of that tool's result -- nobody
    /// has to have been watching.
    #[test]
    fn a_shell_tools_exit_code_becomes_its_verdict() {
        let mut s = store();
        s.start_tool_run("ws-1", "t-a", "s-1", None, None, None).unwrap();
        s.finish_tool_runs_for_session("s-1", Some(0)).unwrap();
        let passed = s.tool_runs("ws-1").unwrap().remove(0);
        assert_eq!(passed.outcome, "passed");
        assert_eq!(passed.exit_code, Some(0));
        assert!(passed.ended_at.is_some());

        s.start_tool_run("ws-1", "t-b", "s-2", None, None, None).unwrap();
        s.finish_tool_runs_for_session("s-2", Some(2)).unwrap();
        let failed = s.tool_runs("ws-1").unwrap().into_iter().find(|r| r.tool_id == "t-b").unwrap();
        assert_eq!(failed.outcome, "failed");
        assert_eq!(failed.exit_code, Some(2));
    }

    /// An agent's session is still alive when its turn ends, so the app
    /// files the verdict. The exit that comes later must not rewrite it
    /// -- an agent quitting cleanly after a failure would otherwise turn
    /// a failed run into a passed one.
    #[test]
    fn a_verdict_already_recorded_survives_the_sessions_later_exit() {
        let mut s = store();
        s.start_tool_run("ws-1", "t-a", "s-1", None, None, None).unwrap();
        s.set_tool_run_outcome("s-1", "failed", None).unwrap();
        s.finish_tool_runs_for_session("s-1", Some(0)).unwrap();
        let run = s.tool_runs("ws-1").unwrap().remove(0);
        assert_eq!(run.outcome, "failed");
        assert_eq!(run.exit_code, None);
    }

    #[test]
    fn an_unknown_tool_run_outcome_is_refused() {
        let mut s = store();
        s.start_tool_run("ws-1", "t-a", "s-1", None, None, None).unwrap();
        assert!(s.set_tool_run_outcome("s-1", "finished-ish", None).is_err());
        assert_eq!(s.tool_runs("ws-1").unwrap()[0].outcome, "running");
    }

    #[test]
    fn a_session_whose_end_nobody_saw_is_abandoned_not_ended() {
        let mut s = store();
        s.start_tool_run("ws-1", "t-a", "s-1", None, None, None).unwrap();
        s.abandon_tool_runs_for_sessions(&["s-1".to_string()]).unwrap();
        let run = s.tool_runs("ws-1").unwrap().remove(0);
        assert_eq!(run.outcome, "abandoned");
        // Not back-filled with the time somebody LOOKED.
        assert_eq!(run.ended_at, None);
    }

    /// One session hosts one tool run. A second open row for it could
    /// only be a record whose end nobody saw, so the first is closed as
    /// such rather than left claiming to be running forever.
    #[test]
    fn relaunching_into_the_same_session_id_closes_the_previous_run() {
        let mut s = store();
        s.start_tool_run("ws-1", "t-a", "s-1", None, None, None).unwrap();
        s.start_tool_run("ws-1", "t-a", "s-1", None, None, None).unwrap();
        let runs: Vec<String> = s
            .conn
            .prepare("SELECT outcome FROM tool_runs ORDER BY id")
            .unwrap()
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(runs, vec!["abandoned".to_string(), "running".to_string()]);
    }

    /// A run still open on start-up belongs to a daemon that is gone.
    /// Without this sweep the Tools tab shows a run that has been over
    /// for days as still going.
    #[test]
    fn a_run_left_open_by_a_previous_daemon_is_abandoned_on_open() {
        let dir = std::env::temp_dir().join(format!("gavin-tool-runs-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("orchestration.sqlite");
        let _ = std::fs::remove_file(&path);
        {
            let mut first = OrchestrationStore::open(&path).unwrap();
            first.start_tool_run("ws-1", "t-a", "s-1", None, None, None).unwrap();
            assert_eq!(first.tool_runs("ws-1").unwrap()[0].outcome, "running");
        }
        let second = OrchestrationStore::open(&path).unwrap();
        let run = second.tool_runs("ws-1").unwrap().remove(0);
        assert_eq!(run.outcome, "abandoned");
        assert_eq!(run.ended_at, None);
        let _ = std::fs::remove_file(&path);
    }

    /// The migration that CREATE TABLE IF NOT EXISTS cannot perform. A
    /// live orch_tools keeps its old shape, and `tools()` selects `cwd`
    /// by name -- so without the ALTER the whole library read fails with
    /// "no such column: cwd" the first time a v30 daemon opens a v29
    /// file.
    #[test]
    fn opening_a_pre_v30_database_adds_the_tool_cwd_column() {
        let dir = std::env::temp_dir().join(format!("gavin-tool-cwd-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("orchestration.sqlite");
        let _ = std::fs::remove_file(&path);
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE orch_tools (
                    id TEXT PRIMARY KEY, workspace_id TEXT, name TEXT NOT NULL,
                    description TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL,
                    params TEXT NOT NULL, position INTEGER NOT NULL);",
            )
            .unwrap();
            conn.execute(
                "INSERT INTO orch_tools (id, workspace_id, name, description, kind, body, params, position)
                 VALUES ('u1','ws-1','Old','','command','echo hi','[]',0)",
                [],
            )
            .unwrap();
        }
        let s = OrchestrationStore::open(&path).unwrap();
        let tools = s.tools("ws-1").unwrap();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].cwd, None);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn adding_a_column_twice_is_a_no_op() {
        let s = store();
        add_column_if_missing(&s.conn, "orch_steps", "tool_id", "TEXT").unwrap();
        add_column_if_missing(&s.conn, "orch_steps", "tool_id", "TEXT").unwrap();
    }

    /// The real migration path: a database created BEFORE tool steps
    /// existed must gain the columns on the next open, not keep the old
    /// shape behind CREATE TABLE IF NOT EXISTS.
    #[test]
    fn opening_a_pre_tools_database_adds_the_step_columns() {
        let dir = std::env::temp_dir().join(format!("gavin-orch-migrate-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("orchestration.sqlite");
        let _ = std::fs::remove_file(&path);
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE orch_steps (
                    id TEXT PRIMARY KEY, stage_id TEXT NOT NULL,
                    position INTEGER NOT NULL, card_path TEXT NOT NULL);",
            )
            .unwrap();
            conn.execute(
                "INSERT INTO orch_steps (id, stage_id, position, card_path) VALUES ('t1','s1',0,'/x/a.md')",
                [],
            )
            .unwrap();
        }
        let s = OrchestrationStore::open(&path).unwrap();
        let (tool_id, tool_params): (Option<String>, Option<String>) = s
            .conn
            .query_row("SELECT tool_id, tool_params FROM orch_steps WHERE id = 't1'", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(tool_id, None);
        assert_eq!(tool_params, None);
        let _ = std::fs::remove_file(&path);
    }

    /// A branch and a worktree are ORTHOGONAL bindings (spec O15), so
    /// the store must carry a branch on a rail that has no worktree --
    /// that pairing is the point of the feature, not an edge case.
    #[test]
    fn a_rails_branch_round_trips_without_a_worktree() {
        let mut s = store();
        let mut r = rail("r1", &[("t1", "/x/a.md")]);
        r.branch = Some("feature/api".into());
        s.replace_plan("ws-1", &[r], &[], &none()).unwrap();
        let back = s.get("ws-1").unwrap().rails[0].clone();
        assert_eq!(back.branch.as_deref(), Some("feature/api"));
        assert_eq!(back.worktree_path, None);
    }

    /// The real migration path: a database created BEFORE branch binding
    /// must gain the column on the next open, keeping its rails intact.
    #[test]
    fn opening_a_pre_branch_database_adds_the_rail_column() {
        let dir = std::env::temp_dir().join(format!("gavin-orch-branch-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("orchestration.sqlite");
        let _ = std::fs::remove_file(&path);
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE orch_rails (
                    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, name TEXT NOT NULL,
                    position INTEGER NOT NULL, worktree_path TEXT, page_id TEXT);",
            )
            .unwrap();
            conn.execute(
                "INSERT INTO orch_rails (id, workspace_id, name, position, worktree_path, page_id)
                 VALUES ('r1','ws-1','backend',0,'/x/wt',NULL)",
                [],
            )
            .unwrap();
        }
        let s = OrchestrationStore::open(&path).unwrap();
        let back = s.get("ws-1").unwrap().rails[0].clone();
        assert_eq!(back.branch, None);
        // v22 rides the same path, and its absent value has to read as
        // the safe one: a rail authored before the opt-in existed never
        // consented to resuming itself.
        assert_eq!(back.auto_resume, None);
        assert_eq!(back.worktree_path.as_deref(), Some("/x/wt"));
        let _ = std::fs::remove_file(&path);
    }

    /// The per-rail opt-in survives a plan rewrite, which is the only way
    /// a rail is ever stored: `replace_plan` deletes every rail of the
    /// workspace and re-inserts them, so a field it forgot to carry would
    /// be silently cleared by the next unrelated edit to the board.
    #[test]
    fn a_rails_auto_resume_opt_in_round_trips() {
        let mut s = store();
        let mut r = rail("r1", &[("t1", "/x/a.md")]);
        r.auto_resume = Some(true);
        s.replace_plan("ws-1", &[r], &[], &none()).unwrap();
        assert_eq!(s.get("ws-1").unwrap().rails[0].auto_resume, Some(true));

        let mut off = rail("r1", &[("t1", "/x/a.md")]);
        off.auto_resume = Some(false);
        s.replace_plan("ws-1", &[off], &[], &none()).unwrap();
        assert_eq!(s.get("ws-1").unwrap().rails[0].auto_resume, Some(false));
    }

    /// The budget is the one run field written by a LATER transition than
    /// the launch, so it needs the opposite of `conversation_id`'s
    /// treatment in one direction and the same in the other: an explicit
    /// count is stored, and a None leaves the stored one alone -- because
    /// the dozen transitions that say nothing about the budget (a stall,
    /// a done, a rail reset) all pass None.
    #[test]
    fn the_resume_budget_is_written_when_given_and_kept_when_not() {
        let mut s = store();
        s.replace_plan("ws-1", &[rail("r1", &[("t1", "/x/a.md")])], &[], &none()).unwrap();
        s.set_step_run("t1", "running", Some("sess-1"), None, Some("conv-1"), Some("/x"), Some(0))
            .unwrap();
        assert_eq!(s.get("ws-1").unwrap().step_runs[0].resume_attempts, Some(0));

        // The automatic resume spends the budget.
        s.set_step_run("t1", "running", Some("sess-2"), None, None, None, Some(1)).unwrap();
        assert_eq!(s.get("ws-1").unwrap().step_runs[0].resume_attempts, Some(1));

        // A stall says nothing about it, and must not spend or refund it.
        s.set_step_run("t1", "stalled", Some("sess-2"), Some("broke"), None, None, None).unwrap();
        let run = s.get("ws-1").unwrap().step_runs[0].clone();
        assert_eq!(run.resume_attempts, Some(1));
        assert_eq!(run.conversation_id.as_deref(), Some("conv-1"));
    }

    /// A trigger survives a plan rewrite, for the same reason the
    /// auto-resume opt-in has to: `replace_plan` deletes every rail of
    /// the workspace and re-inserts them, so a field the insert forgot
    /// would be silently cleared by the next unrelated edit -- and a rail
    /// that quietly stops waiting for the others is one that starts by
    /// hand and never says it changed.
    #[test]
    fn a_rails_trigger_round_trips_with_and_without_a_named_rail() {
        let mut s = store();
        let mut r = rail("r1", &[("t1", "/x/a.md")]);
        r.trigger = Some(RailTrigger { kind: "all-rails-done".into(), rail: None });
        s.replace_plan("ws-1", &[r], &[], &none()).unwrap();
        assert_eq!(
            s.get("ws-1").unwrap().rails[0].trigger,
            Some(RailTrigger { kind: "all-rails-done".into(), rail: None })
        );

        let mut named = rail("r1", &[("t1", "/x/a.md")]);
        named.trigger =
            Some(RailTrigger { kind: "rail-done".into(), rail: Some("backend".into()) });
        s.replace_plan("ws-1", &[named], &[], &none()).unwrap();
        assert_eq!(
            s.get("ws-1").unwrap().rails[0].trigger,
            Some(RailTrigger { kind: "rail-done".into(), rail: Some("backend".into()) })
        );

        // And clearing it stores nothing, rather than leaving the last
        // condition behind for the scheduler to keep acting on.
        s.replace_plan("ws-1", &[rail("r1", &[("t1", "/x/a.md")])], &[], &none()).unwrap();
        assert_eq!(s.get("ws-1").unwrap().rails[0].trigger, None);
    }

    /// The migration for the two v35 columns, from the v34 shape. A rail
    /// that predates triggers waits for nothing -- which is the reading
    /// that arms nothing.
    #[test]
    fn opening_a_pre_v35_database_adds_the_trigger_columns() {
        let dir = std::env::temp_dir().join(format!("gavin-orch-v35-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("orchestration.sqlite");
        let _ = std::fs::remove_file(&path);
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE orch_rails (
                    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, name TEXT NOT NULL,
                    position INTEGER NOT NULL, worktree_path TEXT, branch TEXT,
                    auto_resume INTEGER, page_id TEXT);
                 INSERT INTO orch_rails VALUES ('r1','ws-1','backend',0,'/x/wt',NULL,1,NULL);",
            )
            .unwrap();
        }
        let s = OrchestrationStore::open(&path).unwrap();
        let back = s.get("ws-1").unwrap().rails[0].clone();
        assert_eq!(back.trigger, None, "a v34 rail waits for nothing");
        assert_eq!(back.auto_resume, Some(true), "and keeps what it did carry");

        // Idempotent: the ALTERs run on every open.
        drop(s);
        assert!(OrchestrationStore::open(&path).is_ok());
        let _ = std::fs::remove_file(&path);
    }

    /// The migration for the two v22 columns, from the v21 shape.
    #[test]
    fn opening_a_pre_v22_database_adds_the_auto_resume_columns() {
        let dir = std::env::temp_dir().join(format!("gavin-orch-v22-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("orchestration.sqlite");
        let _ = std::fs::remove_file(&path);
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(
                "CREATE TABLE orch_rails (
                    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, name TEXT NOT NULL,
                    position INTEGER NOT NULL, worktree_path TEXT, branch TEXT, page_id TEXT);
                 CREATE TABLE orch_stages (
                    id TEXT PRIMARY KEY, rail_id TEXT NOT NULL, position INTEGER NOT NULL,
                    mode TEXT, name TEXT);
                 CREATE TABLE orch_steps (
                    id TEXT PRIMARY KEY, stage_id TEXT NOT NULL, position INTEGER NOT NULL,
                    card_path TEXT NOT NULL, tool_id TEXT, tool_params TEXT);
                 CREATE TABLE orch_step_runs (
                    step_id TEXT PRIMARY KEY, state TEXT NOT NULL, session_id TEXT, reason TEXT,
                    conversation_id TEXT, launch_cwd TEXT);
                 INSERT INTO orch_rails VALUES ('r1','ws-1','backend',0,'/x/wt',NULL,NULL);
                 INSERT INTO orch_stages VALUES ('g1','r1',0,'parallel',NULL);
                 INSERT INTO orch_steps VALUES ('t1','g1',0,'/x/a.md',NULL,NULL);
                 INSERT INTO orch_step_runs VALUES ('t1','running','s-1',NULL,'conv-1','/x/wt');",
            )
            .unwrap();
        }
        let s = OrchestrationStore::open(&path).unwrap();
        let o = s.get("ws-1").unwrap();
        assert_eq!(o.rails[0].auto_resume, None, "a v21 rail never opted in");
        assert_eq!(o.step_runs[0].resume_attempts, None, "a v21 run was never auto-resumed");
        assert_eq!(o.step_runs[0].conversation_id.as_deref(), Some("conv-1"));

        // Idempotent: the ALTERs run on every open.
        drop(s);
        assert!(OrchestrationStore::open(&path).is_ok());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn rail_run_upserts() {
        let mut s = store();
        s.replace_plan("ws-1", &[rail("r1", &[("t1", "/x/a.md")])], &[], &none()).unwrap();
        s.set_rail_run("r1", "running", Some("r1-s1")).unwrap();
        s.set_rail_run("r1", "paused", Some("r1-s1")).unwrap();
        let o = s.get("ws-1").unwrap();
        assert_eq!(o.rail_runs.len(), 1);
        assert_eq!(o.rail_runs[0].state, "paused");
    }
}
