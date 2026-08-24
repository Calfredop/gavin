use protocol::{ConflictNote, Orchestration, Rail, RailRun, Stage, Step, StepRun};
use rusqlite::{params, Connection};
use std::collections::HashSet;

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
            );",
        )?;
        Ok(Self { conn })
    }

    pub fn get(&self, workspace_id: &str) -> anyhow::Result<Orchestration> {
        let mut rails: Vec<Rail> = self
            .conn
            .prepare(
                "SELECT id, name, position, worktree_path, page_id FROM orch_rails
                 WHERE workspace_id = ?1 ORDER BY position",
            )?
            .query_map(params![workspace_id], |row| {
                Ok(Rail {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    position: row.get(2)?,
                    worktree_path: row.get(3)?,
                    page_id: row.get(4)?,
                    stages: Vec::new(),
                })
            })?
            .collect::<Result<_, _>>()?;

        for rail in rails.iter_mut() {
            let mut stages: Vec<Stage> = self
                .conn
                .prepare("SELECT id, position FROM orch_stages WHERE rail_id = ?1 ORDER BY position")?
                .query_map(params![rail.id], |row| {
                    Ok(Stage { id: row.get(0)?, position: row.get(1)?, steps: Vec::new() })
                })?
                .collect::<Result<_, _>>()?;
            for stage in stages.iter_mut() {
                stage.steps = self
                    .conn
                    .prepare(
                        "SELECT id, position, card_path FROM orch_steps
                         WHERE stage_id = ?1 ORDER BY position",
                    )?
                    .query_map(params![stage.id], |row| {
                        Ok(Step { id: row.get(0)?, position: row.get(1)?, card_path: row.get(2)? })
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
            .prepare("SELECT step_id, state, session_id, reason FROM orch_step_runs")?
            .query_map([], |row| {
                Ok(StepRun {
                    step_id: row.get(0)?,
                    state: row.get(1)?,
                    session_id: row.get(2)?,
                    reason: row.get(3)?,
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

        // Guard 2: a running step must survive the replace, or its live
        // session is orphaned.
        let running: Vec<(String, String)> = self
            .conn
            .prepare(
                "SELECT sr.step_id, st.card_path FROM orch_step_runs sr
                 JOIN orch_steps st ON st.id = sr.step_id
                 JOIN orch_stages sg ON sg.id = st.stage_id
                 JOIN orch_rails r ON r.id = sg.rail_id
                 WHERE r.workspace_id = ?1 AND sr.state = 'running'",
            )?
            .query_map(params![workspace_id], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<Result<_, _>>()?;
        for (step_id, card_path) in &running {
            if !incoming.contains(step_id.as_str()) {
                anyhow::bail!(
                    "step {step_id} ({card_path}) is running — pause or let it finish before removing it"
                );
            }
        }

        // Guard 3: every conflict note names steps in this same payload.
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
                "INSERT INTO orch_rails (id, workspace_id, name, position, worktree_path, page_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![rail.id, workspace_id, rail.name, rail.position, rail.worktree_path, rail.page_id],
            )?;
            for stage in &rail.stages {
                tx.execute(
                    "INSERT INTO orch_stages (id, rail_id, position) VALUES (?1, ?2, ?3)",
                    params![stage.id, rail.id, stage.position],
                )?;
                for step in &stage.steps {
                    tx.execute(
                        "INSERT INTO orch_steps (id, stage_id, position, card_path) VALUES (?1, ?2, ?3, ?4)",
                        params![step.id, stage.id, step.position, step.card_path],
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

    pub fn set_step_run(
        &mut self,
        step_id: &str,
        state: &str,
        session_id: Option<&str>,
        reason: Option<&str>,
    ) -> anyhow::Result<()> {
        self.conn.execute(
            "INSERT INTO orch_step_runs (step_id, state, session_id, reason) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(step_id) DO UPDATE SET state = ?2, session_id = ?3, reason = ?4",
            params![step_id, state, session_id, reason],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> OrchestrationStore {
        OrchestrationStore::open(std::path::Path::new(":memory:")).unwrap()
    }

    fn rail(id: &str, steps: &[(&str, &str)]) -> Rail {
        Rail {
            id: id.into(),
            name: id.into(),
            position: 0,
            worktree_path: None,
            page_id: None,
            stages: vec![Stage {
                id: format!("{id}-s1"),
                position: 0,
                steps: steps
                    .iter()
                    .enumerate()
                    .map(|(i, (sid, path))| Step {
                        id: (*sid).into(),
                        position: i as i64,
                        card_path: (*path).into(),
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
        s.replace_plan("ws-1", &[rail("r1", &[("t1", "/x/a.md")])], &[]).unwrap();
        let o = s.get("ws-1").unwrap();
        assert_eq!(o.rails.len(), 1);
        assert_eq!(o.rails[0].stages[0].steps[0].card_path, "/x/a.md");
    }

    #[test]
    fn rename_card_path_follows_a_moved_card_on_every_rail() {
        let mut s = store();
        s.replace_plan("ws-1", &[rail("r1", &[("t1", "/x/a.md"), ("t2", "/x/b.md")])], &[]).unwrap();
        s.replace_plan("ws-2", &[rail("r2", &[("t3", "/x/a.md")])], &[]).unwrap();

        s.rename_card_path("/x/a.md", "/x/done/a.md").unwrap();

        let steps = &s.get("ws-1").unwrap().rails[0].stages[0].steps;
        assert_eq!(steps[0].card_path, "/x/done/a.md");
        assert_eq!(steps[1].card_path, "/x/b.md");
        assert_eq!(s.get("ws-2").unwrap().rails[0].stages[0].steps[0].card_path, "/x/done/a.md");
    }

    #[test]
    fn replace_plan_replaces_rather_than_appends_and_is_workspace_scoped() {
        let mut s = store();
        s.replace_plan("ws-1", &[rail("r1", &[("t1", "/x/a.md")])], &[]).unwrap();
        s.replace_plan("ws-2", &[rail("r2", &[("t2", "/x/b.md")])], &[]).unwrap();
        s.replace_plan("ws-1", &[rail("r3", &[("t3", "/x/c.md")])], &[]).unwrap();
        assert_eq!(s.get("ws-1").unwrap().rails.len(), 1);
        assert_eq!(s.get("ws-1").unwrap().rails[0].id, "r3");
        assert_eq!(s.get("ws-2").unwrap().rails[0].id, "r2");
    }

    #[test]
    fn run_state_survives_a_replace_that_keeps_the_step_id() {
        let mut s = store();
        s.replace_plan("ws-1", &[rail("r1", &[("t1", "/x/a.md")])], &[]).unwrap();
        s.set_step_run("t1", "done", Some("sess-1"), None).unwrap();
        // Same step id, moved into a differently-named rail.
        let mut moved = rail("r9", &[("t1", "/x/a.md")]);
        moved.name = "renamed".into();
        s.replace_plan("ws-1", &[moved], &[]).unwrap();
        let o = s.get("ws-1").unwrap();
        assert_eq!(o.step_runs.len(), 1);
        assert_eq!(o.step_runs[0].state, "done");
        assert_eq!(o.step_runs[0].session_id.as_deref(), Some("sess-1"));
    }

    #[test]
    fn run_state_for_a_vanished_step_is_dropped() {
        let mut s = store();
        s.replace_plan("ws-1", &[rail("r1", &[("t1", "/x/a.md")])], &[]).unwrap();
        s.set_step_run("t1", "done", None, None).unwrap();
        s.replace_plan("ws-1", &[rail("r1", &[("t2", "/x/b.md")])], &[]).unwrap();
        assert!(s.get("ws-1").unwrap().step_runs.is_empty());
    }

    #[test]
    fn deleting_a_running_step_is_refused_and_changes_nothing() {
        let mut s = store();
        s.replace_plan("ws-1", &[rail("r1", &[("t1", "/x/a.md")])], &[]).unwrap();
        s.set_step_run("t1", "running", Some("sess-1"), None).unwrap();
        let err = s
            .replace_plan("ws-1", &[rail("r1", &[("t2", "/x/b.md")])], &[])
            .unwrap_err()
            .to_string();
        assert!(err.contains("t1"), "message names the step: {err}");
        assert!(err.contains("/x/a.md"), "message names the card path: {err}");
        // The stored plan is untouched.
        assert_eq!(s.get("ws-1").unwrap().rails[0].stages[0].steps[0].id, "t1");
    }

    #[test]
    fn moving_a_running_step_between_rails_is_allowed() {
        let mut s = store();
        s.replace_plan("ws-1", &[rail("r1", &[("t1", "/x/a.md")])], &[]).unwrap();
        s.set_step_run("t1", "running", Some("sess-1"), None).unwrap();
        s.replace_plan("ws-1", &[rail("r2", &[("t1", "/x/a.md")])], &[]).unwrap();
        let o = s.get("ws-1").unwrap();
        assert_eq!(o.rails[0].id, "r2");
        assert_eq!(o.step_runs[0].state, "running");
    }

    #[test]
    fn duplicate_ids_are_refused() {
        let mut s = store();
        let err = s
            .replace_plan("ws-1", &[rail("r1", &[("t1", "/x/a.md"), ("t1", "/x/b.md")])], &[])
            .unwrap_err()
            .to_string();
        assert!(err.contains("duplicate"), "{err}");
    }

    #[test]
    fn a_conflict_note_naming_an_unknown_step_is_refused() {
        let mut s = store();
        let note = ConflictNote { id: "n1".into(), step_ids: vec!["nope".into()], note: "x".into() };
        let err = s
            .replace_plan("ws-1", &[rail("r1", &[("t1", "/x/a.md")])], &[note])
            .unwrap_err()
            .to_string();
        assert!(err.contains("nope"), "{err}");
    }

    #[test]
    fn conflict_notes_round_trip() {
        let mut s = store();
        let note = ConflictNote { id: "n1".into(), step_ids: vec!["t1".into()], note: "careful".into() };
        s.replace_plan("ws-1", &[rail("r1", &[("t1", "/x/a.md")])], &[note]).unwrap();
        let o = s.get("ws-1").unwrap();
        assert_eq!(o.conflict_notes[0].note, "careful");
        assert_eq!(o.conflict_notes[0].step_ids, vec!["t1".to_string()]);
    }

    #[test]
    fn rail_run_upserts() {
        let mut s = store();
        s.replace_plan("ws-1", &[rail("r1", &[("t1", "/x/a.md")])], &[]).unwrap();
        s.set_rail_run("r1", "running", Some("r1-s1")).unwrap();
        s.set_rail_run("r1", "paused", Some("r1-s1")).unwrap();
        let o = s.get("ws-1").unwrap();
        assert_eq!(o.rail_runs.len(), 1);
        assert_eq!(o.rail_runs[0].state, "paused");
    }
}
