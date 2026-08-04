# Kanban Board — Backend (Part 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add daemon-owned, durable storage for per-workspace kanban boards (columns, cards, labels), reachable over the existing daemon protocol and relayed through new Tauri commands — the full backend surface Part 2 (frontend: tab framework + kanban UI, planned separately once this is built and tested) will build on.

**Architecture:** New shared wire types (`Board`/`Column`/`Card`/`Label`/`Priority`) in `crates/protocol`, plus three new `Request`/`Response` variants (`GetBoard`/`SetBoard`/`DeleteBoard`, all going over the existing `CommandConnection`). A new `crates/daemon/src/kanban.rs` module (`KanbanStore`) owns a dedicated SQLite file, structured exactly like `registry.rs`'s `Registry`. `SessionManager` gains a `KanbanStore` field alongside its existing `Registry` field. Three new `#[tauri::command]` functions in `app/src-tauri/src/session.rs` relay these over the existing one-shot request/response channel, mirroring `create_session`/`kill_session`'s exact shape.

**Tech Stack:** Rust, `rusqlite` (already a `crates/daemon` dependency, "bundled" feature — no new dependency), `serde`/`serde_json` (already dependencies of `crates/protocol`), Tauri 2 commands.

## Global Constraints

- This is Part 1 (backend only). No frontend/TypeScript files change in this plan — Part 2 (tab framework + kanban UI components) is a separate plan, written after this one is built and tested. Do not add anything under `app/src/`.
- No new Cargo dependencies. `rusqlite = { version = "0.31", features = ["bundled"] }` is already a `crates/daemon` dependency (see `crates/daemon/Cargo.toml`) — reuse it exactly as `registry.rs` does.
- `Priority` serializes as lowercase strings (`"none"`/`"low"`/`"medium"`/`"high"`/`"urgent"`) via `#[serde(rename_all = "lowercase")]`, matching this project's existing lowercase status-string convention (`SessionStatus::as_str()`, `Response::StatusChanged.status`).
- `Board`/`Column`/`Card`/`Label` use `#[serde(rename_all = "camelCase")]` on their field names, matching `GitStatus`'s precedent in `crates/protocol/src/lib.rs` — these types cross to the frontend in Part 2, unlike `SessionSummary` which stays Rust-side only.
- The user works directly on `main`, no git worktree — standing project preference.
- Execute via `superpowers:subagent-driven-development`, this project's established, approved process for every plan.
- Every commit stages only the files that specific task actually needs — never `git add -A` / `git add .`.

---

### Task 1: Protocol types — `Board`/`Column`/`Card`/`Label`/`Priority` + `GetBoard`/`SetBoard`/`DeleteBoard`/`Board` protocol variants

**Files:**
- Modify: `crates/protocol/src/lib.rs`

**Interfaces:**
- Produces: `pub struct Board { pub columns: Vec<Column>, pub labels: Vec<Label> }`, `pub struct Column { pub id: String, pub name: String, pub position: i64, pub cards: Vec<Card> }`, `pub struct Card { pub id: String, pub title: String, pub description: String, pub label_ids: Vec<String>, pub priority: Priority, pub position: i64 }`, `pub struct Label { pub id: String, pub name: String, pub color: String }`, `pub enum Priority { None, Low, Medium, High, Urgent }` with `Priority::as_str(&self) -> &'static str` and `Priority::from_str(s: &str) -> Self`. `Request::GetBoard { workspace_id: String }`, `Request::SetBoard { workspace_id: String, columns: Vec<Column>, labels: Vec<Label> }`, `Request::DeleteBoard { workspace_id: String }`. `Response::Board { columns: Vec<Column>, labels: Vec<Label> }`.

- [ ] **Step 1: Write the failing tests**

Add to the `#[cfg(test)] mod tests` block at the bottom of `crates/protocol/src/lib.rs` (after the existing `git_status_changed_response_roundtrips_with_none_status` test):

