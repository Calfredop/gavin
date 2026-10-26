//! The Workspace log (v79, ADR 0011): one row per thing that happened in a
//! workspace, recorded as it happens in `kanban.sqlite`.
//!
//! Three kinds of writer feed it. The card and human-item entries come
//! from diffing each workspace's card tree against the last one the log
//! saw (`journal_cards`), so every writer is caught -- the board, an agent
//! over gavin-mcp, an editor, `git checkout`. Runs, rails and Scheduled
//! fires are appended by the daemon code that performs them. Git entries
//! are appended from the reflogs (`append`, with the `Git*` kinds).
//!
//! The card snapshot lives in the same file as the log rather than in
//! memory, for the reason everything else in `kanban.sqlite` does: the dev
//! and release daemons share it. Each diffs inside one IMMEDIATE
//! transaction against the snapshot the other may have just written, so a
//! card moved while both are watching is logged once, by whichever looked
//! first.

use std::collections::{HashMap, HashSet};

use protocol::workspace_log::{LogCategory, LogCursor, LogEntry, LogKind, LogPayload, MAX_LOG_PAGE};
use protocol::{CardKind, GavinTree, HumanItemKind, HumanItemState};
use rusqlite::{params, Connection, TransactionBehavior};
use serde::{Deserialize, Serialize};

/// The log and the card snapshot it diffs against. `category` is the
/// kind's family, kept as a column so the tab's filter is an index-free
/// `IN` rather than a list of kinds; `search` is `LogPayload::search_text`.
const SCHEMA: &str = "
    CREATE TABLE workspace_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id TEXT NOT NULL,
        at INTEGER NOT NULL,
        kind TEXT NOT NULL,
        category TEXT NOT NULL,
        payload TEXT NOT NULL,
        search TEXT NOT NULL
    );
    CREATE INDEX workspace_log_by_time ON workspace_log (workspace_id, at);
";

/// One row per workspace: the cards as the log last saw them, as JSON. A
/// workspace with no row has never been looked at, and its first scan
/// seeds the row without logging anything -- a board that existed before
/// the log did was not created the moment the log noticed it.
const SNAPSHOT_SCHEMA: &str = "
    CREATE TABLE IF NOT EXISTS workspace_log_cards (
        workspace_id TEXT PRIMARY KEY,
        cards TEXT NOT NULL
    );
";

/// Creates the log, and the first time it does, copies `card_runs` into it
/// as run entries -- once, inside the transaction that creates the table,
/// so of two daemons opening the file together only one copies. Every run
/// after that is journaled as it starts and ends, and the copy is never
/// repeated: a cleared log stays cleared.
pub fn migrate(conn: &mut Connection) -> anyhow::Result<()> {
    conn.execute_batch(SNAPSHOT_SCHEMA)?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let exists: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workspace_log')",
        [],
        |row| row.get(0),
    )?;
    if !exists {
        tx.execute_batch(SCHEMA)?;
        copy_card_runs(&tx)?;
    }
    tx.commit()?;
    Ok(())
}

/// The run history the log starts with: a started entry per `card_runs`
/// row and a finished one per run whose exit the daemon watched -- the
/// same two a live run writes. A card still on disk lends its title; one
/// that is gone keeps its file name.
fn copy_card_runs(conn: &Connection) -> anyhow::Result<()> {
    let mut stmt = conn.prepare(
        "SELECT workspace_id, path, session_id, command, started_at, ended_at, exit_code, outcome
         FROM card_runs ORDER BY id",
    )?;
    type Row = (String, String, String, Option<String>, i64, Option<i64>, Option<i32>, String);
    let rows: Vec<Row> = stmt
        .query_map([], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?))
        })?
        .collect::<Result<_, _>>()?;
    let mut titles: HashMap<String, Option<String>> = HashMap::new();
    for (workspace_id, path, session_id, command, started_at, ended_at, exit_code, outcome) in rows {
        let title = titles.entry(path.clone()).or_insert_with(|| card_title_on_disk(&path)).clone();
        let payload = run_payload(&path, title, command.as_deref(), &session_id);
        append(conn, &workspace_id, started_at, LogKind::RunStarted, &payload)?;
        if let (Some(ended_at), "exited") = (ended_at, outcome.as_str()) {
            let finished = LogPayload { exit_code, ..payload };
            append(conn, &workspace_id, ended_at, LogKind::RunFinished, &finished)?;
        }
    }
    Ok(())
}

/// A card's title read off its file, or None when there is no file to
/// read.
pub fn card_title_on_disk(path: &str) -> Option<String> {
    let path = std::path::Path::new(path);
    let content = std::fs::read_to_string(path).ok()?;
    Some(crate::gavin::plan_file_info(path, &content).title)
}

