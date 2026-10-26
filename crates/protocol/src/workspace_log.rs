//! The Workspace log (v79, ADR 0011): one entry per thing that happened in
//! a workspace, recorded by the daemon as it happens and never derived
//! afterwards.
//!
//! Pure: the daemon keeps the rows in `kanban.sqlite` and diffs the card
//! tree to find most of them; this module is only the shapes both ends
//! agree on.
//!
//! An entry is a [`LogKind`] and a flat [`LogPayload`] whose fields each
//! kind fills as it needs -- a card's file name and title, a column moved
//! between, a rail, a human item's text, a git branch. Flat rather than an
//! enum of payloads so a row written by a newer daemon still reads in an
//! older app: an unknown kind is [`LogKind::Unknown`], and its payload is
//! still a payload.

use serde::{Deserialize, Serialize};

/// What happened. Snake case on the wire and in the store's `kind`
/// column.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LogKind {
    CardCreated,
    CardDeleted,
    CardArchived,
    /// Out of the archive and back on the board.
    CardUnarchived,
    /// Its effective column changed, Done included.
    CardMoved,
    CardRetitled,

    RunStarted,
    RunFinished,

    RailCreated,
    RailStarted,
    RailPaused,
    RailResumed,
    RailFinished,
    /// Paused by a stalled step rather than by a person.
    RailFailed,
    RailDeleted,

    DecisionFiled,
    DecisionAnswered,
    /// Filed, or re-armed after a failure.
    TestFiled,
    TestPassed,
    TestFailed,

    ScheduledFired,

    GitCommit,
    GitCheckout,
    GitMerge,
    GitPull,
    GitRebase,
    GitReset,
    GitPush,
    GitBranchDeleted,

    /// A kind this build does not know: a newer daemon's. Kept so one new
    /// kind does not make a whole page unreadable.
    #[serde(other)]
    Unknown,
}

/// The six families the Log tab filters by.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LogCategory {
    Cards,
    Runs,
    Rails,
    Human,
    Scheduled,
    Git,
}

impl LogCategory {
    pub const ALL: [LogCategory; 6] = [
        LogCategory::Cards,
        LogCategory::Runs,
        LogCategory::Rails,
        LogCategory::Human,
        LogCategory::Scheduled,
        LogCategory::Git,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            LogCategory::Cards => "cards",
            LogCategory::Runs => "runs",
            LogCategory::Rails => "rails",
            LogCategory::Human => "human",
            LogCategory::Scheduled => "scheduled",
            LogCategory::Git => "git",
        }
    }
}

impl LogKind {
    /// Every kind this build writes, for tests that walk them all.
    pub const ALL: [LogKind; 29] = [
        LogKind::CardCreated,
        LogKind::CardDeleted,
        LogKind::CardArchived,
        LogKind::CardUnarchived,
        LogKind::CardMoved,
        LogKind::CardRetitled,
        LogKind::RunStarted,
        LogKind::RunFinished,
        LogKind::RailCreated,
        LogKind::RailStarted,
        LogKind::RailPaused,
        LogKind::RailResumed,
        LogKind::RailFinished,
        LogKind::RailFailed,
        LogKind::RailDeleted,
        LogKind::DecisionFiled,
        LogKind::DecisionAnswered,
        LogKind::TestFiled,
        LogKind::TestPassed,
        LogKind::TestFailed,
        LogKind::ScheduledFired,
        LogKind::GitCommit,
        LogKind::GitCheckout,
        LogKind::GitMerge,
        LogKind::GitPull,
        LogKind::GitRebase,
        LogKind::GitReset,
        LogKind::GitPush,
        LogKind::GitBranchDeleted,
    ];

