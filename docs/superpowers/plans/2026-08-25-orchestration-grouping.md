# Orchestration Grouping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dropping a step onto another forms a named, movable **sequential group** that can be flipped to parallel and saved as a workspace or global **template**.

**Architecture:** A group is a `Stage` that gained `mode` (`"sequence" | "parallel"`) and `name` — no new nesting level, because a stage is already an ordered set of steps that moves as a unit. The scheduler runs a `sequence` stage one member at a time; the conflict detector stops calling such a stage a same-worktree collision. Templates are a separate targeted store mirroring the tool library exactly (upsert/delete by id, `workspace_id: NULL` = global).

**Tech Stack:** Rust (protocol crate, daemon, Tauri host, gavin-mcp), SvelteKit + Svelte 5 runes, vitest, rusqlite/SQLite.

**Spec:** `docs/superpowers/specs/2026-08-25-orchestration-grouping-design.md` — read it first; every task below argues from a G-number in it.

## Global Constraints

- **`PROTOCOL_VERSION` becomes 15.** `MIN_COMPATIBLE_VERSION` stays `5`.
- **`mode` defaults to `"parallel"`** everywhere it can be absent — the wire (`serde(default = …)`), SQLite (`NULL`), and the app (`stageMode`). Any value that is neither `"sequence"` nor `"parallel"` also reads as `"parallel"`. (G2)
- **New single-step stages are written `mode: "sequence"`.** A single-step stage runs identically either way; this makes the *next* drop mean what it says. (§1.3)
- **`FEATURE_MIN_VERSION.groups = 15` is not enough on its own.** `mode`/`name` widen an existing request, so `min_version_for` is blind to them. Every surface that can form or change a group owes a `featureBlockedReason(compat, "groups")` consumer. (G9, spec §6)
- **Never attribute work to Claude/an LLM/an agent** in commit messages, bodies, comments or docs. Write as the human author: `type(scope): imperative summary`, then a body explaining *why*. No `Co-Authored-By`, no session URLs, no generated-with footers.
- **Commit only the files the task names.** The working tree is shared with other sessions — never `git add -A`, never `git stash`.
- **Never `pkill gavin-daemon`.** To exercise daemon behaviour, run an isolated daemon under a temp `$HOME`.
- Checks: `cargo test --workspace`, and in `app/`: `npm test && npm run check && npm run build`. The daemon's `gavin::tests` are flaky under full-suite cargo parallelism — re-run that module alone before calling a failure a regression.

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `crates/protocol/src/lib.rs` | `StageMode`, `Stage.mode`/`.name`, `GroupTemplate`, 3 requests, `min_version_for` | 1, 10 |
| `crates/daemon/src/orchestration.rs` | `orch_stages` columns; `orch_group_templates` table + CRUD | 2, 10 |
| `crates/daemon/src/server.rs` | Manager wrappers + `handle_request` arms for the 3 requests | 10 |
| `app/src/lib/daemonCompat.ts` | `FEATURE_MIN_VERSION.groups` | 3 |
| `app/src/lib/orchestration.ts` | `stageMode`, `isGroup`, group mutators, sequential scheduling, conflict exemption | 4, 5, 6 |
| `app/src/lib/orchestrationState.ts` | Actions that persist the mutators | 7 |
| `app/src/lib/orchestrationDrag.ts` | Indexed `into-stage`, `"stage"` and `"template"` drag kinds | 8 |
| `app/src/lib/orchestrationDragGlue.ts` | Member-rect measurement, stage-handle pointerdown | 8 |
| `app/src/lib/OrchestrationRail.svelte` | Group header, mode toggle, rename, ⋯ menu | 9 |
| `app/src/lib/OrchestrationHubView.svelte` | Drag commit wiring, compat gating, dialog hosting | 9, 12 |
| `app/src/lib/OrchestrationConflicts.svelte` | Repair copy | 6 |
| `app/src/lib/orchestrationGroups.ts` (**new**) | Template types, scope derivation, group↔template conversion | 11 |
| `app/src/lib/groupTemplatesState.ts` (**new**) | Template store + persistence | 11 |
| `app/src/lib/backend.ts`, `app/src-tauri/src/session.rs`, `app/src-tauri/src/lib.rs` | Template bridge | 11 |
| `app/src/lib/OrchestrationDrawer.svelte` | Groups section | 12 |
| `app/src/lib/GroupTemplateSaveDialog.svelte` (**new**) | Save-as-template form | 12 |
| `app/src/lib/ToolLibraryDialog.svelte` | Second tab managing templates | 12 |
| `crates/gavin-mcp/src/main.rs` | `mode`/`name` in get + set orchestration | 13 |
| `app/src/lib/smokeChecklist.ts` | Manual pass items | 13 |

---

### Task 1: `Stage` gains `mode` and `name`

**Files:**
- Modify: `crates/protocol/src/lib.rs:20` (`PROTOCOL_VERSION`), `:598-608` (`Stage`)
- Test: `crates/protocol/src/lib.rs` (the existing `#[cfg(test)] mod tests`)

**Interfaces:**
- Consumes: nothing.
- Produces: `protocol::StageMode` (= `String`), `protocol::Stage { id, position, mode: StageMode, name: Option<String>, steps }`, `protocol::default_stage_mode() -> StageMode`, `PROTOCOL_VERSION == 15`.

- [ ] **Step 1: Write the failing tests**

Add to the `tests` module in `crates/protocol/src/lib.rs`:

```rust
#[test]
fn a_stage_without_a_mode_deserialises_as_parallel() {
    // Every stage written before groups existed omits the field. It must
    // read as the discipline it actually ran under, never as "".
    let s: Stage = serde_json::from_str(
        r#"{"id":"s1","position":0,"steps":[]}"#,
    )
    .unwrap();
    assert_eq!(s.mode, "parallel");
    assert_eq!(s.name, None);
}

#[test]
fn a_stage_round_trips_its_mode_and_name() {
    let s = Stage {
        id: "s1".into(),
        position: 0,
        mode: "sequence".into(),
        name: Some("Merge and push".into()),
        steps: vec![],
    };
    let back: Stage = serde_json::from_str(&serde_json::to_string(&s).unwrap()).unwrap();
    assert_eq!(back, s);
}

#[test]
fn stage_mode_is_camel_case_on_the_wire() {
    let json = serde_json::to_string(&Stage {
        id: "s1".into(),
        position: 0,
        mode: "sequence".into(),
        name: None,
        steps: vec![],
    })
    .unwrap();
    assert!(json.contains(r#""mode":"sequence""#), "{json}");
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p protocol stage`
Expected: FAIL — `Stage` has no field `mode`.

- [ ] **Step 3: Add the fields**

In `crates/protocol/src/lib.rs`, above `struct Stage`:

```rust
/// How a stage's steps run: "sequence" (one at a time, in position
/// order) or "parallel" (all at once, in the same checkout). A String
/// rather than an enum for the same reason ToolKind is: the daemon only
/// stores and returns it, and widening the vocabulary must not become a
/// wire break.
pub type StageMode = String;

/// Serde's own String default is "", which reads as NEITHER mode. Every
/// stage written before groups existed omits the field, and it must come
/// back as the discipline it actually ran under.
pub fn default_stage_mode() -> StageMode {
    "parallel".into()
}
```

Then replace the struct:

```rust
/// Stages run one after another. A `parallel` stage's steps run at the
/// same time in the SAME checkout, since they share the rail's worktree;
/// a `sequence` stage's run one at a time (grouping spec G4). A stage
/// holding two or more steps is what the app calls a GROUP.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Stage {
    pub id: String,
    pub position: i64,
    #[serde(default = "default_stage_mode")]
    pub mode: StageMode,
    /// The group's name. None renders as the positional label.
    #[serde(default)]
    pub name: Option<String>,
    pub steps: Vec<Step>,
}
```

Bump the version constant and its doc comment:

```rust
/// v15 widened `Stage` with `mode` and `name` (grouping spec G1). Both are
/// `serde(default)`, so no Request variant changed and `min_version_for`
/// is untouched -- the gate that matters is the app's
/// FEATURE_MIN_VERSION.groups, because a v14 daemon parses the request
/// fine and then drops both fields on the floor.
pub const PROTOCOL_VERSION: u32 = 15;
```

- [ ] **Step 4: Fix every construction site**

`Stage` is constructed literally in tests across the workspace. Build and let the compiler enumerate them; add `mode: default_stage_mode(), name: None` to each:

Run: `cargo build --workspace --tests 2>&1 | grep -c "missing field"`
Then fix each site reported by `cargo build --workspace --tests`.

Known sites: `crates/daemon/src/orchestration.rs`, `crates/daemon/src/server.rs`, `crates/gavin-mcp/src/main.rs`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cargo test -p protocol`
Expected: PASS, including the pre-existing `min_version_for` exhaustiveness tests (no Request variant changed).

- [ ] **Step 6: Commit**

```bash
git add crates/protocol/src/lib.rs crates/daemon/src/orchestration.rs crates/daemon/src/server.rs crates/gavin-mcp/src/main.rs
git commit -m "$(cat <<'MSG'
feat(protocol): a stage carries how its steps run

A rail could express "these run at once" and "these run in order" only
by the shape of its stages, so there was no way to say "these two run in
this order, as one unit I can move". A stage gains `mode` and an
optional `name`: the same container, now able to describe its own
discipline.

`mode` defaults to `parallel` rather than to serde's empty String, so
every stage already on disk reads back as the discipline it actually ran
under. Both fields are serde-defaulted, so no request variant changed
and min_version_for stays untouched -- which is precisely why the app
owes this a gate of its own.
MSG
)"
```

---

### Task 2: The daemon stores `mode` and `name`

**Files:**
- Modify: `crates/daemon/src/orchestration.rs:24-27` (schema), `:74-76` (migration), `:101-106` (read), `:312-316` (write)
- Test: `crates/daemon/src/orchestration.rs` (`#[cfg(test)] mod tests`)

**Interfaces:**
- Consumes: `protocol::Stage { mode, name }`, `protocol::default_stage_mode()` from Task 1.
- Produces: an `OrchestrationStore` that round-trips both fields, and reads a pre-v15 row as `mode == "parallel"`, `name == None`.

- [ ] **Step 1: Write the failing tests**

