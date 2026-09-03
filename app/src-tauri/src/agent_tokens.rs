//! What ONE run of a card cost, in tokens, read out of the agent CLI's
//! own transcript.
//!
//! The sibling of `agent_usage`, and deliberately not part of it. That
//! module reports the account's limit windows -- a percentage of a quota,
//! shared across every machine the human works on, useless for saying
//! which card was expensive. This one reports the tokens one conversation
//! actually burned, which is the only figure a per-card history can be
//! built from.
//!
//! Three things make it possible, and all three already exist:
//!
//!  - gavin MINTS the conversation id at launch (`--session-id <uuid>`
//!    and its per-profile equivalents), so the transcript can be found by
//!    exact name rather than matched by cwd and time -- which is what
//!    every "which log was that run" heuristic degenerates into.
//!  - the run history keeps that id per run (`CardRun::conversation_id`).
//!  - the profile table says whether the agent writes a transcript gavin
//!    can read at all (`agent_setup::TokenLog`), and `Unsupported` is the
//!    honest answer for the four profiles that do not.
//!
//! Nothing here reaches the network and nothing here needs a credential:
//! these are files the CLI wrote on this machine. The cost of being
//! wrong is a number in front of somebody, so every parse below refuses
//! rather than estimates -- an absent total is reported as absent.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

use crate::agent_setup::{profile_by_id, TokenLog};

/// How deep the codex rollout walk goes. Its sessions are filed
/// `sessions/<year>/<month>/<day>/rollout-*.jsonl`; the same bound
/// `agent_usage::collect_jsonl` uses, for the same directory tree.
const CODEX_MAX_DEPTH: usize = 4;

/// How many rollout files a lookup will open before giving up. The name
/// match below is exact, so this only bounds a walk over a machine with
/// years of codex history -- not a scan for the right file.
const CODEX_MAX_FILES: usize = 4000;

/// What one run cost. All four counts, not just a total: cache reads are
/// most of a long agent run's input and cost a fraction of a fresh one,
/// so a single "input" figure would make every resumed run look
/// ruinous.
#[derive(Clone, Debug, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenTotals {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    /// The sum of the four above. Computed here rather than in the
    /// frontend so that "total" means the same thing on every surface,
    /// and so a route that reports its OWN total (codex does) can hand
    /// back that one instead of a re-derived disagreement.
    pub total_tokens: u64,
    /// How many assistant turns the total is spread across. The
    /// denominator that makes a total legible: 400k over 12 turns and
    /// 400k over 300 are different runs.
    pub turns: u64,
}

/// What a read came back with.
///
/// A tagged union rather than `Option<TokenTotals>` for the same reason
/// `UsageReport` is one: "this agent keeps no readable transcript",
/// "this run has no conversation id", and "the log for this run is gone"
/// are three different sentences to put in front of somebody, and only
/// the last is a surprise.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TokenReport {
    Ready {
        totals: TokenTotals,
        /// The models the run actually used, in first-seen order.
        /// Plural because a single Claude Code run genuinely spans more
        /// than one.
        models: Vec<String>,
    },
    /// The profile writes nothing gavin can read (`TokenLog::None`), or
    /// the run predates gavin minting conversation ids.
    Unsupported { reason: String },
    /// The transcript should exist and does not, or exists and cannot be
    /// read as tokens. Distinct from `Unsupported`: this one is a
    /// surprise, and worth saying so.
    Unavailable { reason: String },
}

/// Totals for a finished run never change, and a run history opens ten
/// of them at once. Keyed by conversation id and invalidated on the
/// transcript's mtime, so a LIVE run's figures still move -- a cache
/// that froze the open run would be worse than none, because that is
/// the row somebody is watching.
#[derive(Default)]
pub struct TokenCache(Mutex<std::collections::HashMap<String, (SystemTime, TokenReport)>>);

impl TokenCache {
    pub fn new() -> Self {
        Self::default()
    }
}