    /// The store's spelling, the same as the wire's.
    pub fn as_str(self) -> &'static str {
        match self {
            LogKind::CardCreated => "card_created",
            LogKind::CardDeleted => "card_deleted",
            LogKind::CardArchived => "card_archived",
            LogKind::CardUnarchived => "card_unarchived",
            LogKind::CardMoved => "card_moved",
            LogKind::CardRetitled => "card_retitled",
            LogKind::RunStarted => "run_started",
            LogKind::RunFinished => "run_finished",
            LogKind::RailCreated => "rail_created",
            LogKind::RailStarted => "rail_started",
            LogKind::RailPaused => "rail_paused",
            LogKind::RailResumed => "rail_resumed",
            LogKind::RailFinished => "rail_finished",
            LogKind::RailFailed => "rail_failed",
            LogKind::RailDeleted => "rail_deleted",
            LogKind::DecisionFiled => "decision_filed",
            LogKind::DecisionAnswered => "decision_answered",
            LogKind::TestFiled => "test_filed",
            LogKind::TestPassed => "test_passed",
            LogKind::TestFailed => "test_failed",
            LogKind::ScheduledFired => "scheduled_fired",
            LogKind::GitCommit => "git_commit",
            LogKind::GitCheckout => "git_checkout",
            LogKind::GitMerge => "git_merge",
            LogKind::GitPull => "git_pull",
            LogKind::GitRebase => "git_rebase",
            LogKind::GitReset => "git_reset",
            LogKind::GitPush => "git_push",
            LogKind::GitBranchDeleted => "git_branch_deleted",
            LogKind::Unknown => "unknown",
        }
    }

    pub fn parse(s: &str) -> LogKind {
        LogKind::ALL.into_iter().find(|k| k.as_str() == s).unwrap_or(LogKind::Unknown)
    }

    /// The filter family. None only for `Unknown`, which no filter hides
    /// or shows on purpose -- it is shown while every family is.
    pub fn category(self) -> Option<LogCategory> {
        Some(match self {
            LogKind::CardCreated
            | LogKind::CardDeleted
            | LogKind::CardArchived
            | LogKind::CardUnarchived
            | LogKind::CardMoved
            | LogKind::CardRetitled => LogCategory::Cards,
            LogKind::RunStarted | LogKind::RunFinished => LogCategory::Runs,
            LogKind::RailCreated
            | LogKind::RailStarted
            | LogKind::RailPaused
            | LogKind::RailResumed
            | LogKind::RailFinished
            | LogKind::RailFailed
            | LogKind::RailDeleted => LogCategory::Rails,
            LogKind::DecisionFiled
            | LogKind::DecisionAnswered
            | LogKind::TestFiled
            | LogKind::TestPassed
            | LogKind::TestFailed => LogCategory::Human,
            LogKind::ScheduledFired => LogCategory::Scheduled,
            LogKind::GitCommit
            | LogKind::GitCheckout
            | LogKind::GitMerge
            | LogKind::GitPull
            | LogKind::GitRebase
            | LogKind::GitReset
            | LogKind::GitPush
            | LogKind::GitBranchDeleted => LogCategory::Git,
            LogKind::Unknown => return None,
        })
    }
}

/// What an entry is about. Every field is optional and each kind fills
/// the ones it has; nothing here is ever a foreign key -- a card deleted
/// tomorrow still reads as the card it was today.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogPayload {
    /// The card's file name, which is how the tab finds it again across
    /// `plans/`, `plans/done/` and `plans/archive/`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub card_file: Option<String>,
    /// Where the card was when this happened.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub card_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub card_title: Option<String>,
    /// A retitle's old title.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub old_title: Option<String>,
    /// A move's columns. None on either side is a card with no column.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_column: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to_column: Option<String>,

    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rail_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rail_name: Option<String>,

    /// A human item's question or check, marker stripped.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub item_text: Option<String>,
    /// The answer, or the failed test's note: the item's last outcome
    /// line, verbatim.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub item_outcome: Option<String>,

    /// A Scheduled task's copy, which is its id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scheduled_path: Option<String>,
    /// Which fire of its schedule this was.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fire_number: Option<u32>,

    /// The agent a run launched -- the only "who" the log keeps.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,

    /// A git entry's branch, and the checkout it happened in.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha: Option<String>,
    /// The reflog line's message: a commit's subject, `moving from a to
    /// b`, a merge's `Fast-forward`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,

    /// Why: a stalled step's reason on a failed rail.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,

    /// Found by the diff a watch runs when it starts rather than as it
    /// happened, so `at` is when it was noticed. Changes made while no
    /// daemon was watching land here.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub noticed_on_start: bool,
}

