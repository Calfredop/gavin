use protocol::{Board, Column, Label};
use rusqlite::{params, Connection};

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
            DROP TABLE IF EXISTS kanban_card_labels;
            DROP TABLE IF EXISTS kanban_cards;",
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
                Ok(Column { id: row.get(0)?, name: row.get(1)?, position: row.get(2)? })
            })?;
            for row in rows {
                columns.push(row?);
            }
        }

        Ok(Board { columns, labels })
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
        store.replace_board("ws-1", &[column("c1", "First", 0)], &[]).unwrap();

        store.replace_board("ws-1", &[column("c2", "Second", 0)], &[]).unwrap();

        let board = store.get_board("ws-1").unwrap();
        assert_eq!(board.columns.len(), 1);
        assert_eq!(board.columns[0].id, "c2");
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