Add to the tests module in `crates/daemon/src/orchestration.rs` (use the file's existing store-construction helper; `replace_plan` + `get` is the shape every other test there uses):

```rust
#[test]
fn replace_plan_round_trips_stage_mode_and_name() {
    let mut s = store();
    let mut rail = a_rail();
    rail.stages[0].mode = "sequence".into();
    rail.stages[0].name = Some("Merge and push".into());
    s.replace_plan("ws-1", vec![rail], vec![]).unwrap();
    let o = s.get("ws-1").unwrap();
    assert_eq!(o.rails[0].stages[0].mode, "sequence");
    assert_eq!(o.rails[0].stages[0].name.as_deref(), Some("Merge and push"));
}

#[test]
fn a_stage_row_written_before_v15_reads_as_parallel() {
    // The columns are added by migration, so an existing row has NULL in
    // both. NULL must read as the discipline that row actually ran under.
    let mut s = store();
    s.replace_plan("ws-1", vec![a_rail()], vec![]).unwrap();
    let stage_id = s.get("ws-1").unwrap().rails[0].stages[0].id.clone();
    s.conn
        .execute(
            "UPDATE orch_stages SET mode = NULL, name = NULL WHERE id = ?1",
            rusqlite::params![stage_id],
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
    s.replace_plan("ws-1", vec![a_rail()], vec![]).unwrap();
    let stage_id = s.get("ws-1").unwrap().rails[0].stages[0].id.clone();
    s.conn
        .execute(
            "UPDATE orch_stages SET mode = 'lockstep' WHERE id = ?1",
            rusqlite::params![stage_id],
        )
        .unwrap();
    assert_eq!(s.get("ws-1").unwrap().rails[0].stages[0].mode, "parallel");
}
```

If the tests module has no `store()` / `a_rail()` helper under those names, reuse whatever it already uses (see the existing `replace_plan_round_trips_rails_stages_and_steps` at `:584`) and keep the assertions identical. Make `conn` reachable from the tests (it is a private field in the same module, so `s.conn` compiles).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p gavin-daemon --lib orchestration::tests::`
Expected: FAIL — `no such column: mode`.

- [ ] **Step 3: Migrate, read and write the columns**

Add the columns next to the existing `orch_steps` migration (`:74`):

```rust
        // orch_stages predates groups and is already live on disk, so the
        // CREATE TABLE above would silently keep the old shape.
        add_column_if_missing(&conn, "orch_stages", "mode", "TEXT")?;
        add_column_if_missing(&conn, "orch_stages", "name", "TEXT")?;
```

Leave the `CREATE TABLE IF NOT EXISTS orch_stages` statement alone — the migration is what creates the columns on both fresh and existing databases, and having one owner for their shape is the point.

Replace the stage read (`:101-106`):

```rust
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
```

Replace the stage write (`:312-316`):

```rust
            for stage in &rail.stages {
                self.conn.execute(
                    "INSERT INTO orch_stages (id, rail_id, position, mode, name)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![stage.id, rail.id, stage.position, stage.mode, stage.name],
                )?;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p gavin-daemon --lib orchestration::tests::`
Expected: PASS.

- [ ] **Step 5: Run the whole workspace**

Run: `cargo test --workspace`
Expected: PASS. If `gavin::tests` fails, re-run it alone (`cargo test -p gavin-daemon --lib gavin::tests`) before treating it as a regression — that module is flaky under full-suite parallelism.

- [ ] **Step 6: Commit**

```bash
git add crates/daemon/src/orchestration.rs
git commit -m "$(cat <<'MSG'
feat(daemon): persist a stage's mode and name

orch_stages is already live on disk, so CREATE TABLE IF NOT EXISTS would
have kept the old shape silently; the columns are added by the same
idempotent migration orch_steps.tool_id uses.

The read maps NULL and any unrecognised value to `parallel` rather than
propagating it. A stage row predating groups genuinely ran in parallel,
and an unknown discipline degrading to that beats a strict parse that
drops an entire workspace's rails over one hand-edited cell.
MSG
)"
```

---

### Task 3: The compat gate

**Files:**
- Modify: `app/src/lib/daemonCompat.ts:23-42`
- Test: `app/src/lib/daemonCompat.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `FEATURE_MIN_VERSION.groups === 15`; `featureBlockedReason(compat, "groups")` returns a string against a daemon below 15 and `null` at or above it.

- [ ] **Step 1: Write the failing test**

Add to `app/src/lib/daemonCompat.test.ts`:

```ts
describe("the groups gate", () => {
  it("blocks grouping on a daemon that would drop the mode", () => {
    // A v14 daemon parses SetOrchestration perfectly and has no `mode`
    // column: it accepts a sequential group and returns it parallel. The
    // wire gate cannot see a widened request, so this is the only gate.
    const c = { daemonVersion: 14, appVersion: 15, degraded: true };
    expect(featureBlockedReason(c, "groups")).toContain("v15");
  });

  it("allows grouping on a v15 daemon", () => {
    expect(featureBlockedReason({ daemonVersion: 15, appVersion: 15, degraded: false }, "groups")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd app && npx vitest run src/lib/daemonCompat.test.ts`
Expected: FAIL — `"groups"` is not assignable to `Feature`.

- [ ] **Step 3: Add the entry**

In `app/src/lib/daemonCompat.ts`, inside `FEATURE_MIN_VERSION`, after `agentModel: 14,`:

```ts
  // Groups: a stage's `mode` and `name`. A v14 daemon has neither column
  // on orch_stages, so it accepts a sequential group, drops both fields
  // and hands the stage back parallel -- the group silently runs its
  // members all at once in one checkout. `mode` widens an EXISTING
  // request, so min_version_for is structurally blind to it and this
  // entry is the only gate there is. Every surface that can form or
  // change a group reads it through featureBlockedReason.
  groups: 15,
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd app && npx vitest run src/lib/daemonCompat.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/daemonCompat.ts app/src/lib/daemonCompat.test.ts
git commit -m "$(cat <<'MSG'
feat(app): gate grouping on a daemon that can store it

`mode` and `name` widen SetOrchestration rather than adding a request,
and the wire gate keys on request TYPE -- so nothing on that path can
notice them. Against a v14 daemon a sequential group would save, come
back parallel, and run its members at once in one checkout.

The entry alone is a dead gate; the surfaces that can produce the
payload consume it in the tasks that add them.
MSG
)"
```

---

### Task 4: The group model and its mutators

**Files:**
- Modify: `app/src/lib/orchestration.ts:42-47` (`Stage`), `:786-1035` (mutators)
- Test: `app/src/lib/orchestration.test.ts`

**Interfaces:**
- Consumes: `FEATURE_MIN_VERSION.groups` (Task 3) — not called here, only gated by callers.
- Produces:
  - `type StageMode = "sequence" | "parallel"`
  - `Stage { id, position, mode?: StageMode, name?: string | null, steps }`
  - `stageMode(stage: Stage): StageMode`
  - `isGroup(stage: Stage): boolean`
  - `findStage(orch: Orchestration, stageId: string): Stage | null`
  - `setStageMode(orch, stageId: string, mode: StageMode): Orchestration`
  - `renameStage(orch, stageId: string, name: string | null): Orchestration`
  - `moveStageToIndex(orch, stageId: string, railId: string, index: number): Orchestration`
  - `removeStage(orch, stageId: string): Orchestration`
  - `moveStepIntoStage(orch, stepId, stageId, index: number): Orchestration` — **signature change**, `index` is required
  - `addStep(orch, stageId, stepId, cardPath, index: number): Orchestration` — **signature change**
  - `addToolStep(orch, stageId, stepId, toolId, index: number): Orchestration` — **signature change**

- [ ] **Step 1: Write the failing tests**

Add to `app/src/lib/orchestration.test.ts`. Add the new names to the import block at the top of the file.

```ts
describe("stageMode", () => {
  it("reads an absent mode as parallel", () => {
    // Every stage written before groups existed omits it, and those ran
    // their steps at once.
    expect(stageMode({ id: "s1", position: 0, steps: [] })).toBe("parallel");
  });

  it("reads an unknown mode as parallel", () => {
    expect(stageMode({ id: "s1", position: 0, mode: "lockstep" as StageMode, steps: [] })).toBe("parallel");
  });

  it("reads sequence as sequence", () => {
    expect(stageMode({ id: "s1", position: 0, mode: "sequence", steps: [] })).toBe("sequence");
  });
});

describe("isGroup", () => {
  it("is false for a single-step stage whatever its mode", () => {
    const one = { id: "s1", position: 0, mode: "sequence" as StageMode, steps: [{ id: "t1", position: 0, cardPath: "/x/a.md" }] };
    expect(isGroup(one)).toBe(false);
  });

  it("is true for two steps", () => {
    const two = {
      id: "s1",
      position: 0,
      steps: [
        { id: "t1", position: 0, cardPath: "/x/a.md" },
        { id: "t2", position: 1, cardPath: "/x/b.md" },
      ],
    };
    expect(isGroup(two)).toBe(true);
  });
});

describe("forming a group", () => {
  function twoStages(): Orchestration {
    let o = addRail(emptyOrchestration(), "r1", "backend");
    o = addStep(addStage(o, "r1", "s1"), "s1", "t1", "/x/a.md", 0);
    o = addStep(addStage(o, "r1", "s2"), "s2", "t2", "/x/b.md", 0);
    return o;
  }

  it("makes the target sequential when it held one step", () => {
    // The whole point of the change: dropping a card onto another means
    // "these two, in this order", not "these two at once".
    const o = moveStepIntoStage(twoStages(), "t2", "s1", 1);
    const stage = findStage(o, "s1") as Stage;
    expect(stageMode(stage)).toBe("sequence");
    expect(stage.steps.map((s) => s.id)).toEqual(["t1", "t2"]);
  });

  it("makes an OLD single-step stage sequential too", () => {
    // A stage stored before groups reads as parallel. Its mode describes
    // nothing observable while it holds one step, so the gesture means
    // the same thing whenever the target was written.
    let o = twoStages();
    o = { ...o, rails: o.rails.map((r) => ({ ...r, stages: r.stages.map((s) => (s.id === "s1" ? { ...s, mode: "parallel" as StageMode } : s)) })) };
    expect(stageMode(findStage(moveStepIntoStage(o, "t2", "s1", 1), "s1") as Stage)).toBe("sequence");
  });

  it("keeps the mode of a stage that is already a group", () => {
    let o = twoStages();
    o = moveStepIntoStage(o, "t2", "s1", 1); // s1 is now a sequence group
    o = setStageMode(o, "s1", "parallel");
    o = addStep(addStage(o, "r1", "s3"), "s3", "t3", "/x/c.md", 0);
    o = moveStepIntoStage(o, "t3", "s1", 2);
    expect(stageMode(findStage(o, "s1") as Stage)).toBe("parallel");
  });

  it("does NOT flip a parallel group to sequence when a member is reordered inside it", () => {
    // The trap: detaching the member first leaves the stage momentarily
    // holding one step, which reads exactly like the stage a drop is
    // about to group. The decision has to be made before the detach.
    let o = twoStages();
    o = moveStepIntoStage(o, "t2", "s1", 1);
    o = setStageMode(o, "s1", "parallel");
    o = moveStepIntoStage(o, "t2", "s1", 0);
    expect(stageMode(findStage(o, "s1") as Stage)).toBe("parallel");
    expect((findStage(o, "s1") as Stage).steps.map((t) => t.id)).toEqual(["t2", "t1"]);
  });

  it("inserts at the given index and renumbers", () => {
    const o = moveStepIntoStage(twoStages(), "t2", "s1", 0);
    const stage = findStage(o, "s1") as Stage;
    expect(stage.steps.map((s) => s.id)).toEqual(["t2", "t1"]);
    expect(stage.steps.map((s) => s.position)).toEqual([0, 1]);
  });

  it("clamps an index past the end", () => {
    const o = moveStepIntoStage(twoStages(), "t2", "s1", 99);
    expect((findStage(o, "s1") as Stage).steps.map((s) => s.id)).toEqual(["t1", "t2"]);
  });
});

describe("setStageMode / renameStage", () => {
  function group(): Orchestration {
    let o = addRail(emptyOrchestration(), "r1", "backend");
    o = addStep(addStage(o, "r1", "s1"), "s1", "t1", "/x/a.md", 0);
    o = addStep(o, "s1", "t2", "/x/b.md", 1);
    return o;
  }

  it("flips the mode", () => {
    expect(stageMode(findStage(setStageMode(group(), "s1", "parallel"), "s1") as Stage)).toBe("parallel");
  });

  it("leaves other stages alone", () => {
    let o = addStep(addStage(group(), "r1", "s2"), "s2", "t3", "/x/c.md", 0);
    o = setStageMode(o, "s1", "parallel");
    expect(stageMode(findStage(o, "s2") as Stage)).toBe("sequence");
  });

  it("names and un-names", () => {
    const named = renameStage(group(), "s1", "Merge and push");
    expect((findStage(named, "s1") as Stage).name).toBe("Merge and push");
    expect((findStage(renameStage(named, "s1", null), "s1") as Stage).name).toBeNull();
  });

  it("trims a name to null when it is only whitespace", () => {
    // An empty name falls back to the positional label; storing "  "
    // would render as a blank header instead.
    expect((findStage(renameStage(group(), "s1", "   "), "s1") as Stage).name).toBeNull();
  });
});

describe("moveStageToIndex", () => {
  function threeStages(): Orchestration {
    let o = addRail(addRail(emptyOrchestration(), "r1", "backend"), "r2", "frontend");
    o = addStep(addStage(o, "r1", "s1"), "s1", "t1", "/x/a.md", 0);
    o = addStep(addStage(o, "r1", "s2"), "s2", "t2", "/x/b.md", 0);
    o = addStep(addStage(o, "r1", "s3"), "s3", "t3", "/x/c.md", 0);
    return o;
  }

  it("reorders within the rail and renumbers", () => {
    const o = moveStageToIndex(threeStages(), "s3", "r1", 0);
    const rail = o.rails.find((r) => r.id === "r1") as Rail;
    expect(rail.stages.map((s) => s.id)).toEqual(["s3", "s1", "s2"]);
    expect(rail.stages.map((s) => s.position)).toEqual([0, 1, 2]);
  });

  it("moves the whole stage to another rail with every step", () => {
    let o = threeStages();
    o = moveStepIntoStage(o, "t2", "s1", 1); // s1 is a group of t1, t2
    o = moveStageToIndex(o, "s1", "r2", 0);
    const r2 = o.rails.find((r) => r.id === "r2") as Rail;
    expect(r2.stages[0].steps.map((s) => s.id)).toEqual(["t1", "t2"]);
    expect((o.rails.find((r) => r.id === "r1") as Rail).stages.map((s) => s.id)).toEqual(["s3"]);
  });

  it("keeps run state: the ids survive the move", () => {
    // Run state is keyed by step id, so a move must never mint new ones.
    let o = threeStages();
    o = { ...o, stepRuns: [{ stepId: "t1", state: "done", sessionId: null, reason: null }] };
    o = moveStageToIndex(o, "s1", "r2", 0);
    expect(stepStateOf(o, "t1")).toBe("done");
  });

  it("is a no-op for an unknown stage or rail", () => {
    expect(moveStageToIndex(threeStages(), "nope", "r1", 0)).toEqual(threeStages());
    expect(moveStageToIndex(threeStages(), "s1", "nope", 0)).toEqual(threeStages());
  });
});

describe("removeStage", () => {
  it("takes the stage and every step it held", () => {
    let o = addRail(emptyOrchestration(), "r1", "backend");
    o = addStep(addStage(o, "r1", "s1"), "s1", "t1", "/x/a.md", 0);
    o = addStep(o, "s1", "t2", "/x/b.md", 1);
    o = { ...o, stepRuns: [{ stepId: "t1", state: "done", sessionId: null, reason: null }] };
    const after = removeStage(o, "s1");
    expect(after.rails[0].stages).toEqual([]);
    // sweepOrphans: run state for steps that no longer exist must go too.
    expect(after.stepRuns).toEqual([]);
  });
});

describe("new single-step stages", () => {
  it("are written sequence, so the next drop means what it says", () => {
    const o = addCardAsStage(addRail(emptyOrchestration(), "r1", "backend"), "r1", 0, "t1", "/x/a.md");
    expect(o.rails[0].stages[0].mode).toBe("sequence");
  });
});

describe("splitStageIntoSequence", () => {
  it("clears the name on every slice", () => {
    // A name describes a group; ungrouping says there is no longer one.
    let o = addRail(emptyOrchestration(), "r1", "backend");
    o = addStep(addStage(o, "r1", "s1"), "s1", "t1", "/x/a.md", 0);
    o = addStep(o, "s1", "t2", "/x/b.md", 1);
    o = renameStage(o, "s1", "Merge and push");
    const after = splitStageIntoSequence(o, "s1");
    expect(after.rails[0].stages).toHaveLength(2);
    expect(after.rails[0].stages.every((s) => s.name == null)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd app && npx vitest run src/lib/orchestration.test.ts`
Expected: FAIL — `stageMode` is not exported.

- [ ] **Step 3: Implement the model**

In `app/src/lib/orchestration.ts`, replace the `Stage` interface (`:42-47`):

```ts
/// How a stage's steps run (grouping spec G1). Absent means `parallel`,
/// because every stage written before groups existed ran that way -- read
/// it through stageMode(), never directly.
export type StageMode = "sequence" | "parallel";

/// Stages run one after another. A stage holding two or more steps is a
/// GROUP, and its `mode` says whether those steps run at once in the
/// rail's checkout or one at a time in position order.
export interface Stage {
  id: string;
  position: number;
  mode?: StageMode;
  /// The group's name, shown in its header. Null/absent renders as the
  /// positional label the rail already draws.
  name?: string | null;
  steps: Step[];
}

/// The mode a stage actually runs in, tolerating a field that is absent
/// (written before groups existed) or unrecognised (a hand edit, a newer
/// peer). Both degrade to the discipline every existing plan already ran
/// under -- the same shape stepParams uses for a missing toolParams.
export function stageMode(stage: Stage): StageMode {
  return stage.mode === "sequence" ? "sequence" : "parallel";
}

/// A stage the human sees as a GROUP: one with something to order. A
/// single-step stage runs identically in either mode, so it draws bare
/// and its mode is not worth showing.
export function isGroup(stage: Stage): boolean {
  return stage.steps.length > 1;
}
```

- [ ] **Step 4: Implement the mutators**

In the mutator section of `orchestration.ts`:

```ts
/// The stage with this id, wherever it sits -- the stage-level twin of
/// findStep, for every surface that gets a stage id from the DOM.
export function findStage(orch: Orchestration, stageId: string): Stage | null {
  for (const rail of orch.rails) {
    for (const stage of rail.stages) {
      if (stage.id === stageId) return stage;
    }
  }
  return null;
}

function mapStage(
  orch: Orchestration,
  stageId: string,
  f: (stage: Stage) => Stage
): Orchestration {
  return {
    ...orch,
    rails: orch.rails.map((r) => ({
      ...r,
      stages: r.stages.map((s) => (s.id === stageId ? f(s) : s)),
    })),
  };
}

/// Flip a group between running its steps at once and one at a time.
/// Safe mid-run in both directions: a sequence group has at most one
/// running member, and flipping to parallel only lets the rest start on
/// the next tick.
export function setStageMode(orch: Orchestration, stageId: string, mode: StageMode): Orchestration {
  return mapStage(orch, stageId, (s) => ({ ...s, mode }));
}

/// Name a group, or clear the name back to the positional label. A name
/// that is only whitespace is a cleared name, not a blank header.
export function renameStage(orch: Orchestration, stageId: string, name: string | null): Orchestration {
  const trimmed = name?.trim() ?? "";
  return mapStage(orch, stageId, (s) => ({ ...s, name: trimmed === "" ? null : trimmed }));
}

/// Move a whole stage -- every step it holds, with their ids and so their
/// run state -- to `index` in `railId`. The unit move a group needs, and
/// the stage-level twin of moveStepToNewStage.
///
/// CONTRACT: `index` counts stage positions in the target rail with the
/// dragged stage already removed, which is what the drag glue measures.
export function moveStageToIndex(
  orch: Orchestration,
  stageId: string,
  railId: string,
  index: number
): Orchestration {
  const stage = findStage(orch, stageId);
  if (!stage || !orch.rails.some((r) => r.id === railId)) return orch;
  const detached = orch.rails.map((r) => ({
    ...r,
    stages: renumber(r.stages.filter((s) => s.id !== stageId)),
  }));
  return {
    ...orch,
    rails: detached.map((r) => {
      if (r.id !== railId) return r;
      const stages = [...r.stages];
      stages.splice(Math.max(0, Math.min(index, stages.length)), 0, stage);
      return { ...r, stages: renumber(stages) };
    }),
  };
}

/// Remove a stage and every step it held -- what dropping a group on the
/// drawer means. sweepOrphans, because those step ids are gone for good.
export function removeStage(orch: Orchestration, stageId: string): Orchestration {
  const rails = orch.rails.map((r) => ({
    ...r,
    stages: renumber(r.stages.filter((s) => s.id !== stageId)),
  }));
  return sweepOrphans({ ...orch, rails });
}
```

Replace `insertStep` and the two `addStep`/`addToolStep` wrappers so every join takes an index and forms a group:

```ts
/// Would this drop FORM a group -- is the target a stage holding exactly
/// one step, and is that step not the one arriving?
///
/// The second half is load-bearing and easy to miss: a member being
/// REORDERED within its own stage is detached first, which leaves that
/// stage momentarily holding one step. Read after the detach, a reorder
/// inside a parallel group is indistinguishable from a drop that forms
/// one, and would silently flip the group to sequence. So this is always
/// evaluated against the orchestration BEFORE anything is detached.
function formsGroup(orch: Orchestration, stageId: string, arrivingStepId: string | null): boolean {
  const stage = findStage(orch, stageId);
  return Boolean(stage) && stage!.steps.length === 1 && stage!.steps[0].id !== arrivingStepId;
}

/// Insert into a stage at `index`, clamped. `forming` makes it a
/// `sequence` group (grouping spec G3): that stage's stored mode
/// described nothing observable while it held one step, so overwriting it
/// discards no intent, and the gesture means the same thing whether the
/// target was written today or before groups existed. A stage that is
/// already a group keeps the mode the human chose for it.
function insertStep(
  orch: Orchestration,
  stageId: string,
  index: number,
  forming: boolean,
  make: (position: number) => Step
): Orchestration {
  return mapStage(orch, stageId, (s) => {
    const steps = [...s.steps].sort((a, b) => a.position - b.position);
    steps.splice(Math.max(0, Math.min(index, steps.length)), 0, make(0));
    return { ...s, mode: forming ? "sequence" : stageMode(s), steps: renumber(steps) };
  });
}

export function addStep(
  orch: Orchestration,
  stageId: string,
  stepId: string,
  cardPath: string,
  index: number
): Orchestration {
  // A brand-new step is never already in the target, so `null` is the
  // honest "nothing is arriving from inside this stage".
  return insertStep(orch, stageId, index, formsGroup(orch, stageId, null), (position) =>
    cardStep(stepId, position, cardPath)
  );
}

/// Join an existing stage with a tool -- the same grouping drop addStep
/// is for a card.
export function addToolStep(
  orch: Orchestration,
  stageId: string,
  stepId: string,
  toolId: string,
  index: number
): Orchestration {
  return insertStep(orch, stageId, index, formsGroup(orch, stageId, null), (position) =>
    toolStep(stepId, position, toolId)
  );
}
```

Rewrite `moveStepIntoStage` to take an index and go through the same insert:

```ts
/// Drop onto an existing stage: the step joins it at `index`, forming a
/// `sequence` group if that stage held one step (G3). No sweepOrphans --
/// the step id survives a move, so its run state and notes must too.
///
/// CONTRACT: `index` counts the target's members with the dragged step
/// already removed if it came from this same stage, which is what the
/// drag glue measures.
export function moveStepIntoStage(
  orch: Orchestration,
  stepId: string,
  stageId: string,
  index: number
): Orchestration {
  const found = locateStep(orch, stepId);
  if (!found) return orch;
  // Decided BEFORE the detach -- see formsGroup.
  const forming = formsGroup(orch, stageId, stepId);
  const detached = detachStep(orch, stepId);
  if (!detached.rails.some((r) => r.stages.some((s) => s.id === stageId))) return orch;
  return insertStep(detached, stageId, index, forming, (position) => ({ ...found.step, position }));
}
```

Note the removed `found.stageId === stageId` early return: reordering *within* a stage is now a real move, and refusing it would make within-group ordering impossible. `detachStep` drops a stage it empties, so a same-stage move of the only step still finds nothing to insert into and returns unchanged via the guard above.

In `addStage`, `insertAsStage` and `moveStepToNewStage`, write the new stage as `mode: "sequence"` (spec §1.3) — e.g. in `insertAsStage`:

```ts
      stages.splice(at, 0, { id: crypto.randomUUID(), position: at, mode: "sequence", name: null, steps: [step] });
```

In `splitStageIntoSequence`, clear the name and carry the mode as `sequence` on every slice:

```ts
          .map((step, i) => ({
            id: i === 0 ? s.id : crypto.randomUUID(),
            position: 0, // renumber() fixes these up below
            mode: "sequence" as StageMode,
            // A name describes a GROUP; ungrouping says there is no
            // longer one to name.
            name: null,
            steps: [{ ...step, position: 0 }],
          }));
```

- [ ] **Step 5: Fix the call sites of the three changed signatures**

Run: `cd app && npm run check`
Fix every `addStep` / `addToolStep` / `moveStepIntoStage` call the checker flags by passing an index. In `orchestrationState.ts` the existing callers append, so their index is the target stage's current step count; in tests it is whatever the test's ordering needs. Task 7 replaces those state actions properly — here, just keep them compiling and appending.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd app && npx vitest run src/lib/orchestration.test.ts && npm run check`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add app/src/lib/orchestration.ts app/src/lib/orchestration.test.ts app/src/lib/orchestrationState.ts
git commit -m "$(cat <<'MSG'
feat(orchestration): a stage can be a named, ordered group

Dropping a step onto another made the target stage parallel by
construction, which was the only multi-step shape a rail could hold. It
now forms a sequence group: the same container, told to run its members
in order, nameable and movable as one unit.

Joining a single-step stage overwrites its mode unconditionally. That
stage's mode described nothing observable while it held one step, so
nothing is discarded, and the gesture means the same thing whether the
target was written today or before groups existed.

The three join mutators take an insertion index rather than always
appending, because a sequential group whose order is fixed by the order
you happened to drop things in is the one shape that most needs
reordering. moveStepIntoStage no longer refuses a same-stage move for
the same reason.
MSG
)"
```

---

### Task 5: The scheduler runs a sequence stage one member at a time

**Files:**
- Modify: `app/src/lib/orchestration.ts:593-683` (the step loop inside `nextActions`)
- Test: `app/src/lib/orchestration.test.ts`

**Interfaces:**
- Consumes: `stageMode` (Task 4).
- Produces: no new exports — `nextActions`'s behaviour changes for `mode: "sequence"` stages only.

- [ ] **Step 1: Write the failing tests**

Add to `app/src/lib/orchestration.test.ts`. The file's existing `nextActions` describe block has the setup idioms — reuse its `board`/`tree`/`plan` helpers.

```ts
describe("nextActions on a sequence group", () => {
  function sequential(): Orchestration {
    let o = addRail(emptyOrchestration(), "r1", "backend");
    o = addStep(addStage(o, "r1", "s1"), "s1", "t1", "/ws/.gavin-root/plans/a.md", 0);
    o = addStep(o, "s1", "t2", "/ws/.gavin-root/plans/b.md", 1);
    o = setStageMode(o, "s1", "sequence");
    return { ...o, railRuns: [{ railId: "r1", state: "running", currentStageId: "s1" }] };
  }

  const t = () => tree([plan("a.md"), plan("b.md")]);
  const b = () => board(["To Do", "Done"]);

  it("launches only the first member", () => {
    const actions = nextActions(sequential(), b(), t(), [], new Set());
    expect(actions).toEqual([{ kind: "launch", stepId: "t1" }]);
  });

  it("launches all members when the same stage is parallel", () => {
    // The contrast is the whole feature: same stage, same steps, one
    // field apart.
    const o = setStageMode(sequential(), "s1", "parallel");
    expect(nextActions(o, b(), t(), [], new Set())).toEqual([
      { kind: "launch", stepId: "t1" },
      { kind: "launch", stepId: "t2" },
    ]);
  });

  it("does not launch the second while the first runs", () => {
    const o = { ...sequential(), stepRuns: [{ stepId: "t1", state: "running" as StepState, sessionId: "sess-1", reason: null }] };
    expect(nextActions(o, b(), t(), [], new Set(["sess-1"]))).toEqual([]);
  });

  it("launches the next as soon as the first is done", () => {
    const o = { ...sequential(), stepRuns: [{ stepId: "t1", state: "done" as StepState, sessionId: null, reason: null }] };
    expect(nextActions(o, b(), t(), [], new Set())).toEqual([{ kind: "launch", stepId: "t2" }]);
  });

  it("cascades within one tick when a member completes on this pass", () => {
    // Rule 1 marks t1 done because its card reached the done column; the
    // next member must not wait for an unrelated change to tick the
    // workspace again.
    const o = sequential();
    const actions = nextActions(o, b(), tree([plan("a.md", { status: "Done" }), plan("b.md")]), [], new Set());
    expect(actions).toEqual([
      { kind: "markDone", stepId: "t1" },
      { kind: "launch", stepId: "t2" },
    ]);
  });

  it("advances the rail only when every member is done", () => {
    let o = sequential();
    o = addStep(addStage(o, "r1", "s2"), "s2", "t3", "/ws/.gavin-root/plans/c.md", 0);
    o = { ...o, stepRuns: [
      { stepId: "t1", state: "done", sessionId: null, reason: null },
      { stepId: "t2", state: "done", sessionId: null, reason: null },
    ] };
    const actions = nextActions(o, b(), tree([plan("a.md"), plan("b.md"), plan("c.md")]), [], new Set());
    expect(actions).toContainEqual({ kind: "advance", railId: "r1", stageId: "s2" });
  });

  it("still pauses the rail when a member stalls", () => {
    // A stalled member must read as a stall, not as "just not done yet".
    // A bound rail whose worktree is not in the known list is the
    // cheapest blocker launchBlocker recognises.
    const base = sequential();
    const o = { ...base, rails: base.rails.map((r) => ({ ...r, worktreePath: "/gone" })) };
    const actions = nextActions(o, b(), t(), [], new Set());
    expect(actions.filter((a) => a.kind === "stall")).toHaveLength(1);
    expect(actions.some((a) => a.kind === "launch")).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd app && npx vitest run src/lib/orchestration.test.ts -t "sequence group"`
Expected: FAIL — "launches only the first member" gets both launches.

- [ ] **Step 3: Add the sequential guard**

In `nextActions`, replace the step-loop header at `orchestration.ts:593`:

```ts
      // A `sequence` stage runs ONE member at a time, in position order
      // (grouping spec G4). The guard at the bottom of this loop is the
      // whole of that rule: every existing rule is untouched, and a
      // member that completes on this pass lets the next one launch in
      // the same tick -- the cascade rule 4 already gives stages.
      const sequential = stageMode(stage) === "sequence";
      for (const step of [...stage.steps].sort((a, b) => a.position - b.position)) {
        stepBody: {
```

Change every `continue;` inside that loop body to `break stepBody;` (there are four: rule 1's, rule 2's, rule 3b's, and rule 3's `markDone` branch — plus the `continue` in rule 3's live-session branch if present after the refactor; the compiler will not catch a missed one, so grep the block).

Close the labeled block and add the guard immediately before the loop's closing brace:

```ts
        }
        // A member that is not done leaves nothing for its successors
        // to start behind. That covers a stall too: both sites that set
        // the rail-level `stalled` flag set this step's simulated state
        // to "stalled" first, so rule 5 below still pauses the rail
        // without a second break here. A second break would also not be
        // gated on `sequential`, and would change what a PARALLEL stage
        // emits -- a stalled member would abort the loop instead of
        // letting rule 2 reach its launchable siblings.
        if (sequential && simulated.get(step.id) !== "done") break;
      }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd app && npx vitest run src/lib/orchestration.test.ts`
Expected: PASS — including every pre-existing `nextActions` test, which all use parallel (mode-absent) stages.

Green is not sufficient on the parallel path. `orchestration.test.ts:620` ("stops at
the first stall") asserts with `toContainEqual`, so it stays green even if a parallel
stage stops emitting the sibling `launch` it used to. Tighten it to assert the whole
action array before trusting the suite here.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/orchestration.ts app/src/lib/orchestration.test.ts
git commit -m "$(cat <<'MSG'
feat(orchestration): run a sequence group one member at a time

A group that says its members run in order has to be scheduled that way,
and the scheduler launched every step in a stage on the same tick.

The rule is one guard at the foot of the existing step loop rather than
a second code path: each of rules 1 to 3 is untouched, so a member
inherits the same blockers, the same stall reasons and the same rule 1
that skips a card already sitting in the done column. Because the guard
reads the simulated state, a member that completes on this pass lets the
next one launch in the same tick -- the cascade stages already had.

A stalled member needs no guard of its own: the flag that pauses the
rail is always set alongside that step's simulated state, so one guard
serves both -- and a second one, ungated by mode, would change what a
parallel stage emits.
MSG
)"
```

---

### Task 6: A sequence group is not a same-worktree conflict

**Files:**
- Modify: `app/src/lib/orchestration.ts:1462-1483` (`detectConflicts` rule 1), `app/src/lib/orchestrationState.ts:1030-1036` (the repair action), `app/src/lib/OrchestrationConflicts.svelte:16,65`
- Test: `app/src/lib/orchestration.test.ts`, `app/src/lib/orchestrationState.test.ts`

**Interfaces:**
- Consumes: `stageMode`, `setStageMode` (Task 4).
- Produces: `makeStageSequentialAction(workspaceId: string, stageId: string): Promise<string | null>` in `orchestrationState.ts` — **behaviour change**, same name, now writes a mode instead of splitting.

- [ ] **Step 1: Write the failing tests**

In `app/src/lib/orchestration.test.ts`, inside the existing `detectConflicts` describe:

```ts
it("does not call a sequence group a same-worktree conflict", () => {
  // Its members share the rail's checkout IN TURN, which is what a rail
  // is for -- reporting that as a collision is noise.
  let o = addRail(emptyOrchestration(), "r1", "backend");
  o = { ...o, rails: o.rails.map((r) => ({ ...r, worktreePath: "/wt/a" })) };
  o = addStep(addStage(o, "r1", "s1"), "s1", "t1", "/ws/.gavin-root/plans/a.md", 0);
  o = addStep(o, "s1", "t2", "/ws/.gavin-root/plans/b.md", 1);
  o = setStageMode(o, "s1", "sequence");
  const found = detectConflicts(o, tree([plan("a.md"), plan("b.md")]), [{ path: "/wt/a" } as WorktreeInfo]);
  expect(found.filter((c) => c.kind === "same-worktree" && c.scope === "stage")).toEqual([]);
});

it("still calls a parallel group one", () => {
  let o = addRail(emptyOrchestration(), "r1", "backend");
  o = { ...o, rails: o.rails.map((r) => ({ ...r, worktreePath: "/wt/a" })) };
  o = addStep(addStage(o, "r1", "s1"), "s1", "t1", "/ws/.gavin-root/plans/a.md", 0);
  o = addStep(o, "s1", "t2", "/ws/.gavin-root/plans/b.md", 1);
  o = setStageMode(o, "s1", "parallel");
  const found = detectConflicts(o, tree([plan("a.md"), plan("b.md")]), [{ path: "/wt/a" } as WorktreeInfo]);
  expect(found.filter((c) => c.kind === "same-worktree" && c.scope === "stage")).toHaveLength(1);
});
```

In `app/src/lib/orchestrationState.test.ts`, alongside the existing repair test:

```ts
it("makeStageSequentialAction flips the mode and keeps the group whole", async () => {
  // The repair used to detonate the stage into single-step stages, which
  // threw away the grouping the human built.
  // (Set up a two-step parallel stage in `orchestrations` the way the
  // neighbouring tests in this file do, then:)
  await makeStageSequentialAction("ws-1", "s1");
  const after = get(orchestrations)["ws-1"];
  expect(findStage(after, "s1")?.steps).toHaveLength(2);
  expect(stageMode(findStage(after, "s1") as Stage)).toBe("sequence");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd app && npx vitest run src/lib/orchestration.test.ts src/lib/orchestrationState.test.ts`
Expected: FAIL — the sequence group is still reported, and the action still splits.

- [ ] **Step 3: Exempt sequence stages and change the repair**

In `detectConflicts` rule 1, replace the grouping loop's guard. The map is built per stage id, so carry the mode alongside:

```ts
  // 1. A PARALLEL stage IS a same-worktree conflict by construction: its
  // steps share the rail's checkout at the same time. That is intended,
  // and saying so out loud beats pretending it is safe (spec §5). A
  // SEQUENCE group is exempt (grouping spec G5) -- its members share that
  // checkout in turn, which is what a rail is for.
  const parallelStages = new Set(
    orch.rails.flatMap((r) => r.stages.filter((s) => stageMode(s) === "parallel").map((s) => s.id))
  );
  const byStage = new Map<string, PlacedStep[]>();
  for (const s of steps) {
    if (!s.checkout || !parallelStages.has(s.stageId)) continue;
    const group = byStage.get(s.stageId) ?? [];
    group.push(s);
    byStage.set(s.stageId, group);
  }
```

In `orchestrationState.ts:1034`, change the repair to a mode write and update its doc comment:

```ts
/// The repair for a parallel-stage conflict: tell the group to run its
/// members one at a time. A mode flip rather than the old split, so the
/// group the human built survives the fix -- ungrouping is a separate,
/// deliberate act.
export function makeStageSequentialAction(workspaceId: string, stageId: string): Promise<string | null> {
  return mutatePlan(workspaceId, (o) => setStageMode(o, stageId, "sequence"));
}
```

Keep `splitStageIntoSequence` exported and imported — Task 9 wires it to **Ungroup**.

In `OrchestrationConflicts.svelte`, update the comment at `:16` and the button label at `:65`:

```
Run in sequence
```

with the prop doc reading:

```svelte
    /// The repair for a parallel stage (grouping spec G5): tell the group
    /// to run its members one at a time. The group stays whole.
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd app && npx vitest run src/lib/orchestration.test.ts src/lib/orchestrationState.test.ts && npm run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/orchestration.ts app/src/lib/orchestration.test.ts app/src/lib/orchestrationState.ts app/src/lib/orchestrationState.test.ts app/src/lib/OrchestrationConflicts.svelte
git commit -m "$(cat <<'MSG'
fix(orchestration): a sequence group is not a same-worktree collision

Rule 1 reported every multi-step stage as a same-worktree conflict,
which was exactly right while a multi-step stage could only mean "all at
once in one checkout". A sequence group's members share that checkout in
turn -- that is what a rail is -- so reporting it is noise that trains
the human to ignore the panel.

The repair changes with it. "Make sequential" split the stage into N
single-step stages, throwing away the grouping to fix it; it now writes
the mode and leaves the group whole. Destroying a group stays available
as Ungroup, where it is the point rather than a side effect.
MSG
)"
```

---

### Task 7: State actions for groups

**Files:**
- Modify: `app/src/lib/orchestrationState.ts:803-870`
- Test: `app/src/lib/orchestrationState.test.ts`

**Interfaces:**
- Consumes: `setStageMode`, `renameStage`, `moveStageToIndex`, `removeStage`, `splitStageIntoSequence`, indexed `addStep`/`addToolStep`/`moveStepIntoStage` (Task 4).
- Produces:
  - `setStageModeAction(workspaceId, stageId, mode: StageMode): Promise<string | null>`
  - `renameStageAction(workspaceId, stageId, name: string | null): Promise<string | null>`
  - `moveStageToIndexAction(workspaceId, stageId, railId, index): Promise<string | null>`
  - `removeStageAction(workspaceId, stageId): Promise<string | null>`
  - `ungroupStageAction(workspaceId, stageId): Promise<string | null>`
  - `addStepToStageAction(workspaceId, stageId, cardPath, index)` — **signature change**
  - `addToolToStageAction(workspaceId, stageId, toolId, index)` — **signature change**
  - `moveStepIntoStageAction(workspaceId, stepId, stageId, index)` — **signature change**

- [ ] **Step 1: Write the failing tests**

Add to `app/src/lib/orchestrationState.test.ts`, following the file's existing action-test idiom (seed `orchestrations`, call, assert on the store and on the mocked backend):

```ts
it("setStageModeAction persists the flip", async () => {
  // seeded: rail r1, stage s1 with steps t1, t2
  expect(await setStageModeAction("ws-1", "s1", "parallel")).toBeNull();
  expect(stageMode(findStage(get(orchestrations)["ws-1"], "s1") as Stage)).toBe("parallel");
});

it("renameStageAction persists a name and clears it", async () => {
  await renameStageAction("ws-1", "s1", "Merge and push");
  expect(findStage(get(orchestrations)["ws-1"], "s1")?.name).toBe("Merge and push");
  await renameStageAction("ws-1", "s1", null);
  expect(findStage(get(orchestrations)["ws-1"], "s1")?.name).toBeNull();
});

it("moveStageToIndexAction moves the group and its run state", async () => {
  await moveStageToIndexAction("ws-1", "s1", "r2", 0);
  const o = get(orchestrations)["ws-1"];
  expect(o.rails.find((r) => r.id === "r2")?.stages[0].id).toBe("s1");
});

it("ungroupStageAction leaves one stage per step", async () => {
  await ungroupStageAction("ws-1", "s1");
  expect(get(orchestrations)["ws-1"].rails[0].stages).toHaveLength(2);
});

it("addStepToStageAction inserts at the given index", async () => {
  await addStepToStageAction("ws-1", "s1", "/x/c.md", 0);
  const stage = findStage(get(orchestrations)["ws-1"], "s1") as Stage;
  expect(stage.steps[0].cardPath).toBe("/x/c.md");
});

it("a member queued behind a running one does not start on drop", async () => {
  // startIfStageRunning ticks; the tick must decline to launch it while
  // the member ahead of it is still running. The drop is correctly inert.
  // (seed: s1 is the running stage, mode sequence, t1 running)
  await addStepToStageAction("ws-1", "s1", "/x/c.md", 1);
  expect(backend.createSession).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd app && npx vitest run src/lib/orchestrationState.test.ts`
Expected: FAIL — `setStageModeAction` is not exported.

- [ ] **Step 3: Implement the actions**

In `app/src/lib/orchestrationState.ts`, after `addStepToStageAction`:

```ts
export function setStageModeAction(
  workspaceId: string,
  stageId: string,
  mode: StageMode
): Promise<string | null> {
  return mutatePlan(workspaceId, (o) => setStageMode(o, stageId, mode));
}

export function renameStageAction(
  workspaceId: string,
  stageId: string,
  name: string | null
): Promise<string | null> {
  return mutatePlan(workspaceId, (o) => renameStage(o, stageId, name));
}

/// Moving a whole group. Nothing to start afterwards: a group that lands
/// on a running rail is a later beat unless it IS the current stage, and
/// it cannot be -- the rail was running a stage this move did not touch.
export function moveStageToIndexAction(
  workspaceId: string,
  stageId: string,
  railId: string,
  index: number
): Promise<string | null> {
  return mutatePlan(workspaceId, (o) => moveStageToIndex(o, stageId, railId, index));
}

/// Drops the group and every step it held. The cards are untouched: only
/// the steps that pointed at them leave.
export function removeStageAction(workspaceId: string, stageId: string): Promise<string | null> {
  return mutatePlan(workspaceId, (o) => removeStage(o, stageId));
}

/// One stage per member, in order -- the deliberate destruction of a
/// group, as opposed to the conflict repair, which keeps it whole.
export function ungroupStageAction(workspaceId: string, stageId: string): Promise<string | null> {
  return mutatePlan(workspaceId, (o) => splitStageIntoSequence(o, stageId));
}
```

Thread the index through the three changed actions:

```ts
export async function addStepToStageAction(
  workspaceId: string,
  stageId: string,
  cardPath: string,
  index: number
): Promise<string | null> {
  const error = await mutatePlan(workspaceId, (o) => addStep(o, stageId, crypto.randomUUID(), cardPath, index));
  if (!error) await startIfStageRunning(workspaceId, stageId);
  return error;
}
```

and the same shape for `addToolToStageAction` and `moveStepIntoStageAction`. `startIfStageRunning` is unchanged: on a `sequence` group the tick simply declines to launch a member queued behind a running one (spec §2.1).

Update the doc comment on `addStepToStageAction` — it currently says "The PARALLEL drop", which is no longer what it means:

```ts
/// The GROUPING drop: the card joins an existing stage at `index`,
/// making it a sequence group if it held one step. If that stage is the
/// one its rail is running right now, the card starts immediately --
/// unless the group is sequential and something ahead of it is still
/// running, in which case the tick correctly leaves it queued.
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd app && npx vitest run src/lib/orchestrationState.test.ts && npm run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/src/lib/orchestrationState.ts app/src/lib/orchestrationState.test.ts
git commit -m "$(cat <<'MSG'
feat(orchestration): persist group mode, name, move and ungroup

The reactive half of the group mutators, following the split every other
action here keeps: orchestration.ts decides, this executes.

The three join actions thread an insertion index rather than always
appending. startIfStageRunning needs no change and gets none: a member
dropped behind a running one in a sequence group ticks, is declined, and
sits queued -- which is what the group asked for.
MSG
)"
```

---

### Task 8: Drag — indexed drops and the stage handle

**Files:**
- Modify: `app/src/lib/orchestrationDrag.ts:16-37,55-90,93-120`, `app/src/lib/orchestrationDragGlue.ts:6-14,49-75,85-120`
- Test: `app/src/lib/orchestrationDrag.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (pure geometry).
- Produces:
  - `MeasuredStage { id, position, rect, steps: MeasuredStep[] }` where `MeasuredStep { id: string; rect: Rect }`
  - `OrchDropTarget` — `into-stage` now `{ kind: "into-stage"; stageId: string; index: number }`
  - `OrchDragKind` — adds `"stage"` and `"template"`
  - `isPlacementDrag(kind)` — now true for `"card" | "tool" | "template"`
  - `computeOrchDropTarget(pointer, rails, drawerRect, maxSnapPx?, kind?: OrchDragKind)` — a `"stage"` kind never returns `into-stage`
- Data-attribute contract additions: `[data-orch-stage-handle]` on the group header's drag handle, `[data-orch-template]` on a drawer template row (value = template id).

- [ ] **Step 1: Write the failing tests**

Add to `app/src/lib/orchestrationDrag.test.ts`, reusing its existing rect helpers:

```ts
describe("into-stage index over a GROUP", () => {
  // A group at y 100..200 holding two members that tile it: t1 at
  // 100..150 (midpoint 125), t2 at 150..200 (midpoint 175).
  const rails: MeasuredRail[] = [
    {
      id: "r1",
      rect: { left: 0, top: 0, width: 200, height: 400 },
      stages: [
        {
          id: "s1",
          position: 0,
          rect: { left: 0, top: 100, width: 200, height: 100 },
          steps: [
            { id: "t1", rect: { left: 0, top: 100, width: 200, height: 50 } },
            { id: "t2", rect: { left: 0, top: 150, width: 200, height: 50 } },
          ],
        },
      ],
    },
  ];

  it("is 0 over the first member's top half", () => {
    // Reachable only because a GROUP drops the three-band rule: under it
    // y=110 would be an outer band, and the first slot would have no
    // gesture at all.
    expect(computeOrchDropTarget({ x: 100, y: 110 }, rails, null)).toEqual({
      kind: "into-stage",
      stageId: "s1",
      index: 0,
    });
  });

  it("is 1 over the first member's bottom half", () => {
    expect(computeOrchDropTarget({ x: 100, y: 140 }, rails, null)).toEqual({
      kind: "into-stage",
      stageId: "s1",
      index: 1,
    });
  });

  it("is 1 over the second member's top half", () => {
    expect(computeOrchDropTarget({ x: 100, y: 160 }, rails, null)).toEqual({
      kind: "into-stage",
      stageId: "s1",
      index: 1,
    });
  });

  it("is 2 over the last member's bottom half", () => {
    expect(computeOrchDropTarget({ x: 100, y: 190 }, rails, null)).toEqual({
      kind: "into-stage",
      stageId: "s1",
      index: 2,
    });
  });

  it("means BEFORE the group when the pointer is on its header strip", () => {
    // The header and the padding are inside the stage rect but over no
    // member, which is how "before/after the whole group" stays
    // reachable once the three-band rule is gone.
    const withHead: MeasuredRail[] = [
      {
        ...rails[0],
        stages: [{ ...rails[0].stages[0], rect: { left: 0, top: 80, width: 200, height: 120 } }],
      },
    ];
    expect(computeOrchDropTarget({ x: 100, y: 90 }, withHead, null)).toEqual({
      kind: "new-stage",
      railId: "r1",
      index: 0,
    });
  });
});

describe("into-stage index over a SINGLE-STEP stage", () => {
  // The three-band rule still applies here: the outer bands are what
  // distinguish "go before/after this stage" from "group with it".
  const rails: MeasuredRail[] = [
    {
      id: "r1",
      rect: { left: 0, top: 0, width: 200, height: 400 },
      stages: [
        {
          id: "s1",
          position: 0,
          rect: { left: 0, top: 100, width: 200, height: 100 },
          steps: [{ id: "t1", rect: { left: 0, top: 110, width: 200, height: 80 } }],
        },
      ],
    },
  ];

  it("groups above the member, at slot 0", () => {
    expect(computeOrchDropTarget({ x: 100, y: 135 }, rails, null)).toEqual({
      kind: "into-stage",
      stageId: "s1",
      index: 0,
    });
  });

  it("groups below the member, at slot 1", () => {
    expect(computeOrchDropTarget({ x: 100, y: 165 }, rails, null)).toEqual({
      kind: "into-stage",
      stageId: "s1",
      index: 1,
    });
  });

  it("still means before/after in the outer bands", () => {
    expect(computeOrchDropTarget({ x: 100, y: 105 }, rails, null)).toEqual({
      kind: "new-stage",
      railId: "r1",
      index: 0,
    });
    expect(computeOrchDropTarget({ x: 100, y: 195 }, rails, null)).toEqual({
      kind: "new-stage",
      railId: "r1",
      index: 1,
    });
  });
});

describe("dragging a whole stage", () => {
  const rails: MeasuredRail[] = [
    {
      id: "r1",
      rect: { left: 0, top: 0, width: 200, height: 400 },
      stages: [
        {
          id: "s1",
          position: 0,
          rect: { left: 0, top: 100, width: 200, height: 100 },
          steps: [{ id: "t1", rect: { left: 0, top: 110, width: 200, height: 80 } }],
        },
      ],
    },
  ];

  it("never targets into-stage, because groups do not nest", () => {
    const target = computeOrchDropTarget({ x: 100, y: 150 }, rails, null, 100, "stage");
    expect(target).toEqual({ kind: "new-stage", railId: "r1", index: 1 });
  });

  it("still targets the drawer", () => {
    const drawer = { left: 300, top: 0, width: 100, height: 400 };
    expect(computeOrchDropTarget({ x: 350, y: 50 }, rails, drawer, 100, "stage")).toEqual({ kind: "unplace" });
  });
});

describe("isPlacementDrag", () => {
  it("is true for a template, which has no step to detach", () => {
    expect(isPlacementDrag("template")).toBe(true);
  });

  it("is false for a stage, which is already placed", () => {
    expect(isPlacementDrag("stage")).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd app && npx vitest run src/lib/orchestrationDrag.test.ts`
Expected: FAIL — `MeasuredStage` has no `steps`, and `into-stage` carries no index.

- [ ] **Step 3: Widen the types and the hit-test**

In `app/src/lib/orchestrationDrag.ts`:

```ts
export interface MeasuredStep {
  id: string;
  rect: Rect;
}

export interface MeasuredStage {
  id: string;
  position: number;
  rect: Rect;
  /// The stage's member chips, in render order, with the dragged one
  /// excluded -- which is what makes the index this module computes the
  /// post-removal index the mutators expect.
  steps: MeasuredStep[];
}

export type OrchDropTarget =
  | { kind: "new-stage"; railId: string; index: number }
  /// `index` is the slot AMONG the stage's members, by the same midpoint
  /// rule the gaps between stages use.
  | { kind: "into-stage"; stageId: string; index: number }
  | { kind: "unplace" };

/// "step" moves an existing step; "stage" moves a whole GROUP and every
/// member it holds; "card", "tool" and "template" place something from
/// the drawer, whose `id` is a card path, a tool id or a template id.
export type OrchDragKind = "step" | "card" | "tool" | "stage" | "template";

/// True for the drawer kinds -- the ones that have no step id yet, so
/// nothing to detach and nowhere to be "dropped back".
export function isPlacementDrag(kind: OrchDragKind): boolean {
  return kind === "card" || kind === "tool" || kind === "template";
}
```

Replace the band comment above `STAGE_BAND_LO` and the stage loop in
`computeOrchDropTarget`. Two rules, because a group and a single-step
stage are asking different questions:

```ts
/// For a SINGLE-STEP stage the middle band means "group with it" and the
/// outer bands keep meaning before/after, which agrees with the midpoint
/// rule used for the gaps. Same shape as the board's nest interaction, so
/// the app has one drag language.
///
/// A GROUP does not use these at all -- see computeOrchDropTarget.
export const STAGE_BAND_LO = 0.3;
export const STAGE_BAND_HI = 0.7;
```

```ts
export function computeOrchDropTarget(
  pointer: Point,
  rails: MeasuredRail[],
  drawerRect: Rect | null,
  maxSnapPx = 100,
  /// A GROUP cannot be dropped into a group: nested groups are out of
  /// scope, so a "stage" drag skips the stage loop entirely and reads
  /// every stage as a gap.
  kind: OrchDragKind = "step"
): OrchDropTarget | null {
  // ... drawer and nearest-rail logic unchanged ...

  if (kind !== "stage") {
    for (const stage of stages) {
      if (pointer.y < stage.rect.top || pointer.y > stage.rect.top + stage.rect.height) continue;

      if (stage.steps.length >= 2) {
        // A GROUP is all "into", and the slot comes from the MEMBER the
        // pointer is over. The three-band rule cannot serve a group: its
        // members tile it, so the outer bands would swallow the first and
        // last slots and there would be no gesture for either. Before and
        // after the group stay reachable through the connector gaps and
        // through the group's own header strip and padding, which are
        // inside the stage rect but over no member -- the `break` below.
        const overAMember = stage.steps.some(
          (m) => pointer.y >= m.rect.top && pointer.y <= m.rect.top + m.rect.height
        );
        if (!overAMember) break;
      } else {
        // A single-step stage keeps the three bands: the outer ones are
        // the only thing distinguishing "before/after this stage" from
        // "group with it".
        const y = (pointer.y - stage.rect.top) / stage.rect.height;
        if (y < STAGE_BAND_LO || y > STAGE_BAND_HI) break;
      }

      // The slot, by the same midpoint rule the gaps between stages use.
      let index = 0;
      for (const step of stage.steps) {
        if (pointer.y > step.rect.top + step.rect.height / 2) index += 1;
      }
      return { kind: "into-stage", stageId: stage.id, index };
    }
  }

  // ... new-stage index logic unchanged ...
}
```

`stage.steps` here is the MEASURED list, with the dragged chip already
excluded — which is what makes `>= 2` ask the right question. A
two-member group with one member in flight measures as one step and
correctly falls to the three-band rule: it is about to be a single-step
stage, and both of its slots stay reachable through the middle band.

`refreshTarget` in the same file calls `computeOrchDropTarget` — pass the active drag's `kind` through.

- [ ] **Step 4: Measure members and start a stage drag in the glue**

In `app/src/lib/orchestrationDragGlue.ts`, extend the data-attribute contract comment:

```
//   [data-orch-stage-handle] a group header's drag handle; value = stage id
//   [data-orch-template]   a drawer template row; value = the template id
```

Measure members, and exclude the dragged stage for a stage drag:

```ts
/// The dragged step is excluded from measurement, and a stage left with
/// ONLY the dragged step is excluded too -- it is about to disappear, so
/// letting it hold a slot would produce an index one too high. A dragged
/// STAGE is excluded outright, for the same reason.
function measureRails(root: HTMLElement, draggedId: string, kind: OrchDragKind): MeasuredRail[] {
  const rails: MeasuredRail[] = [];
  for (const railEl of root.querySelectorAll("[data-orch-rail]")) {
    const stages: MeasuredStage[] = [];
    for (const stageEl of railEl.querySelectorAll("[data-orch-stage]")) {
      const stageId = stageEl.getAttribute("data-orch-stage") ?? "";
      if (kind === "stage" && stageId === draggedId) continue;
      const steps = [...stageEl.querySelectorAll("[data-orch-step]")];
      const remaining = steps.filter((s) => s.getAttribute("data-orch-step") !== draggedId);
      if (steps.length > 0 && remaining.length === 0) continue;
      stages.push({
        id: stageId,
        position: Number(stageEl.getAttribute("data-orch-stage-pos") ?? "0"),
        rect: toRect(stageEl),
        steps: remaining.map((s) => ({
          id: s.getAttribute("data-orch-step") ?? "",
          rect: toRect(s),
        })),
      });
    }
    rails.push({ id: railEl.getAttribute("data-orch-rail") ?? "", rect: toRect(railEl), stages });
  }
  return rails;
}
```

In `onPointerDown`, add the template row next to the card and tool rows, and the stage handle ahead of the step branch. The handle is checked **before** the `button, input, a, textarea, select` guard, exactly as the drawer rows are, because the handle is a button and also the drag subject:

```ts
    const cardEl = target.closest("[data-orch-card]");
    const toolEl = cardEl ? null : target.closest("[data-orch-tool]");
    const templateEl = cardEl || toolEl ? null : target.closest("[data-orch-template]");
    const handleEl = cardEl || toolEl || templateEl ? null : target.closest("[data-orch-stage-handle]");
```

```ts
    } else if (templateEl) {
      kind = "template";
      itemEl = templateEl;
      draggedId = templateEl.getAttribute("data-orch-template") ?? "";
      sourceStageId = null;
    } else if (handleEl) {
      // A GROUP moves as one unit. `itemEl` is the whole stage, not the
      // handle, so the drag preview is the thing being moved.
      const stageEl = handleEl.closest("[data-orch-stage]");
      if (!stageEl) return;
      kind = "stage";
      itemEl = stageEl;
      draggedId = stageEl.getAttribute("data-orch-stage") ?? "";
      sourceStageId = draggedId;
    } else {
```

and thread the kind into the measure callback:

```ts
      measure: () => measureRails(root, draggedId, kind),
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd app && npx vitest run src/lib/orchestrationDrag.test.ts && npm run check`
Expected: PASS. Fix the `computeOrchDropTarget` and `MeasuredStage` call sites the checker flags (the existing tests build `MeasuredStage` literals and need `steps: []`).

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/orchestrationDrag.ts app/src/lib/orchestrationDragGlue.ts app/src/lib/orchestrationDrag.test.ts
git commit -m "$(cat <<'MSG'
feat(orchestration): drop into a slot, and drag a group as one unit

A drop onto a stage band could only append, which is tolerable for a set
that runs at once and wrong for one that runs in order: the only way to
fix an ordering was to pull a member out and re-drop it. A drop now
lands in a slot, chosen by the member midpoints -- the same rule the
gaps between stages already use.

A group reads its whole rect that way rather than keeping the three-band
rule. Its members tile it, so the outer bands would swallow the first
and last slots and neither would have a gesture at all; before and after
a group stay reachable through the connector gaps and through its own
header strip, which is inside the stage rect and over no member. A
single-step stage keeps the bands, because there the outer ones are the
only thing separating "before this" from "group with this".

The two new drag kinds ride the same vocabulary. A "stage" drag skips
the middle band outright rather than refusing it later -- groups do not
nest, so a stage has no "into" to offer -- and excludes itself from
measurement, which keeps the index it computes the post-removal index
the mutator expects.
MSG
)"
```

---

### Task 9: The group header

**Files:**
- Modify: `app/src/lib/OrchestrationRail.svelte:200-215,297-366,495-545`, `app/src/lib/OrchestrationHubView.svelte:337-370,520-545`
- Test: manual (smoke); the logic it calls is covered by Tasks 4–8.

**Interfaces:**
- Consumes: `stageMode`, `isGroup` (Task 4); the six group actions (Task 7); `featureBlockedReason` (Task 3); the `data-orch-stage-handle` contract (Task 8).
- Produces: `OrchestrationRail` props `onSetStageMode(stageId, mode)`, `onRenameStage(stageId, name)`, `onUngroupStage(stageId)`, `onSaveStageAsTemplate(stageId)`, `groupsBlocked: string | null`.

- [ ] **Step 1: Add the props**

In `OrchestrationRail.svelte`'s `Props` interface and destructuring:

```ts
    /// A group's own controls. The parent owns persistence; this
    /// component only says which stage and what to.
    onSetStageMode: (stageId: string, mode: StageMode) => void;
    onRenameStage: (stageId: string, name: string | null) => void;
    onUngroupStage: (stageId: string) => void;
    onSaveStageAsTemplate: (stageId: string) => void;
    /// Why this daemon cannot carry groups, or null. A daemon older than
    /// v15 has no `mode` column: it accepts a sequential group and hands
    /// it back parallel, so the group would silently run its members at
    /// once in one checkout. The header still renders -- the human should
    /// see the group they built -- but its controls are inert with the
    /// reason on hover.
    groupsBlocked: string | null;
```

- [ ] **Step 2: Render the header**

Replace the stage `<section>` opening and label (`:299-310`):

```svelte
    <section
      class="stage"
      class:group={isGroup(stage)}
      class:parallel={isGroup(stage) && stageMode(stage) === "parallel"}
      class:sequence={isGroup(stage) && stageMode(stage) === "sequence"}
      class:drop-into={intoStage === stage.id}
      data-orch-stage={stage.id}
      data-orch-stage-pos={stage.position}
    >
      {#if isGroup(stage)}
        <div class="group-head">
          <button
            type="button"
            class="grip"
            data-orch-stage-handle={stage.id}
            title={groupsBlocked ?? "Drag to move this group"}
            aria-label="Move this group"
          >
            <GripVertical size={12} />
          </button>
          {#if renamingStage === stage.id}
            <input
              class="group-name-input"
              bind:value={groupDraft}
              use:focusAndSelect
              onblur={() => commitGroupName(stage.id)}
              onkeydown={(e) => {
                if (e.key === "Enter") commitGroupName(stage.id);
                if (e.key === "Escape") renamingStage = null;
              }}
            />
          {:else}
            <button
              type="button"
              class="group-name"
              disabled={Boolean(groupsBlocked)}
              title={groupsBlocked ?? "Rename this group"}
              onclick={() => startGroupRename(stage)}
            >
              {stage.name ?? `stage ${i + 1}`}
            </button>
          {/if}
          <div class="mode-toggle" title={groupsBlocked ?? ""}>
            <button
              type="button"
              class:on={stageMode(stage) === "sequence"}
              disabled={Boolean(groupsBlocked)}
              onclick={() => onSetStageMode(stage.id, "sequence")}>sequence</button
            >
            <button
              type="button"
              class:on={stageMode(stage) === "parallel"}
              disabled={Boolean(groupsBlocked)}
              onclick={() => onSetStageMode(stage.id, "parallel")}>parallel</button
            >
          </div>
          <IconButton
            label="Group actions…"
            disabled={Boolean(groupsBlocked)}
            title={groupsBlocked ?? "Group actions…"}
            onclick={(e) => openGroupMenu(stage, e)}
          >
            <Ellipsis size={13} />
          </IconButton>
        </div>
      {/if}
```

Add to the script block:

```ts
  import { GripVertical, Ellipsis } from "@lucide/svelte";
  import { stageMode, isGroup } from "./orchestration";
  import type { Stage, StageMode } from "./orchestration";
  import { openContextMenu } from "./contextMenu";

  let renamingStage = $state<string | null>(null);
  let groupDraft = $state("");

  function startGroupRename(stage: Stage): void {
    renamingStage = stage.id;
    groupDraft = stage.name ?? "";
  }

  function commitGroupName(stageId: string): void {
    onRenameStage(stageId, groupDraft);
    renamingStage = null;
  }

  /// Save-as-template is disabled when the group carries no TOOL steps:
  /// a template stores tool steps only (grouping spec G7), so there would
  /// be nothing to save and a silent no-op is worse than a dead item that
  /// says why.
  function openGroupMenu(stage: Stage, e: MouseEvent): void {
    const toolSteps = stage.steps.filter((s) => s.toolId).length;
    openContextMenu(e, [
      {
        label: "Save as template…",
        disabled: toolSteps === 0,
        hint: toolSteps === 0 ? "This group has no tool steps to save" : undefined,
        onSelect: () => onSaveStageAsTemplate(stage.id),
      },
      { label: "Ungroup", onSelect: () => onUngroupStage(stage.id) },
    ]);
  }
```

Match `openContextMenu`'s actual entry shape — read `app/src/lib/contextMenu.ts` and follow it exactly rather than the sketch above.

- [ ] **Step 3: Style the two modes**

Replace the `.stage.parallel` rules (`:495-545`) with a `group` base plus the two modes. A **sequence** group stacks its members with the rail's own connector between them, so the ordering reads without the header; a **parallel** group keeps today's side-by-side band.

```css
  /* A single-step stage draws bare; only a GROUP gets a band and a head. */
  .stage.group {
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    padding: var(--space-1);
  }
  .group-head {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    font-size: var(--text-xs);
    color: var(--text-muted);
  }
  .group-name {
    flex: 1;
    text-align: left;
  }
  .stage.parallel .steps {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1);
  }
  .stage.sequence .steps {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }
```

Use the design tokens this file already uses — read the existing rules first and match them; do not invent token names.

- [ ] **Step 4: Wire the parent**

In `OrchestrationHubView.svelte`, compute the gate once and pass it down:

```ts
  const groupsBlocked = $derived(featureBlockedReason($daemonCompat, "groups"));
```

Pass the four callbacks to `<OrchestrationRail>`:

```svelte
        groupsBlocked={groupsBlocked}
        onSetStageMode={(stageId, mode) => void setStageModeAction(workspaceId, stageId, mode)}
        onRenameStage={(stageId, name) => void renameStageAction(workspaceId, stageId, name)}
        onUngroupStage={(stageId) => void ungroupStageAction(workspaceId, stageId)}
        onSaveStageAsTemplate={(stageId) => (savingTemplateFor = stageId)}
```

`savingTemplateFor` is a `$state<string | null>(null)` the dialog in Task 12 consumes; until then it is set and unread, which is fine and compiles.

Extend the drag `commit` to gate grouping drops and handle the stage kind:

```ts
      commit: (drag) => {
        // A drop that would FORM or reorder a group needs a daemon that
        // can store the mode. Refusing here rather than at the mutator
        // keeps one message: the drawer rows and the header say the same
        // thing on hover.
        const wouldGroup =
          drag.target.kind === "into-stage" || drag.kind === "stage" || drag.kind === "template";
        if (wouldGroup && groupsBlocked) {
          orchestrationErrors.update((e) => ({ ...e, [workspaceId]: groupsBlocked }));
          return;
        }
        if (drag.kind === "stage") {
          if (drag.target.kind === "new-stage") {
            void moveStageToIndexAction(workspaceId, drag.id, drag.target.railId, drag.target.index);
          } else if (drag.target.kind === "unplace") {
            void confirmAndRemoveStage(drag.id);
          }
          return;
        }
        // ... the card / tool / step branches, each passing
        //     drag.target.index for into-stage ...
      },
```

`confirmAndRemoveStage` uses the app's existing confirm surface (see `confirmClose.ts` / `ConfirmPrompt.svelte` for the pattern this file already follows) and calls `removeStageAction` on yes — a group is N steps at once, unlike every other `unplace`.

Match `orchestrationErrors`' actual name and shape by reading `orchestrationState.ts` first.

- [ ] **Step 5: Verify**

Run: `cd app && npm test && npm run check && npm run build`
Expected: PASS. There is no unit coverage for the rendered header — that is what Task 13's smoke items are for. Do not claim the header works; claim the suites pass.

- [ ] **Step 6: Commit**

```bash
git add app/src/lib/OrchestrationRail.svelte app/src/lib/OrchestrationHubView.svelte
git commit -m "$(cat <<'MSG'
feat(orchestration): give a group a header it can be steered from

A multi-step stage had no controls at all: it announced "stage 3 --
parallel" and offered nothing. It now carries a drag handle, an editable
name, a sequence/parallel toggle and a menu, so the shape the human
built is the shape they can change.

A sequence group stacks its members behind the rail's own connector and
a parallel one keeps the side-by-side band, so the discipline is legible
without reading the toggle.

Every control reads the groups gate. Against a v14 daemon the header
still renders -- the human should see the group they built -- but the
controls are inert with the reason on hover, and a grouping DROP is
refused in the commit handler so the drawer, the header and the drop all
say the same thing.
MSG
)"
```

---

### Task 10: Group templates on the wire and on disk

**Files:**
- Modify: `crates/protocol/src/lib.rs` (types, 3 requests, `Response::GroupTemplates`, `min_version_for`), `crates/daemon/src/orchestration.rs` (table + CRUD), `crates/daemon/src/server.rs` (manager + `handle_request`)
- Test: all three files' test modules

**Interfaces:**
- Consumes: `StageMode` (Task 1).
- Produces:
  - `protocol::GroupTemplateStep { tool_id: String, tool_params: HashMap<String, String> }`
  - `protocol::GroupTemplate { id, workspace_id: Option<String>, name, description, mode: StageMode, steps: Vec<GroupTemplateStep>, position: i64 }`
  - `Request::GetGroupTemplates { workspace_id }`, `Request::SaveGroupTemplate { template }`, `Request::DeleteGroupTemplate { id }` — all `min_version_for == 15`
  - `Response::GroupTemplates { templates: Vec<GroupTemplate> }`
  - `OrchestrationStore::group_templates(&self, workspace_id) -> Result<Vec<GroupTemplate>>`, `save_group_template(&mut self, &GroupTemplate)`, `delete_group_template(&mut self, id)`

- [ ] **Step 1: Write the failing tests**

In `crates/protocol/src/lib.rs`'s tests, extend the existing exhaustive request list (the one at `:1577`) with the three new variants and assert their version:

```rust
#[test]
fn group_template_requests_are_v15() {
    for req in [
        Request::GetGroupTemplates { workspace_id: "w".into() },
        Request::SaveGroupTemplate { template: a_group_template() },
        Request::DeleteGroupTemplate { id: "g1".into() },
    ] {
        assert_eq!(min_version_for(&req), 15, "{req:?}");
    }
}

fn a_group_template() -> GroupTemplate {
    GroupTemplate {
        id: "g1".into(),
        workspace_id: Some("ws-1".into()),
        name: "Merge and push".into(),
        description: "Land it, then push".into(),
        mode: "sequence".into(),
        steps: vec![GroupTemplateStep {
            tool_id: "builtin:push".into(),
            tool_params: HashMap::from([("remote".into(), "origin".into())]),
        }],
        position: 0,
    }
}
```

In `crates/daemon/src/orchestration.rs`'s tests:

```rust
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
```

Write `a_group_template(id, workspace_id)` as a local helper in that tests module mirroring the protocol one above.

In `crates/daemon/src/server.rs`'s tests, one round-trip through `handle_request`, mirroring `save_tool_then_get_tools_round_trips_through_handle_request` at `:1804`:

```rust
#[test]
fn save_then_get_group_templates_round_trips_through_handle_request() {
    let manager = a_manager();
    assert!(matches!(
        handle_request(&manager, Request::SaveGroupTemplate { template: a_group_template("g1", Some("ws-1")) }),
        Response::Ok
    ));
    match handle_request(&manager, Request::GetGroupTemplates { workspace_id: "ws-1".into() }) {
        Response::GroupTemplates { templates } => assert_eq!(templates.len(), 1),
        other => panic!("expected GroupTemplates, got {other:?}"),
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test --workspace 2>&1 | head -30`
Expected: FAIL — `GroupTemplate` is not defined.

- [ ] **Step 3: Add the protocol types and requests**

In `crates/protocol/src/lib.rs`, next to `ToolDef`:

```rust
/// One member of a group template: a tool and the overrides it carries.
/// Deliberately NOT a Step -- step ids are run-state keys and must be
/// minted fresh at every placement, and a card path has no meaning in a
/// template (grouping spec G7).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GroupTemplateStep {
    pub tool_id: String,
    #[serde(default)]
    pub tool_params: HashMap<String, String>,
}

/// A reusable group droppable onto a rail -- merge + push, commit +
/// test. `workspace_id` is the SCOPE, exactly as it is for a ToolDef:
/// Some(id) is that workspace's own, None is global to this machine
/// (grouping spec G8). There are no built-in templates.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GroupTemplate {
    pub id: String,
    pub workspace_id: Option<String>,
    pub name: String,
    pub description: String,
    pub mode: StageMode,
    pub steps: Vec<GroupTemplateStep>,
    pub position: i64,
}
```

Add the three `Request` variants next to the tool ones:

```rust
    /// This workspace's group templates PLUS every global one, per
    /// GetTools. Never an error for an unknown workspace -- an empty list.
    GetGroupTemplates {
        workspace_id: String,
    },
    /// Upsert by id. `workspace_id: None` stores it global to this
    /// machine; re-saving with the other value is how a template changes
    /// scope.
    SaveGroupTemplate {
        template: GroupTemplate,
    },
    DeleteGroupTemplate {
        id: String,
    },
```

Add the response variant next to `Tools`:

```rust
    GroupTemplates { templates: Vec<GroupTemplate> },
```

Add the `min_version_for` arm after the `Shutdown => 12` / archive arms:

```rust
        // Group templates. v15 also widened Stage with `mode` and
        // `name`, which are serde-defaulted and therefore invisible to
        // this match -- daemonCompat.ts gates the UI on `groups: 15` for
        // exactly that reason. These three are what a v14 daemon
        // genuinely cannot serve.
        Request::DeleteGroupTemplate { .. }
        | Request::GetGroupTemplates { .. }
        | Request::SaveGroupTemplate { .. } => 15,
```

- [ ] **Step 4: Add the table and the CRUD**

In `crates/daemon/src/orchestration.rs`'s `execute_batch`:

```sql
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
```

Then the three methods, directly after `delete_tool`:

```rust
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
```

Add `GroupTemplate, GroupTemplateStep, default_stage_mode` to the file's `use protocol::{…}` line.

- [ ] **Step 5: Add the manager wrappers and request arms**

In `crates/daemon/src/server.rs`, next to the tool wrappers:

```rust
    pub fn group_templates(&self, workspace_id: &str) -> anyhow::Result<Vec<protocol::GroupTemplate>> {
        self.orchestration.lock().unwrap().group_templates(workspace_id)
    }

    pub fn save_group_template(&self, template: protocol::GroupTemplate) -> anyhow::Result<()> {
        self.orchestration.lock().unwrap().save_group_template(&template)
    }

    pub fn delete_group_template(&self, id: &str) -> anyhow::Result<()> {
        self.orchestration.lock().unwrap().delete_group_template(id)
    }
```

In `handle_request`, next to the tool arms at `:1482`:

```rust
        Request::GetGroupTemplates { workspace_id } => manager
            .group_templates(&workspace_id)
            .map(|templates| Response::GroupTemplates { templates }),
        Request::SaveGroupTemplate { template } => {
            manager.save_group_template(template).map(|_| Response::Ok)
        }
        Request::DeleteGroupTemplate { id } => {
            manager.delete_group_template(&id).map(|_| Response::Ok)
        }
```

Follow the exact error-wrapping shape the neighbouring tool arms use.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cargo test --workspace`
Expected: PASS. Re-run `cargo test -p gavin-daemon --lib gavin::tests` alone if that module fails.

- [ ] **Step 7: Commit**

```bash
git add crates/protocol/src/lib.rs crates/daemon/src/orchestration.rs crates/daemon/src/server.rs
git commit -m "$(cat <<'MSG'
feat(daemon): store reusable group templates

A group like merge + push is rebuilt by hand on every rail that wants
it. Templates make it a thing you place once: an ordered list of tool
steps and the discipline they run under, scoped to one workspace or
global to the machine.

The shape is the tool library's, deliberately, because the problem is
the same one: workspace_id IS the scope, re-saving with the other value
is how something moves between scopes, and the store is targeted rather
than replaced wholesale because a template outlives every arrangement
that uses it.

Members are a JSON column rather than a child table -- a template is
only ever read and written whole -- and an unreadable one degrades to an
empty, deletable row instead of failing the library read.
MSG
)"
```

---

### Task 11: The template library in the app

**Files:**
- Create: `app/src/lib/orchestrationGroups.ts`, `app/src/lib/orchestrationGroups.test.ts`, `app/src/lib/groupTemplatesState.ts`, `app/src/lib/groupTemplatesState.test.ts`
- Modify: `app/src/lib/backend.ts` (after `deleteTool`), `app/src-tauri/src/session.rs` (after `delete_tool`), `app/src-tauri/src/lib.rs:90`
- Test: the two new test files

**Interfaces:**
- Consumes: `Stage`, `StageMode`, `stageMode`, `Step`, `stepParams`, `isToolStep` (Task 4); the wire types (Task 10).
- Produces:
  - `GroupTemplateStep { toolId: string; toolParams: Record<string, string> }`
  - `GroupTemplate { id, name, description, mode, steps, scope: "workspace" | "global" }`
  - `GroupTemplateRecord { id, workspaceId: string | null, name, description, mode, steps, position }`
  - `templateLibrary(records: GroupTemplateRecord[]): GroupTemplate[]`
  - `toTemplateRecord(t: GroupTemplate, workspaceId: string, position: number): GroupTemplateRecord`
  - `templateFromStage(stage: Stage, name: string, description: string, scope): GroupTemplate` — tool steps only
  - `droppedCardCount(stage: Stage): number`
  - `stepsFromTemplate(t: GroupTemplate, mintId: () => string): Step[]`
  - store `groupTemplateRecords`, `libraryFor`, `fetchGroupTemplates`, `refreshGroupTemplates`, `saveGroupTemplateAction`, `deleteGroupTemplateAction`, `__resetForTesting`

- [ ] **Step 1: Write the failing tests**

`app/src/lib/orchestrationGroups.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  templateLibrary,
  toTemplateRecord,
  templateFromStage,
  droppedCardCount,
  stepsFromTemplate,
} from "./orchestrationGroups";
import type { GroupTemplate, GroupTemplateRecord } from "./orchestrationGroups";
import type { Stage } from "./orchestration";

function record(over: Partial<GroupTemplateRecord> = {}): GroupTemplateRecord {
  return {
    id: "g1",
    workspaceId: "ws-1",
    name: "Merge and push",
    description: "",
    mode: "sequence",
    steps: [{ toolId: "builtin:push", toolParams: { remote: "origin" } }],
    position: 0,
    ...over,
  };
}

describe("templateLibrary", () => {
  it("derives scope from workspaceId", () => {
    // Same rule as ToolScope: the daemon stores the id, the app labels it.
    const lib = templateLibrary([record(), record({ id: "g2", workspaceId: null })]);
    expect(lib.map((t) => t.scope)).toEqual(["workspace", "global"]);
  });

  it("orders workspace templates before global ones, each alphabetical", () => {
    const lib = templateLibrary([
      record({ id: "a", workspaceId: null, name: "Zebra" }),
      record({ id: "b", workspaceId: null, name: "Alpha" }),
      record({ id: "c", workspaceId: "ws-1", name: "Nomad" }),
    ]);
    expect(lib.map((t) => t.name)).toEqual(["Nomad", "Alpha", "Zebra"]);
  });
});

describe("toTemplateRecord", () => {
  it("maps global scope to a null workspaceId", () => {
    const t: GroupTemplate = {
      id: "g1", name: "Merge and push", description: "", mode: "sequence",
      steps: [{ toolId: "builtin:push", toolParams: {} }], scope: "global",
    };
    expect(toTemplateRecord(t, "ws-1", 3).workspaceId).toBeNull();
    expect(toTemplateRecord(t, "ws-1", 3).position).toBe(3);
  });

  it("maps workspace scope to the workspace id", () => {
    const t: GroupTemplate = {
      id: "g1", name: "Merge and push", description: "", mode: "sequence",
      steps: [{ toolId: "builtin:push", toolParams: {} }], scope: "workspace",
    };
    expect(toTemplateRecord(t, "ws-1", 0).workspaceId).toBe("ws-1");
  });
});

describe("templateFromStage", () => {
  const mixed: Stage = {
    id: "s1",
    position: 0,
    mode: "sequence",
    name: "Land it",
    steps: [
      { id: "t1", position: 0, cardPath: "", toolId: "builtin:merge-into", toolParams: { base: "main" } },
      { id: "t2", position: 1, cardPath: "/ws/plans/a.md", toolId: null, toolParams: {} },
      { id: "t3", position: 2, cardPath: "", toolId: "builtin:push", toolParams: {} },
    ],
  };

  it("keeps the tool steps, in order, with their overrides", () => {
    const t = templateFromStage(mixed, "Merge and push", "", "workspace");
    expect(t.steps).toEqual([
      { toolId: "builtin:merge-into", toolParams: { base: "main" } },
      { toolId: "builtin:push", toolParams: {} },
    ]);
  });

  it("carries the group's mode", () => {
    expect(templateFromStage(mixed, "x", "", "workspace").mode).toBe("sequence");
  });

  it("excludes card steps, and says how many it dropped", () => {
    // A card step is an absolute path into one workspace, so it can
    // never be a template member (G7) -- and a template that silently
    // lost half a group would be worse than one that refused to save.
    expect(templateFromStage(mixed, "x", "", "workspace").steps).toHaveLength(2);
    expect(droppedCardCount(mixed)).toBe(1);
  });
});

describe("stepsFromTemplate", () => {
  it("mints a fresh id per member and numbers them in order", () => {
    // Step ids are run-state keys: reusing one would graft a finished
    // run onto a step that has not started.
    let n = 0;
    const steps = stepsFromTemplate(
      {
        id: "g1", name: "Merge and push", description: "", mode: "sequence", scope: "workspace",
        steps: [
          { toolId: "builtin:merge-into", toolParams: { base: "main" } },
          { toolId: "builtin:push", toolParams: {} },
        ],
      },
      () => `new-${n++}`
    );
    expect(steps).toEqual([
      { id: "new-0", position: 0, cardPath: "", toolId: "builtin:merge-into", toolParams: { base: "main" } },
      { id: "new-1", position: 1, cardPath: "", toolId: "builtin:push", toolParams: {} },
    ]);
  });
});
```

`app/src/lib/groupTemplatesState.test.ts`: mirror `app/src/lib/toolsState.test.ts` exactly — mock `./backend`, assert that `saveGroupTemplateAction` calls `backend.saveGroupTemplate` with the record and then refreshes every loaded workspace, that a save error comes back as a string rather than throwing, and that `libraryFor` returns `null` before the first fetch (the scheduler must be able to tell loading from empty).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd app && npx vitest run src/lib/orchestrationGroups.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `orchestrationGroups.ts`**

```ts
// The group-template library, as pure data and pure functions (grouping
// spec G7/G8). No Svelte, no Tauri, no I/O -- groupTemplatesState.ts owns
// every side effect. TS mirrors of crates/protocol's GroupTemplate
// (camelCase on the wire).
//
// A template is a group you can place again: an ordered list of TOOL
// steps and the discipline they run under. There are no built-ins --
// every template is something the human saved off a group they built.

import { stageMode, stepParams, isToolStep } from "./orchestration";
import type { Stage, StageMode, Step } from "./orchestration";

/// Where a template came from. Derived from the wire's `workspaceId`,
/// never stored: null is global, a string is that workspace's own.
export type GroupTemplateScope = "workspace" | "global";

export interface GroupTemplateStep {
  toolId: string;
  toolParams: Record<string, string>;
}

export interface GroupTemplate {
  id: string;
  name: string;
  description: string;
  mode: StageMode;
  steps: GroupTemplateStep[];
  scope: GroupTemplateScope;
}

/// One template as the daemon stores it. `workspaceId` IS the scope.
export interface GroupTemplateRecord {
  id: string;
  workspaceId: string | null;
  name: string;
  description: string;
  mode: StageMode;
  steps: GroupTemplateStep[];
  position: number;
}

/// The library, in the order the drawer shows it: this workspace's own
/// first, then the machine's, each alphabetical -- a stable order, so a
/// template stays where the human last saw it.
export function templateLibrary(records: GroupTemplateRecord[]): GroupTemplate[] {
  const rank = (t: GroupTemplate) => (t.scope === "workspace" ? 0 : 1);
  return records
    .map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      mode: r.mode === "sequence" ? ("sequence" as const) : ("parallel" as const),
      steps: r.steps,
      scope: (r.workspaceId === null ? "global" : "workspace") as GroupTemplateScope,
    }))
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

export function toTemplateRecord(
  t: GroupTemplate,
  workspaceId: string,
  position: number
): GroupTemplateRecord {
  if (t.name.trim() === "") throw new Error("A template needs a name.");
  if (t.steps.length === 0) throw new Error("A template needs at least one tool step.");
  return {
    id: t.id,
    workspaceId: t.scope === "global" ? null : workspaceId,
    name: t.name.trim(),
    description: t.description.trim(),
    mode: t.mode,
    steps: t.steps,
    position,
  };
}

/// A template built from a group the human already arranged. CARD steps
/// are excluded (G7): a card path is absolute and belongs to one
/// workspace, so it can never travel. Pair this with droppedCardCount so
/// the form can say what it left behind -- a template that silently lost
/// half a group is worse than one that refuses to save.
export function templateFromStage(
  stage: Stage,
  name: string,
  description: string,
  scope: GroupTemplateScope
): GroupTemplate {
  return {
    id: crypto.randomUUID(),
    name,
    description,
    mode: stageMode(stage),
    steps: [...stage.steps]
      .sort((a, b) => a.position - b.position)
      .filter(isToolStep)
      .map((s) => ({ toolId: s.toolId as string, toolParams: { ...stepParams(s) } })),
    scope,
  };
}

/// How many of this group's steps a template would have to leave behind.
export function droppedCardCount(stage: Stage): number {
  return stage.steps.filter((s) => !isToolStep(s)).length;
}

/// The steps a placement mints. Ids are FRESH every time: a step id is a
/// run-state key, so reusing one would graft a finished run onto a step
/// that has not started. `mintId` is injected so tests can be
/// deterministic; production passes crypto.randomUUID.
export function stepsFromTemplate(t: GroupTemplate, mintId: () => string): Step[] {
  return t.steps.map((s, i) => ({
    id: mintId(),
    position: i,
    cardPath: "",
    toolId: s.toolId,
    toolParams: { ...s.toolParams },
  }));
}
```

- [ ] **Step 4: Write `groupTemplatesState.ts`**

Copy `app/src/lib/toolsState.ts` structurally and substitute the template names. Two deliberate differences from the tool version, each worth its comment:

```ts
/// Null means "not fetched yet". Unlike the tool library there is no
/// built-in fallback to render meanwhile: a workspace with no templates
/// and a workspace whose templates have not loaded look the same, and
/// showing an empty Groups section for a beat is honest.
export const groupTemplateRecords = writable<Record<string, GroupTemplateRecord[] | null>>({});
```

```ts
/// Every loaded workspace re-reads. A GLOBAL template saved here belongs
/// to all of them, and there is no push for template writes -- they
/// always originate in this app.
async function refreshEveryWorkspace(): Promise<void> { /* per toolsState */ }
```

`saveGroupTemplateAction(workspaceId, template)` and `deleteGroupTemplateAction(workspaceId, id)` mirror `saveToolAction`/`deleteToolAction`, minus the built-in guards — there are no built-in templates.

- [ ] **Step 5: Add the bridge**

`app/src/lib/backend.ts`, after `deleteTool`:

```ts
// --- Group templates --------------------------------------------------------

export function getGroupTemplates(workspaceId: string): Promise<GroupTemplateRecord[]> {
  return invoke("get_group_templates", { workspaceId });
}

export function saveGroupTemplate(template: GroupTemplateRecord): Promise<void> {
  return invoke("save_group_template", { template });
}

export function deleteGroupTemplate(id: string): Promise<void> {
  return invoke("delete_group_template", { id });
}
```

`app/src-tauri/src/session.rs`, after `delete_tool` — three commands copied from the tool ones, substituting `Request::GetGroupTemplates` / `SaveGroupTemplate` / `DeleteGroupTemplate` and `Response::GroupTemplates { templates }`, with this comment above them:

```rust
// --- Group templates --------------------------------------------------------
//
// v15 requests, so against a v14 daemon they fail LOCALLY through the
// gated path rather than putting bytes on a socket that cannot parse
// them. The UI is already dark there (FEATURE_MIN_VERSION.groups), so
// this is the belt to that braces.
```

Register all three in `app/src-tauri/src/lib.rs`'s `invoke_handler` list after `session::delete_tool`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd app && npx vitest run src/lib/orchestrationGroups.test.ts src/lib/groupTemplatesState.test.ts && npm run check && cargo check --manifest-path app/src-tauri/Cargo.toml`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add app/src/lib/orchestrationGroups.ts app/src/lib/orchestrationGroups.test.ts app/src/lib/groupTemplatesState.ts app/src/lib/groupTemplatesState.test.ts app/src/lib/backend.ts app/src-tauri/src/session.rs app/src-tauri/src/lib.rs
git commit -m "$(cat <<'MSG'
feat(app): the group template library

The pure half (what a template IS, how a group becomes one, how one
becomes steps) and the reactive half (the store and its persistence),
split the way orchestration.ts and orchestrationState.ts already are.

Two rules are worth stating out loud because getting them wrong is
silent. A template keeps only tool steps, since a card path is absolute
and belongs to one workspace -- and it reports how many it dropped, so
the form can say so rather than saving half a group. And a placement
mints fresh step ids every time, because a step id is a run-state key:
reusing one would graft a finished run onto a step that never started.
MSG
)"
```

---

### Task 12: Templates in the drawer, the save form and the manager

**Files:**
- Create: `app/src/lib/GroupTemplateSaveDialog.svelte`
- Modify: `app/src/lib/OrchestrationDrawer.svelte`, `app/src/lib/ToolLibraryDialog.svelte`, `app/src/lib/OrchestrationHubView.svelte`, `app/src/lib/orchestrationState.ts`
- Test: `app/src/lib/orchestrationState.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 7, 8, 11.
- Produces:
  - `addTemplateAsStageAction(workspaceId, railId, index, template: GroupTemplate): Promise<string | null>`
  - `addTemplateToStageAction(workspaceId, stageId, index, template: GroupTemplate): Promise<string | null>`
  - `insertStageWithSteps(orch, railId, index, stage: Stage): Orchestration` in `orchestration.ts`
  - `OrchestrationDrawer` props `templates: GroupTemplate[]`, `onAddTemplate(templateId)`, `onManageTemplates()`, `groupsBlocked: string | null`

- [ ] **Step 1: Write the failing tests**

In `app/src/lib/orchestration.test.ts`:

```ts
describe("insertStageWithSteps", () => {
  it("places a whole group at the index and renumbers", () => {
    const o = addRail(emptyOrchestration(), "r1", "backend");
    const stage: Stage = {
      id: "s-new",
      position: 0,
      mode: "sequence",
      name: "Merge and push",
      steps: [
        { id: "t1", position: 0, cardPath: "", toolId: "builtin:merge-into", toolParams: {} },
        { id: "t2", position: 1, cardPath: "", toolId: "builtin:push", toolParams: {} },
      ],
    };
    const after = insertStageWithSteps(o, "r1", 0, stage);
    expect(after.rails[0].stages[0].name).toBe("Merge and push");
    expect(after.rails[0].stages[0].steps).toHaveLength(2);
  });
});
```

In `app/src/lib/orchestrationState.test.ts`:

```ts
it("addTemplateAsStageAction places the template as its own group", async () => {
  const t: GroupTemplate = {
    id: "g1", name: "Merge and push", description: "", mode: "sequence", scope: "workspace",
    steps: [{ toolId: "builtin:merge-into", toolParams: {} }, { toolId: "builtin:push", toolParams: {} }],
  };
  expect(await addTemplateAsStageAction("ws-1", "r1", 0, t)).toBeNull();
  const stage = get(orchestrations)["ws-1"].rails[0].stages[0];
  expect(stage.name).toBe("Merge and push");
  expect(stageMode(stage)).toBe("sequence");
  expect(stage.steps.map((s) => s.toolId)).toEqual(["builtin:merge-into", "builtin:push"]);
});

it("addTemplateToStageAction merges the members into an existing group at the index", async () => {
  // seeded: s1 holds t1
  const t: GroupTemplate = {
    id: "g1", name: "Merge and push", description: "", mode: "sequence", scope: "workspace",
    steps: [{ toolId: "builtin:push", toolParams: {} }],
  };
  await addTemplateToStageAction("ws-1", "s1", 0, t);
  const stage = findStage(get(orchestrations)["ws-1"], "s1") as Stage;
  expect(stage.steps[0].toolId).toBe("builtin:push");
  // Joining a single-step stage forms a sequence group (G3).
  expect(stageMode(stage)).toBe("sequence");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd app && npx vitest run src/lib/orchestration.test.ts src/lib/orchestrationState.test.ts`
Expected: FAIL — `insertStageWithSteps` is not exported.

- [ ] **Step 3: Add the mutator and the two actions**

In `orchestration.ts`, next to `insertAsStage`:

```ts
/// Place a fully-formed stage -- a template's group, steps and all -- at
/// `index` in `railId`. The multi-step twin of insertAsStage.
export function insertStageWithSteps(
  orch: Orchestration,
  railId: string,
  index: number,
  stage: Stage
): Orchestration {
  if (!orch.rails.some((r) => r.id === railId)) return orch;
  return {
    ...orch,
    rails: orch.rails.map((r) => {
      if (r.id !== railId) return r;
      const stages = [...r.stages];
      const at = Math.max(0, Math.min(index, stages.length));
      stages.splice(at, 0, { ...stage, position: at, steps: renumber(stage.steps) });
      return { ...r, stages: renumber(stages) };
    }),
  };
}
```

In `orchestrationState.ts`:

```ts
/// A template dropped into a gap: its members become a group of their
/// own, carrying the template's name and mode.
export function addTemplateAsStageAction(
  workspaceId: string,
  railId: string,
  index: number,
  template: GroupTemplate
): Promise<string | null> {
  return mutatePlan(workspaceId, (o) =>
    insertStageWithSteps(o, railId, index, {
      id: crypto.randomUUID(),
      position: index,
      mode: template.mode,
      name: template.name,
      steps: stepsFromTemplate(template, () => crypto.randomUUID()),
    })
  );
}

/// A template dropped ONTO a stage: its members join that group at
/// `index`, in order. The group's own name and mode win -- the human
/// arranged that group, and a template merged into it is an addition,
/// not a replacement.
export async function addTemplateToStageAction(
  workspaceId: string,
  stageId: string,
  index: number,
  template: GroupTemplate
): Promise<string | null> {
  const error = await mutatePlan(workspaceId, (o) => {
    const minted = stepsFromTemplate(template, () => crypto.randomUUID());
    // Two passes because addToolStep places a step and setStepParams
    // gives it its overrides -- one mutatePlan, so it is still one write.
    const placed = minted.reduce(
      (acc, step, i) => addToolStep(acc, stageId, step.id, step.toolId as string, index + i),
      o
    );
    return minted.reduce((acc, step) => setStepParams(acc, step.id, step.toolParams ?? {}), placed);
  });
  if (!error) await startIfStageRunning(workspaceId, stageId);
  return error;
}
```

- [ ] **Step 4: The drawer's Groups section**

In `OrchestrationDrawer.svelte`, add the props and a section above Tools, copying the Tools section's markup and swapping the attribute:

```svelte
    <div class="row" data-orch-template={t.id} title={groupsBlocked ?? t.description}>
```

Rows are visible but carry no drag handle when `groupsBlocked` is set, exactly as `toolsBlocked` already does for tools. Add a **Manage** button calling `onManageTemplates`.

Header copy: `Groups (N)`, with a scope caption per row (`this workspace` / `all workspaces`) matching how the tools rows label kind.

- [ ] **Step 5: The save dialog**

`app/src/lib/GroupTemplateSaveDialog.svelte` — a small modal following `ToolLibraryDialog`'s form conventions:

```svelte
<script lang="ts">
  import { templateFromStage, droppedCardCount } from "./orchestrationGroups";
  import type { GroupTemplateScope } from "./orchestrationGroups";
  import type { Stage } from "./orchestration";

  interface Props {
    stage: Stage;
    onSave: (name: string, description: string, scope: GroupTemplateScope) => Promise<string | null>;
    onClose: () => void;
  }
  let { stage, onSave, onClose }: Props = $props();

  let name = $state(stage.name ?? "");
  let description = $state("");
  let scope = $state<GroupTemplateScope>("workspace");
  let error = $state<string | null>(null);

  // A template keeps tool steps only, so a mixed group loses its cards.
  // Saying so is the point: a template that silently lost half a group
  // would be worse than one that refused.
  const dropped = $derived(droppedCardCount(stage));
  const keeping = $derived(templateFromStage(stage, "x", "", "workspace").steps.length);
</script>
```

The body renders the name field, the description field, a two-button scope picker (`This workspace` / `All workspaces`, mirroring `ToolLibraryDialog:226-240`), the member list, and — when `dropped > 0` — the line:

```
Saving {keeping} tool steps. {dropped} card steps are not saved: a card belongs to this workspace, so it cannot travel in a template.
```

Save is disabled when `name.trim() === ""` or `keeping === 0`; `error` renders the string `onSave` returns.

Host it in `OrchestrationHubView.svelte` off the `savingTemplateFor` state Task 9 introduced, resolving the stage with `findStage`.

- [ ] **Step 6: The manager tab**

In `ToolLibraryDialog.svelte`, add a tab strip above the existing body with `Tools` and `Groups`, defaulting to `Tools`. The Groups pane lists templates by the same two scope sections (`This workspace`, `All workspaces` — there is no built-in section) with, per row: name, description, member count, and Edit (name/description/scope, and reorder members by remove) plus Delete. Reuse the file's existing row and form markup rather than inventing new patterns.

- [ ] **Step 7: Wire the template drag**

In `OrchestrationHubView.svelte`'s drag `commit`, add the branch:

```ts
        if (drag.kind === "template") {
          const template = templates.find((t) => t.id === drag.id);
          if (!template) return;
          if (drag.target.kind === "into-stage") {
            void addTemplateToStageAction(workspaceId, drag.target.stageId, drag.target.index, template);
          } else if (drag.target.kind === "new-stage") {
            void addTemplateAsStageAction(workspaceId, drag.target.railId, drag.target.index, template);
          }
          return;
        }
```

placed after the existing `groupsBlocked` guard, which already covers `drag.kind === "template"`.

Call `fetchGroupTemplates(workspaceId)` where the tab already calls `fetchTools(workspaceId)`.

- [ ] **Step 8: Verify**

Run: `cd app && npm test && npm run check && npm run build`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add app/src/lib/GroupTemplateSaveDialog.svelte app/src/lib/OrchestrationDrawer.svelte app/src/lib/ToolLibraryDialog.svelte app/src/lib/OrchestrationHubView.svelte app/src/lib/orchestration.ts app/src/lib/orchestration.test.ts app/src/lib/orchestrationState.ts app/src/lib/orchestrationState.test.ts
git commit -m "$(cat <<'MSG'
feat(orchestration): place, save and manage group templates

The drawer grows a Groups section above Tools, dragged onto a rail the
same way: into a gap it becomes a group of its own carrying the
template's name and mode; onto an existing group its members join at the
drop slot, and the group the human arranged keeps its own name and mode
because a merged template is an addition, not a replacement.

Saving reports what it cannot keep. A mixed group loses its card steps,
and the form says how many and why, rather than writing a template that
is quietly half the group it was made from.

Management rides in the tool library dialog as a second tab: it is the
same question about the same two scopes, and a second dialog would only
mean a second place to look.
MSG
)"
```

---

### Task 13: MCP fidelity and the smoke items

**Files:**
- Modify: `crates/gavin-mcp/src/main.rs:193-195,493-541`, `app/src/lib/smokeChecklist.ts`
- Test: `crates/gavin-mcp/src/main.rs` tests, `app/src/lib/smokeChecklist.test.ts`

**Interfaces:**
- Consumes: `protocol::Stage { mode, name }` (Task 1).
- Produces: `gavin_get_orchestration` emits `mode` and `name` per stage; `gavin_set_orchestration`'s schema documents both.

- [ ] **Step 1: Write the failing test**

In `crates/gavin-mcp/src/main.rs`'s tests, extend the orchestration-shape test at `:1027`:

```rust
#[test]
fn get_orchestration_reports_each_stages_mode_and_name() {
    // gavin_set_orchestration replaces the arrangement WHOLESALE, so an
    // agent that cannot read a stage's mode cannot preserve it -- and
    // every group in the workspace flattens to parallel on its first
    // rewrite.
    // (build the fixture the neighbouring tests build, with
    //  stages[0].mode = "sequence" and name = Some("Merge and push"))
    assert_eq!(text["rails"][0]["stages"][0]["mode"], "sequence");
    assert_eq!(text["rails"][0]["stages"][0]["name"], "Merge and push");
}

#[test]
fn set_orchestration_preserves_a_stage_mode_it_is_given() {
    let json = r#"[{"id":"r1","name":"backend","position":0,"worktreePath":null,"pageId":null,
      "stages":[{"id":"s1","position":0,"mode":"sequence","name":"Merge and push",
      "steps":[{"id":"t1","position":0,"cardPath":"/ws/a.md"}]}]}]"#;
    // parse through the same path the neighbouring set_orchestration
    // tests use, then:
    assert_eq!(rails[0].stages[0].mode, "sequence");
    assert_eq!(rails[0].stages[0].name.as_deref(), Some("Merge and push"));
}
```

In `app/src/lib/smokeChecklist.test.ts`, follow the file's existing shape test (unique ids, non-empty text).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p gavin-mcp`
Expected: FAIL — the emitted stage object has no `mode` key.