impl LogPayload {
    /// The text the daemon's search matches against: card names, rail
    /// names, git branches and worktrees. Lowercased, one field a line.
    pub fn search_text(&self) -> String {
        [
            self.card_title.as_deref(),
            self.old_title.as_deref(),
            self.card_file.as_deref(),
            self.rail_name.as_deref(),
            self.branch.as_deref(),
            self.worktree.as_deref(),
        ]
        .into_iter()
        .flatten()
        .map(str::to_lowercase)
        .collect::<Vec<_>>()
        .join("\n")
    }
}

/// One entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    /// The row id. With `at`, the cursor a page is read before.
    pub id: i64,
    pub workspace_id: String,
    /// UTC unix seconds. When it happened -- a git entry's reflog time --
    /// or, for one noticed on start, when it was noticed.
    pub at: i64,
    pub kind: LogKind,
    #[serde(default)]
    pub payload: LogPayload,
}

/// Where the next page starts: strictly older than this entry. Entries are
/// ordered by `at` and then `id`, both descending: `at` alone is not
/// unique, and `id` alone is not time order -- a git entry carries its
/// reflog's time, which can be older than rows written before it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogCursor {
    pub at: i64,
    pub id: i64,
}

impl LogEntry {
    pub fn cursor(&self) -> LogCursor {
        LogCursor { at: self.at, id: self.id }
    }
}

/// The most entries one page may hold. A page is what one reply carries,
/// and a reply has a line cap.
pub const MAX_LOG_PAGE: u32 = 500;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_kind_round_trips_through_its_store_spelling() {
        for kind in LogKind::ALL {
            assert_eq!(LogKind::parse(kind.as_str()), kind);
            let wire = serde_json::to_string(&kind).unwrap();
            assert_eq!(wire, format!("\"{}\"", kind.as_str()));
            assert!(kind.category().is_some(), "{kind:?} has no family");
        }
    }

    #[test]
    fn an_unknown_kind_reads_as_unknown_rather_than_failing_the_page() {
        let entry: LogEntry = serde_json::from_str(
            r#"{"id":1,"workspaceId":"w","at":5,"kind":"card_teleported","payload":{"cardFile":"a.md","later":1}}"#,
        )
        .unwrap();
        assert_eq!(entry.kind, LogKind::Unknown);
        assert_eq!(entry.payload.card_file.as_deref(), Some("a.md"));
        assert_eq!(LogKind::parse("card_teleported"), LogKind::Unknown);
        assert_eq!(LogKind::Unknown.category(), None);
    }

    #[test]
    fn an_empty_payload_serialises_to_an_empty_object() {
        assert_eq!(serde_json::to_string(&LogPayload::default()).unwrap(), "{}");
        let p = LogPayload { noticed_on_start: true, card_title: Some("X".into()), ..Default::default() };
        assert_eq!(serde_json::to_string(&p).unwrap(), r#"{"cardTitle":"X","noticedOnStart":true}"#);
    }

    #[test]
    fn search_text_covers_names_branches_and_worktrees_lowercased() {
        let p = LogPayload {
            card_title: Some("[feat] Login".into()),
            rail_name: Some("API".into()),
            branch: Some("feat/X".into()),
            worktree: Some("/r/.gavin-worktrees/wt".into()),
            item_text: Some("not searched".into()),
            ..Default::default()
        };
        let text = p.search_text();
        for needle in ["[feat] login", "api", "feat/x", "/r/.gavin-worktrees/wt"] {
            assert!(text.contains(needle), "{needle} missing from {text}");
        }
        assert!(!text.contains("not searched"));
    }
}
