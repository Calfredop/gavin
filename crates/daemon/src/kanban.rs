use protocol::{Board, Card, Column, Label, Priority, SessionLink};
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
            CREATE TABLE IF NOT EXISTS kanban_cards (
                id TEXT PRIMARY KEY,
                column_id TEXT NOT NULL,
                title TEXT NOT NULL,
                description TEXT NOT NULL,
                priority TEXT NOT NULL,
                position INTEGER NOT NULL,
                session_link_session_id TEXT,
                session_link_cwd TEXT,
                session_link_command TEXT
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
            "SELECT id, title, description, priority, position,
                    session_link_session_id, session_link_cwd, session_link_command
             FROM kanban_cards WHERE column_id = ?1 ORDER BY position",
        )?;
        let rows = stmt.query_map(params![column_id], |row| {
            let priority_str: String = row.get(3)?;
            let link_session_id: Option<String> = row.get(5)?;
            let link_cwd: Option<String> = row.get(6)?;
            let link_command: Option<String> = row.get(7)?;
            let session_link = link_session_id.map(|session_id| SessionLink {
                session_id,
                cwd: link_cwd.unwrap_or_default(),
                command: link_command,
            });
            Ok(Card {
                id: row.get(0)?,
                title: row.get(1)?,
                description: row.get(2)?,
                priority: Priority::from_str(&priority_str),
                position: row.get(4)?,
                label_ids: Vec::new(),
                session_link,
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
                let (link_session_id, link_cwd, link_command): (Option<&str>, Option<&str>, Option<&str>) =
                    match &card.session_link {
                        Some(link) => (Some(link.session_id.as_str()), Some(link.cwd.as_str()), link.command.as_deref()),
                        None => (None, None, None),
                    };
                tx.execute(
                    "INSERT INTO kanban_cards
                     (id, column_id, title, description, priority, position,
                      session_link_session_id, session_link_cwd, session_link_command)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                    params![
                        card.id, column.id, card.title, card.description, card.priority.as_str(), card.position,
                        link_session_id, link_cwd, link_command
                    ],
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
            session_link: None,
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
    fn replace_board_persists_a_cards_session_link() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = KanbanStore::open(&dir.path().join("kanban.sqlite")).unwrap();
        let mut linked_card = card("card-1", "Run tests", vec![], 0);
        linked_card.session_link = Some(SessionLink {
            session_id: "session-1".to_string(),
            cwd: "/tmp/project".to_string(),
            command: Some("npm test".to_string()),
        });
        let columns = vec![column("c1", "To Do", 0, vec![linked_card])];

        store.replace_board("ws-1", &columns, &[]).unwrap();

        let board = store.get_board("ws-1").unwrap();
        let link = board.columns[0].cards[0].session_link.as_ref().unwrap();
        assert_eq!(link.session_id, "session-1");
        assert_eq!(link.cwd, "/tmp/project");
        assert_eq!(link.command, Some("npm test".to_string()));
    }

    #[test]
    fn replace_board_persists_a_card_with_no_session_link_as_none() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = KanbanStore::open(&dir.path().join("kanban.sqlite")).unwrap();
        let columns = vec![column("c1", "To Do", 0, vec![card("card-1", "Plain card", vec![], 0)])];

        store.replace_board("ws-1", &columns, &[]).unwrap();

        let board = store.get_board("ws-1").unwrap();
        assert_eq!(board.columns[0].cards[0].session_link, None);
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
