# Orchestration Tab — SP1 "Rails that run" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A human can build a rail of stages over the board's cards, press Start, and watch gavin launch each stage's agents and advance when their cards reach the Done column.

**Architecture:** The plan (rails → stages → steps) and its run state live in a new SQLite store in the daemon, reached through four protocol requests and four Tauri commands. All scheduling logic is one pure function, `nextActions`, in `app/src/lib/orchestration.ts`; a thin reactive layer, `orchestrationState.ts`, subscribes to the events already flowing through the app, calls `nextActions`, and executes the returned actions using the existing card-run path (`cardRun.ts` + `createSession` + `linkCardSession`). The tab renders the plan as a CSS grid of vertical rails.

**Tech Stack:** Rust (rusqlite, serde, anyhow) for the daemon and protocol; Tauri 2 commands; Svelte 5 (runes) + TypeScript for the app; vitest for TS tests, `cargo test` for Rust.

**Spec:** `docs/superpowers/specs/2026-08-21-orchestration-tab-design.md` — read it alongside this plan. This plan implements **SP1 only** (spec §11). SP2 (conflicts UI, drag, binding dialogs) and SP3 (MCP tools and the skill) get their own plans.

## Global Constraints

- **Do not implement `detectConflicts`, the Conflicts box, drag-and-drop, the unplaced drawer, `GitForkDialog` changes, `GitDirtyPaths`, the MCP tools, or the skill file.** Those are SP2/SP3. In SP1, `worktreePath` and `pageId` are edited as plain text inputs in the rail header menu.
- The plan is replaced **wholesale** on every edit (spec O11), like `replace_board`. Run state is keyed by step id and survives.
- **`SetOrchestration` refuses to delete a step whose `StepRun.state` is `running`** (spec §2.2).
- A step is **done when its card's status slug equals the slug of the board column with the highest `position`** (spec O6). Slugs are compared with `slugStatus` from `planBoard.ts`.
- Sessions are launched only through the existing path: `composeTaskPrompt`/`composePlanPrompt` → `buildRunCommand` → `createSession` → `linkCardSessionAction` → status `In Progress` gated by `runStatusNeeded` (spec §4.3).
- Gavin **never blocks a run** because of a conflict, and **never auto-completes** a card.
- Rust wire structs use `#[serde(rename_all = "camelCase")]`; TS mirrors use camelCase.
- New daemon store lives in its own SQLite file, `orchestration.sqlite`, beside `kanban.sqlite`.
- Test commands: TS `cd app && npm test`; Rust `cargo test -p protocol -p gavin-daemon`; type check `cd app && npm run check`.
- Commit after every task. Conventional-commit subjects, matching the repo's history (`feat(app):`, `refactor(ui):`, `docs(spec):`).

---

### Task 0: Plan card on the board

This repo is a gavin workspace; the human watches the board. Create the card before touching code.

**Files:**
- Create: `.gavin-root/plans/orchestration-rails-that-run.md`

- [ ] **Step 1: Create the card**

Call the MCP tool:

```
gavin_create_plan(
  context_folder: ".gavin-root",
  file_name: "orchestration-rails-that-run",
  title: "Orchestration tab — Rails that run (SP1 of 3)",
  status: "In Progress",
  priority: "high",
  kind: "plan",
  body: <the markdown below>
)
```

Body:

```markdown
# Orchestration tab — Rails that run (SP1 of 3)

Rails of stages of steps over the board's cards: build a rail, press Start,
and gavin launches each stage's agents and advances when their cards reach
the Done column.

Spec: `docs/superpowers/specs/2026-08-21-orchestration-tab-design.md`
Plan: `docs/superpowers/plans/2026-08-21-orchestration-rails-that-run.md`

## Steps

- [ ] Protocol types and the four orchestration requests
- [ ] `orchestration.rs` SQLite store with its guards (+ tests)
- [ ] Daemon server wiring and request routing (+ tests)
- [ ] Tauri commands and `backend.ts`
- [ ] `orchestration.ts` primitives (+ tests)
- [ ] `nextActions` scheduler (+ tests)
- [ ] `orchestrationState.ts` store and persistence (+ tests)
- [ ] Launch executor and the tick loop (+ tests)
- [ ] Plan mutators: rails, stages, steps (+ tests)
- [ ] `OrchestrationHubView` and the tab registration
```

- [ ] **Step 2: Verify it appears**

Run `gavin_get_tree` and confirm the card is present with `status: In Progress`.

- [ ] **Step 3: Commit**

```bash
git add .gavin-root/plans/orchestration-rails-that-run.md
git commit -m "docs(plan): orchestration SP1 card"
```

Tick each checklist item on this card (`- [x]`) as you finish the matching task below.

---

### Task 1: Protocol types and requests

**Files:**
- Modify: `crates/protocol/src/lib.rs`

**Interfaces:**
- Consumes: nothing.
- Produces: `Rail`, `Stage`, `Step`, `ConflictNote`, `RailRun`, `StepRun`, `Orchestration` structs; `Request::GetOrchestration`, `Request::SetOrchestration`, `Request::SetRailRun`, `Request::SetStepRun`; `Response::Orchestration`.

- [ ] **Step 1: Write the failing shape test**

Append to the `mod tests` block at the bottom of `crates/protocol/src/lib.rs`:

```rust
#[test]
fn orchestration_types_are_camel_case_on_the_wire() {
    let rail = Rail {
        id: "r1".into(),
        name: "backend".into(),
        position: 0,
        worktree_path: Some("/x/gavin-backend".into()),
        page_id: None,
        stages: vec![Stage {
            id: "s1".into(),
            position: 0,
            steps: vec![Step { id: "t1".into(), position: 0, card_path: "/x/a.md".into() }],
        }],
    };
    assert_eq!(
        serde_json::to_value(&rail).unwrap(),
        serde_json::json!({
            "id": "r1",
            "name": "backend",
            "position": 0,
            "worktreePath": "/x/gavin-backend",
            "pageId": null,
            "stages": [{ "id": "s1", "position": 0,
                         "steps": [{ "id": "t1", "position": 0, "cardPath": "/x/a.md" }] }]
        })
    );

    let run = StepRun {
        step_id: "t1".into(),
        state: "running".into(),
        session_id: Some("sess-1".into()),
        reason: None,
    };
    assert_eq!(
        serde_json::to_value(&run).unwrap(),
        serde_json::json!({ "stepId": "t1", "state": "running", "sessionId": "sess-1", "reason": null })
    );
}
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cargo test -p protocol orchestration_types_are_camel_case_on_the_wire`
Expected: FAIL — `cannot find struct 'Rail' in this scope`.

- [ ] **Step 3: Add the types**

Add near the other wire structs in `crates/protocol/src/lib.rs` (after `Board`):

```rust
/// One orchestration rail: an ordered column of stages over the board's
/// cards. `worktree_path` is the cwd its steps' sessions get; `page_id`
/// is the workspace page they land on. Both optional -- a rail is a name
/// until it is bound (orchestration spec O5).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Rail {
    pub id: String,
    pub name: String,
    pub position: i64,
    pub worktree_path: Option<String>,
    pub page_id: Option<String>,
    pub stages: Vec<Stage>,
}

/// Stages run one after another; a stage's steps run in parallel, in the
/// SAME checkout, since they share the rail's worktree.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Stage {
    pub id: String,
    pub position: i64,
    pub steps: Vec<Step>,
}

/// A step is a REFERENCE to a card file (spec O2) -- title, prompt,
/// status and checklist all stay in the card.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    pub id: String,
    pub position: i64,
    pub card_path: String,
}

/// The agent's own judgement about a set of steps, rendered beside the
/// computed conflicts. Written only through SetOrchestration.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConflictNote {
    pub id: String,
    pub step_ids: Vec<String>,
    pub note: String,
}

/// Machine-local runtime bookkeeping; the agent never writes these.
/// A rail with no row is "idle"; a step with no row is "pending".
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RailRun {
    pub rail_id: String,
    /// idle | running | paused
    pub state: String,
    pub current_stage_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StepRun {
    pub step_id: String,
    /// pending | running | done | stalled
    pub state: String,
    pub session_id: Option<String>,
    /// Human-readable stall cause; None otherwise.
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Orchestration {
    pub rails: Vec<Rail>,
    pub conflict_notes: Vec<ConflictNote>,
    pub rail_runs: Vec<RailRun>,
    pub step_runs: Vec<StepRun>,
}
```

State is a `String`, not an enum, deliberately: the daemon only stores and compares it, and a widened vocabulary must not become a wire break.

- [ ] **Step 4: Add the request and response variants**

In `pub enum Request`, before `GetProtocolVersion`:

```rust
    /// The workspace's orchestration plan plus its run state. Never an
    /// error for an unknown workspace -- an empty Orchestration.
    GetOrchestration {
        workspace_id: String,
    },
    /// Replaces the whole plan (spec O11). Run state survives for step
    /// and rail ids that are still present. Refused when it would delete
    /// a step whose StepRun is `running`.
    SetOrchestration {
        workspace_id: String,
        rails: Vec<Rail>,
        #[serde(default)]
        conflict_notes: Vec<ConflictNote>,
    },
    SetRailRun {
        rail_id: String,
        state: String,
        current_stage_id: Option<String>,
    },
    SetStepRun {
        step_id: String,
        state: String,
        session_id: Option<String>,
        reason: Option<String>,
    },
```

In `pub enum Response`, after `Board { .. }`:

```rust
    Orchestration {
        rails: Vec<Rail>,
        conflict_notes: Vec<ConflictNote>,
        rail_runs: Vec<RailRun>,
        step_runs: Vec<StepRun>,
    },
```

- [ ] **Step 5: Run the test and watch it pass**

Run: `cargo test -p protocol`
Expected: PASS, all existing protocol tests still green.

- [ ] **Step 6: Commit**

```bash
git add crates/protocol/src/lib.rs
git commit -m "feat(protocol): orchestration rails, stages, steps and run state"
```

---

### Task 2: The SQLite store

**Files:**
- Create: `crates/daemon/src/orchestration.rs`
- Modify: `crates/daemon/src/main.rs`

**Interfaces:**
- Consumes: `protocol::{Rail, Stage, Step, ConflictNote, RailRun, StepRun, Orchestration}` from Task 1.
- Produces: `OrchestrationStore::open(&Path) -> anyhow::Result<Self>`, `.get(&self, workspace_id: &str) -> anyhow::Result<Orchestration>`, `.replace_plan(&mut self, workspace_id: &str, rails: &[Rail], notes: &[ConflictNote]) -> anyhow::Result<()>`, `.set_rail_run(&mut self, rail_id: &str, state: &str, current_stage_id: Option<&str>) -> anyhow::Result<()>`, `.set_step_run(&mut self, step_id: &str, state: &str, session_id: Option<&str>, reason: Option<&str>) -> anyhow::Result<()>`; `main::orchestration_db_path()`.

- [ ] **Step 1: Write the failing tests**

Create `crates/daemon/src/orchestration.rs` with only the test module for now:

```rust
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
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cargo test -p gavin-daemon orchestration::`
Expected: FAIL to compile — `OrchestrationStore` does not exist. (The module is not registered yet either; that happens in Step 3.)

- [ ] **Step 3: Implement the store**

Prepend to `crates/daemon/src/orchestration.rs`, above the test module:

```rust
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
```

- [ ] **Step 4: Register the module and its database file**

In `crates/daemon/src/main.rs`, add `mod orchestration;` beside the other `mod` declarations, then add beside `kanban_db_path()`:

```rust
fn orchestration_db_path() -> std::path::PathBuf {
    protocol::app_support_dir().join("orchestration.sqlite")
}
```

Extend the existing filename test in that file's `mod tests`:

```rust
    assert_eq!(orchestration_db_path().file_name().unwrap(), "orchestration.sqlite");
```

- [ ] **Step 5: Run the tests and watch them pass**

Run: `cargo test -p gavin-daemon orchestration`
Expected: PASS — all eleven store tests plus the path test.

- [ ] **Step 6: Commit**

```bash
git add crates/daemon/src/orchestration.rs crates/daemon/src/main.rs
git commit -m "feat(daemon): orchestration store with wholesale plan replace and run-state guards"
```

---

### Task 3: Daemon server wiring

**Files:**
- Modify: `crates/daemon/src/server.rs`
- Modify: `crates/daemon/src/main.rs:31-32`

**Interfaces:**
- Consumes: `OrchestrationStore` from Task 2.
- Produces: `SessionManager::new(registry, kanban, orchestration)` (third parameter added); `SessionManager::get_orchestration/set_orchestration/set_rail_run/set_step_run`; `handle_request` routing for the four requests.

- [ ] **Step 1: Write the failing tests**

Add to `crates/daemon/src/server.rs`'s `mod tests`, following the shape of `set_board_then_get_board_round_trips_through_handle_request`:

```rust
    #[test]
    fn set_orchestration_then_get_orchestration_round_trips_through_handle_request() {
        let dir = tempfile::tempdir().unwrap();
        let manager = test_manager(&dir);
        let rails = vec![protocol::Rail {
            id: "r1".into(),
            name: "backend".into(),
            position: 0,
            worktree_path: None,
            page_id: None,
            stages: vec![protocol::Stage {
                id: "s1".into(),
                position: 0,
                steps: vec![protocol::Step { id: "t1".into(), position: 0, card_path: "/x/a.md".into() }],
            }],
        }];
        let resp = handle_request(
            &manager,
            Request::SetOrchestration {
                workspace_id: "ws-1".into(),
                rails: rails.clone(),
                conflict_notes: vec![],
            },
        );
        assert!(matches!(resp, Response::Ok));

        let resp = handle_request(&manager, Request::GetOrchestration { workspace_id: "ws-1".into() });
        match resp {
            Response::Orchestration { rails: got, .. } => assert_eq!(got, rails),
            other => panic!("expected Orchestration, got {other:?}"),
        }
    }

    #[test]
    fn run_state_writes_come_back_on_the_next_get() {
        let dir = tempfile::tempdir().unwrap();
        let manager = test_manager(&dir);
        handle_request(
            &manager,
            Request::SetOrchestration {
                workspace_id: "ws-1".into(),
                rails: vec![protocol::Rail {
                    id: "r1".into(),
                    name: "backend".into(),
                    position: 0,
                    worktree_path: None,
                    page_id: None,
                    stages: vec![protocol::Stage {
                        id: "s1".into(),
                        position: 0,
                        steps: vec![protocol::Step { id: "t1".into(), position: 0, card_path: "/x/a.md".into() }],
                    }],
                }],
                conflict_notes: vec![],
            },
        );
        handle_request(
            &manager,
            Request::SetRailRun { rail_id: "r1".into(), state: "running".into(), current_stage_id: Some("s1".into()) },
        );
        handle_request(
            &manager,
            Request::SetStepRun {
                step_id: "t1".into(),
                state: "running".into(),
                session_id: Some("sess-1".into()),
                reason: None,
            },
        );
        match handle_request(&manager, Request::GetOrchestration { workspace_id: "ws-1".into() }) {
            Response::Orchestration { rail_runs, step_runs, .. } => {
                assert_eq!(rail_runs[0].state, "running");
                assert_eq!(step_runs[0].session_id.as_deref(), Some("sess-1"));
            }
            other => panic!("expected Orchestration, got {other:?}"),
        }
    }

    #[test]
    fn a_refused_set_orchestration_answers_with_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let manager = test_manager(&dir);
        let with = |ids: &[&str]| Request::SetOrchestration {
            workspace_id: "ws-1".into(),
            rails: vec![protocol::Rail {
                id: "r1".into(),
                name: "backend".into(),
                position: 0,
                worktree_path: None,
                page_id: None,
                stages: vec![protocol::Stage {
                    id: "s1".into(),
                    position: 0,
                    steps: ids
                        .iter()
                        .map(|i| protocol::Step { id: (*i).into(), position: 0, card_path: "/x/a.md".into() })
                        .collect(),
                }],
            }],
            conflict_notes: vec![],
        };
        handle_request(&manager, with(&["t1"]));
        handle_request(
            &manager,
            Request::SetStepRun { step_id: "t1".into(), state: "running".into(), session_id: None, reason: None },
        );
        match handle_request(&manager, with(&["t2"])) {
            Response::Error { message } => assert!(message.contains("t1"), "{message}"),
            other => panic!("expected Error, got {other:?}"),
        }
    }
```

Add the shared helper next to the other test helpers in that module (the existing tests build a manager inline; this factors out the third store):

```rust
    fn test_manager(dir: &tempfile::TempDir) -> Arc<SessionManager> {
        let registry = Registry::open(&dir.path().join("registry.sqlite")).unwrap();
        let kanban = KanbanStore::open(&dir.path().join("kanban.sqlite")).unwrap();
        let orchestration =
            crate::orchestration::OrchestrationStore::open(&dir.path().join("orchestration.sqlite")).unwrap();
        Arc::new(SessionManager::new(registry, kanban, orchestration))
    }
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cargo test -p gavin-daemon set_orchestration_then_get_orchestration_round_trips_through_handle_request`
Expected: FAIL to compile — `SessionManager::new` takes two arguments, and the request variants are unhandled.

- [ ] **Step 3: Hold the store on the manager**

In `crates/daemon/src/server.rs`, beside `kanban: Mutex<KanbanStore>` (around line 597):

```rust
    orchestration: Mutex<crate::orchestration::OrchestrationStore>,
```

Widen `SessionManager::new` (around line 617) to take `orchestration: crate::orchestration::OrchestrationStore` as its third parameter and store `orchestration: Mutex::new(orchestration)`.

Add the four methods beside `get_board`/`set_board` (around line 740):

```rust
    pub fn get_orchestration(&self, workspace_id: &str) -> anyhow::Result<protocol::Orchestration> {
        self.orchestration.lock().unwrap().get(workspace_id)
    }

    pub fn set_orchestration(
        &self,
        workspace_id: &str,
        rails: Vec<protocol::Rail>,
        conflict_notes: Vec<protocol::ConflictNote>,
    ) -> anyhow::Result<()> {
        self.orchestration.lock().unwrap().replace_plan(workspace_id, &rails, &conflict_notes)
    }

    pub fn set_rail_run(
        &self,
        rail_id: &str,
        state: &str,
        current_stage_id: Option<String>,
    ) -> anyhow::Result<()> {
        self.orchestration.lock().unwrap().set_rail_run(rail_id, state, current_stage_id.as_deref())
    }

    pub fn set_step_run(
        &self,
        step_id: &str,
        state: &str,
        session_id: Option<String>,
        reason: Option<String>,
    ) -> anyhow::Result<()> {
        self.orchestration
            .lock()
            .unwrap()
            .set_step_run(step_id, state, session_id.as_deref(), reason.as_deref())
    }
```

- [ ] **Step 4: Route the requests**

In `handle_request`, beside the `Request::GetBoard` / `Request::SetBoard` arms (around line 1195):

```rust
        Request::GetOrchestration { workspace_id } => manager.get_orchestration(&workspace_id).map(|o| {
            Response::Orchestration {
                rails: o.rails,
                conflict_notes: o.conflict_notes,
                rail_runs: o.rail_runs,
                step_runs: o.step_runs,
            }
        }),
        Request::SetOrchestration { workspace_id, rails, conflict_notes } => manager
            .set_orchestration(&workspace_id, rails, conflict_notes)
            .map(|()| Response::Ok),
        Request::SetRailRun { rail_id, state, current_stage_id } => manager
            .set_rail_run(&rail_id, &state, current_stage_id)
            .map(|()| Response::Ok),
        Request::SetStepRun { step_id, state, session_id, reason } => manager
            .set_step_run(&step_id, &state, session_id, reason)
            .map(|()| Response::Ok),
```

- [ ] **Step 5: Update the two call sites of `SessionManager::new`**

In `crates/daemon/src/main.rs` around lines 31-32:

```rust
    let kanban = KanbanStore::open(&kanban_db_path())?;
    let orchestration = orchestration::OrchestrationStore::open(&orchestration_db_path())?;
    let manager = Arc::new(SessionManager::new(registry, kanban, orchestration));
```

Then update every existing `SessionManager::new(...)` in `server.rs`'s tests to call `test_manager(&dir)` instead, or to pass a third store.

- [ ] **Step 6: Run the whole daemon suite**

Run: `cargo test -p gavin-daemon`
Expected: PASS — the three new tests plus every pre-existing one.

- [ ] **Step 7: Commit**

```bash
git add crates/daemon/src/server.rs crates/daemon/src/main.rs
git commit -m "feat(daemon): route the four orchestration requests"
```

---

### Task 4: Tauri commands and `backend.ts`

**Files:**
- Modify: `app/src-tauri/src/session.rs` (beside `get_board`/`set_board`, around line 1365)
- Modify: `app/src-tauri/src/lib.rs:66-67`
- Modify: `app/src/lib/backend.ts`

**Interfaces:**
- Consumes: `Request::GetOrchestration`/`SetOrchestration`/`SetRailRun`/`SetStepRun` from Task 1.
- Produces: `backend.getOrchestration(workspaceId)`, `backend.setOrchestration(workspaceId, rails, conflictNotes)`, `backend.setRailRun(railId, state, currentStageId)`, `backend.setStepRun(stepId, state, sessionId, reason)`.

- [ ] **Step 1: Add the commands**

In `app/src-tauri/src/session.rs`, beside `set_board`:

```rust
fn get_orchestration_impl(
    command_conn: &Mutex<UnixStream>,
    workspace_id: String,
) -> anyhow::Result<Orchestration> {
    let resp = send_command(command_conn, &Request::GetOrchestration { workspace_id })?;
    match resp {
        Response::Orchestration { rails, conflict_notes, rail_runs, step_runs } => {
            Ok(Orchestration { rails, conflict_notes, rail_runs, step_runs })
        }
        other => anyhow::bail!("expected Orchestration, got {other:?}"),
    }
}

#[tauri::command]
pub fn get_orchestration(
    workspace_id: String,
    state: State<CommandConnection>,
) -> Result<Orchestration, String> {
    get_orchestration_impl(&state.0, workspace_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_orchestration(
    workspace_id: String,
    rails: Vec<Rail>,
    conflict_notes: Vec<ConflictNote>,
    state: State<CommandConnection>,
) -> Result<(), String> {
    let resp = send_command(
        &state.0,
        &Request::SetOrchestration { workspace_id, rails, conflict_notes },
    )
    .map_err(|e| e.to_string())?;
    match resp {
        Response::Ok => Ok(()),
        Response::Error { message } => Err(message),
        other => Err(format!("expected Ok, got {other:?}")),
    }
}

#[tauri::command]
pub fn set_rail_run(
    rail_id: String,
    state_value: String,
    current_stage_id: Option<String>,
    state: State<CommandConnection>,
) -> Result<(), String> {
    let resp = send_command(
        &state.0,
        &Request::SetRailRun { rail_id, state: state_value, current_stage_id },
    )
    .map_err(|e| e.to_string())?;
    match resp {
        Response::Ok => Ok(()),
        Response::Error { message } => Err(message),
        other => Err(format!("expected Ok, got {other:?}")),
    }
}

#[tauri::command]
pub fn set_step_run(
    step_id: String,
    state_value: String,
    session_id: Option<String>,
    reason: Option<String>,
    state: State<CommandConnection>,
) -> Result<(), String> {
    let resp = send_command(
        &state.0,
        &Request::SetStepRun { step_id, state: state_value, session_id, reason },
    )
    .map_err(|e| e.to_string())?;
    match resp {
        Response::Ok => Ok(()),
        Response::Error { message } => Err(message),
        other => Err(format!("expected Ok, got {other:?}")),
    }
}
```

`state_value` rather than `state`: the Tauri `State<CommandConnection>` parameter already owns the name `state` in this file's convention. Add `Orchestration, Rail, ConflictNote` to this file's existing `use protocol::{...}` list.

- [ ] **Step 2: Register them**

In `app/src-tauri/src/lib.rs`, beside `session::get_board` / `session::set_board`:

```rust
            session::get_orchestration,
            session::set_orchestration,
            session::set_rail_run,
            session::set_step_run,
```

- [ ] **Step 3: Add the `backend.ts` wrappers**

Append to `app/src/lib/backend.ts` (import the types added in Task 5 — do this step after Task 5 if the type import does not resolve yet, or add the import once Task 5 lands):

```ts
// --- Orchestration (SP1) ----------------------------------------------------

export function getOrchestration(workspaceId: string): Promise<Orchestration> {
  return invoke("get_orchestration", { workspaceId });
}

export function setOrchestration(
  workspaceId: string,
  rails: Rail[],
  conflictNotes: ConflictNote[]
): Promise<void> {
  return invoke("set_orchestration", { workspaceId, rails, conflictNotes });
}

export function setRailRun(
  railId: string,
  state: RailState,
  currentStageId: string | null
): Promise<void> {
  return invoke("set_rail_run", { railId, stateValue: state, currentStageId });
}

export function setStepRun(
  stepId: string,
  state: StepState,
  sessionId: string | null,
  reason: string | null
): Promise<void> {
  return invoke("set_step_run", { stepId, stateValue: state, sessionId, reason });
}
```

and extend the file's type imports with:

```ts
import type { ConflictNote, Orchestration, Rail, RailState, StepState } from "./orchestration";
```

- [ ] **Step 4: Verify it compiles**

Run: `cargo build -p gavin-app 2>/dev/null || cargo build --workspace`
Expected: builds clean. Then `cd app && npm run check` — expected clean once Task 5's types exist.

- [ ] **Step 5: Commit**

```bash
git add app/src-tauri/src/session.rs app/src-tauri/src/lib.rs app/src/lib/backend.ts
git commit -m "feat(app): orchestration Tauri commands and backend wrappers"
```

---

### Task 5: `orchestration.ts` primitives

**Files:**
- Create: `app/src/lib/orchestration.ts`
- Create: `app/src/lib/orchestration.test.ts`

**Interfaces:**
- Consumes: `Board`, `Column` from `./kanban`; `GavinTree`, `PlanFileInfo` from `./gavin`; `slugStatus` from `./planBoard`; `WorktreeInfo` from `./git`.
- Produces: types `Step`, `Stage`, `Rail`, `ConflictNote`, `RailState`, `StepState`, `RailRun`, `StepRun`, `Orchestration`, `Action`; functions `emptyOrchestration()`, `doneColumn(board)`, `cardIndex(tree)`, `effectiveWorktree(rail, entry)`, `stepStateOf(orch, stepId)`, `railStateOf(orch, railId)`, `firstUnfinishedStageId(rail, orch)`.

- [ ] **Step 1: Write the failing tests**