- [ ] **Step 3: Emit and document the fields**

In the stage projection at `:493-541`, add both keys next to `"steps"`:

```rust
                    "mode": stage.mode,
                    "name": stage.name,
```

Update the two tool descriptions at `:194-195`:

```rust
        { "name": "gavin_set_orchestration", "description": "Replace the workspace's orchestration wholesale: rails of stages of steps, plus your own conflict notes. Read gavin_get_orchestration first and preserve the ids of steps you are keeping — run state follows the id — AND each stage's `mode` and `name`: omitting `mode` reverts that stage to `parallel`, which turns a sequential group into steps that all run at once in one checkout. Removing a step whose run state is 'running' is refused.", ... }
```

```rust
            "rails": { "type": "array", "description": "Ordered rails. Each: { id, name, position, worktreePath, pageId, stages: [{ id, position, mode, name, steps: [...] }] }. A step is EITHER a card step { id, position, cardPath } OR a tool step { id, position, toolId, toolParams: { name: value } } — never both. Stages run one after another. A stage's `mode` is \"parallel\" (its steps run at once in the rail's checkout) or \"sequence\" (one at a time, in position order); a stage of two or more steps is what the app calls a GROUP, and `name` is what it is called. `mode` defaults to \"parallel\" when omitted.", "items": { "type": "object" } },
```