/// The agent a run launched, read off its command: the first word that is
/// not an environment assignment, without its directory. None for a run
/// with no command (a shell the human typed into).
pub fn agent_of(command: Option<&str>) -> Option<String> {
    let word = command?
        .split_whitespace()
        .find(|w| !w.contains('=') && *w != "exec" && *w != "env")?;
    let word = word.trim_matches(|c| c == '\'' || c == '"');
    let name = word.rsplit(['/', '\\']).next().unwrap_or(word);
    (!name.is_empty()).then(|| name.to_string())
}

/// What a run entry carries, started or finished.
pub fn run_payload(path: &str, title: Option<String>, command: Option<&str>, session_id: &str) -> LogPayload {
    LogPayload {
        card_file: file_name_of(path),
        card_path: Some(path.to_string()),
        card_title: title,
        agent: agent_of(command),
        session_id: Some(session_id.to_string()),
        ..Default::default()
    }
}

fn file_name_of(path: &str) -> Option<String> {
    std::path::Path::new(path).file_name().map(|n| n.to_string_lossy().to_string())
}

/// Writes one entry and hands it back with its id.
pub fn append(
    conn: &Connection,
    workspace_id: &str,
    at: i64,
    kind: LogKind,
    payload: &LogPayload,
) -> rusqlite::Result<LogEntry> {
    let category = kind.category().map(LogCategory::as_str).unwrap_or("");
    conn.execute(
        "INSERT INTO workspace_log (workspace_id, at, kind, category, payload, search)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            workspace_id,
            at,
            kind.as_str(),
            category,
            serde_json::to_string(payload).unwrap_or_else(|_| "{}".to_string()),
            payload.search_text()
        ],
    )?;
    Ok(LogEntry {
        id: conn.last_insert_rowid(),
        workspace_id: workspace_id.to_string(),
        at,
        kind,
        payload: payload.clone(),
    })
}

/// A page, newest first, strictly older than `before`; and whether older
/// entries match beyond it.
pub fn page(
    conn: &Connection,
    workspace_id: &str,
    before: Option<LogCursor>,
    limit: u32,
    categories: &[LogCategory],
    search: Option<&str>,
) -> anyhow::Result<(Vec<LogEntry>, bool)> {
    let limit = limit.clamp(1, MAX_LOG_PAGE);
    let mut sql = String::from("SELECT id, at, kind, payload FROM workspace_log WHERE workspace_id = ?");
    let mut args: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(workspace_id.to_string())];
    if let Some(c) = before {
        sql.push_str(" AND (at < ? OR (at = ? AND id < ?))");
        args.extend([Box::new(c.at) as Box<dyn rusqlite::ToSql>, Box::new(c.at), Box::new(c.id)]);
    }
    // Every family, or none named, is no filter at all: that is also what
    // keeps an Unknown kind (a newer daemon's) visible.
    let wanted: HashSet<LogCategory> = categories.iter().copied().collect();
    if !wanted.is_empty() && wanted.len() < LogCategory::ALL.len() {
        let marks = vec!["?"; wanted.len()].join(", ");
        sql.push_str(&format!(" AND category IN ({marks})"));
        for c in LogCategory::ALL.into_iter().filter(|c| wanted.contains(c)) {
            args.push(Box::new(c.as_str()));
        }
    }
    if let Some(needle) = search.map(str::trim).filter(|s| !s.is_empty()) {
        sql.push_str(" AND search LIKE ? ESCAPE '\\'");
        args.push(Box::new(format!("%{}%", like_escape(&needle.to_lowercase()))));
    }
    sql.push_str(" ORDER BY at DESC, id DESC LIMIT ?");
    args.push(Box::new(i64::from(limit) + 1));

    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(args.iter().map(|a| a.as_ref())), |row| {
        let payload: String = row.get(3)?;
        Ok(LogEntry {
            id: row.get(0)?,
            workspace_id: workspace_id.to_string(),
            at: row.get(1)?,
            kind: LogKind::parse(&row.get::<_, String>(2)?),
            payload: serde_json::from_str(&payload).unwrap_or_default(),
        })
    })?;
    let mut entries: Vec<LogEntry> = rows.collect::<Result<_, _>>()?;
    let more = entries.len() > limit as usize;
    entries.truncate(limit as usize);
    Ok((entries, more))
}