Create `app/src/lib/orchestration.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  emptyOrchestration,
  doneColumn,
  cardIndex,
  effectiveWorktree,
  stepStateOf,
  railStateOf,
  firstUnfinishedStageId,
} from "./orchestration";
import type { Orchestration, Rail } from "./orchestration";
import type { Board } from "./kanban";
import type { GavinTree, PlanFileInfo } from "./gavin";

function board(names: string[]): Board {
  return {
    columns: names.map((name, i) => ({ id: `c${i}`, name, position: i })),
    labels: [],
    cardSessions: [],
  };
}

function plan(fileName: string, overrides: Partial<PlanFileInfo> = {}): PlanFileInfo {
  return {
    path: `/ws/.gavin-root/plans/${fileName}`,
    fileName,
    title: fileName.replace(/\.md$/, ""),
    status: null,
    priority: null,
    order: null,
    kind: "task",
    parent: null,
    labels: [],
    checklistDone: 0,
    checklistTotal: 0,
    parseWarning: false,
    ...overrides,
  };
}

function tree(plans: PlanFileInfo[]): GavinTree {
  return {
    rootPath: "/ws",
    rootMissing: false,
    contexts: [
      {
        folderPath: "/ws/.gavin-root",
        kind: "root",
        name: "ws",
        plans,
        docs: [],
        specs: [],
        hasPrd: true,
        configWarning: false,
      },
    ],
  };
}

function rail(id: string, stages: Array<Array<[string, string]>>): Rail {
  return {
    id,
    name: id,
    position: 0,
    worktreePath: null,
    pageId: null,
    stages: stages.map((steps, si) => ({
      id: `${id}-s${si}`,
      position: si,
      steps: steps.map(([stepId, cardPath], pi) => ({ id: stepId, position: pi, cardPath })),
    })),
  };
}

describe("doneColumn", () => {
  it("is the column with the highest position", () => {
    expect(doneColumn(board(["To Do", "In Progress", "Done"]))?.name).toBe("Done");
  });

  it("ignores array order and uses position", () => {
    const b = board(["To Do", "Done"]);
    b.columns = [b.columns[1], b.columns[0]];
    expect(doneColumn(b)?.name).toBe("Done");
  });

  it("is null for a board with no columns", () => {
    expect(doneColumn(board([]))).toBeNull();
  });
});

describe("cardIndex", () => {
  it("maps every card path to its plan and context folder", () => {
    const idx = cardIndex(tree([plan("a.md")]));
    expect(idx.get("/ws/.gavin-root/plans/a.md")?.contextFolder).toBe("/ws/.gavin-root");
  });

  it("is empty for a missing or missing-root tree", () => {
    expect(cardIndex(undefined).size).toBe(0);
    expect(cardIndex({ ...tree([plan("a.md")]), rootMissing: true }).size).toBe(0);
  });
});

describe("effectiveWorktree", () => {
  it("is the rail's worktree when bound", () => {
    const r = { ...rail("r1", [[["t1", "/ws/.gavin-root/plans/a.md"]]]), worktreePath: "/x/wt" };
    expect(effectiveWorktree(r, { plan: plan("a.md"), contextFolder: "/ws/.gavin-root" })).toBe("/x/wt");
  });

  it("falls back to the card's context folder when unbound", () => {
    const r = rail("r1", [[["t1", "/ws/.gavin-root/plans/a.md"]]]);
    expect(effectiveWorktree(r, { plan: plan("a.md"), contextFolder: "/ws/.gavin-root" })).toBe(
      "/ws/.gavin-root"
    );
  });

  it("is null when unbound and the card is unknown", () => {
    expect(effectiveWorktree(rail("r1", []), undefined)).toBeNull();
  });
});

describe("state accessors", () => {
  const orch: Orchestration = {
    rails: [rail("r1", [[["t1", "/x/a.md"]]])],
    conflictNotes: [],
    railRuns: [{ railId: "r1", state: "running", currentStageId: "r1-s0" }],
    stepRuns: [{ stepId: "t1", state: "done", sessionId: "s1", reason: null }],
  };

  it("reads a recorded state", () => {
    expect(stepStateOf(orch, "t1")).toBe("done");
    expect(railStateOf(orch, "r1")).toBe("running");
  });

  it("defaults absence to pending and idle", () => {
    expect(stepStateOf(orch, "nope")).toBe("pending");
    expect(railStateOf(orch, "nope")).toBe("idle");
  });
});

describe("firstUnfinishedStageId", () => {
  it("skips stages whose every step is already done", () => {
    const r = rail("r1", [[["t1", "/x/a.md"]], [["t2", "/x/b.md"]]]);
    const orch: Orchestration = {
      rails: [r],
      conflictNotes: [],
      railRuns: [],
      stepRuns: [{ stepId: "t1", state: "done", sessionId: null, reason: null }],
    };
    expect(firstUnfinishedStageId(r, orch)).toBe("r1-s1");
  });

  it("is null when every stage is done", () => {
    const r = rail("r1", [[["t1", "/x/a.md"]]]);
    const orch: Orchestration = {
      rails: [r],
      conflictNotes: [],
      railRuns: [],
      stepRuns: [{ stepId: "t1", state: "done", sessionId: null, reason: null }],
    };
    expect(firstUnfinishedStageId(r, orch)).toBeNull();
  });

  it("is null for a rail with no stages", () => {
    expect(firstUnfinishedStageId(rail("r1", []), emptyOrchestration())).toBeNull();
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd app && npm test -- orchestration`
Expected: FAIL — `Failed to resolve import "./orchestration"`.

- [ ] **Step 3: Implement the primitives**

Create `app/src/lib/orchestration.ts`:

```ts
// The orchestration plan and its scheduler, as pure data and pure
// functions (orchestration spec O10). No Svelte, no Tauri, no I/O --
// orchestrationState.ts owns every side effect. TS mirrors of
// crates/protocol's orchestration shapes (camelCase on the wire).

import type { Board, Column } from "./kanban";
import type { GavinContext, GavinTree, PlanFileInfo } from "./gavin";
import type { WorktreeInfo } from "./git";
import { slugStatus } from "./planBoard";

export interface Step {
  id: string;
  position: number;
  /// The card file's absolute path -- a step is a REFERENCE to a card
  /// (spec O2); title, prompt and status all stay in the file.
  cardPath: string;
}

/// Stages run one after another; a stage's steps run in parallel, in the
/// SAME checkout, since they share the rail's worktree.
export interface Stage {
  id: string;
  position: number;
  steps: Step[];
}

export interface Rail {
  id: string;
  name: string;
  position: number;
  /// cwd for this rail's steps. Null falls back to each card's own
  /// contextFolder (see effectiveWorktree) and raises a `rail-unbound`
  /// conflict in SP2.
  worktreePath: string | null;
  /// Workspace page its sessions land on; null uses the Agents-page
  /// posture handleAgentSessionSpawned already applies.
  pageId: string | null;
  stages: Stage[];
}

export interface ConflictNote {
  id: string;
  stepIds: string[];
  note: string;
}

export type RailState = "idle" | "running" | "paused";
export type StepState = "pending" | "running" | "done" | "stalled";

export interface RailRun {
  railId: string;
  state: RailState;
  currentStageId: string | null;
}

export interface StepRun {
  stepId: string;
  state: StepState;
  sessionId: string | null;
  /// Human-readable stall cause; null otherwise.
  reason: string | null;
}

export interface Orchestration {
  rails: Rail[];
  conflictNotes: ConflictNote[];
  railRuns: RailRun[];
  stepRuns: StepRun[];
}

export function emptyOrchestration(): Orchestration {
  return { rails: [], conflictNotes: [], railRuns: [], stepRuns: [] };
}

/// A card resolved out of the gavin tree, with the context folder that
/// owns it -- the cwd fallback for an unbound rail.
export interface CardEntry {
  plan: PlanFileInfo;
  contextFolder: string;
}

/// The board's done column: the one with the highest `position`, NOT the
/// last array element (spec O6). Null for a board with no columns, in
/// which case nothing can ever complete and the rail header says so.
export function doneColumn(board: Board): Column | null {
  let best: Column | null = null;
  for (const c of board.columns) {
    if (!best || c.position > best.position) best = c;
  }
  return best;
}

export function cardIndex(tree: GavinTree | undefined): Map<string, CardEntry> {
  const index = new Map<string, CardEntry>();
  if (!tree || tree.rootMissing) return index;
  for (const ctx of tree.contexts as GavinContext[]) {
    for (const plan of ctx.plans) {
      index.set(plan.path, { plan, contextFolder: ctx.folderPath });
    }
  }
  return index;
}

/// WHERE AN AGENT'S SHELL STARTS. Not the isolation question: SP2 adds
/// `conflictCheckout` for that, because a card's contextFolder is a
/// subdirectory of the root checkout rather than a checkout of its own
/// (spec O13). Keep the two apart.
export function effectiveWorktree(rail: Rail, entry: CardEntry | undefined): string | null {
  return rail.worktreePath ?? entry?.contextFolder ?? null;
}

export function stepStateOf(orch: Orchestration, stepId: string): StepState {
  return orch.stepRuns.find((r) => r.stepId === stepId)?.state ?? "pending";
}

export function railStateOf(orch: Orchestration, railId: string): RailState {
  return orch.railRuns.find((r) => r.railId === railId)?.state ?? "idle";
}

/// Where Start arms the rail: the first stage (by position) holding a
/// step that is not already `done`. Cards that are ALREADY in the done
/// column are not considered here -- nextActions marks and cascades past
/// them on the first tick, which keeps this trivial and keeps one place
/// deciding what "done" means.
export function firstUnfinishedStageId(rail: Rail, orch: Orchestration): string | null {
  const stages = [...rail.stages].sort((a, b) => a.position - b.position);
  for (const stage of stages) {
    if (!stage.steps.every((s) => stepStateOf(orch, s.id) === "done")) return stage.id;
  }
  return null;
}
```

`WorktreeInfo` and `slugStatus` are imported here but not used until Task 6. If your linter objects to unused imports, add those two lines in Task 6 instead.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `cd app && npm test -- orchestration`
Expected: PASS — all primitive tests.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/orchestration.ts app/src/lib/orchestration.test.ts
git commit -m "feat(app): orchestration wire types and scheduler primitives"
```

---

### Task 6: The `nextActions` scheduler

**Files:**
- Modify: `app/src/lib/orchestration.ts`
- Modify: `app/src/lib/orchestration.test.ts`

**Interfaces:**
- Consumes: everything Task 5 produced.
- Produces: `type Action`; `nextActions(orch, board, tree, worktrees, liveSessionIds): Action[]`.

`Action` is exactly:

```ts
export type Action =
  | { kind: "launch"; stepId: string }
  | { kind: "markDone"; stepId: string }
  | { kind: "stall"; stepId: string; reason: string }
  | { kind: "advance"; railId: string; stageId: string }
  | { kind: "complete"; railId: string };
```

- [ ] **Step 1: Write the failing tests**

Append to `app/src/lib/orchestration.test.ts` (the helpers `board`, `plan`, `tree`, `rail` from Task 5 are already in scope):

```ts
import { nextActions } from "./orchestration";
import type { Action } from "./orchestration";

const BOARD = board(["To Do", "In Progress", "Done"]);

function running(rail: Rail, stageId: string, stepRuns: Orchestration["stepRuns"] = []): Orchestration {
  return {
    rails: [rail],
    conflictNotes: [],
    railRuns: [{ railId: rail.id, state: "running", currentStageId: stageId }],
    stepRuns,
  };
}