- [ ] **Step 4: Add the smoke items**

In `app/src/lib/smokeChecklist.ts`, add a section after the orchestration one:

```ts
  {
    title: "Orchestration groups",
    items: [
      {
        id: "group-form-sequence",
        text: "Dropping a card onto another forms a group whose header says “sequence”, with both cards stacked in drop order",
        hint: "Dropping into the gap ABOVE or BELOW a stage still makes a separate stage — only the middle band groups.",
      },
      {
        id: "group-reorder-member",
        text: "Dragging a member onto the top half of the other member swaps their order inside the group",
      },
      {
        id: "group-toggle-parallel",
        text: "The header's parallel button re-lays the members side by side, and the conflicts panel reports the stage again",
        hint: "A sequence group is deliberately NOT a same-worktree conflict; flipping to parallel brings the badge back.",
      },
      {
        id: "group-rename",
        text: "Clicking the group's name edits it; clearing it falls back to “stage N”",
      },
      {
        id: "group-drag-whole",
        text: "Dragging the group's grip moves every member together, to another position and to another rail",
      },
      {
        id: "group-runs-in-order",
        text: "Starting a rail on a sequence group launches ONE member; the next launches only when the first finishes",
        hint: "Two tool steps (e.g. Commit then Push) make this visible without waiting on a card.",
      },
      {
        id: "group-ungroup",
        text: "⋯ → Ungroup leaves one stage per member, in order, with the name gone",
      },
      {
        id: "group-save-template",
        text: "⋯ → Save as template… on a group of tool steps offers This workspace / All workspaces and the template appears in the drawer's Groups section",
      },
      {
        id: "group-template-mixed",
        text: "Saving a group that also holds CARDS says how many card steps it is not saving, and why",
      },
      {
        id: "group-template-place",
        text: "Dragging a template into a gap places it as a named group; dropping it onto an existing group merges its members at the drop slot",
      },
      {
        id: "group-template-manage",
        text: "Tool library → Groups tab renames, re-scopes and deletes a template; a global one is visible from a second workspace",
      },
      {
        id: "group-gate-old-daemon",
        text: "Against a pre-v15 daemon the group header controls and the drawer's Groups rows are inert, each saying which daemon version they need",
        hint: "The trap this guards: a v14 daemon accepts a sequential group and hands it back parallel.",
      },
    ],
  },
```