fn like_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if matches!(c, '%' | '_' | '\\') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// Deletes log rows older than `older_than`, or all of them. Never
/// `card_runs`, and never the card snapshot: clearing the log is not
/// forgetting what the board looks like, or the next scan would log every
/// card as new.
pub fn clear(conn: &Connection, workspace_id: &str, older_than: Option<i64>) -> anyhow::Result<u64> {
    let removed = match older_than {
        Some(t) => conn.execute(
            "DELETE FROM workspace_log WHERE workspace_id = ?1 AND at < ?2",
            params![workspace_id, t],
        )?,
        None => conn.execute("DELETE FROM workspace_log WHERE workspace_id = ?1", params![workspace_id])?,
    };
    Ok(removed as u64)
}

// --- The card diff ---------------------------------------------------------

/// A card as the log remembers it between scans.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CardSnap {
    /// The context folder it belongs to: with the file name, the card's
    /// identity. File names are unique per context, and a card moving
    /// between `plans/`, `done/` and `archive/` keeps both.
    pub context: String,
    pub file_name: String,
    pub path: String,
    pub title: String,
    /// The board column: its own status, its parent's for a nested task,
    /// and Done for a card filed under `done/` that says nothing.
    pub column: Option<String>,
    pub archived: bool,
    pub human: Vec<HumanSnap>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HumanSnap {
    pub kind: HumanItemKind,
    pub text: String,
    pub state: HumanItemState,
    pub latest: Option<String>,
}

/// One scan's cards, with what the diff needs to know about the scan
/// itself.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct CardScan {
    pub cards: Vec<CardSnap>,
    /// Every context the scan saw. A card whose context is missing from a
    /// scan -- an outside folder unmounted, a context mid-move -- is not
    /// deleted, only not looked at.
    pub contexts: HashSet<String>,
    /// Contexts whose walk hit the file cap: some of their cards were not
    /// read, so none of them can be said to be gone.
    pub truncated: HashSet<String>,
}

const TRUNCATED_MARKER: &str = "_scan_truncated.md";

/// Reads a tree into what the diff compares. None for a root that is
/// missing, which says nothing about its cards.
pub fn scan_of(tree: &GavinTree) -> Option<CardScan> {
    if tree.root_missing {
        return None;
    }
    let mut scan = CardScan::default();
    for ctx in &tree.contexts {
        scan.contexts.insert(ctx.folder_path.clone());
        let by_name: HashMap<&str, &protocol::PlanFileInfo> =
            ctx.plans.iter().map(|p| (p.file_name.as_str(), p)).collect();
        for plan in &ctx.plans {
            if plan.file_name == TRUNCATED_MARKER && plan.parse_warning {
                scan.truncated.insert(ctx.folder_path.clone());
                continue;
            }
            let dir = parent_dir_name(&plan.path);
            let nested_parent = (plan.kind == CardKind::Task && plan.status.is_none())
                .then_some(plan.parent.as_deref())
                .flatten();
            let column = match nested_parent {
                Some(parent) => by_name.get(parent).and_then(|p| p.status.clone()),
                None => plan.status.clone(),
            }
            .or_else(|| (dir == Some(crate::gavin::DONE_DIR)).then(|| "Done".to_string()));
            scan.cards.push(CardSnap {
                context: ctx.folder_path.clone(),
                file_name: plan.file_name.clone(),
                path: plan.path.clone(),
                title: plan.title.clone(),
                column,
                archived: dir == Some(crate::gavin::ARCHIVE_DIR),
                human: plan
                    .human_items
                    .iter()
                    .flatten()
                    .map(|h| HumanSnap { kind: h.kind, text: h.text.clone(), state: h.state, latest: h.latest.clone() })
                    .collect(),
            });
        }
    }
    Some(scan)
}

/// The name of the folder a card sits in, when that folder is a context's
/// `done/` or `archive/`.
fn parent_dir_name(path: &str) -> Option<&'static str> {
    let p = std::path::Path::new(path);
    let dir = p.parent()?;
    let name = dir.file_name()?.to_str()?;
    let in_plans = dir.parent().and_then(|d| d.file_name()).is_some_and(|n| n == "plans");
    if !in_plans {
        return None;
    }
    [crate::gavin::DONE_DIR, crate::gavin::ARCHIVE_DIR].into_iter().find(|d| *d == name)
}