describe("nextActions", () => {
  it("returns nothing for a rail that is not running", () => {
    const r = rail("r1", [[["t1", "/ws/.gavin-root/plans/a.md"]]]);
    const orch: Orchestration = { rails: [r], conflictNotes: [], railRuns: [], stepRuns: [] };
    expect(nextActions(orch, BOARD, tree([plan("a.md")]), [], new Set())).toEqual([]);
  });

  it("launches a pending step of the current stage", () => {
    const r = rail("r1", [[["t1", "/ws/.gavin-root/plans/a.md"]]]);
    expect(nextActions(running(r, "r1-s0"), BOARD, tree([plan("a.md")]), [], new Set())).toEqual([
      { kind: "launch", stepId: "t1" },
    ]);
  });

  it("launches every step of a parallel stage at once", () => {
    const r = rail("r1", [[
      ["t1", "/ws/.gavin-root/plans/a.md"],
      ["t2", "/ws/.gavin-root/plans/b.md"],
    ]]);
    const actions = nextActions(
      running(r, "r1-s0"),
      BOARD,
      tree([plan("a.md"), plan("b.md")]),
      [],
      new Set()
    );
    expect(actions).toEqual([
      { kind: "launch", stepId: "t1" },
      { kind: "launch", stepId: "t2" },
    ]);
  });

  it("marks a step done when its card reaches the done column", () => {
    const r = rail("r1", [[["t1", "/ws/.gavin-root/plans/a.md"]]]);
    const orch = running(r, "r1-s0", [{ stepId: "t1", state: "running", sessionId: "s1", reason: null }]);
    const actions = nextActions(
      orch,
      BOARD,
      tree([plan("a.md", { status: "Done" })]),
      [],
      new Set(["s1"])
    );
    expect(actions).toContainEqual({ kind: "markDone", stepId: "t1" });
  });

  it("matches the done column by slug, not by exact spelling", () => {
    const r = rail("r1", [[["t1", "/ws/.gavin-root/plans/a.md"]]]);
    const orch = running(r, "r1-s0", [{ stepId: "t1", state: "running", sessionId: "s1", reason: null }]);
    const actions = nextActions(
      orch,
      BOARD,
      tree([plan("a.md", { status: "  done  " })]),
      [],
      new Set(["s1"])
    );
    expect(actions).toContainEqual({ kind: "markDone", stepId: "t1" });
  });

  it("advances to the next stage once every step of this one is done", () => {
    const r = rail("r1", [[["t1", "/ws/.gavin-root/plans/a.md"]], [["t2", "/ws/.gavin-root/plans/b.md"]]]);
    const orch = running(r, "r1-s0", [{ stepId: "t1", state: "done", sessionId: null, reason: null }]);
    const actions = nextActions(orch, BOARD, tree([plan("a.md"), plan("b.md")]), [], new Set());
    expect(actions).toEqual([
      { kind: "advance", railId: "r1", stageId: "r1-s1" },
      { kind: "launch", stepId: "t2" },
    ]);
  });

  it("collapses a run of already-done stages in a single tick", () => {
    const r = rail("r1", [
      [["t1", "/ws/.gavin-root/plans/a.md"]],
      [["t2", "/ws/.gavin-root/plans/b.md"]],
      [["t3", "/ws/.gavin-root/plans/c.md"]],
    ]);
    const t = tree([
      plan("a.md", { status: "Done" }),
      plan("b.md", { status: "Done" }),
      plan("c.md"),
    ]);
    const actions = nextActions(running(r, "r1-s0"), BOARD, t, [], new Set());
    expect(actions).toEqual([
      { kind: "markDone", stepId: "t1" },
      { kind: "advance", railId: "r1", stageId: "r1-s1" },
      { kind: "markDone", stepId: "t2" },
      { kind: "advance", railId: "r1", stageId: "r1-s2" },
      { kind: "launch", stepId: "t3" },
    ]);
  });

  it("completes the rail after its last stage", () => {
    const r = rail("r1", [[["t1", "/ws/.gavin-root/plans/a.md"]]]);
    const orch = running(r, "r1-s0", [{ stepId: "t1", state: "done", sessionId: null, reason: null }]);
    expect(nextActions(orch, BOARD, tree([plan("a.md")]), [], new Set())).toEqual([
      { kind: "complete", railId: "r1" },
    ]);
  });

  it("treats an empty stage as complete and moves past it", () => {
    const r = rail("r1", [[], [["t1", "/ws/.gavin-root/plans/a.md"]]]);
    expect(nextActions(running(r, "r1-s0"), BOARD, tree([plan("a.md")]), [], new Set())).toEqual([
      { kind: "advance", railId: "r1", stageId: "r1-s1" },
      { kind: "launch", stepId: "t1" },
    ]);
  });

  it("stalls a step whose card file is missing", () => {
    const r = rail("r1", [[["t1", "/ws/.gavin-root/plans/gone.md"]]]);
    expect(nextActions(running(r, "r1-s0"), BOARD, tree([]), [], new Set())).toEqual([
      { kind: "stall", stepId: "t1", reason: "card file is missing" },
    ]);
  });

  it("stalls a step pointing at a note", () => {
    const r = rail("r1", [[["t1", "/ws/.gavin-root/plans/a.md"]]]);
    const actions = nextActions(
      running(r, "r1-s0"),
      BOARD,
      tree([plan("a.md", { kind: "note" })]),
      [],
      new Set()
    );
    expect(actions).toEqual([{ kind: "stall", stepId: "t1", reason: "notes are not runnable" }]);
  });

  it("stalls when the rail's bound worktree is gone", () => {
    const r = { ...rail("r1", [[["t1", "/ws/.gavin-root/plans/a.md"]]]), worktreePath: "/x/gone" };
    const worktrees = [
      { path: "/ws", head: "abc", branch: "main", isMain: true, locked: false, prunable: false },
    ];
    expect(nextActions(running(r, "r1-s0"), BOARD, tree([plan("a.md")]), worktrees, new Set())).toEqual([
      { kind: "stall", stepId: "t1", reason: "worktree /x/gone is gone" },
    ]);
  });

  it("does not stall on a missing worktree when the worktree list is unknown", () => {
    const r = { ...rail("r1", [[["t1", "/ws/.gavin-root/plans/a.md"]]]), worktreePath: "/x/maybe" };
    expect(nextActions(running(r, "r1-s0"), BOARD, tree([plan("a.md")]), null, new Set())).toEqual([
      { kind: "launch", stepId: "t1" },
    ]);
  });

  it("stalls a running step whose session is gone and whose card is not done", () => {
    const r = rail("r1", [[["t1", "/ws/.gavin-root/plans/a.md"]]]);
    const orch = running(r, "r1-s0", [{ stepId: "t1", state: "running", sessionId: "s1", reason: null }]);
    expect(nextActions(orch, BOARD, tree([plan("a.md")]), [], new Set())).toEqual([
      { kind: "stall", stepId: "t1", reason: "agent exited before the card reached Done" },
    ]);
  });

  it("prefers markDone over stall when the session is gone but the card IS done", () => {
    const r = rail("r1", [[["t1", "/ws/.gavin-root/plans/a.md"]]]);
    const orch = running(r, "r1-s0", [{ stepId: "t1", state: "running", sessionId: "s1", reason: null }]);
    const actions = nextActions(orch, BOARD, tree([plan("a.md", { status: "Done" })]), [], new Set());
    expect(actions).toEqual([
      { kind: "markDone", stepId: "t1" },
      { kind: "complete", railId: "r1" },
    ]);
  });

  it("stops at the first stall and does not advance past it", () => {
    const r = rail("r1", [
      [["t1", "/ws/.gavin-root/plans/gone.md"], ["t2", "/ws/.gavin-root/plans/a.md"]],
      [["t3", "/ws/.gavin-root/plans/b.md"]],
    ]);
    const actions = nextActions(
      running(r, "r1-s0"),
      BOARD,
      tree([plan("a.md"), plan("b.md")]),
      [],
      new Set()
    );
    expect(actions).toContainEqual({ kind: "stall", stepId: "t1", reason: "card file is missing" });
    expect(actions.some((a: Action) => a.kind === "advance")).toBe(false);
  });

  it("never advances when the board has no done column", () => {
    const r = rail("r1", [[["t1", "/ws/.gavin-root/plans/a.md"]]]);
    const orch = running(r, "r1-s0", [{ stepId: "t1", state: "running", sessionId: "s1", reason: null }]);
    const actions = nextActions(
      orch,
      board([]),
      tree([plan("a.md", { status: "Done" })]),
      [],
      new Set(["s1"])
    );
    expect(actions).toEqual([]);
  });

  it("schedules each running rail independently", () => {
    const a = rail("r1", [[["t1", "/ws/.gavin-root/plans/a.md"]]]);
    const b = rail("r2", [[["t2", "/ws/.gavin-root/plans/b.md"]]]);
    const orch: Orchestration = {
      rails: [a, b],
      conflictNotes: [],
      railRuns: [
        { railId: "r1", state: "running", currentStageId: "r1-s0" },
        { railId: "r2", state: "paused", currentStageId: "r2-s0" },
      ],
      stepRuns: [],
    };
    expect(nextActions(orch, BOARD, tree([plan("a.md"), plan("b.md")]), [], new Set())).toEqual([
      { kind: "launch", stepId: "t1" },
    ]);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd app && npm test -- orchestration`
Expected: FAIL — `nextActions is not a function`.

- [ ] **Step 3: Implement `nextActions`**

Append to `app/src/lib/orchestration.ts`:

```ts
/// What the reactive layer must DO. nextActions decides; executing is
/// orchestrationState.ts's job alone.
export type Action =
  | { kind: "launch"; stepId: string }
  | { kind: "markDone"; stepId: string }
  | { kind: "stall"; stepId: string; reason: string }
  | { kind: "advance"; railId: string; stageId: string }
  | { kind: "complete"; railId: string };

/// Why a pending step cannot be launched right now, or null.
/// `knownWorktrees` is null when the worktree list has not loaded yet --
/// unknown must never look like "gone", or a cold start would stall
/// every bound rail.
function launchBlocker(
  rail: Rail,
  entry: CardEntry | undefined,
  knownWorktrees: Set<string> | null
): string | null {
  if (!entry) return "card file is missing";
  if (entry.plan.kind === "note") return "notes are not runnable";
  if (rail.worktreePath && knownWorktrees && !knownWorktrees.has(rail.worktreePath)) {
    return `worktree ${rail.worktreePath} is gone`;
  }
  return null;
}

/// The scheduler (spec §4.2). Pure and total: same inputs, same list.
/// Rules run in order per stage -- mark done, launch or stall pending,
/// stall a running step whose session died -- and a fully-done stage
/// advances within the same tick, so a run of already-finished stages
/// collapses in one pass.
export function nextActions(
  orch: Orchestration,
  board: Board,
  tree: GavinTree | undefined,
  worktrees: WorktreeInfo[] | null,
  liveSessionIds: Set<string>
): Action[] {
  const actions: Action[] = [];
  const cards = cardIndex(tree);
  const done = doneColumn(board);
  const doneSlug = done ? slugStatus(done.name) : null;
  const knownWorktrees = worktrees ? new Set(worktrees.map((w) => w.path)) : null;
  const runByStep = new Map(orch.stepRuns.map((r) => [r.stepId, r]));

  for (const rail of orch.rails) {
    if (railStateOf(orch, rail.id) !== "running") continue;

    // Step states simulated forward within this tick, so an advance can
    // cascade without re-entering the function.
    const simulated = new Map<string, StepState>();
    for (const stage of rail.stages) {
      for (const step of stage.steps) simulated.set(step.id, stepStateOf(orch, step.id));
    }

    let stageId = orch.railRuns.find((r) => r.railId === rail.id)?.currentStageId ?? null;
    let stalled = false;

    for (let guard = 0; guard <= rail.stages.length; guard++) {
      const stage = rail.stages.find((s) => s.id === stageId);
      if (!stage) {
        actions.push({ kind: "complete", railId: rail.id });
        break;
      }

      for (const step of [...stage.steps].sort((a, b) => a.position - b.position)) {
        const state = simulated.get(step.id);
        const entry = cards.get(step.cardPath);

        // Rule 1 -- the card reached the done column. Checked before
        // launching, so re-arming a rail is idempotent, and before the
        // dead-session check, so an agent that finished the card and
        // then quit counts as done, not stalled.
        if (
          (state === "pending" || state === "running") &&
          doneSlug &&
          entry &&
          slugStatus(entry.plan.status ?? "") === doneSlug
        ) {
          actions.push({ kind: "markDone", stepId: step.id });
          simulated.set(step.id, "done");
          continue;
        }

        // Rule 2 -- launch a pending step, or stall it with a reason.
        if (state === "pending") {
          const reason = launchBlocker(rail, entry, knownWorktrees);
          if (reason) {
            actions.push({ kind: "stall", stepId: step.id, reason });
            simulated.set(step.id, "stalled");
            stalled = true;
          } else {
            actions.push({ kind: "launch", stepId: step.id });
            simulated.set(step.id, "running");
          }
          continue;
        }

        // Rule 3 -- a running step whose session is gone (spec O6).
        if (state === "running") {
          const sessionId = runByStep.get(step.id)?.sessionId ?? null;
          if (sessionId && !liveSessionIds.has(sessionId)) {
            actions.push({
              kind: "stall",
              stepId: step.id,
              reason: `agent exited before the card reached ${done?.name ?? "the done column"}`,
            });
            simulated.set(step.id, "stalled");
            stalled = true;
          }
        }
      }

      // Rule 5 -- any stall this tick pauses the rail; the executor
      // writes that, and we stop scheduling here.
      if (stalled) break;

      // Rule 4 -- a fully-done stage advances. An empty stage is
      // vacuously done, so it is stepped over rather than hanging.
      if (!stage.steps.every((s) => simulated.get(s.id) === "done")) break;
      const next = rail.stages
        .filter((s) => s.position > stage.position)
        .sort((a, b) => a.position - b.position)[0];
      if (!next) {
        actions.push({ kind: "complete", railId: rail.id });
        break;
      }
      actions.push({ kind: "advance", railId: rail.id, stageId: next.id });
      stageId = next.id;
    }
  }

  return actions;
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `cd app && npm test -- orchestration`
Expected: PASS — every scheduler test.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/orchestration.ts app/src/lib/orchestration.test.ts
git commit -m "feat(app): nextActions, the orchestration scheduler"
```

---

### Task 7: `orchestrationState.ts` — store and persistence

**Files:**
- Create: `app/src/lib/orchestrationState.ts`
- Create: `app/src/lib/orchestrationState.test.ts`

**Interfaces:**
- Consumes: `backend.getOrchestration/setOrchestration/setRailRun/setStepRun` (Task 4); types from Task 5.
- Produces: `orchestrations` store; `fetchOrchestration(workspaceId)`, `refreshOrchestration(workspaceId)`, `mutatePlan(workspaceId, mutate)`, `setRailRunAction(workspaceId, railId, state, currentStageId)`, `setStepRunAction(workspaceId, stepId, state, sessionId, reason)`, `saveErrors`, `dismissSaveError(workspaceId)`, `__resetForTesting()`.

This deliberately mirrors `kanbanState.ts`, including its rollback-unless-superseded rule and its `pendingSaves` guard.

- [ ] **Step 1: Write the failing tests**

Create `app/src/lib/orchestrationState.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { get } from "svelte/store";

vi.mock("./backend", () => ({
  getOrchestration: vi.fn(),
  setOrchestration: vi.fn(),
  setRailRun: vi.fn(),
  setStepRun: vi.fn(),
}));

import * as backend from "./backend";
import {
  orchestrations,
  fetchOrchestration,
  mutatePlan,
  setRailRunAction,
  setStepRunAction,
  saveErrors,
  dismissSaveError,
  __resetForTesting,
} from "./orchestrationState";
import { emptyOrchestration } from "./orchestration";
import type { Orchestration, Rail } from "./orchestration";

function rail(id: string): Rail {
  return { id, name: id, position: 0, worktreePath: null, pageId: null, stages: [] };
}

function withRails(...ids: string[]): Orchestration {
  return { ...emptyOrchestration(), rails: ids.map(rail) };
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetForTesting();
});

describe("fetchOrchestration", () => {
  it("loads once and caches", async () => {
    vi.mocked(backend.getOrchestration).mockResolvedValue(withRails("r1"));
    await fetchOrchestration("ws-1");
    await fetchOrchestration("ws-1");
    expect(backend.getOrchestration).toHaveBeenCalledTimes(1);
    expect(get(orchestrations)["ws-1"].rails[0].id).toBe("r1");
  });

  it("leaves the workspace unset when the load fails", async () => {
    vi.mocked(backend.getOrchestration).mockRejectedValue(new Error("nope"));
    await fetchOrchestration("ws-1");
    expect(get(orchestrations)["ws-1"]).toBeUndefined();
  });
});

describe("mutatePlan", () => {
  it("applies optimistically and persists the whole plan", async () => {
    vi.mocked(backend.getOrchestration).mockResolvedValue(withRails("r1"));
    vi.mocked(backend.setOrchestration).mockResolvedValue(undefined);
    await fetchOrchestration("ws-1");

    await mutatePlan("ws-1", (o) => ({ ...o, rails: [...o.rails, rail("r2")] }));

    expect(get(orchestrations)["ws-1"].rails.map((r) => r.id)).toEqual(["r1", "r2"]);
    expect(backend.setOrchestration).toHaveBeenCalledWith(
      "ws-1",
      [expect.objectContaining({ id: "r1" }), expect.objectContaining({ id: "r2" })],
      []
    );
  });

  it("rolls back and records the message when the save fails", async () => {
    vi.mocked(backend.getOrchestration).mockResolvedValue(withRails("r1"));
    vi.mocked(backend.setOrchestration).mockRejectedValue(
      new Error("step t1 (/x/a.md) is running — pause or let it finish before removing it")
    );
    await fetchOrchestration("ws-1");

    await mutatePlan("ws-1", (o) => ({ ...o, rails: [] }));

    expect(get(orchestrations)["ws-1"].rails.map((r) => r.id)).toEqual(["r1"]);
    expect(get(saveErrors)["ws-1"]).toContain("is running");
    dismissSaveError("ws-1");
    expect(get(saveErrors)["ws-1"]).toBeUndefined();
  });

  it("is a no-op for a workspace that was never fetched", async () => {
    await mutatePlan("ws-nope", (o) => ({ ...o, rails: [rail("r1")] }));
    expect(backend.setOrchestration).not.toHaveBeenCalled();
  });
});

describe("run-state actions", () => {
  beforeEach(async () => {
    vi.mocked(backend.getOrchestration).mockResolvedValue(withRails("r1"));
    vi.mocked(backend.setRailRun).mockResolvedValue(undefined);
    vi.mocked(backend.setStepRun).mockResolvedValue(undefined);
    await fetchOrchestration("ws-1");
  });

  it("upserts a rail run in the store and persists it", async () => {
    await setRailRunAction("ws-1", "r1", "running", "s1");
    expect(get(orchestrations)["ws-1"].railRuns).toEqual([
      { railId: "r1", state: "running", currentStageId: "s1" },
    ]);
    expect(backend.setRailRun).toHaveBeenCalledWith("r1", "running", "s1");

    await setRailRunAction("ws-1", "r1", "paused", "s1");
    expect(get(orchestrations)["ws-1"].railRuns).toHaveLength(1);
    expect(get(orchestrations)["ws-1"].railRuns[0].state).toBe("paused");
  });

  it("upserts a step run in the store and persists it", async () => {
    await setStepRunAction("ws-1", "t1", "running", "sess-1", null);
    expect(get(orchestrations)["ws-1"].stepRuns).toEqual([
      { stepId: "t1", state: "running", sessionId: "sess-1", reason: null },
    ]);
    expect(backend.setStepRun).toHaveBeenCalledWith("t1", "running", "sess-1", null);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd app && npm test -- orchestrationState`
Expected: FAIL — `Failed to resolve import "./orchestrationState"`.

- [ ] **Step 3: Implement the store**

Create `app/src/lib/orchestrationState.ts`:

```ts
// The reactive half of orchestration: the per-workspace store, its
// persistence, and (Task 8) the tick that executes nextActions. Every
// decision lives in orchestration.ts; this module only holds state and
// performs effects. Shaped after kanbanState.ts on purpose -- same
// optimistic-mutate, same rollback-unless-superseded, same pendingSaves
// guard against a refresh clobbering an in-flight save.

import { writable, get } from "svelte/store";
import * as backend from "./backend";
import { emptyOrchestration } from "./orchestration";
import type { Orchestration, RailState, StepState } from "./orchestration";

export const orchestrations = writable<Record<string, Orchestration>>({});

export const saveErrors = writable<Record<string, string>>({});

export function dismissSaveError(workspaceId: string): void {
  saveErrors.update((e) => {
    if (!(workspaceId in e)) return e;
    const { [workspaceId]: _removed, ...rest } = e;
    return rest;
  });
}

const pendingSaves = new Map<string, number>();

export async function fetchOrchestration(workspaceId: string): Promise<void> {
  if (workspaceId in get(orchestrations)) return;
  try {
    const orch = await backend.getOrchestration(workspaceId);
    orchestrations.update((s) => ({ ...s, [workspaceId]: orch }));
  } catch {
    // Leave it unset; the tab renders its load-failed state and the next
    // mount retries.
  }
}

/// Re-reads from SQLite. Skipped while a save is in flight, and checked
/// again afterwards for saves that started meanwhile.
export async function refreshOrchestration(workspaceId: string): Promise<void> {
  if ((pendingSaves.get(workspaceId) ?? 0) > 0) return;
  try {
    const orch = await backend.getOrchestration(workspaceId);
    if ((pendingSaves.get(workspaceId) ?? 0) > 0) return;
    orchestrations.update((s) => ({ ...s, [workspaceId]: orch }));
  } catch {
    // Keep showing what we have.
  }
}

/// Every plan edit goes through here: apply optimistically, persist the
/// whole plan, roll back on failure unless a later mutation already
/// replaced it (reference check -- and that later save carries this
/// change anyway, since the plan is persisted wholesale).
export async function mutatePlan(
  workspaceId: string,
  mutate: (orch: Orchestration) => Orchestration
): Promise<void> {
  const current = get(orchestrations)[workspaceId];
  if (!current) return;
  const updated = mutate(current);
  orchestrations.update((s) => ({ ...s, [workspaceId]: updated }));
  pendingSaves.set(workspaceId, (pendingSaves.get(workspaceId) ?? 0) + 1);
  try {
    await backend.setOrchestration(workspaceId, updated.rails, updated.conflictNotes);
    dismissSaveError(workspaceId);
  } catch (e) {
    orchestrations.update((s) => (s[workspaceId] === updated ? { ...s, [workspaceId]: current } : s));
    saveErrors.update((err) => ({
      ...err,
      [workspaceId]: String(e instanceof Error ? e.message : e),
    }));
  } finally {
    pendingSaves.set(workspaceId, (pendingSaves.get(workspaceId) ?? 1) - 1);
  }
}

async function mutateRunState(
  workspaceId: string,
  apply: (orch: Orchestration) => Orchestration,
  persist: () => Promise<void>
): Promise<void> {
  const current = get(orchestrations)[workspaceId];
  if (!current) return;
  const updated = apply(current);
  orchestrations.update((s) => ({ ...s, [workspaceId]: updated }));
  pendingSaves.set(workspaceId, (pendingSaves.get(workspaceId) ?? 0) + 1);
  try {
    await persist();
    dismissSaveError(workspaceId);
  } catch (e) {
    orchestrations.update((s) => (s[workspaceId] === updated ? { ...s, [workspaceId]: current } : s));
    saveErrors.update((err) => ({
      ...err,
      [workspaceId]: String(e instanceof Error ? e.message : e),
    }));
  } finally {
    pendingSaves.set(workspaceId, (pendingSaves.get(workspaceId) ?? 1) - 1);
  }
}

export function setRailRunAction(
  workspaceId: string,
  railId: string,
  state: RailState,
  currentStageId: string | null
): Promise<void> {
  return mutateRunState(
    workspaceId,
    (orch) => ({
      ...orch,
      railRuns: [
        ...orch.railRuns.filter((r) => r.railId !== railId),
        { railId, state, currentStageId },
      ],
    }),
    () => backend.setRailRun(railId, state, currentStageId)
  );
}

export function setStepRunAction(
  workspaceId: string,
  stepId: string,
  state: StepState,
  sessionId: string | null,
  reason: string | null
): Promise<void> {
  return mutateRunState(
    workspaceId,
    (orch) => ({
      ...orch,
      stepRuns: [
        ...orch.stepRuns.filter((r) => r.stepId !== stepId),
        { stepId, state, sessionId, reason },
      ],
    }),
    () => backend.setStepRun(stepId, state, sessionId, reason)
  );
}

/** @internal test-only reset for module-level state */
export function __resetForTesting(): void {
  orchestrations.set({});
  saveErrors.set({});
  pendingSaves.clear();
}
```

`emptyOrchestration` is imported for consumers and tests; if your linter flags it as unused here, drop the import.

- [ ] **Step 4: Run the tests and watch them pass**

Run: `cd app && npm test -- orchestrationState`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/orchestrationState.ts app/src/lib/orchestrationState.test.ts
git commit -m "feat(app): orchestration store with optimistic plan persistence"
```

---

### Task 8: The launch executor and the tick

**Files:**
- Modify: `app/src/lib/layoutState.ts` (near `createSessionForCard`, line 994)
- Modify: `app/src/lib/orchestrationState.ts`
- Modify: `app/src/lib/orchestrationState.test.ts`

**Interfaces:**
- Consumes: `nextActions` (Task 6); `setRailRunAction`/`setStepRunAction` (Task 7); `composeTaskPrompt`, `composePlanPrompt`, `buildRunCommand`, `runStatusNeeded` from `./cardRun`; `resolvedAgentFor` from `./layoutState`; `linkCardSessionAction` from `./kanbanState`; `patchPlanField` from `./gavinState`; `stripFrontmatter` from `./planChecklist`.
- Produces: `layoutState.createSessionOnPage(workspaceId, pageId, cwd, command)`; `startRail(workspaceId, railId)`, `pauseRail(workspaceId, railId)`, `resumeRail(workspaceId, railId)`, `resetRail(workspaceId, railId)`, `retryStep(workspaceId, stepId)`, `tick(workspaceId)`.

- [ ] **Step 1: Add page-targeted session creation**

In `app/src/lib/layoutState.ts`, add above `createSessionForCard`:

```ts
/// createSessionForCard, but landing on a NAMED page rather than the
/// workspace's active one -- what an orchestration rail needs, since a
/// rail binds to a page (orchestration spec §4.3). A null or unknown
/// pageId falls back to createSessionForCard's behavior, which is the
/// Agents-page posture.
export async function createSessionOnPage(
  workspaceId: string,
  pageId: string | null,
  cwd: string,
  command: string | null
): Promise<string | null> {
  const state = get(layoutState);
  const ws = state.workspaces.find((w) => w.id === workspaceId);
  const page = pageId ? ws?.pages.find((p) => p.id === pageId) : undefined;
  if (!ws || !page) return createSessionForCard(workspaceId, cwd, command);

  let sessionId: string;
  try {
    sessionId = await backend.createSession(cwd || undefined, command ?? undefined);
  } catch (e) {
    setError(String(e));
    return null;
  }
  const anchor = layout.allSessionIds(page.layout)[0];
  const newTree = anchor
    ? layout.addTab(page.layout, anchor, sessionId)
    : layout.presetSingle(sessionId);
  const withTree = workspace.updatePageLayout(state, workspaceId, page.id, newTree);
  const data = workspace.setPageFocus(withTree, workspaceId, page.id, sessionId);
  layoutState.update((s) => ({ ...s, workspaces: data.workspaces }));
  await persistWorkspaces(data.workspaces, state.activeWorkspaceId);
  return sessionId;
}
```

- [ ] **Step 2: Write the failing tests**

Append to `app/src/lib/orchestrationState.test.ts`.

First extend the existing `vi.mock("./backend", ...)` factory at the top of the file with the two calls `executeLaunch` makes:

```ts
  readFileForViewer: vi.fn(),
  setPlanFrontmatterField: vi.fn(),
```

Then add these mock blocks beside it. `tick` reads four stores through `get()`, so each mock must expose a real store contract, not just its functions — a bare object here makes `get()` throw, and the failure reads as an unrelated crash:

```ts
// A minimal readable store: get() needs subscribe to call back
// synchronously and return an unsubscribe function.
function stubStore<T>(value: T) {
  return { subscribe: (fn: (v: T) => void) => (fn(value), () => {}) };
}

const CARD = {
  path: "/x/a.md",
  fileName: "a.md",
  title: "Wire the API",
  status: "To Do",
  priority: null,
  order: null,
  kind: "task" as const,
  parent: null,
  labels: [],
  checklistDone: 0,
  checklistTotal: 0,
  parseWarning: false,
};

vi.mock("./layoutState", () => ({
  layoutState: stubStore({ workspaces: [] }),
  resolvedAgentFor: vi.fn(() => ({ command: "claude", file: "CLAUDE.md", profile: "claude-code" })),
  createSessionOnPage: vi.fn(),
}));
vi.mock("./kanbanState", () => ({
  kanbanState: stubStore<Record<string, unknown>>({}),
  linkCardSessionAction: vi.fn(),
}));
vi.mock("./gavinState", () => ({
  gavinTrees: stubStore({
    "ws-1": {
      rootPath: "/ws",
      rootMissing: false,
      contexts: [
        {
          folderPath: "/ws/.gavin-root",
          kind: "root",
          name: "ws",
          plans: [CARD],
          docs: [],
          specs: [],
          hasPrd: true,
          configWarning: false,
        },
      ],
    },
  }),
  patchPlanField: vi.fn(),
}));
vi.mock("./gitState", () => ({
  gitStore: stubStore<Record<string, unknown>>({}),
  ensureGitView: vi.fn(),
  refresh: vi.fn(),
}));
```

`vi.mock` factories are hoisted above the imports, so `stubStore` and `CARD` must be declared with `function`/`const` *inside* the factory scope or hoisted themselves — if vitest complains that `stubStore` is not defined, inline the `{ subscribe }` literal into each factory rather than sharing the helper.

`kanbanState` is stubbed as an empty map on purpose: `tick` bails early without a board, so the rail-control tests below exercise arming without also running the scheduler. Then add:

```ts
import { startRail, pauseRail, retryStep, executeActions } from "./orchestrationState";
import * as layoutStateModule from "./layoutState";
import * as kanbanStateModule from "./kanbanState";

describe("rail controls", () => {
  beforeEach(async () => {
    vi.mocked(backend.getOrchestration).mockResolvedValue({
      ...emptyOrchestration(),
      rails: [
        {
          id: "r1",
          name: "backend",
          position: 0,
          worktreePath: null,
          pageId: null,
          stages: [{ id: "s1", position: 0, steps: [{ id: "t1", position: 0, cardPath: "/x/a.md" }] }],
        },
      ],
    });
    vi.mocked(backend.setRailRun).mockResolvedValue(undefined);
    vi.mocked(backend.setStepRun).mockResolvedValue(undefined);
    await fetchOrchestration("ws-1");
  });

  it("Start arms the rail at its first unfinished stage", async () => {
    await startRail("ws-1", "r1");
    expect(backend.setRailRun).toHaveBeenCalledWith("r1", "running", "s1");
  });

  it("Start is a no-op for a rail whose every stage is done", async () => {
    await setStepRunAction("ws-1", "t1", "done", null, null);
    vi.mocked(backend.setRailRun).mockClear();
    await startRail("ws-1", "r1");
    expect(backend.setRailRun).not.toHaveBeenCalled();
  });

  it("Pause keeps the current stage", async () => {
    await startRail("ws-1", "r1");
    await pauseRail("ws-1", "r1");
    expect(backend.setRailRun).toHaveBeenLastCalledWith("r1", "paused", "s1");
  });

  it("Retry returns a stalled step to pending and clears its reason", async () => {
    await setStepRunAction("ws-1", "t1", "stalled", "sess-1", "card file is missing");
    await retryStep("ws-1", "t1");
    expect(backend.setStepRun).toHaveBeenLastCalledWith("t1", "pending", null, null);
  });
});

describe("executeActions", () => {
  beforeEach(async () => {
    vi.mocked(backend.getOrchestration).mockResolvedValue({
      ...emptyOrchestration(),
      rails: [
        {
          id: "r1",
          name: "backend",
          position: 0,
          worktreePath: "/x/wt",
          pageId: "p1",
          stages: [{ id: "s1", position: 0, steps: [{ id: "t1", position: 0, cardPath: "/x/a.md" }] }],
        },
      ],
      railRuns: [{ railId: "r1", state: "running", currentStageId: "s1" }],
      // cardPath matches the CARD stubbed into gavinTrees above, so a
      // launch reaches createSessionOnPage instead of stalling on a
      // missing card.
    });
    vi.mocked(backend.setRailRun).mockResolvedValue(undefined);
    vi.mocked(backend.setStepRun).mockResolvedValue(undefined);
    await fetchOrchestration("ws-1");
  });

  it("a stall records the reason and pauses the owning rail", async () => {
    await executeActions("ws-1", [{ kind: "stall", stepId: "t1", reason: "card file is missing" }]);
    expect(backend.setStepRun).toHaveBeenCalledWith("t1", "stalled", null, "card file is missing");
    expect(backend.setRailRun).toHaveBeenCalledWith("r1", "paused", "s1");
  });

  it("markDone keeps the session id so the transcript stays reachable", async () => {
    await setStepRunAction("ws-1", "t1", "running", "sess-1", null);
    await executeActions("ws-1", [{ kind: "markDone", stepId: "t1" }]);
    expect(backend.setStepRun).toHaveBeenLastCalledWith("t1", "done", "sess-1", null);
  });

  it("advance moves the rail's current stage", async () => {
    await executeActions("ws-1", [{ kind: "advance", railId: "r1", stageId: "s2" }]);
    expect(backend.setRailRun).toHaveBeenLastCalledWith("r1", "running", "s2");
  });

  it("complete returns the rail to idle", async () => {
    await executeActions("ws-1", [{ kind: "complete", railId: "r1" }]);
    expect(backend.setRailRun).toHaveBeenLastCalledWith("r1", "idle", null);
  });

  it("a launch that cannot create a session stalls the step instead of throwing", async () => {
    vi.mocked(backend.readFileForViewer).mockResolvedValue({
      content: "---\ntitle: Wire the API\n---\ndo the thing",
      truncated: false,
      exists: true,
    });
    vi.mocked(layoutStateModule.createSessionOnPage).mockResolvedValue(null);
    await executeActions("ws-1", [{ kind: "launch", stepId: "t1" }]);
    expect(backend.setStepRun).toHaveBeenCalledWith(
      "t1",
      "stalled",
      null,
      expect.stringContaining("could not start")
    );
  });

  it("a launch binds the card session, records the session id, and writes In Progress", async () => {
    vi.mocked(backend.readFileForViewer).mockResolvedValue({
      content: "---\ntitle: Wire the API\n---\ndo the thing",
      truncated: false,
      exists: true,
    });
    vi.mocked(backend.setPlanFrontmatterField).mockResolvedValue(undefined);
    vi.mocked(layoutStateModule.createSessionOnPage).mockResolvedValue("sess-9");
    await executeActions("ws-1", [{ kind: "launch", stepId: "t1" }]);

    expect(layoutStateModule.createSessionOnPage).toHaveBeenCalledWith(
      "ws-1",
      "p1",
      "/x/wt",
      expect.stringContaining("claude ")
    );
    expect(kanbanStateModule.linkCardSessionAction).toHaveBeenCalledWith("ws-1", {
      path: "/x/a.md",
      sessionId: "sess-9",
      cwd: "/x/wt",
      command: expect.stringContaining("claude "),
    });
    expect(backend.setStepRun).toHaveBeenCalledWith("t1", "running", "sess-9", null);
    expect(backend.setPlanFrontmatterField).toHaveBeenCalledWith("/x/a.md", "status", "In Progress");
  });
});
```

- [ ] **Step 3: Run them and watch them fail**

Run: `cd app && npm test -- orchestrationState`
Expected: FAIL — `startRail is not a function`.

- [ ] **Step 4: Implement the controls and the executor**

Append to `app/src/lib/orchestrationState.ts`:

Merge these into the file's existing import block at the top — do not leave a second block, and note that `get` and the `Orchestration` type are already imported by Task 7:

```ts
import { nextActions, firstUnfinishedStageId, cardIndex } from "./orchestration";
import type { Action, Rail } from "./orchestration";
import { kanbanState, linkCardSessionAction } from "./kanbanState";
import { gavinTrees, patchPlanField } from "./gavinState";
import { gitStore } from "./gitState";
import { layoutState, resolvedAgentFor, createSessionOnPage } from "./layoutState";
import { allSessionIds } from "./layout";
import { composeTaskPrompt, composePlanPrompt, buildRunCommand, runStatusNeeded } from "./cardRun";
import { stripFrontmatter } from "./planChecklist";
```

Then append the implementation:

```ts

function railOwning(orch: Orchestration, stepId: string): Rail | null {
  return (
    orch.rails.find((r) => r.stages.some((s) => s.steps.some((t) => t.id === stepId))) ?? null
  );
}

export async function startRail(workspaceId: string, railId: string): Promise<void> {
  const orch = get(orchestrations)[workspaceId];
  const rail = orch?.rails.find((r) => r.id === railId);
  if (!rail) return;
  const stageId = firstUnfinishedStageId(rail, orch);
  if (!stageId) return;
  await setRailRunAction(workspaceId, railId, "running", stageId);
  await tick(workspaceId);
}

export async function pauseRail(workspaceId: string, railId: string): Promise<void> {
  const orch = get(orchestrations)[workspaceId];
  const current = orch?.railRuns.find((r) => r.railId === railId)?.currentStageId ?? null;
  await setRailRunAction(workspaceId, railId, "paused", current);
}

export async function resumeRail(workspaceId: string, railId: string): Promise<void> {
  const orch = get(orchestrations)[workspaceId];
  const rail = orch?.rails.find((r) => r.id === railId);
  if (!rail) return;
  const current = orch.railRuns.find((r) => r.railId === railId)?.currentStageId ?? null;
  await setRailRunAction(workspaceId, railId, "running", current ?? firstUnfinishedStageId(rail, orch));
  await tick(workspaceId);
}

/// Clears run state for the rail. Never touches card statuses -- the
/// board is the human's record, not the scheduler's scratch space.
export async function resetRail(workspaceId: string, railId: string): Promise<void> {
  const orch = get(orchestrations)[workspaceId];
  const rail = orch?.rails.find((r) => r.id === railId);
  if (!rail) return;
  for (const stage of rail.stages) {
    for (const step of stage.steps) {
      await setStepRunAction(workspaceId, step.id, "pending", null, null);
    }
  }
  await setRailRunAction(workspaceId, railId, "idle", null);
}

/// A stalled step returns to pending with its reason cleared; the next
/// tick re-reads the card and re-checks the worktree rather than
/// replaying the old command (spec §6.2).
export async function retryStep(workspaceId: string, stepId: string): Promise<void> {
  await setStepRunAction(workspaceId, stepId, "pending", null, null);
  await tick(workspaceId);
}

async function executeLaunch(workspaceId: string, stepId: string): Promise<void> {
  const orch = get(orchestrations)[workspaceId];
  const rail = railOwning(orch, stepId);
  const step = rail?.stages.flatMap((s) => s.steps).find((t) => t.id === stepId);
  if (!rail || !step) return;

  const entry = cardIndex(get(gavinTrees)[workspaceId]).get(step.cardPath);
  if (!entry) {
    await setStepRunAction(workspaceId, stepId, "stalled", null, "card file is missing");
    return;
  }

  let prompt: string;
  if (entry.plan.kind === "task") {
    const file = await backend.readFileForViewer(step.cardPath);
    if (!file.exists) {
      await setStepRunAction(workspaceId, stepId, "stalled", null, "card file is missing");
      return;
    }
    prompt = composeTaskPrompt(step.cardPath, entry.plan.title, stripFrontmatter(file.content).trim());
  } else {
    prompt = composePlanPrompt(step.cardPath);
  }

  const command = buildRunCommand(resolvedAgentFor(workspaceId).command, prompt);
  const cwd = rail.worktreePath ?? entry.contextFolder;
  const sessionId = await createSessionOnPage(workspaceId, rail.pageId, cwd, command);
  if (!sessionId) {
    await setStepRunAction(workspaceId, stepId, "stalled", null, "could not start the agent");
    return;
  }

  await linkCardSessionAction(workspaceId, { path: step.cardPath, sessionId, cwd, command });
  await setStepRunAction(workspaceId, stepId, "running", sessionId, null);
  if (runStatusNeeded(entry.plan.status)) {
    try {
      await backend.setPlanFrontmatterField(step.cardPath, "status", "In Progress");
      patchPlanField(workspaceId, step.cardPath, "status", "In Progress");
    } catch {
      // The agent is running; a failed status write is not worth
      // stalling the step over. The card's own agent will set it.
    }
  }
}

export async function executeActions(workspaceId: string, actions: Action[]): Promise<void> {
  for (const action of actions) {
    const orch = get(orchestrations)[workspaceId];
    if (!orch) return;
    if (action.kind === "launch") {
      await executeLaunch(workspaceId, action.stepId);
    } else if (action.kind === "markDone") {
      const sessionId = orch.stepRuns.find((r) => r.stepId === action.stepId)?.sessionId ?? null;
      // The session id is kept deliberately: the step is finished, but
      // its transcript stays reachable from the chip.
      await setStepRunAction(workspaceId, action.stepId, "done", sessionId, null);
    } else if (action.kind === "stall") {
      await setStepRunAction(workspaceId, action.stepId, "stalled", null, action.reason);
      const rail = railOwning(orch, action.stepId);
      if (rail) {
        const current = orch.railRuns.find((r) => r.railId === rail.id)?.currentStageId ?? null;
        await setRailRunAction(workspaceId, rail.id, "paused", current);
      }
    } else if (action.kind === "advance") {
      await setRailRunAction(workspaceId, action.railId, "running", action.stageId);
    } else {
      await setRailRunAction(workspaceId, action.railId, "idle", null);
    }
  }
}

// One tick at a time per workspace: executing an action mutates the very
// state the next nextActions call reads, so overlapping ticks would
// double-launch.
const ticking = new Set<string>();

export async function tick(workspaceId: string): Promise<void> {
  if (ticking.has(workspaceId)) return;
  ticking.add(workspaceId);
  try {
    const orch = get(orchestrations)[workspaceId];
    const board = get(kanbanState)[workspaceId];
    if (!orch || !board) return;
    const tree = get(gavinTrees)[workspaceId];
    // null, not [] -- an unloaded refs snapshot must not look like "every
    // worktree is gone" and stall every bound rail on a cold start.
    const worktrees = get(gitStore)[workspaceId]?.refs?.worktrees ?? null;
    const live = new Set<string>();
    for (const ws of get(layoutState).workspaces) {
      for (const page of ws.pages) for (const id of allSessionIds(page.layout)) live.add(id);
    }
    await executeActions(workspaceId, nextActions(orch, board, tree, worktrees, live));
  } finally {
    ticking.delete(workspaceId);
  }
}
```

`orchestrationState.ts` now imports from `layoutState.ts`, which does not import back — keep it that way; a cycle here would break the store's initialization order.

- [ ] **Step 5: Run the tests and watch them pass**

Run: `cd app && npm test -- orchestrationState`
Expected: PASS. Then `cd app && npm test` — the whole suite green.

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/layoutState.ts app/src/lib/orchestrationState.ts app/src/lib/orchestrationState.test.ts
git commit -m "feat(app): orchestration launch executor, rail controls and tick"
```

---

### Task 9: Plan mutators

**Files:**
- Modify: `app/src/lib/orchestration.ts`
- Modify: `app/src/lib/orchestration.test.ts`
- Modify: `app/src/lib/orchestrationState.ts`

**Interfaces:**
- Consumes: Task 5's types.
- Produces: pure `addRail`, `renameRail`, `bindRail`, `deleteRail`, `addStage`, `addStep`, `removeStep` on `Orchestration`; and the matching `*Action` wrappers in `orchestrationState.ts` that pass them to `mutatePlan`.

- [ ] **Step 1: Write the failing tests**

Append to `app/src/lib/orchestration.test.ts`:

```ts
import { addRail, renameRail, bindRail, deleteRail, addStage, addStep, removeStep } from "./orchestration";

describe("plan mutators", () => {
  it("adds a rail at the end and numbers positions from zero", () => {
    let o = addRail(emptyOrchestration(), "r1", "backend");
    o = addRail(o, "r2", "ui");
    expect(o.rails.map((r) => [r.id, r.position])).toEqual([
      ["r1", 0],
      ["r2", 1],
    ]);
  });

  it("renames and binds a rail without touching the others", () => {
    let o = addRail(addRail(emptyOrchestration(), "r1", "backend"), "r2", "ui");
    o = renameRail(o, "r1", "server");
    o = bindRail(o, "r1", { worktreePath: "/x/wt", pageId: "p1" });
    expect(o.rails[0]).toMatchObject({ name: "server", worktreePath: "/x/wt", pageId: "p1" });
    expect(o.rails[1]).toMatchObject({ name: "ui", worktreePath: null, pageId: null });
  });

  it("binds only the keys given", () => {
    let o = bindRail(addRail(emptyOrchestration(), "r1", "backend"), "r1", { worktreePath: "/x/wt" });
    o = bindRail(o, "r1", { pageId: "p1" });
    expect(o.rails[0]).toMatchObject({ worktreePath: "/x/wt", pageId: "p1" });
  });

  it("deletes a rail, renumbers the rest, and drops notes that named its steps", () => {
    let o = addRail(addRail(emptyOrchestration(), "r1", "backend"), "r2", "ui");
    o = addStep(addStage(o, "r1", "s1"), "s1", "t1", "/x/a.md");
    o = { ...o, conflictNotes: [{ id: "n1", stepIds: ["t1"], note: "careful" }] };
    o = deleteRail(o, "r1");
    expect(o.rails.map((r) => [r.id, r.position])).toEqual([["r2", 0]]);
    expect(o.conflictNotes).toEqual([]);
  });

  it("adds stages in order and steps within a stage in order", () => {
    let o = addRail(emptyOrchestration(), "r1", "backend");
    o = addStage(o, "r1", "s1");
    o = addStage(o, "r1", "s2");
    o = addStep(o, "s1", "t1", "/x/a.md");
    o = addStep(o, "s1", "t2", "/x/b.md");
    expect(o.rails[0].stages.map((s) => [s.id, s.position])).toEqual([
      ["s1", 0],
      ["s2", 1],
    ]);
    expect(o.rails[0].stages[0].steps.map((t) => [t.id, t.position])).toEqual([
      ["t1", 0],
      ["t2", 1],
    ]);
  });

  it("removes a step, renumbers its siblings, and drops a stage left empty", () => {
    let o = addStep(addStage(addRail(emptyOrchestration(), "r1", "backend"), "r1", "s1"), "s1", "t1", "/x/a.md");
    o = addStep(o, "s1", "t2", "/x/b.md");
    o = removeStep(o, "t1");
    expect(o.rails[0].stages[0].steps.map((t) => [t.id, t.position])).toEqual([["t2", 0]]);
    o = removeStep(o, "t2");
    expect(o.rails[0].stages).toEqual([]);
  });

  it("drops run state and notes for a removed step", () => {
    let o = addStep(addStage(addRail(emptyOrchestration(), "r1", "backend"), "r1", "s1"), "s1", "t1", "/x/a.md");
    o = {
      ...o,
      stepRuns: [{ stepId: "t1", state: "done", sessionId: null, reason: null }],
      conflictNotes: [{ id: "n1", stepIds: ["t1"], note: "careful" }],
    };
    o = removeStep(o, "t1");
    expect(o.stepRuns).toEqual([]);
    expect(o.conflictNotes).toEqual([]);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd app && npm test -- orchestration`
Expected: FAIL — `addRail is not a function`.

- [ ] **Step 3: Implement the mutators**

Append to `app/src/lib/orchestration.ts`:

```ts
// ---- Plan mutators ---------------------------------------------------------
// Pure and total, like kanban.ts's: every one returns a fresh
// Orchestration. orchestrationState.mutatePlan persists the result
// wholesale, so none of these needs to know about I/O.

function renumber<T extends { position: number }>(items: T[]): T[] {
  return items.map((item, i) => ({ ...item, position: i }));
}

/// Drops run state and conflict notes that name ids no longer in the
/// plan -- the client-side mirror of replace_plan's orphan sweep, so the
/// optimistic view matches what SQLite will hold.
function sweepOrphans(orch: Orchestration): Orchestration {
  const railIds = new Set(orch.rails.map((r) => r.id));
  const stepIds = new Set(
    orch.rails.flatMap((r) => r.stages.flatMap((s) => s.steps.map((t) => t.id)))
  );
  return {
    ...orch,
    railRuns: orch.railRuns.filter((r) => railIds.has(r.railId)),
    stepRuns: orch.stepRuns.filter((r) => stepIds.has(r.stepId)),
    conflictNotes: orch.conflictNotes.filter((n) => n.stepIds.every((id) => stepIds.has(id))),
  };
}

export function addRail(orch: Orchestration, railId: string, name: string): Orchestration {
  const rail: Rail = {
    id: railId,
    name,
    position: orch.rails.length,
    worktreePath: null,
    pageId: null,
    stages: [],
  };
  return { ...orch, rails: renumber([...orch.rails, rail]) };
}

export function renameRail(orch: Orchestration, railId: string, name: string): Orchestration {
  return { ...orch, rails: orch.rails.map((r) => (r.id === railId ? { ...r, name } : r)) };
}

/// Re-binding affects steps launched from now on; sessions already
/// running keep the cwd they were spawned with (spec §7).
export function bindRail(
  orch: Orchestration,
  railId: string,
  patch: { worktreePath?: string | null; pageId?: string | null }
): Orchestration {
  return {
    ...orch,
    rails: orch.rails.map((r) => (r.id === railId ? { ...r, ...patch } : r)),
  };
}

/// Never removes a worktree or a page -- those outlive the plan that
/// referenced them (spec §7).
export function deleteRail(orch: Orchestration, railId: string): Orchestration {
  return sweepOrphans({ ...orch, rails: renumber(orch.rails.filter((r) => r.id !== railId)) });
}

export function addStage(orch: Orchestration, railId: string, stageId: string): Orchestration {
  return {
    ...orch,
    rails: orch.rails.map((r) =>
      r.id === railId
        ? { ...r, stages: renumber([...r.stages, { id: stageId, position: r.stages.length, steps: [] }]) }
        : r
    ),
  };
}

export function addStep(
  orch: Orchestration,
  stageId: string,
  stepId: string,
  cardPath: string
): Orchestration {
  return {
    ...orch,
    rails: orch.rails.map((r) => ({
      ...r,
      stages: r.stages.map((s) =>
        s.id === stageId
          ? { ...s, steps: renumber([...s.steps, { id: stepId, position: s.steps.length, cardPath }]) }
          : s
      ),
    })),
  };
}

/// A stage left with no steps is removed: an empty stage is invisible in
/// the grid and would otherwise be a silent gap the scheduler steps over.
export function removeStep(orch: Orchestration, stepId: string): Orchestration {
  const rails = orch.rails.map((r) => ({
    ...r,
    stages: renumber(
      r.stages
        .map((s) => ({ ...s, steps: renumber(s.steps.filter((t) => t.id !== stepId)) }))
        .filter((s) => s.steps.length > 0)
    ),
  }));
  return sweepOrphans({ ...orch, rails });
}
```

- [ ] **Step 4: Add the action wrappers**

Append to `app/src/lib/orchestrationState.ts`:

```ts
import { addRail, renameRail, bindRail, deleteRail, addStage, addStep, removeStep } from "./orchestration";

export function addRailAction(workspaceId: string, name: string): Promise<void> {
  return mutatePlan(workspaceId, (o) => addRail(o, crypto.randomUUID(), name));
}

export function renameRailAction(workspaceId: string, railId: string, name: string): Promise<void> {
  return mutatePlan(workspaceId, (o) => renameRail(o, railId, name));
}

export function bindRailAction(
  workspaceId: string,
  railId: string,
  patch: { worktreePath?: string | null; pageId?: string | null }
): Promise<void> {
  return mutatePlan(workspaceId, (o) => bindRail(o, railId, patch));
}

export function deleteRailAction(workspaceId: string, railId: string): Promise<void> {
  return mutatePlan(workspaceId, (o) => deleteRail(o, railId));
}

/// Adds the card as its OWN new stage -- a sequential beat, the safe
/// default. Parallel is the deliberate act of dropping onto an existing
/// stage (SP2).
export function addStepAsStageAction(workspaceId: string, railId: string, cardPath: string): Promise<void> {
  return mutatePlan(workspaceId, (o) => {
    const stageId = crypto.randomUUID();
    return addStep(addStage(o, railId, stageId), stageId, crypto.randomUUID(), cardPath);
  });
}

export function addStepToStageAction(
  workspaceId: string,
  stageId: string,
  cardPath: string
): Promise<void> {
  return mutatePlan(workspaceId, (o) => addStep(o, stageId, crypto.randomUUID(), cardPath));
}

export function removeStepAction(workspaceId: string, stepId: string): Promise<void> {
  return mutatePlan(workspaceId, (o) => removeStep(o, stepId));
}
```

- [ ] **Step 5: Run the tests and watch them pass**

Run: `cd app && npm test`
Expected: PASS — whole suite.

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/orchestration.ts app/src/lib/orchestration.test.ts app/src/lib/orchestrationState.ts
git commit -m "feat(app): orchestration plan mutators for rails, stages and steps"
```

---

### Task 10: The tab

**Files:**
- Create: `app/src/lib/OrchestrationStepChip.svelte`
- Create: `app/src/lib/OrchestrationRail.svelte`
- Create: `app/src/lib/OrchestrationHubView.svelte`
- Modify: `app/src/lib/workspaceViews.ts`

**Interfaces:**
- Consumes: everything from Tasks 5–9.
- Produces: the `orchestration` hub view.

This project's convention is that Svelte components carry no unit tests — their logic already lives in `orchestration.ts` and `orchestrationState.ts`. Verification here is `npm run check` plus the manual smoke at the end.

- [ ] **Step 1: The step chip**

Create `app/src/lib/OrchestrationStepChip.svelte`:

```svelte
<script lang="ts">
  import { FileText, ListChecks, StickyNote, Check, CircleAlert, RotateCw, X } from "@lucide/svelte";
  import Tooltip from "./Tooltip.svelte";
  import { tooltip } from "./tooltip";
  import IconButton from "./ui/IconButton.svelte";
  import type { CardEntry, StepState } from "./orchestration";

  interface Props {
    cardPath: string;
    entry: CardEntry | undefined;
    state: StepState;
    reason: string | null;
    onRetry: () => void;
    onRemove: () => void;
  }
  let { cardPath, entry, state, reason, onRetry, onRemove }: Props = $props();

  const title = $derived(entry?.plan.title ?? cardPath.split("/").pop() ?? cardPath);
  const kind = $derived(entry?.plan.kind ?? "task");
  const Icon = $derived(kind === "plan" ? ListChecks : kind === "note" ? StickyNote : FileText);
</script>

<div class="chip {state}" use:tooltip={state === "stalled" && reason ? reason : undefined}>
  <Icon size={13} class="kind" />
  <span class="title">{title}</span>
  {#if entry && entry.plan.checklistTotal > 0}
    <span class="checklist">{entry.plan.checklistDone}/{entry.plan.checklistTotal}</span>
  {/if}
  {#if state === "done"}<Check size={13} class="mark done-mark" />{/if}
  {#if state === "stalled"}
    <CircleAlert size={13} class="mark stall-mark" />
    <IconButton icon={RotateCw} label="Retry" size={13} onclick={onRetry} />
  {/if}
  <IconButton icon={X} label="Remove from rail" size={13} onclick={onRemove} />
</div>

<style>
  .chip {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 8px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface-raised);
    color: var(--text);
    font-size: 12px;
    min-width: 0;
  }
  .title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .checklist {
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }
  /* Run state is a ring, so SP2's conflict colouring owns the fill. */
  .chip.running {
    border-color: var(--border-focus);
    box-shadow: 0 0 0 1px var(--border-focus);
  }
  .chip.done {
    border-color: var(--border-success);
    color: var(--text-muted);
  }
  .chip.stalled {
    border-color: var(--border-danger);
    background: var(--surface-danger);
  }
</style>
```

If `IconButton`'s prop names differ, read `app/src/lib/ui/IconButton.svelte` and match them — it was introduced in commit `040ecf8` and is the house primitive for icon-only buttons.

- [ ] **Step 2: The rail column**

Create `app/src/lib/OrchestrationRail.svelte`:

```svelte
<script lang="ts">
  import { Play, Pause, RotateCcw, Trash2, Plus } from "@lucide/svelte";
  import IconButton from "./ui/IconButton.svelte";
  import OrchestrationStepChip from "./OrchestrationStepChip.svelte";
  import type { CardEntry, Orchestration, Rail } from "./orchestration";
  import { railStateOf, stepStateOf } from "./orchestration";

  interface Props {
    rail: Rail;
    orch: Orchestration;
    cards: Map<string, CardEntry>;
    doneColumnName: string | null;
    onStart: () => void;
    onPause: () => void;
    onReset: () => void;
    onDelete: () => void;
    onBind: (patch: { worktreePath?: string | null; pageId?: string | null }) => void;
    onAddStep: () => void;
    onRetryStep: (stepId: string) => void;
    onRemoveStep: (stepId: string) => void;
  }
  let {
    rail,
    orch,
    cards,
    doneColumnName,
    onStart,
    onPause,
    onReset,
    onDelete,
    onBind,
    onAddStep,
    onRetryStep,
    onRemoveStep,
  }: Props = $props();

  const state = $derived(railStateOf(orch, rail.id));
  const stages = $derived([...rail.stages].sort((a, b) => a.position - b.position));
  const runOf = $derived((id: string) => orch.stepRuns.find((r) => r.stepId === id) ?? null);
</script>

<div class="rail" style="grid-row: 1 / span {stages.length + 1}">
  <header>
    <div class="name-row">
      <span class="name">{rail.name}</span>
      <span class="state {state}">{state}</span>
      {#if state === "running"}
        <IconButton icon={Pause} label="Pause" onclick={onPause} />
      {:else}
        <IconButton icon={Play} label={state === "paused" ? "Resume" : "Start"} onclick={onStart} />
      {/if}
      <IconButton icon={RotateCcw} label="Reset run state" onclick={onReset} />
      <IconButton icon={Trash2} label="Delete rail" onclick={onDelete} />
    </div>
    <!-- SP1 binds with plain inputs; SP2 replaces these with the fork
         dialog and a page picker. -->
    <label class="bind">
      worktree
      <input
        value={rail.worktreePath ?? ""}
        placeholder="(the card's own folder)"
        onchange={(e) => onBind({ worktreePath: e.currentTarget.value.trim() || null })}
      />
    </label>
    <label class="bind">
      page id
      <input
        value={rail.pageId ?? ""}
        placeholder="(the Agents page)"
        onchange={(e) => onBind({ pageId: e.currentTarget.value.trim() || null })}
      />
    </label>
    {#if !doneColumnName}
      <p class="warn">This board has no columns — nothing can complete.</p>
    {/if}
  </header>

  {#each stages as stage, i (stage.id)}
    <section class="stage" class:parallel={stage.steps.length > 1}>
      {#if stage.steps.length > 1}<span class="stage-label">stage {i + 1} — parallel</span>{/if}
      <div class="steps">
        {#each [...stage.steps].sort((a, b) => a.position - b.position) as step (step.id)}
          <OrchestrationStepChip
            cardPath={step.cardPath}
            entry={cards.get(step.cardPath)}
            state={stepStateOf(orch, step.id)}
            reason={runOf(step.id)?.reason ?? null}
            onRetry={() => onRetryStep(step.id)}
            onRemove={() => onRemoveStep(step.id)}
          />
        {/each}
      </div>
    </section>
  {/each}

  <button type="button" class="add-step" onclick={onAddStep}>
    <Plus size={13} /> Add step
  </button>
</div>

<style>
  .rail {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 280px;
    padding: 8px;
    border-right: 1px solid var(--border);
  }
  header {
    position: sticky;
    top: 0;
    z-index: 1;
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding-bottom: 6px;
    background: var(--surface-base);
    border-bottom: 1px solid var(--border);
  }
  .name-row {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 600;
  }
  .state {
    font-size: 11px;
    color: var(--text-muted);
  }
  .state.running {
    color: var(--accent-text);
  }
  .state.paused {
    color: var(--warning-text);
  }
  .bind {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    color: var(--text-muted);
  }
  .bind input {
    flex: 1;
    min-width: 0;
    background: var(--surface-sunken);
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text);
    padding: 2px 4px;
    font-size: 11px;
  }
  .warn {
    margin: 0;
    font-size: 11px;
    color: var(--warning-text);
  }
  .stage.parallel {
    border: 1px dashed var(--border-strong);
    border-radius: 8px;
    padding: 6px;
  }
  .stage-label {
    font-size: 11px;
    color: var(--text-subtle);
  }
  .steps {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .stage.parallel .steps {
    flex-direction: row;
    flex-wrap: wrap;
  }
  .stage.parallel .steps > :global(*) {
    flex: 1 1 120px;
  }
  .add-step {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    padding: 6px;
    background: none;
    border: 1px dashed var(--border);
    border-radius: 6px;
    color: var(--text-muted);
    font-size: 12px;
    cursor: pointer;
  }
  .add-step:hover {
    background: var(--surface-hover);
    color: var(--text);
  }
</style>
```

- [ ] **Step 3: The hub view**

Create `app/src/lib/OrchestrationHubView.svelte`:

```svelte
<script lang="ts">
  import { Plus } from "@lucide/svelte";
  import OrchestrationRail from "./OrchestrationRail.svelte";
  import Modal from "./Modal.svelte";
  import { gavinTrees } from "./gavinState";
  import { fetchBoard, kanbanState } from "./kanbanState";
  import { gitStore, ensureGitView, refresh as refreshGit } from "./gitState";
  import { layoutState } from "./layoutState";
  import { cardIndex, doneColumn } from "./orchestration";
  import {
    orchestrations,
    fetchOrchestration,
    refreshOrchestration,
    saveErrors,
    dismissSaveError,
    addRailAction,
    bindRailAction,
    deleteRailAction,
    addStepAsStageAction,
    removeStepAction,
    startRail,
    pauseRail,
    resumeRail,
    resetRail,
    retryStep,
    tick,
  } from "./orchestrationState";

  interface Props {
    workspaceId: string;
  }
  let { workspaceId }: Props = $props();

  const ws = $derived($layoutState.workspaces.find((w) => w.id === workspaceId) ?? null);
  const root = $derived(ws?.rootPath ?? null);
  const orch = $derived($orchestrations[workspaceId] ?? null);
  const board = $derived($kanbanState[workspaceId] ?? null);
  const tree = $derived($gavinTrees[workspaceId]);
  const cards = $derived(cardIndex(tree));
  const doneName = $derived(board ? (doneColumn(board)?.name ?? null) : null);
  const rails = $derived([...(orch?.rails ?? [])].sort((a, b) => a.position - b.position));

  let picking = $state<string | null>(null);

  // The unplaced cards a rail can take on: every runnable card not
  // already on a rail.
  const placed = $derived(
    new Set((orch?.rails ?? []).flatMap((r) => r.stages.flatMap((s) => s.steps.map((t) => t.cardPath))))
  );
  const available = $derived(
    [...cards.values()].filter((e) => e.plan.kind !== "note" && !placed.has(e.plan.path))
  );

  $effect(() => {
    void fetchOrchestration(workspaceId);
    void fetchBoard(workspaceId);
    void refreshOrchestration(workspaceId);
    if (root) {
      ensureGitView(workspaceId, root);
      void refreshGit(workspaceId);
    }
  });

  // Re-tick whenever anything the scheduler reads changes: card statuses
  // arrive on gavin-tree-changed pushes, sessions come and go in the
  // layout, and the board decides what "done" means.
  $effect(() => {
    void $gavinTrees[workspaceId];
    void $layoutState.workspaces;
    void $kanbanState[workspaceId];
    void tick(workspaceId);
  });
</script>

<div class="view">
  <header class="bar">
    <h2>Orchestration</h2>
    <button type="button" class="add-rail" onclick={() => void addRailAction(workspaceId, "New rail")}>
      <Plus size={14} /> Rail
    </button>
  </header>

  {#if $saveErrors[workspaceId]}
    <div class="save-error">
      <span>{$saveErrors[workspaceId]}</span>
      <button type="button" onclick={() => dismissSaveError(workspaceId)}>Dismiss</button>
    </div>
  {/if}

  {#if !orch}
    <p class="empty">Loading…</p>
  {:else if rails.length === 0}
    <p class="empty">
      No rails yet. A rail is a column of stages over your cards — add one, then add steps to it.
    </p>
  {:else}
    <div class="grid">
      {#each rails as rail (rail.id)}
        <OrchestrationRail
          {rail}
          {orch}
          {cards}
          doneColumnName={doneName}
          onStart={() =>
            void (orch.railRuns.find((r) => r.railId === rail.id)?.state === "paused"
              ? resumeRail(workspaceId, rail.id)
              : startRail(workspaceId, rail.id))}
          onPause={() => void pauseRail(workspaceId, rail.id)}
          onReset={() => void resetRail(workspaceId, rail.id)}
          onDelete={() => void deleteRailAction(workspaceId, rail.id)}
          onBind={(patch) => void bindRailAction(workspaceId, rail.id, patch)}
          onAddStep={() => (picking = rail.id)}
          onRetryStep={(stepId) => void retryStep(workspaceId, stepId)}
          onRemoveStep={(stepId) => void removeStepAction(workspaceId, stepId)}
        />
      {/each}
    </div>
  {/if}
</div>

{#if picking}
  <Modal onClose={() => (picking = null)}>
    <h3>Add a step</h3>
    {#if available.length === 0}
      <p class="empty">Every runnable card is already on a rail.</p>
    {:else}
      <ul class="picker">
        {#each available as entry (entry.plan.path)}
          <li>
            <button
              type="button"
              onclick={() => {
                void addStepAsStageAction(workspaceId, picking!, entry.plan.path);
                picking = null;
              }}
            >
              <span class="pick-title">{entry.plan.title}</span>
              <span class="pick-kind">{entry.plan.kind}</span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </Modal>
{/if}

<style>
  .view {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    background: var(--surface-base);
    color: var(--text);
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
  }
  h2 {
    flex: 1;
    margin: 0;
    font-size: 14px;
    font-weight: 600;
  }
  .add-rail {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 8px;
    background: var(--surface-raised);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text);
    font-size: 12px;
    cursor: pointer;
  }
  .add-rail:hover {
    background: var(--surface-hover);
  }
  .save-error {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    background: var(--surface-danger);
    border-bottom: 1px solid var(--border-danger);
    color: var(--danger-text);
    font-size: 12px;
  }
  .save-error button {
    margin-left: auto;
    background: none;
    border: none;
    color: inherit;
    text-decoration: underline;
    cursor: pointer;
  }
  .empty {
    padding: 16px 12px;
    margin: 0;
    color: var(--text-muted);
    font-size: 13px;
  }
  /* Rails are grid columns and stage index is the row track, so a
     horizontal band across the grid reads as roughly concurrent
     (orchestration spec O8). */
  .grid {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-auto-flow: column;
    grid-auto-columns: minmax(280px, 1fr);
    overflow: auto;
    align-items: start;
  }
  .picker {
    list-style: none;
    margin: 0;
    padding: 0;
    max-height: 50vh;
    overflow-y: auto;
  }
  .picker button {
    display: flex;
    width: 100%;
    gap: 8px;
    padding: 6px 8px;
    background: none;
    border: none;
    color: var(--text);
    font-size: 13px;
    text-align: left;
    cursor: pointer;
  }
  .picker button:hover {
    background: var(--surface-hover);
  }
  .pick-title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .pick-kind {
    color: var(--text-subtle);
    font-size: 11px;
  }
</style>
```

If `Modal.svelte`'s prop is named something other than `onClose`, read it and match.

- [ ] **Step 4: Register the tab**

In `app/src/lib/workspaceViews.ts`: add `Waypoints` to the `@lucide/svelte` import, add `import OrchestrationHubView from "./OrchestrationHubView.svelte";`, and insert into `HUB_VIEWS` directly after the `kanban` entry:

```ts
  {
    id: "orchestration",
    label: "Orchestration",
    icon: Waypoints,
    component: OrchestrationHubView,
    requiresRoot: true,
  },
```

- [ ] **Step 5: Type check and run the suite**

Run: `cd app && npm run check && npm test`
Expected: no type errors; whole suite green.

- [ ] **Step 6: Manual smoke**

Run the app (`cd app && npm run tauri dev`). In a rooted workspace:

1. Open the **Orchestration** tab; confirm the empty state.
2. Add a rail; confirm it persists across a tab switch and an app restart.
3. Add two steps to it (each lands as its own stage).
4. Press **Start**; confirm a session spawns with the card's prompt, the card goes to *In Progress*, and the chip shows the running ring.
5. In that session, set the card to *Done* (`gavin_set_plan_field`); confirm the chip turns done and the rail advances to the second stage on its own.
6. Quit the second agent without finishing its card; confirm the chip stalls with the reason and the rail pauses.
7. Press **Retry**, then **Start/Resume**; confirm it relaunches.
8. Point a rail's worktree field at a path that does not exist; confirm Start stalls rather than spawning into the wrong cwd.
9. Restart reconciliation (spec §4.4): with a step running, quit and reopen the app. The daemon-hosted session survives, so the chip should still read running. Then close that session's tab and confirm the next tick stalls the step rather than waiting forever.

- [ ] **Step 7: Commit**

```bash
git add app/src/lib/OrchestrationHubView.svelte app/src/lib/OrchestrationRail.svelte \
        app/src/lib/OrchestrationStepChip.svelte app/src/lib/workspaceViews.ts
git commit -m "feat(app): Orchestration tab with rails, stages and run controls"
```

- [ ] **Step 8: Close out the card**

Tick every checklist item on `.gavin-root/plans/orchestration-rails-that-run.md` and set its status:

```
gavin_set_plan_field(".gavin-root/plans/orchestration-rails-that-run.md", "status", "Done")
```

```bash
git add .gavin-root/plans/orchestration-rails-that-run.md
git commit -m "docs(plan): orchestration SP1 complete"
```

---

## What SP1 deliberately leaves undone

Named here so a reviewer does not read them as gaps:

- **Conflicts.** `detectConflicts`, the Conflicts box, severity colouring and number badges — SP2. The step chip's run-state ring deliberately uses `border`/`box-shadow` only, leaving the chip's *fill* free for SP2's severity colour.
- **Drag.** Steps are added through the picker and always as their own stage. Building a parallel stage by dropping onto an existing one is SP2; until then a multi-step stage can only be produced by the MCP tool or by hand.
- **Real binding UI.** Worktree and page are plain text inputs. The fork dialog and page picker are SP2.
- **The agent surface.** `GitDirtyPaths`, both MCP tools, the `OrchestrationChanged` push, the skill file and the Reorganize button — SP3. Until then, an agent's plan edit needs a tab remount to show up.