/// Read one run's token cost.
///
/// `conversation_id` is the id gavin minted for the run, off
/// `CardRun::conversation_id`. Absent means the run was launched by a
/// profile with no verified resume argv, and there is nothing to look
/// up -- which is `Unsupported`, not a failure.
#[tauri::command]
pub fn card_run_tokens(
    cache: tauri::State<'_, TokenCache>,
    profile_id: String,
    conversation_id: Option<String>,
) -> TokenReport {
    let Some(conversation_id) = conversation_id.filter(|id| !id.trim().is_empty()) else {
        return TokenReport::Unsupported {
            reason: "gavin did not record a conversation id for this run".to_string(),
        };
    };
    let Some(log) = profile_by_id(&profile_id).token_log else {
        return TokenReport::Unsupported {
            reason: format!("gavin cannot read {profile_id}'s token counts"),
        };
    };

    let path = match log {
        TokenLog::ClaudeSessionJsonl => claude_transcript(&claude_projects_dir(), &conversation_id),
        TokenLog::CodexRollout => codex_rollout(&codex_sessions_dir(), &conversation_id),
    };
    let Some(path) = path else {
        return TokenReport::Unavailable {
            reason: "the agent's transcript for this run is no longer on this machine".to_string(),
        };
    };

    let mtime = std::fs::metadata(&path).and_then(|m| m.modified()).unwrap_or(SystemTime::UNIX_EPOCH);
    if let Some((seen, report)) = cache.0.lock().unwrap().get(&conversation_id) {
        if *seen == mtime {
            return report.clone();
        }
    }

    let Ok(text) = std::fs::read_to_string(&path) else {
        return TokenReport::Unavailable {
            reason: "the agent's transcript for this run could not be read".to_string(),
        };
    };
    let report = match log {
        TokenLog::ClaudeSessionJsonl => claude_totals(&text),
        TokenLog::CodexRollout => codex_totals(&text),
    };
    cache.0.lock().unwrap().insert(conversation_id, (mtime, report.clone()));
    report
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

fn claude_projects_dir() -> PathBuf {
    home_dir().unwrap_or_default().join(".claude").join("projects")
}

fn codex_sessions_dir() -> PathBuf {
    home_dir().unwrap_or_default().join(".codex").join("sessions")
}

/// `<projects>/<slugged cwd>/<session id>.jsonl`, found by looking in
/// every project directory rather than by reproducing the slug.
///
/// The slug rule is Claude Code's, undocumented, and has changed; the
/// file name is the session id, which gavin minted and therefore knows
/// exactly. Reproducing the slug would also be wrong more often than it
/// looks: a run's launch cwd is where gavin STARTED the agent, and an
/// agent that moves into a worktree is filed under where it ended up.
fn claude_transcript(projects: &Path, conversation_id: &str) -> Option<PathBuf> {
    let file = format!("{conversation_id}.jsonl");
    let entries = std::fs::read_dir(projects).ok()?;
    for entry in entries.flatten() {
        let candidate = entry.path().join(&file);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// The rollout whose name carries this conversation id. Codex files them
/// `sessions/<y>/<m>/<d>/rollout-<timestamp>-<id>.jsonl`, so the id is a
/// suffix of the stem rather than the whole of it -- matched as one, not
/// with a `contains` that a timestamp could satisfy by accident.
fn codex_rollout(sessions: &Path, conversation_id: &str) -> Option<PathBuf> {
    let suffix = format!("-{conversation_id}");
    let mut found = None;
    let mut budget = CODEX_MAX_FILES;
    walk_rollouts(sessions, 0, &mut budget, &mut |path| {
        if found.is_some() {
            return;
        }
        let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or_default();
        if stem.ends_with(&suffix) || stem == conversation_id {
            found = Some(path.to_path_buf());
        }
    });
    found
}

fn walk_rollouts(dir: &Path, depth: usize, budget: &mut usize, visit: &mut impl FnMut(&Path)) {
    if depth > CODEX_MAX_DEPTH || *budget == 0 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            walk_rollouts(&path, depth + 1, budget, visit);
        } else if path.extension().is_some_and(|e| e == "jsonl") {
            if *budget == 0 {
                return;
            }
            *budget -= 1;
            visit(&path);
        }
    }
}

/// Sum a Claude Code transcript, ONE COUNT PER MESSAGE.
///
/// This is the whole subtlety of the route. An assistant message is
/// written to the transcript once per content block -- text, each tool
/// call, each thinking block -- and every one of those records repeats
/// the same `message.usage`. Summing lines reports a multiple of the
/// real cost that varies with how tool-heavy the run was: measured on a
/// real transcript (2026-09-03), 39 assistant records for 15 messages.
///
/// So the sum is over distinct `message.id`. A record without one is
/// skipped rather than counted -- there is no way to tell a duplicate
/// from a fresh turn without it, and over-reporting is the failure this
/// function exists to avoid.
pub fn claude_totals(text: &str) -> TokenReport {
    let mut totals = TokenTotals::default();
    let mut seen: HashSet<String> = HashSet::new();
    let mut models: Vec<String> = Vec::new();

    for line in text.lines() {
        let Ok(record) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        if record.get("type").and_then(|v| v.as_str()) != Some("assistant") {
            continue;
        }
        let Some(message) = record.get("message") else { continue };
        let Some(id) = message.get("id").and_then(|v| v.as_str()) else { continue };
        if !seen.insert(id.to_string()) {
            continue;
        }
        let Some(usage) = message.get("usage") else { continue };
        let count = |key: &str| usage.get(key).and_then(|v| v.as_u64()).unwrap_or(0);
        totals.input_tokens += count("input_tokens");
        totals.output_tokens += count("output_tokens");
        totals.cache_read_tokens += count("cache_read_input_tokens");
        totals.cache_write_tokens += count("cache_creation_input_tokens");
        totals.turns += 1;
        if let Some(model) = message.get("model").and_then(|v| v.as_str()) {
            if !models.iter().any(|m| m == model) {
                models.push(model.to_string());
            }
        }
    }

    if totals.turns == 0 {
        return TokenReport::Unavailable {
            reason: "the agent's transcript for this run records no completed turn".to_string(),
        };
    }
    totals.total_tokens =
        totals.input_tokens + totals.output_tokens + totals.cache_read_tokens + totals.cache_write_tokens;
    TokenReport::Ready { totals, models }
}

/// Read a codex rollout's LAST cumulative total.
///
/// The same `token_count` event `agent_usage::newest_codex_limits`
/// already reads, a different field on it: `info.total_token_usage` is
/// the conversation's running total, so the answer is the newest event
/// carrying one. Summing them would multiply the conversation by its own
/// length -- the opposite mistake to the Claude route's, and the reason
/// neither route is written generically.
///
/// `total_tokens` is taken from the file rather than re-derived: codex
/// counts reasoning tokens inside its own total, and a sum of the parts
/// here would quietly disagree with what `codex` itself reports.
pub fn codex_totals(text: &str) -> TokenReport {
    for line in text.lines().rev() {
        let Ok(record) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        let Some(payload) = record.get("payload") else { continue };
        if payload.get("type").and_then(|v| v.as_str()) != Some("token_count") {
            continue;
        }
        let Some(used) = payload.pointer("/info/total_token_usage").filter(|v| v.is_object()) else {
            continue;
        };
        let count = |key: &str| used.get(key).and_then(|v| v.as_u64()).unwrap_or(0);
        let cache_read = count("cached_input_tokens");
        let mut totals = TokenTotals {
            // Codex reports cached input INSIDE `input_tokens`; the two
            // are reported separately here, so the cached half is taken
            // back out rather than counted on both lines.
            input_tokens: count("input_tokens").saturating_sub(cache_read),
            output_tokens: count("output_tokens"),
            cache_read_tokens: cache_read,
            // No equivalent: codex does not bill a cache write.
            cache_write_tokens: 0,
            total_tokens: count("total_tokens"),
            // The rollout carries no turn count, and inventing one from
            // the number of events would count tool calls as turns.
            turns: 0,
        };
        if totals.total_tokens == 0 {
            totals.total_tokens = totals.input_tokens + totals.output_tokens + totals.cache_read_tokens;
        }
        if totals.total_tokens == 0 {
            continue;
        }
        let models = payload
            .get("info")
            .and_then(|i| i.get("model"))
            .and_then(|v| v.as_str())
            .map(|m| vec![m.to_string()])
            .unwrap_or_default();
        return TokenReport::Ready { totals, models };
    }
    TokenReport::Unavailable {
        reason: "the agent's transcript for this run records no token count".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn totals(report: &TokenReport) -> &TokenTotals {
        match report {
            TokenReport::Ready { totals, .. } => totals,
            other => panic!("expected a ready report, got {other:?}"),
        }
    }

    fn assistant(id: &str, input: u64, output: u64, cache_read: u64, cache_write: u64) -> String {
        format!(
            r#"{{"type":"assistant","message":{{"id":"{id}","model":"claude-opus-5","usage":{{"input_tokens":{input},"output_tokens":{output},"cache_read_input_tokens":{cache_read},"cache_creation_input_tokens":{cache_write}}}}}}}"#
        )
    }

    /// The bug this whole route is shaped around. One assistant message
    /// is written once per content block and every copy repeats the same
    /// `usage`; a sum over lines reports a multiple of the real cost.
    #[test]
    fn a_message_written_once_per_content_block_is_counted_once() {
        let one = assistant("msg-1", 10, 20, 30, 40);
        let text = [one.clone(), one.clone(), one].join("\n");

        let report = claude_totals(&text);

        let t = totals(&report);
        assert_eq!(t.input_tokens, 10, "not 30 -- three records, one message");
        assert_eq!(t.output_tokens, 20);
        assert_eq!(t.cache_read_tokens, 30);
        assert_eq!(t.cache_write_tokens, 40);
        assert_eq!(t.total_tokens, 100);
        assert_eq!(t.turns, 1);
    }

    #[test]
    fn distinct_messages_add_up_and_the_models_are_kept_in_order() {
        let text = [
            assistant("msg-1", 1, 2, 3, 4),
            r#"{"type":"user","message":{"id":"u-1"}}"#.to_string(),
            assistant("msg-2", 5, 6, 7, 8),
            "not json at all".to_string(),
        ]
        .join("\n");

        let report = claude_totals(&text);

        let t = totals(&report);
        assert_eq!(t.turns, 2);
        assert_eq!(t.total_tokens, 1 + 2 + 3 + 4 + 5 + 6 + 7 + 8);
        match &report {
            TokenReport::Ready { models, .. } => assert_eq!(models, &vec!["claude-opus-5".to_string()]),
            other => panic!("expected ready, got {other:?}"),
        }
    }

    /// A record with no `message.id` cannot be told apart from a
    /// duplicate of the one before it, and guessing wrong OVER-reports.
    #[test]
    fn an_assistant_record_without_a_message_id_is_skipped_rather_than_guessed_at() {
        let text = r#"{"type":"assistant","message":{"usage":{"input_tokens":999}}}"#;

        assert!(matches!(claude_totals(text), TokenReport::Unavailable { .. }));
    }

    #[test]
    fn a_transcript_with_no_assistant_turn_is_unavailable_not_a_zero_bill() {
        let text = r#"{"type":"user","message":{"id":"u-1"}}"#;

        // Zero would render as a run that cost nothing, which is a
        // different claim from one whose cost could not be read.
        assert!(matches!(claude_totals(text), TokenReport::Unavailable { .. }));
    }

    /// `info.total_token_usage` is CUMULATIVE, so the newest event is
    /// the answer. Summing would multiply the conversation by its own
    /// length -- the opposite mistake to the Claude route's.
    #[test]
    fn a_codex_rollout_reports_its_last_cumulative_total_not_a_sum() {
        let text = [
            r#"{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"cached_input_tokens":40,"output_tokens":10,"total_tokens":110}}}}"#,
            r#"{"type":"event_msg","payload":{"type":"token_count","info":{"model":"gpt-5-codex","total_token_usage":{"input_tokens":300,"cached_input_tokens":250,"output_tokens":30,"total_tokens":330}}}}"#,
        ]
        .join("\n");

        let report = codex_totals(&text);

        let t = totals(&report);
        assert_eq!(t.total_tokens, 330, "the last total, not 110 + 330");
        assert_eq!(t.cache_read_tokens, 250);
        assert_eq!(t.input_tokens, 50, "cached input is reported on its own line, not twice");
        assert_eq!(t.output_tokens, 30);
        match &report {
            TokenReport::Ready { models, .. } => assert_eq!(models, &vec!["gpt-5-codex".to_string()]),
            other => panic!("expected ready, got {other:?}"),
        }
    }

    #[test]
    fn a_rollout_with_no_token_count_event_is_unavailable() {
        let text = r#"{"type":"event_msg","payload":{"type":"agent_message","message":"hi"}}"#;

        assert!(matches!(codex_totals(text), TokenReport::Unavailable { .. }));
    }

    /// The report crosses to the frontend as a discriminated union, and
    /// `runHistory.ts` switches on `kind` and reads camelCase fields. A
    /// container `rename_all` renames enum VARIANTS, not their fields --
    /// so the field casing here rides on `TokenTotals`' own attribute,
    /// which is exactly the kind of thing that keeps compiling after
    /// somebody moves it, and shows up as every run costing "—".
    #[test]
    fn a_report_serializes_to_the_shape_the_frontend_switches_on() {
        let report = TokenReport::Ready {
            totals: TokenTotals {
                input_tokens: 1,
                output_tokens: 2,
                cache_read_tokens: 3,
                cache_write_tokens: 4,
                total_tokens: 10,
                turns: 5,
            },
            models: vec!["claude-opus-5".to_string()],
        };

        assert_eq!(
            serde_json::to_value(&report).unwrap(),
            serde_json::json!({
                "kind": "ready",
                "totals": { "inputTokens": 1, "outputTokens": 2, "cacheReadTokens": 3,
                            "cacheWriteTokens": 4, "totalTokens": 10, "turns": 5 },
                "models": ["claude-opus-5"],
            })
        );
        assert_eq!(
            serde_json::to_value(TokenReport::Unsupported { reason: "no".to_string() }).unwrap(),
            serde_json::json!({ "kind": "unsupported", "reason": "no" })
        );
        assert_eq!(
            serde_json::to_value(TokenReport::Unavailable { reason: "gone".to_string() }).unwrap(),
            serde_json::json!({ "kind": "unavailable", "reason": "gone" })
        );
    }

    /// The transcript is found by NAME, in whichever project directory
    /// holds it -- the slug is Claude Code's rule, and a run's launch
    /// cwd is not necessarily where the agent ended up.
    #[test]
    fn a_claude_transcript_is_found_by_session_id_in_any_project_directory() {
        let dir = tempfile::tempdir().unwrap();
        let projects = dir.path();
        std::fs::create_dir_all(projects.join("-Users-someone-a")).unwrap();
        std::fs::create_dir_all(projects.join("-Users-someone-b")).unwrap();
        std::fs::write(projects.join("-Users-someone-b").join("conv-1.jsonl"), "{}").unwrap();

        assert_eq!(
            claude_transcript(projects, "conv-1"),
            Some(projects.join("-Users-someone-b").join("conv-1.jsonl"))
        );
        assert_eq!(claude_transcript(projects, "conv-2"), None);
    }

    /// Matched as a SUFFIX of the stem after a dash, so the timestamp
    /// half of a rollout name cannot satisfy it by accident.
    #[test]
    fn a_codex_rollout_is_found_by_the_id_at_the_end_of_its_name() {
        let dir = tempfile::tempdir().unwrap();
        let day = dir.path().join("2026").join("09").join("03");
        std::fs::create_dir_all(&day).unwrap();
        std::fs::write(day.join("rollout-2026-09-03T10-00-00-conv-1.jsonl"), "{}").unwrap();
        std::fs::write(day.join("rollout-2026-09-03T11-00-00-other.jsonl"), "{}").unwrap();

        assert_eq!(
            codex_rollout(dir.path(), "conv-1"),
            Some(day.join("rollout-2026-09-03T10-00-00-conv-1.jsonl"))
        );
        assert_eq!(codex_rollout(dir.path(), "conv-9"), None);
    }
}