- [ ] **Step 5: Statically pre-flight the items**

For each new item, grep its distinguishing strings against the committed source and confirm the surface exists:

```bash
grep -rn "sequence" app/src/lib/OrchestrationRail.svelte
grep -rn "Ungroup\|Save as template" app/src/lib/OrchestrationRail.svelte
grep -rn "data-orch-template\|Groups (" app/src/lib/OrchestrationDrawer.svelte
grep -rn "not saving\|cannot travel" app/src/lib/GroupTemplateSaveDialog.svelte
```

Expected: every item's surface is present. Report anything missing as a gap rather than ticking the item — a smoke item is the owner's to run, and a pre-flight only proves the strings exist.

- [ ] **Step 6: Run everything**

Run: `cargo test --workspace && cd app && npm test && npm run check && npm run build`
Expected: PASS. Re-run `cargo test -p gavin-daemon --lib gavin::tests` alone if that module fails.

- [ ] **Step 7: Commit**

```bash
git add crates/gavin-mcp/src/main.rs app/src/lib/smokeChecklist.ts app/src/lib/smokeChecklist.test.ts
git commit -m "$(cat <<'MSG'
feat(mcp): report and document a stage's mode and name

gavin_set_orchestration replaces the arrangement wholesale, and `mode`
is serde-defaulted -- so an agent that cannot see a stage's mode cannot
preserve it, and the first rewrite of any workspace would flatten every
sequential group into steps that all run at once in one checkout. The
getter now emits both fields and the setter's schema says plainly what
omitting `mode` costs.

The twelve smoke items cover what no suite here can: this is WKWebView,
where pointer capture is unreliable, so the drag gestures and the
rendered header are the owner's to run.
MSG
)"
```