/// The entries between two looks at a workspace's cards, and what the log
/// remembers next. `still_there` is asked about a card the scan did not
/// find before it is called deleted: a save that replaces a file can be
/// caught between its two halves.
pub fn diff_cards(
    old: &[CardSnap],
    scan: &CardScan,
    still_there: impl Fn(&CardSnap) -> bool,
) -> (Vec<(LogKind, LogPayload)>, Vec<CardSnap>) {
    let key = |c: &CardSnap| (c.context.clone(), c.file_name.clone());
    let old_by_key: HashMap<(String, String), &CardSnap> = old.iter().map(|c| (key(c), c)).collect();
    let new_keys: HashSet<(String, String)> = scan.cards.iter().map(key).collect();

    let mut events = Vec::new();
    let mut next: Vec<CardSnap> = scan.cards.clone();

    // Gone from where they were. Kept aside first, so a card that moved to
    // another context under the same name is matched as a move rather
    // than a delete and a create.
    let mut gone: Vec<&CardSnap> = Vec::new();
    for o in old {
        if new_keys.contains(&key(o)) {
            continue;
        }
        let unseen = !scan.contexts.contains(&o.context) || scan.truncated.contains(&o.context);
        if unseen || still_there(o) {
            next.push(o.clone());
        } else {
            gone.push(o);
        }
    }
    let mut gone_by_name: HashMap<&str, Vec<&CardSnap>> = HashMap::new();
    for g in &gone {
        gone_by_name.entry(g.file_name.as_str()).or_default().push(g);
    }

    for n in &scan.cards {
        let before = match old_by_key.get(&key(n)) {
            Some(o) => Some(*o),
            None => gone_by_name.get_mut(n.file_name.as_str()).and_then(|v| v.pop()),
        };
        match before {
            Some(o) => events.extend(card_changes(o, n)),
            None => {
                events.push((LogKind::CardCreated, card_payload(n)));
                for h in &n.human {
                    events.push((filed_kind(h.kind), item_payload(n, h)));
                }
            }
        }
    }
    for remaining in gone_by_name.into_values().flatten() {
        events.push((LogKind::CardDeleted, card_payload(remaining)));
    }
    (events, next)
}

fn card_payload(c: &CardSnap) -> LogPayload {
    LogPayload {
        card_file: Some(c.file_name.clone()),
        card_path: Some(c.path.clone()),
        card_title: Some(c.title.clone()),
        ..Default::default()
    }
}

fn item_payload(c: &CardSnap, h: &HumanSnap) -> LogPayload {
    LogPayload { item_text: Some(h.text.clone()), item_outcome: h.latest.clone(), ..card_payload(c) }
}

fn filed_kind(kind: HumanItemKind) -> LogKind {
    match kind {
        HumanItemKind::Decision => LogKind::DecisionFiled,
        HumanItemKind::Test => LogKind::TestFiled,
    }
}

/// What changed about one card between two looks.
fn card_changes(o: &CardSnap, n: &CardSnap) -> Vec<(LogKind, LogPayload)> {
    let mut out = Vec::new();
    if !o.archived && n.archived {
        out.push((LogKind::CardArchived, card_payload(n)));
    } else if o.archived && !n.archived {
        out.push((LogKind::CardUnarchived, card_payload(n)));
    }
    if o.column != n.column {
        out.push((
            LogKind::CardMoved,
            LogPayload { from_column: o.column.clone(), to_column: n.column.clone(), ..card_payload(n) },
        ));
    }
    if o.title != n.title {
        out.push((LogKind::CardRetitled, LogPayload { old_title: Some(o.title.clone()), ..card_payload(n) }));
    }
    // Items are matched by kind and text, each old one used once: the
    // same check filed twice is two items.
    let mut unmatched: Vec<&HumanSnap> = o.human.iter().collect();
    for h in &n.human {
        let found = unmatched.iter().position(|u| u.kind == h.kind && u.text == h.text);
        let Some(i) = found else {
            out.push((filed_kind(h.kind), item_payload(n, h)));
            continue;
        };
        let was = unmatched.remove(i);
        if was.state == h.state {
            continue;
        }
        let kind = match (h.kind, h.state) {
            (HumanItemKind::Decision, HumanItemState::Answered) => Some(LogKind::DecisionAnswered),
            (HumanItemKind::Test, HumanItemState::Passed) => Some(LogKind::TestPassed),
            (HumanItemKind::Test, HumanItemState::Failed) => Some(LogKind::TestFailed),
            // A failed test asked again: the same item, filed afresh.
            (HumanItemKind::Test, HumanItemState::Open) => Some(LogKind::TestFiled),
            _ => None,
        };
        if let Some(kind) = kind {
            out.push((kind, item_payload(n, h)));
        }
    }
    out
}