```rust
    #[test]
    fn get_board_request_roundtrips_through_json_line() {
        let mut buf = Vec::new();
        let req = Request::GetBoard { workspace_id: "ws-1".to_string() };
        write_message(&mut buf, &req).unwrap();

        let mut cursor = Cursor::new(buf);
        let decoded: Request = read_message(&mut cursor).unwrap().unwrap();

        match decoded {
            Request::GetBoard { workspace_id } => assert_eq!(workspace_id, "ws-1"),
            other => panic!("wrong variant: {other:?}"),
        }
    }

    #[test]
    fn set_board_request_roundtrips_through_json_line() {
        let mut buf = Vec::new();
        let req = Request::SetBoard {
            workspace_id: "ws-1".to_string(),
            columns: vec![Column {
                id: "col-1".to_string(),
                name: "To Do".to_string(),
                position: 0,
                cards: vec![Card {
                    id: "card-1".to_string(),
                    title: "Write plan".to_string(),
                    description: "".to_string(),
                    label_ids: vec!["label-1".to_string()],
                    priority: Priority::High,
                    position: 0,
                }],
            }],
            labels: vec![Label {
                id: "label-1".to_string(),
                name: "urgent".to_string(),
                color: "#ff0000".to_string(),
            }],
        };
        write_message(&mut buf, &req).unwrap();

        let mut cursor = Cursor::new(buf);
        let decoded: Request = read_message(&mut cursor).unwrap().unwrap();

        match decoded {
            Request::SetBoard { workspace_id, columns, labels } => {
                assert_eq!(workspace_id, "ws-1");
                assert_eq!(columns.len(), 1);
                assert_eq!(columns[0].cards[0].priority, Priority::High);
                assert_eq!(labels.len(), 1);
            }
            other => panic!("wrong variant: {other:?}"),
        }
    }

    #[test]
    fn delete_board_request_roundtrips_through_json_line() {
        let mut buf = Vec::new();
        let req = Request::DeleteBoard { workspace_id: "ws-1".to_string() };
        write_message(&mut buf, &req).unwrap();

        let mut cursor = Cursor::new(buf);
        let decoded: Request = read_message(&mut cursor).unwrap().unwrap();

        match decoded {
            Request::DeleteBoard { workspace_id } => assert_eq!(workspace_id, "ws-1"),
            other => panic!("wrong variant: {other:?}"),
        }
    }

    #[test]
    fn board_response_roundtrips_through_json_line() {
        let mut buf = Vec::new();
        let resp = Response::Board {
            columns: vec![Column {
                id: "col-1".to_string(),
                name: "Done".to_string(),
                position: 0,
                cards: vec![],
            }],
            labels: vec![],
        };
        write_message(&mut buf, &resp).unwrap();

        let mut cursor = Cursor::new(buf);
        let decoded: Response = read_message(&mut cursor).unwrap().unwrap();

        match decoded {
            Response::Board { columns, labels } => {
                assert_eq!(columns.len(), 1);
                assert_eq!(columns[0].name, "Done");
                assert_eq!(labels.len(), 0);
            }
            other => panic!("wrong variant: {other:?}"),
        }
    }

    #[test]
    fn card_serializes_to_the_camel_case_shape_the_frontend_expects() {
        let card = Card {
            id: "card-1".to_string(),
            title: "Write plan".to_string(),
            description: "details".to_string(),
            label_ids: vec!["label-1".to_string()],
            priority: Priority::Urgent,
            position: 2,
        };
        let json = serde_json::to_value(&card).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "id": "card-1",
                "title": "Write plan",
                "description": "details",
                "labelIds": ["label-1"],
                "priority": "urgent",
                "position": 2
            })
        );
    }

    #[test]
    fn priority_serializes_to_lowercase_strings() {
        assert_eq!(serde_json::to_value(Priority::None).unwrap(), serde_json::json!("none"));
        assert_eq!(serde_json::to_value(Priority::Low).unwrap(), serde_json::json!("low"));
        assert_eq!(serde_json::to_value(Priority::Medium).unwrap(), serde_json::json!("medium"));
        assert_eq!(serde_json::to_value(Priority::High).unwrap(), serde_json::json!("high"));
        assert_eq!(serde_json::to_value(Priority::Urgent).unwrap(), serde_json::json!("urgent"));
    }

    #[test]
    fn priority_as_str_and_from_str_round_trip_every_variant() {
        for p in [Priority::None, Priority::Low, Priority::Medium, Priority::High, Priority::Urgent] {
            assert_eq!(Priority::from_str(p.as_str()), p);
        }
    }

    #[test]
    fn priority_from_str_defaults_to_none_for_an_unrecognized_value() {
        assert_eq!(Priority::from_str("not-a-real-priority"), Priority::None);
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p protocol` (from the repo root)
Expected: FAIL to compile — `Board`, `Column`, `Card`, `Label`, `Priority`, `Request::GetBoard`, `Request::SetBoard`, `Request::DeleteBoard`, and `Response::Board` don't exist yet.

- [ ] **Step 3: Add the types and protocol variants**

In `crates/protocol/src/lib.rs`, add three new variants to the `Request` enum (after `Attach`):

```rust
    GetBoard {
        workspace_id: String,
    },
    SetBoard {
        workspace_id: String,
        columns: Vec<Column>,
        labels: Vec<Label>,
    },
    DeleteBoard {
        workspace_id: String,
    },
```

Add one new variant to the `Response` enum (after `SessionRestored`, before `Ok`):

```rust
    Board { columns: Vec<Column>, labels: Vec<Label> },
```

Add the new types after `SessionSummary`'s struct definition:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Priority {
    None,
    Low,
    Medium,
    High,
    Urgent,
}

