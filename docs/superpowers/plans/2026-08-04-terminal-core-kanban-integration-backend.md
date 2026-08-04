# Kanban Integration Layer — Backend (Part 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the `SessionLink` data model to kanban cards (protocol + daemon SQLite storage) and extend session creation with optional `cwd`/`command` parameters, so Part 2's frontend UI has everything it needs to link cards to sessions.

**Architecture:** `crates/protocol` gains a `SessionLink` struct and `Card.session_link: Option<SessionLink>`. `crates/daemon/src/kanban.rs` gains three new nullable SQLite columns on `kanban_cards`. The daemon's own `SessionManager::create_session` and the `Request::CreateSession` dispatch already fully support an optional `command` — confirmed by reading both directly, not assumed — so no daemon-side changes are needed there at all. The only gap is the Tauri command layer: `app/src-tauri/src/session.rs`'s `create_session` command and its `create_fresh_session` helper currently hardcode `cwd: None`/`command: None`; both gain real parameters, threaded through to `app/src/lib/backend.ts`'s wrapper.

**Tech Stack:** Rust, `rusqlite` (already a dependency), TypeScript/Tauri `invoke()`.

## Global Constraints

- This is Part 1 (backend only). No frontend UI changes — Part 2 (kanban.ts helpers, `CardDetailModal`'s Session section, `KanbanCard`'s status dot, the delete-with-link prompt) is a separate plan, written after this one is built and tested. `app/src/lib/backend.ts` is the one exception: its `createSession` wrapper is extended here (matching the precedent already set by the original kanban backend plan, which added `getBoard`/`setBoard`/`deleteBoard` to `backend.ts` in its own Part 1, not deferred to the frontend plan).
- No daemon-side (`crates/daemon/src/server.rs`) logic changes — `SessionManager::create_session` already accepts `command: Option<&str>` and the `Request::CreateSession` dispatch arm already threads it through (`command.as_deref()`), confirmed by reading both directly. Do not "fix" or touch this code; it already does the right thing.
- `SessionLink` uses `#[serde(rename_all = "camelCase")]` with no `#[serde(default)]` on `Card.session_link` — a bare `Option<SessionLink>` already deserializes correctly when the JSON key is absent, matching the established `active_view`/`active_page_id` precedent (no attribute needed for `Option<T>` fields).
- Adding `session_link` to the `Card` struct breaks every existing Rust `Card { ... }` literal (unlike TypeScript's structural optionality, Rust struct literals require every field explicitly) — this plan enumerates the exact 4 sites that need `session_link: None` added (2 in `crates/protocol/src/lib.rs`, 2 in `crates/daemon/src/kanban.rs`) as part of Task 1/Task 2's own steps.
- The user works directly on `main`, no git worktree — standing preference.
- Execute via `superpowers:subagent-driven-development`, this project's established process. Note for whoever executes: this session has hit the 200-subagent spawn cap six times already (each time resolved by the user choosing direct controller implementation) — don't be surprised if it happens again.
- Every commit stages only the files that specific task actually needs — never `git add -A` / `git add .`.

---

### Task 1: `SessionLink` protocol type + `Card.session_link` field

**Files:**
- Modify: `crates/protocol/src/lib.rs`

**Interfaces:**
- Produces: `pub struct SessionLink { pub session_id: String, pub cwd: String, pub command: Option<String> }`; `Card` gains `pub session_link: Option<SessionLink>` as its last field.

- [ ] **Step 1: Write the failing tests**

Add to the `#[cfg(test)] mod tests` block, near the existing `card_serializes_to_the_camel_case_shape_the_frontend_expects` test:

```rust
    #[test]
    fn session_link_serializes_to_the_camel_case_shape_the_frontend_expects() {
        let link = SessionLink {
            session_id: "session-1".to_string(),
            cwd: "/Users/alice/project".to_string(),
            command: Some("npm test".to_string()),
        };
        let json = serde_json::to_value(&link).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "sessionId": "session-1",
                "cwd": "/Users/alice/project",
                "command": "npm test"
            })
        );
    }

    #[test]
    fn card_with_session_link_roundtrips_through_json_line() {
        let mut buf = Vec::new();
        let card = Card {
            id: "card-1".to_string(),
            title: "Run tests".to_string(),
            description: "".to_string(),
            label_ids: vec![],
            priority: Priority::None,
            position: 0,
            session_link: Some(SessionLink {
                session_id: "session-1".to_string(),
                cwd: "/tmp".to_string(),
                command: None,
            }),
        };
        write_message(&mut buf, &card).unwrap();

        let mut cursor = Cursor::new(buf);
        let decoded: Card = read_message(&mut cursor).unwrap().unwrap();

        assert_eq!(decoded.session_link.unwrap().session_id, "session-1");
    }
```

Update the two existing `Card { ... }` literals that will now fail to compile:

In `set_board_request_roundtrips_through_json_line`, the `Card` inside the `SetBoard` request's `columns` — add `session_link: None,` as the last field:

```rust
                cards: vec![Card {
                    id: "card-1".to_string(),
                    title: "Write plan".to_string(),
                    description: "".to_string(),
                    label_ids: vec!["label-1".to_string()],
                    priority: Priority::High,
                    position: 0,
                    session_link: None,
                }],
```

In `card_serializes_to_the_camel_case_shape_the_frontend_expects`, add `session_link: None,` to the `Card` literal, and add `"sessionLink": null` to the expected JSON (matching the established precedent — `None` serializes as explicit `null`, never omitted, confirmed by the existing `Workspace.activeView` shape test):

```rust
    fn card_serializes_to_the_camel_case_shape_the_frontend_expects() {
        let card = Card {
            id: "card-1".to_string(),
            title: "Write plan".to_string(),
            description: "details".to_string(),
            label_ids: vec!["label-1".to_string()],
            priority: Priority::Urgent,
            position: 2,
            session_link: None,
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
                "position": 2,
                "sessionLink": null
            })
        );
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `source "$HOME/.cargo/env" && cargo test -p protocol` (from the repo root)
Expected: FAIL to compile — `SessionLink` and `Card.session_link` don't exist yet.

- [ ] **Step 3: Add `SessionLink` and `Card.session_link`**

Add the new struct right after `Label`'s definition, before `Card`:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionLink {
    pub session_id: String,
    pub cwd: String,
    pub command: Option<String>,
}
```

Add `session_link` as `Card`'s last field:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Card {
    pub id: String,
    pub title: String,
    pub description: String,
    pub label_ids: Vec<String>,
    pub priority: Priority,
    pub position: i64,
    pub session_link: Option<SessionLink>,
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `source "$HOME/.cargo/env" && cargo test -p protocol`
Expected: PASS, all tests (20 total: 18 existing + 2 new).

- [ ] **Step 5: Commit**

```bash
git add crates/protocol/src/lib.rs
git commit -m "feat(protocol): add SessionLink type and Card.sessionLink field"
```

---

### Task 2: Daemon storage — `session_link_*` columns on `kanban_cards`

**Files:**
- Modify: `crates/daemon/src/kanban.rs`

**Interfaces:**
- Consumes: `SessionLink` (Task 1).
- Produces: `KanbanStore::replace_board`/`get_board` now persist and return a card's `session_link` correctly.

- [ ] **Step 1: Write the failing tests**

Add to the `#[cfg(test)] mod tests` block, near the existing `replace_board_persists_cards_with_labels_in_position_order` test:

```rust
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
```

Update the `card()` test helper (it constructs a `Card` literal and will now fail to compile) — add `session_link: None,` as its last field:

```rust
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `source "$HOME/.cargo/env" && cargo test -p gavin-daemon kanban::`
Expected: FAIL to compile — `card()` doesn't compile without `session_link`, and even once fixed, the new tests would fail since the columns/read-write logic doesn't handle `session_link` yet.

- [ ] **Step 3: Add the import**

Add `SessionLink` to the top-of-file import:

```rust
use protocol::{Board, Card, Column, Label, Priority, SessionLink};
```

- [ ] **Step 4: Add the three new columns to the schema**

In `KanbanStore::open`'s `CREATE TABLE` for `kanban_cards`, add three new nullable columns:

```rust
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
```

- [ ] **Step 5: Update `replace_board`'s card INSERT**

Replace the existing card-insert block inside `replace_board`'s `for card in &column.cards` loop:

```rust
            for card in &column.cards {
                tx.execute(
                    "INSERT INTO kanban_cards (id, column_id, title, description, priority, position)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![card.id, column.id, card.title, card.description, card.priority.as_str(), card.position],
                )?;
```

with:

```rust
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
```

- [ ] **Step 6: Update `read_cards`'s SELECT and row-mapping**

Replace the existing `read_cards` function body:

```rust
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
```

with:

```rust
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
```

(Everything after this block — the `for row in rows { cards.push(row?); }` loop and the `label_ids` back-fill — is unchanged.)

- [ ] **Step 7: Run the tests to verify they pass**

Run: `source "$HOME/.cargo/env" && cargo test -p gavin-daemon kanban::`
Expected: PASS, all tests (9 total: 7 existing + 2 new).

- [ ] **Step 8: Commit**

```bash
git add crates/daemon/src/kanban.rs
git commit -m "feat(daemon): persist a card's session link in 3 new nullable columns"
```

---

### Task 3: `create_session` gains optional `cwd`/`command`

**Files:**
- Modify: `app/src-tauri/src/session.rs`
- Modify: `app/src/lib/backend.ts`

**Interfaces:**
- Consumes: nothing from Tasks 1-2 (this task is independent of the protocol/storage changes — it only touches session creation, not kanban data).
- Produces: `create_fresh_session(command_conn: &Mutex<UnixStream>, cwd: Option<&str>, command: Option<&str>) -> anyhow::Result<String>` (signature change — its one other call site, in `resolve_sessions`, is updated in this task too); `#[tauri::command] pub fn create_session(cwd: Option<String>, command: Option<String>, ...) -> Result<String, String>`; `backend.createSession(cwd?: string, command?: string): Promise<string>`.

- [ ] **Step 1: Write the failing tests**

Add to the `resolve_workspaces_tests` module (it already imports `fake_daemon_capturing_requests`), near the existing `falls_back_to_home_when_the_last_known_cwd_is_rejected_instead_of_failing_the_whole_bootstrap` test:

```rust
    #[test]
    fn create_fresh_session_with_no_command_sends_none() {
        let (client, captured, _dir) =
            fake_daemon_capturing_requests(vec![Response::SessionCreated { id: "s1".to_string() }]);
        let conn = Mutex::new(client);

        create_fresh_session(&conn, Some("/tmp"), None).unwrap();

        let requests = captured.lock().unwrap();
        match &requests[0] {
            Request::CreateSession { command, .. } => assert_eq!(command, &None),
            other => panic!("expected CreateSession, got {other:?}"),
        }
    }

    #[test]
    fn create_fresh_session_threads_an_explicit_command_through() {
        let (client, captured, _dir) =
            fake_daemon_capturing_requests(vec![Response::SessionCreated { id: "s1".to_string() }]);
        let conn = Mutex::new(client);

        create_fresh_session(&conn, Some("/tmp"), Some("npm test")).unwrap();

        let requests = captured.lock().unwrap();
        match &requests[0] {
            Request::CreateSession { command, .. } => assert_eq!(command, &Some("npm test".to_string())),
            other => panic!("expected CreateSession, got {other:?}"),
        }
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `source "$HOME/.cargo/env" && cargo test -p app` (from the repo root)
Expected: FAIL to compile — `create_fresh_session` doesn't accept a third argument yet.

- [ ] **Step 3: Extend `create_fresh_session`**

Replace the function's current body:

```rust
fn create_fresh_session(command_conn: &Mutex<UnixStream>, cwd: Option<&str>) -> anyhow::Result<String> {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/".to_string());
    let target = cwd.map(str::to_string).unwrap_or_else(|| home.clone());

    let resp = send_command(
        command_conn,
        &Request::CreateSession { workspace_path: target.clone(), cwd: target.clone(), command: None },
    )?;
    match resp {
        Response::SessionCreated { id } => return Ok(id),
        Response::Error { message } if target != home => {
            eprintln!("failed to recreate session at last-known cwd {target}, falling back to $HOME: {message}");
        }
        other => anyhow::bail!("expected SessionCreated, got {other:?}"),
    }

    let resp = send_command(
        command_conn,
        &Request::CreateSession { workspace_path: home.clone(), cwd: home.clone(), command: None },
    )?;
    match resp {
        Response::SessionCreated { id } => Ok(id),
        other => anyhow::bail!("expected SessionCreated, got {other:?}"),
    }
}
```

with:

```rust
fn create_fresh_session(
    command_conn: &Mutex<UnixStream>,
    cwd: Option<&str>,
    command: Option<&str>,
) -> anyhow::Result<String> {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/".to_string());
    let target = cwd.map(str::to_string).unwrap_or_else(|| home.clone());
    let command = command.map(str::to_string);

    let resp = send_command(
        command_conn,
        &Request::CreateSession { workspace_path: target.clone(), cwd: target.clone(), command: command.clone() },
    )?;
    match resp {
        Response::SessionCreated { id } => return Ok(id),
        Response::Error { message } if target != home => {
            eprintln!("failed to recreate session at last-known cwd {target}, falling back to $HOME: {message}");
        }
        other => anyhow::bail!("expected SessionCreated, got {other:?}"),
    }

    let resp = send_command(
        command_conn,
        &Request::CreateSession { workspace_path: home.clone(), cwd: home.clone(), command },
    )?;
    match resp {
        Response::SessionCreated { id } => Ok(id),
        other => anyhow::bail!("expected SessionCreated, got {other:?}"),
    }
}
```

(The `$HOME`-fallback retry now also carries the given `command` — only `cwd` falls back, since a valid command doesn't stop being valid just because its cwd was rejected.)

- [ ] **Step 4: Update `resolve_sessions`'s call site**

Find `*id = create_fresh_session(command_conn, last_known_cwd)?;` and change it to:

```rust
                    *id = create_fresh_session(command_conn, last_known_cwd, None)?;
```

- [ ] **Step 5: Update the `create_session` Tauri command**

Replace:

```rust
#[tauri::command]
pub fn create_session(
    command_state: State<CommandConnection>,
    daemon_state: State<DaemonConnection>,
) -> Result<String, String> {
    let id = create_fresh_session(&command_state.0, None).map_err(|e| e.to_string())?;
    send_request(&daemon_state.writer, &Request::Attach { id: id.clone() })
        .map_err(|e| e.to_string())?;
    Ok(id)
}
```

with:

```rust
#[tauri::command]
pub fn create_session(
    cwd: Option<String>,
    command: Option<String>,
    command_state: State<CommandConnection>,
    daemon_state: State<DaemonConnection>,
) -> Result<String, String> {
    let id = create_fresh_session(&command_state.0, cwd.as_deref(), command.as_deref())
        .map_err(|e| e.to_string())?;
    send_request(&daemon_state.writer, &Request::Attach { id: id.clone() })
        .map_err(|e| e.to_string())?;
    Ok(id)
}
```

- [ ] **Step 6: Extend `backend.ts`'s `createSession` wrapper**

Replace:

```ts
export function createSession(): Promise<string> {
  return invoke("create_session");
}
```

with:

```ts
export function createSession(cwd?: string, command?: string): Promise<string> {
  return invoke("create_session", { cwd, command });
}
```

Both existing call sites (`app/src/lib/layoutState.ts`, `backend.createSession()` with zero arguments, twice) keep working unchanged — `cwd`/`command` become `undefined`, which Tauri's IPC layer drops from the serialized args object entirely, and the Rust side's `Option<String>` parameters already deserialize a missing key as `None` (the same behavior already relied on throughout this project for `active_view`/`active_page_id`).

- [ ] **Step 7: Run the tests to verify they pass**

Run: `source "$HOME/.cargo/env" && cargo test -p app`
Expected: PASS, all tests (35 total: 33 existing + 2 new).

- [ ] **Step 8: Run the frontend type checker**

Run: `npm run check` (from `app/`)
Expected: 0 errors (same pre-existing warnings as before this task — this is a pure signature widening with both new parameters optional, no existing call site needs to change).

- [ ] **Step 9: Run the full workspace build and test suite**

```bash
source "$HOME/.cargo/env"
cargo build
cargo test
```

Expected: PASS, clean build (0 warnings), all tests across `protocol`, `gavin-daemon`, and `app` (should be 20 + 117 + 35 = 172 total, up from 166 before this plan: protocol 18→20, daemon 115→117, app 33→35).

- [ ] **Step 10: Commit**

```bash
git add app/src-tauri/src/session.rs app/src/lib/backend.ts
git commit -m "feat(app): extend create_session with optional cwd/command"
```