/// Diffs one scan against the stored snapshot and appends what changed,
/// in one IMMEDIATE transaction. A workspace never looked at before is
/// seeded and logs nothing.
pub fn journal_cards(
    conn: &mut Connection,
    workspace_id: &str,
    scan: &CardScan,
    now: i64,
    noticed_on_start: bool,
) -> anyhow::Result<Vec<LogEntry>> {
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let stored: Option<String> = tx
        .query_row(
            "SELECT cards FROM workspace_log_cards WHERE workspace_id = ?1",
            params![workspace_id],
            |row| row.get(0),
        )
        .ok();
    let mut entries = Vec::new();
    let next = match stored.as_deref().map(serde_json::from_str::<Vec<CardSnap>>) {
        Some(Ok(old)) => {
            let (events, next) =
                diff_cards(&old, scan, |c| std::path::Path::new(&c.path).is_file());
            for (kind, mut payload) in events {
                payload.noticed_on_start = noticed_on_start;
                entries.push(append(&tx, workspace_id, now, kind, &payload)?);
            }
            next
        }
        // Never seen, or a snapshot this build cannot read: start from
        // this scan rather than logging the whole board as new.
        _ => scan.cards.clone(),
    };
    tx.execute(
        "INSERT INTO workspace_log_cards (workspace_id, cards) VALUES (?1, ?2)
         ON CONFLICT(workspace_id) DO UPDATE SET cards = excluded.cards",
        params![workspace_id, serde_json::to_string(&next)?],
    )?;
    tx.commit()?;
    Ok(entries)
}

// --- Rails -----------------------------------------------------------------

/// A rail as a run-state write finds it.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct RailLook {
    pub workspace_id: String,
    pub name: String,
    /// Its run state, None for no row (idle).
    pub state: Option<String>,
    /// Every step done or skipped.
    pub finished: bool,
    /// A stalled step's reason, when one is stalled.
    pub stalled: Option<String>,
}

impl RailLook {
    pub fn of(o: &protocol::Orchestration, rail_id: &str, workspace_id: &str) -> Option<RailLook> {
        let rail = o.rails.iter().find(|r| r.id == rail_id)?;
        let state_of = |step: &str| o.step_runs.iter().find(|s| s.step_id == step);
        let steps: Vec<&protocol::Step> = rail.stages.iter().flat_map(|s| s.steps.iter()).collect();
        Some(RailLook {
            workspace_id: workspace_id.to_string(),
            name: rail.name.clone(),
            state: o.rail_runs.iter().find(|r| r.rail_id == rail_id).map(|r| r.state.clone()),
            finished: !steps.is_empty()
                && steps.iter().all(|s| state_of(&s.id).is_some_and(|r| matches!(r.state.as_str(), "done" | "skipped"))),
            stalled: steps
                .iter()
                .filter_map(|s| state_of(&s.id))
                .find(|r| r.state == "stalled")
                .map(|r| r.reason.clone().unwrap_or_default()),
        })
    }
}

/// The entry one rail run-state write makes, if any. The app's states are
/// idle, running and paused; which word a transition is depends on where
/// it came from and on the rail's steps after it:
///
/// - into running from idle is a start, from paused a resume;
/// - into paused is a failure when a step is stalled (the scheduler stalls
///   the step before it pauses the rail), and a pause otherwise;
/// - into idle is a finish when every step is done -- a Reset idles a
///   rail too, with its steps set back to pending, and that is not one.
pub fn rail_transition(before: Option<&str>, after: &RailLook) -> Option<(LogKind, Option<String>)> {
    let before = before.unwrap_or("idle");
    let after_state = after.state.as_deref().unwrap_or("idle");
    if before == after_state {
        return None;
    }
    match after_state {
        "running" if before == "paused" => Some((LogKind::RailResumed, None)),
        "running" => Some((LogKind::RailStarted, None)),
        "paused" => match &after.stalled {
            Some(reason) => Some((LogKind::RailFailed, Some(reason.clone()).filter(|r| !r.is_empty()))),
            None => Some((LogKind::RailPaused, None)),
        },
        "idle" if after.finished => Some((LogKind::RailFinished, None)),
        _ => None,
    }
}