---

## Self-Review

**Spec coverage:**

| Spec | Task |
|---|---|
| G1, §1.1 `Stage.mode`/`name` | 1 (wire), 2 (disk), 4 (app) |
| G2 default `parallel`, unknown → `parallel` | 1, 2, 4 |
| G3 drop forms a sequence group | 4 |
| §1.3 new single-step stages are `sequence` | 4 |
| G4 §2 one member at a time, same-tick cascade | 5 |
| §2.1 drop into a running group | 7 |
| G5 §3 conflict exemption + repair flips mode | 6 |
| §4.1 group header | 9 |
| G6 §4.2 indexed drops, stage drag, template drag | 8 (geometry), 9 + 12 (wiring) |
| §4.3 drawer Groups section | 12 |
| §4.4 save form + manager tab | 12 |
| G7 tool steps only, report what is dropped | 11 (logic), 12 (copy) |
| G8 §5.2 two scopes, template table | 10, 11 |
| §5.1 stage columns migration | 2 |
| §5.3 three requests, `PROTOCOL_VERSION` 15 | 1 (version), 10 (requests) |
| G9 §6 gate + five consumers | 3 (entry), 9 (header, drop), 12 (drawer), 6 (repair — reached only from the panel, which the hub gates) |
| §6.1 MCP | 13 |
| §7 testing | every task; smoke in 13 |

**Known ordering constraint:** Task 9 sets `savingTemplateFor` before Task 12 reads it. That compiles and is inert in between — noted rather than reordered, because splitting the header across two tasks would be worse.

**Two signature changes ripple:** `addStep`/`addToolStep`/`moveStepIntoStage` gain an index in Task 4, and their state-action wrappers in Task 7. Task 4's Step 5 keeps every caller compiling by appending; Task 7 makes the index meaningful. Test files calling `addStep` (`cardMenu.test.ts`, `orchestrationState.test.ts`, `orchestration.test.ts`) need the extra argument in Task 4.