impl Priority {
    pub fn as_str(&self) -> &'static str {
        match self {
            Priority::None => "none",
            Priority::Low => "low",
            Priority::Medium => "medium",
            Priority::High => "high",
            Priority::Urgent => "urgent",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s {
            "low" => Priority::Low,
            "medium" => Priority::Medium,
            "high" => Priority::High,
            "urgent" => Priority::Urgent,
            _ => Priority::None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Label {
    pub id: String,
    pub name: String,
    pub color: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Card {
    pub id: String,
    pub title: String,
    pub description: String,
    pub label_ids: Vec<String>,
    pub priority: Priority,
    pub position: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Column {
    pub id: String,
    pub name: String,
    pub position: i64,
    pub cards: Vec<Card>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Board {
    pub columns: Vec<Column>,
    pub labels: Vec<Label>,
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p protocol`
Expected: PASS, all tests including the new ones (should be 17 total: 10 existing + 7 new).

- [ ] **Step 5: Commit**

```bash
git add crates/protocol/src/lib.rs
git commit -m "feat(protocol): add Board/Column/Card/Label/Priority types and GetBoard/SetBoard/DeleteBoard"
```

---

### Task 2: Daemon-side storage — `crates/daemon/src/kanban.rs`

**Files:**
- Create: `crates/daemon/src/kanban.rs`
- Modify: `crates/daemon/src/main.rs:1-6` (add `mod kanban;`)

**Interfaces:**
- Consumes: `protocol::{Board, Card, Column, Label, Priority}` (Task 1).
- Produces: `pub struct KanbanStore` with `pub fn open(path: &std::path::Path) -> anyhow::Result<Self>`, `pub fn get_board(&mut self, workspace_id: &str) -> anyhow::Result<Board>`, `pub fn replace_board(&mut self, workspace_id: &str, columns: &[Column], labels: &[Label]) -> anyhow::Result<()>`, `pub fn delete_board(&mut self, workspace_id: &str) -> anyhow::Result<()>`.

- [ ] **Step 1: Write the failing tests**

Create `crates/daemon/src/kanban.rs` with just the test module first:

```rust
use protocol::{Board, Card, Column, Label, Priority};
use rusqlite::{params, Connection};

pub struct KanbanStore {
    conn: Connection,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn label(id: &str, name: &str) -> Label {
        Label { id: id.to_string(), name: name.to_string(), color: "#ff0000".to_string() }
    }

    fn card(id: &str, title: &str, label_ids: Vec<&str>, position: i64) -> Card {
        Card {
            id: id.to_string(),
            title: title.to_string(),
            description: "".to_string(),
            label_ids: label_ids.into_iter().map(str::to_string).collect(),
            priority: Priority::Medium,
            position,
        }
    }

    fn column(id: &str, name: &str, position: i64, cards: Vec<Card>) -> Column {
        Column { id: id.to_string(), name: name.to_string(), position, cards }
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

    #[test]
    fn get_board_is_idempotent_and_does_not_reseed_over_an_edited_board() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = KanbanStore::open(&dir.path().join("kanban.sqlite")).unwrap();
        let first = store.get_board("ws-1").unwrap();
        let remaining: Vec<Column> = first.columns.into_iter().take(1).collect();
        store.replace_board("ws-1", &remaining, &[]).unwrap();

        let second = store.get_board("ws-1").unwrap();

        assert_eq!(second.columns.len(), 1, "a second get_board must not reseed over a deliberately-edited board");
    }

    #[test]
    fn replace_board_replaces_rather_than_appends() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = KanbanStore::open(&dir.path().join("kanban.sqlite")).unwrap();
        store.replace_board("ws-1", &[column("c1", "First", 0, vec![])], &[]).unwrap();

        store.replace_board("ws-1", &[column("c2", "Second", 0, vec![])], &[]).unwrap();

        let board = store.get_board("ws-1").unwrap();
        assert_eq!(board.columns.len(), 1);
        assert_eq!(board.columns[0].id, "c2");
    }

    #[test]
    fn replace_board_persists_cards_with_labels_in_position_order() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = KanbanStore::open(&dir.path().join("kanban.sqlite")).unwrap();
        let labels = vec![label("l1", "urgent")];
        let columns = vec![column(
            "c1",
            "To Do",
            0,
            vec![card("card-b", "Second", vec![], 1), card("card-a", "First", vec!["l1"], 0)],
        )];

        store.replace_board("ws-1", &columns, &labels).unwrap();

        let board = store.get_board("ws-1").unwrap();
        assert_eq!(board.labels.len(), 1);
        assert_eq!(board.columns[0].cards.len(), 2);
        assert_eq!(board.columns[0].cards[0].id, "card-a", "must come back in position order, not insertion order");
        assert_eq!(board.columns[0].cards[0].label_ids, vec!["l1".to_string()]);
        assert_eq!(board.columns[0].cards[1].id, "card-b");
    }

    #[test]
    fn boards_for_different_workspaces_are_independent() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = KanbanStore::open(&dir.path().join("kanban.sqlite")).unwrap();
        store.replace_board("ws-1", &[column("c1", "Only in ws-1", 0, vec![])], &[]).unwrap();

        let ws2_board = store.get_board("ws-2").unwrap();

        assert_eq!(ws2_board.columns.len(), 3, "ws-2 has never been touched, so it gets its own fresh default seed");
        assert_eq!(ws2_board.columns[0].name, "To Do");
    }

    #[test]
    fn delete_board_removes_everything_and_a_later_get_board_reseeds_fresh_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = KanbanStore::open(&dir.path().join("kanban.sqlite")).unwrap();
        store
            .replace_board(
                "ws-1",
                &[column("c1", "To Do", 0, vec![card("card-a", "A card", vec!["l1"], 0)])],
                &[label("l1", "urgent")],
            )
            .unwrap();

        store.delete_board("ws-1").unwrap();

        let board = store.get_board("ws-1").unwrap();
        assert_eq!(board.columns.len(), 3, "a fresh default seed, not the deleted board's leftovers");
        assert_eq!(board.columns[0].cards.len(), 0);
        assert!(board.labels.is_empty());
    }

    #[test]
    fn store_survives_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("kanban.sqlite");
        {
            let mut store = KanbanStore::open(&db_path).unwrap();
            store.replace_board("ws-1", &[column("c1", "Persisted", 0, vec![])], &[]).unwrap();
        }
        let mut store = KanbanStore::open(&db_path).unwrap();
        let board = store.get_board("ws-1").unwrap();
        assert_eq!(board.columns[0].name, "Persisted");
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p gavin-daemon kanban::` (from the repo root)
Expected: FAIL to compile — `KanbanStore::open`, `get_board`, `replace_board`, `delete_board` don't exist yet.

- [ ] **Step 3: Implement `KanbanStore`**

Add above the `#[cfg(test)]` block in `crates/daemon/src/kanban.rs`:

```rust
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
            CREATE TABLE IF NOT EXISTS kanban_cards (
                id TEXT PRIMARY KEY,
                column_id TEXT NOT NULL,
                title TEXT NOT NULL,
                description TEXT NOT NULL,
                priority TEXT NOT NULL,
                position INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS kanban_labels (
                id TEXT PRIMARY KEY,
                workspace_id TEXT NOT NULL,
                name TEXT NOT NULL,
                color TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS kanban_card_labels (
                card_id TEXT NOT NULL,
                label_id TEXT NOT NULL,
                PRIMARY KEY (card_id, label_id)
            );",
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
                Column { id: uuid::Uuid::new_v4().to_string(), name: "To Do".to_string(), position: 0, cards: vec![] },
                Column {
                    id: uuid::Uuid::new_v4().to_string(),
                    name: "In Progress".to_string(),
                    position: 1,
                    cards: vec![],
                },
                Column { id: uuid::Uuid::new_v4().to_string(), name: "Done".to_string(), position: 2, cards: vec![] },
            ];
            self.replace_board(workspace_id, &default_columns, &[])?;
        }
        self.read_board(workspace_id)
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
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?))
            })?;
            let mut column_rows = Vec::new();
            for row in rows {
                column_rows.push(row?);
            }
            for (id, name, position) in column_rows {
                let cards = self.read_cards(&id)?;
                columns.push(Column { id, name, position, cards });
            }
        }

        Ok(Board { columns, labels })
    }

    fn read_cards(&self, column_id: &str) -> anyhow::Result<Vec<Card>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, title, description, priority, position FROM kanban_cards
             WHERE column_id = ?1 ORDER BY position",
        )?;
        let rows = stmt.query_map(params![column_id], |row| {
            let priority_str: String = row.get(3)?;
            Ok(Card {
                id: row.get(0)?,
                title: row.get(1)?,
                description: row.get(2)?,
                priority: Priority::from_str(&priority_str),
                position: row.get(4)?,
                label_ids: Vec::new(),
            })
        })?;
        let mut cards = Vec::new();
        for row in rows {
            cards.push(row?);
        }
        for card in &mut cards {
            card.label_ids = self.read_label_ids(&card.id)?;
        }
        Ok(cards)
    }

    fn read_label_ids(&self, card_id: &str) -> anyhow::Result<Vec<String>> {
        let mut stmt = self.conn.prepare("SELECT label_id FROM kanban_card_labels WHERE card_id = ?1")?;
        let rows = stmt.query_map(params![card_id], |row| row.get::<_, String>(0))?;
        let mut ids = Vec::new();
        for row in rows {
            ids.push(row?);
        }
        Ok(ids)
    }

    /// Deletes every `kanban_*` row for `workspace_id` except the
    /// `kanban_boards` marker itself -- shared by `replace_board` (which
    /// re-inserts fresh rows right after) and `delete_board` (which also
    /// removes the marker, right after calling this).
    fn delete_content_rows(tx: &rusqlite::Transaction, workspace_id: &str) -> anyhow::Result<()> {
        tx.execute(
            "DELETE FROM kanban_card_labels WHERE card_id IN (
                SELECT kanban_cards.id FROM kanban_cards
                JOIN kanban_columns ON kanban_cards.column_id = kanban_columns.id
                WHERE kanban_columns.workspace_id = ?1
            )",
            params![workspace_id],
        )?;
        tx.execute(
            "DELETE FROM kanban_cards WHERE column_id IN (SELECT id FROM kanban_columns WHERE workspace_id = ?1)",
            params![workspace_id],
        )?;
        tx.execute("DELETE FROM kanban_columns WHERE workspace_id = ?1", params![workspace_id])?;
        tx.execute("DELETE FROM kanban_labels WHERE workspace_id = ?1", params![workspace_id])?;
        Ok(())
    }

    /// Wholesale replace: deletes every existing row for `workspace_id`
    /// and re-inserts everything from `columns`/`labels`, in one
    /// transaction so a mid-write failure can never leave a half-deleted
    /// board. This is the daemon's only "replace the whole tree" storage
    /// operation -- every other daemon-side store (Registry) does
    /// fine-grained field updates instead, so there is no existing
    /// pattern to mirror here; the transaction is what makes a
    /// from-scratch delete-then-reinsert safe.
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
            for card in &column.cards {
                tx.execute(
                    "INSERT INTO kanban_cards (id, column_id, title, description, priority, position)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![card.id, column.id, card.title, card.description, card.priority.as_str(), card.position],
                )?;
                for label_id in &card.label_ids {
                    tx.execute(
                        "INSERT INTO kanban_card_labels (card_id, label_id) VALUES (?1, ?2)",
                        params![card.id, label_id],
                    )?;
                }
            }
        }
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p gavin-daemon kanban::`
Expected: PASS, all 8 tests.

- [ ] **Step 5: Register the module**

In `crates/daemon/src/main.rs`, add `mod kanban;` to the `mod` list at the top (alphabetically, between `git_status` and `osc`):

```rust
mod git_status;
mod kanban;
mod osc;
mod pty;
mod registry;
mod server;
mod status;
```

- [ ] **Step 6: Run the full daemon build to confirm nothing else broke**

Run: `cargo build -p gavin-daemon`
Expected: PASS, clean build, 0 warnings.

- [ ] **Step 7: Commit**

```bash
git add crates/daemon/src/kanban.rs crates/daemon/src/main.rs
git commit -m "feat(daemon): add KanbanStore, per-workspace SQLite board storage"
```

---

### Task 3: Wire `KanbanStore` into `SessionManager` and the request dispatcher

**Files:**
- Modify: `crates/daemon/src/server.rs` (struct/constructor, `handle_request`, every `SessionManager::new` test call site)
- Modify: `crates/daemon/src/main.rs` (real construction + path)

**Interfaces:**
- Consumes: `KanbanStore` (Task 2), `Board`/`Column`/`Label` (Task 1).
- Produces: `SessionManager::new(registry: Registry, kanban: KanbanStore) -> Self` (signature change — every existing call site must be updated), `SessionManager::get_board(&self, workspace_id: &str) -> anyhow::Result<Board>`, `SessionManager::set_board(&self, workspace_id: &str, columns: Vec<Column>, labels: Vec<Label>) -> anyhow::Result<()>`, `SessionManager::delete_board(&self, workspace_id: &str) -> anyhow::Result<()>`.

**Important — this task's constructor-signature change touches every existing `SessionManager::new(...)` call site.** Find all of them first:

```bash
grep -n "SessionManager::new(" crates/daemon/src/server.rs crates/daemon/src/main.rs
```

As of this plan being written, that's 11 call sites in `crates/daemon/src/server.rs` (all inside `#[cfg(test)]` blocks) plus 1 in `crates/daemon/src/main.rs`. Every one of those test call sites already has a `dir` (a `tempfile::TempDir`, from `tempfile::tempdir()`) in scope — the same directory the existing `Registry::open(...)` call in that test builds its `db_path` from. At every one, change `SessionManager::new(<registry-expr>)` to `SessionManager::new(<registry-expr>, KanbanStore::open(&dir.path().join("kanban.sqlite")).unwrap())`. This is mechanically safe to verify exhaustively: a missed call site is a compile error (wrong argument count), not a silent bug — Step 5 below (`cargo build --tests`) will catch any you miss.

- [ ] **Step 1: Write the failing tests**

Add to the `#[cfg(test)] mod tests` block in `crates/daemon/src/server.rs` (near the other `handle_request`-level tests):

```rust
    #[test]
    fn get_board_request_returns_the_default_seed_for_a_new_workspace() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(&dir.path().join("registry.sqlite")).unwrap();
        let kanban = KanbanStore::open(&dir.path().join("kanban.sqlite")).unwrap();
        let manager = SessionManager::new(registry, kanban);

        let resp = handle_request(&manager, Request::GetBoard { workspace_id: "ws-1".to_string() });

        match resp {
            Response::Board { columns, labels } => {
                assert_eq!(columns.len(), 3);
                assert!(labels.is_empty());
            }
            other => panic!("expected Board, got {other:?}"),
        }
    }

    #[test]
    fn set_board_then_get_board_round_trips_through_handle_request() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(&dir.path().join("registry.sqlite")).unwrap();
        let kanban = KanbanStore::open(&dir.path().join("kanban.sqlite")).unwrap();
        let manager = SessionManager::new(registry, kanban);
        let columns = vec![Column { id: "c1".to_string(), name: "Only column".to_string(), position: 0, cards: vec![] }];

        let set_resp = handle_request(
            &manager,
            Request::SetBoard { workspace_id: "ws-1".to_string(), columns: columns.clone(), labels: vec![] },
        );
        assert!(matches!(set_resp, Response::Ok));

        let get_resp = handle_request(&manager, Request::GetBoard { workspace_id: "ws-1".to_string() });
        match get_resp {
            Response::Board { columns: got, .. } => {
                assert_eq!(got.len(), 1);
                assert_eq!(got[0].name, "Only column");
            }
            other => panic!("expected Board, got {other:?}"),
        }
    }

    #[test]
    fn delete_board_request_removes_the_board_and_a_later_get_reseeds_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Registry::open(&dir.path().join("registry.sqlite")).unwrap();
        let kanban = KanbanStore::open(&dir.path().join("kanban.sqlite")).unwrap();
        let manager = SessionManager::new(registry, kanban);
        handle_request(
            &manager,
            Request::SetBoard {
                workspace_id: "ws-1".to_string(),
                columns: vec![Column { id: "c1".to_string(), name: "Custom".to_string(), position: 0, cards: vec![] }],
                labels: vec![],
            },
        );

        let delete_resp = handle_request(&manager, Request::DeleteBoard { workspace_id: "ws-1".to_string() });
        assert!(matches!(delete_resp, Response::Ok));

        let get_resp = handle_request(&manager, Request::GetBoard { workspace_id: "ws-1".to_string() });
        match get_resp {
            Response::Board { columns, .. } => {
                assert_eq!(columns.len(), 3, "should reseed fresh defaults, not the deleted custom column");
            }
            other => panic!("expected Board, got {other:?}"),
        }
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p gavin-daemon get_board_request_returns_the_default_seed`
Expected: FAIL to compile — `SessionManager::new` doesn't accept a second argument yet, and `Request::GetBoard`/`Response::Board` aren't handled by `handle_request` yet.

- [ ] **Step 3: Add the `kanban` field, update the constructor, add the three manager methods**

In `crates/daemon/src/server.rs`, update the top `use` line to add the new protocol types and the new module:

```rust
use protocol::{read_message, write_message, Board, Column, GitStatus, Label, Request, Response, SessionSummary};
use crate::kanban::KanbanStore;
```

Update `SessionManager`'s struct definition to add a `kanban` field (right after `registry`):

```rust
pub struct SessionManager {
    registry: Mutex<Registry>,
    kanban: Mutex<KanbanStore>,
    sessions: Mutex<HashMap<String, PtySession>>,
```

Update the constructor:

```rust
    pub fn new(registry: Registry, kanban: KanbanStore) -> Self {
        Self {
            registry: Mutex::new(registry),
            kanban: Mutex::new(kanban),
            sessions: Mutex::new(HashMap::new()),
```

Add three new methods, right after `list_sessions`:

```rust
    pub fn get_board(&self, workspace_id: &str) -> anyhow::Result<Board> {
        self.kanban.lock().unwrap().get_board(workspace_id)
    }

    pub fn set_board(&self, workspace_id: &str, columns: Vec<Column>, labels: Vec<Label>) -> anyhow::Result<()> {
        self.kanban.lock().unwrap().replace_board(workspace_id, &columns, &labels)
    }

    pub fn delete_board(&self, workspace_id: &str) -> anyhow::Result<()> {
        self.kanban.lock().unwrap().delete_board(workspace_id)
    }
```

- [ ] **Step 4: Add the dispatch arms**

In `handle_request`, add three arms right before `Request::Attach`:

```rust
        Request::GetBoard { workspace_id } => manager
            .get_board(&workspace_id)
            .map(|board| Response::Board { columns: board.columns, labels: board.labels }),
        Request::SetBoard { workspace_id, columns, labels } => manager
            .set_board(&workspace_id, columns, labels)
            .map(|_| Response::Ok),
        Request::DeleteBoard { workspace_id } => manager.delete_board(&workspace_id).map(|_| Response::Ok),
```

- [ ] **Step 5: Update every other `SessionManager::new` call site**

Using the `grep` output from before Step 1, update every remaining test call site with the same transformation (add `KanbanStore::open(&dir.path().join("kanban.sqlite")).unwrap()` as the second argument). Then run:

```bash
cargo build --tests -p gavin-daemon
```

Expected: FAIL initially, listing every call site still missing the second argument (one compile error per site). Fix each one, re-running until it's clean. This is your exhaustiveness check — do not move on until this build is clean.

- [ ] **Step 6: Update `crates/daemon/src/main.rs`**

```rust
mod git_status;
mod kanban;
mod osc;
mod pty;
mod registry;
mod server;
mod status;

use kanban::KanbanStore;
use registry::Registry;
use server::SessionManager;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::sync::Arc;

fn db_path() -> PathBuf {
    protocol::app_support_dir().join("registry.sqlite")
}

fn kanban_db_path() -> PathBuf {
    protocol::app_support_dir().join("kanban.sqlite")
}

fn main() -> anyhow::Result<()> {
    let dir = protocol::app_support_dir();
    std::fs::create_dir_all(&dir)?;
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;

    let registry = Registry::open(&db_path())?;
    let kanban = KanbanStore::open(&kanban_db_path())?;
    let manager = Arc::new(SessionManager::new(registry, kanban));
    manager.recover()?;

    println!("gavin-daemon listening on {}", protocol::socket_path().display());
    server::run_server(&protocol::socket_path(), manager)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_are_scoped_under_app_support() {
        let dir = protocol::app_support_dir();
        assert!(protocol::socket_path().starts_with(&dir));
        assert!(db_path().starts_with(&dir));
        assert!(kanban_db_path().starts_with(&dir));
        assert_eq!(protocol::socket_path().file_name().unwrap(), "daemon.sock");
        assert_eq!(db_path().file_name().unwrap(), "registry.sqlite");
        assert_eq!(kanban_db_path().file_name().unwrap(), "kanban.sqlite");
    }
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cargo test -p gavin-daemon` (the whole crate, not just a filter — Step 5's mechanical edits touched many tests)
Expected: PASS, every test, with 3 new ones from Step 1 plus the updated `paths_are_scoped_under_app_support`.

Run it twice more to check for flakiness (this project's established convention for anything touching `SessionManager` construction):

```bash
cargo test -p gavin-daemon
cargo test -p gavin-daemon
```

Expected: PASS, identically, both times.

- [ ] **Step 8: Commit**

```bash
git add crates/daemon/src/server.rs crates/daemon/src/main.rs
git commit -m "feat(daemon): wire KanbanStore into SessionManager and the request dispatcher"
```

---

### Task 4: Tauri relay commands — `get_board`/`set_board`/`delete_board`

**Files:**
- Modify: `app/src-tauri/src/session.rs`
- Modify: `app/src-tauri/src/lib.rs` (register the 3 new commands)

**Interfaces:**
- Consumes: `Request::GetBoard`/`SetBoard`/`DeleteBoard`, `Response::Board` (Task 1/3), `send_command` (existing helper in `session.rs`), `CommandConnection` (existing Tauri-managed state).
- Produces: `#[tauri::command] pub fn get_board(workspace_id: String, state: State<CommandConnection>) -> Result<protocol::Board, String>`, `#[tauri::command] pub fn set_board(workspace_id: String, columns: Vec<Column>, labels: Vec<Label>, state: State<CommandConnection>) -> Result<(), String>`, `#[tauri::command] pub fn delete_board(workspace_id: String, state: State<CommandConnection>) -> Result<(), String>`. These are what Part 2's frontend will call via `invoke("get_board", ...)` etc.

**Note on testing shape:** this codebase has no existing direct tests of a `#[tauri::command]`-decorated function itself (constructing a real `tauri::State` outside a running app is awkward) — the established precedent (`create_fresh_session`, which the real `create_session` command wraps) is to put the actual logic in a plain, non-decorated function taking `&Mutex<UnixStream>` directly, test that, and keep the `#[tauri::command]` function itself a thin one-line wrapper. This task follows that same shape for all three commands.

- [ ] **Step 1: Write the failing tests**

Add a new test module to `app/src-tauri/src/session.rs`, after the existing `resolve_workspaces_tests` module:

```rust
#[cfg(test)]
mod kanban_command_tests {
    use super::test_support::{fake_daemon_capturing_requests, fake_daemon_replying_with};
    use super::*;

    #[test]
    fn get_board_impl_returns_the_boards_columns_and_labels() {
        let (client, _dir) = fake_daemon_replying_with(vec![Response::Board {
            columns: vec![Column { id: "c1".to_string(), name: "To Do".to_string(), position: 0, cards: vec![] }],
            labels: vec![Label { id: "l1".to_string(), name: "urgent".to_string(), color: "#f00".to_string() }],
        }]);
        let conn = Mutex::new(client);

        let board = get_board_impl(&conn, "ws-1".to_string()).unwrap();

        assert_eq!(board.columns.len(), 1);
        assert_eq!(board.columns[0].name, "To Do");
        assert_eq!(board.labels.len(), 1);
    }

    #[test]
    fn get_board_impl_sends_the_given_workspace_id() {
        let (client, captured, _dir) =
            fake_daemon_capturing_requests(vec![Response::Board { columns: vec![], labels: vec![] }]);
        let conn = Mutex::new(client);

        get_board_impl(&conn, "ws-42".to_string()).unwrap();

        let requests = captured.lock().unwrap();
        match &requests[0] {
            Request::GetBoard { workspace_id } => assert_eq!(workspace_id, "ws-42"),
            other => panic!("expected GetBoard, got {other:?}"),
        }
    }

    #[test]
    fn get_board_impl_propagates_a_daemon_error() {
        let (client, _dir) =
            fake_daemon_replying_with(vec![Response::Error { message: "board fetch failed".to_string() }]);
        let conn = Mutex::new(client);

        let result = get_board_impl(&conn, "ws-1".to_string());

        assert!(result.is_err());
    }

    #[test]
    fn set_board_impl_sends_the_given_columns_and_labels() {
        let (client, captured, _dir) = fake_daemon_capturing_requests(vec![Response::Ok]);
        let conn = Mutex::new(client);
        let columns = vec![Column { id: "c1".to_string(), name: "Only".to_string(), position: 0, cards: vec![] }];

        set_board_impl(&conn, "ws-1".to_string(), columns.clone(), vec![]).unwrap();

        let requests = captured.lock().unwrap();
        match &requests[0] {
            Request::SetBoard { workspace_id, columns: sent_columns, .. } => {
                assert_eq!(workspace_id, "ws-1");
                assert_eq!(sent_columns.len(), 1);
                assert_eq!(sent_columns[0].name, "Only");
            }
            other => panic!("expected SetBoard, got {other:?}"),
        }
    }

    #[test]
    fn set_board_impl_propagates_a_daemon_error() {
        let (client, _dir) =
            fake_daemon_replying_with(vec![Response::Error { message: "board save failed".to_string() }]);
        let conn = Mutex::new(client);

        let result = set_board_impl(&conn, "ws-1".to_string(), vec![], vec![]);

        assert!(result.is_err());
    }

    #[test]
    fn delete_board_impl_sends_the_given_workspace_id() {
        let (client, captured, _dir) = fake_daemon_capturing_requests(vec![Response::Ok]);
        let conn = Mutex::new(client);

        delete_board_impl(&conn, "ws-1".to_string()).unwrap();

        let requests = captured.lock().unwrap();
        match &requests[0] {
            Request::DeleteBoard { workspace_id } => assert_eq!(workspace_id, "ws-1"),
            other => panic!("expected DeleteBoard, got {other:?}"),
        }
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p app kanban_command_tests`
Expected: FAIL to compile — `get_board_impl`, `set_board_impl`, `delete_board_impl` don't exist yet, and `Column`/`Label`/`Board` aren't imported.

- [ ] **Step 3: Implement the impl functions and the Tauri command wrappers**

Update the `use protocol::{...}` line near the top of `app/src-tauri/src/session.rs`:

```rust
use protocol::{read_message, socket_path, write_message, Board, Column, Label, Request, Response};
```

Add these functions right after `kill_session` (near the bottom of the file, alongside the other Tauri commands):

```rust
fn get_board_impl(command_conn: &Mutex<UnixStream>, workspace_id: String) -> anyhow::Result<Board> {
    let resp = send_command(command_conn, &Request::GetBoard { workspace_id })?;
    match resp {
        Response::Board { columns, labels } => Ok(Board { columns, labels }),
        other => anyhow::bail!("expected Board, got {other:?}"),
    }
}

#[tauri::command]
pub fn get_board(workspace_id: String, state: State<CommandConnection>) -> Result<Board, String> {
    get_board_impl(&state.0, workspace_id).map_err(|e| e.to_string())
}

fn set_board_impl(
    command_conn: &Mutex<UnixStream>,
    workspace_id: String,
    columns: Vec<Column>,
    labels: Vec<Label>,
) -> anyhow::Result<()> {
    let resp = send_command(command_conn, &Request::SetBoard { workspace_id, columns, labels })?;
    match resp {
        Response::Ok => Ok(()),
        other => anyhow::bail!("expected Ok, got {other:?}"),
    }
}

#[tauri::command]
pub fn set_board(
    workspace_id: String,
    columns: Vec<Column>,
    labels: Vec<Label>,
    state: State<CommandConnection>,
) -> Result<(), String> {
    set_board_impl(&state.0, workspace_id, columns, labels).map_err(|e| e.to_string())
}

fn delete_board_impl(command_conn: &Mutex<UnixStream>, workspace_id: String) -> anyhow::Result<()> {
    let resp = send_command(command_conn, &Request::DeleteBoard { workspace_id })?;
    match resp {
        Response::Ok => Ok(()),
        other => anyhow::bail!("expected Ok, got {other:?}"),
    }
}

#[tauri::command]
pub fn delete_board(workspace_id: String, state: State<CommandConnection>) -> Result<(), String> {
    delete_board_impl(&state.0, workspace_id).map_err(|e| e.to_string())
}
```

- [ ] **Step 4: Register the commands**

In `app/src-tauri/src/lib.rs`, add the three new commands to the `generate_handler!` list:

```rust
        .invoke_handler(tauri::generate_handler![
            session::write_input,
            session::resize_session,
            session::create_session,
            session::kill_session,
            session::get_workspaces_state,
            session::set_workspaces_state,
            session::get_session_names,
            session::set_session_name,
            session::signal_frontend_ready,
            session::get_bootstrap_error,
            session::get_board,
            session::set_board,
            session::delete_board
        ])
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cargo test -p app`
Expected: PASS, all tests including the 6 new ones.

- [ ] **Step 6: Run the full workspace build and test suite**

```bash
cargo build
cargo test
```

Expected: PASS, clean build (0 warnings), all tests across `protocol`, `gavin-daemon`, and `app` (should be 17 + 116 + 32 = 165 total, up from 141 before this plan: protocol 10→17, daemon 105→116 (+8 from Task 2, +3 from Task 3), app 26→32).

- [ ] **Step 7: Commit**

```bash
git add app/src-tauri/src/session.rs app/src-tauri/src/lib.rs
git commit -m "feat(app): add get_board/set_board/delete_board Tauri relay commands"
```

---

## Note for Part 2

This plan only builds the *capability* to cascade-delete a workspace's board (`delete_board`/`DeleteBoard`). The spec's edge case ("deleting a workspace cascade-deletes its `kanban_*` rows") also requires *triggering* it — investigation during this plan's own grounding found that workspace deletion is entirely a frontend concept today (`closeWorkspace` in `app/src/lib/layoutState.ts`): it kills each session individually via `backend.killSession(id)`, and the daemon has no notion of "workspace" at all (sessions are keyed by session id only, never grouped by `workspace_id`). There is no existing daemon-side hook to attach the cascade-delete to. Part 2 must add a call to the new `delete_board` Tauri command inside `closeWorkspace`'s existing kill-every-session flow — this plan deliberately stops at providing the command, since wiring a frontend call site is out of this backend-only plan's scope.