pub fn rail_payload(rail_id: &str, name: &str) -> LogPayload {
    LogPayload { rail_id: Some(rail_id.to_string()), rail_name: Some(name.to_string()), ..Default::default() }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn card(file: &str, column: Option<&str>) -> CardSnap {
        CardSnap {
            context: "/r".into(),
            file_name: file.into(),
            path: format!("/r/.gavin-root/plans/{file}"),
            title: format!("[feat] {file}"),
            column: column.map(Into::into),
            archived: false,
            human: vec![],
        }
    }

    fn scan(cards: Vec<CardSnap>) -> CardScan {
        let contexts = cards.iter().map(|c| c.context.clone()).chain(["/r".to_string()]).collect();
        CardScan { cards, contexts, truncated: HashSet::new() }
    }

    fn kinds(events: &[(LogKind, LogPayload)]) -> Vec<LogKind> {
        events.iter().map(|(k, _)| *k).collect()
    }

    fn gone(_: &CardSnap) -> bool {
        false
    }

    #[test]
    fn a_new_card_is_created_and_a_vanished_one_deleted() {
        let (events, next) = diff_cards(&[card("a.md", None)], &scan(vec![card("b.md", None)]), gone);
        assert_eq!(kinds(&events), vec![LogKind::CardCreated, LogKind::CardDeleted]);
        assert_eq!(events[0].1.card_file.as_deref(), Some("b.md"));
        assert_eq!(events[1].1.card_file.as_deref(), Some("a.md"));
        assert_eq!(next, vec![card("b.md", None)]);
    }

    #[test]
    fn a_card_still_on_disk_is_not_deleted_by_a_scan_that_missed_it() {
        let (events, next) = diff_cards(&[card("a.md", None)], &scan(vec![]), |_| true);
        assert!(events.is_empty());
        assert_eq!(next, vec![card("a.md", None)]);
    }

    #[test]
    fn archiving_moves_the_file_and_logs_one_archive() {
        let mut archived = card("a.md", Some("To Do"));
        archived.path = "/r/.gavin-root/plans/archive/a.md".into();
        archived.archived = true;
        let (events, _) = diff_cards(&[card("a.md", Some("To Do"))], &scan(vec![archived.clone()]), gone);
        assert_eq!(kinds(&events), vec![LogKind::CardArchived]);
        assert_eq!(events[0].1.card_path.as_deref(), Some("/r/.gavin-root/plans/archive/a.md"));

        let (events, _) = diff_cards(&[archived], &scan(vec![card("a.md", Some("To Do"))]), gone);
        assert_eq!(kinds(&events), vec![LogKind::CardUnarchived]);
    }

    #[test]
    fn a_move_to_another_context_under_the_same_name_is_not_a_delete_and_a_create() {
        let mut moved = card("a.md", Some("To Do"));
        moved.context = "/r/sub".into();
        moved.path = "/r/sub/.gavin/plans/a.md".into();
        let s = scan(vec![moved.clone()]);
        let (events, next) = diff_cards(&[card("a.md", Some("To Do"))], &s, gone);
        assert!(events.is_empty(), "{events:?}");
        assert_eq!(next, vec![moved]);
    }

    #[test]
    fn a_column_change_and_a_file_into_done_are_moves() {
        let (events, _) =
            diff_cards(&[card("a.md", Some("To Do"))], &scan(vec![card("a.md", Some("In Progress"))]), gone);
        assert_eq!(kinds(&events), vec![LogKind::CardMoved]);
        assert_eq!(events[0].1.from_column.as_deref(), Some("To Do"));
        assert_eq!(events[0].1.to_column.as_deref(), Some("In Progress"));

        // Status written and the file filed in the same scan: one move.
        let mut done = card("a.md", Some("Done"));
        done.path = "/r/.gavin-root/plans/done/a.md".into();
        let (events, _) = diff_cards(&[card("a.md", Some("In Progress"))], &scan(vec![done.clone()]), gone);
        assert_eq!(kinds(&events), vec![LogKind::CardMoved]);
        assert_eq!(events[0].1.to_column.as_deref(), Some("Done"));
        // Filed a second time with nothing else changed: nothing.
        let (events, _) = diff_cards(&[done.clone()], &scan(vec![done]), gone);
        assert!(events.is_empty());
    }

    #[test]
    fn a_retitle_carries_both_titles() {
        let mut renamed = card("a.md", None);
        renamed.title = "[feat] New".into();
        let (events, _) = diff_cards(&[card("a.md", None)], &scan(vec![renamed]), gone);
        assert_eq!(kinds(&events), vec![LogKind::CardRetitled]);
        assert_eq!(events[0].1.old_title.as_deref(), Some("[feat] a.md"));
        assert_eq!(events[0].1.card_title.as_deref(), Some("[feat] New"));
    }

    fn item(kind: HumanItemKind, text: &str, state: HumanItemState) -> HumanSnap {
        HumanSnap { kind, text: text.into(), state, latest: None }
    }

    fn with_items(items: Vec<HumanSnap>) -> CardSnap {
        CardSnap { human: items, ..card("a.md", None) }
    }

    #[test]
    fn every_human_item_transition_is_its_own_entry() {
        use HumanItemKind::{Decision, Test};
        use HumanItemState::{Answered, Failed, Open, Passed};
        let cases = [
            (vec![], vec![item(Decision, "q", Open)], LogKind::DecisionFiled),
            (vec![item(Decision, "q", Open)], vec![item(Decision, "q", Answered)], LogKind::DecisionAnswered),
            (vec![], vec![item(Test, "t", Open)], LogKind::TestFiled),
            (vec![item(Test, "t", Open)], vec![item(Test, "t", Passed)], LogKind::TestPassed),
            (vec![item(Test, "t", Open)], vec![item(Test, "t", Failed)], LogKind::TestFailed),
            (vec![item(Test, "t", Failed)], vec![item(Test, "t", Open)], LogKind::TestFiled),
        ];
        for (before, after, want) in cases {
            let (events, _) = diff_cards(&[with_items(before.clone())], &scan(vec![with_items(after.clone())]), gone);
            assert_eq!(kinds(&events), vec![want], "{before:?} -> {after:?}");
            assert_eq!(events[0].1.item_text, Some(after[0].text.clone()));
        }
        // A tick with no outcome line is not an entry.
        let same = vec![item(Test, "t", Open)];
        let (events, _) = diff_cards(&[with_items(same.clone())], &scan(vec![with_items(same)]), gone);
        assert!(events.is_empty());
    }

    #[test]
    fn a_card_created_with_items_files_each_of_them() {
        let (events, _) =
            diff_cards(&[], &scan(vec![with_items(vec![item(HumanItemKind::Test, "t", HumanItemState::Open)])]), gone);
        assert_eq!(kinds(&events), vec![LogKind::CardCreated, LogKind::TestFiled]);
    }

    #[test]
    fn an_unseen_or_truncated_context_keeps_its_cards() {
        let mut outside = card("x.md", None);
        outside.context = "/elsewhere".into();
        let (events, next) = diff_cards(&[outside.clone()], &scan(vec![]), gone);
        assert!(events.is_empty());
        assert_eq!(next, vec![outside]);

        let mut s = scan(vec![]);
        s.truncated.insert("/r".into());
        let (events, next) = diff_cards(&[card("a.md", None)], &s, gone);
        assert!(events.is_empty());
        assert_eq!(next.len(), 1);
    }

    fn plan(path: &str, status: Option<&str>, kind: CardKind, parent: Option<&str>) -> protocol::PlanFileInfo {
        let mut p = crate::gavin::plan_file_info(std::path::Path::new(path), "");
        p.status = status.map(Into::into);
        p.kind = kind;
        p.parent = parent.map(Into::into);
        p
    }

    fn tree(plans: Vec<protocol::PlanFileInfo>) -> GavinTree {
        GavinTree {
            root_path: "/r".into(),
            root_missing: false,
            contexts: vec![protocol::GavinContext {
                folder_path: "/r".into(),
                kind: protocol::GavinContextKind::Root,
                name: "r".into(),
                plans,
                docs: vec![],
                specs: vec![],
                has_prd: false,
                config_warning: false,
                agent: None,
                prd: None,
                outside: false,
            }],
        }
    }

    #[test]
    fn a_nested_task_takes_its_parents_column_and_done_and_archive_are_read_off_the_folder() {
        let t = tree(vec![
            plan("/r/.gavin-root/plans/p.md", Some("In Progress"), CardKind::Plan, None),
            plan("/r/.gavin-root/plans/t.md", None, CardKind::Task, Some("p.md")),
            plan("/r/.gavin-root/plans/done/d.md", None, CardKind::Note, None),
            plan("/r/.gavin-root/plans/archive/z.md", Some("To Do"), CardKind::Note, None),
        ]);
        let s = scan_of(&t).unwrap();
        let col = |f: &str| s.cards.iter().find(|c| c.file_name == f).unwrap().column.clone();
        assert_eq!(col("t.md").as_deref(), Some("In Progress"));
        assert_eq!(col("d.md").as_deref(), Some("Done"));
        assert!(s.cards.iter().find(|c| c.file_name == "z.md").unwrap().archived);
        assert!(!s.cards.iter().find(|c| c.file_name == "d.md").unwrap().archived);

        let mut missing = t.clone();
        missing.root_missing = true;
        assert!(scan_of(&missing).is_none());
    }

    fn store() -> (tempfile::TempDir, Connection) {
        let dir = tempfile::tempdir().unwrap();
        let mut conn = Connection::open(dir.path().join("kanban.sqlite")).unwrap();
        conn.execute_batch(
            "CREATE TABLE card_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL,
               path TEXT NOT NULL, session_id TEXT NOT NULL, command TEXT, started_at INTEGER NOT NULL,
               ended_at INTEGER, exit_code INTEGER, outcome TEXT NOT NULL);",
        )
        .unwrap();
        migrate(&mut conn).unwrap();
        (dir, conn)
    }

    #[test]
    fn the_first_look_seeds_and_the_next_one_logs_with_its_flag() {
        let (_dir, mut conn) = store();
        let first = journal_cards(&mut conn, "ws", &scan(vec![card("a.md", None)]), 10, true).unwrap();
        assert!(first.is_empty());
        let second =
            journal_cards(&mut conn, "ws", &scan(vec![card("a.md", None), card("b.md", None)]), 20, true).unwrap();
        assert_eq!(second.len(), 1);
        assert_eq!((second[0].kind, second[0].at, second[0].payload.noticed_on_start), (LogKind::CardCreated, 20, true));
        // A second daemon diffing the same scan finds nothing left to log.
        let again =
            journal_cards(&mut conn, "ws", &scan(vec![card("a.md", None), card("b.md", None)]), 30, false).unwrap();
        assert!(again.is_empty());
    }

    #[test]
    fn pages_run_newest_first_and_filter_by_family_and_search() {
        let (_dir, conn) = store();
        let card_entry = |title: &str| LogPayload { card_title: Some(title.into()), ..Default::default() };
        append(&conn, "ws", 100, LogKind::CardCreated, &card_entry("Alpha")).unwrap();
        append(&conn, "ws", 300, LogKind::CardMoved, &card_entry("Beta")).unwrap();
        let git = LogPayload { branch: Some("feat/Login".into()), ..Default::default() };
        // Older than the move it was written after: a reflog's own time.
        append(&conn, "ws", 200, LogKind::GitCommit, &git).unwrap();
        append(&conn, "other", 400, LogKind::CardCreated, &card_entry("Gamma")).unwrap();

        let (all, more) = page(&conn, "ws", None, 10, &[], None).unwrap();
        assert_eq!(all.iter().map(|e| e.at).collect::<Vec<_>>(), vec![300, 200, 100]);
        assert!(!more);

        let (first, more) = page(&conn, "ws", None, 2, &[], None).unwrap();
        assert_eq!(first.len(), 2);
        assert!(more);
        let (rest, more) = page(&conn, "ws", Some(first[1].cursor()), 2, &[], None).unwrap();
        assert_eq!(rest.iter().map(|e| e.at).collect::<Vec<_>>(), vec![100]);
        assert!(!more);

        let (git_only, _) = page(&conn, "ws", None, 10, &[LogCategory::Git], None).unwrap();
        assert_eq!(git_only.iter().map(|e| e.kind).collect::<Vec<_>>(), vec![LogKind::GitCommit]);
        let (by_branch, _) = page(&conn, "ws", None, 10, &[], Some("FEAT/login")).unwrap();
        assert_eq!(by_branch.len(), 1);
        let (by_title, _) = page(&conn, "ws", None, 10, &[LogCategory::Cards], Some("alp")).unwrap();
        assert_eq!(by_title.iter().map(|e| e.at).collect::<Vec<_>>(), vec![100]);
        let (wild, _) = page(&conn, "ws", None, 10, &[], Some("%")).unwrap();
        assert!(wild.is_empty(), "a % is a character, not a wildcard");
    }

    #[test]
    fn rail_transitions_read_where_they_came_from_and_what_the_steps_say() {
        let look = |state: Option<&str>, finished: bool, stalled: Option<&str>| RailLook {
            workspace_id: "ws".into(),
            name: "api".into(),
            state: state.map(Into::into),
            finished,
            stalled: stalled.map(Into::into),
        };
        let k = |before: Option<&str>, after: RailLook| rail_transition(before, &after).map(|(k, _)| k);
        assert_eq!(k(None, look(Some("running"), false, None)), Some(LogKind::RailStarted));
        assert_eq!(k(Some("idle"), look(Some("running"), false, None)), Some(LogKind::RailStarted));
        assert_eq!(k(Some("paused"), look(Some("running"), false, None)), Some(LogKind::RailResumed));
        assert_eq!(k(Some("running"), look(Some("paused"), false, None)), Some(LogKind::RailPaused));
        assert_eq!(
            rail_transition(Some("running"), &look(Some("paused"), false, Some("no such worktree"))),
            Some((LogKind::RailFailed, Some("no such worktree".into())))
        );
        assert_eq!(k(Some("running"), look(Some("idle"), true, None)), Some(LogKind::RailFinished));
        // A Reset: idle with its steps pending again.
        assert_eq!(k(Some("paused"), look(Some("idle"), false, None)), None);
        // An advance between stages.
        assert_eq!(k(Some("running"), look(Some("running"), false, None)), None);
    }

    #[test]
    fn the_agent_is_the_first_word_that_is_not_an_assignment() {
        assert_eq!(agent_of(Some("claude --session-id x 'do it'")).as_deref(), Some("claude"));
        assert_eq!(agent_of(Some("FOO=1 /usr/local/bin/codex exec")).as_deref(), Some("codex"));
        assert_eq!(agent_of(Some("env A=b opencode run")).as_deref(), Some("opencode"));
        assert_eq!(agent_of(None), None);
        assert_eq!(agent_of(Some("   ")), None);
    }
}
